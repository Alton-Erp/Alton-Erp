# ALTON ERP V2 — Phase 2: Live Backend Integration Report

**Date:** 31 Oct 2026 · **Hosted project:** `srpeewjutlyruympdznc` ("alton-manufacturing-erp") · **Status: partially verified — authenticated tests blocked on test accounts.**

Every result below is labelled by where it came from:

- **HOSTED**: run against the real Supabase project over its public API with the app's publishable key, so RLS applies exactly as in the browser. Raw output: [`docs/live-runs/2026-10-31-run1-unauthenticated.md`](live-runs/2026-10-31-run1-unauthenticated.md).
- **LOCAL**: local PostgreSQL (PGlite) with all 68 migrations, or the browser UI suite against the mock API. These are **not** evidence of live integration.
- **BLOCKED / NOT RUN**: not tested yet; no result is claimed.

## 1. Summary

| Area | Hosted result |
|---|---|
| Frontend → correct project | **PASS**. `.env.local` → `srpeewjutlyruympdznc`. The CLI is linked to the same ref. The old ERP uses `reuoicscalgcjoabwspu` (different). The browser key is a publishable key. |
| Backend reachable, schema deployed | **PASS**. The API and Auth answer. All tables and functions probed (including the Stage 7 `management_overview`, `erp_settings_get` and `erp_report`) exist: they answer "permission denied", not "not found". |
| Anonymous access / RLS / grants | **PASS**. 22/22 probes refused: 16 core tables, 5 functions and the private documents bucket. |
| Public sign-up | **FAIL** (configuration). Sign-up is **enabled**; anyone can create an account. |
| Super Admin login and access | **BLOCKED**. No login available to the test script yet. |
| 8 modules, dashboard KPIs and date filters, stock by source, ledger, reconciliation | **BLOCKED** (needs the Super Admin login) |
| Workflows (purchase→GRN, production→inventory, sales→invoice→payment) | **NOT RUN**. Needs the STG-A test company and test accounts. |
| Roles, permissions, company isolation between logged-in users | **BLOCKED** (needs the test accounts) |
| Migration history on the hosted DB | **BLOCKED**. `supabase migration list` failed: `DbConfigLoginRoleNetworkError` (the CLI could not open a database login). |

**Totals (hosted):** 26 passed · 1 failed · 2 blocked · 1 not run.

## 2. Passed workflows

- **HOSTED:** none yet. No authenticated workflow could run (see §1).
- **LOCAL** (not live evidence): the full 23-step flow passes in `supabase/tests/stage7_e2e_verification.sql`: products, BOM, PO, GRN, production, sales order, dispatch, invoice, partial and final payment, ledger, dashboards and reports. All 24 database suites pass. The 106 UI smoke steps pass against the mock API.

## 3. Failed workflows

- None run on the hosted backend yet.

## 4. Database errors

- **HOSTED:** none. Every refusal seen was the expected `42501 permission denied` for an anonymous caller.
- **CLI:** `DbConfigLoginRoleNetworkError: failed to initialise login role: TransportError` on `supabase migration list --linked`. This is a connection problem from this machine to the database, not a database error. The API-based checks do not depend on it.

## 5. Permission errors

- **HOSTED:** none unexpected. All anonymous access was refused, as designed.
- **Configuration finding:** `disable_signup=false`. Turn off **Authentication → Sign In / Providers → Allow new users to sign up** before go-live. A self-registered user has no company or role, so RLS still hides all data, but the account exists.

## 6. Dashboard calculation errors

- **Found by code review (fixed, LOCAL):** the "Sales orders" card counted **cancelled** orders, because `sales_dashboard.total_orders` includes them. Its value also included **draft** orders, while the sales chart and `kpis.sales_order_value` exclude both. The card now shows orders excluding cancelled ones, and the overview's order value ([management-overview-page.tsx](../src/pages/management-overview-page.tsx)).
- **HOSTED:** not yet verified (blocked). `npm run verify:live` recomputes every dashboard figure for Today, This week, This month and This year directly from the raw records and reports any difference. The figures are invoiced sales, invoice count, sales orders, purchase orders, production orders, pending GRNs, outstanding payments, and total, manufactured and outsourced stock.

