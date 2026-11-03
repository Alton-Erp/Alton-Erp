# Staging setup and validation

How to build a **separate** Supabase staging project for the Alton ERP and validate it before production review. Every step here uses the existing migrations, seed file and scripts.

Never use the production project, production data or real customer or financial data for any of this. Staging validation counts as complete only after **every step below has passed on the real staging project**, and the results are recorded in the sign-off table in [PRODUCTION_READINESS.md](PRODUCTION_READINESS.md#7-final-production-approval-checklist).

What you need:
- **Node.js 20 or later** (the scripts use `node --env-file`) and this repository.
- **A Supabase organisation account with MFA enabled.**
- **One mailbox that supports "+" addressing** (for example `it.team@yourcompany.com`, which also receives `it.team+stg-admin@yourcompany.com`). The password-reset test sends an email there.

Status words used here:
- **PASS:** executed and passed.
- **FAIL:** executed and failed.
- **BLOCKED:** could not run.
- **NOT RUN:** skipped.
- **MANUAL REVIEW REQUIRED:** a person must check it.

Only PASS counts as passed.

---

## Step 1: Create the staging project

1. Supabase Dashboard → **New project**. Name it `alton-erp-staging`, in the same region you plan for production.
2. Store the database password in your password manager. It is not needed by the app or the scripts; never put it in a file in this repository.
3. **Project Settings → API**, note:
   - **Project URL**, which becomes `VITE_SUPABASE_URL`.
   - **Publishable key** (`sb_publishable_…`), or the legacy *anon public* key, which becomes `VITE_SUPABASE_PUBLISHABLE_KEY`.
   - **Do not** copy the secret or service-role key anywhere.
4. **Project Settings → API → Exposed schemas:** keep only `public` (and `graphql_public` if listed). The `private` schema must **not** be exposed.

## Step 2: Configure the environment securely

```bash
cp .env.staging.example .env.staging          # Windows: copy .env.staging.example .env.staging
```

Fill in the values. `.env.staging` is git-ignored.

| Variable | Used by | Value |
| --- | --- | --- |
| `VITE_SUPABASE_URL` | app build, both scripts | staging Project URL |
| `VITE_SUPABASE_PUBLISHABLE_KEY` (or `VITE_SUPABASE_ANON_KEY`) | app build, both scripts | staging publishable or anon key |
| `STAGING_EMAIL_PREFIX` | seed (typed into the file), scripts | mailbox part before "+", e.g. `it.team` |
| `STAGING_EMAIL_DOMAIN` | seed, scripts | mailbox domain |
| `STAGING_TEST_PASSWORD` | scripts | a long random password used **only** for the `stg-` test accounts |
| `STAGING_SEND_RESET_EMAIL`, `STAGING_APP_URL` | `verify-supabase.mjs` (optional) | `yes` and the staging app's https address |
| `CONFIRM_STAGING` | `concurrency-check.mjs` | `yes`, only in `.env.staging` |

The scripts print variable **names** when something is missing, never values. They refuse to run with a secret or service-role key, and they mask any configured password, JWT or Supabase key in their output.

## Step 3: Apply the migrations in order

The 50 files in `supabase/migrations/` are applied in filename order. The CLI does this automatically.

```bash
npx supabase login
npx supabase link --project-ref <staging-project-ref>
npx supabase db push --dry-run      # review: 50 migrations, nothing else
npx supabase db push
```

- **Expected:** 50 migrations applied, and the last two are `20261019090000_readiness_indexes.sql` and `20261019090100_rls_policy_performance.sql`.
- **Check:** Dashboard → Database → Migrations lists all 50.
- **No CLI?** Paste each file into the **SQL Editor** in filename order. Every file can safely be run again.

## Step 4: Configure Auth, Storage and the invite function

1. **Authentication → URL Configuration:**
   - **Site URL:** the staging app URL (`https://…`).
   - **Redirect URLs:** `https://<staging app>/reset-password` and `https://<staging app>/login`.
2. **Authentication → Sign In / Providers:**
   - Email provider on; "Confirm email" on.
   - **Allow new users to sign up: off.** Users are invited.
3. **Storage:** buckets `product-images` and `documents` exist (created by the migrations) and are **not** public.
4. **Invite function** (needs the CLI):

   ```bash
   npx supabase functions deploy invite-user
   npx supabase secrets set INVITE_REDIRECT_URL=https://<staging app>/reset-password ALLOWED_ORIGINS=https://<staging app>
   ```

## Step 5: Create the test users for all roles

1. **Authentication → Users → Add user → Create new user.** Create these 10 accounts, each with **Auto Confirm User** ticked and the same `STAGING_TEST_PASSWORD`:

   | Account | Role | Company |
   | --- | --- | --- |
   | `<prefix>+stg-superadmin@<domain>` | SUPER_ADMIN | STG-A |
   | `<prefix>+stg-admin@<domain>` | ADMIN | STG-A |
   | `<prefix>+stg-inventory@<domain>` | INVENTORY_MANAGER | STG-A |
   | `<prefix>+stg-production@<domain>` | PRODUCTION_MANAGER | STG-A |
   | `<prefix>+stg-purchase@<domain>` | PURCHASE_MANAGER | STG-A |
   | `<prefix>+stg-sales@<domain>` | SALES_MANAGER | STG-A |
   | `<prefix>+stg-accounts@<domain>` | ACCOUNTS_MANAGER | STG-A |
   | `<prefix>+stg-viewer@<domain>` | MANAGEMENT_VIEWER | STG-A |
   | `<prefix>+stg-inactive@<domain>` | SALES_MANAGER, **deactivated** | STG-A |
   | `<prefix>+stg-b-admin@<domain>` | ADMIN | STG-B (second company, for the isolation tests) |

2. Open `supabase/staging/seed_staging_test_data.sql`. Edit the three lines at the top: your prefix, your domain, and `app.allow_staging_seed` set to `yes`. Paste the whole file into the **SQL Editor** and run it.
   - **Expected:** a notice *"Staging test data ready"* and a table of 10 accounts with their roles. Nine are active; `stg-inactive` is not.
   - **It refuses to run:**
     - if it isn't confirmed;
     - if an account is missing (it lists which);
     - if the database contains issued invoices of a non-test company, i.e. it looks like production.
   - It creates fictitious test companies STG-A and STG-B, warehouse `STG-W1`, product `STG-CONC-1` and customer `STG-CUST-1`. It can be run again safely.
3. Do **not** commit your edited copy of the seed file.

## Step 6: Run the SQL verification suites on staging

Paste each file from `supabase/tests/` into the **SQL Editor** and run it, one at a time:

```
rls_verification.sql                    RLS_VERIFICATION_RESULT
inventory_verification.sql              INVENTORY_VERIFICATION_RESULT
production_verification.sql             PRODUCTION_VERIFICATION_RESULT
customer_po_verification.sql            CUSTOMER_PO_VERIFICATION_RESULT
sales_fulfilment_verification.sql       SALES_FULFILMENT_VERIFICATION_RESULT
billing_verification.sql                BILLING_VERIFICATION_RESULT
analytics_verification.sql              ANALYTICS_VERIFICATION_RESULT
admin_productivity_verification.sql     ADMIN_VERIFICATION_RESULT
production_readiness_verification.sql   READINESS_VERIFICATION_RESULT
```

Each run **ends with an error on purpose**. The error message reads `<TAG> passed=N failed=0`, and it rolls back all of the file's test data.

- **PASS:** `failed=0`.
- **Locally the counts are** 173, 132, 198, 113, 183, 124, 108, 133 and 137. A staging count can differ only if the project already contains different data.
- **Do not edit** `supabase/tests/local_supabase_shim.sql`; it is for local runs only and is never run on staging.

## Step 7: Verify authentication, roles and company isolation

```bash
npm run verify:supabase
```

Read-only by design. It checks:
- **Anonymous access:** blocked for 14 tables, 2 functions and private files.
- **Sign-in and sessions:** wrong password rejected, valid sign-in, session refresh, and the old refresh token rejected after sign-out.
- **Roles:** each of the 8 roles has exactly its role in STG-A, may use one function of its own, and is refused one belonging to another role.
- **Viewer write attempts:** all refused.
- **Deactivated account:** no roles, no data, no writes.
- **Company isolation:** company B's Admin cannot read 17 kinds of company A record, or edit A's product or customer even though B holds those permissions. B also cannot assign a barcode to A's product, see A's users or list A's files.

Expected results:
- **Exit code 3 ("INCOMPLETE"):** normal when you haven't asked for the password-reset email. Everything else should be PASS.
- **Exit code 0:** with the password-reset email included, everything automated passed.
- Either way, finish the **MANUAL REVIEW REQUIRED** items.

Password reset (once):

```bash
# add to .env.staging: STAGING_SEND_RESET_EMAIL=yes and STAGING_APP_URL=https://<staging app>
npm run verify:supabase
```

Then do the manual part:
1. Open the email sent to `+stg-viewer` and confirm the link opens the **staging** app.
2. Set a new password and sign in with it.
3. Set the password back to `STAGING_TEST_PASSWORD` (Dashboard → Users → the account → reset).

## Step 8: Run the simultaneous-request checks

```bash
npm run verify:concurrency      # needs CONFIRM_STAGING=yes in .env.staging
```

This **writes** small, clearly marked test records in company STG-A only, and refuses to run for any account that isn't in an `STG-` company.

**Expected:** exit code 0 with all 8 checks PASS:
1. One request key sent 8 times at once posts one receipt.
2. Parallel issues never exceed available stock.
3. Parallel reservations never exceed available stock.
4. Six simultaneous dispatches of one consignment deduct stock once.
5. Six simultaneous invoice drafts create one draft, and four simultaneous issue requests assign one invoice number.
6. A payment retried 8 times with the same key is recorded once.
7. Two receipts racing for the same balance never over-allocate it.

Run it twice: the second run must also pass. Each run tags its records with a run id.

## Step 9: Backups and a restore test

1. **Database → Backups:** record whether scheduled backups exist and their retention, and whether point-in-time recovery is enabled. Both depend on the plan. If there are none, record that as a blocking gap for production.
2. **Restore test:** never restore over the source project.
   - If your plan offers *restore to a new project*, use it.
   - Otherwise take a logical dump with `pg_dump` (connection string from Project Settings → Database; type the password at the prompt, don't store it in a file) and load it into a second, empty test project with `psql`.
3. On the restored copy:
   - Run Step 6, which must give `failed=0`.
   - Run the integrity query in [PRODUCTION_READINESS.md §3](PRODUCTION_READINESS.md#3-backup-and-recovery), which must return `0`.
   - Compare the row counts of `inventory_transactions`, `sales_invoices` and `customer_payments` with the source.
4. **Files:** database backups do not contain the files in Storage. Copy one test document out of `documents` and back into the restored project, and open it in the app.
5. Record the date, the duration (this is your measured restore time) and the result.

## Step 10: Invoice numbering, GST settings and hosting

**Invoice numbering (staging):**
1. Sign in as `+stg-admin` and open **Invoice Settings** (`/billing/settings`). Check the prefix, padding and financial-year start.
2. Step 8 issued invoices in STG-A, numbered `INV/<FY>/0001`, `…/0002` and so on. Confirm in **Invoices** that numbers are consecutive and that there are no duplicates.
3. Confirm STG-B has its own series.
4. For production, Accounts must approve the exact format and starting number **before** the first live invoice.

**GST settings:**
1. Company Settings: legal name, address, state and GSTIN.
2. Invoice Settings: GST registered, round-off, any other charges with their SAC and rate.
3. Issue a test invoice in STG-A to an intra-state customer (CGST + SGST) and one to an inter-state customer (IGST; create a second test customer with a different state). Check the totals and the printed invoice (`/billing/invoices/<id>/print`).
4. The tax professional reviews the list in [PRODUCTION_READINESS.md §6](PRODUCTION_READINESS.md#6-gst-and-statutory-items-for-professional-review).
5. E-invoicing, e-way bills and GST filing are **not integrated**. Nothing is submitted anywhere.

**Hosting (staging app):**
1. Build with the staging values:

   ```bash
   npm ci
   npm run build        # with VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY set to staging in the host's environment
   ```

2. Deploy `dist/` to the staging host. It must be served over HTTPS, with every path falling back to `index.html` (single-page app).
3. Check in a browser:
   - The login page loads over https.
   - Signing in as `+stg-viewer` works, and production accounts do **not** exist there.
   - Reloading on a deep link (e.g. `/inventory/movements`) works.
   - Signing out returns to the login page.
   - Camera scanning appears only where the browser supports it.
4. **Check the build contains no secret.** Search `dist/` for `sb_secret_`, `service_role` (only the refusal message may match), and the staging database password; none should match.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `node: .env.staging: not found` | Create it from `.env.staging.example` (Step 2) |
| `BLOCKED: Missing required environment variables: …` | Add the listed **names** to `.env.staging` |
| `BLOCKED: Refusing to run with a privileged … key` | You used the secret or service-role key. Use the publishable or anon key, and **rotate the secret key** in Project Settings → API |
| `BLOCKED: The Supabase project could not be reached` | Wrong `VITE_SUPABASE_URL`, project paused, or no network |
| `… test account could not sign in (invalid_credentials)` | Account missing, not confirmed, or a different password. Recreate it with Auto Confirm and `STAGING_TEST_PASSWORD` |
| `… belongs to company "…", not a STG- test company` | The seed wasn't run, or the account belongs to a real company. Never point the concurrency script at production |
| Seed: `Create these Auth users first: …` | Create the listed accounts (Step 5.1), then run the seed again |
| Seed: `looks like PRODUCTION` | You are connected to the wrong project. Stop |
| SQL suite ends `failed=N` (N > 0) | Read the FAIL lines in the error detail. Re-check that all 50 migrations are applied (Database → Migrations) |
| Readiness suite: "anonymous users cannot execute any public function" fails, listing extension functions | An extension was installed into `public`. Move it to the `extensions` schema (`alter extension <name> set schema extensions;`) and rerun |
| `5b … BLOCKED … validation problems` | Company or customer GST details incomplete on staging (Step 10, GST settings) |
| `5b … approval` | Invoice Settings requires approval. Either test approval separately or switch it off on staging only |
| Password reset link opens production or localhost | Fix Site URL and Redirect URLs (Step 4.1) |

## What can be checked locally (no staging access)

```bash
npm run test:staging-local
```

This tests the seed file (its refusals, re-runs and the production guard). It also runs both scripts against a **local emulation** of the Supabase API, built on the real migrations and row-level security.

The emulation processes requests one at a time. So it validates the scripts and the rules, **not** true simultaneity, real Supabase Auth email or hosting. It never counts as staging validation.
