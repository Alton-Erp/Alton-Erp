# Stock register, stock movement accuracy and duplicate-safe production

Migration: `supabase/migrations/20261111090000_stock_register_reliability.sql`
Rollback: `supabase/rollback/20261111090000_stock_register_reliability_down.sql`
Tests: `supabase/tests/stock_reliability_verification.sql` (69 checks), `tests/db/stock-reliability-rollback-check.mjs`,
`tests/unit/stock-position.test.ts`, UI smoke step "stock register: …".

## 1. Stock posting audit (which event moves stock)

Every movement goes through `private.post_movement`. In one transaction it writes the append-only ledger row (`inventory_transactions`) and updates `inventory_balances`. It refuses stock that would go negative.

| Operation | Authoritative posting | Ledger | Request id | Undo |
|---|---|---|---|---|
| Sales invoice (draft, issue, proforma) | **none**: invoices never move stock. Since 20261112 an invoice with stock items can be posted only after they are dispatched (section 7) | — | yes | — |
| Dispatch | `sales_order_v2_dispatch` → `fulfilment_dispatch` | ISSUE, taken from the order's reservations (converted, not left behind) | yes | `sales_order_v2_reverse_dispatch`: REVERSAL, re-reserved |
| Purchase GRN | `purchase_receipt_post`, `goods_receipt_direct_post` | RECEIPT of accepted quantity to storage. Rejected goods go to a rejected/quarantine location (never available) or are recorded only | yes | `goods_receipt_reverse`; `goods_receipt_correct` = reverse + repost |
| Production material issue and output | `production_order_v2_save` (complete) / `production_order_v2_complete` → `private.production_v2_post` | PRODUCTION_ISSUE (from reservations), PRODUCTION_RECEIPT | yes | `production_order_v2_correct` |
| Outsourcing | `outsourcing_move_materials`, `outsourcing_receive_goods` | TRANSFER, SUBCONTRACT_* | yes | `outsourcing_reverse_receipt` |
| Adjustments / counts / opening stock | `inventory_review_adjustment`, `inventory_review_count`, `inventory_review_opening_stock` | ADJUSTMENT_IN/OUT, OPENING_STOCK | yes | `inventory_reverse_transaction` |
| Customer returns | `customer_return_receive` | CUSTOMER_RETURN | yes | — |

Notes:
- No posting function needed a change: drafts move nothing, each event posts once, a repeated request returns the first result, and reversals post compensating REVERSAL rows (the original is never edited).
- ~~**Business risk:** a manual invoice (one not linked to a dispatch) deducts no stock.~~ Closed by 20261112: stock items can no longer be posted on an invoice that is not covered by a posted dispatch (section 7).

## 2. Stock register (Inventory → Stock Register → By product)

`public.inventory_stock_position(filters)` and `public.inventory_stock_position_detail(product, warehouse)` compute these figures:

- Available = storage on hand − reserved
- Pending PO = ordered − accepted on posted GRNs, for open orders only. Amendments change the ordered quantity; reversed GRNs no longer count.
- Expected incoming = pending PO + pending production output (planned − good output of open orders)
- BOM required = material still to issue to open production orders (their approved-BOM snapshot, wastage included) that is not yet reserved for them
- BOM shortage = GREATEST(BOM required − available, 0)
- Discrepancy = the balance differs from the sum of its ledger movements

Pending PO and production are never added to on hand.

**Filters:** warehouse, product search, category, type, status, plus quick views for low stock, BOM shortage, pending PO and discrepancy.

**Each row expands to show:**
- lots by warehouse and location
- open POs
- recent GRNs (with invoice and challan numbers)
- production orders that make or use the product
- BOM components and where the product is used

There is an Excel export of the list.

## 3. Reconciliation

`public.inventory_reconciliation(product?)` is read-only and lists every lot and location with one of these problems:
- balance ≠ ledger
- ledger stock without a balance row
- reserved ≠ active reservations
- negative stock
- reserved > on hand

It is shown under Stock Register → **Stock reconciliation**, with Excel export.

