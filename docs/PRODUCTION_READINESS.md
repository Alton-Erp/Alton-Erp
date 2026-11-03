# Production readiness (Phases 11–12)

Release checklist, environment and secret rules, backup and recovery, rollback, staging validation, approvals, and the dashboard KPI definitions for the Alton ERP.

The audit results are in the Phase 11 and Phase 12 reports. This file records the procedures and what still needs a person with access to do. The step-by-step staging guide is **[STAGING_SETUP.md](STAGING_SETUP.md)**.

**Current status:** ready for staging validation. Staging validation has **not** yet been performed against a real staging project. Production review starts only when every row of the sign-off table in §7 is filled in.

Status words used below:
- **PASS**: executed and passed.
- **FAIL**: executed and failed.
- **BLOCKED**: could not run (missing access, account or configuration).
- **NOT RUN**: not executed.
- **MANUAL REVIEW REQUIRED** (MANUAL): needs a person with staging or production access, or an external authority.

Only PASS counts as passed.

---

## 1. Environments

| Environment | Database | Frontend config | Purpose |
| --- | --- | --- | --- |
| Local | PGlite (in-memory, `npm run test:db`) | none | Automated SQL, RLS and E2E suites; nothing persists |
| UI smoke | Mock API (`tests/ui-smoke`) | `.env.smoke` (no credentials) | Browser journeys against a mock |
| Staging | A **separate** Supabase project | `.env.staging` (git-ignored) | Migrations dry run, live verification, concurrency check, user acceptance |
| Production | The live Supabase project | Host's environment settings | Real business data |

Rules:
- Staging and production are separate Supabase projects with different URLs and keys. Never point a staging build at production.
- The browser needs only `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` (or the legacy `VITE_SUPABASE_ANON_KEY`).
  - Both are public by design. RLS protects the data.
  - The app refuses to start with a `sb_secret_` or service-role key.
- The service-role key is used only by the `invite-user` Edge Function. Supabase injects it there; it is never in the repository, `.env*` files or the hosting environment for the frontend.
- `.gitignore` excludes `.env` and `.env.*`, except `.env.example` and `.env.smoke`, which hold no credentials.
- The project folder audited in Phase 11 is not a Git repository. Before go-live, put it under version control with this `.gitignore`, and confirm no `.env.local` was ever committed elsewhere.
- If a secret is ever exposed, rotate it in Supabase → Project Settings → API (or Edge Function secrets). Then redeploy the function, and review the audit log for the exposure window.

## 2. Deployment checklist

| # | Step | Status / who |
| --- | --- | --- |
| 1 | `npm ci` from `package-lock.json`, then `npm run build` (runs `tsc -b`) | Build PASS locally; `npm ci` on the build server: MANUAL |
| 2 | `npm run lint`, `npm run test:unit`, `npm run test:db`, `npm run build:smoke && npm run test:ui` | PASS locally (see report) |
| 3 | Create the **staging** project. Run `npx supabase db push --dry-run`, then `db push` (50 migrations) | MANUAL |
| 4 | On staging, run the SQL Editor verification files (every `supabase/tests/*_verification.sql`). Each must end with `failed=0` | MANUAL |
| 5 | On staging, create the 10 `stg-` accounts and run `supabase/staging/seed_staging_test_data.sql`. Then run `npm run verify:supabase` and `npm run verify:concurrency` (test companies only; see [STAGING_SETUP.md](STAGING_SETUP.md)) | MANUAL |
| 6 | Supabase Auth: Site URL = production URL. Redirect URLs = `<prod>/reset-password` and `<prod>/login` (and the staging equivalents on staging). Email confirmations on; signups disabled (users are invited) | MANUAL |
| 7 | Edge Function `invite-user`: deploy; set secrets `INVITE_REDIRECT_URL=<prod>/reset-password` and `ALLOWED_ORIGINS=<prod origin>`. If `ALLOWED_ORIGINS` is empty the function allows any origin; a valid user token is still required | MANUAL |
| 8 | Storage: buckets `product-images` and `documents` exist and are **private** (created by migrations; check in the Dashboard) | MANUAL |
| 9 | Hosting: no hosting configuration is in the repository. Configure: HTTPS only; an SPA fallback so every path serves `index.html`; the two `VITE_` variables; the custom domain and DNS. Camera scanning needs HTTPS | MANUAL |
| 10 | Back up production (section 3) **before** applying migrations to it | MANUAL |
| 11 | Apply migrations to production (`db push`). Phase 11 adds `20261019090000_readiness_indexes.sql` (indexes only) and `20261019090100_rls_policy_performance.sql` (equivalent policies) | MANUAL, needs approval |
| 12 | Bootstrap the first Super Admin (docs/SUPABASE_SETUP.md §6); invite users with the right roles; keep at least two Super Admins | MANUAL |
| 13 | Company settings: legal name, address, state, GSTIN, time zone, financial-year start | MANUAL |
| 14 | Invoice settings: series prefix, padding, financial-year reset, GST registration, bank details. Confirm the first invoice number with Accounts **before** issuing anything | MANUAL |
| 15 | GST review by the company's tax professional (section 6) | MANUAL (external) |
| 16 | Master data: products with HSN and GST rate, warehouses and locations, customers with GST details; opening stock through submit → approve | MANUAL |
| 17 | Error monitoring: errors are logged to `error_events` (System Health page). No external monitoring service is configured; decide whether to add one | MANUAL |
| 18 | User training on approvals, scanning, dispatch, invoicing and payment allocation | MANUAL |

