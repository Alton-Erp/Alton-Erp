# Immutable product, component and BOM version control

Migration `supabase/migrations/20261118090000_master_versioning.sql` · rollback `supabase/rollback/20261118090000_master_versioning_down.sql`

**Rule:** a product, component or BOM changed today never changes any transaction, production order, stock record, report or Excel export made before the change. New transactions use the current version.

## 1. Audit before the change (what already existed)

| Area | Finding |
| --- | --- |
| Product Master (`products`) | One mutable row per product. No history. Components and raw materials are products too (`product_type` RAW_MATERIAL, COMPONENT, …); there is no separate component table. |
| BOMs (`boms`, `bom_items`) | Already versioned (`bom_code` + `version`). Approved / archived versions were already immutable (`guard_bom_write`, `guard_bom_item_write`); changes needed a new version. Lines pointed to the **current** component (no component version). |
| Production orders | Already stored `bom_id`, `bom_code`, `bom_version`, `unit` and quantities. The material plan (`production_order_materials`) already stored quantity per unit, wastage, base and planned quantities. Not stored: product / component code, name and version, or standard cost. |
| Stock ledger (`inventory_transactions`) | Append-only. Already stores quantity, unit, unit cost (rate), date, source type and document reference. Not stored: product code, name or version. |
| Document lines | Purchase order lines (`sku`, `description`, `hsn_sac`, `unit`, prices), sales order lines (`sku_snapshot`, `product_name_snapshot`), invoice lines (`sku`, `description`, `hsn_sac`, `unit`, GST) were already snapshots. GRN lines, fulfilment lines, opening stock, adjustments and consumption kept only the product id. |
| Valuation | Weighted average of the issued lots' receipt costs (`lot_average_cost`), from ledger rates. It never reads master costs. Unchanged. |
| **Problems found** | <ul><li>Reports and list views joined the **current** Product Master for codes and names, so renaming a product rewrote history.</li><li>The **Production Cost Summary** standard estimate multiplied historical plans by **today's** standard cost.</li><li>Released production orders could have their plan re-synced with no record of the previous plan.</li></ul> |

## 2. Database architecture

| Object | Purpose |
| --- | --- |
| `public.product_versions` | One row per version of a product or component: number, effective from / to, current flag, legacy flag, source (LEGACY_BASELINE / CREATED / UPDATED). Typed snapshot (code, name, description, type, UOM, HSN, GST, standard cost, selling price, MRP) plus `attributes` (every attribute), `changes` (previous → new per field), reason, author, time. Unique version number per product; one current version. |
| Trigger `products_zz_version` | On every product change: closes the current version (`effective_to`, `is_current = false`) and adds the next one with the changes and the reason. The reason comes from the write-only column `products.change_reason`, which is never stored on the product; it defaults to "Not stated". Housekeeping fields (updated_at / by, has_bom, image, archive stamps) do not create versions. |
| Trigger `product_versions_guard` | Versions are read-only: only closing the current version is allowed. Delete is allowed only inside a force reset. Clients have SELECT only (RLS: `products.read`). |
| Ledger snapshot | `inventory_transactions.product_version_id`, `sku_snapshot`, `product_name_snapshot`, filled at posting. A reversal copies the entry it reverses. Posted entries are never updated. |
| BOM | <ul><li>`bom_items.component_version_id`: stamped on insert and fixed at approval.</li><li>`boms.change_reason` and `process_instructions`: drafts only, set through `bom_version_details_save`.</li><li>Lifecycle (`private.bom_lifecycle_status`): Draft, Pending approval, Rejected, Active, Scheduled, Superseded, Archived.</li><li>Constraint trigger `boms_no_overlap` (checked at commit): no two approved versions of a product overlap in time.</li></ul> |
| Production snapshot | <ul><li>`production_orders`: `product_version_id`, `product_sku_snapshot`, `product_name_snapshot`, `snapshot_taken_at`.</li><li>`production_order_materials`: `component_version_id`, code, name, `standard_cost_snapshot`, `costing_basis`, `snapshot_taken_at`.</li><li>Actual consumption stays separate (`production_material_consumption` and its ledger entries).</li></ul> |
| Released orders | <ul><li>Product, BOM, quantity and material plan cannot change once released, except through **Edit** (`production_order_v2_save`), which returns the order to draft and recalculates.</li><li>Every such change keeps the previous header / material line in `production_order_revisions` (who, when, reason). Clients have SELECT only (RLS: `manufacturing.read`).</li></ul> |
| Activation and drafts | `production_bom_save_and_activate` (save + activate in one step), `private.bom_version_lifecycle` (Superseded), `draft_version_check` / `draft_refresh_versions`, `production_order_v2_save` option `use_latest_versions`. |
| `private.hist_product(product, version, sku, name)` | Values for a historical record, in this order: its version; else the code / name stored on the document; else, for records made before version control, the **legacy baseline** (which never changes again). The label is `vN`, "Document snapshot" or "Legacy / Unversioned". |
| Read RPCs | `product_version_history(product)` (`products.read`) and `bom_version_history(bom)` (`production_bom.read`), both company-scoped. |

