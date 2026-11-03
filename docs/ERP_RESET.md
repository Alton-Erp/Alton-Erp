# ERP data reset

**ERP Settings → Reset ERP Data** permanently deletes the business data of the signed-in Super Admin's company from
Supabase. It keeps the company itself, every user and access setting, the configuration, and the database schema.

| Part | File |
|---|---|
| Migration | `supabase/migrations/20261030090000_erp_reset.sql` |
| Edge Function | `supabase/functions/reset-erp-data/index.ts` |
| Screen | `src/features/admin/erp-reset-card.tsx` (on `src/pages/admin/erp-settings-page.tsx`) |
| Service | `src/services/erp-reset.ts`, `src/features/admin/erp-reset-model.ts` |
| Tests | `supabase/tests/erp_reset_verification.sql` (83 checks), `tests/unit/erp-reset.test.ts`, UI smoke steps "ERP reset: …", `tests/db/erp-reset-rollback-check.mjs` |
| Rollback | `supabase/rollback/20261030090000_erp_reset_down.sql` (manual only) |

## What is deleted and what is kept

**Deleted:** the 75 tables in `private.erp_reset_tables()`, children first, only rows of the caller's company:

- sales orders, fulfilments, dispatches, deliveries and returns;
- invoices, payments and credit/debit notes;
- customer POs and their imports;
- customers and customer product codes;
- suppliers, supplier POs and goods receipts;
- BOMs, production orders, issues and output;
- outsourcing;
- stock ledger, balances, batches, reservations, counts, adjustments, opening stock, requests and alerts;
- approval requests and decisions, notifications and import jobs;
- all Amazon business data (listings, sync jobs and errors, daily sales and ads data, recommendations, budget plans and change requests).

**Kept:** the tables in `private.erp_reset_kept_tables()`:

- the company and its settings;
- profiles, users and every role assignment, including all Super Admins;
- roles, permissions and their grants;
- the audit log and the reset history;
- invoice settings and number series;
- approval workflows;
- notification preferences and the system error log;
- Amazon settings and connections;
- warehouses and locations;
- products and categories, and documents.

Also kept: suppliers that a product names as its preferred supplier, because products are kept and reference them.

Supabase Auth users are never deleted. The initiating Super Admin stays signed in.

**Number series are not reset.** Document numbers continue from where they were, so they never repeat numbers that
appear in the audit log.

## When the reset refuses: blockers

The database protects certain records with guards that block deletion. The reset never disables these guards and never
uses TRUNCATE:

- posted stock movements;
- order, PO, production, outsourcing, billing and delivery event histories;
- posted receipts, issues and output;
- invoices and their lines;
- payments and allocations;
- credit/debit notes;
- BOMs;
- import history;
- approval decisions.

If any of these tables holds rows for the company, the reset **stops before deleting anything**. The screen and the
response list each blocker with its row count and reason.

Two other cases also block the reset:

- **Documents attached to records that would be deleted.** Documents are archived, never deleted, and their files are
  in Storage.
- **A public table that is not classified** as resettable or kept. A future migration that adds a table must classify
  it.

In practice, any company that has posted stock, issued an invoice or created an order (which writes event history) is
blocked. For an approved demo or development company, the **force reset** described below can delete that history.

`demo_presentation_data` (present only in some databases) is classified as resettable when it has a `company_id`
column; otherwise it blocks the standard reset as unclassified.

## How a reset runs

1. **Preview.** The Super Admin opens ERP Settings. `erp_reset_preview()` is read-only and checks for Super Admin plus
   `system.reset_data`. It shows what will be deleted, what is kept, the blockers and previous attempts. The page also
   recommends a backup.
2. **Confirm.** The modal asks for the current password and the text `RESET ERP`. Each opening of the modal gets a
   random `request_id`.
3. **Edge Function `reset-erp-data`:**
   - takes the user from the verified JWT;
   - checks Super Admin and the permission;
   - refuses accounts without password sign-in (this ERP signs in with email and password only);
   - checks the rate limit of 5 wrong passwords per 15 minutes;
   - verifies the password against Supabase Auth with the verified email, then signs that extra session out;
   - calls `erp_reset_execute` as service_role. The password is never logged, stored or sent to the database.
