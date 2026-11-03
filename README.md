# Alton ERP V2 — Single-Operator Manufacturing ERP

Copy of Alton ERP being reworked so one person can run the whole business: products and BOMs, purchasing, goods receipt, production, sales orders and invoicing. The original project in `C:\Users\Admin\alton-erp` is unchanged.

**V2 has no `.env.local`.** Point it at a new or staging Supabase project (copy `.env.example`), not the live one used by the original ERP. Migrations from `20261101090000` onwards are V2-only.

### Step 0 — single-operator mode (`20261101090000_single_operator_mode.sql`)
- Segregation of duties is **off by default**. Switch it on under Company Settings to require a second approver again.
- One-step actions replace submit-then-approve. Each one runs the existing, tested functions in a single transaction, so all validation, stock posting and audit logging is unchanged:

  | Action | Function |
  | --- | --- |
  | Open order | `purchase_order_open` |
  | Activate BOM | `production_bom_activate` |
  | Release order (production) | `production_order_release` |
  | Release order (outsourcing) | `outsourcing_order_release` |
  | Post adjustment | `inventory_post_adjustment` |
  | Post opening stock | `inventory_post_opening_stock` |
  | Post count | `inventory_post_count` |

- Screens show the one-step button when the user holds the approve permission and segregation of duties is off. Otherwise they fall back to "Submit for approval".
- A purchase order in status `APPROVED` is shown as **Open**.
- Tests: `supabase/tests/single_operator_verification.sql` and `tests/unit/single-operator.test.ts`. Older suites that test segregation of duties switch it on in their own setup.

### Stage 1 — Product Master and BOM (`20261102090000_product_master_v2.sql`)
- **Eight product types:** Finished Good, Raw Material, Component, Subassembly, Outsourced Component, Packing Material, Consumable, Other.
- **New product fields:** standard manufacturing cost, minimum stock level (column `minimum_level`; products never hold stock columns), remarks, and a working preferred supplier.
- **Incomplete products are saved.** Only the name and type are required.
  - A blank SKU gets the next code for the type (`FG-000001`, `RM-000001`, `SUB-…`, `OSC-…`, `PKG-…`, `CON-…`).
  - The source type and unit default from the type.
  - Missing HSN, GST, category, price or cost, and a missing BOM, are shown as warnings on the form, the product page and the list (the "Missing Information" and "Without BOM" KPIs).
- **Product import** (`/products/import`):
  - Only name and type are needed.
  - Preferred supplier is matched by code or name.
  - **Update existing products** mode matches rows by SKU. It changes only cells that have a value, lists every change (old → new) before saving, and puts the changes in the report.
  - An exported product list re-imports in this mode.
- **BOM lines:** each line has a source (In-house / Outsourced / Purchased) and a preferred supplier. Both default from the component's product master.
  - Any type except raw, packing and consumable can have a BOM, and any product can be a component. Multi-level BOMs are supported, and circular ones are refused.
  - A draft can be saved with no components.
  - "Edit components" on an active BOM starts a new version. Activating it the same day replaces the old version, which is archived and kept.
  - `has_bom` now follows the active BOM automatically.
- **BOM import** (`/production/boms/import`):
  - One row per component, with a template.
  - Each finished product becomes a new version, saved as a draft or activated.
  - A BOM with any bad row is held back whole, with every row explained.
  - Runs are recorded in Bulk Operations (`BOMS`).
- Tests: `supabase/tests/product_master_v2_verification.sql` (46 checks) and `tests/unit/product-master-v2.test.ts`.

### Stage 2 — Unified Ledger (`20261103090000_unified_ledger.sql`)
- **`/ledger`** shows customers and suppliers in one list:
  - KPIs: customers, suppliers, both, receivables, payables;
  - search by name, code, GSTIN, mobile or e-mail, with type and status filters;
  - Excel export.

  Each party opens at `/ledger/:id`, showing balances, all details and the transaction history with running balances.
- **A party is a Customer, a Supplier or Both.** The existing `customers` and `suppliers` tables are unchanged and remain the records every document points to.
  - A new `parties` record links them and holds the opening balance (receivable or payable), payment-terms note, bank details and remarks.
  - `party_save` writes the shared details (name, GSTIN, PAN, contacts, addresses, state, credit period) to both records.
  - Customers gained contact person, mobile, city, PIN code and country.
- **Existing data is preserved.** Every existing customer and supplier got its own party, and nothing was merged automatically.
  - Customers and suppliers created anywhere else get a party automatically.
  - The ledger also fixes any that are missing when it opens.
  - "Link as one party" joins a customer and a supplier of the same business without touching their records.
- **Duplicates:**
  - The same GSTIN as another party is refused.
  - The same name (company suffixes ignored), PAN, mobile or e-mail is a warning the user confirms.
  - Quick add offers to use the existing party instead.
- **Removing a role deactivates it, never deletes it.** Adding it back reactivates the same record. Deactivating a party deactivates both roles.
- **Balances** are calculated on the fly, never stored:
  - receivable = opening receivable + issued invoices + debit notes − credit notes − receipts;
  - payable = opening payable + goods accepted on goods receipts (at PO line value incl. GST) − supplier payments.
- **Supplier payments** are a new feature (`supplier_payments`, permission `supplier_payment.manage`). They are recorded from the party page, reversed with a reason, and never deleted.
- **Quick add** of a new supplier from the purchase order form, and a new customer from the manual sales order.
- **New permissions:** `ledger.read` goes to every role that reads customers or suppliers. Customer details still need `customers.manage`, supplier details `suppliers.manage`.
- **ERP reset** covers `parties` and `supplier_payments`.
- Tests: `supabase/tests/ledger_verification.sql` (64 checks), `tests/unit/ledger.test.ts`, and two UI smoke steps.

### Stage 3 — Purchase Orders and Goods Received (`20261104090000_purchasing_grn_v2.sql`)
- **Purchase orders are created by hand only.** The Excel PO import page, its button and its route are removed from the app. The database import functions are kept, unused.
  - The order holds supplier, items, quantities, rates, discounts, GST (CGST+SGST or IGST from the GSTIN states), charge lines, payment terms and delivery date. Print / PDF is unchanged.
  - "Open order" makes it receivable in one step; there are no approvals.
  - **Duplicate** (`/purchase-orders/new?copy=:id`) copies supplier, lines, rates, terms and notes into a new draft.
  - **Delivery date / notes** change at any time without a new revision (`purchase_order_update_details`). Items, quantities and prices change through **Edit order (new revision)**, which keeps the previous version.
  - Files (supplier quotes, signed POs) attach to the order through the documents module (`SUPPLIER_PO`).
- **Goods received (GRN)** at `/goods-receipts`:
  - The register has KPIs (total, today, this month, unlinked, rejected, reversed) and filters for against-PO, unlinked and reversed.
  - Each GRN has a page (`/goods-receipts/:id`) with ordered, received, accepted, rejected and still-pending quantities, its stock postings, and attachments (`GOODS_RECEIPT`).
- **Partial and multiple receipts** against one order. Pending = ordered − accepted. The order moves to Partially received / Received by itself. Receiving more than ordered needs a reason.
- **Only accepted goods change stock.** Rejected goods are recorded only, or kept in a rejected/quarantine location, and are never available stock.
- **Unlinked receipts** ("Receive without PO", `goods_receipt_direct_post`) are allowed with a warning.
  - The warehouse is required. Supplier is optional; cost and GST default from the product.
  - They are flagged `receipt_type = 'DIRECT'` and counted in the "Unlinked GRNs" KPI.
  - A direct receipt with a supplier adds to that supplier's payable.
- **Correction** (`goods_receipt_correct`) reverses a receipt and posts the corrected one in the same transaction. If either part fails, nothing changes. The new receipt points to the one it corrects, and both stay in the history.
- **Reversal** (`goods_receipt_reverse`) works for both receipt types.
  - It takes the stock back out, so it is refused if that stock has already been used.
  - Pending quantities and the order status go back up.
- Payables count goods accepted at PO line value incl. GST. PO charge lines (e.g. freight) are not included until a supplier bill feature exists.
- Tests: `supabase/tests/purchasing_v2_verification.sql` (62 checks: totals, GST split, partial/multiple receipts, pending, reversal, atomic correction, direct receipts, payables, isolation) and four UI smoke steps.

### Stage 4 — Production (`20261105090000_production_v2.sql`)
- **No new tables.** It reuses `production_orders`, their materials, consumption, output receipts, events, `stock_reservations` and the stock ledger. The step-by-step tools (reserve, issue lot by lot, partial output, hold) still work and are shown as "Step-by-step tools" on the order page.
- **Production Dashboard** (`/production`):
  - KPIs: total orders, production today, monthly production, finished goods produced, raw materials consumed, components consumed, shortages, rejected (and wastage), pending production.
  - A date filter, a shortages table with a purchase-order shortcut, and recent activity.
  - Quantities are shown per unit (PCS and KG are never added together).
  - The previous overview with charts moved to `/production/analytics`.
