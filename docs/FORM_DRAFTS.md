# Persistent form drafts (auto-save)

Migration `supabase/migrations/20261117090000_form_drafts.sql` · rollback `supabase/rollback/20261117090000_form_drafts_down.sql`

Users never lose what they typed when they switch module, page or tab, refresh, close the browser or sign in again. A form keeps a **working copy** of its values; the ERP record is still created only by the form's own Save / Post button, with its existing validation, approval, accounting, stock and audit rules.

## How it works

| Piece | File |
| --- | --- |
| Table, registry, RLS, functions | `supabase/migrations/20261117090000_form_drafts.sql` |
| Hook used by every form | `src/hooks/use-persistent-form-draft.ts` (`usePersistentFormDraft`) |
| Status bar (Saving… / All changes saved / Unable to save — Retry / Draft restored, Save / Discard / Restore Draft, conflicts) | `src/components/common/form-draft-bar.tsx` |
| Pure logic (serialisation, secrets, browser copy, restore decision) | `src/features/drafts/draft-model.ts` |
| Supabase calls | `src/services/form-drafts.ts` |
| Save-before-sign-out | `src/features/drafts/draft-flush.ts`, `src/auth/auth-provider.tsx` |

### Lifecycle

1. **Open.** The form loads its normal data. The hook then asks the server for the user's draft of this form (`erp_form_draft_get`), and reads this browser's copy.
   - If there is a draft, it is put back into the form and the bar says *"An unsaved draft was found. Your previous entries have been restored."*
   - **Edit forms:** the draft remembers the record version (`updated_at`) it was started on. If the record has changed since, the draft is **not** applied; the bar offers *Restore Draft* or *Discard Draft*. An older draft never silently overwrites a newer record.
   - If the user started typing before the draft arrived, their typing is kept and the draft is offered with *Restore Draft*.
2. **Edit.** Every change is written at once to this browser (`localStorage`, per user, company, form, record and scope), then saved to Supabase after **1.5 s** without typing (`erp_form_draft_save`).
   - A pending change is also saved immediately when the form closes. That covers another module, another tab or sub-feature, a route change and Back / Forward.
   - It is also saved when the page is hidden or closed, and before sign-out.
   - If the page closes before the server answers, the browser copy is sent the next time the form opens.
3. **Errors.** A failed save shows *"Unable to save — Retry"*. The entries stay on screen and in the browser, and saving is retried automatically after 5 s, 15 s, 30 s and then every minute.
4. **Conflicts.** Each save sends the version it last saw. If another window or device saved in the meantime, the server refuses the save (`CONFLICT`) and returns the newer draft; nothing is overwritten. The user chooses *Keep this window's version* or *Load the other version*. If the form was already submitted elsewhere, the choice is *Keep editing as a new draft* or *Start over*.
5. **Submit.** The form runs its existing business function unchanged.
   - Only after the database confirms it does the form call `markSubmitted()` (`erp_form_draft_close(…, 'submitted')`), which clears the stored values.
   - A failed submission leaves the draft untouched.
   - Duplicate submissions are still prevented by the forms' existing busy states and request ids (idempotency keys).
6. **Discard.** *Discard Draft* closes the draft (`'discarded'`, values cleared) and puts the form back to how it opened. *Restore Draft* undoes this.
7. **Sign-out.** Pending drafts are saved first; then this browser's copies that the server already holds are removed. Copies the server could not receive (offline) stay for the same user and are sent on the next sign-in.

### Database

`public.erp_form_drafts` — one row per **company + user + form + record + scope** (unique index `erp_form_drafts_key`).

- **Columns:** `module`, `feature`, `form_key`, `record_id` (edit forms), `scope` (variants such as "copy of PO X"), `draft_data` jsonb, `base_version`, `status` (`draft` / `submitted` / `discarded`), `version`, `created_at`, `updated_at`, `last_saved_at`.
- **Registry:** every form key is listed in `private.erp_form_draft_registry()` with the permissions needed to use the form. Unknown keys are refused. A draft can be read or saved only while the user is active, belongs to an active company, and holds one of those permissions.
- **RLS:** clients have `SELECT` only, and only on their own drafts in their own company. All writes go through the `SECURITY DEFINER` functions. Nobody else can read a draft — not other users, administrators or other companies.
- **No secrets:** keys that look like passwords, tokens, OTPs, API keys or card data are dropped by the browser and refused by the server. Files are never stored. The size limit is 256 KB.
- **Isolation from ERP data:** drafts never touch ERP records. The ERP reset deletes them with the company's business data (`erp_reset_tables` now lists 80 tables; the force reset purges 86).

## Coverage