## 4. Duplicate-safe production orders

- **Already in place:**
  - Both creation functions (`production_order_v2_save`, `production_order_save`) require a request id. The unique `inventory_requests (company_id, idempotency_key)` makes a concurrent second call wait for the first and then return its result.
  - The entry form keeps the same id for retries, renews it only after success, and disables saving while processing.
  - Reservations top up only what is not yet reserved.
- **Added:**
  - `production_order_requests (company_id, request_id)` is unique and filled by trigger, so one request id can never create two orders, even through a path that skipped the request table.
  - Repeated requests are written to the audit log (`request.duplicate_returned`).
  - Different request ids create separate orders, so separate batches are allowed.

## 5. Before / after reconciliation on the hosted project

**Not run yet:** no signed-in session was available.

**Before:** run this read-only query in the Supabase SQL Editor before applying the migration. It lists balances that differ from the ledger:

```sql
select c.company_code, p.sku, w.warehouse_code, l.location_code, b.on_hand,
       coalesce((select sum(t.direction * t.quantity) from public.inventory_transactions t
                 where t.batch_id = b.batch_id and t.location_id = b.location_id), 0) as ledger_on_hand,
       b.reserved,
       coalesce((select sum(r.quantity - r.fulfilled_quantity - r.released_quantity) from public.stock_reservations r
                 where r.batch_id = b.batch_id and r.location_id = b.location_id
                   and r.reservation_status in ('ACTIVE', 'PARTIALLY_FULFILLED')), 0) as active_reservations
from public.inventory_balances b
join public.companies c on c.id = b.company_id
join public.products p on p.id = b.product_id
join public.warehouses w on w.id = b.warehouse_id
join public.inventory_locations l on l.id = b.location_id
where b.on_hand <> coalesce((select sum(t.direction * t.quantity) from public.inventory_transactions t
                             where t.batch_id = b.batch_id and t.location_id = b.location_id), 0)
   or b.reserved <> coalesce((select sum(r.quantity - r.fulfilled_quantity - r.released_quantity) from public.stock_reservations r
                              where r.batch_id = b.batch_id and r.location_id = b.location_id
                                and r.reservation_status in ('ACTIVE', 'PARTIALLY_FULFILLED')), 0)
   or b.on_hand < 0 or b.reserved > b.on_hand;
```

**After:** open Stock Register → Stock reconciliation. The migration changes no stock data, so the result must be the same.

## 6. Deployment

1. Apply `20261110090000_readonly_rpc_fix.sql` if it is not applied yet (ERP Settings fix), then `20261111090000_stock_register_reliability.sql`.
2. Run the reconciliation query (or the Stock reconciliation dialog) before and after; the results should be identical.
3. Optional check: run `supabase/tests/stock_reliability_verification.sql` in the SQL Editor. It rolls itself back and leaves no data.
4. Rollback, if needed: run the down script. It removes only the new functions, trigger and request-id table, and restores `private.idempotency_begin`.

## 7. Dispatch before invoice posting

> **Changed by section 8 (20261115):** there is no separate dispatch step any more. Posting a sales-order invoice performs the dispatch itself, in the same transaction. The rule below still checks every posting.

Migration: `supabase/migrations/20261112090000_invoice_dispatch_policy.sql`
Rollback: `supabase/rollback/20261112090000_invoice_dispatch_policy_down.sql`
Tests:
- `supabase/tests/invoice_dispatch_policy_verification.sql` (79 checks)
- `tests/db/invoice-dispatch-rollback-check.mjs`
- `tests/unit/invoice-dispatch-status.test.ts`
- UI smoke step "invoice posting: …"

### Rule

An invoice that contains stock items can be posted (DRAFT or PENDING_APPROVAL → ISSUED) only when valid, posted dispatches cover the full invoiced quantity of every stock line. The dispatch stays the only event that deducts stock; posting an invoice still moves nothing.