- **New production** (`/production/new`, edit at `/production/orders/:id/edit`):
  - The number is automatic. The form has date, product, SKU, the active BOM version (fetched automatically), planned quantity, production location (warehouse) and remarks.
  - Optionally record actual, rejected and wastage quantities and complete the order in the same step.
  - The requirement table shows per component: required (BOM × quantity + BOM wastage, whole pieces rounded up), available, reserved, shortage, unit and source.
- **On save** (`production_order_v2_save`):
  - The order is opened in one step and **only available stock is reserved**.
  - Shortages are warnings with the quantity to purchase; they never block.
  - Nothing is deducted. Saving again replaces the reservations; it never adds to them.
- **Complete production** (`production_order_v2_complete`), in one transaction:
  - Records the **actual** consumption per material. It defaults to the standard for what was produced but can be edited, and the planned quantity is never deducted by itself.
  - Consumes this order's reservations first, then free stock (earliest expiry first).
  - Adds the accepted quantity (actual − rejected) to stock. Rejected goods are recorded only or kept in a rejected location; wastage units are recorded only.
  - Releases unused reservations.
  - If any material is short in the location, nothing is posted. A completed order cannot be completed again, and request ids stop double posting.
  - Finished goods are costed at the actual material cost when every cost is known.
- **Correct production** (`production_order_v2_correct`, needs `production_exception.approve`):
  - Reverses every posting with new ledger entries; the originals are kept as REVERSED.
  - Then posts the corrected figures, or only undoes and reopens the order. All or nothing.
  - Refused if the finished goods have already been used or sold.
- **Other corrections:**
  - Open orders without postings can be edited (product, quantity, date, location, remarks) or recalculated from the current BOM.
  - Cancel uses the existing action.
  - **Add missing components** from the production screen (`production_bom_add_components`) creates and activates a new BOM version; old versions are kept.
- **Excel upload** (`/production/import`):
  - Template columns: Production Date, Finished Product SKU, Planned Quantity, Actual Quantity, Rejected Quantity, Remarks.
  - The server matches SKUs, fetches the active BOM, calculates requirements, and checks availability cumulatively down the file.
  - It flags errors and possible duplicates per row, with a preview and a downloadable error report.
  - Rows without an actual quantity become open orders; rows with one are recorded as completed production (a shortage is then an error).
  - Valid rows are imported one by one, each isolated, and every failure is reported. The run is recorded in Bulk Operations (`PRODUCTION`).
- Tests: `supabase/tests/production_v2_verification.sql` (86 checks), `tests/unit/production-v2.test.ts` (17) and six UI smoke steps.

### Stage 5 — Sales Orders and automatic reservations (`20261106090000_sales_orders_v2.sql`)
- **Built on the existing sales tables.** It uses the Phase 7 orders, lines, fulfilments, events, the reservation ledger and the Stage 4 production flow.
  - New columns only: pricing on orders and lines, plus `production_orders.sales_order_id / sales_order_line_id`.
  - The three `*_list` views are recreated unchanged so they show the new columns.
  - The existing picking, packing, dispatch, delivery and returns screens still work. The order's "Warehouse view" opens them.
- **Sales Dashboard** (`/sales/dashboard`):
  - KPIs: total orders, created today, this month, total value, pending, partially fulfilled, fully fulfilled, cancelled, finished goods reserved, production required, raw material shortages, awaiting dispatch.
  - Filters for date, customer and status, recent orders, a shortage table and a fulfilment summary. Quantities are always shown per unit.
- **New sales order** (`/sales/orders/new`, edit at `/sales/orders/:id/edit`):
  - Header: customer (with quick add), GSTIN, billing and shipping address, expected delivery, payment terms, delivery instructions, reference, remarks, dispatch warehouse.
  - Several products per order, with quick add for new products. Each line has a description, discount % or ₹ and GST.
  - Freight and other charges are taxed at their own rate. Totals are live; CGST + SGST within the state, IGST otherwise.
  - Numbers are automatic (`SO-…`).
- **Automatic reservation on save:**
  - Finished goods: available = physical − existing reservations. Only available stock is reserved (earliest expiry first).
  - The rest is "to produce". The active BOM gives the materials, and the available materials are reserved for the order line (`SALES_ORDER_MATERIAL`). Shared components are counted once across lines and orders.
  - Shortages show required, available, reserved, shortage, unit, preferred supplier and recommended purchase. They never block the order.
  - Every reservation goes through the locked balance row, so stock is never reserved twice.
  - Recalculating tops reservations up or releases the excess. Nothing physical moves until dispatch.
- **Create Production Order** (whole order or one line):
  - Makes Stage 4 production orders, using the active BOM, for the quantity not covered by stock or existing production orders, linked to the line.
  - The line's material reservations are handed to it.
  - A second click creates nothing, so there are no duplicates. Production stays manual (Complete production).
- **Create Purchase Order** opens the existing PO form (`/purchase-orders/new?from_so=…`) prefilled with the shortage items, recommended quantities, cost and GST, plus the most common preferred supplier. Everything stays editable, and nothing is saved until the user saves.
- **Fulfilment screen** (`/sales/orders/:id`):
  - Per product: ordered, finished goods reserved, production quantity (open linked orders), produced, available for dispatch, dispatched, pending, still to produce.
  - Material shortages, dispatch history and full change history.
- **Dispatch:**
  - Partial and full, one step, through the existing pick → pack → dispatch postings, so each dispatch is its own consignment.
  - It deducts stock and uses up the reservation.
  - **Reverse dispatch** puts the goods back with reversal entries and reserves them again. It is refused if the dispatch was invoiced (credit note first) or delivered (use Customer Returns).
- **Statuses** are derived from the records: Draft, Open, Partially Reserved, Stock Shortage, Production Pending, Ready for Dispatch, Partially Dispatched, Fully Dispatched, Cancelled.
- **Corrections:**
  - Edit customer (before picking or dispatch), products, quantities (not below what was dispatched), prices, discounts and dates.
  - Removing a line cancels its remaining quantity.
  - After a dispatch a reason is required. History records old → new values, the time and the reason.
  - Release reservations, and cancel the order (also releases materials; warns about open production orders).
- **Excel import** (`/sales/orders/import`, template with the 13 columns):
  - Rows with the same customer and Customer Reference form one order.
  - Customers are matched by GSTIN, then name; products by SKU.
  - Quantities, prices and units are validated, and totals and finished-goods availability estimated.
  - Missing customers and products can be quick-added, then the file checked again.
  - An order with any bad row is held back whole. There is an error report, and the run is recorded in Bulk Operations (`SALES_ORDER`).
  - Uploading again never duplicates: the same customer and reference is "already imported".
- Tests: `supabase/tests/sales_v2_verification.sql` (73 checks), `tests/unit/sales-v2.test.ts` (12) and six UI smoke steps.

### Stage 6 — Invoicing, GST, payments and Excel import (`20261107090000_invoicing_v2.sql`)
- **Built on the Phase 8 billing tables.** No new tables: invoices, lines, receipts, allocations, credit/debit notes, settings and numbering are reused.
  - New columns only (invoice source, sales order link, proforma, pricing mode, invoice discount, transport / vehicle / e-way bill, customer PAN; charge kind on lines; GST, PDF and payment settings).
  - Two line constraints are relaxed so product lines no longer need a dispatch; `sales_invoice_list` is recreated unchanged to show the new columns.
  - Dispatch invoicing (`/billing/invoices/new?mode=dispatch`) works as before and gives the same totals.
- **Invoice Dashboard** (`/billing/dashboard`): total invoices, created today, this month, value, taxable value, GST, received, outstanding, overdue, partially paid, fully paid, drafts (and proforma), cancelled; filters for date, customer, invoice status and payment status; recent invoices, overdue table, 12-month trend and GST summary by rate.
- **Create invoice** (`/billing/invoices/new`):
  - **Manual**: any customer (quick add) and products (quick add); invoice date, due date or terms, GSTIN, PAN, billing / shipping address, place of supply, transport, vehicle, e-way bill number, remarks.
  - **From a sales order** (`?mode=so&so=…`, or "Create invoice" on the order): products, prices, discount, HSN and GST come from the order; each line shows ordered / invoiced / pending. Partial invoicing (30 + 40 + 30) is allowed; more than what is pending is refused.
  - Lines: product, SKU, description, HSN, quantity, unit, rate, discount % or ₹, GST rate, taxable value, CGST / SGST or IGST, total. Summary: subtotal, discount, freight / packing / other, taxable, taxes, round-off, grand total, received, balance due.
  - Save as draft (editable at `/billing/invoices/:id/edit`) or "Save and issue". Invoices never move stock.