## 7. Work done in this phase

| Task | Result |
|---|---|
| 1 Correct project | Verified (HOSTED), see §1 |
| 8 Obsolete notification links | **Fixed.** New [notification-links.ts](../src/features/admin/notification-links.ts) is used by the bell and the notification centre. Links to removed modules (approvals, Amazon, customer POs, system health) open nothing and show "Module no longer in the ERP". `/customers` and `/suppliers/…` go to the Ledger; `/analytics…` goes to the dashboard. Note: the database's alert sync still **creates** new `/customer-pos/…` and `/customers` links; these are now handled. Unit-tested against every link pattern the database writes. |
| 9 The 51 unreachable files | **Checked with a full import graph** (static imports, `lazy(() => import())`, string mentions in `src`, `tests` and `scripts`). **50 are unused.** **`src/pages/billing/create-invoice-page.tsx` is still used**: the live Create Invoice page imports it. My earlier "51" was wrong for that file, and it must be kept. No unit test imports any of the 50 pages. 41 other modules are also unreachable from the app: 37 are used only by those pages, and 4 were already unused (`demo-form-dialog`, `ui/separator`, `config/labels`, `features/sales/order-dialogs`). Several of those helpers (Amazon analysis, analytics formatting, the old PO import parsers, the supplier model) are covered by existing unit tests, so deleting them would also retire those tests. **Nothing deleted.** |
| 10 Tables and migrations | Untouched. No reset functions and no SQL were run on the hosted project. |
| 11 Local checks | `npm run build` ✓ · `npm run lint` ✓ (0 warnings) · `npm run test:unit` 323/323 ✓ · `npm run test:ui` 106/106 ✓ (mock API) |
| Live test harness | New [`scripts/verify-v2-live.mjs`](../scripts/verify-v2-live.mjs) (`npm run verify:live`). It never writes to ALTON and never prints secrets. Workflows run only with `--workflows`, and only after confirming that the signed-in account belongs to STG-A. |

## 8. To unblock the remaining live tests (your steps)

1. Copy `.env.live.example` to `.env.live` and fill in the real Super Admin email and password. The file stays on this PC and is git-ignored.
2. In the Supabase Dashboard, open **Authentication → Users → Add user** (tick *Auto Confirm*). Create the 10 test accounts listed at the top of [`supabase/staging/seed_staging_test_data.sql`](../supabase/staging/seed_staging_test_data.sql) (`<prefix>+stg-superadmin@<domain>` … `<prefix>+stg-b-admin@<domain>`) with one shared **test** password. Put the prefix, domain and password in `.env.live`.
3. In the **SQL Editor**, edit the three lines at the top of the seed file (prefix, domain, `allow_staging_seed = 'yes'`) and run it. It creates test companies STG-A and STG-B, a warehouse, a product and a customer, all marked TEST. It refuses to run if ALTON already has issued invoices.
4. Tell me when that's done. I'll then run `npm run verify:live -- --workflows --report docs/live-runs/<date>-run2.md` and report the results.

What the authenticated run will create: STG-A only. Per run that's three TEST products, a BOM, a supplier and a customer, one PO and GRN, one production order, one sales order and dispatch, and one invoice with two payments. All are tagged `LIVE <run>`, and these test records stay in the database.

## 9. Remaining development tasks

- Run the authenticated live suite (§8) and fix anything it finds.
- Disable public sign-up; set the Auth Site URL and redirect URLs and SMTP (as in `docs/STAGE8_BACKEND_AUDIT.md`).
- Confirm the hosted migration history: run `supabase migration list` from a machine whose connection to the database works, or check *Database → Migrations* in the Dashboard.
- Decide whether to delete the 50 unused page files and the 41 unreachable helper modules (and retire the matching unit tests).
- The analytics alert sync (`notifications_sync` → `analytics_alerts`) still produces customer-PO alerts. Stopping that at the source needs a new migration; for now the links are handled in the frontend.
- Invoice and purchase charts are monthly (12 months to the end date), not the exact selected range. A small new backend function would be needed for that.
