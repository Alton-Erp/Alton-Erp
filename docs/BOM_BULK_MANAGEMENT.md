# Bulk BOM management and component where-used analysis

Migration `20261218090000_bom_bulk_changes` (with its rollback) adds the backend. The frontend is the BOM page's six tabs
(`/production/boms?tab=…`). Nothing is deployed automatically.

## 1. What already existed and is reused

| Existing | How bulk changes use it |
|---|---|
| `boms` / `bom_items` (one BOM code per product, numbered versions) | The only BOM master. A BOM **version is the revision record**; no second BOM table was created. |
| Approved versions are immutable (`guard_bom_write`, `guard_bom_item_write`, `bom_stamp_on_approval`) | Publishing never edits an existing version: it creates the next one. |
| `production_new_bom_version` + `production_save_bom` | Used to create each new revision. They re-check every component (active, unit = inventory unit, no duplicates, no circular BOM, at most 500 lines). |
| Effective dates + `boms_no_overlap` | The new revision starts on the batch's effective date. The previous one is closed the day before, or superseded (archived) when it starts the same day. |
| `production_v2_active_bom` (the version effective today) | New production orders pick the revision in force on the day they are created. |
| `production_orders.bom_id` + `production_order_materials` | Existing orders keep their BOM version and material plan; publishing does not touch them. |
| `production_bom.read / create / update / approve` | Reused; no permission was added. |
| `inventory.segregation_of_duties` | When it is on, the person who prepared or submitted a batch cannot approve it (same rule as single BOMs). |
| `audit_logs`, `notifications` | One audit entry per workflow step and per new revision. Approvers are notified on submit, the creator on rejection. |

Constraints found in the existing design:
- **No unit-conversion master.** A BOM line is always in the component's inventory unit. "UOM conversion" when replacing
  a component means a conversion factor (new quantity = old quantity × factor) or an explicit quantity per BOM. Editing a
  line to another unit is refused.
- **One line per component per BOM** (`bom_items_component_unique`). "Allow duplicates" therefore means *merge into the
  existing line*, adding the quantities (same unit only). Without that option, such BOMs are reported as errors.

## 2. New tables

| Table | Holds |
|---|---|
| `bom_change_batches` | One bulk change: number `BCB-000001`, operation (REPLACE / DELETE / ADD / EDIT / RESTORE), status, reason, effective date, merge option, summary, preview hash, who prepared / submitted / approved / rejected / published it and when, optimistic-lock `row_version`. |
| `bom_change_batch_lines` | One change on one BOM: source BOM version, finished product, component (and replacement), the user's input, the old and new quantity / unit / wastage / notes, validation errors and warnings, and the revision created on publish. SKU and name snapshots keep it readable. |
| `bom_change_approvals` | Workflow and approval history: CREATED, EDITED, SUBMITTED, WITHDRAWN, APPROVED, REJECTED, PUBLISHED, PUBLISH_FAILED, CANCELLED. It is append-only and stores the actor, time, note, preview hash and details (impact snapshot on submit and approval, revisions on publish). |

Row-level security: select only, by `production_bom.read` in the row's company. No insert, update or delete grants:
everything is written by the functions below. BOMs and products are referenced by id without foreign keys, on purpose:
the department planner and the product bulk delete treat any foreign key as a blocker. ERP reset allowlist: 129 tables
(force reset 136).

## 3. Functions (all SECURITY DEFINER, company-checked)

| Function | Permission | Purpose |
|---|---|---|
| `bom_component_search(term, limit)` | read | Components by name, SKU, product / model code, barcode or EAN (inactive included), with BOM-line counts |
| `bom_where_used(component, filters, sort, ascending, limit, offset)` | read | Every BOM version using a component. Filters: status (current revisions / active / scheduled / draft / pending / superseded / archived / all), finished product search, product type. Sorting and paging are done on the server. |
| `bom_bulk_current_boms(search, limit)`, `bom_bulk_resolve_skus(skus)` | read | Current revisions for bulk add; SKU lookup for Excel import |
| `bom_change_batch_save(id, expected_version, header, lines)` | create or update | Creates a draft or replaces a draft's lines. A line gives `bom_id` or `finished_product_id` (that product's current revision). Every line is checked immediately. |
| `bom_change_batch_remove_lines`, `bom_change_batch_validate` | create/update, read | Remove lines (e.g. BOMs with errors); re-check against the BOMs as they are now |
| `bom_change_batch_get(id)` | read | Batch, lines, impact, history and what the caller may do. Read-only. |
| `bom_change_batch_action(id, SUBMIT\|WITHDRAW\|APPROVE\|REJECT\|CANCEL, note, expected_version)` | see below | Workflow |
| `bom_change_batch_publish(id, expected_version, request_id)` | approve + create | Publishes all-or-nothing |
| `bom_change_batch_create_reversal(id, reason, effective_from)` | create or update | New draft that restores the earlier components as a further revision |
| `bom_change_batches_list`, `bom_revision_log` | read | Approvals list; revision history with batch, reason, approver |

