# Department-wise Data Management: mapping, dependency report and safety plan

**Status:** for review. Nothing has been built, deleted or migrated.

**Source:** the current schema (all migrations loaded into a local database) — 109 tables, 271 foreign keys and 165 triggers read from the database catalogue, not from memory.

## 1. Summary

1. **Each department can be managed independently, but only for working data.** That covers drafts, unposted and cancelled documents, open reservations, alerts and similar records. The preview counts exactly what will be removed, and the operation runs in one database transaction.
2. **Posted history is not departmental.** Posted stock movements, goods receipts, production output and consumption, dispatches, issued invoices, credit and debit notes, and payments are linked across departments.
   - Every posted stock movement belongs to the Inventory stock ledger, whichever department posted it.
   - Issued invoices point at dispatches; dispatches point at stock movements and reservations; and so on down the chain.
   - Deleting one department's posted records alone would break stock reconciliation, ledger balances or GST records. The module therefore **blocks** it, and the preview names the dependent records that block it.
3. **Posted financial and GST records are never permanently deleted by this module.** This covers issued invoices, credit and debit notes, customer payments and allocations, and supplier payments. They are kept, and handled only through the existing cancellation and reversal workflows. Indian GST law (CGST Act, section 36) requires accounts and records to be kept for 72 months after the due date of the annual return.
4. **Archiving** uses the archive and inactive states that already exist on master data (products, BOMs, customers, suppliers, warehouses, locations, categories). Transactions have no archive flag; adding one would be an additive migration, so it is listed as a decision.
5. **Wiping a whole company's history** remains the existing ERP Reset and Force Reset (Settings → System), which already remove the full dependency chain in the right order. This module does not duplicate it.

## 2. What already exists and will be reused

| Existing piece | Where | Reuse |
|---|---|---|
| Standard reset: ordered list of 81 company tables (`ord` 0–6, dependants first) | `private.erp_reset_tables()` (migration 20261118090000) | Deletion order inside each department |
| Force reset: purges history, including guarded tables, inside one session-scoped exemption | `private.erp_force_purge_allows()`, `erp_force_purge_sessions` (20261031090000, 20261113090000) | Model for a narrower, department-scoped exemption (decision D4) |
| Backup records: immutable, valid 24 h, single use | `public.erp_reset_backup_attestations` | Backup check before any permanent delete |
| Run records: immutable | `public.erp_reset_runs` | Operation status, counts, time, failure details (with a new `scope` value) |
| Audit log: immutable (`prevent_audit_log_mutation`) | `public.audit_logs` | One entry per preview, run and failure |
| Super Admin check | `private.require_permission('system.reset_data')`, held only by Super Admin | Authorisation |
| Composite foreign keys `(company_id, id)` on every business link | all tables | A row can only ever reference a row of the same company |
| RLS on every company table | all tables | Unchanged; the operations run as protected server functions and never disable RLS |

## 3. Table → department mapping (all 109 tables)

**Kinds:**
- **M**: master data.
- **D**: document (has a status).
- **P**: posted or ledger data. Immutable, or guarded once posted.
- **H**: history or event log. Immutable.
- **W**: working data (requests, alerts, sequences).
- **S**: system. Never touched.

**Guards** are the triggers that block DELETE or UPDATE today.

### 1. Product Master & BOM (5)

| Table | Kind | Guards / notes |
|---|---|---|
| `products` | M | archive = INACTIVE + `archived_at`; referenced by 20 tables in every department |
| `product_categories` | M | referenced by products |
| `product_versions` | H | `guard_product_version`: read-only; referenced by stock movements, production orders and material plans, BOM lines |
| `boms` | D/M | `guard_bom_write`: approved versions are immutable; referenced by production and outsourcing orders |
| `bom_items` | D | `guard_bom_item_write` |

### 2. Inventory Management (13)

