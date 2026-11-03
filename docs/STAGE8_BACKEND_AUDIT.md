# Alton Manufacturing ERP V2 — Supabase backend deployment audit (Stage 8, Phase 1)

Prepared 31 Oct 2026 from the repository at `C:\Users\Admin\ALTON-ERP-V2`. **Read-only audit: no migration was applied, no Supabase project was contacted, nothing was linked, no secret was read or written.**

Method: every file was read from the repository. The database figures come from applying the local Supabase shim plus all 68 migrations, twice, to a throwaway in-memory PostgreSQL (PGlite 0.5.8, PostgreSQL 18.3) and querying the system catalogs. This is the engine `npm run test:db` uses. Supabase runs PostgreSQL 17, so the first run on Supabase itself is the final proof (see risks R1–R4).

---

## 1. Summary

| Item | Result |
|---|---|
| Migration files | **68**, `20261010090000` → `20261108090000`, no duplicate timestamps, strictly ordered |
| Applies in order on an empty database | **Yes**, twice (idempotent), 2,568 test checks pass afterwards |
| Tables / views / functions | 103 public tables + 3 private tables, 33 views, 271 public + 307 private functions |
| Triggers / indexes / policies | 144 triggers (+2 on `auth.users`), 406 indexes, 121 RLS policies on public tables, 6 on `storage.objects` |
| Storage buckets | 2, both **private**: `product-images` (2 MB, images) and `documents` (25 MB, PDF / images / office) |
| Extensions | none beyond `plpgsql` (`gen_random_uuid()` is built in) |
| RLS | **enabled on all 103 public tables**; no table or view readable by `anon`; no function executable by `anon` |
| Secrets in the repository | none (no `.env.local`, no keys, no project ref); the CLI is **not linked** to any project |
| Hard blockers in the code | **none found** |
| Must be done before the app can be used | create the new project; set the two `VITE_` variables; Auth URLs; bootstrap the first Super Admin (section 9) |
| Risks to verify on the first real run | storage policies, `auth.users` trigger, `auth.sessions` access, Postgres 17 vs 18 (section 8) |

---

## 2. Task 1 — Environment audit

### 2.1 Files

| File | Status | Contents |
|---|---|---|
| `.env.example` | committed template | `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`; warns never to put secret keys in `VITE_` variables |
| `.env.local` | **does not exist** (git-ignored) | must be created for the new project |
| `.env.smoke` | committed | points at the local mock API (`http://localhost:54329`) with a dummy key — used only by `npm run build:smoke` |
| `.env.staging.example` | committed template | staging verification scripts (public key + TEST account settings) |
| `supabase/config.toml` | committed | local CLI stack only (ports, local Auth). `project_id = "alton-erp"` — same name as the original project's local stack (see H6) |
| `supabase/.temp` | **does not exist** | CLI is not linked to any project, old or new |
| `.gitignore` | ignores `.env`, `.env.*` (except the three templates), `*.local`, `supabase/.temp`, `supabase/.branches` | correct |

### 2.2 Supabase client (`src/lib/supabase.ts`)

- One client, created from `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` (falls back to `VITE_SUPABASE_ANON_KEY`).
- Refuses to start with a missing value, a non-https URL (except localhost), or a **secret / service-role key** (`sb_secret_…` or a JWT with role `service_role`).
- Auth: persisted session, auto refresh, `detectSessionInUrl`, **PKCE flow** (password reset and invite links come back to the app URL).
- No other `import.meta.env` variables are used anywhere in `src/`.

### 2.3 Every variable needed for the new backend

**Frontend (`.env.local`, bundled into the browser — public values only)**

| Variable | Required | Value |
|---|---|---|
| `VITE_SUPABASE_URL` | yes | `https://<NEW-project-ref>.supabase.co` |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | yes (or the next one) | Dashboard → Project Settings → API Keys → publishable key `sb_publishable_…` |
| `VITE_SUPABASE_ANON_KEY` | only if the project has legacy keys only | the legacy `anon` public key |

**Edge Functions (Dashboard → Edge Functions → Secrets, or `supabase secrets set`) — never in `.env.local`**

| Function | Variable | Source | Required |
|---|---|---|---|
| all | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | provided automatically by Supabase to every function | automatic |
| `invite-user`, `reset-erp-data`, `force-reset-erp-data`, Amazon | `ALLOWED_ORIGINS` | comma-separated app origins, e.g. `https://erp.alton.example` (CORS) | yes, set by you |
| `invite-user` | `INVITE_REDIRECT_URL` | e.g. `https://erp.alton.example/reset-password` | recommended |
| `amazon-spapi` | `AMAZON_SPAPI_LWA_CLIENT_ID`, `AMAZON_SPAPI_LWA_CLIENT_SECRET`, `AMAZON_SPAPI_REFRESH_TOKEN`, `AMAZON_SPAPI_REGION`, `AMAZON_SPAPI_MARKETPLACE_IDS`, `AMAZON_SPAPI_SANDBOX`, `AMAZON_COMPANY_CODE`, `AMAZON_TIMEZONE_OFFSET_MINUTES` | Amazon Seller Central | only if the Amazon module is used |
| `amazon-ads` | `AMAZON_ADS_CLIENT_ID`, `AMAZON_ADS_CLIENT_SECRET`, `AMAZON_ADS_REFRESH_TOKEN`, `AMAZON_ADS_PROFILE_ID`, `AMAZON_ADS_REGION` | Amazon Ads | only if used |

**CLI / operator only (never committed, never in a `VITE_` variable)**

| Value | Used by |
|---|---|
| Supabase access token | `supabase login` |
| New project ref | `supabase link --project-ref …` |
| Database password | `supabase link` / `db push` (prompted) |

**Staging scripts (optional, `.env.staging`)**: `STAGING_EMAIL_PREFIX`, `STAGING_EMAIL_DOMAIN`, `STAGING_TEST_PASSWORD`, `STAGING_SEND_RESET_EMAIL`, `STAGING_APP_URL`, `CONFIRM_STAGING`.

### 2.4 Edge Functions in the repository

| Function | Called from the app | Purpose | Deploy? |
|---|---|---|---|
| `invite-user` | Users page | invite a user by e-mail (service role, checks `users.manage`) | **yes** if users are invited from the app |
| `reset-erp-data` | ERP Settings → System | standard data reset (Super Admin, password, typed confirmation) | optional |
| `force-reset-erp-data` | ERP Settings → System | delete-everything reset | optional — destructive by design |
| `amazon-spapi`, `amazon-ads` | Amazon module | Amazon sync | only with Amazon credentials |

`config.toml` has no `[functions.*]` overrides, so JWT verification stays on (the default) for all functions.

### 2.5 Authentication configuration (to set on the new project)

| Setting (Dashboard → Authentication) | Value | Why |
|---|---|---|
| Site URL | the deployed app URL | invite / reset links |
| Redirect URLs | `https://<app>/**` and, for local use, `http://localhost:5173/**` | PKCE redirect back to the app |
| E-mail provider | enabled | sign-in is e-mail + password |
| Allow new users to sign up | **off (recommended)** | users are invited; a self sign-up would only get an inactive profile with no company and no access, but there is no reason to allow it |
| Minimum password length | 10+ (recommended); leaked-password protection on (Pro plan) | the local `config.toml` still says 6 |
| Custom SMTP | recommended | the built-in mailer is rate-limited (invites, password resets) |
| JWT expiry | default 3600 s | as tested |

The database side needs nothing extra. Migration `20261010090200_profiles.sql` creates triggers on `auth.users` that create an **inactive** profile per user. Access is granted only by the bootstrap function or by a Super Admin in the app.

### 2.6 Storage configuration

Created by migrations — **do not create the buckets by hand**:

| Bucket | Public | Limit | Types | Object path | Access |
|---|---|---|---|---|---|
| `product-images` | no | 2 MB | jpeg, png, webp | `<company_id>/<product_id>/<file>` | select / insert / update / delete for signed-in users of that company with product permissions; shown through 1-hour signed URLs |
| `documents` | no | 25 MB | pdf, png, jpeg, webp, csv, txt, xlsx, docx | `<company_id>/<document_id>/v<n>/…` | select / insert through `private.document_object_readable / writable`; no update or delete policy (versions are append-only) |

---

## 3. Task 2 — Migration register

Execution order is the order of this table, which is the filename order. "RLS / policies" counts the policies that exist **after all 68 migrations** on the tables the migration creates. These counts were measured in the database, not text-parsed. "Functions" and "Triggers" count `CREATE [OR REPLACE]` statements in the file (redefinitions included).