### Rollback
- **Frontend:** redeploy the previous build artefact. The hosting platform's "previous deployment" feature is enough.
- **Database:** migrations are forward-only and additive. Do not "down-migrate" business tables. To undo a Phase 11 change:
  - **Indexes:** `drop index if exists <name>` for the indexes listed in `20261019090000_readiness_indexes.sql`. Harmless.
  - **Policies:** re-create the eight previous policies from their original migrations (`20261010090600`, `20261011090000`, `20261012090100`/`0200`/`0300`). The Phase 11 policies are proven equivalent by the readiness suite, so rollback should not be needed.
- **Data errors:** never edit balances, invoices or payments directly. Use the module's own correction:
  - **Stock:** reversal or adjustment.
  - **Invoices:** credit or debit note, or cancellation.
  - **Payments:** reversal or allocation reversal.

## 3. Backup and recovery

**Nothing about the production backup configuration could be verified in Phase 11**, because there was no access to the Supabase project. The responsible administrator must confirm and record the following:

| Item | What to check / decide | Record here |
| --- | --- | --- |
| Plan and daily backups | Supabase → Database → Backups. Check whether daily backups exist and what the retention is (it depends on the plan) | |
| Point-in-time recovery | Whether PITR is enabled (a paid add-on) and the retention window | |
| RPO / RTO | Agree the acceptable data loss (e.g. 24 h with daily backups) and restore time with management | |
| Storage files | Database backups do **not** contain the uploaded files (product images, documents), only their metadata. Plan a separate, regular export of both buckets (e.g. a scheduled script with a server-side key, kept outside the browser) | |
| Off-platform copy | Periodic `pg_dump` (Dashboard connection string, run by an administrator) stored encrypted outside Supabase | |
| Access | Who can restore; MFA on the Supabase organisation account | |
| Responsible administrator | Name and deputy | |

**Restore test (staging, at least before go-live and then quarterly):**
1. Restore the latest backup or dump into a **new** project. Never overwrite production.
2. Run every `supabase/tests/*_verification.sql`. Each must end with `failed=0`.
3. Run the integrity query:

   ```sql
   with tx as (select batch_id, location_id, sum(direction * quantity) q from inventory_transactions group by 1, 2)
   select count(*) from tx full join inventory_balances b using (batch_id, location_id)
   where coalesce(tx.q, 0) <> coalesce(b.on_hand, 0);
   ```

   The result must be `0`.
4. Compare invoice, payment and stock totals with the source project.
5. Record the date, the duration (this is your measured RTO) and the result.

## 4. Staging validation: commands, variables, expected results