| Table | Kind | Guards / notes |
|---|---|---|
| `warehouses`, `inventory_locations` | M | status ACTIVE / INACTIVE; referenced by POs, SOs, production, fulfilment, counts |
| `inventory_transactions` | P | `prevent_ledger_mutation`: the stock ledger. Holds movements posted by **every** department (GRN, production, outsourcing, dispatch, returns, adjustments, opening, counts) |
| `inventory_balances` | P | derived from the stock ledger |
| `inventory_batches` | P | lots; referenced by 10 tables |
| `stock_reservations` | D | `reference_type` / `reference_id` point at sales order lines or production orders (no foreign key) |
| `inventory_adjustments` | D | approval workflow; posted ones have a stock movement |
| `inventory_counts`, `inventory_count_lines` | D | |
| `inventory_opening_batches`, `inventory_opening_lines` | D | |
| `inventory_alerts`, `inventory_requests` | W | idempotency keys, alerts |

### 3. Purchase & GRN (8)

| Table | Kind | Guards / notes |
|---|---|---|
| `purchase_orders`, `purchase_order_lines` | D | supplier → Ledger; warehouse → Inventory |
| `purchase_order_events`, `purchase_order_amendments`, `purchase_order_import_refs` | H | `prevent_history_mutation` |
| `purchase_document_refs` | W | supplier invoice and challan references |
| `goods_receipts` | P | `guard_posted_document`; **also the source of supplier payables in the Ledger** |
| `goods_receipt_lines` | P | `prevent_history_mutation`; point at stock movements |

### 4. Production & Outsourcing (12)

| Table | Kind | Guards / notes |
|---|---|---|
| `production_orders`, `production_order_materials` | D | BOM, product versions → Products; warehouses → Inventory; `sales_order_id` → Sales (no foreign key) |
| `production_order_events`, `production_order_requests` | H | `prevent_history_mutation` |
| `production_order_revisions` | H | no foreign key, by design (released-order amendments) |
| `production_material_consumption`, `production_output_receipts` | P | `guard_posted_document`; point at stock movements and lots |
| `outsourcing_orders`, `outsourcing_order_materials` | D | |
| `outsourcing_order_events` | H | |
| `outsourcing_material_movements`, `outsourcing_receipts` | P | `guard_posted_document` |

### 5. Sales & Orders (16)

| Table | Kind | Guards / notes |
|---|---|---|
| `sales_orders`, `sales_order_lines` | D | customer → Ledger; lines referenced by invoice lines (Billing) and fulfilment lines |
| `sales_order_events` | H | |
| `fulfilments`, `fulfilment_lines` | P once dispatched | `dispatch_reversal_guard`; point at stock movements, lots and reservations; referenced by invoice lines and invoice-dispatch allocations (Billing) |
| `delivery_events` | H | |
| `customer_returns`, `customer_return_lines` | D/P | return receipts are stock movements; referenced by credit notes (Billing) |
| `customer_product_codes` | M | |
| `customer_purchase_orders`, `customer_purchase_order_lines`, `customer_po_import_batches` | D | legacy Phase 6 module (not in the V2 menu); SO lines reference CPO lines |
| `customer_po_events`, `customer_po_allocation_runs`, `customer_po_analysis_snapshots`, `customer_po_shortage_notes` | H | |

### 6. Billing & Invoice (8)

| Table | Kind | Guards / notes |
|---|---|---|
| `sales_invoices`, `sales_invoice_lines` | P once issued | `guard_invoice_change`, `guard_invoice_line_change`, `invoice_dispatch_guard`; **GST records** |
| `sales_invoice_dispatch_allocations` | P | |
| `invoice_adjustment_notes`, `invoice_adjustment_note_lines` | P once issued | `guard_note_change`; **GST records** |
| `customer_payments`, `invoice_payment_allocations` | P | `guard_payment_change` |
| `billing_events` | H | |

### 7. Ledger (4)