- **No double billing.** The quantity of a sales-order line on live invoices is counted across all methods (order invoices, dispatch invoices, imports). Dispatch invoicing is capped by what the order line has left; proforma drafts are not counted.
- **GST engine** (the same formulas in the database and the screen preview):
  - Tax-exclusive or tax-inclusive prices; line discount (% or ₹) and an invoice-level discount shared across products by value.
  - CGST + SGST when the place of supply is the company's GSTIN state, IGST otherwise (and for place of supply 96 / SEZ).
  - Freight and packing are separate charge lines with their own SAC and rate; rounding to the nearest rupee, always up or always down.
  - Rates 0/5/12/18/28 plus any other configured rate. No e-invoice (IRN) or GST filing is claimed.
- **Issue in one step** (single operator, no approval): review points are confirmed by issuing and recorded in the history. Numbers come from the existing counter, are unique under concurrency and are never reused after cancellation.
- **Proforma invoices** have their own `PFI-…` number, print as "PROFORMA INVOICE" and are never issued by accident; "Convert to tax invoice and issue" re-checks everything and gives the next invoice number.
- **PDF / print** (`/billing/invoices/:id/print`, `/billing/notes/:id/print`): A4 with blue accents, logo, seller and customer GSTIN / PAN, transport details, tax summary by rate, amount in words, bank details, terms, footer and authorised signatory. Headings: Tax Invoice, Bill of Supply, Proforma Invoice, Credit Note, Debit Note. "Save as PDF" in the print dialog downloads it.
- **Payments** (on the invoice page): date, amount, mode (Bank / UPI / Cash / Cheque / Other), reference, bank account, notes; payment proof is attached under Attachments.
  - Full, partial and multiple payments. Anything above the balance stays on the customer's account as an advance; "Apply advance" uses it on another invoice.
  - The same reference twice is refused; the same amount, date and mode without a reference asks for confirmation. Receipts are reversed, never deleted.
  - Outstanding = grand total − credit notes + debit notes − valid payments. Payment status: Unpaid, Partially Paid, Paid, Overdue, Cancelled. The customer ledger (Stage 2) and statements include every issued invoice, note and receipt.
- **Credit and debit notes** in one step from the invoice page: by quantity (returns, short supply, quality) or by taxable amount; the original invoice is never changed.
- **Corrections**: drafts are edited (a warning appears first when the customer, place of supply or total changes); issued invoices are corrected with notes or cancelled (only without payments or notes).
- **Excel import** (`/billing/invoices/import`, template with the 17 columns): rows with the same Invoice Number form one invoice; customers matched by GSTIN then name, products by SKU; HSN, quantity (whole pieces), rate, discount, GST rate, place of supply (code or name) and the sales order's pending quantity are checked. An invoice with any bad row is held back whole, with an error report; valid invoices are issued with the number from the file. An existing number is reported and never imported twice; a number in the company's own series moves the counter past it. Recorded in Bulk Operations (`INVOICE`).
- **Invoice Register** (`/billing/register`): new and import buttons, filters for date, customer, type, invoice status and payment status, and Excel export.
- **Settings** (`/billing/settings`): numbering, financial year, terms; GST rates, pricing mode, rounding, freight / packing SAC and rate, default document, date format; logo, template, signatory; payment modes, default mode and several bank accounts.
- Tests: `supabase/tests/invoicing_v2_verification.sql` (131 checks), `tests/unit/invoicing-v2.test.ts` (17) and seven UI smoke steps; the Phase 8 billing suite still passes unchanged.

### Stage 7 — Management overview, dashboards, ERP settings and end-to-end integration (`20261108090000_management_v2.sql`)
- **No new tables.** Settings live in `companies` (new profile columns: PAN, CIN, phone, e-mail, website, logo) and the existing `company_settings` key/value table; the invoice settings stay in `invoice_settings`. All figures are read from the stock ledger, balances, reservations, purchase orders and GRNs, production output and consumption, sales orders and dispatches, invoices, notes, receipts, supplier payments and parties. The Stage 4–6 dashboards are reused inside the overview, not re-implemented.
- **Management Overview** (`/`, function `management_overview`): 12 business KPIs (invoiced sales kept apart from sales-order value; purchases received kept apart from POs placed; inventory value at weighted-average lot cost, lots without cost reported, never estimated; customer outstanding vs receivables incl. opening balances; supplier outstanding vs payables), inventory per unit (PCS, KG, LTR never added together) with stock value by category, stock movement, low stock, valuation and warehouse tables, purchase, production (daily, monthly, product-wise with yield only where output exists), sales (daily, monthly, product- and customer-wise), invoicing (trend, customer outstanding, GST summary), 12 alert types each linking to the record, and 10 quick actions. The former home page is at `/dashboard/inventory`.
- **Module dashboards**: new `/products/dashboard`, `/ledger/dashboard`, `/purchase-orders/dashboard`, `/goods-receipts/dashboard` (function `module_dashboard`); Production, Sales and Invoicing use the Stage 4–6 dashboards.
- **ERP Settings** (`/admin/erp-settings`, functions `erp_settings_get` / `erp_settings_save`, audited) with tabs Company, Products, Inventory, Purchase, Production, Sales, Invoices, Excel import, Backup & audit and System (the earlier document/reporting/reset settings). Settings that change behaviour:
  - date format for every screen and print; document logo on invoices, notes and POs; financial year start;
  - prefixes for PO, GRN, production and sales order numbers (the counter never restarts or reuses numbers); SKU prefixes per product type and automatic SKUs on/off;
  - units, default GST rate and HSN suggestions on the product form; adjustment reasons offered as notes;
  - default purchase payment and delivery terms; default BOM wastage %; consumption pre-fill on completion; default sales terms, delivery instructions and warehouse; day/month order of imported dates.
  - Fixed rules (valuation method, reservation, negative stock, costing, rejection, duplicate detection) are explained where they cannot be changed. Backups: Supabase-managed; no backup status is shown. Excel exports per area (company data, inventory, sales, purchase, production, invoices) and links to audit and correction history.
- **Global search** in the top bar (`global_search`): product name, SKU, HSN, customer, supplier, PO, GRN, production order, sales order and invoice numbers; partial and case-insensitive; a result opens the record.
- **Activity Centre** (`/activity`, `activity_feed`): products, BOMs, parties, POs, GRNs (and reversals), production, sales orders, reservations, dispatches, invoices, payments (and reversals) and stock adjustments, each with type, reference, time, link and description.
- **Reconciliation** (`/reconciliation`, `erp_reconciliation`): 13 read-only checks — stock = ledger, reserved = active reservations, no negative stock, no duplicate reservations, invoices move no stock, reversals mirror the original, dispatched = consignments; invoice totals = lines, outstanding = total − credits + debits − valid payments, no payments on cancelled invoices or from reversed receipts, receipts not over-allocated, customer ledger and supplier ledger (GRN-based payables; POs are not payables).
- **Reports** (`/reports`, `erp_report`): 20 reports (product master, stock register, stock movements, valuation, low stock, purchase register, GRN register, supplier-wise purchases, production register, material consumption, wastage, sales order register, customer-wise and product-wise sales, dispatch, invoice register, GST summary, customer and supplier outstanding, payment collection) with date / product / customer / supplier filters where they apply, search, totals (cancelled and reversed rows excluded), Excel export and a print / PDF view. The earlier module report pages are listed at `/reports/modules`.
- *Superseded by the V2 frontend scope below:* the quick actions, the Activity Centre, Reconciliation, `/dashboard/inventory` and `/reports/modules` are no longer in the app. Their database functions are unchanged.
- **End-to-end test** `supabase/tests/stage7_e2e_verification.sql` (106 checks) runs the whole 23-step flow through the real functions — products with automatic SKUs, BOM, supplier, PO (no stock), GRN (stock and payable), production (reserve, then deduct materials and add goods), customer, sales orders (finished goods reserved, rest to produce with materials reserved), dispatch, invoice, partial and final payment, ledger and PAID status — then checks the overview, dashboards, all 20 reports, reconciliation, settings, numbering, search, activity, cancellation, reversal, correction, duplicate prevention and an empty company. Also `tests/unit/management-v2.test.ts` (9) and seven UI smoke steps, one of which opens every sidebar link.

### V2 frontend scope (no database changes)
- **Sidebar = the eight approved modules only:**
  1. Management Dashboard
  2. Product Master & BOM
  3. Inventory Management
  4. Purchase Orders & GRN
  5. Production & Outsourcing
  6. Sales Orders & Fulfilment
  7. Billing & Invoicing (includes the customer & supplier ledger)
  8. Reports & Settings (Reports Centre, ERP Settings, Users & Roles, Import History, Audit Log)

  The groups collapse, the sidebar is compact, and every entry opens a page backed by the existing V2 functions. Configuration is in `src/config/navigation.ts` and `src/routes.ts`.