| Invoice line | Needs dispatch? |
|---|---|
| Product with **Stock-tracked item** ticked (`products.inventory_tracked = true`, the default for every existing and new product) | yes |
| Product with the box unticked (service / non-stock: installation, AMC, labour) | no |
| Freight, packing and other charge lines | no |

- A service-only or charges-plus-services invoice posts as before. A charge-only invoice is still refused by the existing "at least one product" rule.
- On a mixed invoice, only the stock lines are checked.

### What counts as validly dispatched

The quantity is counted per dispatch line, the same basis the invoicing rules already use:

- open(dispatch line) = max(dispatched − received back on customer returns − billed on other **posted** invoices for that dispatch line, 0)
- open(order line) = Σ open(its dispatch lines) − billed on posted sales-order invoices not tied to a dispatch line

A line's coverage is computed as follows:
- A line invoiced from a dispatch is limited by both its dispatch line and its order line.
- A line invoiced from a sales order is limited by its order line.
- Earlier lines of the same invoice use up the quantity first.
- A manual line (no order or dispatch link) has no coverage.

Things that never count:
- Pick lists and packed consignments (no `actual_dispatch_at`).
- Cancelled consignments.
- Reversed dispatches, which are reset to 0 by `sales_order_v2_reverse_dispatch`. A replacement dispatch counts again.
- Draft, proforma, discarded and cancelled invoices never use up dispatched quantity.

A unit that differs from the product's stock unit is refused, because no unit conversions exist. Fractional quantities (e.g. 2.25 KG) are compared exactly.

### Where it is enforced

**Posting guard.** A `BEFORE UPDATE OF status` trigger (`sales_invoices_dispatch_guard`, function `private.invoice_dispatch_guard`) applies the rule on every path to ISSUED: `sales_invoice_v2_issue`, `sales_invoice_issue` (approval flow), proforma conversion, Excel import and any direct update.
- It runs in the posting transaction, after the existing validation and numbering. A refusal rolls everything back: no number is used, no billing event is written and no ledger rows are created.
- It first locks the order lines and their dispatch lines `FOR UPDATE`. Two postings for the same goods, or a posting and a dispatch reversal, are therefore serialised: the second one re-checks against committed data.
- Idempotency is unchanged: a repeated request returns the first result.

**Reversal guard.** `fulfilment_lines_dispatch_reversal_guard` refuses a dispatch reversal that would leave posted invoices billing goods that are no longer dispatched. Before this, only reversals with a dispatch invoice were refused; order-sourced invoices are now covered too.

**Error message.** Each outstanding line is named, for example: `Dispatch the goods before posting this invoice (…). Not fully dispatched: FG-1 Basin mixer: invoiced 10 PCS, validly dispatched 4, still to dispatch 6`.

### Screens

- **Product form:** "Stock-tracked item" check box. The product detail page shows the classification. Spreadsheet imports keep the stored value.
- **Invoice detail (draft / pending):** the Dispatch status card lists, per line:
  - invoiced, dispatched and remaining quantities
  - the status: Awaiting Dispatch, Partially Dispatched, Fully Dispatched, or No dispatch needed
  - the overall badge: Ready to Post, Awaiting Dispatch or Partially Dispatched
- **Posting controls:**
  - **Issue invoice** is disabled while anything is outstanding, and a "Dispatch on SO-…" link opens the order's dispatch workflow.
  - **Check again** re-reads the status.
  - Before posting, the status is fetched again; if it changed, the post is not attempted.
- **New invoice → Save and issue:** the draft is saved; if goods are outstanding it opens with the dispatch status instead of posting.

### Not changed

- No stock posting function was changed: posting never deducts stock, so there is no double deduction.
- Invoice cancellation does not restock. The goods were deducted by the dispatch; returning them is a customer return or a dispatch reversal.
- Existing invoices are not modified.

### Historical invoices that do not meet the rule

Invoices posted before this migration may bill goods that were never dispatched, for example manual or imported invoices. They are **not** changed.

After deployment, list them with `public.invoice_dispatch_exceptions()` (signed in; read-only). On the hosted project, run this read-only query in the SQL Editor:

```sql
select c.company_code, i.invoice_number, i.invoice_date, i.source, d.line_no, d.sku, d.product_name, d.unit,
       d.required as invoiced, d.dispatched as covered, d.remaining as uncovered, d.reason
from public.sales_invoices i
join public.companies c on c.id = i.company_id
cross join lateral private.invoice_dispatch_lines(i.id) d
where i.status = 'ISSUED' and d.applies and d.remaining > 0
order by c.company_code, i.invoice_date, i.invoice_number, d.line_no;
```

Before deployment, a rough equivalent covers manual and imported stock lines only:

```sql
select c.company_code, i.invoice_number, i.invoice_date, i.source, l.line_no, l.sku, l.quantity
from public.sales_invoices i join public.companies c on c.id = i.company_id
join public.sales_invoice_lines l on l.invoice_id = i.id
where i.status = 'ISSUED' and l.line_type = 'PRODUCT' and l.sales_order_line_id is null and l.fulfilment_line_id is null
order by 1, 3, 2, 5;
```

For each listed invoice, decide outside the system whether to:
- dispatch the goods (a dispatch from the related order), or
- issue a credit note, or
- leave it as a documented historical exception.

### Known limits

- **Excel import of past invoices:** imported invoices are posted through the same path, so an imported invoice with stock items is now refused. Either classify those products as non-stock first, or import only invoices that are already dispatched from a sales order.
- **Manual invoices for stock items** can no longer be posted. Raise them from the sales order or the dispatch instead.
- **Concurrency** is proven by the row locks and by the stale-draft test. The local database (PGlite) has one connection, so no true two-session race was run.

### Deployment (for review; not applied)

1. Before applying, run the "before deployment" query above and keep the result.
2. Apply `20261112090000_invoice_dispatch_policy.sql`, after 20261110 and 20261111. It only adds:
   - one column with a default
   - functions
   - two triggers
3. Untick **Stock-tracked item** for real service products: installation, AMC, labour.
4. Run the historical query again. Optionally run `invoice_dispatch_policy_verification.sql` in the SQL Editor; it rolls itself back.
5. **Rollback:** run the down script. It removes the triggers and functions and keeps the `inventory_tracked` column and all data.

## 8. Partial invoicing, pending invoice quantities and release (20261115)

Migration: `supabase/migrations/20261115090000_partial_invoicing.sql`
Rollback: `supabase/rollback/20261115090000_partial_invoicing_down.sql`
Tests:
- `supabase/tests/partial_invoicing_verification.sql` (63 checks)
- `tests/db/partial-invoicing-rollback-check.mjs`
- `tests/unit/pending-invoice.test.ts`
- UI smoke steps "sales order page", "create invoice", "partial invoice", "stock register: Pending / Incomplete Invoice Orders"

### Workflow

- **Sales Order page:** create, edit, view, production, reservations and cancel. It no longer has **Create Invoice** or **Dispatch**. An **Invoicing** card shows ordered, invoiced, released and pending quantities per line, with an order label such as *Partially Invoiced – 2 PCS Pending*.
- **Where invoices are created:** only in Billing & Invoicing → New invoice.
  - **From sales order** is the default. Pick the order, and its pending items load.
  - **Manual invoice** remains for services and charges; a manual line for a stock item cannot be posted.
  - **From dispatches** was removed; an old `?mode=dispatch` link opens sales-order mode.
- **Posting is the dispatch (intentional change to section 7):**
  - `sales_invoice_v2_issue` first runs the invoice's own checks (over-invoicing, GST data). It then dispatches, through the existing `sales_order_v2_dispatch` and from the order's reservations, whatever part of each stock line is not already covered by a posted dispatch. Then it posts.
  - All of this is one transaction. The section 7 trigger verifies coverage, so stock is deducted exactly once. A shortage or any failure rolls everything back, and the invoice stays a draft.
  - Goods dispatched earlier, for example before an invoice was cancelled and re-raised, are used first and never deducted again.
  - **Permissions:** posting a stock invoice also needs the dispatch permissions (fulfilment pick, pack and dispatch), since posting performs the dispatch.
