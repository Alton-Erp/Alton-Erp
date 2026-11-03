# Supabase setup, authentication & security

Phase 2 of the Alton Hi-Tech Sanitary Ware ERP: Supabase PostgreSQL, Supabase Auth, role-based access control (RBAC) and Row Level Security (RLS).

Steps marked **🖐 Manual** have to be done by a person in the Supabase dashboard or a terminal. Nothing in this repository can do them for you.

---

## 1. Prerequisites

- A Supabase project. Use one project per environment (see §9).
- Node.js 20+ and npm.
- Optional: the Supabase CLI (`npx supabase …`) for migrations, type generation and Edge Functions.

## 2. Environment variables

| Variable | Where | Value |
| --- | --- | --- |
| `VITE_SUPABASE_URL` | frontend | Project URL, e.g. `https://abcd.supabase.co` |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | frontend | Publishable key (`sb_publishable_…`). On older projects, use the **anon public** key, either here or as `VITE_SUPABASE_ANON_KEY`. |
| `INVITE_REDIRECT_URL` | Edge Function secret | `https://<your-app>/reset-password` |
| `AMAZON_*` (see [AMAZON_INTEGRATION.md](AMAZON_INTEGRATION.md#3-edge-functions-and-secrets)) | Edge Function secrets | Amazon SP-API and Ads API credentials for the `amazon-spapi` / `amazon-ads` functions. Never in `.env` files read by Vite |
| `ALLOWED_ORIGINS` | Edge Function secret | Comma-separated app origins, e.g. `https://erp.example.com,http://localhost:5173` |

Every `VITE_*` value is compiled into browser JavaScript, so it must be **public**. The publishable/anon key is designed for this: it grants only what RLS policies allow.

**Never** put any of these in a `VITE_*` variable, `.env.example`, source control or browser storage:
- the service-role key
- a secret key (`sb_secret_…`)
- the database password

The app refuses to start with a service-role or secret key (`src/lib/supabase.ts`). If you ever expose one by mistake, **rotate it** in Supabase.

Where to set the frontend variables:
- **Local development:** copy `.env.example` to `.env.local` (git-ignored) and restart `npm run dev`.
- **Bolt.new:** connect Supabase through Bolt's Supabase integration. It provides `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`, and the app accepts the anon key name. To set variables manually, use the project's environment/secrets settings, never a committed file.
- **Production hosting (Netlify, Vercel, etc.):** the host's build environment variables. Redeploy after changing them, because Vite inlines them at build time.

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are injected into Edge Functions automatically by Supabase. Never copy them into the frontend.

## 3. Apply the database migrations 🖐

The migrations live in `supabase/migrations/` and run in filename order:

| File | Contents |
| --- | --- |
| `…090000_foundation.sql` | `private` schema and the `updated_at` trigger function |
| `…090100_companies.sql` | `companies`, `company_settings`, timezone validation |
| `…090200_profiles.sql` | `profiles`, auto-creation trigger on `auth.users`, email sync |
| `…090300_rbac.sql` | `roles`, `permissions`, `role_permissions`, `user_roles` |
| `…090400_audit_logs.sql` | append-only `audit_logs` |
| `…090500_authorization_functions.sql` | RLS helper functions; `get_my_access`, `current_user_has_permission`, `log_security_event` RPCs |
| `…090600_rls_policies.sql` | RLS enabled on all tables, minimal grants, explicit policies |
| `…090700_guards_and_audit_triggers.sql` | activation guard and audit triggers |
| `…090800_seed_rbac.sql` | roles, permissions and the role matrix |
| `…090900_seed_company_and_bootstrap.sql` | the Alton company row and the one-time Super Admin bootstrap function |
| `20261011090000_product_master.sql` | **Phase 3:** granular product permissions; `product_categories`, `products`; validation, guard and audit triggers; RLS; `product_kpis`, `product_category_counts`, `check_product_identifiers`, `user_display_names`, `log_product_import`; suggested categories for ALTON |
| `20261011090100_product_images_storage.sql` | **Phase 3:** private `product-images` Storage bucket (2 MB, JPEG/PNG/WebP) and its access policies |
| `20261012090000_inventory_permissions.sql` | **Phase 4:** inventory permissions and role grants |
| `20261012090100_inventory_locations.sql` | **Phase 4:** `warehouses`, `inventory_locations` (auto `GENERAL` location), document numbering, idempotency (`inventory_requests`), policy helpers |
| `20261012090200_inventory_ledger.sql` | **Phase 4:** `inventory_batches`, `inventory_balances`, append-only `inventory_transactions`, the posting core `private.post_movement`, product guards |
| `20261012090300_inventory_operations.sql` | **Phase 4:** receipt / issue / transfer / reversal RPCs, `stock_reservations` |
| `20261012090400_inventory_documents.sql` | **Phase 4:** opening stock, adjustments, physical counts (all with approval) |
| `20261012090500_inventory_reporting_alerts.sql` | **Phase 4:** stock views, overview / trend / as-of / valuation / reconciliation RPCs, `inventory_alerts` |
| `20261013090000_production_permissions.sql` | **Phase 5:** production and outsourcing permissions and role grants |
| `20261013090100_production_inventory_extensions.sql` | **Phase 5:** location usage (storage / rejected / external processing), new ledger transaction types, posting core and reversal core updates, guards so production/outsourcing postings and reservations are changed only from their orders |
| `20261013090200_production_boms.sql` | **Phase 5:** `boms`, `bom_items`, BOM RPCs (save, new version, submit/approve/reject/archive), material requirement calculation |
| `20261013090300_production_orders.sql` | **Phase 5:** production orders, material plan, reservation, material issue, output receipts, reversals, order history |
| `20261013090400_outsourcing.sql` | **Phase 5:** outsourcing orders, material dispatch/return, supplier consumption, goods receipts, reversals |
| `20261013090500_production_reporting.sql` | **Phase 5:** production overview, 14 reports, cost summary, batch traceability |
| `20261014090000_customer_po_permissions.sql` | **Phase 6:** `customer_po.*`, `customer_po_shortages.read`, `customer_po_reports.export` and role grants |
| `20261014090100_customer_po_inventory_extensions.sql` | **Phase 6:** `CUSTOMER_PO` ledger document type, shared `private.reserve_balance`, guards so PO reservations and dispatches are changed only from the PO module |
| `20261014090200_customers.sql` | **Phase 6:** `customers` master and verified `customer_product_codes` |
| `20261014090300_customer_purchase_orders.sql` | **Phase 6:** import batches, POs, revisions, lines, matching, availability, allocation runs, reservations, dispatch, shortages, events and all PO RPCs |
| `20261014090400_customer_po_dashboard.sql` | **Phase 6:** PO dashboard and customer filter options |
| `20261015090000_sales_fulfilment_permissions.sql` | **Phase 7:** sales order, fulfilment, delivery, return, reservation-release and report permissions and role grants |
| `20261015090100_sales_inventory_extensions.sql` | **Phase 7:** `QUARANTINE` location usage, `SALES_ORDER` / `CUSTOMER_RETURN` document types, guards for module-owned reservations and returns, dispatch policy |
| `20261015090200_sales_orders.sql` | **Phase 7:** `sales_orders`, `sales_order_lines`, `fulfilments`, `fulfilment_lines`, `delivery_events`, `sales_order_events`; PO conversion, manual orders, confirmation, allocation, release, backorders, cancellation; Phase 6 handover guards |
| `20261015090300_fulfilment.sql` | **Phase 7:** pick lists, picking, packing, dispatch (the stock issue), delivery events |
| `20261015090400_customer_returns.sql` | **Phase 7:** `customer_returns`, `customer_return_lines`; authorise, receive into quarantine, inspect, post dispositions |
| `20261015090500_sales_reporting.sql` | **Phase 7:** sales overview and 14 fulfilment reports |
| `20261016090000_billing_permissions.sql` | **Phase 8:** invoice issue, payment reversal, credit/debit note, billing settings and billing report permissions and role grants |
| `20261016090100_billing_masters.sql` | **Phase 8:** customer billing fields (legal name, GSTIN, registration type, addresses, state codes, payment terms), GST state codes, `invoice_settings`, financial-year numbering, `billing_events` |
| `20261016090200_sales_invoices.sql` | **Phase 8:** `sales_invoices`, `sales_invoice_lines`, `sales_invoice_dispatch_allocations`; drafts from dispatches, GST calculation, validation, approval, issue, cancellation |
| `20261016090300_customer_payments.sql` | **Phase 8:** `customer_payments`, `invoice_payment_allocations`; record, allocate and reverse receipts |
| `20261016090400_adjustment_notes.sql` | **Phase 8:** `invoice_adjustment_notes`, `invoice_adjustment_note_lines`; credit/debit notes, invoice and note list views, customer statement |
| `20261016090500_billing_reporting.sql` | **Phase 8:** receivables / ageing as of a date, billing overview, 12 billing reports |
| `20261017090000_executive_analytics.sql` | **Phase 9:** read-only analytics functions (executive KPIs, sales, inventory, production, PO & fulfilment, shortages, finance, alerts, data quality), 3 indexes, quarantine excluded from allocation eligibility |
| `20261018090000_admin_permissions.sql` | **Phase 10:** 7 new permissions and their role grants; last-active-Super-Admin guards on `profiles` and `user_roles` |
| `20261018090100_notifications.sql` | **Phase 10:** `notifications`, `notification_preferences`, `notification_sync_state`, `error_events`; deduplicated notify, alert sync, client error logging with redaction |
| `20261018090200_approval_engine.sql` | **Phase 10:** `approval_workflows`, `approval_workflow_stages`, `approval_requests`, `approval_decisions`; gate and tracking triggers on 9 document tables; submit / decide / cancel / inbox functions |
| `20261018090300_documents.sql` | **Phase 10:** private `documents` storage bucket and policies; `documents`, `document_versions`; prepare / complete / download / archive functions |
| `20261018090400_import_jobs.sql` | **Phase 10:** `import_jobs`, `import_job_rows` (append-only import history); customer-PO imports recorded automatically |
| `20261018090500_admin_tools.sql` | **Phase 10:** barcode lookup and assignment, user activity, session revocation, system health, audit mirror triggers for module events and stock transactions, audit filters, `reporting.default_period` |
| `20261019090000_readiness_indexes.sql` | **Phase 11:** supporting indexes on foreign keys used by customer, product, location and workflow lookups (additive only) |
| `20261019090100_rls_policy_performance.sql` | **Phase 11:** equivalent, faster SELECT policies on 8 high-volume tables (stock ledger, balances, reservations, products, batches, warehouses, locations, audit log); visibility unchanged, proven by the readiness suite |
| `20261020090000_amazon_core.sql` | **Amazon:** 5 permissions and role grants; `amazon_settings` (read-only + kill switch by default), `amazon_connections`, `amazon_listings` (ERP mapping, unit economics, one-ASIN-one-product guard), sync jobs / errors, daily sales & fees, inventory snapshots, campaigns, ad groups, targets, daily campaign / product / search-term facts; validated idempotent ingest, import, mapping and settings functions; service-role-only functions for the Edge Functions |
| `20261020090100_amazon_analytics.sql` | **Amazon:** read-only analytics (product performance with ex-GST sales and cost sources, daily series, campaigns, campaign detail, search terms, data status) |
| `20261020090200_amazon_actions.sql` | **Amazon:** recommendations, budget plans, ad change requests (request, approval by another user, service-only execution claim / result), demo data load and clear (demo rows only) |
| `20261021090000_suppliers.sql` | **Suppliers:** company-scoped supplier master (RLS on existing `suppliers.read` / `suppliers.manage`, no deletes), automatic `SUP-` codes, GSTIN / code uniqueness per company, audit trigger, `supplier_activity()`, `private.require_active_supplier()` for future supplier POs, and the same-company FK on `products.preferred_supplier_id`. Additive only. Verify with `supabase/tests/suppliers_verification.sql` (60 checks). |
| `20261022090000_purchase_order_permissions.sql` | **Supplier POs:** 9 permissions (`purchase_order.*`, `purchase_receipt.create`, `purchase_exception.approve`) and their role assignments. Additive. |
| `20261022090100_purchase_orders.sql` | **Supplier POs:** purchase orders, lines, events, amendments, goods receipts and receipt lines. Read-only RLS on `purchases.read`. Includes save / workflow / receipt / reversal / dashboard functions and the `PURCHASE_ORDER` ledger document type. `inventory_reverse_transaction` now refuses PO postings, and `approval_inbox` lists POs awaiting approval. Verify with `supabase/tests/purchase_orders_verification.sql` (133 checks). |
| `20261023090000_purchase_order_import.sql` | **Supplier PO import:** `purchase_order_import_refs` (one import per supplier + PO reference), `purchase_order_import_preview()` (validates and dry-runs `purchase_order_save`, rolled back), `purchase_order_import()` (drafts only, each order all-or-nothing, idempotent). Adds `SUPPLIER_PO` to `import_jobs`. Additive. Verify with `supabase/tests/purchase_order_import_verification.sql` (45 checks). |

**Option A: Supabase CLI (recommended)**

```bash
npx supabase login
npx supabase init                       # only if supabase/config.toml does not exist yet
npx supabase link --project-ref <project-ref>
npx supabase db push --dry-run          # review what will run
npx supabase db push
```

**Option B: SQL Editor.** Paste each file into Dashboard → SQL Editor in filename order and run it.

**Option C: Bolt.new.** With Supabase connected, Bolt applies files in `supabase/migrations/`. Confirm in Dashboard → Database → Migrations, or in the Table Editor, that all eight tables exist.

### Applying to an existing project without losing data

- The migrations never drop tables and never delete rows. Tables and indexes use `IF NOT EXISTS`; functions use `CREATE OR REPLACE`; seeds use `ON CONFLICT DO NOTHING`. Only policies and triggers are dropped and re-created by name. Re-applying a migration is safe; this is tested in `npm run test:db`.
- **Check for name clashes first.** Many Supabase starters create their own `public.profiles`. The profiles migration stops with a clear error if it finds a `profiles` table with a different structure. Migrate that table manually instead of dropping it.
- Take a backup (Dashboard → Database → Backups) before running `db push` on a project that holds real data.
- Do not edit a migration that has already been applied. Add a new migration instead.

## 4. Database TypeScript types

`src/types/database.ts` is hand-written to match the migrations. After linking a project, regenerate it:

```bash
npx supabase gen types typescript --project-id <project-ref> --schema public > src/types/database.ts
```

Then run `npm run build` to catch any mismatches.

## 5. Configure Supabase Auth 🖐

In Dashboard → Authentication:

1. **Sign In / Providers → Email:** keep Email enabled.
2. **Turn off "Allow new users to sign up".** The ERP uses administrator-controlled onboarding. Even if sign-up were left on, a new account would get an inactive profile with no company and no roles, and therefore no access. Turning it off stops strangers creating accounts at all.
3. **Confirm email:** keep on.
4. **Password policy:** set a minimum length of 8 or more. The app also enforces 8 when setting a new password.
5. **URL Configuration:**
   - **Site URL:** your production URL, e.g. `https://erp.example.com`.
   - **Redirect URLs:** add `https://erp.example.com/reset-password`, and `http://localhost:5173/reset-password` for development.
6. **SMTP (recommended for production):** configure custom SMTP under Project Settings → Authentication. The built-in email service is heavily rate-limited and meant for testing.

The app uses the **PKCE** flow, so a reset link must be opened in the same browser where it was requested. Invitation links work in any browser.

## 6. Bootstrap the first Super Admin securely 🖐

No sign-up, client request or URL can create a privileged account. The first Super Admin is created by a trusted SQL step:

1. Dashboard → Authentication → Users → **Add user → Create new user**. Enter the administrator's email and a strong password, and tick **Auto Confirm User**.
2. Dashboard → SQL Editor (runs as the database owner):

   ```sql
   select private.bootstrap_super_admin('owner@your-company.com');      -- company code defaults to 'ALTON'
   ```

   This assigns the user to the company, activates them, grants `SUPER_ADMIN` and writes an audit entry. It **refuses to run once the company already has a Super Admin**. It is not callable from the browser: `anon`, `authenticated` and `service_role` have no `EXECUTE` permission on it, and the `private` schema is not exposed through the API.
3. Sign in to the app. Fill in the verified legal details (GSTIN, address, state) in **Company Settings**. These are intentionally empty and must not be guessed.

Further Super Admins are granted in the app by an existing Super Admin.

## 7. Inviting, changing and deactivating users

### Invite (Edge Function) 🖐

Inviting needs the Supabase Admin API, which requires the service-role key, so it runs in the `invite-user` Edge Function. That function re-checks the caller's `users.manage` permission in the database:

```bash
npx supabase functions deploy invite-user
npx supabase secrets set INVITE_REDIRECT_URL=https://erp.example.com/reset-password
npx supabase secrets set ALLOWED_ORIGINS=https://erp.example.com,http://localhost:5173
```

Then use **User Management → Invite User**. The invitee gets an email, opens the link and sets a password on `/reset-password`. If the function is not deployed, the app says so; it never pretends an invitation was sent.

**Without the Edge Function:** in Dashboard → Authentication → Users, use **Invite user**. Then assign the user in the SQL Editor:

```sql
update public.profiles
   set company_id = (select id from public.companies where company_code = 'ALTON'), is_active = true
 where email = 'new.user@your-company.com';

insert into public.user_roles (user_id, company_id, role_id)
select p.id, p.company_id, r.id
  from public.profiles p, public.roles r
 where p.email = 'new.user@your-company.com' and r.code = 'SALES_MANAGER';
```

### Change roles / deactivate (in the app)

**User Management** lists the company's users.
- **Roles** grants or revokes roles.
- **Deactivate** blocks a user.

Both are enforced by RLS and recorded in the audit log. Restrictions:
- Nobody can change their own roles or activation status.
- Only a Super Admin can grant or revoke `SUPER_ADMIN`, or deactivate a Super Admin.

Deactivation takes effect on the user's next database request: every policy checks `profiles.is_active`. Their sign-in token stays technically valid until it expires (about an hour), but it no longer grants any data. To block sign-in completely as well, use **Ban user** in Dashboard → Authentication → Users.

## 8. Testing RLS and authorization

Three levels of verification:

1. **Local, no project needed:** `npm run test:db`.
   This applies all migrations to PGlite (real PostgreSQL in WebAssembly) twice, to prove re-runs are safe. It then runs `supabase/tests/rls_verification.sql` under the real `anon`/`authenticated` roles, with simulated JWTs and two companies. The shim used, `supabase/tests/local_supabase_shim.sql`, also reproduces Supabase's default `GRANT ALL` to the API roles, so the tests prove the explicit revokes work.
2. **On your Supabase project:** paste `supabase/tests/rls_verification.sql` into the SQL Editor and run it.
   It always ends with an **intentional error** like `RLS_VERIFICATION_RESULT passed=95 failed=0`. Raising the error rolls back all test data. The DETAIL lists each check. It uses its own `TESTA`/`TESTB` companies and `@example.invalid` users, so it does not touch real data.
3. **Through the live API with real logins (staging only):**
   - Create the 10 `stg-` test accounts and run `supabase/staging/seed_staging_test_data.sql`.
   - Fill in `.env.staging` (from `.env.staging.example`).
   - Run `npm run verify:supabase`.

   It covers:
   - anonymous denial
   - login, session refresh and sign-out
   - each of the 8 roles
   - viewer write attempts
   - a deactivated account
   - company A/B isolation

   `npm run verify:concurrency` adds the simultaneous-request checks. The full procedure is in [STAGING_SETUP.md](STAGING_SETUP.md). (The Phase 3 variables `VERIFY_VIEWER_EMAIL` / `VERIFY_INACTIVE_EMAIL` are replaced by the `STAGING_*` variables.)

Never disable RLS to make a test pass.

### Phase 3 test suites

- `npm run test:unit` runs the product validation and spreadsheet import rules: real `.xlsx` files parsed with SheetJS, duplicate detection, row numbering and CSV formula escaping.
- `npm run test:db` now also runs the Product Master checks: SKU/barcode uniqueness per company, invalid values, category and company scoping, audit ownership, archive rules, category deactivation, Storage folder policies, and per-role permissions.
- `npm run build:smoke && npm run test:ui` drives the built app in headless Edge/Chrome against a **mock** API. It covers:
  - products: sign-in, list, search, sort, add, view, deactivate, categories, Excel import, CSV export and the read-only view
  - inventory pages
  - production and outsourcing pages (BOM, planning, issue, output, outsourced receipt, reports, traceability, read-only user)
  - customer PO pages (dashboard, rejected file type, CSV upload wizard through confirmed import, manual matching, availability, allocation proposal and commit, other pages, read-only user)
  - sales and fulfilment pages (overview, paged order list, PO conversion with confirmation, order details, barcode picking, dispatch with policy field, delivery event, cancellation, reports, read-only user)

  It checks UI wiring only; security is covered by `test:db`.

### Phase 4 inventory 🖐

**Setup after applying the migrations:**
1. **Inventory → Warehouses & Locations:** create at least one warehouse. Each warehouse automatically gets a `GENERAL` location, and you can add zones, racks, shelves or bins under it. Mark one location as the default. No warehouse is pre-created, because names and addresses must be real.
2. **Settings → Inventory policy:**
   - **Segregation of duties** (default **on**): the person who requests an adjustment, opening-stock batch or count cannot approve it.
   - **Expiry warning days** (default **30**).
3. **Opening stock:** use **Inventory → Opening Stock**, entering it manually or importing Excel/CSV. Submitted batches stay **pending** until a user with `inventory_opening.approve` approves them. Only approval posts stock.
4. **Assign roles:** give users the inventory roles they need. The role matrix is in `20261012090000_inventory_permissions.sql`.

**How stock is stored:**
- **The ledger is the source of truth.** `inventory_transactions` is append-only: updates and deletes are blocked by a trigger, even for the table owner. Corrections are made with reversals or adjustments.
- **Balances are written only by the posting RPCs,** inside the same transaction as the ledger row, under a row lock. They never go negative.
- **Checking consistency:** **Inventory Reports → Ledger reconciliation** (`inventory_reconcile`) compares balances with the ledger. Run it after any manual SQL work.

**Tests:**
- `npm run test:db` runs `supabase/tests/inventory_verification.sql` (132 checks). It covers posting rules, negative-stock and reservation guards, idempotency, transfers, reversals, approvals and SoD, counts, valuation, alerts, RLS and cross-company isolation.
- On your project, paste the same file into the SQL Editor. It ends with `INVENTORY_VERIFICATION_RESULT passed=… failed=…` as an intentional error, so all test data is rolled back.
- **Not covered by these tests:**
  - **Real concurrency** (two sessions posting at once). PGlite is single-session; locking is implemented with `SELECT … FOR UPDATE` but has not been exercised under real parallel load.
  - **Alert e-mail or push delivery.** `inventory_alerts.notified_at` is the hook for a future notification job; nothing sends alerts yet.

### Phase 5 manufacturing & outsourcing 🖐

**Setup after applying the migrations:**
1. **Warehouses & Locations:**
   - For rejected goods, create a location with **Used for = Rejected goods (non-saleable)**.
   - For each job worker or processor that holds company material, create a location with **Used for = Held by outside processor** and enter who holds it.
   - Only storage locations count as available stock. A location's usage cannot change while it holds stock.
2. **Roles:** assign the production and outsourcing roles. The role matrix is in `20261013090000_production_permissions.sql`.
   - `production_exception.approve` allows over-consumption, over-production, over-receipt, completion with discrepancies, and reversal of posted production/outsourcing transactions. Grant it sparingly.
   - Phase 2's `manufacturing.read` is reused as "view production". Phase 2's `manufacturing.manage` is no longer checked; the granular permissions replace it.
3. **BOMs first:** create a BOM for each manufactured product and have a second person approve it. **Segregation of duties** uses the same company setting as inventory (Settings → Inventory policy).
4. **Products' units:** there is no unit-conversion master. A BOM component must be entered in the component's inventory unit. If a product's unit is changed later, planning flags the line as a unit conversion error instead of calculating with it.
5. **Suppliers:** outsourcing orders store the supplier as a controlled name/reference, and `supplier_id` stays empty by constraint. The supplier master (`20261021090000_suppliers.sql`) exists, but outsourcing orders are not linked to it yet.

**How stock moves (all through the Phase 4 ledger):**

| Step | Ledger entries |
| --- | --- |
| Create, approve or start an order; planning | none |
| Reserve materials | `stock_reservations` rows on actual lots, under row locks |
| Issue material | `PRODUCTION_ISSUE` (consumes this order's reservations first) |
| Good output | `PRODUCTION_RECEIPT` into a storage location (source IN_HOUSE) |
| Rejected output | `PRODUCTION_RECEIPT` into a *rejected* location, or recorded only |
| Scrap | recorded only |
| Dispatch to processor | `TRANSFER_OUT` / `TRANSFER_IN` of the same lot to the processor's location (ownership unchanged) |
| Supplier uses material | `SUBCONTRACT_CONSUMPTION` from the processor's location |
| Outsourced goods accepted | `SUBCONTRACT_RECEIPT` (source OUTSOURCED) |

Corrections are reversals made from the order. The generic *Reverse* action on Stock Movements refuses production and outsourcing transactions, so documents and the ledger stay consistent.

**Tests:**
- `npm run test:db` runs `supabase/tests/production_verification.sql` (198 checks). It covers BOM validation and approval, planning, unit mismatch, order transitions, reservations (including competing orders), issue exactly once, atomic failure, partial issue and output, over-limit controls, completion discrepancies, outsourcing dispatch, receipts, rejects, no double counting, traceability, costing, reversals with reconciliation, dashboard totals, RLS, cross-company isolation and retried requests.
- On your project, paste the same file into the SQL Editor. It ends with `PRODUCTION_VERIFICATION_RESULT passed=… failed=…`, and all test data is rolled back.
- **Not covered:** true parallel sessions (PGlite is single-connection). Reservations and issues lock balance rows (`FOR UPDATE`), and competing orders were tested one after another, not concurrently.

### Phase 6 customer purchase orders 🖐

**Setup after applying the migrations:**
1. **Customers:** create customer records under **Master Data → Customers** (needs `customers.manage`; no customers are pre-created). A PO can also be imported against an external customer name, but verified customer product codes can only be remembered for a customer record.
2. **Roles:** the role matrix is in `20261014090000_customer_po_permissions.sql`. In summary:

   | Role | Customer PO permissions |
   | --- | --- |
   | Sales | read, import, match, update, revise, cancel, allocate, release, shortages, export, `customers.read`/`.manage` |
   | Inventory | read, allocate, release, fulfil (dispatch), shortages, export, `customers.read` |
   | Admin | read, cancel, release, shortages, export |
   | Production, Purchase | read, shortages |
   | Accounts | read, export |
   | Management Viewer | read, shortages, `customers.read` |
   | Super Admin | all |

   `customer_po.*` is separate from the supplier-side `purchases.*` permissions. Reversing a PO dispatch needs both `customer_po.fulfil` and `inventory.approve_adjustment`.
3. **Stock:** only storage locations of active warehouses, active and unexpired lots, with a known source (IN_HOUSE / OUTSOURCED) count as available. Confirm the source of `UNKNOWN` lots in Inventory, or they stay excluded.

**Uploaded files are not stored.** The browser parses the file. Only the parsed rows, the file name, the sheet name, row counts, the error summary and a SHA-256 fingerprint are saved, in `customer_po_import_batches`. The fingerprint is used to detect the same file being imported again.

**How stock moves:**

| Step | Ledger / reservation |
| --- | --- |
| Upload, validation, matching, analysis, proposal, draft plan | none |
| Commit allocation | `stock_reservations` rows (`reference_type = 'CUSTOMER_PO'`) on actual lots, under row locks |
| Release | reservation released |
| Dispatch | `ISSUE` with `document_type = 'CUSTOMER_PO'` that consumes the reservation |
| Dispatch reversal | reversal posting; the stock is not re-reserved |

Generic reservation and reversal actions in Inventory refuse customer PO records, so PO documents and the ledger stay consistent.

**Tests:**
- `npm run test:db` runs `supabase/tests/customer_po_verification.sql` (113 checks). It covers import, file and PO duplicate detection, the matching rules (description never matches), ambiguity, unit mismatch, eligibility, source split, warehouse limits, allocation strategies, all-or-nothing vs partial allocation, competing POs, release, dispatch, reversal, revisions, status workflow, shortages, RLS, cross-company isolation and retried requests.
- On your project, paste the same file into the SQL Editor. It ends with `CUSTOMER_PO_VERIFICATION_RESULT passed=… failed=…`, and all test data is rolled back.
- **Not covered:** true parallel sessions. Allocation locks balances in a fixed order (`FOR UPDATE`), but competing POs were tested one after another.

### Phase 7 sales orders and fulfilment 🖐

**Setup after applying the migrations:**
1. **Quarantine location:** under Warehouses & Locations, create at least one location with **Used for = Quarantine (returns awaiting inspection)**. Returns can only be received there. For scrapped returns, a **Rejected goods** location is also needed.
2. **Roles:** the role matrix is in `20261015090000_sales_fulfilment_permissions.sql`. In summary:

   | Role | Phase 7 permissions |
   | --- | --- |
   | Sales | create / confirm / update / cancel orders, fulfilment read, delivery updates, create and approve returns, release reservations, reports read + export |
   | Inventory | fulfilment read, pick, pack, dispatch, delivery updates, create / inspect / receive returns, release reservations, reports read + export |
   | Admin | cancel orders, fulfilment read, approve returns, reports read + export |
   | Production, Management Viewer | fulfilment read, reports read |
   | Accounts | fulfilment read, reports read + export |
   | Super Admin | all |

   Allocating stock to sales order lines reuses `customer_po.allocate`. Phase 2's `sales_orders.read` is reused; `sales_orders.manage` is no longer checked.
3. **Dispatch policy (optional):** to make transport fields mandatory, add a company setting `fulfilment.dispatch_required_fields` with a JSON array, e.g. `["vehicle_number", "lr_number", "eway_bill_number"]`. Allowed names: `carrier_name`, `transport_mode`, `vehicle_number`, `lr_number`, `tracking_number`, `eway_bill_number`. Default: none required.

**How stock moves:**

| Step | Ledger / reservation |
| --- | --- |
| Convert PO → sales order | the PO line's open reservations move to the order line (release + re-reserve of the same lot) |
| Confirm, pick, pack, mark ready | none (picking records who picked what; stock is not moved to a staging location) |
| Dispatch | one `ISSUE` per lot line (`document_type = 'SALES_ORDER'`) consuming the reservation |
| Delivery events | none |
| Return requested / authorised | none |
| Return received | `CUSTOMER_RETURN` into the quarantine location, same lot as dispatched |
| Dispositions posted | restock = transfer to storage; scrap = transfer to rejected location; return to customer = issue; other dispositions stay in quarantine |
| Order cancelled | open pick lists cancelled, this order's remaining reservations released; dispatched goods kept |

Once a PO has a sales order (not cancelled), the PO module can no longer allocate, dispatch, change matched lines, cancel or revise it. Generic reservation, fulfil and reversal actions refuse sales order reservations and dispatches. Any `CUSTOMER_RETURN` posting into a storage location is refused (including the generic Phase 4 receipt type), so returns cannot become sellable without inspection.

**Tests:**
- `npm run test:db` runs `supabase/tests/sales_fulfilment_verification.sql` (183 checks).
- On your project, paste the same file into the SQL Editor. It ends with `SALES_FULFILMENT_VERIFICATION_RESULT passed=… failed=…`, and all test data is rolled back.
- **Not covered:** true parallel sessions. Rows are locked (order, then consignment, then reservation and balance), and competing pick lists and dispatch retries were tested one after another.

### Phase 8 billing, invoicing and receivables 🖐

**Setup after applying the migrations.** Nothing below is filled in automatically; the system never invents GSTINs, HSN codes, tax rates or prices.
1. **Company legal details:** in Settings, enter the company legal name, registered address and **GSTIN**. The seller state for GST is the first two digits of the GSTIN. Without it, invoices stay "tax treatment unresolved" and cannot be issued.
2. **Invoice Settings** (`/billing/settings`, needs `billing_settings.manage`, granted to Admin):
   - GST registration (off = bill of supply without GST);
   - prefixes, padding, financial-year start month. Numbers look like `INV/26-27/0001` and are limited to 16 characters;
   - invoice basis: dispatched or delivered quantity;
   - default payment terms, partial invoicing of a dispatch, line discounts, approval before issue, round-off;
   - optional charge line (its SAC and rate must be entered by you), accepted payment methods, bank details, terms and footer.
3. **Customers:** for each customer, set legal name, GST registration type, GSTIN (for registered/SEZ), billing address and billing **state**, optional shipping address/state, and payment terms. Place of supply is suggested from the GSTIN state (registered), `96` (overseas) or the shipping/billing state.
4. **Products:** HSN code, GST rate and selling price come from the Product Master. Lines without HSN, rate or price block issue until completed (then use "Refresh from masters" on the draft).
5. **Roles** (matrix in `20261016090000_billing_permissions.sql`; Phase 2 already gave Accounts `invoices.*` and `payments.*`):

   | Role | Phase 8 permissions |
   | --- | --- |
   | Accounts | create, approve, issue and cancel invoices; record, allocate and reverse receipts; create and issue credit/debit notes; billing reports read + export |
   | Admin | invoice settings, billing reports read + export |
   | Sales | create draft invoices, read receipts, billing reports read |
   | Inventory | read invoices (status only) |
   | Management Viewer | billing reports read |
   | Super Admin | all |

**How the money is calculated (all in the database):**
- **Line amounts:** taxable value = quantity × price − discount, rounded half-up to 2 decimals per line.
- **Intra-state** (seller state = place of supply): CGST = SGST = round(taxable × rate / 2 / 100, 2).
- **Inter-state, SEZ or overseas (`96`):** IGST = round(taxable × rate / 100, 2).
- **Exempt, zero-rated and non-GST treatments** are only offered when enabled in settings. Each needs a written basis and an authorised tax-review acknowledgement before issue.
- **Invoice total** = taxable + CGST + SGST + IGST + optional round-off. A check constraint enforces it.
- **Balance** = total − issued credit notes + issued debit notes − active allocations. It is always derived and never stored.
- **Invoiceable quantity** = dispatched (or delivered) − returned − quantity already on draft, pending or issued invoices. Lines are locked while it is checked.
- **Stock:** invoices, receipts and notes never post stock movements. Returned goods are handled in Phase 7 Sales Returns.

**Lifecycle:**
- Draft → (pending approval, when required) → issued. Issue assigns the next number atomically and freezes the invoice; issued invoices, lines, allocations and notes cannot be edited or deleted.
- Corrections: credit or debit notes, or cancellation. Cancellation is only allowed with no allocations and no notes, and needs a reason. The number is never reused.
- Drafts are discarded, not deleted; receipts and allocations are reversed with a reason.

**Not implemented (no fake data is shown):**
- No e-invoicing (IRN / signed QR), e-way bill or GST portal integration. Settings shows "Not configured".
- Receipts are recorded by users and marked unverified. There is no bank feed, reconciliation or payment gateway.
- PDFs come from the browser's print dialog ("Save as PDF").
- The Tax Summary pages are management reports, not GST returns. Review them with your accountant before any filing.

**Tests:**
- `npm run test:db` runs `supabase/tests/billing_verification.sql` (124 checks).
- On your project, paste the same file into the SQL Editor. It ends with `BILLING_VERIFICATION_RESULT passed=… failed=…`, and all test data is rolled back.
- **Not covered:** true parallel sessions. Duplicate invoicing, double issue and over-allocation were tested sequentially and with repeated idempotency keys; the row locks were not exercised by simultaneous connections.

### Phase 9 executive dashboard and analytics 🖐

**No new tables, roles or permissions.** Phase 9 adds only read-only `SECURITY DEFINER` functions. Each one takes the caller's company from the session, never from the client, and checks the existing permission for every section it returns:

| Section | Permission (existing) |
| --- | --- |
| Executive dashboard, alert centre | `dashboard.read`. Each section and alert rule also needs its module permission |
| Sales | `sales_orders.read` |
| Billing and receivables | `billing_reports.read`. Receipt lists also need `payments.read` |
| Inventory | `inventory.read`. Stock valuation also needs `inventory_reports.read` |
| Production / outsourcing | `manufacturing.read` / `outsourcing.read` |
| Purchase orders / shortage report | `customer_po.read` / `customer_po_shortages.read` |
| Data quality | `audit_logs.read` (Admin, Super Admin) |
| Exports | Each module's existing export permission (`fulfilment_reports.export`, `billing_reports.export`, `inventory.export`, `production_reports.export`, `customer_po_reports.export`) |

A section the user may not see is returned as `{"available": false, "reason": …}`; it is never filled with zeros.

**Data freshness:**
- Nothing is cached or materialised. Every figure is computed from the operational tables when the page loads or **Refresh** is pressed, and pages show the server time of the last successful refresh.
- If a refresh fails, the page says so. Any figures still shown are labelled as coming from the last successful refresh.

**Alerts:**
- Alerts are evaluated by fixed rules on each request and are not stored, so a refresh cannot duplicate them.
- Each alert has a stable id (`rule:record id`), and each rule lists at most 100 alerts.
- Outsourcing alerts use each order's own `expected_return_date`; there is no separate configurable threshold.

**Definitions:** the header of the migration file documents order, dispatched, invoiced, collections, outstanding and available stock, and the UI shows each card's definition.

**Correction to an earlier phase:**
- `private.po_eligible_stock` now treats `QUARANTINE` locations as ineligible. Previously, quarantined returns could be counted as allocatable, which contradicted the Phase 7 rule.
- All earlier test suites still pass with this change.

**Tests:**
- `npm run test:db` runs `supabase/tests/analytics_verification.sql` (108 checks).
- On your project, paste the same file into the SQL Editor. It ends with `ANALYTICS_VERIFICATION_RESULT passed=… failed=…`, and all test data is rolled back.

### Phase 10 administration and productivity 🖐

**New permissions** (granted in `20261018090000_admin_permissions.sql`):

| Permission | Granted to | Allows |
| --- | --- | --- |
| `approvals.read` | All roles | See approval requests and the inbox (deciding still requires being an approver of the current stage) |
| `approvals.manage` | Super Admin, Admin | Create, edit, activate and deactivate workflows |
| `documents.read` / `documents.upload` | Read: all roles. Upload: operational roles, Admin | Open / upload documents for records the user can already see |
| `documents.manage` | Super Admin, Admin | Archive documents |
| `bulk_operations.read` | Admin, Inventory, Sales | Import history and error reports |
| `system_health.read` | Super Admin, Admin | Health checks and the error log |

Reused permissions: `users.manage` (User Activity), `settings.manage` (ERP Settings), `audit_logs.read` (Audit Log Viewer), `products.read` / `products.update` (barcode lookup / assignment).

**Approval engine:**
- Workflows are **inactive by default**. A document type with no active workflow behaves exactly as in Phases 4–8.
- When a workflow applies, the existing module step (posting an adjustment, issuing an invoice, confirming a sales order, reversing a receipt, …) is blocked by a `BEFORE UPDATE` trigger until a request is **approved**. The trigger then marks the approval as used.
- An approval never performs the action. The user still completes the step in the module, with all of that module's own checks.
- Each request stores the workflow version it started with, and a fingerprint of the document.
- If the document changes after submission, a decision cancels the request instead of approving it. If the document leaves its pending state, open requests are cancelled.
- Decisions are append-only and can't be edited.
- Self-approval is never allowed on financial documents.
- **Escalation** runs when users' apps refresh notifications (every 60 seconds while the app is open). No background job is installed.

**Notifications:**
- Stored in `notifications` and visible only to the recipient (RLS). The pair `(company, recipient, dedup_key)` is unique, so the same event can't notify a user twice.
- Alerts from Phase 9 become notifications at most once every 2 minutes per user.
- The bell polls every 60 seconds. **Supabase Realtime is not used. Email and push are "Not configured"**: nothing leaves the application.
- To add a channel later, deliver from a server-side function (e.g. an Edge Function reading undelivered rows) and keep provider keys in Supabase secrets, never in `company_settings` or the browser.

**Documents:**
- Files go to the private `documents` bucket (25 MB storage cap; the company limit is set in ERP Settings).
- The server chooses the path (`<company>/<document>/v<n>-<random>.<ext>`) and checks extension, MIME type and size. The browser additionally checks the file signature and records a SHA-256 checksum.
- Storage policies allow uploading only to your own reserved, pending version. Downloading is allowed only for available versions of records you can read. There are no update or delete policies.
- Downloads use 60-second signed URLs and every download is audited. A new version never replaces an old one; archiving keeps all files.

**Sessions:**
- *End sessions* (User Activity) deletes the user's rows in `auth.sessions`, so their refresh tokens stop working.
- An access token already issued stays valid until it expires (Supabase default: 1 hour). **Deactivate the user to block access immediately.**
- If the database role may not delete sessions on your project, the page says so and the failure is audited. Use Dashboard → Authentication → Users instead.
- The last active Super Admin cannot be deactivated or lose that role; the database enforces this.

**System health:** every status comes from a check run when the page opens or **Check again** is pressed. There is no continuous monitoring. Integrations that are not set up (email, push, e-invoicing, Realtime, pg_cron) are shown as *Not configured*. Browser errors are logged to `error_events` with a correlation id, after redacting tokens, secrets and e-mail addresses, and are rate-limited per user.

**Barcode / camera scanning:**
- USB and Bluetooth scanners work in every browser, as keyboard input.
- Camera scanning uses the browser's `BarcodeDetector` API. It currently works in Chrome/Edge on Android, ChromeOS and macOS. It does **not** work in Firefox or Safari, or in Chrome/Edge on Windows/Linux, and it needs HTTPS (or localhost) plus camera permission. The page says when it's unavailable; typing the code always works.
- QR labels contain only an internal link (`/scan?c=P-<id>`). Opening one needs a signed-in user with permission for that record.

**Tests:**
- `npm run test:db` runs `supabase/tests/admin_productivity_verification.sql` (133 checks).
- On your project, paste the same file into the SQL Editor. It ends with `ADMIN_VERIFICATION_RESULT passed=… failed=…`, and all test data is rolled back.

### Phase 11 production readiness 🖐

`npm run test:db` also runs `supabase/tests/production_readiness_verification.sql` (137 checks; result tag `READINESS_VERIFICATION_RESULT`). It covers:
- **Catalog security:** RLS on every table, no anonymous access, pinned `search_path` on privileged functions, views run as the caller, private buckets, append-only records.
- **End-to-end business scenario:** product → opening stock → BOM → production → customer PO → sales order → dispatch → invoice → payments → dashboard → audit, for test company RDA.
- **Integrity:** stock-ledger and reservation invariants for every company.
- **Isolation and escalation:** a generic cross-company read and write sweep over every company-scoped table and view, plus privilege-escalation and workflow-bypass attempts.
- **Policy equivalence:** proof that the Phase 11 policy rewrite shows each user exactly the same rows as before.

Release checklist, backups, rollback, live staging scripts (`scripts/verify-supabase.mjs`, `scripts/concurrency-check.mjs`) and the KPI definitions are in [PRODUCTION_READINESS.md](PRODUCTION_READINESS.md).
### Rules for every new table (future phases)

1. Include `company_id uuid not null references public.companies(id)` for company data.
2. Run `alter table … enable row level security;`.
3. `revoke all on table … from anon, authenticated;`, then grant only the operations and **columns** needed.
4. Write separate `select` / `insert` / `update` / `delete` policies using `private.has_permission(company_id, '<module>.<action>')`. Never use `using (true)`.
5. Add audit triggers for security- or finance-relevant changes.
6. Add cases to `supabase/tests/rls_verification.sql`. The suite already fails if any table in `public` has RLS disabled or any policy is unconditional.

## 9. Development and production environments

- Use **separate Supabase projects** for development and production. Each has its own keys, users and data.
- Apply the same migrations to both. Never make schema changes in the dashboard without a migration file.
- Add both environments' URLs to Auth → Redirect URLs, and to the `ALLOWED_ORIGINS` secret of each project's Edge Function.

## 10. Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| "Supabase is not configured" / "Connect the database" | `VITE_SUPABASE_URL` or the key is missing. Set them and restart or redeploy. |
| "A privileged (secret / service-role) key was supplied" | The wrong key is in a `VITE_` variable. Replace it with the publishable/anon key and **rotate** the exposed key. |
| "Incorrect email or password" | Wrong credentials, or the user does not exist. The message is the same in both cases on purpose. |
| "Account setup pending" | The user has no company yet. Bootstrap them (§6) or provision them (§7). |
| "Account profile not found" | The auth user predates the profile trigger. Run the bootstrap/provisioning SQL, which creates the profile. |
| "No role assigned" | The user is active but has no role. Assign one in User Management. |
| "You do not have permission…" (code `42501`) | Working as intended: RLS rejected the action for this role. |
| "Cannot reach the server" | A network problem, a wrong URL, or a paused Supabase project. |
| `PGRST202` / `function get_my_access does not exist` / `relation … does not exist` | Migrations were not applied to this project. Apply them (§3). If they were just applied, reload the API schema cache (Dashboard → API → Reload schema). |
| Reset link says "invalid or expired" | The link expired, was used twice, was opened in a different browser (PKCE), or `/reset-password` is missing from Redirect URLs. |
| "The invitation service is not reachable" | The `invite-user` Edge Function is not deployed (§7). |
| SQL Editor shows `RLS_VERIFICATION_RESULT … failed=N` | Read the DETAIL section for the failing checks. `failed=0` means everything passed; the error itself is intentional. |