The read functions are STABLE and write nothing, because PostgREST runs them in read-only transactions
(`npm run test:db:readonly` covers this class of problem).

### Validation (each line, and each resulting BOM as a whole)
- **BOM state:** the BOM must still be the product's current revision (its latest approved version), and the finished
  product must be active.
- **Effective date:** today or later; not before the start of a scheduled revision.
- **Component:**
  - REPLACE, DELETE and EDIT: the component must be on the BOM;
  - REPLACE and ADD: the new component must exist, be active, not be the finished product itself, and not create a
    circular BOM.
- **Values:**
  - quantity greater than 0 with up to 6 decimals; wastage from 0 to 99.99;
  - a conversion factor greater than 0;
  - the unit equal to the inventory unit, and different units on a replacement need a factor or a quantity;
  - an ADD needs a quantity;
  - a duplicate component is an error unless "merge" is ticked.
- **Resulting BOM:**
  - at least 1 and at most 500 components;
  - no inactive component;
  - no line whose unit differs from the inventory unit.
- **Warnings:**
  - an unpublished draft version of the product exists; it will not include the change;
  - an edit with no change;
  - a merged line.

### Workflow
```
DRAFT ──submit──▶ PENDING_APPROVAL ──approve──▶ APPROVED ──publish──▶ PUBLISHED
  ▲                  │ reject (reason)            │ withdraw
  └── edit ◀── REJECTED ◀┘                         └──▶ DRAFT
any state except PUBLISHED ──cancel──▶ CANCELLED
```
- **Submit** needs zero errors. It records the preview hash (lines + the exact BOM versions they apply to).
- **Approve** needs `production_bom.approve`, re-checks the batch, and refuses if the BOMs changed since submission
  (different hash).
- **Publish** needs `production_bom.approve` and `production_bom.create`.
  1. It locks the affected products' BOMs, re-checks the batch and compares the hash.
  2. For every BOM it creates the next version with the resulting components and activates it from the effective date.
     The new version records the batch's submitter and approver and the reason `BCB-x Replace: <reason>`.
  3. Everything runs in one transaction, and the overlap check runs immediately inside it.
  4. Any failure rolls back every BOM. The batch stays APPROVED, with a PUBLISH_FAILED record and the message.
- **Concurrency:**
  - every write checks `row_version`, so an out-of-date screen gets "changed by someone else";
  - two batches on the same BOM: the first to publish wins, and the other is refused at approval or publishing;
  - a retried publish request (same request id) returns the first result.

### Impact preview (read-only; each section needs the matching permission)
- **Totals:** BOMs affected, lines, lines and products with errors.
- **Each line:** old and new component, quantity, unit and wastage.
- **Production orders** (`manufacturing.read`): open orders using the BOM versions being changed, and their effect.
  Released orders keep their version and material plan. Drafts keep it too, until someone edits them on or after the
  effective date (existing behaviour of the production order editor).
- **For each component involved:**
  - current BOMs now and after the change;
  - on hand, reserved and available (`inventory.read`);
  - open purchase-order quantity (`purchases.read`);
  - consumption in the last 90 days and open order requirement (`manufacturing.read`);
  - a warning for removed components that would keep stock or open POs but no current BOM.

Publishing never changes stock, reservations, purchase orders, consumption or existing production orders.

### Reversal (rollback of a published batch)
"Create reversal" makes a new RESTORE draft, one line per BOM, which puts back the components the BOM had before the
batch, as a further revision. It goes through approval like any change. BOMs changed again since are flagged and can be
removed from the draft. History is never rewritten.