- **Removed from the app:**
  - Executive analytics, Amazon, customer POs, Marketplace ("not built"), Activity Centre, Reconciliation, approvals, barcode/scan tools, document centre, user activity, system health
  - The separate customers and suppliers pages; the ledger replaces them
  - Duplicate overviews: sales, billing, inventory dashboard, production analytics, module reports
  - The "Create from customer PO" and legacy "Manual order" buttons on Sales Orders
  - The dashboard's quick-action panel
- **Kept as they were:** the database objects and migrations behind the removed pages, RLS, permissions and audit logging. The old page files remain on disk but are unreachable. Old addresses of merged pages redirect (`/settings`, `/sales`, `/billing`, `/customers`, `/suppliers`, `/payments`, `/sales-orders`, `/dashboard/inventory`, `/production/analytics`, `/reports/modules`); other legacy addresses show "Page not found".
- **Management Dashboard** (`/`):
  - Filters: Today, This week (from Monday), This month, This year, Custom range.
  - Nine figures, each linking to its module: total, manufactured (in-house lots) and outsourced stock; purchase orders; pending GRNs (POs awaiting goods); production orders; sales orders; invoiced sales; outstanding payments.
  - Charts follow the period, grouped by day, week or month as the range grows: sales orders booked, production output, stock movement (one unit at a time), stock by source, invoiced vs collected, and purchases ordered vs received.
  - Lists: needs attention, low stock, and customer balances.
  - Data comes from the existing `management_overview` and `inventory_overview` functions. Helpers are in `src/features/management/dashboard-model.ts`.
- **Sidebar refinement (frontend only):** the sidebar has 9 sections:
  1. Management Dashboard
  2. Product Master & BOM
  3. Inventory Management
  4. Purchase & GRN
  5. Production & Outsourcing
  6. Sales & Orders
  7. Billing & Invoicing
  8. **Ledger**
  9. Reports & Settings

  Pages removed from the app (routes too; files kept on disk):
  - Inventory: stock adjustments, physical stock count, batch tracking and inventory reports
  - Production: outsourcing orders and outsourced goods receipts
  - Sales: picking, packing, dispatch management, delivery tracking, customer returns, fulfilment reports, and the order "warehouse view"

  Ledger is its own section: Ledger Dashboard, Customer & Supplier Ledger, Customer Ledger (`/ledger/customers`) and Supplier Ledger (`/ledger/suppliers`). The last two are the existing ledger list limited to one side. `/customers` and `/suppliers` redirect there. "Account Transactions" and "Ledger Statements" were not added: no cross-party transaction list or printable party statement exists. Each party's page shows its transactions with running balances, and Billing has Customer Statements.
- Tests: `tests/unit/frontend-scope-v2.test.ts`. The UI smoke suite was updated to 106 steps: steps for removed pages are gone, and new steps cover the dashboard, the 8-module sidebar, the removed addresses and the redirects.
- **Product Master, BOM and Purchase enhancements** (migration `20261109090000_product_purchase_enhancements.sql`; rollback in `supabase/rollback/`; not yet applied to the hosted project):
  - Product form: Lead Time (Days) and Reorder Level (Days) replace Minimum Stock Level. MRP sits in Tax & Pricing and is never used as the invoice price; a selling price above the MRP (incl. GST) only warns. Optional dimensions (cm), supplier model no. and supplier product name are searchable and in the Excel template. A category can be added from the form (“+ Add New Category”).
  - Earlier quantity levels (`reorder_level`, `minimum_level`) are kept as stored and never converted to days. The form shows them, with a button to clear them; until cleared, the reorder quantity still raises low-stock alerts.
  - Planning: days of cover = available ÷ average daily consumption. Consumption is issues, production issues and subcontract consumption, less reversals, over the last 90 days (or since the first movement).
    - It drives the stock status, the inventory overview, the alerts, and a Reorder Planning view (Low Stock Alerts → Reorder planning).
    - That view shows available, reserved and incoming quantities separately, the lead time, and a suggested quantity. There is also a Reorder Planning report.
  - BOM editor: a searchable component selector (name, SKU, barcode, supplier model; stock and unit shown; keyboard and scanner support). The output product and duplicate components cannot be chosen, and each line shows its quantity plus wastage, rounded up to whole pieces.
  - Purchasing: supplier invoice and challan numbers on the order (`purchase_order_save_refs`) and on each GRN (`purchase_receipt_post_refs`, `goods_receipt_direct_post_refs`, `goods_receipt_correct_refs`).
    - They are stored in `purchase_document_refs`, so posted receipts stay unchanged, and they can be edited later (`purchase_document_refs_set`).
    - A supplier invoice number can't be reused on another order or receipt of the same supplier.
    - They appear on the PO and GRN pages, the PO print and the new GRN print (`/goods-receipts/:id/print`), the list searches, the Excel exports and the purchase and GRN registers (`erp_report_v2`).
  - Fix (migration `20261110090000_readonly_rpc_fix.sql`): on the hosted API, the ERP Settings tabs (Company … Excel import) and the invoice import preview failed with "cannot execute INSERT in a read-only transaction".
    - Cause: PostgREST runs STABLE functions read-only, but `erp_settings_get` and `invoice_import_preview` reach `private.billing_settings()`, which inserts the default invoice settings row.
    - Fix: both are now VOLATILE.
    - Check: `npm run test:db:readonly` scans for this mistake and replays these calls read-only. The settings page logs failures (tab, operation, code, message, request id) and shows a reference code with Try again.
  - Stock register, stock accuracy and duplicate-safe production (migration `20261111090000_stock_register_reliability.sql`): see [docs/STOCK_RELIABILITY.md](docs/STOCK_RELIABILITY.md).
  - Persistent form drafts / auto-save (migration `20261117090000_form_drafts.sql`):
    - **What it does:** entries in the main forms survive switching modules, refresh, closing the browser and signing in again.
    - **Forms:** purchase orders, goods receipts, sales orders, invoices, payments, production orders, BOMs, opening stock, products, parties and the invite dialog.
    - **How:** one table `erp_form_drafts` (owner-only RLS, a per-form permission registry, versioned conflict detection, no secrets, no files), the hook `usePersistentFormDraft` and the status bar `FormDraftBar`.
    - **Documentation:** [docs/FORM_DRAFTS.md](docs/FORM_DRAFTS.md), including the lifecycle, coverage and the forms not covered.
    - **Tests:** `supabase/tests/form_drafts_verification.sql` (55 checks), `tests/db/form-drafts-rollback-check.mjs`, `tests/unit/form-drafts.test.ts` and 7 UI smoke steps. The UI smoke suite has 121 steps.
    - **Rollback:** roll back 20261117 first.
  - User invitations and functional roles (migration `20261116090000_user_invitations.sql`, Edge Function `invite-user`):
    - **Roles:** 13 new roles (21 in total), each with an explicit permission set. Access never depends on a role's name.
      - New: Accounts Executive / Accountant, Sales Executive, Billing & Invoicing Manager, Purchase Executive, Warehouse Manager, Store Executive, Production Executive, Quality Control, Dispatch Manager, Dispatch Executive, Legal & Compliance Manager, HR Manager, Reports Viewer.
      - They are grouped into eight categories in the role picker.
    - **Admin roles:** only a Super Admin can assign Super Admin or any administrative role. The `user_roles` insert policy now enforces this too.
    - **Invite User:** name and work e-mail (required); employee ID, department, designation and reporting manager (optional); searchable role cards with View Permissions; selected-role summary; confirmation step.
    - **Users & Roles → Invitations:** status and e-mail status, with Resend / Revoke / Details / Edit roles.
    - **Activation:** `/accept-invitation`, where the invitee sets a password and activates the account. The account stays inactive until then.
    - **E-mail template:** [supabase/templates/invite.html](supabase/templates/invite.html).
    - **Deploy and verification:** §5 and §7 of [docs/SUPABASE_SETUP.md](docs/SUPABASE_SETUP.md).
    - **Tests:** `supabase/tests/user_invitations_verification.sql` (72 checks), `tests/db/user-invitations-rollback-check.mjs`, `tests/unit/invite-user-handler.test.ts` and `tests/unit/invitation-model.test.ts`. The UI smoke suite has 113 steps.
    - **Rollback:** `supabase/rollback/20261116090000_user_invitations_down.sql`. It drops the invitation table; history stays in the audit log. Roll back 20261116 before 20261113 and 20261031.
  - Partial invoicing (migration `20261115090000_partial_invoicing.sql`):
    - **Creating invoices:** only in Billing & Invoicing (no Create Invoice / Dispatch on the Sales Order page; "From dispatches" removed).
    - **Posting:** a sales-order invoice dispatches its goods in the same transaction.
    - **Partial invoices:** a warning before posting, and Super Admins are notified.
    - **Stock Register → Pending / Incomplete Invoice Orders:** tracking only, never stock. Includes five reports and Release Pending Quantity.
    - **Documentation:** section 8 of [docs/STOCK_RELIABILITY.md](docs/STOCK_RELIABILITY.md).
    - **Rollback order:** roll back 20261115 before 20261112.
  - BOM planning fields and Product Master EAN (migration `20261114090000_bom_planning_product_ean.sql`):
    - **BOM:** a "Product Planning & Classification" card shows and edits the finished product's Product Name, Product Type, Tax Rate (`gst_rate`), Lead Time, Group Head and Minimum Stock Days (`minimum_cover_days`; informational).
    - **BOM list:** the six fields, Product Type / Group Head filters, Excel export in the import-template layout.
    - **BOM import:** the six columns, with no duplicate BOM versions when the components are unchanged.
    - **Product Master:** an EAN field (EAN-8 / EAN-13, check digit, unique per company) under Product Identification, searchable, and in the Excel import / export.
    - **Group Head list:** in ERP Settings → Products.
    - **Rollback order:** roll back 20261114 before 20261109.
  - Dispatch before invoice posting (migration `20261112090000_invoice_dispatch_policy.sql`): invoices with stock items post only after the goods are dispatched; services, non-stock items and charges are exempt. See section 7 of [docs/STOCK_RELIABILITY.md](docs/STOCK_RELIABILITY.md).
    - The Stock Register's product view shows on hand, reserved, available, pending PO, expected incoming, and BOM required and shortage.
    - It has indicators, drill-down, Excel export and a stock reconciliation.
    - Production orders record their creation request id (unique), and repeated requests are logged.
  - Tests: `supabase/tests/product_purchase_v2_verification.sql` (64 checks), `tests/db/product-purchase-rollback-check.mjs` and `tests/unit/product-purchase-v2.test.ts`. The UI smoke suite now has 101 steps.

