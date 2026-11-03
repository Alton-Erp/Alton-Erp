// Live verification of a STAGING Supabase project through the public API, using
// the browser's publishable key (so RLS applies exactly as in the app) and the
// TEST accounts created by supabase/staging/seed_staging_test_data.sql.
//
//   node --env-file=.env.staging scripts/verify-supabase.mjs
//
// Read-only by design: it reads, and attempts writes that MUST be rejected. If a
// rule were broken, a rejected-write attempt could change one TEST record of the
// test companies; it never touches other companies' data on purpose.
//
// Environment (names only; never put values in code or logs):
//   required  VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY (or VITE_SUPABASE_ANON_KEY)
//   accounts  STAGING_EMAIL_PREFIX, STAGING_EMAIL_DOMAIN, STAGING_TEST_PASSWORD
//             (accounts are <prefix>+stg-<role>@<domain>, see the seed file)
//   optional  STAGING_SEND_RESET_EMAIL=yes and STAGING_APP_URL=https://<staging app>
//             to send one password-reset email to the viewer test account
//
// Statuses: PASS / FAIL / BLOCKED / NOT RUN / MANUAL REVIEW REQUIRED (only PASS passes).
// Exit code: 0 all PASS, 1 any FAIL, 2 configuration missing, 3 some BLOCKED / NOT RUN.

import { createClient } from '@supabase/supabase-js'

import { connectionFromEnv, createReport, errorText, isDenied, isNetworkError, missingEnv, preflight } from './lib/staging.mjs'

const { url, key } = connectionFromEnv()
await preflight(url, key)
const report = createReport('Staging verification')
const client = () => createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
const NIL = '00000000-0000-0000-0000-000000000000'
const today = new Date().toISOString().slice(0, 10)

/** Blocked = an error, or no rows returned / affected. */
async function expectBlocked(name, promise) {
  const r = await promise
  if (isNetworkError(r)) return report.blocked(name, 'no answer from the server (network error), so the refusal is not proven')
  report.check(name, Boolean(r.error) || !r.data || r.data.length === 0, r.error ? `rejected (${r.error.code ?? 'error'})` : `rows=${r.data?.length ?? 0}`)
}

// --- 1. Anonymous access ------------------------------------------------------
{
  const anon = client()
  for (const t of ['companies', 'profiles', 'user_roles', 'company_settings', 'audit_logs', 'products', 'customers', 'inventory_transactions', 'inventory_balances',
    'sales_orders', 'sales_invoices', 'customer_payments', 'documents', 'notifications']) {
    await expectBlocked(`anonymous: cannot read ${t}`, anon.from(t).select('id').limit(1))
  }
  for (const fn of ['get_my_access', 'inventory_overview']) {
    const r = await anon.rpc(fn)
    report.check(`anonymous: cannot call ${fn}`, Boolean(r.error), errorText(r))
  }
  const files = await anon.storage.from('documents').list('', { limit: 1 })
  report.check('anonymous: cannot list private documents', Boolean(files.error) || (files.data ?? []).length === 0, errorText(files))
}