## 4. Screens (Production → Bill of Materials)
1. **BOM Master:** the existing list, unchanged.
2. **Where-Used Analysis:**
   - search a component by name, SKU, code, barcode or EAN;
   - the table shows finished product, BOM number and revision, component, quantity, UOM, wastage, status and effective dates;
   - status, type and text filters, server sorting and paging, Excel export;
   - Replace, Edit and Delete buttons start a bulk change with that component.
3. **Bulk BOM Editor:**
   - **Replace:** old component, replacement, conversion factor, wastage, plus a quantity or wastage override per BOM.
   - **Delete:** pick the BOMs.
   - **Add:** components with default quantity and wastage, plus a quantity per BOM.
   - **Edit:** quantity, wastage, notes and source for all selected BOMs, or per BOM.
   - **Common to all four:**
     - select all or individual BOMs;
     - reason, effective date and the merge option;
     - "Save draft and preview".
4. **Revision History:**
   - every BOM version, with bulk and single-edit revisions shown separately;
   - batch, reason, approver and effective dates;
   - "Compare with previous" and "All versions" links;
   - Excel export.
5. **Change Approvals:**
   - batches by status;
   - each batch shows its preview, impact, errors and approval history;
   - actions: re-check, remove BOMs with errors, submit, withdraw, approve, reject, publish, reversal, cancel;
   - the preview can be exported to Excel.
6. **Excel Import/Export:**
   - templates for add, edit, replace and delete;
   - every row is checked against the Product Master (unknown SKU, no approved BOM, inactive component, unit, numbers,
     repeated rows);
   - rows with errors can be downloaded;
   - a draft batch is created from the valid rows;
   - links to the BOM, where-used and revision exports.

## 5. Tests
- `npm run test:db:bom-bulk` (88 checks, local PGlite only), covering:
  - one component used in 100 BOMs: where-used paging, sorting, filtering and search by name, SKU, code and barcode;
  - replacing it in all 100 BOMs (100 new revisions; previous ones unchanged), and in only 10 selected BOMs with a unit conversion;
  - bulk add with a different quantity per BOM, bulk delete (including refusing to remove the last component), bulk edit;
  - duplicates refused, or merged on request; inactive replacement; circular BOM; unit, wastage and number checks;
  - approval and rejection, segregation of duties, notifications;
  - concurrency: optimistic lock, two batches on one BOM, a BOM changed after approval;
  - atomicity: a component made inactive after approval means nothing changes;
  - effective dates: scheduled revisions; orders created before and after (the released order keeps v1);
  - reversal and revision history;
  - company isolation and RLS; read-only and preparer roles; no direct table writes;
  - reset allowlist, rollback and re-apply.
- `tests/unit/bom-bulk.test.ts` (17): Excel parsing and row validation, export columns, preview helpers, and migration
  safety rules (no deletes or rewrites of BOMs, orders, stock or purchase orders; read functions STABLE).
- UI smoke step "Bulk BOM management…": tabs, where-used, replace preview with impact, submit, approve and publish,
  revision history, Excel validation.

## 6. Deployment (after review and approval)
1. Apply `20261218090000_bom_bulk_changes` after `20261217090000_acefone_softphone`. It only adds tables and functions and
   redefines the reset allowlist; no existing data is changed.
2. Deploy the frontend (no Edge Function is involved).
3. Optionally switch on `inventory.segregation_of_duties` if approvals must come from a second person.

Rollback: `supabase/rollback/20261218090000_bom_bulk_changes_down.sql`.
- It refuses while published batches exist, because their change history would be lost. Export it first, then run with
  `set app.bom_bulk_rollback_force = 'on'`.
- BOM revisions created by published batches stay: they are ordinary BOM versions and may be used by production orders.

## 7. Limitations
- No unit-conversion master: conversions are factors entered per change, not stored conversions.
- A component appears once per BOM, so "duplicates" can only be merged.
- An open draft version of an affected product is not updated; a warning says it must be recreated.
- Draft production orders edited after the effective date take the new revision (existing editor behaviour). Released
  and started orders never do.
- Tested locally (PGlite and a mocked UI). Not run against the hosted database.