| # | Migration | Timestamp | Module | Purpose | Tables created | Tables modified | Functions | Triggers | Views | RLS / policies |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `20261010090000_foundation.sql` | 2026-10-10 09:00 | Platform: companies, users, RBAC, audit | Foundation: private helper schema and shared trigger functions. | — | — | 1 | 0 | 0 | — |
| 2 | `20261010090100_companies.sql` | 2026-10-10 09:01 | Platform: companies, users, RBAC, audit | Companies and company settings. | companies, company_settings | — | 1 | 3 | 0 | RLS on all 2; 6 policies |
| 3 | `20261010090200_profiles.sql` | 2026-10-10 09:02 | Platform: companies, users, RBAC, audit | User profiles, one per auth.users row. | profiles | — | 2 | 3 | 0 | RLS on all 1; 4 policies |
| 4 | `20261010090300_rbac.sql` | 2026-10-10 09:03 | Platform: companies, users, RBAC, audit | Role-based access control: roles, permissions, role_permissions, user_roles. | roles, permissions, role_permissions, user_roles | — | 0 | 1 | 0 | RLS on all 4; 7 policies |
| 5 | `20261010090400_audit_logs.sql` | 2026-10-10 09:04 | Platform: companies, users, RBAC, audit | Append-only audit log. | audit_logs | — | 2 | 2 | 0 | RLS on all 1; 1 policies |
| 6 | `20261010090500_authorization_functions.sql` | 2026-10-10 09:05 | Platform: companies, users, RBAC, audit | Authorization helpers. | — | — | 9 | 0 | 0 | — |
| 7 | `20261010090600_rls_policies.sql` | 2026-10-10 09:06 | Platform: companies, users, RBAC, audit | Row Level Security and table privileges. | — | companies, company_settings, profiles, roles, permissions, role_permissions, user_roles, audit_logs | 0 | 0 | 0 | 18 policies changed |
| 8 | `20261010090700_guards_and_audit_triggers.sql` | 2026-10-10 09:07 | Platform: companies, users, RBAC, audit | Guard triggers and automatic audit logging for security-relevant changes. | — | — | 5 | 5 | 0 | — |
| 9 | `20261010090800_seed_rbac.sql` | 2026-10-10 09:08 | Platform: companies, users, RBAC, audit | Seed: role and permission catalogue, and the least-privilege role matrix. | — | — | 0 | 0 | 0 | — |
| 10 | `20261010090900_seed_company_and_bootstrap.sql` | 2026-10-10 09:09 | Platform: companies, users, RBAC, audit | Seed the initial company and provide the one-time Super Admin bootstrap. | — | — | 1 | 0 | 0 | — |
| 11 | `20261011090000_product_master.sql` | 2026-10-11 09:00 | Product Master | Product Master * Granular product permissions + role grants * product_categories and products (company-scoped) * Validation, guard and audit triggers | product_categories, products | — | 11 | 6 | 0 | RLS on all 2; 6 policies |
| 12 | `20261011090100_product_images_storage.sql` | 2026-10-11 09:01 | Product Master | product image storage Private bucket `product-images`. Object names must be <company_id>/<product_id>/<file> Access is decided by the company folder: | — | — | 2 | 0 | 0 | 4 policies changed; bucket product-images |
| 13 | `20261012090000_inventory_permissions.sql` | 2026-10-12 09:00 | Inventory | inventory permissions Reused from Phase 2 (equivalent meaning, not duplicated): inventory.read -> view inventory inventory.create -> post receipts,… | — | — | 0 | 0 | 0 | — |
| 14 | `20261012090100_inventory_locations.sql` | 2026-10-12 09:01 | Inventory | inventory helpers, warehouses and storage locations | inventory_number_sequences, inventory_requests, warehouses, inventory_locations | — | 12 | 7 | 0 | RLS on all 4; 6 policies |
| 15 | `20261012090200_inventory_ledger.sql` | 2026-10-12 09:02 | Inventory | stock ledger core inventory_batches stock lots with their ACTUAL source (and cost/expiry) inventory_transactions append-only ledger: the authoritat… | inventory_batches, inventory_balances, inventory_transactions | products | 6 | 3 | 0 | RLS on all 3; 3 policies |
| 16 | `20261012090300_inventory_operations.sql` | 2026-10-12 09:03 | Inventory | stock operations (RPCs) and reservations All functions: SECURITY DEFINER, permission checked inside, company derived from the caller, idempotency k… | stock_reservations | — | 11 | 0 | 0 | RLS on all 1; 1 policies |
| 17 | `20261012090400_inventory_documents.sql` | 2026-10-12 09:04 | Inventory | approval documents Opening stock (manual + staged import) -> OPENING_STOCK on approval Stock adjustments (quantity / source) -> ADJUSTMENT_IN / ADJ… | inventory_opening_batches, inventory_opening_lines, inventory_adjustments, inventory_counts, inventory_count_lines | — | 15 | 0 | 0 | RLS on all 5; 5 policies |
| 18 | `20261012090500_inventory_reporting_alerts.sql` | 2026-10-12 09:05 | Inventory | read views, reporting functions, reconciliation and alerts Reporting timezone: the company's timezone (companies.timezone). | inventory_alerts | — | 9 | 0 | 3 | RLS on all 1; 1 policies |
| 19 | `20261013090000_production_permissions.sql` | 2026-10-13 09:00 | Production / BOM / outsourcing | manufacturing & outsourcing permissions Reused from Phase 2 (equivalent meaning, not duplicated): manufacturing.read -> production.read (view produ… | — | — | 0 | 0 | 0 | — |
| 20 | `20261013090100_production_inventory_extensions.sql` | 2026-10-13 09:01 | Production / BOM / outsourcing | safe extensions of the Phase 4 inventory ledger No new stock tables. | — | inventory_locations, inventory_transactions | 10 | 0 | 3 | — |
| 21 | `20261013090200_production_boms.sql` | 2026-10-13 09:02 | Production / BOM / outsourcing | bills of materials (BOM) boms one row per BOM version of a finished product / sub-assembly bom_items components required for output_quantity units … | boms, bom_items | — | 13 | 3 | 2 | RLS on all 2; 2 policies |
| 22 | `20261013090300_production_orders.sql` | 2026-10-13 09:03 | Production / BOM / outsourcing | production orders, material reservation / issue, finished-goods output receipts and their history. | production_orders, production_order_materials, production_material_consumption, production_output_receipts, production_order_events | — | 15 | 4 | 3 | RLS on all 5; 5 policies |
| 23 | `20261013090400_outsourcing.sql` | 2026-10-13 09:04 | Production / BOM / outsourcing | outsourcing (third-party manufacturing / processing) outsourcing_orders header (supplier is a controlled text reference until the supplier master e… | outsourcing_orders, outsourcing_order_materials, outsourcing_receipts, outsourcing_material_movements, outsourcing_order_events | — | 7 | 4 | 4 | RLS on all 5; 5 policies |
| 24 | `20261013090500_production_reporting.sql` | 2026-10-13 09:05 | Production / BOM / outsourcing | production overview, reports, costing and batch traceability All figures come from production / outsourcing documents and the Phase 4 ledger. | — | — | 5 | 0 | 0 | — |
| 25 | `20261014090000_customer_po_permissions.sql` | 2026-10-14 09:00 | Customers / customer POs | customer purchase order (PO) permissions The brief's "purchase_orders.*" codes describe CUSTOMER purchase orders. | — | — | 0 | 0 | 0 | — |
| 26 | `20261014090100_customer_po_inventory_extensions.sql` | 2026-10-14 09:01 | Customers / customer POs | inventory extensions for customer PO allocation Allocations ARE inventory reservations (public.stock_reservations) with reference_type = 'CUSTOMER_… | — | inventory_transactions | 6 | 0 | 0 | — |
| 27 | `20261014090200_customers.sql` | 2026-10-14 09:02 | Customers / customer POs | basic customer master + verified customer product codes No customer master existed (the Phase 1 Customers page was a placeholder). | customers, customer_product_codes | — | 2 | 3 | 0 | RLS on all 2; 4 policies |
| 28 | `20261014090300_customer_purchase_orders.sql` | 2026-10-14 09:03 | Customers / customer POs | customer purchase orders — import, product matching, stock availability, allocation (reservations), dispatch, revisions and shortages. | customer_po_import_batches, customer_purchase_orders, customer_purchase_order_lines, customer_po_events, customer_po_allocation_runs, customer_po_analysis_snapshots, customer_po_shortage_notes |  | 35 | 7 | 3 | RLS on all 7; 7 policies |
| 29 | `20261014090400_customer_po_dashboard.sql` | 2026-10-14 09:04 | Customers / customer POs | customer PO dashboard Aggregation rules (shown to users): * Only current revisions count; superseded revisions are history. | — | — | 2 | 0 | 0 | — |
| 30 | `20261015090000_sales_fulfilment_permissions.sql` | 2026-10-15 09:00 | Sales orders / dispatch / returns | sales order and fulfilment permissions Permission codes are resource.action (one dot), so the brief's three-part codes map as follows: sales_orders… | — | — | 0 | 0 | 0 | — |
| 31 | `20261015090100_sales_inventory_extensions.sql` | 2026-10-15 09:01 | Sales orders / dispatch / returns | inventory extensions for sales order fulfilment and customer returns No new stock tables. | — | inventory_locations, inventory_transactions | 5 | 1 | 0 | — |
| 32 | `20261015090200_sales_orders.sql` | 2026-10-15 09:02 | Sales orders / dispatch / returns | sales orders and fulfilment records sales_orders order header; customer name / addresses are snapshots sales_order_lines product, quantities and th… | sales_orders, sales_order_lines, fulfilments, fulfilment_lines, delivery_events, sales_order_events |  | 36 | 10 | 3 | RLS on all 6; 6 policies |
| 33 | `20261015090300_fulfilment.sql` | 2026-10-15 09:03 | Sales orders / dispatch / returns | warehouse picking, packing, dispatch and delivery tracking PENDING -> PICKING -> PICKED -> PACKING -> PACKED -> READY_FOR_DISPATCH -> DISPATCHED ->… | — | — | 9 | 0 | 2 | — |
| 34 | `20261015090400_customer_returns.sql` | 2026-10-15 09:04 | Sales orders / dispatch / returns | customer returns REQUESTED -> AUTHORIZED -> RECEIVED -> (UNDER_INSPECTION) -> ACCEPTED / REJECTED -> CLOSED REQUESTED -> REJECTED (not authorised) … | customer_returns, customer_return_lines |  | 7 | 2 | 2 | RLS on all 2; 2 policies |
| 35 | `20261015090500_sales_reporting.sql` | 2026-10-15 09:05 | Sales orders / dispatch / returns | sales overview and fulfilment reports (real records only) Order quantities and PO prices are operational data, never revenue (no accounting in this… | — | — | 2 | 0 | 0 | — |
| 36 | `20261016090000_billing_permissions.sql` | 2026-10-16 09:00 | Invoicing / payments | billing, invoicing and receivables permissions Reused (Phase 2): invoices.read, invoices.create (create / edit drafts), invoices.approve (approve d… | — | — | 0 | 0 | 0 | — |
| 37 | `20261016090100_billing_masters.sql` | 2026-10-16 09:01 | Invoicing / payments | billing master data customers (extended) billing identity used by invoices: legal name, GSTIN, registration type, addresses, state codes, payment t… | invoice_settings, billing_number_sequences, billing_events | customers | 10 | 1 | 0 | RLS on all 3; 2 policies |
| 38 | `20261016090200_sales_invoices.sql` | 2026-10-16 09:02 | Invoicing / payments | sales invoices sales_invoices header + immutable snapshots (seller, customer, place of supply, totals) sales_invoice_lines product lines (from actu… | sales_invoices, sales_invoice_lines, sales_invoice_dispatch_allocations |  | 14 | 5 | 1 | RLS on all 3; 3 policies |
| 39 | `20261016090300_customer_payments.sql` | 2026-10-16 09:03 | Invoicing / payments | customer payment receipts and allocations customer_payments receipts as recorded by a user (not proof of bank settlement; no bank integration exist… | customer_payments, invoice_payment_allocations |  | 9 | 2 | 2 | RLS on all 2; 2 policies |
| 40 | `20261016090400_adjustment_notes.sql` | 2026-10-16 09:04 | Invoicing / payments | credit notes, debit notes, invoice balances and statements invoice_adjustment_notes credit / debit notes against an issued invoice invoice_adjustme… | invoice_adjustment_notes, invoice_adjustment_note_lines |  | 9 | 3 | 2 | RLS on all 2; 2 policies |
| 41 | `20261016090500_billing_reporting.sql` | 2026-10-16 09:05 | Invoicing / payments | billing overview, receivables / ageing and billing reports Management reports from issued records only (drafts, discarded and - unless stated - can… | — | — | 4 | 0 | 0 | — |
| 42 | `20261017090000_executive_analytics.sql` | 2026-10-17 09:00 | Analytics | executive dashboard & business analytics (read-only) Every function below only READS the operational tables of Phases 3-8. No analytics copy of ord… | — | — | 20 | 0 | 0 | — |
| 43 | `20261018090000_admin_permissions.sql` | 2026-10-18 09:00 | Admin: notifications, docs, imports | administration & productivity permissions Reused (Phase 2): users.manage (user activity, session revocation), settings.manage (ERP settings), audit… | — | — | 3 | 2 | 0 | — |
| 44 | `20261018090100_notifications.sql` | 2026-10-18 09:01 | Admin: notifications, docs, imports | in-app notifications, notification preferences, error log Notifications are private to their recipient (RLS). | notifications, notification_preferences, notification_sync_state, error_events | — | 10 | 0 | 0 | RLS on all 4; 3 policies |
| 45 | `20261018090200_approval_engine.sql` | 2026-10-18 09:02 | Admin: notifications, docs, imports | configurable approval workflow engine Model: an approval GATES an existing action; it never performs it. | approval_workflows, approval_workflow_stages, approval_requests, approval_decisions | — | 20 | 3 | 0 | RLS on all 4; 4 policies |
| 46 | `20261018090300_documents.sql` | 2026-10-18 09:03 | Admin: notifications, docs, imports | Document Center (attachments on existing records) Files live in the PRIVATE storage bucket `documents` under <company_id>/<document_id>/v<version>-… | documents, document_versions | — | 14 | 0 | 1 | RLS on all 2; 2 policies; bucket documents |
| 47 | `20261018090400_import_jobs.sql` | 2026-10-18 09:04 | Admin: notifications, docs, imports | import history for Bulk Operations The existing import paths keep their own validation and commit logic: products -> Phase 3 client validation + RL… | import_jobs, import_job_rows | — | 5 | 3 | 0 | RLS on all 2; 2 policies |
| 48 | `20261018090500_admin_tools.sql` | 2026-10-18 09:05 | Admin: notifications, docs, imports | barcode / QR lookup and assignment, user activity and sessions, system health, and audit-trail coverage of the module event histories. | — | — | 12 | 1 | 0 | — |
| 49 | `20261019090000_readiness_indexes.sql` | 2026-10-19 09:00 | Performance (indexes, RLS) | supporting indexes for foreign keys on common query paths. | — | — | 0 | 0 | 0 | — |
| 50 | `20261019090100_rls_policy_performance.sql` | 2026-10-19 09:01 | Performance (indexes, RLS) | equivalent, faster SELECT policies on the high-volume tables. | — | — | 0 | 0 | 0 | 8 policies changed |
| 51 | `20261020090000_amazon_core.sql` | 2026-10-20 09:00 | Amazon (optional) | Amazon Sales & Profit Intelligence: core model, permissions, ingestion Reuses: products (mapping, standard cost, GST rate), inventory_balances (ERP… | amazon_settings, amazon_connections, amazon_listings, amazon_sync_jobs, amazon_sync_errors, amazon_sku_daily, amazon_inventory_snapshots, amazon_campaigns +5 |  | 15 | 2 | 0 | RLS on all 13; 13 policies |
| 52 | `20261020090100_amazon_analytics.sql` | 2026-10-20 09:01 | Amazon (optional) | Amazon analytics (read-only, amazon.read) One component function, private.amazon_sku_day, assembles every money and quantity component per seller S… | — | — | 8 | 0 | 0 | — |
| 53 | `20261020090200_amazon_actions.sql` | 2026-10-20 09:02 | Amazon (optional) | Amazon: recommendations, budget plans, approval-based ad changes, demo data Ad changes: READ-ONLY by default (automation_mode = READ_ONLY, kill swi… | amazon_recommendations, amazon_budget_plans, amazon_ad_change_requests |  | 13 | 0 | 0 | RLS on all 3; 3 policies |
| 54 | `20261021090000_suppliers.sql` | 2026-10-21 09:00 | Suppliers | Supplier master No supplier table existed: the Suppliers page was a placeholder, and outsourcing orders, stock lots and products each reserved a su… | suppliers | products | 4 | 3 | 0 | RLS on all 1; 3 policies |
| 55 | `20261022090000_purchase_order_permissions.sql` | 2026-10-22 09:00 | Purchase orders / GRN | Supplier purchase orders and goods receipts: permissions Reused (equivalent meaning, not duplicated): purchases.read -> view supplier purchase orde… | — | — | 0 | 0 | 0 | — |
| 56 | `20261022090100_purchase_orders.sql` | 2026-10-22 09:01 | Purchase orders / GRN | Supplier purchase orders and goods receipts No purchase order, goods receipt or payables tables existed (the Supplier Purchase Orders page was a la… | purchase_orders, purchase_order_lines, purchase_order_events, purchase_order_amendments, goods_receipts, goods_receipt_lines | inventory_transactions | 20 | 7 | 4 | RLS on all 6; 6 policies |
| 57 | `20261023090000_purchase_order_import.sql` | 2026-10-23 09:00 | Purchase orders / GRN | Supplier purchase orders: Excel / CSV import ADDITIVE. Imported orders are created ONLY through the existing public.purchase_order_save() as DRAFT … | purchase_order_import_refs | import_jobs | 6 | 1 | 0 | RLS on all 1; 1 policies |
| 58 | `20261029090000_whole_piece_quantities.sql` | 2026-10-29 09:00 | Inventory (whole pieces) | Whole-piece (PCS) quantities Root cause this fixes: a BOM stores "quantity_required per output_quantity units". Planning divided the two and rounde… | — | — | 13 | 2 | 0 | — |
| 59 | `20261030090000_erp_reset.sql` | 2026-10-30 09:00 | ERP data reset | ERP data reset ("factory reset" of one company's business data) What it does Deletes the business and operational records of the caller's company f… | erp_reset_runs | — | 15 | 1 | 0 | RLS on all 1; 1 policies |
| 60 | `20261031090000_erp_force_reset.sql` | 2026-10-31 09:00 | ERP data reset | Force reset ("delete everything") of one company's business data The standard reset (20261030090000_erp_reset.sql) stops when protected history exi… | erp_reset_backup_attestations, private.erp_force_reset_approvals, private.erp_force_reset_tickets, private.erp_force_purge_sessions | erp_reset_runs | 36 | 1 | 0 | RLS on all 4; 1 policies |
| 61 | `20261101090000_single_operator_mode.sql` | 2026-11-01 09:00 | V2 Step 0: single operator | Step 0: single-operator mode V2 is run by one person, so nothing waits for a second approver: 1. Segregation of duties is OFF unless a company swit… | — | — | 8 | 0 | 0 | — |
| 62 | `20261102090000_product_master_v2.sql` | 2026-11-02 09:00 | V2 Stage 1: Product Master & BOM | Stage 1: Product Master and BOM Extends the existing tables (nothing is dropped, reset or re-keyed): products * three more product types: SUBASSEMB… | — | products, bom_items, import_jobs | 15 | 2 | 1 | — |
| 63 | `20261103090000_unified_ledger.sql` | 2026-11-03 09:00 | V2 Stage 2: Ledger | Stage 2: Unified Ledger / Party Master Customers and suppliers stay in their existing tables (every sales order, invoice, payment, purchase order a… | parties, supplier_payments | customers | 20 | 4 | 0 | RLS on all 2; 2 policies |
| 64 | `20261104090000_purchasing_grn_v2.sql` | 2026-11-04 09:00 | V2 Stage 3: PO & GRN | Stage 3: Purchase Orders and Goods Received Notes Builds on the existing purchase order and goods receipt module (no new order or receipt tables): … | — | goods_receipts, goods_receipt_lines, documents | 12 | 1 | 2 | — |
| 65 | `20261105090000_production_v2.sql` | 2026-11-05 09:00 | V2 Stage 4: Production | Stage 4: simple production management A one-screen production flow on top of the existing Phase 5 tables (production_orders, production_order_mater… | — | import_jobs | 19 | 0 | 0 | — |
| 66 | `20261106090000_sales_orders_v2.sql` | 2026-11-06 09:00 | V2 Stage 5: Sales orders & reservations | Stage 5: sales orders with automatic reservations Built on the Phase 7 sales tables (sales_orders, sales_order_lines, fulfilments, fulfilment_lines… | — | sales_orders, sales_order_lines, production_orders, import_jobs | 31 | 0 | 3 | — |
| 67 | `20261107090000_invoicing_v2.sql` | 2026-11-07 09:00 | V2 Stage 6: Invoicing & payments | Stage 6: invoicing, GST, payments and Excel import Built on the Phase 8 billing module (sales_invoices, sales_invoice_lines, customer_payments, inv… | — | sales_invoices, sales_invoice_lines, invoice_settings, import_jobs | 19 | 0 | 1 | — |
| 68 | `20261108090000_management_v2.sql` | 2026-11-08 09:00 | V2 Stage 7: dashboards, settings, reports, reconciliation | Stage 7: management overview, module dashboards, ERP settings, global search, activity centre, reconciliation and the reporting centre. | — | companies, purchase_orders, goods_receipts | 20 | 0 | 0 | — |

### 3.1 Where each requested area lives

| Area | Tables (created in) | Extended / redefined in |
|---|---|---|
| Product Master | `products`, `product_categories` (`20261011090000`); images bucket (`20261011090100`) | `20261029090000`, `20261102090000` (Stage 1), `20261108090000` (SKU prefixes) |
| BOM | `boms`, `bom_items` (`20261013090200`) | `20261029090000`, `20261102090000` |
| Ledger | `customers` (`20261014090200`), `suppliers` (`20261021090000`), `parties`, `supplier_payments` (`20261103090000`) | `20261016090100`, `20261104090000` |
| Purchase Orders | `purchase_orders`, `purchase_order_lines`, `purchase_order_events` … (`20261022090100`), import (`20261023090000`) | `20261104090000` (Stage 3), `20261108090000` (number prefix) |
| GRN | `goods_receipts`, `goods_receipt_lines` (`20261022090100`) | `20261104090000` (direct GRN, corrections, views) |
| Inventory | `warehouses`, `inventory_locations` (`20261012090100`), `inventory_batches`, `inventory_balances`, `inventory_transactions` (`20261012090200`), documents and counts (`20261012090400`) | `20261013090100`, `20261014090100`, `20261015090100`, `20261029090000` |
| Production | `production_orders`, `production_order_materials`, `production_material_consumption`, `production_output_receipts`, `production_order_events` (`20261013090300`), outsourcing (`20261013090400`) | `20261105090000` (Stage 4) |
| Sales Orders | `sales_orders`, `sales_order_lines`, `sales_order_events` … (`20261015090200`) | `20261106090000` (Stage 5) |
| Stock Reservations | `stock_reservations` (`20261012090300`) | `20261013090100`, `20261014090100`, `20261015090100`, `20261106090000` |
| Dispatch | `fulfilments`, `fulfilment_lines` (`20261015090200`), dispatch functions (`20261015090300`), returns (`20261015090400`) | `20261106090000` |
| Invoicing | `invoice_settings`, `billing_number_sequences`, `billing_events` (`20261016090100`), `sales_invoices`, lines, dispatch allocations (`20261016090200`), notes (`20261016090400`) | `20261107090000` (Stage 6) |
| Payments | `customer_payments`, `invoice_payment_allocations` (`20261016090300`), `supplier_payments` (`20261103090000`) | `20261107090000` |
| Management Dashboard | functions only | `20261017090000` (analytics), `20261108090000` (`management_overview`, `module_dashboard`) |
| ERP Settings | `companies`, `company_settings` (`20261010090100`) | `20261108090000` (profile columns, `erp_settings_get/save`, `erp_preferences`) |
| Reports | functions only | `20261012090500`, `20261013090500`, `20261015090500`, `20261016090500`, `20261108090000` (`erp_report`) |
| Reconciliation | functions only | `20261012090500` (stock), `20261108090000` (`erp_reconciliation`) |

---

## 4. Task 3 — Dependency check

### 4.1 Results

| Check | Result |
|---|---|
| Applies in timestamp order on an empty database | **pass** (68/68, then again for idempotency) |
| Duplicate migration files / timestamps | **none** |
| Duplicate tables (created twice) | **none** — every `CREATE TABLE` uses `IF NOT EXISTS` and each table is created in exactly one migration |
| Conflicting functions | **none** — 54 functions and 9 views are deliberately redefined by later migrations (listed in 4.3); there are no ambiguous overloads in `public` |
| References to tables created later | 4, all inside PL/pgSQL bodies or comments (resolved at run time): `product_master → suppliers`, `inventory_locations → inventory_balances`, `sales_invoices → invoice_payment_allocations / invoice_adjustment_notes`, `customer_payments → invoice_adjustment_notes` — **safe** |
| Missing tables | **none** (every referenced table exists after the run; 2,568 checks exercise them) |
| Missing extensions | **none** required. `pg_cron` is only *checked* by System Health (shown as "not configured") |
| PostgreSQL-18-only syntax (local engine) vs Supabase 17 | **none found** (no `uuidv7`, `casefold`, `array_sort`, `RETURNING OLD/NEW`, temporal keys) |
| Missing RLS | **none** — RLS is on for all 103 public tables. 4 internal tables have RLS with no policy and no grants (deny-all by design): `billing_number_sequences`, `inventory_number_sequences`, `inventory_requests`, `notification_sync_state` |
| Missing grants | **none** found by the test suites; client writes are limited to column-level grants on 10 tables and `company_settings` / `user_roles` (all behind RLS) |
| Missing indexes | **advisory**: 138 of 251 foreign keys have no index starting with the same columns. These are mostly composite `(id, company_id)` keys whose single-column index exists. They are performance-only, and Supabase's Performance Advisor will list them (H4) |
| Encoding | 2 comment lines in `20261102090000_product_master_v2.sql` contain mis-encoded "—" / "…"; comments only, no effect |
| Destructive statements | No `DROP TABLE`, `DROP COLUMN` or `TRUNCATE` on data. `DELETE` appears only inside functions: replacing draft lines, and the ERP reset functions (Super Admin + password + confirmation) |

**No migration file was modified by this audit.**

### 4.2 Dependencies on earlier migrations (tables used that were first created in)

| # | Migration | Uses objects first created in |
|---|---|---|
| 1 | `20261010090000_foundation.sql` | foundation only (schema `private`, auth / storage provided by Supabase) |
| 2 | `20261010090100_companies.sql` | foundation only (schema `private`, auth / storage provided by Supabase) |
| 3 | `20261010090200_profiles.sql` | 20261010090100 |
| 4 | `20261010090300_rbac.sql` | 20261010090100, 20261010090200 |
| 5 | `20261010090400_audit_logs.sql` | 20261010090100 |
| 6 | `20261010090500_authorization_functions.sql` | 20261010090100, 20261010090200, 20261010090300, 20261010090400 |
| 7 | `20261010090600_rls_policies.sql` | 20261010090100, 20261010090200, 20261010090300, 20261010090400 |
| 8 | `20261010090700_guards_and_audit_triggers.sql` | 20261010090100, 20261010090200, 20261010090300 |
| 9 | `20261010090800_seed_rbac.sql` | 20261010090300 |
| 10 | `20261010090900_seed_company_and_bootstrap.sql` | 20261010090100, 20261010090200, 20261010090300 |
| 11 | `20261011090000_product_master.sql` | 20261010090100, 20261010090200, 20261010090300 |
| 12 | `20261011090100_product_images_storage.sql` | 20261011090000 |
| 13 | `20261012090000_inventory_permissions.sql` | 20261010090300 |
| 14 | `20261012090100_inventory_locations.sql` | 20261010090100 |
| 15 | `20261012090200_inventory_ledger.sql` | 20261010090100, 20261011090000, 20261012090100 |
| 16 | `20261012090300_inventory_operations.sql` | 20261010090100, 20261011090000, 20261012090100, 20261012090200 |
| 17 | `20261012090400_inventory_documents.sql` | 20261010090100, 20261011090000, 20261012090100, 20261012090200 |
| 18 | `20261012090500_inventory_reporting_alerts.sql` | 20261010090100, 20261011090000, 20261012090100, 20261012090200, 20261012090300, 20261012090400 |
| 19 | `20261013090000_production_permissions.sql` | 20261010090300 |
| 20 | `20261013090100_production_inventory_extensions.sql` | 20261011090000, 20261012090100, 20261012090200, 20261012090300, 20261012090400, 20261012090500 |
| 21 | `20261013090200_production_boms.sql` | 20261010090100, 20261011090000, 20261012090100, 20261012090200 |
| 22 | `20261013090300_production_orders.sql` | 20261010090100, 20261011090000, 20261012090100, 20261012090200, 20261012090300, 20261013090200 |
| 23 | `20261013090400_outsourcing.sql` | 20261010090100, 20261011090000, 20261012090100, 20261012090200, 20261013090200 |
| 24 | `20261013090500_production_reporting.sql` | 20261011090000, 20261012090100, 20261012090200, 20261013090200, 20261013090300, 20261013090400 |
| 25 | `20261014090000_customer_po_permissions.sql` | 20261010090300 |
| 26 | `20261014090100_customer_po_inventory_extensions.sql` | 20261012090100, 20261012090200, 20261012090300 |
| 27 | `20261014090200_customers.sql` | 20261010090100, 20261011090000 |
| 28 | `20261014090300_customer_purchase_orders.sql` | 20261010090100, 20261010090200, 20261010090300, 20261011090000, 20261012090100, 20261012090200, 20261012090300, 20261013090200, 20261014090200 |
| 29 | `20261014090400_customer_po_dashboard.sql` | 20261011090000, 20261014090300 |
| 30 | `20261015090000_sales_fulfilment_permissions.sql` | 20261010090300 |
| 31 | `20261015090100_sales_inventory_extensions.sql` | 20261010090100, 20261012090100, 20261012090200, 20261012090300 |
| 32 | `20261015090200_sales_orders.sql` | 20261010090100, 20261011090000, 20261012090100, 20261012090200, 20261012090300, 20261014090200, 20261014090300 |
| 33 | `20261015090300_fulfilment.sql` | 20261010090100, 20261011090000, 20261012090100, 20261012090200, 20261012090300, 20261014090300, 20261015090200 |
| 34 | `20261015090400_customer_returns.sql` | 20261010090100, 20261011090000, 20261012090100, 20261012090200, 20261014090200, 20261015090200 |
| 35 | `20261015090500_sales_reporting.sql` | 20261011090000, 20261012090100, 20261012090200, 20261012090300, 20261015090200, 20261015090400 |
| 36 | `20261016090000_billing_permissions.sql` | 20261010090300 |
| 37 | `20261016090100_billing_masters.sql` | 20261010090100, 20261014090200 |
| 38 | `20261016090200_sales_invoices.sql` | 20261010090100, 20261011090000, 20261014090200, 20261015090200, 20261015090400, 20261016090100 |
| 39 | `20261016090300_customer_payments.sql` | 20261010090100, 20261014090200, 20261016090100, 20261016090200 |
| 40 | `20261016090400_adjustment_notes.sql` | 20261010090100, 20261014090200, 20261015090400, 20261016090100, 20261016090200, 20261016090300 |
| 41 | `20261016090500_billing_reporting.sql` | 20261010090100, 20261014090200, 20261016090200, 20261016090300, 20261016090400 |
| 42 | `20261017090000_executive_analytics.sql` | 20261010090100, 20261011090000, 20261012090100, 20261012090200, 20261012090300, 20261012090400, 20261013090300, 20261013090400, 20261014090200, 20261014090300, 20261015090200, 20261015090400, 20261016090100, 20261016090200, 20261016090300, 20261016090400 |
| 43 | `20261018090000_admin_permissions.sql` | 20261010090200, 20261010090300 |
| 44 | `20261018090100_notifications.sql` | 20261010090100, 20261010090200, 20261010090300 |
| 45 | `20261018090200_approval_engine.sql` | 20261010090100, 20261010090200, 20261010090300, 20261012090400, 20261013090200, 20261013090300, 20261013090400, 20261015090200, 20261016090200, 20261016090300, 20261016090400 |
| 46 | `20261018090300_documents.sql` | 20261010090100, 20261011090000, 20261012090100, 20261012090200, 20261013090300, 20261013090400, 20261014090200, 20261014090300, 20261015090200, 20261016090200, 20261016090400 |
| 47 | `20261018090400_import_jobs.sql` | 20261010090100, 20261012090400, 20261014090300, 20261018090100 |
| 48 | `20261018090500_admin_tools.sql` | 20261010090100, 20261010090200, 20261010090300, 20261010090400, 20261011090000, 20261012090100, 20261012090200, 20261012090400, 20261013090300, 20261013090400, 20261014090300, 20261015090200, 20261016090100, 20261016090200, 20261016090300, 20261016090400, 20261018090100, 20261018090200, 20261018090300, 20261018090400 |
| 49 | `20261019090000_readiness_indexes.sql` | 20261012090200, 20261012090300, 20261012090400, 20261013090300, 20261013090400, 20261014090200, 20261014090300, 20261015090200, 20261015090400, 20261016090200, 20261016090400, 20261018090200 |
| 50 | `20261019090100_rls_policy_performance.sql` | 20261010090400, 20261011090000, 20261012090100, 20261012090200, 20261012090300 |
| 51 | `20261020090000_amazon_core.sql` | 20261010090100, 20261010090300, 20261011090000 |
| 52 | `20261020090100_amazon_analytics.sql` | 20261011090000, 20261012090100, 20261012090200, 20261013090300, 20261020090000 |
| 53 | `20261020090200_amazon_actions.sql` | 20261010090100, 20261020090000 |
| 54 | `20261021090000_suppliers.sql` | 20261010090100, 20261010090200, 20261010090400, 20261011090000 |
| 55 | `20261022090000_purchase_order_permissions.sql` | 20261010090300 |
| 56 | `20261022090100_purchase_orders.sql` | 20261010090100, 20261010090200, 20261011090000, 20261012090100, 20261012090200, 20261012090400, 20261013090200, 20261013090300, 20261013090400, 20261016090200, 20261016090400, 20261018090200, 20261021090000 |
| 57 | `20261023090000_purchase_order_import.sql` | 20261010090100, 20261011090000, 20261012090100, 20261018090400, 20261021090000, 20261022090100 |
| 58 | `20261029090000_whole_piece_quantities.sql` | 20261011090000, 20261012090100, 20261012090200, 20261012090300, 20261013090200, 20261013090300, 20261013090400, 20261022090100 |
| 59 | `20261030090000_erp_reset.sql` | 20261010090100, 20261010090200, 20261010090300, 20261010090400, 20261011090000, 20261014090300, 20261018090300, 20261021090000 |
| 60 | `20261031090000_erp_force_reset.sql` | 20261010090100, 20261010090200, 20261010090300, 20261010090400, 20261013090200, 20261016090200, 20261016090400, 20261018090300, 20261030090000 |
| 61 | `20261101090000_single_operator_mode.sql` | 20261010090100, 20261012090400, 20261013090200, 20261013090300, 20261013090400, 20261022090100 |
| 62 | `20261102090000_product_master_v2.sql` | 20261011090000, 20261012090100, 20261012090400, 20261013090200, 20261018090400, 20261021090000 |
| 63 | `20261103090000_unified_ledger.sql` | 20261010090100, 20261010090300, 20261012090100, 20261014090200, 20261014090300, 20261015090200, 20261016090200, 20261016090300, 20261016090400, 20261021090000, 20261022090100 |
| 64 | `20261104090000_purchasing_grn_v2.sql` | 20261010090100, 20261011090000, 20261012090100, 20261012090200, 20261013090300, 20261013090400, 20261014090200, 20261014090300, 20261015090200, 20261016090200, 20261016090300, 20261016090400, 20261018090300, 20261021090000, 20261022090100, 20261103090000 |
| 65 | `20261105090000_production_v2.sql` | 20261011090000, 20261012090100, 20261012090200, 20261012090300, 20261013090200, 20261013090300, 20261018090400 |
| 66 | `20261106090000_sales_orders_v2.sql` | 20261010090100, 20261011090000, 20261012090100, 20261012090200, 20261012090300, 20261013090200, 20261013090300, 20261014090200, 20261014090300, 20261015090200, 20261016090200, 20261018090400, 20261021090000 |
| 67 | `20261107090000_invoicing_v2.sql` | 20261010090100, 20261011090000, 20261014090200, 20261015090200, 20261015090400, 20261016090100, 20261016090200, 20261016090300, 20261016090400, 20261018090400 |
| 68 | `20261108090000_management_v2.sql` | 20261010090100, 20261011090000, 20261012090100, 20261012090200, 20261012090300, 20261013090200, 20261013090300, 20261014090200, 20261015090200, 20261016090100, 20261016090200, 20261016090300, 20261016090400, 20261021090000, 20261022090100, 20261103090000 |

### 4.3 Functions and triggers per migration

Functions redefined later (final definition wins — apply strictly in order): `next_document_number`, `next_product_sku`, `invoice_recalculate`, `invoice_issues`, `dispatch_line_invoiceable`, `billing_settings_update`, `import_permission` (6 versions), `inventory_reverse_transaction` (5), the Stage 1 BOM functions, the Phase 4 reservation RPCs, the reset-guard functions and others — 54 in total.

<details><summary>Full list per migration</summary>

**`20261010090000_foundation.sql`** — 1 functions (0 SECURITY DEFINER), 0 triggers
- private (not exposed by the API): set_updated_at

**`20261010090100_companies.sql`** — 1 functions (0 SECURITY DEFINER), 3 triggers
- private (not exposed by the API): validate_company_timezone
- triggers: companies_validate_timezone, companies_set_updated_at, company_settings_set_updated_at

**`20261010090200_profiles.sql`** — 2 functions (2 SECURITY DEFINER), 3 triggers
- private (not exposed by the API): handle_new_auth_user, sync_auth_user_email
- triggers: profiles_set_updated_at, on_auth_user_created, on_auth_user_email_updated

**`20261010090300_rbac.sql`** — 0 functions (0 SECURITY DEFINER), 1 triggers
- triggers: roles_set_updated_at

**`20261010090400_audit_logs.sql`** — 2 functions (1 SECURITY DEFINER), 2 triggers
- private (not exposed by the API): prevent_audit_log_mutation, write_audit_log
- triggers: audit_logs_append_only, audit_logs_no_truncate

**`20261010090500_authorization_functions.sql`** — 9 functions (8 SECURITY DEFINER), 0 triggers
- public (callable by signed-in users where granted): get_my_access, current_user_has_permission, log_security_event
- private (not exposed by the API): is_active_member, has_permission, has_role, user_has_role, role_code, current_company_id

**`20261010090700_guards_and_audit_triggers.sql`** — 5 functions (4 SECURITY DEFINER), 5 triggers
- private (not exposed by the API): guard_profile_update, audit_profile_change, audit_user_role_change, audit_company_setting_change, audit_company_change
- triggers: profiles_guard_update, profiles_audit, user_roles_audit, company_settings_audit, companies_audit

**`20261010090900_seed_company_and_bootstrap.sql`** — 1 functions (1 SECURITY DEFINER), 0 triggers
- private (not exposed by the API): bootstrap_super_admin

**`20261011090000_product_master.sql`** — 11 functions (6 SECURITY DEFINER), 6 triggers
- public (callable by signed-in users where granted): product_kpis, product_category_counts, check_product_identifiers, user_display_names, log_product_import
- private (not exposed by the API): product_has_transactions, is_client_role, before_product_category_write, before_product_write, audit_product_change, audit_product_category_change
- triggers: product_categories_before_write, product_categories_set_updated_at, products_before_write, products_set_updated_at, products_audit, product_categories_audit

**`20261011090100_product_images_storage.sql`** — 2 functions (1 SECURITY DEFINER), 0 triggers
- private (not exposed by the API): try_uuid, product_image_company

**`20261012090100_inventory_locations.sql`** — 12 functions (12 SECURITY DEFINER), 7 triggers
- private (not exposed by the API): require_permission, inventory_policy, company_tz, company_today, company_day_start, next_document_number, idempotency_begin, idempotency_finish, before_warehouse_write, after_warehouse_insert, before_location_write, audit_storage_change
- triggers: warehouses_before_write, warehouses_set_updated_at, warehouses_after_insert, warehouses_audit, inventory_locations_before_write, inventory_locations_set_updated_at, inventory_locations_audit

**`20261012090200_inventory_ledger.sql`** — 6 functions (5 SECURITY DEFINER), 3 triggers
- private (not exposed by the API): prevent_ledger_mutation, ensure_batch, lot_average_cost, post_movement, product_has_transactions, guard_product_inventory
- triggers: inventory_transactions_append_only, inventory_transactions_no_truncate, products_guard_inventory

**`20261012090300_inventory_operations.sql`** — 11 functions (11 SECURITY DEFINER), 0 triggers
- public (callable by signed-in users where granted): inventory_post_receipt, inventory_post_issue, inventory_transfer_stock, inventory_reverse_transaction, inventory_create_reservation, inventory_release_reservation, inventory_fulfil_reservation, inventory_expire_reservations
- private (not exposed by the API): resolve_outflow_lot, require_active_product, release_reservation_remaining

**`20261012090400_inventory_documents.sql`** — 15 functions (15 SECURITY DEFINER), 0 triggers
- public (callable by signed-in users where granted): inventory_submit_opening_stock, inventory_review_opening_stock, inventory_cancel_opening_stock, inventory_create_adjustment, inventory_update_adjustment_status, inventory_review_adjustment, inventory_create_count, inventory_record_count, inventory_add_count_line, inventory_submit_count, inventory_review_count, inventory_cancel_count
- private (not exposed by the API): assert_not_self_approval, effective_timestamp, count_location_ids

**`20261012090500_inventory_reporting_alerts.sql`** — 9 functions (8 SECURITY DEFINER), 0 triggers
- public (callable by signed-in users where granted): inventory_overview, inventory_movement_trend, inventory_stock_as_of, inventory_valuation, inventory_reconcile, inventory_policy_info, inventory_find_product_by_code, inventory_refresh_alerts, inventory_acknowledge_alert

**`20261013090100_production_inventory_extensions.sql`** — 10 functions (10 SECURITY DEFINER), 0 triggers
- public (callable by signed-in users where granted): inventory_reverse_transaction, inventory_create_reservation, inventory_release_reservation, inventory_fulfil_reservation, inventory_overview, inventory_refresh_alerts
- private (not exposed by the API): before_location_write, post_movement, lot_average_cost, reverse_ledger_transaction

**`20261013090200_production_boms.sql`** — 13 functions (12 SECURITY DEFINER), 3 triggers
- public (callable by signed-in users where granted): production_save_bom, production_new_bom_version, production_bom_action, production_bom_requirements
- private (not exposed by the API): require_any_permission, production_policy, ceil_qty, guard_bom_write, guard_bom_item_write, bom_creates_cycle, validate_bom, storage_stock, bom_requirement_lines
- triggers: boms_guard, boms_set_updated_at, bom_items_guard

**`20261013090300_production_orders.sql`** — 15 functions (14 SECURITY DEFINER), 4 triggers
- public (callable by signed-in users where granted): production_save_order, production_order_action, production_reserve_materials, production_release_reservations, production_issue_materials, production_reverse_consumption, production_receive_output, production_reverse_output, production_order_requirements
- private (not exposed by the API): guard_posted_document, prevent_history_mutation, log_production_event, order_open_reserved, release_order_reservations, production_discrepancies
- triggers: production_consumption_guard, production_output_guard, production_events_append_only, production_orders_set_updated_at

**`20261013090400_outsourcing.sql`** — 7 functions (7 SECURITY DEFINER), 4 triggers
- public (callable by signed-in users where granted): outsourcing_save_order, outsourcing_order_action, outsourcing_move_materials, outsourcing_receive_goods, outsourcing_reverse_receipt
- private (not exposed by the API): log_outsourcing_event, outsourcing_discrepancies
- triggers: outsourcing_receipts_guard, outsourcing_movements_guard, outsourcing_events_append_only, outsourcing_orders_set_updated_at

**`20261013090500_production_reporting.sql`** — 5 functions (5 SECURITY DEFINER), 0 triggers
- public (callable by signed-in users where granted): production_overview, production_report, production_trace_batch
- private (not exposed by the API): production_material_outlook, production_cost_rows

**`20261014090100_customer_po_inventory_extensions.sql`** — 6 functions (5 SECURITY DEFINER), 0 triggers
- public (callable by signed-in users where granted): inventory_create_reservation, inventory_release_reservation, inventory_fulfil_reservation, inventory_reverse_transaction
- private (not exposed by the API): reservation_owned_by_module, reserve_balance

**`20261014090200_customers.sql`** — 2 functions (2 SECURITY DEFINER), 3 triggers
- private (not exposed by the API): before_customer_write, audit_customer_change
- triggers: customers_before_write, customers_set_updated_at, customers_audit

**`20261014090300_customer_purchase_orders.sql`** — 35 functions (32 SECURITY DEFINER), 7 triggers
- public (callable by signed-in users where granted): customer_po_preview, customer_po_import, customer_po_line_action, customer_po_rematch, customer_po_analysis, customer_po_line_stock, customer_po_propose, customer_po_allocate, customer_po_save_plan, customer_po_release, customer_po_dispatch, customer_po_reverse_dispatch, customer_po_action, customer_po_update_header, customer_po_refresh_analysis, customer_po_revision_diff, customer_po_shortages, customer_po_update_shortage, customer_po_assignable_users
- private (not exposed by the API): po_customer_key, po_norm_code, log_po_event, po_line_open_reserved, po_match_codes, po_apply_product, po_auto_match_line, po_flag_duplicates, po_recompute_status, po_eligible_stock, po_line_analysis, po_availability_summary, po_plan, po_validate_lines, po_find_existing, po_resolve_customer
- triggers: customer_po_events_append_only, customer_po_runs_append_only, customer_po_snapshots_append_only, customer_po_notes_append_only, customer_po_batches_append_only, customer_pos_set_updated_at, customer_po_lines_set_updated_at

**`20261014090400_customer_po_dashboard.sql`** — 2 functions (2 SECURITY DEFINER), 0 triggers
- public (callable by signed-in users where granted): customer_po_dashboard, customer_po_customer_options

**`20261015090100_sales_inventory_extensions.sql`** — 5 functions (4 SECURITY DEFINER), 1 triggers
- public (callable by signed-in users where granted): inventory_reverse_transaction, fulfilment_policy
- private (not exposed by the API): guard_return_location, reservation_owned_by_module, fulfilment_policy
- triggers: inventory_transactions_guard_return

**`20261015090200_sales_orders.sql`** — 36 functions (33 SECURITY DEFINER), 10 triggers
- public (callable by signed-in users where granted): sales_order_po_candidates, sales_order_po_preview, sales_order_create_from_po, sales_order_create_manual, sales_order_confirm, sales_order_update, sales_order_action, sales_order_allocate, sales_order_release, sales_order_line_update, sales_order_cancel_preview, sales_order_cancel
- private (not exposed by the API): so_line_open_reserved, so_line_planned, reservation_planned, po_line_converted, po_line_so_dispatched, po_active_sales_orders, po_line_open_reserved, so_line_available_now, so_today, release_reservation_qty, log_so_event, so_recompute, so_assert_workable, guard_po_reservation, guard_po_dispatch, guard_po_line_change, guard_po_change, so_header_value, so_header_date, so_check_warehouse, po_conversion_lines, po_conversion_blockers, so_take_po_reservations, so_confirm
- triggers: sales_order_events_append_only, delivery_events_append_only, sales_orders_set_updated_at, sales_order_lines_set_updated_at, fulfilments_set_updated_at, fulfilment_lines_set_updated_at, stock_reservations_guard_po, inventory_transactions_guard_po, customer_po_lines_guard_so, customer_pos_guard_so

**`20261015090300_fulfilment.sql`** — 9 functions (8 SECURITY DEFINER), 0 triggers
- public (callable by signed-in users where granted): fulfilment_create, fulfilment_pick, fulfilment_pack, fulfilment_action, fulfilment_dispatch, fulfilment_record_delivery
- private (not exposed by the API): reservation_problem, lock_fulfilment, fulfilment_status_label

**`20261015090400_customer_returns.sql`** — 7 functions (7 SECURITY DEFINER), 2 triggers
- public (callable by signed-in users where granted): customer_return_create, customer_return_review, customer_return_receive, customer_return_inspect, customer_return_post_disposition
- private (not exposed by the API): return_committed, lock_return
- triggers: customer_returns_set_updated_at, customer_return_lines_set_updated_at

**`20261015090500_sales_reporting.sql`** — 2 functions (2 SECURITY DEFINER), 0 triggers
- public (callable by signed-in users where granted): sales_overview, fulfilment_report

**`20261016090100_billing_masters.sql`** — 10 functions (6 SECURITY DEFINER), 1 triggers
- public (callable by signed-in users where granted): gst_state_codes, billing_settings_get, billing_settings_update
- private (not exposed by the API): before_customer_write, gst_state_name, billing_settings, financial_year, format_billing_number, next_billing_number, log_billing_event
- triggers: billing_events_append_only

**`20261016090200_sales_invoices.sql`** — 14 functions (14 SECURITY DEFINER), 5 triggers
- public (callable by signed-in users where granted): sales_invoice_create_draft, sales_invoice_update_draft, sales_invoice_validate, sales_invoice_action, sales_invoice_issue
- private (not exposed by the API): guard_invoice_change, guard_invoice_line_change, dispatch_line_invoiced, dispatch_line_invoiceable, invoice_refresh_snapshots, invoice_recalculate, invoice_issues, lock_invoice, invoice_apply_header
- triggers: sales_invoices_set_updated_at, sales_invoice_lines_set_updated_at, sales_invoices_guard, sales_invoice_lines_guard, invoice_dispatch_alloc_guard

**`20261016090300_customer_payments.sql`** — 9 functions (9 SECURITY DEFINER), 2 triggers
- public (callable by signed-in users where granted): customer_payment_record, customer_payment_allocate, payment_allocation_reverse, customer_payment_reverse
- private (not exposed by the API): guard_payment_change, invoice_paid, payment_allocated, invoice_balance, allocate_payment
- triggers: customer_payments_guard, invoice_payment_alloc_guard

**`20261016090400_adjustment_notes.sql`** — 9 functions (9 SECURITY DEFINER), 3 triggers
- public (callable by signed-in users where granted): adjustment_note_create, adjustment_note_action, adjustment_note_issue, adjustment_note_validate, billing_customer_statement
- private (not exposed by the API): guard_note_change, invoice_line_noted, note_issues, note_recalculate
- triggers: adjustment_notes_set_updated_at, adjustment_notes_guard, adjustment_note_lines_guard

**`20261016090500_billing_reporting.sql`** — 4 functions (4 SECURITY DEFINER), 0 triggers
- public (callable by signed-in users where granted): billing_receivables, billing_overview, billing_report
- private (not exposed by the API): invoice_position_as_of

**`20261017090000_executive_analytics.sql`** — 20 functions (18 SECURITY DEFINER), 0 triggers
- public (callable by signed-in users where granted): analytics_context, analytics_executive, analytics_sales, analytics_inventory, analytics_production, analytics_fulfilment, analytics_shortages, analytics_finance, analytics_alerts, analytics_data_quality
- private (not exposed by the API): po_eligible_stock, analytics_check_period, analytics_na, analytics_open_demand, analytics_eligible, analytics_sales_kpis, analytics_billing_kpis, analytics_inventory_kpis, analytics_valuation, analytics_production_kpis

**`20261018090000_admin_permissions.sql`** — 3 functions (3 SECURITY DEFINER), 2 triggers
- private (not exposed by the API): other_active_super_admins, guard_last_super_admin_profile, guard_last_super_admin_role
- triggers: profiles_guard_last_super_admin, user_roles_guard_last_super_admin

**`20261018090100_notifications.sql`** — 10 functions (7 SECURITY DEFINER), 0 triggers
- public (callable by signed-in users where granted): notifications_mark_read, notifications_dismiss, notification_preference_set, notifications_sync, log_client_error
- private (not exposed by the API): notification_mandatory, notify, notify_permission, redact, redact_context

**`20261018090200_approval_engine.sql`** — 20 functions (17 SECURITY DEFINER), 3 triggers
- public (callable by signed-in users where granted): approval_workflow_save, approval_workflow_set_active, approval_request_submit, approval_decide, approval_request_cancel, approval_document_status, approval_inbox
- private (not exposed by the API): prevent_approval_decision_mutation, approval_read_permission, approval_submit_permission, approval_document, approval_workflow_for, approval_snapshot, approval_stage_users, approval_notify_stage, approval_create_request, approval_gate, approval_document_trigger, approval_deferred_insert, approval_escalate
- triggers: approval_decisions_append_only, approval_track_sales_order, approval_track_opening_stock

**`20261018090300_documents.sql`** — 14 functions (12 SECURITY DEFINER), 0 triggers
- public (callable by signed-in users where granted): document_upload_rules, document_upload_prepare, document_upload_complete, document_upload_abort, document_download, document_archive, document_entity_search
- private (not exposed by the API): document_entity, document_entity_permission, document_readable, document_object_readable, document_object_writable, document_rules, document_mime_for

**`20261018090400_import_jobs.sql`** — 5 functions (3 SECURITY DEFINER), 3 triggers
- public (callable by signed-in users where granted): import_job_record
- private (not exposed by the API): prevent_import_history_mutation, import_permission, import_job_write, import_job_from_po_batch
- triggers: import_jobs_append_only, import_job_rows_append_only, customer_po_import_batches_history

**`20261018090500_admin_tools.sql`** — 12 functions (11 SECURITY DEFINER), 1 triggers
- public (callable by signed-in users where granted): barcode_lookup, product_assign_barcode, user_activity_list, user_activity_detail, admin_revoke_sessions, system_health_check, audit_log_filters, approval_document_search, analytics_context
- private (not exposed by the API): audit_action_part, audit_mirror_event, audit_mirror_inventory_tx
- triggers: audit_mirror

**`20261020090000_amazon_core.sql`** — 15 functions (12 SECURITY DEFINER), 2 triggers
- public (callable by signed-in users where granted): amazon_import_rows, amazon_service_job_start, amazon_service_ingest, amazon_service_job_update, amazon_service_log_error, amazon_service_connection_update, amazon_listing_save, amazon_listing_auto_map, amazon_settings_update
- private (not exposed by the API): amazon_can, amazon_company_defaults, amazon_listings_guard, amazon_num, amazon_date, amazon_ingest
- triggers: companies_amazon_defaults, amazon_listings_guard

**`20261020090100_amazon_analytics.sql`** — 8 functions (7 SECURITY DEFINER), 0 triggers
- public (callable by signed-in users where granted): amazon_product_performance, amazon_daily_series, amazon_campaign_performance, amazon_campaign_detail, amazon_search_terms, amazon_data_status
- private (not exposed by the API): amazon_sku_day, amazon_check_range

**`20261020090200_amazon_actions.sql`** — 13 functions (12 SECURITY DEFINER), 0 triggers
- public (callable by signed-in users where granted): amazon_recommendations_save, amazon_recommendation_set_status, amazon_budget_plan_save, amazon_ad_change_request, amazon_ad_change_decide, amazon_ad_change_cancel, amazon_service_change_claim, amazon_service_change_result, amazon_demo_load, amazon_demo_clear
- private (not exposed by the API): amazon_change_problem, amazon_current_value, amazon_rand

**`20261021090000_suppliers.sql`** — 4 functions (4 SECURITY DEFINER), 3 triggers
- public (callable by signed-in users where granted): supplier_activity
- private (not exposed by the API): before_supplier_write, audit_supplier_change, require_active_supplier
- triggers: suppliers_before_write, suppliers_set_updated_at, suppliers_audit

**`20261022090100_purchase_orders.sql`** — 20 functions (16 SECURITY DEFINER), 7 triggers
- public (callable by signed-in users where granted): inventory_reverse_transaction, purchase_order_save, purchase_order_action, purchase_receipt_post, purchase_receipt_reverse, purchase_order_validate, purchase_supplier_options, purchase_order_dashboard, approval_inbox
- private (not exposed by the API): purchase_policy, purchase_json_num, purchase_json_uuid, purchase_json_date, purchase_text, log_purchase_event, po_line_receipts, po_refresh_snapshots, po_recalculate, po_issues, po_receipt_status
- triggers: purchase_orders_set_updated_at, purchase_order_lines_set_updated_at, purchase_order_events_append_only, purchase_order_amendments_append_only, goods_receipts_guard, goods_receipt_lines_immutable, audit_mirror

**`20261023090000_purchase_order_import.sql`** — 6 functions (3 SECURITY DEFINER), 1 triggers
- public (callable by signed-in users where granted): purchase_order_import_preview, purchase_order_import
- private (not exposed by the API): import_permission, po_import_resolve, po_import_error, po_import_check_input
- triggers: purchase_order_import_refs_append_only

**`20261029090000_whole_piece_quantities.sql`** — 13 functions (10 SECURITY DEFINER), 2 triggers
- public (callable by signed-in users where granted): production_bom_requirements, production_reserve_materials, whole_unit_quantity_audit
- private (not exposed by the API): whole_unit_codes, is_whole_unit, plan_qty, bom_requirement_lines, material_standard_for_output, production_discrepancies, guard_whole_quantities, guard_whole_ledger_quantity, guard_bom_whole_quantities, whole_unit_findings
- triggers: inventory_transactions_whole_pieces, boms_whole_pieces

**`20261030090000_erp_reset.sql`** — 15 functions (11 SECURITY DEFINER), 1 triggers
- public (callable by signed-in users where granted): erp_reset_preview, erp_reset_record_attempt, erp_reset_attempt_allowed, erp_reset_execute, erp_reset_verify
- private (not exposed by the API): erp_reset_tables, erp_reset_kept_tables, erp_reset_document_entity_types, erp_reset_guard_reason, erp_reset_guarded_tables, erp_reset_schema_fingerprint, erp_reset_counts, erp_reset_actor_ok, erp_reset_kept_supplier_count, erp_reset_plan
- triggers: erp_reset_runs_append_only

**`20261031090000_erp_force_reset.sql`** — 36 functions (26 SECURITY DEFINER), 1 triggers
- public (callable by signed-in users where granted): erp_force_reset_preview, erp_force_reset_record_backup, erp_force_reset_issue_ticket, erp_force_reset_execute, erp_force_reset_record_failure, erp_force_reset_record_storage_cleanup, erp_force_reset_verify
- private (not exposed by the API): erp_reset_tables, erp_reset_kept_tables, erp_force_reset_tables, erp_force_reset_retained_tables, erp_force_reset_row_filter, erp_force_reset_self_fk_clause, erp_force_reset_order, erp_force_reset_guarded_tables, erp_force_purge_allows, prevent_ledger_mutation, prevent_history_mutation, prevent_import_history_mutation, prevent_approval_decision_mutation, guard_posted_document, guard_bom_write, guard_bom_item_write, guard_invoice_change, guard_invoice_line_change, guard_payment_change, guard_note_change, erp_force_reset_counts, erp_force_reset_storage_objects, erp_force_reset_active_approval, erp_force_reset_valid_backup, erp_force_reset_super_admins, erp_force_reset_plan, erp_force_reset_approve, erp_force_reset_revoke_approval, erp_force_reset_run_result
- triggers: erp_reset_backup_attestations_append_only

**`20261101090000_single_operator_mode.sql`** — 8 functions (1 SECURITY DEFINER), 0 triggers
- public (callable by signed-in users where granted): purchase_order_open, production_bom_activate, production_order_release, outsourcing_order_release, inventory_post_adjustment, inventory_post_opening_stock, inventory_post_count
- private (not exposed by the API): inventory_policy

**`20261102090000_product_master_v2.sql`** — 15 functions (8 SECURITY DEFINER), 2 triggers
- public (callable by signed-in users where granted): product_sku_preview, production_save_bom, production_new_bom_version, production_bom_activate, product_kpis, import_job_record
- private (not exposed by the API): product_sku_prefix, product_default_source, next_product_sku, product_fill_defaults, default_bom_source, bom_output_type_ok, validate_bom, sync_product_has_bom, import_permission
- triggers: products_a_fill_defaults, boms_sync_product_has_bom

**`20261103090000_unified_ledger.sql`** — 20 functions (15 SECURITY DEFINER), 4 triggers
- public (callable by signed-in users where granted): ledger_parties, party_find_duplicates, party_save, party_set_status, party_link, party_transactions, supplier_payment_record, supplier_payment_reverse, ledger_sync_parties
- private (not exposed by the API): before_customer_write, party_name_key, phone_key, next_party_code, party_for_new_role, guard_supplier_payment, customer_receivable, grn_line_value, supplier_payable, erp_reset_tables, erp_reset_guard_reason
- triggers: parties_set_updated_at, customers_party, suppliers_party, supplier_payments_guard

**`20261104090000_purchasing_grn_v2.sql`** — 12 functions (10 SECURITY DEFINER), 1 triggers
- public (callable by signed-in users where granted): goods_receipt_direct_post, goods_receipt_reverse, goods_receipt_correct, purchase_order_update_details, document_entity_search, party_transactions
- private (not exposed by the API): goods_receipt_value, supplier_payable, goods_receipts_set_corrects, document_entity, document_entity_permission, erp_reset_document_entity_types
- triggers: goods_receipts_set_corrects

**`20261105090000_production_v2.sql`** — 19 functions (17 SECURITY DEFINER), 0 triggers
- public (callable by signed-in users where granted): production_v2_preview, production_order_v2_save, production_order_v2_complete, production_order_v2_correct, production_order_v2_requirements, production_bom_add_components, production_dashboard, production_import_preview, production_import
- private (not exposed by the API): import_permission, production_v2_active_bom, production_v2_default_location, production_v2_snapshot, production_v2_requirements, production_v2_shortage_warnings, production_v2_open_and_reserve, production_v2_post, production_v2_require_complete, production_import_check

**`20261106090000_sales_orders_v2.sql`** — 31 functions (27 SECURITY DEFINER), 0 triggers
- public (callable by signed-in users where granted): sales_order_v2_save, sales_order_v2_reserve, sales_order_v2_release, sales_order_v2_summary, sales_order_v2_create_production, sales_order_v2_dispatch, sales_order_v2_reverse_dispatch, sales_order_v2_cancel, sales_orders_v2_list, sales_dashboard, sales_order_import_preview, sales_order_import
- private (not exposed by the API): reservation_owned_by_module, import_permission, so_v2_tax_treatment, so_v2_price, so_v2_line_production_open, so_v2_material_reserved, so_v2_material_warehouse, so_v2_to_produce, so_v2_reserve_line, so_v2_reserve, so_v2_release_materials, so_v2_lines, so_v2_shortages, so_v2_status, so_v2_fulfilment_invoiced, so_v2_summary, so_v2_warnings, so_v2_num, so_import_check

**`20261107090000_invoicing_v2.sql`** — 19 functions (17 SECURITY DEFINER), 0 triggers
- public (callable by signed-in users where granted): sales_invoice_v2_save, sales_order_invoice_lines, sales_invoice_v2_issue, invoice_v2_record_payment, invoice_v2_apply_advance, adjustment_note_v2_issue, billing_settings_update, invoice_dashboard, invoice_import_preview, invoice_import
- private (not exposed by the API): import_permission, so_line_invoiced, so_line_invoiceable, dispatch_line_invoiceable, invoice_recalculate, invoice_issues, inv_num, invoice_v2_issue_core, invoice_import_check

**`20261108090000_management_v2.sql`** — 20 functions (18 SECURITY DEFINER), 0 triggers
- public (callable by signed-in users where granted): erp_preferences, erp_settings_get, erp_settings_save, management_overview, module_dashboard, global_search, activity_feed, erp_reconciliation, erp_report
- private (not exposed by the API): erp_setting_defaults, erp_settings_of, erp_setting, next_document_number, next_product_sku, units_json, party_balances, stock_lots, safe_section, management_alerts, mo_inventory
</details>

---

## 5. Task 4 — Security audit

| Area | Finding | Status |
|---|---|---|
| RLS on required tables | all 103 public tables | ✅ |
| Company isolation | every business table has `company_id`; policies use `private.has_permission(company_id, …)` / `private.current_company_id()` / `auth.uid()`. The two policies without a direct company filter (`approval_decisions_select`, `import_job_rows_select`) check their parent row, which is itself company-scoped. Isolation is tested by every suite (company A vs B) | ✅ |
| Anonymous access | `anon` has **no** table, view or function privileges in `public`; `private` is revoked from `anon` and `public` | ✅ |
| Authenticated writes | no direct `INSERT/UPDATE/DELETE` on business tables except column-level grants (products, product categories, customers, suppliers, warehouses, locations, companies, profiles, `company_settings`, `user_roles`) — all behind RLS + guard triggers. Every other change goes through permission-checked functions | ✅ |
| SECURITY DEFINER | 496 functions, **all** with `SET search_path` (no search-path hijack) | ✅ |
| Views | all 33 are `security_invoker = true` (RLS of the caller applies) | ✅ |
| Exposed schemas | `config.toml`: `public`, `graphql_public` only; `private` (307 helpers, 3 reset tables) is not exposed. 40 private helpers are executable by `authenticated` but only reachable through public functions | ✅ |
| Storage | both buckets private; policies only for `authenticated` and scoped by company path / document permission; signed URLs for downloads | ✅ |
| Service role | used only server-side in 3 Edge Functions (`invite-user`, `reset-erp-data`, `force-reset-erp-data`) and the Amazon functions; the browser client refuses a service-role key | ✅ |
| Secrets in code / repo | none; `.env.local` absent; templates contain placeholders only | ✅ |
| Bootstrap | `private.bootstrap_super_admin` is not executable by any API role; runs once from the SQL editor; refuses if a Super Admin exists | ✅ |
| Public sign-up | on by default in new projects; harmless (inactive profile, no company) but should be **turned off** | ⚠ H1 |
| Password policy | local config minimum 6 | ⚠ H2 |
| Destructive features | ERP reset / force reset exist (Super Admin, password re-entry, typed confirmation, audited). Deploying their Edge Functions is optional | ⚠ H8 |
| Audit trail | append-only `audit_logs` + module event tables; guards stop update/delete of posted history | ✅ |

RLS was not disabled or weakened anywhere.

---

## 6. Task 5 — Backend readiness report

1. **Total migration files:** 68.
2. **Execution order:** filename order, `20261010090000_foundation.sql` → `20261108090000_management_v2.sql` (section 3). All must be applied; later ones redefine earlier functions.
3. **Tables required:** 103 in `public` + 3 in `private` (all created by the migrations; none to create by hand). Plus 33 views.
4. **Functions required:** 271 public (the app's API) + 307 private helpers; 144 triggers + 2 on `auth.users`.
5. **Storage buckets:** `product-images`, `documents` (both private, created by migrations).
6. **Environment variables:** section 2.3 — frontend `VITE_SUPABASE_URL` + `VITE_SUPABASE_PUBLISHABLE_KEY`; Edge secrets `ALLOWED_ORIGINS` (+ `INVITE_REDIRECT_URL`); Amazon secrets only if used.
7. **Authentication configuration:** section 2.5.
8. **RLS and security status:** section 5 — ready; two recommended Auth settings.
9. **Deployment blockers:** section 8 — no code blockers; four first-run risks to watch, and the set-up steps below.
10. **Exact commands:** section 9.

### Seeded by the migrations

1 company (`ALTON`, Alton Hi-Tech Sanitary Ware Pvt. Ltd.; GSTIN, address and state left empty on purpose), 8 roles, 129 permissions, 448 role-permission grants, 9 suggested product categories. No users, products or transactions.

---

## 7. What must be done by a person (cannot be scripted from the repo)

1. Create the **new** Supabase project (region near India, e.g. Mumbai `ap-south-1`; Postgres 17). Keep the database password safe.
2. Copy its project ref, URL and publishable key. **Double-check the ref is the new project, not the old Alton ERP.**
3. Set the Auth settings in section 2.5.
4. After the migrations: create the owner user (Authentication → Users → Add user) and run the bootstrap SQL (section 9, step 8).
5. In the app: ERP Settings → Company — enter the GSTIN, registered address and state. Invoices are blocked until these are set.

---

## 8. Blockers, risks and proposed corrections

### Blockers

None in the code. The application cannot connect until steps 1–4 of section 7 are done.

### Risks to verify on the first real run (the local engine imitates Supabase's `auth` and `storage` schemas)

| # | Risk | Where | How to check / proposed correction |
|---|---|---|---|
| R1 | Creating policies on `storage.objects` from a migration. On hosted Supabase the `storage` tables belong to `supabase_storage_admin`; migrations run as `postgres`, which normally can create these policies. If a project refuses, `db push` stops at `20261011090100` or `20261018090300` | storage policies | Run `db push --dry-run`, then push. If it fails with "must be owner", create the same 6 policies in Dashboard → Storage → Policies using the SQL in those two files, and mark the migration as applied with `supabase migration repair --status applied <version>`. **Do not edit the file** |
| R2 | Triggers on `auth.users` (`on_auth_user_created`, `on_auth_user_email_updated`) | `20261010090200` | Supported pattern on Supabase; after the push, add a test user and confirm a row appears in `public.profiles` |
| R3 | `delete from auth.sessions` (revoke sessions in User Activity) | `20261018090500` | After deployment, use "Revoke sessions" on a test user; if permission is denied, only that one admin action is affected |
| R4 | Local tests run on PostgreSQL 18, Supabase on 17 | all | No 18-only syntax found. Safest: push to a **staging/branch project first** (the repository already has `docs/STAGING_SETUP.md` and `npm run verify:supabase`) |

### Hardening recommendations (not blockers)

| # | Recommendation |
|---|---|
| H1 | Turn off public sign-ups; invite users from the app (`invite-user`) |
| H2 | Minimum password length 10+, leaked-password protection (Pro) |
| H3 | Configure custom SMTP before inviting users |
| H4 | Add covering indexes for the 138 un-indexed foreign keys **as a new, additive migration** (proposal only — not written) |
| H5 | Extend `scripts/verify-supabase.mjs` with the V2 Stage 1–7 functions. It currently checks the Phase 1–11 objects only. Proposal: a read-only call each to `management_overview`, `erp_settings_get`, `erp_report`, `erp_reconciliation`, `global_search` |
| H6 | `supabase/config.toml` uses `project_id = "alton-erp"`, the same as the original project's local stack. Rename to `alton-erp-v2` to avoid local Docker volume clashes. Also do **not** run `supabase config push`, which would push `enable_signup = true` and minimum password 6 to the hosted project |
| H7 | `src/types/database.ts` is hand-written; do not overwrite it with `supabase gen types` without review |
| H8 | Deploy `reset-erp-data` / `force-reset-erp-data` only if the reset tools are wanted on production |
| H9 | Amazon tables are created regardless (empty, RLS on); deploy the Amazon functions and secrets only if used |
| H10 | Rollback: only 3 migrations have down scripts (`supabase/rollback/`). For a brand-new project the rollback plan is to delete and recreate the project; enable backups / PITR before real data is entered |

---

## 9. Deployment commands (to run only after explicit approval)

Windows PowerShell, from `C:\Users\Admin\ALTON-ERP-V2`. The CLI is not installed; `npx` downloads it on demand.

```powershell
# 0. Final local proof (no network)
npm run build; npm run lint; npm run test:unit; npm run test:db

# 1. CLI and login (opens the browser)
npx supabase@latest --version
npx supabase@latest login

# 2. Link to the NEW project only (prompts for its database password)
npx supabase@latest link --project-ref <NEW_PROJECT_REF>

# 3. Review: must list exactly the 68 migrations as pending on an empty project
npx supabase@latest migration list
npx supabase@latest db push --dry-run

# 4. Apply (the step that changes the new database)
npx supabase@latest db push

# 5. Confirm all 68 are recorded as applied
npx supabase@latest migration list

# 6. Edge Function secrets and deployment (app origin = where the ERP is hosted)
npx supabase@latest secrets set ALLOWED_ORIGINS=https://<app-domain> INVITE_REDIRECT_URL=https://<app-domain>/reset-password
npx supabase@latest functions deploy invite-user
#   optional: npx supabase@latest functions deploy reset-erp-data
#   optional: npx supabase@latest functions deploy force-reset-erp-data

# 7. Frontend configuration (public values only), then build
#    create .env.local with:
#      VITE_SUPABASE_URL=https://<NEW_PROJECT_REF>.supabase.co
#      VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
npm run build
```

```sql
-- 8. First Super Admin (Dashboard → SQL Editor, after creating the user in Authentication → Users)
select private.bootstrap_super_admin('<owner e-mail>', 'ALTON');

-- 9. Post-deployment check (expected values from this audit)
select
  (select count(*) from pg_tables where schemaname = 'public')                                   as public_tables,    -- 103
  (select count(*) from pg_views  where schemaname = 'public')                                   as public_views,     -- 33
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public')                                                                  as public_functions, -- 271
  (select count(*) from pg_policies where schemaname = 'public')                                 as public_policies,  -- 121
  (select count(*) from pg_policies where schemaname = 'storage'
     and policyname like any (array['product_images_%', 'documents_objects_%']))                  as storage_policies, -- 6
  (select count(*) from storage.buckets where id in ('product-images', 'documents') and not public) as private_buckets, -- 2
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity)                     as tables_without_rls; -- 0
```

Then: Dashboard → Advisors (Security and Performance), sign in to the app as the owner, and optionally run `npm run verify:supabase` against a staging project.