## 3. Lifecycle

No approval queue: an authorised save creates the new version and makes it current at once, for new transactions only. Who may do it is decided by the existing roles; no permission was added.

### Products and components

1. **Create:** version 1 (CREATED, current).
2. **Edit** (Product Master form, BOM planning card, Excel import):
   - The form asks for a reason. The planning card and the import fill one in.
   - Saving closes the current version (shown as **Superseded**) and adds version N+1, which is current immediately.
   - The new version holds the previous → new value of every changed field, and who saved it and when.
   - Permission: `products.update`.
3. **Revision history:** Product → Revision history (`/products/:id/versions`).
   - Every version, with effective from / to, modification time, modified by, reason, and previous → new values.
   - *View* opens any version read-only.
   - The comparison shows **Previous values** against **Current values**, or any two versions.
4. **Read-only:** versions can never be edited or deleted. Future-dated product versions are not supported; a version takes effect when saved.

### BOMs

1. **Users who may activate BOMs** (the existing `production_bom.approve`: Super Admin, Administrator, Production Manager):
   - They edit the **active** version directly.
   - **Save as new version** (a reason is required) creates version N+1, effective today, and **activates it in the same step** (`production_bom_save_and_activate`, all or nothing, retry-safe).
   - The previous version is closed or archived by the existing activation logic, and shown as **Superseded (by vN+1)**. Its lines are never changed.
   - New BOMs and drafts have **Save and activate**.
2. **Users who may only create or update BOMs** (no activation permission, as before) save drafts. The editor offers no submit-for-approval queue to them; someone who may activate opens and saves the draft.
3. **No overlap:** approved versions of a product never overlap in time (constraint trigger).
4. **Comparison:** BOM → Versions & compare (`/production/boms/:id/versions`; also linked from the product page).
   - The version list shows the product name and code, BOM version, status (Active / Scheduled / **Superseded** / Draft / Archived), effective dates, modification date, created by, reason, approver, number of components and standard cost per output unit.
   - Any two versions can be compared side by side:
     - **Header:** dates, output, status, reason, process instructions, approver, standard cost per unit, with the difference.
     - **Components:** each marked **Added**, **Removed**, **Modified** or Unchanged (with counts). It shows quantity, UOM, wastage and component version per version, and **cost per output unit** per version (component standard cost of the version used × quantity incl. wastage, with the difference).

### Drafts keep their versions

- **BOM drafts:**
  - Re-saving keeps the component version each line already had.
  - Approval no longer silently re-stamps lines.
  - New lines get the current version.
- **Edited production orders** keep their BOM version and the product / component versions, names and standard costs they were planned with. Only the quantities are re-planned.
- **Draft sales orders, purchase orders and invoices** keep the names, descriptions, HSN codes, prices and GST rates on their lines.
- **When a draft uses an older version**, its screen shows *Newer versions are available* with each difference (old → current) and two choices:
  - **Keep the draft's versions:** nothing changes.
  - **Refresh to the latest versions:**
    - BOM drafts: component versions.
    - Documents: names, descriptions and HSN.
    - Production orders: the choice is applied when the order is saved. It moves the order to the active BOM and the current versions; the previous plan is kept as a revision.
  - GST rates and prices are listed but never refreshed automatically; they are commercial terms to change on the line.
  - Each refresh is audited (`draft.versions_refreshed`).
- **RPCs:** `draft_version_check(kind, id)` (read-only) and `draft_refresh_versions(kind, id)`, which uses each document's existing edit permission and works on drafts only.

### Production orders

- **Creation:** snapshots the product version, BOM version (the active one), component versions, planned quantities, UOM, wastage and standard costs (`STANDARD_COST_AT_PLANNING`).
- **After release:** the snapshot is fixed.
- **Amendment:** Edit → the order keeps its versions unless the user chooses the latest → a revision is recorded (who, when, why, previous plan) → the order is reopened.
- **Ledger:** consumption and output post with their own snapshots.

## 4. Reports, lists and exports audited