| Table | Kind | Guards / notes |
|---|---|---|
| `customers`, `suppliers` | M | status; referenced by every trading document |
| `parties` | M | opening balances (part of receivables and payables) |
| `supplier_payments` | P | `guard_supplier_payment` |

### Not part of any department — never touched (21 system tables)

`companies`, `company_settings`, `profiles`, `user_roles`, `roles`, `permissions`, `role_permissions`, `user_invitations`, `audit_logs`, `erp_reset_runs`, `erp_reset_backup_attestations`, `approval_workflows`, `approval_workflow_stages`, `notification_preferences`, `notification_sync_state`, `error_events`, `inventory_number_sequences`, `billing_number_sequences`, `invoice_settings`, `amazon_settings`, `amazon_connections`.

These are user accounts, company settings, roles, permissions, authentication links, numbering and system configuration, all of which the request excludes. Number sequences are kept, so document numbers are never reused.

### Cross-cutting — handled by rule, not by department (22 tables)

| Table | Rule |
|---|---|
| `approval_requests`, `approval_decisions` | point at documents by type and id (no foreign key). A pending request blocks deleting its document. Decisions are immutable and kept. |
| `notifications` | removed with their document, matched on `related_entity_type` / `related_entity_id` |
| `import_jobs`, `import_job_rows` | immutable import history; kept |
| `erp_form_drafts` | unsaved drafts of a removed record are removed with it (by `record_id`) |
| `documents`, `document_versions` | attached files: kept (stored files are outside this scope) |
| `amazon_*` (14 tables) | Amazon module, not in the V2 menu; untouched |

Check: 5 + 13 + 8 + 12 + 16 + 8 + 4 + 21 + 22 = **109**, which is every table in `public`.

## 4. Cross-department dependency report

### 4.1 Foreign keys between departments (all `RESTRICT` or `NO ACTION`; no cascades)

| From (child) → to (parent) | Links |
|---|---|
| **Billing → Sales** | `sales_invoice_lines.fulfilment_line_id`, `sales_invoice_lines.sales_order_line_id`, `sales_invoice_dispatch_allocations.fulfilment_line_id`, `invoice_adjustment_notes.customer_return_id` |
| **Billing → Ledger** | `sales_invoices.customer_id`, `customer_payments.customer_id`, `invoice_adjustment_notes.customer_id` |
| **Billing → Products** | `sales_invoice_lines.product_id` |
| **Sales → Inventory** | `fulfilment_lines.issue_transaction_id`, `.batch_id`, `.reservation_id`; `customer_return_lines.receipt_transaction_id`, `.batch_id`; `customer_returns.receipt_location_id`; `fulfilments`, `sales_orders`, `customer_purchase_orders` → `warehouses` |
| **Sales → Ledger** | `sales_orders.customer_id`, `customer_returns.customer_id`, `customer_product_codes.customer_id`, `customer_purchase_orders.customer_id` |
| **Sales → Products** | `sales_order_lines`, `customer_purchase_order_lines`, `customer_product_codes` → `products` |
| **Production → Inventory** | consumption, output receipts, outsourcing receipts and movements → `inventory_transactions` and `inventory_batches`; production and outsourcing orders → `warehouses` / `inventory_locations` |
| **Production → Products** | `production_orders.bom_id`, `.finished_product_id`, `.product_version_id`; `production_order_materials.component_product_id`, `.component_version_id`; `outsourcing_orders.bom_id`, `.product_id`; `outsourcing_order_materials.component_product_id` |
| **Purchase → Inventory** | `goods_receipt_lines.accepted_transaction_id`, `.rejected_transaction_id`; `purchase_orders.warehouse_id` |
| **Purchase → Ledger** | `purchase_orders`, `goods_receipts`, `purchase_document_refs`, `purchase_order_import_refs` → `suppliers` |
| **Purchase → Products** | `purchase_order_lines.product_id` |
| **Inventory → Products** | `inventory_batches`, `inventory_adjustments`, `inventory_count_lines`, `inventory_opening_lines` → `products`; `inventory_transactions.product_version_id` → `product_versions` |
| **Products → Ledger** | `products.preferred_supplier_id`, `bom_items.preferred_supplier_id` (optional) |