---

Admin ERP for Alton Hi-Tech Sanitary Ware Pvt. Ltd.
React 19 · TypeScript · Vite · Tailwind CSS v4 · shadcn/ui (Radix) · Lucide · Recharts · React Router · Supabase.

- **Phase 1:** frontend shell, navigation, reusable components.
- **Phase 2:** Supabase Auth, RBAC, Row Level Security, audit log.
- **Phase 3:** Product Master.
- **Phase 4:** Inventory management and stock ledger.
- **Phase 5:** Manufacturing and outsourcing (BOM, planning, production orders, outsourcing, traceability).
- **Phase 6:** Customer purchase orders: Excel/CSV upload, product matching, stock availability, allocation and shortages.
- **Phase 7:** Sales orders and fulfilment: PO conversion, picking, packing, dispatch, delivery tracking, backorders, returns, cancellation and reports.
- **Phase 8:** Billing and receivables: GST invoices from dispatches, financial-year numbering, payments and allocations, credit/debit notes, receivables ageing, statements, tax summaries and reports.
- **Phase 9:** Executive dashboard and business analytics: KPIs, sales, inventory, production, PO and fulfilment, financial overview, alert centre and data-quality checks.

```bash
npm install
cp .env.example .env.local   # then fill in your Supabase URL + publishable key
npm run dev                  # http://localhost:5173
npm run build                # type-check + production build
npm run lint                 # oxlint
npm run test:db              # migrations + RLS verification on local PostgreSQL (PGlite)
npm run verify:supabase      # live API checks against your Supabase project (needs test users)
```

## Backend, authentication & security

**Full setup guide: [docs/SUPABASE_SETUP.md](docs/SUPABASE_SETUP.md).** It covers prerequisites, environment variables, applying migrations, type generation, Auth URL configuration, bootstrapping the first Super Admin, inviting and deactivating users, RLS testing, dev/prod setup and troubleshooting.

Summary:

- **Database:** SQL migrations in `supabase/migrations/` create `companies`, `company_settings`, `profiles`, `roles`, `permissions`, `role_permissions`, `user_roles` and `audit_logs`. RLS is on for every table, with explicit minimal grants.
- **Access model:** a user can do something only when their profile is active, belongs to an active company and holds a role with the matching permission (for example `settings.manage`). This is enforced in PostgreSQL by policies that use `private.has_permission(company_id, permission)`.
- **Frontend checks are UX only:** `useAuth`, `usePermissions`, `ProtectedRoute`, `RequirePermission` and `PermissionGate` decide what to show. The database is the security boundary.
- **No public sign-up access:** new auth users get an inactive, company-less profile. Access is granted by an administrator, or by the one-time SQL bootstrap for the first Super Admin.
- **Invitations** go through the `invite-user` Edge Function (`supabase/functions/invite-user`), which holds the service-role key server-side.
  - Company, permission and role checks run in the database with the caller's own session.
  - Invitees activate on `/accept-invitation`.
- **Audit log** is append-only, written by triggers. It records provisioning, activation, role and settings changes, sign-ins and access denials.

## Product Master (Phase 3)

`/products` lists products from Supabase. Search, filters, sorting and paging run in the database. The four KPIs are counted by `product_kpis()`.

| Route | Purpose | Permission |
| --- | --- | --- |
| `/products/new` | Add product (sections A–E, recommendations, image upload) | `products.create` |
| `/products/:id` | Product detail, record info, audit activity (with `audit_logs.read`) | `products.read` |
| `/products/:id/edit` | Edit product | `products.update` |
| `/products/categories` | Categories with product counts; create, edit, (de)activate | `products.read` to view, `product_categories.manage` to change |
| `/products/import` | Excel import: sheet, header row, mapping, preview, validation, confirm, report | `products.import` + `products.create` |

Rules worth knowing:
- **Source type** (`IN_HOUSE` / `OUTSOURCED` / `HYBRID`) is the product's *default sourcing strategy*. The actual source of stock is recorded per receipt or batch by the inventory module (Phase 4).
- **No stock on products.** The `products` table has no quantity columns, by design.
- **SKU:** stored exactly as entered and unique per company, ignoring letter case. A SKU can be corrected only while no transactions reference the product. `private.product_has_transactions()` checks the inventory ledger (Phase 4).
- **No deletion:** products are deactivated, then optionally archived. Categories are deactivated, and only when no active product uses them.
- **Preferred supplier** has a same-company foreign key to `suppliers`. The product form does not set it yet, and clients have no column grant for it.
- **Import** never modifies existing products. Duplicate SKUs are either skipped or treated as errors, as the user chooses. There is no update mode.
- **Export** respects RLS and company scope, and requires `products.export` in the UI. A user who can read products could still copy them manually, so `products.export` controls the export *feature*, not data visibility.

Run tests:

```bash
npm test                              # unit + database (PGlite) suites
npm run build:smoke && npm run test:ui   # UI smoke test against a mock API
```

## Suppliers

Supplier master in `public.suppliers` (migration `20261021090000_suppliers.sql`). Records are company-scoped by RLS and are never deleted: they are deactivated instead.

| Route | Purpose | Permission |
| --- | --- | --- |
| `/suppliers` | KPIs, searchable / sortable / paginated list, status, category and state filters, add, edit, deactivate | `suppliers.read` (`suppliers.manage` to change) |
| `/suppliers/:supplierId` | Overview, contact and addresses, purchase orders, activity history | `suppliers.read` |

Rules worth knowing:
- **Permissions** are the existing seeded `suppliers.read` / `suppliers.manage`. Administrator and Purchase Manager can manage, Accounts Manager can read, and Super Admin has both. Other roles get no supplier access, including roles that only have `purchases.read`. Grant access by assigning one of these roles under User Management.
- **Codes:** leave blank to get the next `SUP-000001` number for the company, or enter your own. Codes are unique per company and cannot be changed later.
- **Duplicates:** the same code or GSTIN is rejected by the database. The form also warns about the same name (ignoring "Pvt Ltd" and similar suffixes), PAN, phone or e-mail, and asks the user to confirm.
- **GSTIN is optional.** When given, it must be valid, and the PAN must match characters 3–12 of the GSTIN.
- **No bank details** are stored: every user with `suppliers.read` can see this table.
- **Purchase orders and goods receipts** of the supplier are listed on its detail page from the purchasing tables, along with the open PO value (goods still to be received). Supplier invoices and payments are not recorded, so **no payable balance** is shown.

## Supplier Purchase Orders and Goods Receipts

Migrations `20261022090000_purchase_order_permissions.sql` and `20261022090100_purchase_orders.sql`. Clients only read the tables (RLS, `purchases.read`). Every change goes through a `SECURITY DEFINER` function. The function takes the company from the signed-in user, checks the permission and status, and recalculates all amounts.