| Report / view | Before | Now |
| --- | --- | --- |
| Stock Movement Report | current product code / name | ledger snapshot + **Version** column |
| GRN Register | current product | PO line description / ledger snapshot + **Version** |
| Production Register | current product | order snapshot + **Product version** + **BOM version** |
| Material Consumption | current component and product | consumption entry snapshot + **Material version** + **BOM version** |
| Production Wastage | current product | order snapshot + **Version** |
| Dispatch Report | current product, current unit | sales order line snapshot (code, name, unit) |
| Production reports: Orders summary, Planned vs actual, Planned vs actual consumption, Output & rejections, Finished goods produced, Batch traceability, Variance | current product / component | order / material-plan / ledger snapshots; Orders summary + **Product ver.**, consumption + **Material ver.** |
| Production Cost Summary | standard estimate × **current** standard cost | standard cost captured on the order (legacy plans: the baseline) |
| Lists: stock movements, production orders, consumption, output, BOM lines | current product | snapshots (BOM lines: the version approved with; drafts show current values) |
| **Unchanged on purpose (current-state reports):** <ul><li>Product list, Stock Register / Inventory Valuation, Low Stock, Reorder Planning;</li><li>raw material requirements and shortages for open orders;</li><li>the dashboards;</li><li>Product Sales (grouped per product).</li></ul> | | They describe today's position. Their quantities and values already come from the ledger and documents. |
| Sales order, invoice, purchase order, credit / debit note reports | already document snapshots | unchanged |

**Excel exports:**
- The report screens and the production reports build the export from the **same rows** the screen shows (`reportSheet`, `exportValue`). The values, version columns and totals therefore match. This is tested in `tests/unit/master-versioning.test.ts` and in the UI smoke "Versions 8/9" step, which reads back the downloaded .xlsx.
- No export recalculates costs.

## 5. Existing records and backward compatibility

- **Nothing existing is rewritten:** no quantities, prices, costs, ledger entries or approved documents change.
- **Legacy baseline:** each existing product gets version 1, marked `is_legacy`, with the reason "Legacy baseline: the values when version control was introduced. Earlier changes were not recorded."
  - No earlier versions are invented.
  - Records made before the migration have no version id. Reports label them **Legacy / Unversioned** and show the baseline values, which stay fixed from now on.
- **BOM lines approved before the migration** keep `component_version_id` null (legacy). Their names come from the baseline.
- **Production orders made before the migration** have no snapshot. Their names and costs come from the baseline too, so cost reports read the same values as on the migration day and no longer drift.
- **Schema changes are additive:**
  - All new columns are nullable.
  - Existing RPCs, approvals, accounting, valuation (FIFO / weighted average) and RLS policies are unchanged.
  - The BOM item guard only gained the component-version stamp before approval.
  - List views keep their columns (re-created with the same names).
- **ERP reset:**
  - `product_versions` is kept by the standard reset (with products) and purged by the force reset.
  - `production_order_revisions` is deleted with the production orders.
  - Table counts are 81 for the standard reset and 88 for the force reset.

## 6. Risks and unsupported cases

- **Before the migration:** the system cannot know what a product looked like before version control. Legacy records show the values as of the migration day, labelled as such.
- **Edits outside the app:** product edits made directly in SQL (bypassing the form) still create versions, but with the reason "Not stated".
- **Future-dated product versions** are not supported (only BOMs have effective dates).
- **Separate BOM purposes** (e.g. alternative routings) are not modelled: one approved version per product per period.
- **UOM changes** on a product with stock remain blocked by the existing inventory guard. A version records them when allowed.
- **Opening stock / adjustment lines and GRN lines** themselves gained no columns. Their stock entries carry the snapshot, and the reports read it there.
- **Dashboards** still show current names (current-state screens).
- **Production order edit preview:** the material preview on the edit screen is calculated from the active BOM. When the order keeps an older BOM version, the saved plan follows that version, as the notice explains.
- **Refreshing a draft document** reloads it from the database. Unsaved edits on that screen are discarded first, so the old values cannot be written back.
- **No approval queue:** a user without `production_bom.approve` can save BOM drafts but cannot activate them. Activation stays with the roles that already had it.

## 7. Deployment (not applied automatically)

1. Review, then apply `20261118090000_master_versioning.sql` after 20261110–20261117, in order, in the SQL Editor.
2. Deploy the frontend.
3. **Verify:**
   - `select count(*) from public.product_versions where is_legacy;` equals the number of products.
   - Edit a product with a reason: Version history shows v2.
   - The Stock Movement Report shows "Legacy / Unversioned" for old movements and v2 for new ones.
4. **Rollback:** run `20261118090000_master_versioning_down.sql` before any older rollback. It restores the previous report functions, views and reset lists, and drops the version tables and snapshot columns. Products, BOMs, orders and the ledger are unchanged; the history captured since the migration is lost.

## 8. Tests

- **DB:** `supabase/tests/master_versioning_verification.sql` (89 checks, incl. automatic activation, Superseded, drafts keeping their versions, explicit refresh, permissions and isolation; section 11 tests 1–8 and 10–12). Reports and lists are captured before and after the master changes and compared row for row.
- **Rollback:** `tests/db/master-versioning-rollback-check.mjs` (rollback, data unchanged, roll-forward, re-apply, suite).
- **Unit:** `tests/unit/master-versioning.test.ts` (comparisons; test 9, export = report).
- **UI smoke:** steps "Versions …": the reason is required on edit, the product history and comparison, the BOM versions and differences, and the report version column read back from the Excel file.