Every one of these is a composite `(company_id, …)` key, so no link can cross companies.

### 4.2 Links without a foreign key, which the module must check itself

| Link | Meaning |
|---|---|
| `inventory_transactions.reference_type / reference_id / document_type / document_id` | which GRN, production order, dispatch, adjustment, opening or count posted the movement |
| `stock_reservations.reference_type / reference_id` | reservations for sales order lines and production orders |
| `production_orders.sales_order_id / sales_order_line_id` | production made for a sales order |
| `production_order_revisions.production_order_id` | amendment history of released orders |
| `approval_requests.document_type / document_id`, `notifications.related_entity_*`, `erp_form_drafts.record_id` | cross-cutting (section 3) |

### 4.3 Computed dependencies (no link, but figures depend on the records)

| Figure | Built from |
|---|---|
| Stock on hand, available and valuation | `inventory_balances` / `inventory_transactions` posted by Purchase, Production, Sales and Inventory |
| Customer receivables | Billing (issued invoices, notes, payments) + Ledger opening balances |
| Supplier payables | Purchase (posted GRNs) + Ledger (supplier payments, opening balances) |
| Product version snapshots on transactions | Products (`product_versions`) |
| Dashboards, reports, Excel exports | everything above |

### 4.4 Dependency graph and deletion order

An arrow means "refers to". A department's records can only be removed once nothing pointing at them remains.

```
Billing ──► Sales ──► Inventory ──► Products ──► (Ledger: preferred supplier, optional)
   │          │           ▲  ▲          ▲
   │          │           │  │          │
   │          └──► Ledger │  │          │
   └──► Ledger            │  │          │
Production ───────────────┘  │ ─────────┘
Purchase ────────────────────┘ ──► Ledger, Products
```

Removal order, dependants first (matching `erp_reset_tables().ord`): **Billing → Sales → Production & Outsourcing → Purchase & GRN → Inventory → Product Master & BOM → Ledger masters.**

## 5. What each operation may do

**Legend:**
- **Archive**: set the existing inactive or archived state (reversible, nothing deleted).
- **Reset**: delete working data that nothing else points at.
- **Delete**: permanent delete, needing a backup record.
- **Blocked**: never, with the reason shown.

| Department | Category | Archive | Reset | Permanent delete | Blocked when |
|---|---|---|---|---|---|
| **Product Master & BOM** | Products | ✔ (INACTIVE → archived, existing rules) | — | ✔ only never-used products: no stock movement, lot, BOM line, order line, invoice line or version used by a transaction | any reference in 4.1; version history is never deleted while referenced |
|  | Categories | ✔ (inactive) | — | ✔ only if no product uses it | used by a product |
|  | BOMs | ✔ (ARCHIVED) | ✔ draft, pending or rejected versions not used by any order | ✔ unused draft versions | approved, superseded, or used by a production or outsourcing order |
| **Inventory** | Alerts, request ids | — | ✔ | ✔ | — |
|  | Pending adjustments, opening stock and counts (not posted) | — | ✔ | ✔ | posted (has a stock movement) |
|  | Released, fulfilled or expired reservations | — | ✔ | ✔ | open reservation, or one used by a fulfilment line |
|  | Warehouses / locations | ✔ (inactive) | — | ✔ only if empty and never used | any balance, movement or document |
|  | Stock ledger, balances, lots | — | — | — | **always.** Shared by every department; use the existing whole-company reset |
| **Purchase & GRN** | Draft, pending, rejected or cancelled POs with no receipt | — | ✔ (with lines, events, amendments, references) | ✔ | any goods receipt; a pending approval request |
|  | Posted or reversed GRNs | — | — | — | **always.** Stock ledger and supplier payables |
| **Production & Outsourcing** | Draft, pending, rejected or cancelled orders with no consumption, output or receipt | — | ✔ (with materials, events, request ids, revisions; open reservations released first) | ✔ | any posted consumption, output or outsourcing movement |
|  | Posted consumption, output, outsourcing receipts and movements | — | — | — | **always.** Stock ledger |
| **Sales & Orders** | Draft or cancelled orders with no fulfilment, invoice line or production order | — | ✔ (with lines, events; reservations released) | ✔ | any dispatch, invoice line, return or linked production order |
|  | Dispatches, returns | — | — | — | **always.** Stock ledger and invoices |
|  | Customer product codes | — | ✔ | ✔ | — |
|  | Legacy customer POs | — | ✔ only those not linked to a sales order | ✔ | linked to a sales order |
| **Billing & Invoice** | Draft or discarded invoices and draft notes (no number) | — | ✔ | ✔ | — |
|  | Issued or cancelled invoices, issued notes, payments, allocations | — | — | — | **always.** Financial and GST records (cancel or reverse in Billing instead) |
| **Ledger** | Customers / suppliers / parties | ✔ (inactive) | — | ✔ only never-used parties with no opening balance | any document or payment; an opening balance |
|  | Supplier payments | — | — | — | **always.** Financial records |