| Module | Form | Kind | Notes |
| --- | --- | --- | --- |
| Purchase | New / edit / copy purchase order (`/purchase-orders/new`, `?copy=`, `?from_so=`, `/:id/edit`) | Transaction, line items | Header, lines (goods / services / charges, discounts, GST), warehouse choice |
| Purchase / Warehouse | Goods receipt against a PO, and its correction | Modal, line items | Entered quantities, locations, batches, reasons; PO quantities always come fresh from the server |
| Purchase / Warehouse | Goods received without a PO, and its correction | Modal, line items | |
| Sales | New / edit sales order | Transaction, line items | Customer, addresses, products, prices, discounts, charges |
| GST & Invoicing | New invoice (from a sales order / manual), edit draft invoice | Transaction, line items | Separate drafts for "from sales order" and "manual"; GST, discounts, freight / packing |
| Finance & Accounts | Record customer payment | Modal | Amount, method, references, allocations to invoices |
| Production | New / edit production order | Transaction | Product, quantities, location, completion figures |
| Production | New / edit bill of materials | Line items | Header and components (the planning fields are Product Master values, saved with the product) |
| Inventory | Opening stock entry | Multi-step modal, line items | Lines entered so far and the step (edit / review) |
| Product Master | Add / edit product | Edit form | All fields; the image file must be chosen again |
| Ledger | Add / edit customer / supplier (party) | Edit form | |
| Users & Roles | Invite user | Modal | Details and selected roles (roles the user may no longer assign are dropped) |

### Forms not restored automatically, and why

- **Sign-in, password reset, invitation activation, ERP reset / force reset confirmations:** these contain passwords or destructive confirmations, which must never be stored.
- **File uploads** (product image, documents, Excel imports for products, BOMs, sales orders, invoices, production and opening stock): browsers do not allow a chosen file to be saved and re-attached. The other fields of these forms are restored and the file must be chosen again. The import previews are rebuilt from the file.
- **Settings screens** (ERP Settings hub, invoice settings, company settings, warehouses): they edit live settings that are saved directly. They are not covered yet; the same hook can be added (one registry line and three lines per form).
- **Short confirmation dialogs** (reasons for cancel / reject / revoke / reverse, approvals, allocations of an existing receipt, credit / debit notes, quick-add customer / supplier / product / category): one or two fields filled at the moment of the action. They are not covered.
- **HR & Payroll, Compliance:** these modules have no forms in ALTON ERP V2 yet.

## Adding a form

1. Add a line to `private.erp_form_draft_registry()` in a new migration, with the form key, module, feature and the permissions that allow using the form.
2. Add the key to `DraftFormKey` in `draft-model.ts`.
3. In the form:

```tsx
const draft = usePersistentFormDraft({
  formKey: 'sales.order', recordId: so?.id ?? null, baseVersion: so?.updated_at ?? null,
  enabled: has('sales_orders.create'),
  value: { customerId, h, lines: lines.map(({ key, ...l }) => l) },     // plain JSON; leave out React keys
  onRestore: (d) => { setCustomerId(d.customerId); setH(d.h); setLines(d.lines.map(withNewKey)) },
})
// after the form's own save succeeded:
void draft.markSubmitted()
// under the page heading:
<FormDraftBar draft={draft} showSave={false /* when the form already has its own "Save draft" */} />
```

Set `enabled` to false until the form shows its initial values. This matters when they are loaded asynchronously, as in the BOM editor.

## Tests

- **DB:** `supabase/tests/form_drafts_verification.sql` (55 checks) — save / restore with nested line items; versions and conflicts; users and companies isolated; permissions, deactivated users, lost permissions; secrets and size; submit / discard; direct writes refused; reset classification.
- **Rollback:** `tests/db/form-drafts-rollback-check.mjs`.
- **Read-only scan:** `erp_form_draft_get` and `erp_form_drafts_mine` in `tests/db/readonly-rpc-check.mjs`.
- **Unit:** `tests/unit/form-drafts.test.ts` — serialisation, secrets and files, restore decisions (server, browser, conflict, stale record, submitted elsewhere), browser copies and sign-out.
- **UI smoke** (`tests/ui-smoke/run.mjs`, "Drafts" steps):
  - switching modules, menu navigation and full page changes;
  - refresh, Back / Forward;
  - a conflict with another window;
  - a failed save with Retry;
  - Discard / Restore;
  - sign-out / sign-in as the same user and as another user;
  - a failed then successful submission.

## Deployment (not applied automatically)

1. Review, then apply `20261117090000_form_drafts.sql` after the earlier pending migrations (20261110 … 20261116), in order, in the SQL Editor.
2. Deploy the frontend. No Edge Function and no secrets are needed.
3. **Verify:**
   - open a new purchase order, type, switch to Inventory and come back: the restore notice and the values appear;
   - in the SQL Editor, `select form_key, status, version from public.erp_form_drafts;` shows the row;
   - as another user, the same form is empty.
4. **Rollback:** run `supabase/rollback/20261117090000_form_drafts_down.sql`, before any older rollback. Only unsaved working copies are lost; no ERP data changes.