// --- Test accounts ------------------------------------------------------------
const accountVars = ['STAGING_EMAIL_PREFIX', 'STAGING_EMAIL_DOMAIN', 'STAGING_TEST_PASSWORD']
const missing = missingEnv(accountVars)
const ROLES = [
  // tag, expected role, an RPC this role may call, an RPC it must be refused
  ['stg-superadmin', 'SUPER_ADMIN', ['user_activity_list', {}], null],
  ['stg-admin', 'ADMIN', ['user_activity_list', {}], ['inventory_post_receipt', { p_product_id: NIL, p_location_id: NIL, p_quantity: 1, p_source_type: 'IN_HOUSE' }]],
  ['stg-inventory', 'INVENTORY_MANAGER', ['inventory_overview', {}], ['sales_invoice_issue', { p_invoice_id: NIL }]],
  ['stg-production', 'PRODUCTION_MANAGER', ['production_overview', { p_from: today, p_to: today }], ['customer_payment_record', { p_payment: {} }]],
  ['stg-purchase', 'PURCHASE_MANAGER', ['inventory_overview', {}], ['sales_order_create_manual', { p_header: {}, p_lines: [] }]],
  ['stg-sales', 'SALES_MANAGER', ['sales_overview', { p_from: today, p_to: today }], ['inventory_post_receipt', { p_product_id: NIL, p_location_id: NIL, p_quantity: 1, p_source_type: 'IN_HOUSE' }]],
  ['stg-accounts', 'ACCOUNTS_MANAGER', ['billing_overview', { p_from: today, p_to: today }], ['inventory_post_receipt', { p_product_id: NIL, p_location_id: NIL, p_quantity: 1, p_source_type: 'IN_HOUSE' }]],
  ['stg-viewer', 'MANAGEMENT_VIEWER', ['analytics_executive', { p_from: today, p_to: today }], ['sales_order_create_manual', { p_header: {}, p_lines: [] }]],
]
const email = (tag) => `${process.env.STAGING_EMAIL_PREFIX}+${tag}@${process.env.STAGING_EMAIL_DOMAIN}`
async function signIn(tag) {
  const c = client()
  const r = await c.auth.signInWithPassword({ email: email(tag), password: process.env.STAGING_TEST_PASSWORD })
  return { c, r }
}