**Version histories** (product versions, BOM versions, production order revisions, every events table) are deleted only together with a never-used parent. Transaction-time snapshots are never altered.

## 6. Safety rules (server side)

1. **One protected function per action**, `SECURITY DEFINER` with `search_path = ''`, called through RPC:
   - `department_data_preview(dept, categories)` and `department_data_execute(dept, categories, plan_hash, confirmation, backup_id, request_id)`.
   - Nothing destructive runs in the browser.
   - An Edge Function is not needed and is not recommended: it cannot hold one database transaction across several calls.
2. **Authorisation.**
   - `private.require_permission('system.reset_data')` (Super Admin only), checked against the caller's own company.
   - The company always comes from the signed-in profile, never from the request.
   - Existing role checks and RLS are untouched.
3. **Preview equals execution.**
   - Preview and execute call the same internal planner.
   - Preview returns per-table counts and a hash of the exact row ids.
   - Execute rebuilds the plan and stops, without deleting anything, if the hash differs (data changed since the preview).
4. **One transaction.**
   - All deletes and archive updates happen in that single function call.
   - Any error, including a guard trigger or foreign key error, rolls everything back.
   - The run is then recorded as FAILED, with the message, in a separate autonomous step that already exists in the reset code.
5. **Explicit id lists, no cascades.**
   - Every delete is `delete … where company_id = <own company> and id = any(<planned ids>)`, in dependency order.
   - Foreign keys stay `RESTRICT` as a final safety net.
   - No `ON DELETE CASCADE` is added, and no RLS is disabled.
6. **Blocking rules.**
   - The planner removes blocked rows from the plan and returns them, with the reason and the referencing records, so the preview can show them.
   - Posted, ledger and GST tables (section 5, "always") are not in any department plan at all.
7. **Guarded tables.**
   - Reset and delete touch only unposted rows, which the existing guards already allow.
   - If decision D4 approves deleting history rows of never-used parents (for example the events of a cancelled draft PO), the exemption works like `erp_force_purge_allows`. It holds only inside one execute call, for one company, for the planned ids of the listed history tables.
8. **Backup and confirmation.**
   - Permanent delete needs:
     - a backup record (`erp_reset_backup_attestations`, less than 24 h old, single use, made by the same Super Admin);
     - the typed confirmation `DELETE <DEPARTMENT>`;
     - the caller's password, re-checked with Supabase Auth in the browser before the call.
   - The ERP cannot inspect a Supabase backup, so the record is the operator's declaration (as in the existing reset).
   - Archive needs only the typed confirmation.