| Route | Purpose | Permission |
| --- | --- | --- |
| `/purchase-orders` | Dashboard figures (from records), order register with filters | `purchases.read` |
| `/purchase-orders/new`, `/:id/edit` | Create an order, or edit a draft (own drafts with `purchase_order.create`, any with `.update`) | `purchase_order.create` / `.update` |
| `/purchase-orders/:id` | Lines, quantities, receipts, approval and amendment history, workflow actions | `purchases.read` (+ action permissions) |
| `/purchase-orders/:id/print` | A4 purchase order (browser "Save as PDF") | `purchase_order.export` |

Lifecycle: Draft → Pending approval → Approved → Sent → Partially received → Fully received. A rejected order goes back to Draft with the reason recorded. Other rules:
- **Cancel** is allowed only for orders with no receipts.
- **Short-close** is for partially received orders.
- **Amend** applies to approved, sent and partially received orders. It creates a new revision as a draft, keeps the previous version, and needs approval again.

Rules worth knowing:
- **Permissions:** `purchase_order.create / update / approve / send / amend / cancel / export`, `purchase_receipt.create`, `purchase_exception.approve`. Each role receives these permissions:
  - **Purchase Manager:** everything except exceptions.
  - **Administrator:** approve, export and exceptions.
  - **Inventory Manager:** receive goods.
  - **Accounts Manager:** export.
  - **Super Admin:** all.
  - **Management Viewer:** read only.
- **Segregation of duties:** the company-wide switch `inventory.segregation_of_duties` (on by default) prevents approving an order you created or submitted.
- **GST:** the place of supply is the company's GSTIN state. Tax is worked out as follows:
  - A supplier with a GSTIN in the same state is charged CGST + SGST; one in another state is charged IGST. The two are never combined.
  - An unregistered supplier is charged no GST.
  - An overseas supplier is treated as an import, and customs duty / IGST on imports is not calculated.
  - A missing company GSTIN blocks submission.
  - A missing line GST rate blocks submission. Rates are never guessed.

  Rounding: lines are rounded to 2 decimals. Round-off applies only when `company_settings` has `purchases.round_off_enabled = true`. The browser preview (`src/features/purchasing/po-calc.ts`) uses the same formulas, and both sets of figures are checked in tests.
- **Goods receipts** post the accepted quantity as `RECEIPT` entries in the existing stock ledger (`private.post_movement`). They are posted in the same transaction as the receipt, at the line cost excluding GST, into a storage location of the order's warehouse. Lots are recorded with source `OUTSOURCED`.
  - Rejected goods go to a rejected-goods or quarantine location, or are recorded only. They never become available stock.
  - Pending = ordered − accepted.
  - Receiving more than is pending needs `purchase_exception.approve` and a reason.
  - Retries with the same request id never post twice.
  - Receipts are reversed from the order (`purchase_exception.approve`). The generic ledger reversal refuses them.
- **Excel / CSV import** (`/purchase-orders/import`, `purchase_order.create`, migration `20261023090000_purchase_order_import.sql`): the import works as follows.
  - **File and template.** Download the template, then upload `.xlsx` / `.csv` (up to 5 MB, 1000 rows, 100 orders, 200 lines per order).
  - **Grouping.** Rows with the same **PO Reference** become one draft. Conflicting order details within a reference are errors, never merged.
  - **Browser checks.** The browser checks formats and rejects formula-like cells; formulas are never evaluated.
  - **Server preview.** The server looks up supplier, product and warehouse codes in the user's company only, then dry-runs `purchase_order_save` and rolls it back. The preview therefore shows the real GST totals and row-numbered errors.
  - **Confirm.** On confirm, each order is created as a DRAFT in its own subtransaction, all lines or none.
  - **Duplicates.**
    - Retries with the same request id return the first result.
    - A PO Reference can be imported only once per supplier (`purchase_order_import_refs`).
    - Re-uploading the same file is flagged.
  - **History.** Runs are recorded in `import_jobs` (Bulk Operations, audit `import.completed`), and each draft gets a `purchasing.imported` event.
  - **Nothing else happens automatically.** Imports never create suppliers or products, and never approve, send, receive or post stock.
- **Not included:** supplier invoices / payments (payables), file attachments on orders, and e-mailing the order. Serial numbers are stored only as text on the receipt line, because inventory does not track serials.

## Inventory (Phase 4)

**Source of truth:** the append-only ledger `inventory_transactions`. Balances per product, location and lot are maintained in the same database transaction by `SECURITY DEFINER` RPCs. Each RPC checks permissions, takes row locks and requires an idempotency key. The browser never writes stock tables directly. Each lot records its actual source (`IN_HOUSE` / `OUTSOURCED`, or `UNKNOWN`, which is flagged for review).

| Route | Purpose | Permission |
| --- | --- | --- |
| `/inventory` | Overview: current position, period movements, approvals | `inventory.read` |
| `/inventory/stock`, `/inventory/stock/:productId` | Stock register (by product or by location/lot) and product stock card | `inventory.read` |
| `/inventory/movements` | Ledger; receipt, issue, transfer, reversal | `inventory.read` (`inventory.create`, `inventory_transfer.create`, `inventory.adjust` to post) |
| `/inventory/warehouses` | Warehouses and locations | `inventory_warehouse.manage`, `inventory_location.manage` |
| `/inventory/batches` | Lots, expiry | `inventory_batch.read` |
| `/inventory/reservations` | Reservations | `inventory_reservation.create` / `.release` |
| `/inventory/adjustments` | Adjustment requests and approval (segregation of duties) | `inventory.adjust`, `inventory.approve_adjustment` |
| `/inventory/counts`, `/inventory/counts/:countId` | Physical counts: snapshot, count sheet, variance approval | `inventory_count.create` / `.approve` |
| `/inventory/opening-stock`, `/inventory/opening-stock/import` | Opening stock: manual or Excel/CSV, staged for approval | `inventory_opening.create` / `.approve` |
| `/inventory/reports` | 14 reports, including stock as of date, valuation and reconciliation | `inventory_reports.read` |
| `/inventory/alerts` | Low-stock, expiry and data-quality alerts | `inventory.read` |