Full instructions: [STAGING_SETUP.md](STAGING_SETUP.md).

### Required environment variables (names only; values live in the git-ignored `.env.staging`)

| Variable | Needed for |
| --- | --- |
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` (or `VITE_SUPABASE_ANON_KEY`) | Staging app build, `verify-supabase.mjs`, `concurrency-check.mjs` |
| `STAGING_EMAIL_PREFIX`, `STAGING_EMAIL_DOMAIN`, `STAGING_TEST_PASSWORD` | Both scripts (test accounts `<prefix>+stg-<role>@<domain>`) |
| `CONFIRM_STAGING=yes` | `concurrency-check.mjs` only (it writes test records) |
| `STAGING_SEND_RESET_EMAIL=yes`, `STAGING_APP_URL` | Optional password-reset email test |
| Edge Function secrets `INVITE_REDIRECT_URL`, `ALLOWED_ORIGINS` | `invite-user` function (set with `npx supabase secrets set`) |

The service-role key, secret keys and the database password are **never** needed by the app or these scripts. The scripts refuse a privileged key and mask any configured password, JWT or key in their output.

### Commands and expected results

| # | Command / action | Needs staging access? | Expected result |
| --- | --- | --- | --- |
| 1 | `npm ci && npm run lint && npm run build` | No | No errors |
| 2 | `npm run test:unit && npm run test:db` | No | Unit 79/79. The 9 SQL suites all show `failed=0` (1,301 checks), with 50 migrations applied twice |
| 3 | `npm run build:smoke && npm run test:ui` | No | 79/79 |
| 4 | `npm run test:staging-local` | No | Seed check PASS and script dry run PASS. Local emulation only: **not** staging validation |
| 5 | `npx supabase link --project-ref <staging-ref>`, then `npx supabase db push` | **Yes** | 50 migrations applied |
| 6 | Create 10 `stg-` accounts, then run `supabase/staging/seed_staging_test_data.sql` in the SQL Editor | **Yes** | Notice "Staging test data ready"; 10 accounts listed |
| 7 | Paste each `supabase/tests/*_verification.sql` into the SQL Editor | **Yes** | Each ends with the intentional error `<TAG> passed=N failed=0` |
| 8 | `npm run verify:supabase` | **Yes** | All automated checks PASS. Exit 3 only for the NOT RUN password-reset email; exit 0 when `STAGING_SEND_RESET_EMAIL=yes`. Then complete the MANUAL items |
| 9 | `npm run verify:concurrency` (with `CONFIRM_STAGING=yes`) | **Yes** | 8/8 PASS, exit 0, on two consecutive runs |
| 10 | Backup check and restore test (§3) | **Yes** | Recorded in §3; restored copy passes command 7 and the integrity query |
| 11 | Invoice numbering, GST and hosting checks (STAGING_SETUP Step 10) | **Yes** | Recorded in §7 |
| 12 | `node tests/db/perf-smoke.mjs 10000` | No | Ledger mismatches 0; timings recorded |

Exit codes of both scripts:
- **0:** every check PASS.
- **1:** at least one FAIL.
- **2:** configuration missing or refused; nothing was run.
- **3:** no FAIL, but something was BLOCKED or NOT RUN, so validation is incomplete.

### Common errors

| Message | Fix |
| --- | --- |
| `node: .env.staging: not found` | `cp .env.staging.example .env.staging` and fill it in |
| `BLOCKED: Missing required environment variables: …` | Add the listed variable names |
| `BLOCKED: Refusing to run with a privileged … key` | Use the publishable or anon key, and **rotate** the exposed secret key |
| `BLOCKED: The Supabase project could not be reached` | Check the URL, that the project isn't paused, and the network |
| `test account could not sign in (invalid_credentials)` | Create or confirm the `stg-` account with `STAGING_TEST_PASSWORD` |
| `… not a STG- test company. Refusing to write data` | Wrong project or account. Never run the concurrency script on production |
| Seed: `looks like PRODUCTION` | Wrong project. Stop |
| SQL suite `failed=N` | Read the FAIL lines in the error detail; check all 50 migrations are applied |
| Readiness suite: anonymous can execute an extension function in `public` | Move the extension to the `extensions` schema |
| Concurrency `5b … BLOCKED (validation problems)` | Complete the company and customer GST details on staging |

More cases are in [STAGING_SETUP.md › Troubleshooting](STAGING_SETUP.md#troubleshooting).

## 5. Dashboard KPI definitions and reconciliation

All figures are computed live from the operational tables. There are no analytics tables or caches. Quantities are grouped by unit and never added across units. Dates use the company time zone.

| Metric | Definition | Source | Date basis | Excluded | Reconciled by |
| --- | --- | --- | --- | --- | --- |
| Physical stock on hand | Sum of balances, which equal the sum of posted movements | `inventory_balances` (= `inventory_transactions`) | Current | Archived products in current-position views | Readiness suite (ledger invariant, E2E 22); Phase 9 suite |
| Available stock | On hand − reserved, STORAGE locations only | `inventory_balances`, `inventory_locations.stock_usage` | Current | Quarantine, rejected, external-processing stock | E2E 22, Phase 9 suite |
| Active reservations | Open remainder of ACTIVE / PARTIALLY_FULFILLED reservations | `stock_reservations` (= `inventory_balances.reserved`) | Current | Released, fulfilled, cancelled, expired | Reservation invariant (readiness suite) |
| Dispatched quantity / value | Quantity on consignments whose dispatch was posted in the period; value = quantity × line price snapshot | `fulfilments`, `fulfilment_lines`, `sales_order_lines` | Dispatch date | Ready-but-not-dispatched consignments | E2E 22 (30 000), Phase 9 suite |
| Sales order value | (ordered − cancelled) × price snapshot, orders dated in the period | `sales_orders`, `sales_order_lines` | Order date | DRAFT and CANCELLED orders; unpriced lines are counted, not valued | E2E 22 (30 000) |
| Issued invoice value | Grand total, and taxable value separately, of ISSUED invoices | `sales_invoices` | Invoice date | Drafts, cancelled invoices; notes are shown separately | E2E 22 (35 400 = source) |
| Customer collections | RECORDED receipts by receipt date | `customer_payments` | Receipt date | Reversed receipts | E2E 22 (40 000) |
| Outstanding receivables | Issued total − issued credit notes + issued debit notes − active allocations | `private.invoice_position_as_of` | As-of date | Drafts, cancelled | E2E 19/22, Phase 8 and 9 suites |
| Overdue receivables | Outstanding on invoices past their due date at the as-of date | as above | As-of date | Not-yet-due invoices | Phase 9 suite |
| Production output | Good / rejected / scrap quantities from posted output receipts | `production_output_receipts` | Receipt date | Planned quantities | E2E 22 (38 good, 2 scrap vs plan 40) |
| Outsourced goods awaiting return | Ordered − received on open outsourcing orders; material held by suppliers from EXTERNAL_PROCESSING balances | `outsourcing_orders`, `inventory_balances` | Current | Material held externally is never "available" | Phase 5 and 9 suites |

Not reported, because reliable source data does not exist: profit, gross margin, net income, cash flow and full financial statements. Stock valuation is shown only when every lot on hand has a recorded cost.

## 6. GST and statutory items for professional review

The software calculates GST from configuration. **It is not certified, and it does not file or submit anything.**

What the system enforces:
- Invoice issue is blocked when any of the following is missing or invalid:
  - seller address or GSTIN
  - customer address, registration type, or GSTIN (for registered customers)
  - place of supply, or a tax treatment that can't be determined
  - HSN/SAC or GST rate on any line
  - the line price
  - invoice date (future-dated, or before the dispatch)
  - quantity (more than was dispatched)
- Intra-state supplies get CGST + SGST and inter-state supplies get IGST.
- Rounding goes to a separate round-off line (±1).

For the company's tax professional to confirm:
1. HSN codes and GST rates for every product (master data entered by users).
2. Place-of-supply rules for ship-to addresses that differ from bill-to, and for SEZ, export, exempt and composition customers.
3. Invoice numbering format and financial-year reset (Invoice Settings).
4. E-invoicing (IRN/QR) and e-way bill obligations at the company's turnover. **No IRP, GST portal or e-way bill integration exists.** System Health shows them as "Not configured".
5. Credit and debit note reasons and time limits, and the required wording on printed invoices.
6. Rounding policy, and treatment of other charges (freight).

### Finance and GST approvals required before production

| Approval | By | Evidence |
| --- | --- | --- |
| Invoice series: prefix, padding, financial-year reset, **first live invoice number** | Accounts head | Screenshot of Invoice Settings and the staging invoice numbers |
| Company GST registration, GSTIN, state, legal address on invoices | Accounts head and tax professional | Printed staging invoice (intra-state and inter-state) |
| Product HSN codes and GST rates (master data) | Tax professional | Product export reviewed |
| Place of supply, SEZ/export/exempt treatment, credit/debit note rules, invoice wording | Tax professional | Written confirmation, or a list of required changes |
| E-invoicing / e-way bill obligation at the company's turnover | Tax professional | Decision recorded. **The ERP has no IRP, e-way bill or GST filing integration** |
| Opening stock quantities and costs | Accounts and stores | Approved opening stock documents in the app |
| Receivables opening balances (if migrated) | Accounts head | Reconciliation against the old system |

## 7. Final production approval checklist

Fill in on paper or in your tracker. Production deployment may be scheduled only when **every line is PASS or approved**.

| # | Item | Result / approver | Date |
| --- | --- | --- | --- |
| 1 | Repository under version control; no `.env*` with values committed | | |
| 2 | Local checks (commands 1–4) PASS on the release commit | | |
| 3 | Staging: 50 migrations applied; exposed schemas = `public` only | | |
| 4 | Staging: all 9 SQL suites `failed=0` | | |
| 5 | Staging: `verify-supabase.mjs`, all automated checks PASS (including the password-reset email) | | |
| 6 | Staging: MANUAL browser checks done (login, reload, logout, role menus, permission pages) | | |
| 7 | Staging: `concurrency-check.mjs` 8/8 PASS on two runs | | |
| 8 | Backups: plan, retention and PITR recorded; separate Storage file backup in place | | |
| 9 | Restore test on a separate project PASS; restore time recorded | | |
| 10 | Invoice numbering approved by Accounts | | |
| 11 | GST review completed by the tax professional | | |
| 12 | Hosting: HTTPS, SPA fallback, staging build verified, production build env names set (no secrets) | | |
| 13 | Auth: Site URL and redirect URLs for production; sign-ups disabled; at least 2 Super Admins planned | | |
| 14 | `invite-user` deployed with `INVITE_REDIRECT_URL` and `ALLOWED_ORIGINS` for production | | |
| 15 | Production backup taken immediately before the migration | | |
| 16 | Rollback plan (§2) reviewed; responsible administrator named | | |
| 17 | Users trained; go-live date agreed with management | | |
| 18 | Management sign-off for production deployment | | |

## 8. Known limitations

Tested and verified:
- **Concurrency.** Locally (Phases 11–12): the critical writers take row locks, idempotency keys are unique, and duplicate submissions are tested sequentially. The concurrency script also runs end to end against a local emulation, but that engine executes one request at a time. **True simultaneous requests are verified only by running `scripts/concurrency-check.mjs` on staging, which has not been done yet.**

Not built, or not configured:
- **Not built:** Marketplace Orders. Supplier payables (supplier invoices and payments) are also not recorded. They are labelled "Not built" in the sidebar and on the page.
- **Not configured:** email and push notifications, Supabase Realtime, scheduled jobs (escalations run when users open the app), and external error monitoring.
- **Carrier tracking:** delivery tracking is manual (status events entered by users). It is not live carrier tracking.
- **Statutory integrations:** no GST return filing, e-invoicing (IRN/QR) or e-way bill integration. Nothing is submitted to any government portal. Invoices are printed and filed through the company's existing process.
- **Camera scanning:** it works only in browsers with `BarcodeDetector` over HTTPS. Keyboard-wedge scanners work everywhere.