9. **Audit.**
   - Every preview, run and failure is written to `audit_logs`, which is immutable.
   - Every run is also written to `erp_reset_runs` with `scope = 'DEPARTMENT'`, recording: department, categories, per-table counts before and after, status, start and finish times, failure details, backup id and request id.
   - The same `request_id` sent again returns the first result.
10. **Company isolation.** Every statement filters on the caller's company. The planner also checks that the composite foreign keys rule out any row of another company.

## 7. Interface (Settings → Data Management)

- **Seven department cards**, each with its categories, the current counts per category, and Archive / Reset / Delete buttons enabled only where the matrix allows.
- **Preview** (nothing changes):
  - records per table that will be archived or deleted;
  - **blocked records** with the reason and the referencing documents of other departments;
  - the departments affected.
- **Confirmation step:**
  - typed phrase; for Delete, also the backup record and the password;
  - the execute button is disabled while the preview is stale.
- **Result:** status, counts per table (matching the preview), completion time, and failure details when it fails.
- **History list** of all department operations, plus the existing reset history.

## 8. Tests planned (no deletion outside test databases)

1. A local database test suite with three companies:
   - Company A is fully populated: every department, posted and unposted records, an issued invoice, payments, versions.
   - Company B is identical, to check isolation.
   - Company C is empty.
2. For every department and category:
   - preview counts = rows actually removed;
   - nothing outside the plan changes (row counts of every other table, before and after);
   - company B is byte-for-byte unchanged;
   - stock reconciliation, supplier payables, customer receivables and invoice and GST totals are unchanged wherever posted data exists.
3. Blocked cases:
   - posted GRN, dispatch, issued invoice, payment, used product, approved BOM, open reservation, pending approval;
   - all refused, with nothing changed.
4. Failure mid-run (an injected error): nothing deleted; run recorded as FAILED.
5. Stale preview (data changed after the preview): refused.
6. Repeated request id: the first result is returned.
7. Permissions:
   - an Admin who is not Super Admin, a viewer, and a user of another company are all refused;
   - anon cannot execute;
   - a missing, expired or reused backup record, or a wrong confirmation phrase, is refused.
8. Rollback script check, read-only RPC check, the existing reset and force-reset suites, and the UI smoke tests.

## 9. Migration impact (for review; not written yet)

- **Additive only.**
  - New functions: the planner, preview, execute and history.
  - A new `scope` / `department` column on `erp_reset_runs`, nullable.
- **Guard functions** are redefined only if decision D4 is approved. Each would gain one extra exemption check, mirroring the reviewed force-purge exemption.
- No table, column or data is dropped, and no RLS policy or foreign key is changed.
- A rollback script restores the previous function definitions.
- It is to be applied by you, in order, after the pending migrations 20261110 → 20261118.

## 10. Decisions needed before implementation

| # | Decision | Recommendation |
|---|---|---|
| D1 | Posted financial and GST records (issued invoices, notes, payments, supplier payments): never permanently deleted by this module | **Yes, never.** Cancel or reverse in Billing. Whole-company removal stays with Force Reset. |
| D2 | Posted stock history (GRNs, production postings, dispatches, the stock ledger): blocked per department | **Yes, block.** A per-department delete would break stock reconciliation. Whole-company removal stays with Force Reset. |
| D3 | "Archive" for transactions: add an additive `archived_at` column to documents so they can be hidden without deleting | **Not now.** Archive only master data (existing states). Add later if needed. |
| D4 | Allow deleting the immutable history rows (events, amendments, revisions) of never-used, cancelled or draft documents when the document itself is deleted | **Yes**, with the scoped exemption in 6.7. Otherwise those documents can only be cancelled, not removed. |
| D5 | Permanent delete requires backup record + typed phrase + password re-check (Force Reset currently has none of these, at your earlier request) | **Yes**, as this request specifies. |
| D6 | Server functions (one transaction) rather than an Edge Function | **Server functions.** |
| D7 | Legacy customer PO tables (Phase 6, not in the V2 menu) belong to Sales & Orders | **Yes.** |