Setup after migrating (create a warehouse, set the inventory policy) is in [docs/SUPABASE_SETUP.md](docs/SUPABASE_SETUP.md#phase-4-inventory-).

## Manufacturing & Outsourcing (Phase 5)

Production and outsourcing never keep their own stock. Every stock change is a posting in the Phase 4 ledger, made by a permission-checked, idempotent database function.

**Whole pieces.** Items counted in pieces (PCS, NOS, SET, PAIR) are planned, reserved, issued, received and posted in whole numbers only, enforced by database triggers. BOM requirements add wastage first, then round up to whole pieces; the theoretical BOM ratio is shown separately. Fractional quantities from before this rule are listed, never changed, at `/inventory/whole-piece-audit` (`inventory_reconciliation.run`) and are reconciled with approved stock adjustments. See [docs/WHOLE_PIECE_QUANTITIES.md](docs/WHOLE_PIECE_QUANTITIES.md).

| Route | Purpose | Permission |
| --- | --- | --- |
| `/production` | Overview: open/in-progress/completed orders, shortages, output, approvals, charts | `manufacturing.read` |
| `/production/boms`, `/production/boms/:id` | BOMs with versions, effective dates, approval (SoD), circular-reference checks | `production_bom.read` (+ create / update / approve) |
| `/production/planning` | Material requirements (with wastage) vs available stock; creates draft orders. Moves no stock. | `production_plan.create` |
| `/production/orders`, `/production/orders/:id` | Order workflow: submit, approve, reserve, start, issue, output, hold, complete, cancel, reversals, history | `manufacturing.read` (+ action permissions) |
| `/production/consumption` | Material issues register | `manufacturing.read` |
| `/production/receipts` | Finished-goods receipts (good / rejected / scrap) | `manufacturing.read` |
| `/production/outsourcing`, `/production/outsourcing/:id` | Outsourcing orders, material sent to / returned from suppliers, receipts | `outsourcing.read` (+ action permissions) |
| `/production/outsourced-receipts` | Outsourced goods receipts register | `outsourcing.read` |
| `/production/reports` | 14 reports (CSV/Excel export) and the batch traceability explorer | `production_reports.read` |

Rules worth knowing:
- **Materials** are deducted only when issued to a started order. **Finished goods** are added only by an output receipt. **Rejected goods** go to a non-saleable location or are recorded only. **Scrap** is recorded only.
- **Outsourced processing:** company material sent to a supplier stays company stock at an external-processing location. When goods return, the material used is posted as consumed, so nothing is counted twice.
- **Costs** come only from recorded data (lot costs, recorded prices). Missing costs show as "Cost data incomplete", never as zero.
- **Suppliers:** outsourcing orders still store the supplier as a controlled name/reference (`supplier_id` stays empty). Linking them to the supplier master is a separate change.

Setup steps and the stock-movement table are in [docs/SUPABASE_SETUP.md](docs/SUPABASE_SETUP.md#phase-5-manufacturing--outsourcing-).

## Purchase Orders & Fulfilment (Phase 6)

Customer POs are uploaded from Excel or CSV, matched to products, checked against real stock and allocated through the Phase 4 reservation system. Nothing reserves or moves stock until a user confirms it, and every change is made by a permission-checked database function.

| Route | Purpose | Permission |
| --- | --- | --- |
| `/customer-pos` | Dashboard: KPIs, status, demand, shortages, in-house vs outsourced availability | `customer_po.read` |
| `/customer-pos/upload` | 7-step wizard: file, sheet, column mapping, validation, matching, stock preview, review and import | `customer_po.import` |
| `/customer-pos/register`, `/customer-pos/:poId` | PO register and PO detail (header edit, hold/resume/cancel, revisions and diff, dispatch, timeline) | `customer_po.read` (+ action permissions) |
| `/customer-pos/matching` | Resolve unmatched, ambiguous, invalid and duplicate lines | `customer_po.match` to change |
| `/customer-pos/availability` | Per-line availability, split by source and warehouse, lot eligibility | `customer_po.read` |
| `/customer-pos/fulfilment` | Allocation strategies, manual lot selection, draft plans, commit | `customer_po.allocate` to commit |
| `/customer-pos/shortages` | Shortages with suggested actions and follow-up | `customer_po_shortages.read` |
| `/customer-pos/allocations` | PO reservations: release and dispatch | `customer_po.release`, `customer_po.fulfil` |
| `/customer-pos/history` | Activity, imports, allocation runs | `customer_po.read` |
| `/customers` | Customer master | `customers.read` / `customers.manage` |

Rules worth knowing:
- **Matching order:** exact internal SKU, verified customer code, exact barcode, then a normalized code only when exactly one product matches. Anything else needs a manual choice. Descriptions are never used for matching.
- **Available stock** is on hand minus all reservations, in storage locations only, from active unexpired lots of known source. Several lines for the same product share stock in line order.
- **Files are not stored:** only parsed rows, the file name and a SHA-256 fingerprint are saved.
- **No unit conversion:** a line whose unit differs from the product's unit is flagged for correction.
- The module does not create supplier POs, production orders or customer messages. Shortage actions are suggestions only.

Setup steps are in [docs/SUPABASE_SETUP.md](docs/SUPABASE_SETUP.md#phase-6-customer-purchase-orders-).

## Sales & Fulfilment (Phase 7)

A matched customer PO becomes a sales order; the PO's reservations move with it. Stock leaves the ledger exactly once, when a consignment is dispatched. Every action is a permission-checked database function; nothing is created or dispatched automatically.

| Route | Purpose | Permission |
| --- | --- | --- |
| `/sales` | Overview: 12 KPIs and 6 charts (quantities, not revenue) | `sales_orders.read` |
| `/sales/orders` | Server-paged order list; create from customer PO or manually | `sales_orders.read` (+ `sales_orders.create`) |
| `/sales/order-details` | Lines, reservations, pick lists, consignments, movements, returns, history; confirm, hold, allocate, edit | `sales_orders.read` (+ action permissions) |
| `/sales/picking` | Pick lists from reserved stock, barcode/SKU/batch entry, pick exceptions | `fulfilment.read` (+ `fulfilment.pick`) |
| `/sales/packing` | Verify, pack, record damaged/missing items, mark ready, reopen | `fulfilment.read` (+ `fulfilment.pack`) |
| `/sales/dispatch` | Transport details and the dispatch posting | `fulfilment.read` (+ `fulfilment.dispatch`) |
| `/sales/delivery` | Delivery events, expected vs actual, overdue, tracking-number search | `fulfilment.read` (+ `fulfilment_delivery.update`) |
| `/sales/backorders` | Outstanding quantities, backorder reasons, customer-approved reductions, allocate/release | `sales_orders.read` |
| `/sales/returns` | Request → authorise → quarantine receipt → inspection → dispositions | `fulfilment.read` (+ `fulfilment_returns.*`) |
| `/sales/cancellation` | Impact preview and cancellation | `sales_orders.read` (+ `sales_orders.cancel`) |
| `/sales/reports` | 14 fulfilment reports with CSV/Excel export | `fulfilment_reports.read` (+ `.export`) |

Rules worth knowing:
- **Remaining = ordered − cancelled − dispatched.** Reserved, picked and packed are stages, not fulfilment. Remaining quantity is never cancelled automatically.
- **Returns** sit in quarantine and are not available until an inspected line is restocked. Credit notes for returned goods are raised in Billing (Phase 8).
- **Delivery tracking is manual.** No carrier integration is configured; manual events are marked unverified.

Setup steps are in [docs/SUPABASE_SETUP.md](docs/SUPABASE_SETUP.md#phase-7-sales-orders-and-fulfilment-).

## Billing & Accounts (Phase 8)

Invoices are drafted only from dispatched (or, by policy, delivered) quantities that are not already invoiced. The database calculates every amount, assigns numbers at issue and freezes issued documents. Billing never changes stock.

| Route | Purpose | Permission |
| --- | --- | --- |
| `/billing` | Overview: 8 KPIs, invoicing vs collections, ageing, top customers, recent and overdue items | `billing_reports.read` |
| `/billing/invoices` | Drafts, pending, open, overdue, paid and cancelled invoices (server-paged) | `invoices.read` |
| `/billing/invoices/new` | Manual invoice, invoice from a sales order, or (`?mode=dispatch`) pick dispatched lines of one customer → draft invoice | `invoices.create` |
| `/billing/invoices/:id` | Edit draft, validation, tax review, submit/approve, issue, cancel, payments, notes, history | `invoices.read` (+ action permissions) |
| `/billing/invoices/:id/print` | A4 invoice from saved snapshots; PDF via the browser print dialog | `invoices.read` |
| `/billing/register` | Issued and cancelled invoices by financial year, customer, status; export | `invoices.read` |
| `/billing/payments` | Record receipts (with allocations), receipt details, reverse | `payments.read` (+ `payments.manage`, `payments.reverse`) |
| `/billing/allocations` | Allocate unallocated receipts to open invoices | `payments.read` (+ `payments.manage`) |
| `/billing/receivables`, `/billing/ageing` | Open balances and ageing buckets as of any date | `billing_reports.read` |
| `/billing/credit-notes`, `/billing/debit-notes`, `/billing/notes/:id` | Notes against issued invoices (optionally linked to received returns) | `invoices.read` (+ `invoice_adjustments.*`) |
| `/billing/statements` | Printable customer statement with running balance | `billing_reports.read` |
| `/billing/tax-summary` | Tax by month, GST rate and HSN (management report, not a GST return) | `billing_reports.read` |
| `/billing/reports` | 12 billing reports with CSV/Excel export | `billing_reports.read` (+ `.export`) |
| `/billing/settings` | Numbering, financial year, tax policy, terms, bank, footer | `billing_settings.manage` |

Rules worth knowing:
- **The system is not certified as GST-compliant.** It calculates CGST/SGST/IGST from the data you enter. No e-invoice IRN/QR, e-way bill or GST portal filing is generated.
- **Receipts are user-recorded and unverified.** There is no bank or payment-gateway integration.
- **Approval (optional):** when required, the person who submitted an invoice or note cannot also approve and issue it.

Setup steps are in [docs/SUPABASE_SETUP.md](docs/SUPABASE_SETUP.md#phase-8-billing-invoicing-and-receivables-).

## Executive Dashboard & Analytics (Phase 9)

Read-only analytics over the Phase 3-8 records. Each figure is aggregated in the database by permission-checked, company-scoped functions; there are no analytics tables or cached copies. Sections the user's role may not see are shown as unavailable, never as zero.

| Route | Purpose | Permission |
| --- | --- | --- |
| `/analytics` | Executive KPIs (sales, billing, stock, production), trends and top alerts; view ordered by role | `dashboard.read` (+ module permissions) |
| `/analytics/sales` | Order vs dispatched vs invoiced value, trends, customers, products, categories, fulfilment, shortages | `sales_orders.read` |
| `/analytics/inventory` | Current position by warehouse, category and source; movements, transfers, adjustments, counts, expiry, valuation | `inventory.read` |
| `/analytics/production` | Planned vs actual, completion rate, material outlook, consumption, delays, scrap, outsourcing | `manufacturing.read` |
| `/analytics/fulfilment` | PO pipeline, fulfilment stages and the paged shortage report | `customer_po.read` |
| `/analytics/finance` | Invoicing vs collections, ageing, collection rate, customer balances, due dates, notes | `billing_reports.read` |
| `/analytics/alerts` | Alert centre with severity, type, team and date filters | `dashboard.read` |
| `/analytics/data-quality` | Read-only reconciliation checks | `audit_logs.read` |
| `/reports` | Index of every report the user can open | `reports.read` |

Rules worth knowing:
- **Order, dispatched and invoiced value are different measures.** They come from price snapshots, dispatch records and issued invoices respectively, and collections are recorded receipts.
- **Stock figures are the current position.** Period opening and closing balances are rebuilt from the stock ledger.
- **Units are never added together, and quarantined, rejected or external-processing stock is never "available".**
- **Valuation is shown only when every lot on hand has a recorded cost.** Otherwise the page says "Valuation unavailable — cost data required". Profit, margin, net income and cash flow are listed as unavailable.
- **Every card can be exported and printed.** Exports use the module's export permission and include the period, filters and generation time. Drill-downs open the source records through the existing RLS-protected views.

Setup details are in [docs/SUPABASE_SETUP.md](docs/SUPABASE_SETUP.md#phase-9-executive-dashboard-and-analytics-).

## Administration & Productivity (Phase 10)

| Route | Purpose | Permission |
| --- | --- | --- |
| `/notifications` | Notification centre: filters, mark read, dismiss, per-type preferences (bell badge in the top bar) | signed in |
| `/admin/approvals` | Approval inbox, my requests, module approvals, workflow editor | `approvals.read` (`approvals.manage` for workflows) |
| `/admin/barcodes` | Scan & look up, scan station (receipt / issue / transfer / verification), label printing, barcode assignment | `products.read` |
| `/scan?c=…` | Target of printed QR labels; opens the record after a permission check | signed in |
| `/admin/documents` | Private documents per record, versions, preview / download, archive | `documents.read` |
| `/admin/bulk-operations` | Import history, rejected rows, error reports, retry through the original import page | `bulk_operations.read` |
| `/audit-logs` | Audit Log Viewer: server-paged, filters, CSV export | `audit_logs.read` |
| `/admin/user-activity` | Users, roles, sign-in and activity, security events, activate / deactivate, end sessions | `users.manage` |
| `/admin/system-health` | Live checks and recent errors with correlation ids | `system_health.read` |
| `/admin/erp-settings` | Document rules, default report period, links to every settings page, integration status | `settings.manage` |

Rules worth knowing:
- **Scanning never posts stock.** The scan station builds a list. Lines are posted only after review and confirmation, through the existing inventory functions, and each line has its own idempotency key so a retry cannot post twice.
- **Approvals gate, they don't act.** Configured workflows block the existing module step until approved; the user then completes it in the module.
- **Notifications are in-app only.** Email and push are shown as "Not configured" and Realtime is not used.
- **Imports are recorded, not re-run.** A retry means correcting the rejected rows and importing them on the original import page, which still rejects duplicates.
- **Reset ERP Data (Super Admin only)** on `/admin/erp-settings` permanently deletes the company's business data, after a password re-check and typing `RESET ERP`, through the `reset-erp-data` Edge Function. Users, roles, settings, products, the audit log and the schema are kept. It **refuses** while protected history exists (stock ledger, invoices, payments, BOMs, event history) and never disables a guard to force it. See [docs/ERP_RESET.md](docs/ERP_RESET.md).
- **Force Reset / Delete Everything (Super Admin only, approved demo/development data only)** on the same page deletes all business data, including protected history, products, warehouses and stored files. It requires:
  - an environment approval created by a database owner in the SQL Editor;
  - a backup record confirmed by the administrator (an attestation, not an automatic check);
  - a fresh password check;
  - typing `DELETE ALL COMPANY DATA` and the company code.

  It runs through the `force-reset-erp-data` Edge Function and verifies the result in the database and in Storage before reporting success. Guards stay enabled; they allow a delete only inside that reset's own transaction for that company. See [docs/ERP_RESET.md](docs/ERP_RESET.md).

Setup details are in [docs/SUPABASE_SETUP.md](docs/SUPABASE_SETUP.md#phase-10-administration-and-productivity-).

## Production readiness (Phase 11)

Phase 11 audited all modules, added a readiness test suite and a volume test, and fixed the defects found. It did not add any new business features.
- Release checklist, environments and secrets, backup and recovery, rollback and KPI definitions: [docs/PRODUCTION_READINESS.md](docs/PRODUCTION_READINESS.md).
- `npm run test:db` includes the readiness suite: end-to-end scenario, ledger invariants, cross-company sweep and escalation attempts.
- `node tests/db/perf-smoke.mjs 10000` posts 10 000 receipts and 5 000 issues through the real ledger functions and times the main lists and dashboards.
- `scripts/concurrency-check.mjs` sends parallel requests to a **staging** project to check that stock can't be over-issued or over-reserved. It refuses to run without `CONFIRM_STAGING=yes`.

**Staging (Phase 12):** follow [docs/STAGING_SETUP.md](docs/STAGING_SETUP.md).
- The test companies and accounts come from `supabase/staging/seed_staging_test_data.sql`.
- `npm run verify:supabase` checks authentication, every role and company isolation.
- `npm run verify:concurrency` races stock issues, reservations, dispatch, invoicing and payments, in test company STG-A only.
- `npm run test:staging-local` checks the seed and dry-runs both scripts against a local emulation. That is not staging validation.
## Amazon Sales & Profit Intelligence

Sidebar group **Amazon Intelligence** (12 pages under `/amazon`):
- Overview, product performance, campaigns, keyword intelligence and profitability
- Budget planner and inventory & demand
- Listing health, recommendations with change approvals, and CSV reports
- API integration settings, and sync history & audit

How data gets in:
- **Selling Partner API and Amazon Ads API:** through the `amazon-spapi` and `amazon-ads` Edge Functions. Credentials are kept only in Edge Function secrets.
- **Amazon report files:** importable until the APIs are connected.
- **Demo data:** clearly labelled and removable, and never mixed with live data or ERP records.

Advertising changes need a request, approval by a different person, and explicit execution. Execution is blocked while the module is in read-only mode (the default) or the kill switch is on (also the default).
- Setup, secrets, Amazon authorisation steps, formulas and limits: [docs/AMAZON_INTEGRATION.md](docs/AMAZON_INTEGRATION.md).
- Tests: `npm run test:db` includes `amazon_verification.sql`. Unit tests cover the formulas, allocator, rules, import parsing and the API clients.
## Structure

```
src/
  auth/          AuthProvider, useAuth, usePermissions, ProtectedRoute, RequirePermission, PermissionGate, permission codes
  config/        app.ts (company, sample-data flag), navigation.ts (sidebar, routes, page permissions), status.ts, labels.ts
  types/         domain types + database.ts (Supabase table/function types)
  services/      data access layer (Supabase): access, users, company, audit-logs, products, inventory, production, customer-po, sales, billing
  data/sample/   development-only sample data (see its README)
  hooks/         useAsync, usePersistentState, useVisibleNavItems
  lib/           supabase client, error messages, formatting (en-IN, INR, timezones), date-range helpers
  components/
    ui/          shadcn/ui primitives
    auth/        auth layout, status screens, password input
    layout/      AppLayout, Sidebar, TopNav, GlobalSearch, Breadcrumbs, CompanyLogo
    common/      PageHeader, KpiCard, DataTable, filters, badges, dialogs, empty/loading/error states, …
    charts/      Recharts components + validated chart palette
  pages/         one file per module; pages/auth/ for login, forgot and reset password
  routes.ts      lazy-loaded page for each navigation key
supabase/
  migrations/    versioned SQL (apply in order)
  functions/     invite-user Edge Function
  tests/         *_verification.sql suites for each phase, up to billing_verification.sql (run locally and in the SQL Editor), local test shim
tests/db/        PGlite runner for the RLS suite
scripts/         verify-supabase.mjs, concurrency-check.mjs (live STAGING checks), lib/staging.mjs
```

## Adding a module / route

1. Add an entry to `NAV_ITEMS` and its required permission to `NAV_PERMISSIONS` in `src/config/navigation.ts`.
2. Add the page to `PAGE_COMPONENTS` in `src/routes.ts`. TypeScript reports an error if either is missing.
3. Any new database table must follow the RLS checklist in docs/SUPABASE_SETUP.md §8.

## Sample data

No module shows sample data. Every page reads real Supabase data and shows an empty state when there are no records. The unused sample-data service and the `VITE_USE_SAMPLE_DATA` flag were removed in Phase 11. Marketplace Orders is **not built**: they are labelled as such in the sidebar and on the page, and nothing on them is stored.