if (missing.length) {
  const why = `set ${missing.join(', ')} (test accounts from the staging seed)`
  for (const n of ['authentication', 'session refresh and sign-out', 'role permissions (8 roles)', 'viewer write attempts', 'deactivated account', 'company isolation (A vs B)']) report.blocked(n, why)
} else {
  // --- 2. Authentication and sessions ------------------------------------------
  {
    const c = client()
    const bad = await c.auth.signInWithPassword({ email: email('stg-viewer'), password: `${process.env.STAGING_TEST_PASSWORD}-wrong` })
    report.check('auth: a wrong password is rejected', Boolean(bad.error), bad.error?.code ?? 'signed in with a wrong password')
  }
  const { c: viewer, r: vLogin } = await signIn('stg-viewer')
  if (vLogin.error) {
    report.blocked('auth: viewer test account signs in', `${vLogin.error.code ?? 'error'}: check the account exists, is confirmed and uses STAGING_TEST_PASSWORD`)
  } else {
    report.pass('auth: viewer test account signs in')
    const refresh = await viewer.auth.refreshSession()
    report.check('session: the session can be refreshed (restored after page reload)', !refresh.error && Boolean(refresh.data.session), errorText(refresh))
    const oldRefresh = refresh.data.session?.refresh_token
    await viewer.auth.signOut()
    const reuse = await client().auth.refreshSession({ refresh_token: oldRefresh })
    report.check('session: after sign-out the old refresh token no longer works', Boolean(reuse.error), reuse.error ? reuse.error.code ?? 'rejected' : 'a signed-out session was refreshed')
  }

  // --- 3. Roles ----------------------------------------------------------------
  let companyA = null
  for (const [tag, role, allowed, denied] of ROLES) {
    const { c, r } = await signIn(tag)
    if (r.error) {
      report.blocked(`role ${role}: signs in`, `${r.error.code ?? 'error'}: create the ${tag} account (see the seed file)`)
      continue
    }
    const access = await c.rpc('get_my_access')
    const roles = access.data?.roles ?? []
    companyA ??= access.data?.company?.id ?? null
    report.check(`role ${role}: has exactly this role in test company STG-A`, roles.length === 1 && roles[0] === role && access.data?.company?.company_code === 'STG-A'
      && access.data?.profile?.is_active === true, `roles=${roles.join(',')} company=${access.data?.company?.company_code ?? 'none'}`)
    const ok = await c.rpc(allowed[0], allowed[1])
    report.check(`role ${role}: may use ${allowed[0]}`, !ok.error, errorText(ok))
    if (denied) {
      const no = await c.rpc(denied[0], denied[1])
      report.check(`role ${role}: is refused ${denied[0]} by the server`, isDenied(no), no.error ? errorText(no) : 'the call was allowed')
    }
    await c.auth.signOut()
  }

  // --- 4. Viewer write attempts (all must be rejected) --------------------------
  {
    const { c, r } = await signIn('stg-viewer')
    if (r.error) report.blocked('viewer write attempts', 'viewer account could not sign in')
    else {
      const uid = r.data.user.id
      const { data: superRole } = await c.from('roles').select('id').eq('code', 'SUPER_ADMIN').maybeSingle()
      await expectBlocked('viewer: cannot change company details', c.from('companies').update({ display_name: 'Changed by test' }).eq('id', companyA ?? NIL).select())
      await expectBlocked('viewer: cannot read company settings', c.from('company_settings').select('id'))
      await expectBlocked('viewer: cannot grant itself SUPER_ADMIN', c.from('user_roles').insert({ user_id: uid, company_id: companyA, role_id: superRole?.id ?? NIL, assigned_by: uid }).select())
      await expectBlocked('viewer: cannot change its own active status', c.from('profiles').update({ is_active: false }).eq('id', uid).select())
      await expectBlocked('viewer: cannot read the audit log', c.from('audit_logs').select('id').limit(1))
      await expectBlocked('viewer: cannot create products', c.from('products').insert({ company_id: companyA, sku: `VERIFY-${Date.now()}`, product_name: 'Verify (TEST)', product_type: 'OTHER', default_source_type: 'IN_HOUSE', base_unit: 'PCS' }).select())
      await expectBlocked('viewer: cannot edit products', c.from('products').update({ product_name: 'Changed by test' }).neq('id', NIL).select())
      await expectBlocked('viewer: cannot edit stock balances', c.from('inventory_balances').update({ on_hand: 999999 }).neq('id', NIL).select())
      await expectBlocked('viewer: cannot edit issued invoices', c.from('sales_invoices').update({ grand_total: 1 }).neq('id', NIL).select())
      await c.auth.signOut()
    }
  }

  // --- 5. Deactivated account ----------------------------------------------------
  {
    const { c, r } = await signIn('stg-inactive')
    if (r.error && r.error.code === 'user_banned') report.pass('deactivated: cannot sign in (banned in Auth)')
    else if (r.error) report.blocked('deactivated: account check', `${r.error.code ?? 'error'}: the stg-inactive account could not be tested (wrong password or missing account is not proof)`)
    else {
      const access = await c.rpc('get_my_access')
      report.check('deactivated: signs in but receives no roles or permissions', (access.data?.permissions ?? []).length === 0 && (access.data?.roles ?? []).length === 0)
      await expectBlocked('deactivated: cannot read company data', c.from('products').select('id').limit(1))
      const w = await c.rpc('sales_order_create_manual', { p_header: {}, p_lines: [] })
      report.check('deactivated: cannot create sales orders', isDenied(w), errorText(w))
      await c.auth.signOut()
    }
  }

  // --- 6. Company isolation (A <-> B) ----------------------------------------------
  {
    const { c: a, r: ra } = await signIn('stg-admin')
    const { c: b, r: rb } = await signIn('stg-b-admin')
    if (ra.error || rb.error) report.blocked('company isolation', 'stg-admin and stg-b-admin must both sign in')
    else {
      const idA = (await a.rpc('get_my_access')).data?.company?.id
      const idB = (await b.rpc('get_my_access')).data?.company?.id
      report.check('isolation: the two test accounts belong to different companies', idA && idB && idA !== idB)
      const { data: aProduct } = await a.from('products').select('id, sku').eq('sku', 'STG-CONC-1').maybeSingle()
      const { data: aCustomer } = await a.from('customers').select('id').eq('customer_code', 'STG-CUST-1').maybeSingle()
      if (!aProduct || !aCustomer) report.blocked('isolation: company A test records', 'STG-CONC-1 / STG-CUST-1 not found; run the staging seed')
      for (const t of ['products', 'customers', 'warehouses', 'inventory_transactions', 'inventory_balances', 'stock_reservations', 'sales_orders', 'fulfilments',
        'sales_invoices', 'customer_payments', 'customer_purchase_orders', 'production_orders', 'documents', 'notifications', 'audit_logs', 'profiles', 'user_roles']) {
        const r = await b.from(t).select('id').eq('company_id', idA).limit(1)
        report.check(`isolation: company B cannot read company A ${t}`, !r.error ? (r.data ?? []).length === 0 : true, r.error ? `rejected (${r.error.code})` : `rows=${r.data.length}`)
      }
      const back = await a.from('products').select('id').eq('company_id', idB).limit(1)
      report.check('isolation: company A cannot read company B products', (back.data ?? []).length === 0)
      if (aProduct) {
        await expectBlocked('isolation: B cannot edit A\'s product (B has products.update)', b.from('products').update({ product_name: 'Changed by company B' }).eq('id', aProduct.id).select())
        const bc = await b.rpc('product_assign_barcode', { p_product_id: aProduct.id, p_barcode: 'STG-X-0001', p_expected_current: null, p_confirm_replace: false })
        report.check('isolation: B cannot assign a barcode to A\'s product', Boolean(bc.error), errorText(bc) || 'barcode assigned')
        const scan = await b.rpc('barcode_lookup', { p_code: aProduct.sku })
        report.check('isolation: scanning A\'s SKU in company B returns no A record', !(scan.data?.matches ?? []).some((m) => m.id === aProduct.id), errorText(scan))
      }
      if (aCustomer) await expectBlocked('isolation: B cannot edit A\'s customer (B has customers.manage)', b.from('customers').update({ notes: 'changed by B' }).eq('id', aCustomer.id).select())
      await expectBlocked('isolation: B cannot create a record inside company A', b.from('customers').insert({ company_id: idA, customer_code: 'STG-INJECT', customer_name: 'Injected (TEST)' }).select())
      const aUser = ra.data.user.id
      const detail = await b.rpc('user_activity_detail', { p_user_id: aUser })
      report.check('isolation: B\'s administrator cannot see A\'s user activity', Boolean(detail.error), errorText(detail) || 'details returned')
      const files = await b.storage.from('documents').list(idA, { limit: 5 })
      report.check('isolation: B cannot list A\'s document files', Boolean(files.error) || (files.data ?? []).length === 0, errorText(files))
      await a.auth.signOut()
      await b.auth.signOut()
    }
  }
}

// --- 7. Password reset and manual checks ------------------------------------------
if (process.env.STAGING_SEND_RESET_EMAIL === 'yes' && !missing.length) {
  const appUrl = process.env.STAGING_APP_URL
  if (!appUrl) report.blocked('password reset email', 'set STAGING_APP_URL to the staging app address')
  else {
    const r = await client().auth.resetPasswordForEmail(email('stg-viewer'), { redirectTo: `${appUrl.replace(/\/+$/, '')}/reset-password` })
    report.check('password reset: request accepted by Supabase Auth', !r.error, errorText(r))
    report.manual('password reset: email received, link opens the STAGING app, new password works', 'open the email for +stg-viewer, follow the link, set a new password, sign in, then set it back to STAGING_TEST_PASSWORD')
  }
} else {
  report.notRun('password reset email', 'set STAGING_SEND_RESET_EMAIL=yes and STAGING_APP_URL to send one test email')
}
report.manual('browser: sign in, reload (session restored), sign out, protected page redirects to login', 'staging app in a browser')
report.manual('browser: each role sees only its menu items; a hidden page opened by URL shows "no permission"', 'sign in once per stg- account')

process.exit(report.finish())