## 11. Implementation (approved; migration 20261119090000, NOT applied to hosted)

**Status:** built and tested on a local test database only. Nothing was run against the hosted or the original project.

| Piece | Where |
|---|---|
| Migration (additive) | `supabase/migrations/20261119090000_department_data_management.sql` |
| Rollback | `supabase/rollback/20261119090000_department_data_management_down.sql` |
| Screen | ERP Settings → System → **Department Data Management** (`src/features/admin/department-data-section.tsx`); shown only to a Super Admin with `system.reset_data` |
| Tests | `tests/db/department-data-check.mjs` (`npm run test:db:department`), `tests/db/department-data-rollback-check.mjs` (in `test:db:rollback`), `tests/unit/department-data.test.ts`, UI smoke "Department data 1–4" |

**Database objects**
- Public, callable by signed-in users and checked inside:
  - `department_data_overview()`
  - `department_data_preview(department, operation, categories)`
  - `department_data_execute(department, operation, categories, plan_hash, confirmation, backup_id, request_id)`
  - `department_data_history(limit)`
- Private, not callable by users:
  - `dept_categories`, `dept_plan` (the one planner), `dept_table_ord`, `dept_key_col`, `dept_of_table`, `dept_row_label`
  - `dept_caller_company`, `dept_recent_password`, `dept_valid_request`, `dept_row_counts`, `dept_purge_allows`
  - tables `dept_purge_sessions` and `dept_purge_rows`, which are empty outside a running call
- `erp_reset_runs` gains nullable columns `department`, `operation`, `categories` and `plan_hash`, and its mode check allows `DEPARTMENT`. The existing reset history screen still shows only Standard and Force runs.
- One check is added at the top of eight existing functions:
  - `prevent_history_mutation`, `guard_bom_write`, `guard_bom_item_write`, `guard_product_version`, `guard_invoice_change`, `guard_invoice_line_change`, `guard_note_change`: a delete is allowed only for a row registered in the running call (same company, same transaction, same table and id).
  - `production_material_removed`: writes no "material removed" revision while its own order is being deleted.
  - The rollback check proves each function is otherwise identical, and that the rollback restores the originals exactly.

**Refinements made while building**
- **Two delete levels.**
  - **Reset** (typed phrase only) removes transient data: resolved alerts, request ids older than 7 days, and released, cancelled or expired reservations.
  - **Permanent delete** (backup record, password and phrase) covers every business record: draft or cancelled documents and never-used masters.
  - The matrix in section 5 had drafts under "Reset". They now need the stronger checks.
- **Masters must be deactivated before they can be deleted** (products, categories, warehouses, customers, suppliers). An active never-used product is never deleted.
- **Documents waiting for approval are never candidates.**
- **Not deleted:**
  - draft invoices that already have a proforma number;
  - approval requests that were already decided and point at a deleted document. They are kept as history.
- **A product that still has stock cannot be archived** (an existing rule). The preview lists it as blocked.
- **The password check is enforced in the database.** It reads the `amr` claim of the Supabase session token and needs a password sign-in less than 5 minutes old. The screen signs in again with the user's password just before the call.
- **Verification inside each run.** Every run counts the rows of every company table before and after, for this company and for all others. If anything other than the planned rows changed, the whole run is rolled back. On very large databases this adds a few seconds per run.

**Before deploying (manual, not done)**
1. Apply the pending migrations in order (… 20261118 → 20261119).
2. On the hosted project, open ERP Settings → System → Department Data Management as Super Admin. Check that the preview counts make sense.
3. Run one **Archive**, then one **Permanent delete** on a test company. The second confirms the password re-check works with the hosted Supabase Auth: the session token must carry `amr: [{ method: "password", timestamp }]`.