- **Approval-flow and Excel-import postings** (`sales_invoice_issue`, `invoice_import`) do not dispatch on posting. They still follow section 7 strictly.

### Quantities per sales order line

| Figure | Rule |
|---|---|
| Ordered | `quantity_ordered`, never changed by invoicing |
| Invoiced | Quantity on **posted** invoices (ISSUED, not proforma). Drafts, discarded and cancelled invoices are not counted |
| Released | Quantity released with *Release Pending Quantity* (also added to `quantity_cancelled`) |
| **Pending invoice** | Ordered − cancelled/released − invoiced (never below 0) |
| Releasable | Ordered − cancelled − the larger of (invoiced incl. drafts, dispatched + on a pick list) |

- **Over-invoicing:** the existing save- and post-time rule refuses more than the order has left, counting other open drafts.
- **Concurrent posting:** posting locks the order lines first, so concurrent postings serialise. A second invoice for the same quantity is refused.

**Statuses** (line and order):
- **Open:** nothing invoiced.
- **Partially Invoiced:** some quantity invoiced.
- **Fully Invoiced:** everything invoiced.
- **Partially Released:** some pending quantity released, some still pending.
- **Closed:** nothing left, after a release.
- **Cancelled:** the order was cancelled.

A partial invoice never closes the order.

### Partial invoice warning and notification

- **Warning before posting:** when an invoice covers less than the remaining order quantity, the invoice page (and *Save and issue*) shows **Partial Invoice Warning**.
  - It names the order, the quantities and the remainder.
  - It needs **Continue with Partial Invoice**; **Go Back** posts nothing.
- **When it is posted:**
  - a `PARTIAL_INVOICE` billing event is written
  - an `invoice.partial_posted` audit row is written
  - an in-app notification goes to every active Super Admin of the company: order, invoice, customer, SKU and name, ordered / previously invoiced / this invoice / remaining, user, and date and time, linked to the invoice
- **Notifications:** unread until opened, kept in the notification history. A retried posting request returns its first result, and the de-duplication key `PARTIAL_INVOICE:<invoice>` prevents duplicates.

### Inventory → Stock Register → Pending / Incomplete Invoice Orders

- **What it shows:** order lines with a pending invoice quantity, labelled *Non-stock tracking quantity – excluded from actual inventory*.
  - Each line shows its order, invoices, customer, SKU and name, ordered / invoiced / pending / released quantities, unit, order and invoice dates, and status.
  - The quantities are never stock. No stock entry is created, and on-hand and available stock are unchanged (tested).
- **Filters:** search (order, customer, product), invoice number, customer and dates, plus an option to include closed lines. Totals are shown per unit.
- **Reports, from the same figures, each with Excel export:**
  - Pending Invoice Quantity
  - Partial Invoices
  - Sales Order vs Invoice reconciliation (also on drafts and dispatched)
  - Released Quantities
  - Customer-wise Pending
- **Release Pending Quantity** needs `sales_orders.cancel`, a quantity and a reason.
  - It reuses the existing customer-approved line reduction (`sales_order_line_update`): `quantity_cancelled` goes up and the freed finished-goods reservation is released. If nothing is left to dispatch on the line, material reservations are released too.
  - It is recorded as a `PENDING_INVOICE_RELEASED` order event (user, date, quantity, reason, related invoices) plus an audit row, and Super Admins are notified. The request is idempotent.
  - It never creates stock-in.
  - Refused: invoiced quantities, quantities on draft invoices, and goods already dispatched (dispatched goods are not returned to stock automatically).

### Deployment (for review; not applied)

1. Apply after 20261111–20261114.
2. Nothing in existing data changes:
   - no new tables or columns
   - historical invoices, dispatches and stock entries are untouched
   - the first partial notices appear only for invoices posted after deployment
3. **Rollback:** run the down script. It restores invoice posting and the dispatch status of 20261112, and keeps releases, events, notifications and stock as they are.