4. **`erp_reset_execute`.** This function runs only for service_role, so a browser cannot call it. It:
   1. checks the request id (a replay returns the stored result);
   2. takes a per-company advisory lock (a concurrent reset gets `IN_PROGRESS`);
   3. re-checks authorization with the actor's profile and role rows locked;
   4. re-checks blockers;
   5. deletes the allowlist in foreign-key order inside one transaction;
   6. verifies before commit:
      - the allowlist is empty;
      - kept tables have unchanged counts;
      - schema objects are unchanged (tables, RLS, policies, triggers, constraints, indexes, functions);
      - the Super Admin's access is intact.

   Any error rolls back every deletion and is recorded as **FAILED** with the real reason. Each attempt
   (completed, blocked or failed) writes a row in `erp_reset_runs` and an `erp_reset.*` event in `audit_logs`. Both
   are append-only and contain no secrets.
5. **Post-commit check.** `erp_reset_verify` runs after the commit. The success message ("ERP data reset completed
   successfully…") is shown **only** when the in-transaction check and this post-commit check both pass. The ERP then
   reloads from the database, so no dashboard or list keeps stale data. The browser stores no business data: only the
   sidebar state in localStorage and the report period in sessionStorage.

## Setup

1. **Backup.** Take a backup first: Supabase Dashboard → Database → Backups (or point-in-time recovery), or
   `supabase db dump`. Check that it restores.
2. **Database.** Run `supabase migration list`, then `supabase db push`, and review the list before confirming. This
   migration only adds:
   - the permission, granted to SUPER_ADMIN;
   - the `erp_reset_runs` table;
   - functions.

   It deletes nothing by itself.
3. **Verify.** Paste `supabase/tests/erp_reset_verification.sql` into the SQL Editor. It must end with
   `ERP_RESET_VERIFICATION_RESULT passed=83 failed=0`. The error is intentional and rolls back its own companies
   (ERA/ERB/ERC).

   The script briefly creates and drops a test table and a trigger on `customers` inside its transaction, which locks
   `customers` for a few seconds. Run it at a quiet time.
4. **Edge Function.** Run `supabase functions deploy reset-erp-data`.
   - `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are injected by Supabase.
   - Optional secret: `ALLOWED_ORIGINS=https://your-erp-domain`.
   - Keep JWT verification on (the default).
5. **Frontend.** Deploy the build. The card appears only for users with the SUPER_ADMIN role and `system.reset_data`.
6. **Open the preview.** Go to ERP Settings and read the blockers before attempting a reset.

**Data that could come back:**

- No seed script inserts business data. `supabase/seed.sql` does not exist, and the migrations seed only roles,
  permissions, the company and suggested categories.
- Amazon data is synced only when a user starts a sync or import. If an external scheduler calls the Amazon Edge
  Functions, stop it first, or the next sync downloads Amazon data again.

## Rollback and recovery

- **Undo the feature:** run `supabase/rollback/20261030090000_erp_reset_down.sql` in the SQL Editor and
  `supabase functions delete reset-erp-data`, then redeploy the previous frontend.
  - `npm run test:db:rollback` proves the rollback works, changes no data, and that the migration re-applies.
  - The rollback keeps the `erp_reset_runs` history.
- **Undo a completed reset:** only by restoring the backup taken before it. The deletion is permanent by design.
- **A failed or blocked reset** changed nothing: its deletions were rolled back. Read the reason in the response, in
  `erp_reset_runs`, or in the audit log under `erp_reset.failed` / `erp_reset.blocked`.

## Force reset / delete everything (approved demo or development data only)

> **Changed by `20261113090000_force_reset_direct.sql` (operator request):**
> - The button deletes directly through `public.erp_force_reset_now`. No environment approval, backup record, password, typed phrase or Edge Function is needed; there is one "Delete everything now" confirmation.
> - Still required: an active Super Admin with `system.reset_data`, and the user's own company only.
> - Still in place:
>   - one transaction, verified before commit
>   - users, roles, settings and the audit log are kept
>   - every run is recorded in reset history
> - Product images are removed by the browser afterwards. Stored document files cannot be deleted from the browser; their number is reported.
> - **Take a database backup before using it.**
> - Rollback: `supabase/rollback/20261113090000_force_reset_direct_down.sql`
>
> The approval flow described below is kept in the database but is no longer used by the screen.

**ERP Settings → Force Reset / Delete Everything** deletes *all* business data of the company, including the protected
history that blocks the standard reset. It is meant for a company whose data is demo, development or test data. It
runs only after a database owner has approved that company for it.

| Part | File |
|---|---|
| Migration | `supabase/migrations/20261031090000_erp_force_reset.sql` |
| Edge Function | `supabase/functions/force-reset-erp-data/index.ts` |
| Screen | `src/features/admin/erp-force-reset-section.tsx` (below the grid on `src/pages/admin/erp-settings-page.tsx`) |
| Service | `src/services/erp-force-reset.ts`, `src/features/admin/erp-force-reset-model.ts` |
| Tests | `supabase/tests/erp_force_reset_verification.sql` (129 checks), `tests/unit/erp-force-reset.test.ts`, UI smoke steps "Force reset: …", `tests/db/erp-force-reset-rollback-check.mjs` |
| Rollback | `supabase/rollback/20261031090000_erp_force_reset_down.sql` (manual only; roll this back before the standard reset's) |

### What it deletes and keeps

**Deleted** (only rows of the company; 81 reviewed tables in `private.erp_force_reset_tables()`):

- everything the standard reset deletes, now **including protected records**:
  - posted stock movements and reversals;
  - issued invoices and their lines;
  - payments and allocations;
  - credit and debit notes;
  - BOMs;
  - production, outsourcing, order, PO, billing and delivery histories;
  - import history;
  - approval decisions;
- products, product categories, warehouses and locations;
- documents attached to anything except the company itself, and their files;
- product images and document files in Storage (removed after the database commit);
- `demo_presentation_data`, when that table exists and has a `company_id` column.

**Kept** (`private.erp_force_reset_retained_tables()`):

- the company record and company settings;
- every user profile and role assignment, including all Super Admins;
- roles, permissions and their grants;
- the audit log, the reset history and the backup records;
- invoice settings and number series (numbering continues and never repeats);
- approval workflows and stages;
- notification preferences and sync state;
- the system error log;
- Amazon settings and connections;
- documents attached to the company itself (for example KYC or contracts) and their files;
- the database schema, functions, triggers and RLS.

Supabase Auth users are never deleted.

**Discovery.** Every public table is read from the catalogue at preview and execute time. These three cases block the
force reset until a migration classifies the table:

- a table with a `company_id` column that is in neither list;
- a foreign key from any table outside the purge list into it;
- `demo_presentation_data` without `company_id`.

The deletion order is computed from the live foreign keys, children first. Self-referencing tables (reversals, child
locations, retried imports, PO revisions) are deleted leaf-first.

### How protected rows are deleted without switching protection off

Nothing is disabled: no trigger, RLS policy or constraint, and no TRUNCATE or CASCADE.

Each of the 11 guard functions on purge tables gets one early `return old` for DELETE. It applies only when the
transaction-local setting `app.erp_force_purge` names a purge-session row that meets all of these:

- it was inserted by `erp_force_reset_execute` in the **same transaction** (`txid_current()`);
- it belongs to the **same company** as the row being deleted;
- the row's table is in the reviewed purge list.

The reset history and backup records are not in that list. The audit-log guard is unchanged. Updates and TRUNCATE stay
forbidden. No API role can read or write purge sessions. The verification suite proves that:

- a made-up setting, an old session or another company's session cannot delete anything;
- the guards refuse again after the reset.

### Requirements (all checked again by the database under lock)

1. **Signed-in Super Admin** of that company with `system.reset_data`. The database takes the identity from
   `auth.uid()`.
2. **Environment approval** by a database owner in the Supabase SQL Editor. API roles cannot create, see or change
   approvals. An approval:
   - expires (1–72 hours);
   - can be revoked;
   - is used up by the first completed force reset.
3. **Backup record**, from **Verify Backup**. This is an **administrator attestation, not an automatic check**: the
   database cannot open a Supabase backup. The Super Admin records:
   - the method;
   - a reference (refused if it contains passwords or connection strings with credentials);
   - when the backup was taken (within the last 24 hours);
   - that a restore was checked;
   - that the backup is outside this database and not undone by the reset.

   The record is append-only, valid for 24 hours and for one completed force reset. The preview also shows how many
   audited changes happened after the backup time.
4. **Fresh password.** The Edge Function checks the password against Supabase Auth, using the same rate limit as the
   standard reset. It then issues a one-time ticket (stored hashed, valid 2 minutes) and calls `erp_force_reset_execute`
   with the **user's own JWT**. The browser never sees the ticket, so it cannot call execute usefully itself.
5. **Typed confirmations:**
   - `DELETE ALL COMPANY DATA`;
   - then, on a second screen that shows the company name, code, ID and backup, the **company code**.
6. **Reviewed plan:** no unreviewed tables, references or cycles.

One reset (standard or force) runs per company at a time, using the same advisory lock. The request id makes retries
idempotent. A second request after a completed force reset is **BLOCKED**, because the approval and backup are used up.

### Verification

**Inside the transaction**, before commit, the database checks that:

- every purge table is empty for the company;
- other companies' rows are unchanged;
- retained tables are unchanged (the audit log may only grow);
- the schema fingerprint is unchanged;
- the initiating Super Admin still has access;
- the number of Super Admins is unchanged;
- the company is active.

Any failure rolls everything back and is recorded as **FAILED**.

**After the commit**, the Edge Function:

1. removes the company's files from Storage (`<company id>/…` in `product-images` and `documents`, except company-level
   documents);
2. runs `erp_force_reset_verify` (database and Storage).

The success message appears only when both checks pass. If files remain, the response says so. Retrying the same request
finishes the clean-up without deleting anything twice.

If the database call itself fails (for example a statement timeout, which rolls everything back), the function records a
FAILED run. A request that did commit is never overwritten.

**History:** every attempt is a row in `erp_reset_runs` (`mode = FORCE`). It records:

- the actor, company and timestamps;
- the approval and backup ids;
- per-table counts and the result or failure reason;
- the files scheduled for removal.

Each attempt also writes an `erp_force_reset.*` event in `audit_logs`. Neither contains passwords or tickets. **View Reset
History** lists both standard and force attempts.

### Setup (manual; nothing is applied automatically)

1. Apply both reset migrations: `supabase migration list`, then `supabase db push` (review the list before confirming).
   This migration:
   - adds functions, two private tables and the backup-record table;
   - adds four columns to `erp_reset_runs`;
   - replaces the 11 guard functions with the same bodies plus the exemption.

   It deletes nothing.
2. Run `supabase/tests/erp_force_reset_verification.sql` in the SQL Editor. It must end with
   `ERP_FORCE_RESET_VERIFICATION_RESULT passed=129 failed=0`. The closing error is intentional and rolls back its test
   companies FRA/FRB/FRC.

   The script briefly creates and drops test tables and a trigger on `products`, which locks `products` for a few
   seconds. Run it at a quiet time.
3. Run `supabase functions deploy force-reset-erp-data`, keeping JWT verification on. The `ALLOWED_ORIGINS` secret is
   shared with the other functions.
4. Deploy the frontend.
5. **Take the backup** and check it restores (Supabase Dashboard → Database → Backups, or `supabase db dump`).
6. **Approve the company** in the SQL Editor, as the database owner. This is a statement that the company's data is
   demo, development or test data that may be destroyed:

   ```sql
   select private.erp_force_reset_approve(
     'ALTON',                                   -- company code
     'bdb93104-ecae-47cf-90e0-7ea5eb5c4aa1',    -- company id (must match the code)
     'DEMO',                                    -- DEVELOPMENT | DEMO | TEST (production is refused)
     'Name of the approver',
     'Why the data may be deleted (at least 10 characters)',
     24);                                       -- hours, 1 to 72
   ```

   To see or revoke approvals:

   ```sql
   select * from private.erp_force_reset_approvals order by approved_at desc;
   select private.erp_force_reset_revoke_approval('<approval id>', 'reason');
   ```
7. In the ERP:
   1. **Preview Force Reset**, and read every table, protected count and kept item.
   2. **Verify Backup**.
   3. **Force Reset / Delete Everything**.
8. Stop any external scheduler that calls the Amazon Edge Functions, or the next sync downloads Amazon data again.

**Read-only check in the SQL Editor.** `erp_reset_preview()` and `erp_force_reset_preview()` need a signed-in user, and
`auth.uid()` is empty in the SQL Editor; that check is intentional. To inspect the plan there as the database owner:

```sql
select private.erp_force_reset_plan('bdb93104-ecae-47cf-90e0-7ea5eb5c4aa1') - 'counts';
```

### Limits

- **The database cannot tell production from demo data.** The environment approval is the safeguard. Approving a company
  whose data is real makes that data deletable.
- **Backup checking is attestation only.** The ERP cannot open or restore Supabase backups. Data deleted by a force reset
  comes back only by restoring the backup.
- **Time limit.** The reset runs as the `authenticated` role, so it is subject to that role's statement timeout (8
  seconds by default on Supabase). A few thousand records take well under a second. A timeout rolls everything back and
  is recorded as FAILED.
- **Storage files** are removed after the database commit. If removal fails, the result says so and the success message
  is not shown; retry the same request.

### Rollback

- Run `supabase/rollback/20261031090000_erp_force_reset_down.sql` in the SQL Editor, then
  `supabase functions delete force-reset-erp-data`.
- The rollback restores the 11 guard functions to their exact previous bodies, which `npm run test:db:rollback` checks
  byte for byte. It also removes the private approval, ticket and purge-session tables.
- It keeps the reset history (including the new columns) and the backup records.
- A completed force reset can only be undone by restoring the backup.
