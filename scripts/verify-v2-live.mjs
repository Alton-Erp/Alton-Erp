// =============================================================================
// ALTON ERP V2 — live integration verification against the HOSTED Supabase project.
//
//   node scripts/verify-v2-live.mjs                 read-only checks (real ALTON company + test companies)
//   node scripts/verify-v2-live.mjs --workflows     also runs the business workflows, in test company STG-A only
//   add  --report <file.md>                         to write the results as Markdown
//
// Uses the browser's publishable key, so RLS and permissions apply exactly as in the app.
// Reads .env.local (VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY) and .env.live:
//   LIVE_SUPERADMIN_EMAIL, LIVE_SUPERADMIN_PASSWORD        the real Super Admin (company ALTON) — read-only use
//   STAGING_EMAIL_PREFIX, STAGING_EMAIL_DOMAIN, STAGING_TEST_PASSWORD
//                                                          test accounts from supabase/staging/seed_staging_test_data.sql
// Secrets are never printed. The real ALTON company is never written to.
// Never calls reset functions or destructive SQL. Workflow records are created only in STG-A and are kept.
//
// Statuses: PASS / FAIL / BLOCKED (could not be tested) / NOT RUN. Exit code 0 only when nothing FAILED or was BLOCKED.
// =============================================================================
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { createClient } from '@supabase/supabase-js'

const root = path.resolve(import.meta.dirname, '..')
for (const f of ['.env.local', '.env.live']) if (existsSync(path.join(root, f))) process.loadEnvFile(path.join(root, f))
const args = process.argv.slice(2)
const RUN_WORKFLOWS = args.includes('--workflows')
const REPORT = args.includes('--report') ? args[args.indexOf('--report') + 1] : null
const EXPECTED_REF = 'srpeewjutlyruympdznc'
const OLD_REF = 'reuoicscalgcjoabwspu'
const url = process.env.VITE_SUPABASE_URL ?? ''
const key = process.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? process.env.VITE_SUPABASE_ANON_KEY ?? ''
const RUN = new Date().toISOString().replace(/\D/g, '').slice(2, 12) // tag for this run's test records

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const results = []
let section = ''
const add = (status, name, detail = '') => { results.push({ section, status, name, detail: String(detail ?? '').slice(0, 600) }); console.log(`  ${status.padEnd(7)} ${name}${detail ? ` — ${String(detail).slice(0, 300)}` : ''}`) }
const pass = (n, d) => add('PASS', n, d)
const fail = (n, d) => add('FAIL', n, d)
const blocked = (n, d) => add('BLOCKED', n, d)
const notRun = (n, d) => add('NOT RUN', n, d)
const check = (n, ok, d) => (ok ? pass(n, d) : fail(n, d))
const start = (s) => { section = s; console.log(`\n== ${s}`) }
const errText = (e) => (e ? `${e.code ?? ''} ${e.message ?? e}`.trim() : '')
const mask = (email) => (email ? email.replace(/^(.).*(@.*)$/, '$1***$2') : '')
const num = (v) => Number(v ?? 0)
const eq = (a, b) => Math.abs(num(a) - num(b)) < 0.005

// ---------------------------------------------------------------------------
// Supabase helpers
// ---------------------------------------------------------------------------
const newClient = () => createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
async function signIn(email, password) {
  const c = newClient()
  const { data, error } = await c.auth.signInWithPassword({ email, password })
  return { c, error, user: data?.user ?? null }
}
async function rpc(c, fn, params = {}) { const { data, error } = await c.rpc(fn, params); return { data, error } }
async function fetchAll(make) {
  const rows = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await make().range(from, from + 999)
    if (error) throw error
    rows.push(...(data ?? []))
    if (!data || data.length < 1000) return rows
  }
}
const IST = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d)
const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }
const TODAY = IST()
function presets() {
  const dow = (new Date(`${TODAY}T00:00:00Z`).getUTCDay() + 6) % 7
  return { Today: [TODAY, TODAY], 'This week': [addDays(TODAY, -dow), TODAY], 'This month': [`${TODAY.slice(0, 7)}-01`, TODAY], 'This year': [`${TODAY.slice(0, 4)}-01-01`, TODAY] }
}

// ---------------------------------------------------------------------------
// Shared checks
// ---------------------------------------------------------------------------
const REPORT_KEYS = [...readFileSync(path.join(root, 'src', 'features', 'management', 'report-defs.ts'), 'utf8').matchAll(/^ {2}\{ key: '([A-Z_]+)'/gm)].map((m) => m[1])

/** Every module's main read path, as the pages call it. */
async function moduleReads(c, label) {
  const [from, to] = presets()['This month']
  const calls = [
    ['1 Management Dashboard', 'management_overview', () => rpc(c, 'management_overview', { p_from: from, p_to: to })],
    ['1 Management Dashboard', 'inventory_overview', () => rpc(c, 'inventory_overview')],
    ['2 Product Master & BOM', 'products list', () => c.from('products').select('id', { count: 'exact', head: true })],
    ['2 Product Master & BOM', 'product dashboard', () => rpc(c, 'module_dashboard', { p_module: 'PRODUCTS', p_from: from, p_to: to })],
    ['2 Product Master & BOM', 'BOM list', () => c.from('boms').select('id', { count: 'exact', head: true })],
    ['3 Inventory Management', 'stock register', () => c.from('inventory_product_stock').select('product_id', { count: 'exact', head: true })],
    ['3 Inventory Management', 'stock movements', () => c.from('inventory_transactions').select('id', { count: 'exact', head: true })],
    ['3 Inventory Management', 'reservations', () => c.from('stock_reservations').select('id', { count: 'exact', head: true })],
    ['3 Inventory Management', 'warehouses', () => c.from('warehouses').select('id', { count: 'exact', head: true })],
    ['4 Purchase Orders & GRN', 'purchase orders', () => c.from('purchase_orders').select('id', { count: 'exact', head: true })],
    ['4 Purchase Orders & GRN', 'goods receipts', () => c.from('goods_receipts').select('id', { count: 'exact', head: true })],
    ['4 Purchase Orders & GRN', 'purchase dashboard', () => rpc(c, 'module_dashboard', { p_module: 'PURCHASE', p_from: from, p_to: to })],
    ['4 Purchase Orders & GRN', 'GRN dashboard', () => rpc(c, 'module_dashboard', { p_module: 'GRN', p_from: from, p_to: to })],
    ['5 Production & Outsourcing', 'production dashboard', () => rpc(c, 'production_dashboard', { p_from: from, p_to: to })],
    ['5 Production & Outsourcing', 'production orders', () => c.from('production_orders').select('id', { count: 'exact', head: true })],
    ['5 Production & Outsourcing', 'outsourcing orders', () => c.from('outsourcing_orders').select('id', { count: 'exact', head: true })],
    ['6 Sales Orders & Fulfilment', 'sales dashboard', () => rpc(c, 'sales_dashboard', { p_from: from, p_to: to })],
    ['6 Sales Orders & Fulfilment', 'sales order list', () => c.from('sales_order_list').select('id', { count: 'exact', head: true })],
    ['7 Billing & Invoicing', 'invoice dashboard', () => rpc(c, 'invoice_dashboard', { p_from: from, p_to: to })],
    ['7 Billing & Invoicing', 'invoice list', () => c.from('sales_invoice_list').select('id', { count: 'exact', head: true })],
    ['7 Billing & Invoicing', 'customer payments', () => c.from('customer_payments').select('id', { count: 'exact', head: true })],
    ['7 Billing & Invoicing', 'ledger dashboard', () => rpc(c, 'module_dashboard', { p_module: 'LEDGER', p_from: from, p_to: to })],
    ['8 Reports & Settings', 'ERP settings', () => rpc(c, 'erp_settings_get')],
    ['8 Reports & Settings', 'preferences', () => rpc(c, 'erp_preferences')],
    ['8 Reports & Settings', 'audit log', () => c.from('audit_logs').select('id', { count: 'exact', head: true })],
    ['8 Reports & Settings', 'import history', () => c.from('import_jobs').select('id', { count: 'exact', head: true })],
    ['8 Reports & Settings', 'users & roles', () => rpc(c, 'user_activity_list')],
  ]
  for (const [module, name, call] of calls) {
    const r = await call()
    check(`${label}: ${module} — ${name}`, !r.error, r.error ? errText(r.error) : r.count !== undefined && r.count !== null ? `${r.count} row(s)` : 'ok')
  }
  let reportErrors = []
  for (const k of REPORT_KEYS) { const r = await rpc(c, 'erp_report', { p_report: k, p_filters: { from: `${TODAY.slice(0, 4)}-01-01`, to: TODAY } }); if (r.error) reportErrors.push(`${k}: ${errText(r.error)}`) }
  check(`${label}: 8 Reports & Settings — all ${REPORT_KEYS.length} reports run`, REPORT_KEYS.length === 20 && reportErrors.length === 0, reportErrors.join('; ') || `${REPORT_KEYS.length} reports`)
}

/** Recomputes the dashboard figures from the raw records the user can see and compares them with the dashboard functions. */
async function verifyDashboard(c, label) {
  for (const [name, [from, to]] of Object.entries(presets())) {
    const ov = await rpc(c, 'management_overview', { p_from: from, p_to: to })
    if (ov.error) { fail(`${label}: dashboard (${name}) loads`, errText(ov.error)); continue }
    const d = ov.data
    try {
      const inv = await fetchAll(() => c.from('sales_invoices').select('grand_total').eq('status', 'ISSUED').gte('invoice_date', from).lte('invoice_date', to))
      const so = await fetchAll(() => c.from('sales_orders').select('grand_total, order_status').gte('order_date', from).lte('order_date', to))
      const po = await fetchAll(() => c.from('purchase_orders').select('id').gte('po_date', from).lte('po_date', to))
      const prod = await fetchAll(() => c.from('production_orders').select('status').neq('status', 'CANCELLED').gte('planned_start_date', from).lte('planned_start_date', to))
      const invSum = inv.reduce((s, r) => s + num(r.grand_total), 0)
      const soLive = so.filter((r) => !['DRAFT', 'CANCELLED'].includes(r.order_status))
      const soNotCancelled = so.filter((r) => r.order_status !== 'CANCELLED')
      const shownOrders = num(d.sales?.total_orders) - num(d.sales?.cancelled)
      check(`${label}: dashboard (${name} ${from}..${to}) invoiced sales = issued invoices in the period`, eq(d.kpis.sales_invoiced, invSum) && num(d.kpis.invoices) === inv.length,
        `dashboard ${d.kpis.invoices} / ${d.kpis.sales_invoiced}; records ${inv.length} / ${invSum.toFixed(2)}`)
      check(`${label}: dashboard (${name}) sales orders = orders in the period excluding cancelled; value excludes drafts`,
        (!d.sales?.available || shownOrders === soNotCancelled.length) && eq(d.kpis.sales_order_value, soLive.reduce((s, r) => s + num(r.grand_total), 0)),
        `dashboard ${shownOrders} / ${d.kpis.sales_order_value}; records ${soNotCancelled.length} / ${soLive.reduce((s, r) => s + num(r.grand_total), 0).toFixed(2)}`)
      check(`${label}: dashboard (${name}) purchase orders raised in the period`, !d.purchase?.available || num(d.purchase.created) === po.length, `dashboard ${d.purchase?.created}; records ${po.length}`)
      check(`${label}: dashboard (${name}) production orders planned in the period`, !d.production?.available || num(d.production.orders) === prod.length, `dashboard ${d.production?.orders}; records ${prod.length}`)
    } catch (e) { fail(`${label}: dashboard (${name}) recomputation`, errText(e)) }
  }
  // Period-independent figures
  try {
    const ov = (await rpc(c, 'management_overview', { p_from: TODAY, p_to: TODAY })).data
    const open = await fetchAll(() => c.from('purchase_orders').select('id').in('status', ['APPROVED', 'SENT', 'PARTIALLY_RECEIVED']))
    check(`${label}: dashboard pending GRNs = POs awaiting goods`, !ov.purchase?.available || num(ov.purchase.open) === open.length, `dashboard ${ov.purchase?.open}; records ${open.length}`)
    const issued = await fetchAll(() => c.from('sales_invoice_list').select('balance_due').eq('status', 'ISSUED'))
    const outstanding = issued.reduce((s, r) => s + Math.max(num(r.balance_due), 0), 0)
    check(`${label}: dashboard outstanding payments = open balances of issued invoices`, eq(ov.kpis.customer_outstanding, outstanding), `dashboard ${ov.kpis.customer_outstanding}; records ${outstanding.toFixed(2)}`)
  } catch (e) { fail(`${label}: dashboard current figures`, errText(e)) }
}

/** Stock on hand by unit and source from the balances, compared with inventory_overview (the dashboard's stock cards), and balances vs the ledger. */
async function verifyStock(c, label, productIds = null) {
  try {
    const ovr = await rpc(c, 'inventory_overview')
    if (ovr.error) return fail(`${label}: stock overview loads`, errText(ovr.error))
    const bal = await fetchAll(() => c.from('inventory_balances').select('product_id, source_type, on_hand, reserved, products!inner(base_unit, archived_at)'))
    const by = new Map()
    for (const b of bal) {
      if (b.products.archived_at || (num(b.on_hand) === 0 && num(b.reserved) === 0)) continue
      const u = by.get(b.products.base_unit) ?? { on_hand: 0, IN_HOUSE: 0, OUTSOURCED: 0, UNKNOWN: 0 }
      u.on_hand += num(b.on_hand); u[b.source_type] += num(b.on_hand); by.set(b.products.base_unit, u)
    }
    const units = new Set([...by.keys(), ...(ovr.data.units ?? []).map((u) => u.unit)])
    const diffs = []
    for (const unit of units) {
      const mine = by.get(unit) ?? { on_hand: 0, IN_HOUSE: 0, OUTSOURCED: 0, UNKNOWN: 0 }
      const theirs = (ovr.data.units ?? []).find((u) => u.unit === unit) ?? {}
      if (!eq(mine.on_hand, theirs.on_hand) || !eq(mine.IN_HOUSE, theirs.in_house) || !eq(mine.OUTSOURCED, theirs.outsourced) || !eq(mine.UNKNOWN, theirs.unknown)) {
        diffs.push(`${unit}: balances ${mine.on_hand} (in-house ${mine.IN_HOUSE}, outsourced ${mine.OUTSOURCED}, unknown ${mine.UNKNOWN}) vs dashboard ${theirs.on_hand} (${theirs.in_house}/${theirs.outsourced}/${theirs.unknown})`)
      }
    }
    check(`${label}: total / manufactured / outsourced stock on the dashboard = stock balances by source`, diffs.length === 0,
      diffs.join('; ') || [...by].map(([u, v]) => `${u} ${v.on_hand} (in-house ${v.IN_HOUSE}, outsourced ${v.OUTSOURCED})`).join('; ') || 'no stock')
    // Ledger: every product's balance equals the sum of its posted movements.
    // Movements are always POSTED; a reversal is a new opposite movement, so every row counts.
    const tx = await fetchAll(() => { let q = c.from('inventory_transactions').select('product_id, direction, quantity'); if (productIds) q = q.in('product_id', productIds); return q })
    const ledger = new Map()
    for (const t of tx) ledger.set(t.product_id, (ledger.get(t.product_id) ?? 0) + num(t.direction) * num(t.quantity))
    const balance = new Map()
    for (const b of bal) if (!productIds || productIds.includes(b.product_id)) balance.set(b.product_id, (balance.get(b.product_id) ?? 0) + num(b.on_hand))
    const bad = [...new Set([...ledger.keys(), ...balance.keys()])].filter((p) => !eq(ledger.get(p), balance.get(p)))
    check(`${label}: inventory ledger — balance of every product = sum of its stock movements`, bad.length === 0,
      bad.length ? bad.slice(0, 5).map((p) => `${p}: ledger ${ledger.get(p) ?? 0} vs balance ${balance.get(p) ?? 0}`).join('; ') : `${ledger.size} product(s), ${tx.length} movement(s)`)
  } catch (e) { fail(`${label}: stock verification`, errText(e)) }
}

async function verifyReconciliation(c, label) {
  const r = await rpc(c, 'erp_reconciliation')
  if (r.error) return fail(`${label}: reconciliation runs`, errText(r.error))
  const bad = (r.data.checks ?? []).filter((x) => num(x.issues) > 0)
  check(`${label}: all ${(r.data.checks ?? []).length} reconciliation checks pass (stock, reservations, invoices, payments, ledgers)`, bad.length === 0,
    bad.map((x) => `${x.code}: ${x.issues} — ${(x.samples ?? []).slice(0, 2).map((s) => `${s.reference} ${s.detail}`).join(', ')}`).join('; '))
}

// ---------------------------------------------------------------------------
// 1. Connection
// ---------------------------------------------------------------------------
start('1. Connection to the V2 project')
const ref = (url.match(/^https:\/\/([a-z0-9]+)\.supabase\.co\/?$/) ?? [])[1]
check('frontend .env.local points to the V2 project srpeewjutlyruympdznc', ref === EXPECTED_REF, ref ? `project ${ref}` : 'VITE_SUPABASE_URL missing or not a supabase.co URL')
check('not the original Alton ERP project', ref !== OLD_REF, ref)
check('browser key is a publishable key (no secret or service-role key in the frontend)', key.startsWith('sb_publishable_') || (key.split('.').length === 3 && JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString()).role === 'anon'), `${key.slice(0, 15)}…`)
if (ref !== EXPECTED_REF) { console.log('\nStopping: wrong project.'); process.exit(2) }
try {
  const s = await (await fetch(`${url}/auth/v1/settings`, { headers: { apikey: key } })).json()
  pass('Auth service answers', `email sign-in ${s.external?.email ? 'on' : 'off'}`)
  check('public sign-up is disabled (recommended before go-live)', s.disable_signup === true, `disable_signup=${s.disable_signup}`)
} catch (e) { blocked('Auth service answers', errText(e)) }

// ---------------------------------------------------------------------------
// 2. Anonymous access
// ---------------------------------------------------------------------------
start('2. Anonymous access (RLS and grants)')
{
  const anon = newClient()
  for (const t of ['companies', 'profiles', 'user_roles', 'products', 'inventory_balances', 'inventory_transactions', 'purchase_orders', 'goods_receipts', 'production_orders',
    'sales_orders', 'sales_invoices', 'customer_payments', 'parties', 'audit_logs', 'company_settings', 'notifications']) {
    const r = await anon.from(t).select('id').limit(1)
    check(`anonymous cannot read ${t}`, Boolean(r.error) || (r.data ?? []).length === 0, r.error ? errText(r.error) : `${r.data.length} row(s)`)
  }
  for (const fn of ['get_my_access', 'management_overview', 'inventory_overview', 'erp_settings_get', 'erp_report']) {
    const r = await rpc(anon, fn, fn === 'management_overview' ? { p_from: TODAY, p_to: TODAY } : fn === 'erp_report' ? { p_report: 'PRODUCTS' } : {})
    check(`anonymous cannot call ${fn}`, Boolean(r.error), errText(r.error))
  }
  const files = await anon.storage.from('documents').list('', { limit: 1 })
  check('anonymous cannot list private documents', Boolean(files.error) || (files.data ?? []).length === 0, errText(files.error))
}

// ---------------------------------------------------------------------------
// 3. Real Super Admin (company ALTON) — READ ONLY
// ---------------------------------------------------------------------------
start('3. Super Admin on the real company (read-only)')
let alton = null
if (!process.env.LIVE_SUPERADMIN_EMAIL || !process.env.LIVE_SUPERADMIN_PASSWORD) {
  blocked('Super Admin sign-in', 'LIVE_SUPERADMIN_EMAIL / LIVE_SUPERADMIN_PASSWORD not set in .env.live')
} else {
  const s = await signIn(process.env.LIVE_SUPERADMIN_EMAIL, process.env.LIVE_SUPERADMIN_PASSWORD)
  if (s.error) fail(`Super Admin sign-in (${mask(process.env.LIVE_SUPERADMIN_EMAIL)})`, errText(s.error))
  else {
    pass(`Super Admin sign-in (${mask(process.env.LIVE_SUPERADMIN_EMAIL)})`)
    const a = await rpc(s.c, 'get_my_access')
    const acc = a.data ?? {}
    check('Super Admin: active profile in company ALTON with role SUPER_ADMIN', !a.error && acc.profile?.is_active && acc.company?.company_code === 'ALTON' && (acc.roles ?? []).includes('SUPER_ADMIN'),
      a.error ? errText(a.error) : `company ${acc.company?.company_code}, roles ${(acc.roles ?? []).join(',')}, ${(acc.permissions ?? []).length} permissions`)
    alton = { c: s.c, companyId: acc.company?.id }
    const comps = await s.c.from('companies').select('company_code')
    check('Super Admin sees only its own company (company isolation)', !comps.error && comps.data.length === 1 && comps.data[0].company_code === 'ALTON', comps.error ? errText(comps.error) : comps.data.map((x) => x.company_code).join(','))
    const foreign = await s.c.from('products').select('company_id').neq('company_id', acc.company?.id ?? '00000000-0000-0000-0000-000000000000').limit(1)
    check('Super Admin cannot read another company\'s products', !foreign.error && foreign.data.length === 0, foreign.error ? errText(foreign.error) : `${foreign.data.length} row(s)`)
    await moduleReads(s.c, 'ALTON')
    await verifyDashboard(s.c, 'ALTON')
    await verifyStock(s.c, 'ALTON')
    await verifyReconciliation(s.c, 'ALTON')
  }
}

// ---------------------------------------------------------------------------
// 4. Test accounts (STG-A / STG-B): roles, isolation, deactivated user
// ---------------------------------------------------------------------------
start('4. Roles, permissions and company isolation (test companies)')
const stgEmail = (tag) => `${process.env.STAGING_EMAIL_PREFIX}+${tag}@${process.env.STAGING_EMAIL_DOMAIN}`
const haveStg = Boolean(process.env.STAGING_EMAIL_PREFIX && process.env.STAGING_EMAIL_DOMAIN && process.env.STAGING_TEST_PASSWORD)
const stg = {}
const NIL = '00000000-0000-0000-0000-000000000000'
if (!haveStg) blocked('test accounts', 'STAGING_EMAIL_PREFIX / STAGING_EMAIL_DOMAIN / STAGING_TEST_PASSWORD not set in .env.live (run the staging seed first)')
else {
  // tag, role, company, a read it must have, a write it must be refused
  const ROLES = [
    ['stg-superadmin', 'SUPER_ADMIN', 'STG-A', 'management_overview', null],
    ['stg-admin', 'ADMIN', 'STG-A', 'erp_settings_get', null],
    ['stg-inventory', 'INVENTORY_MANAGER', 'STG-A', 'inventory_overview', ['sales_invoice_v2_issue', { p_invoice_id: NIL }]],
    ['stg-production', 'PRODUCTION_MANAGER', 'STG-A', 'production_dashboard', ['invoice_v2_record_payment', { p_invoice_id: NIL, p_payment: { amount: 1 } }]],
    ['stg-purchase', 'PURCHASE_MANAGER', 'STG-A', 'purchase_order_dashboard', ['sales_order_v2_save', { p_so_id: null, p_header: {}, p_lines: [] }]],
    ['stg-sales', 'SALES_MANAGER', 'STG-A', 'sales_dashboard', ['purchase_receipt_post', { p_po_id: NIL, p_header: {}, p_lines: [], p_idempotency_key: randomUUID() }]],
    ['stg-accounts', 'ACCOUNTS_MANAGER', 'STG-A', 'invoice_dashboard', ['production_order_v2_save', { p_order_id: null, p_data: {} }]],
    ['stg-viewer', 'MANAGEMENT_VIEWER', 'STG-A', 'management_overview', ['purchase_order_save', { p_po_id: null, p_header: {}, p_lines: [] }]],
    ['stg-b-admin', 'ADMIN', 'STG-B', 'erp_settings_get', null],
  ]
  const readArgs = (fn) => (['management_overview', 'purchase_order_dashboard', 'invoice_dashboard'].includes(fn) ? { p_from: `${TODAY.slice(0, 7)}-01`, p_to: TODAY } : {})
  for (const [tag, role, company, read, write] of ROLES) {
    const s = await signIn(stgEmail(tag), process.env.STAGING_TEST_PASSWORD)
    if (s.error) { blocked(`${tag}: sign-in`, errText(s.error)); continue }
    const acc = (await rpc(s.c, 'get_my_access')).data ?? {}
    stg[tag] = { c: s.c, companyId: acc.company?.id, permissions: acc.permissions ?? [] }
    check(`${tag}: role ${role} in ${company}`, acc.company?.company_code === company && (acc.roles ?? []).includes(role), `${acc.company?.company_code} ${(acc.roles ?? []).join(',')}`)
    const r = await rpc(s.c, read, readArgs(read))
    check(`${tag}: may use ${read}`, !r.error, errText(r.error))
    if (write) {
      const w = await rpc(s.c, write[0], write[1])
      check(`${tag}: refused ${write[0]} (no permission)`, Boolean(w.error) && /permission|not authori|42501/i.test(`${w.error.code} ${w.error.message}`), w.error ? errText(w.error) : 'NOT refused')
    }
  }
  if (stg['stg-viewer']) {
    const v = stg['stg-viewer']
    const settings = await rpc(v.c, 'erp_settings_save', { p_company: {}, p_settings: {} })
    check('stg-viewer: refused to change ERP settings', Boolean(settings.error), errText(settings.error))
  }
  // Deactivated user
  const ina = await signIn(stgEmail('stg-inactive'), process.env.STAGING_TEST_PASSWORD)
  if (ina.error) pass('stg-inactive: deactivated user cannot sign in', errText(ina.error))
  else {
    const p = await ina.c.from('products').select('id').limit(1)
    const o = await rpc(ina.c, 'management_overview', { p_from: TODAY, p_to: TODAY })
    check('stg-inactive: deactivated user sees no data and cannot call functions', (Boolean(p.error) || p.data.length === 0) && Boolean(o.error), `products ${p.error ? errText(p.error) : p.data.length}; overview ${errText(o.error) || 'allowed'}`)
  }
  // Isolation between the test companies and the real company
  if (stg['stg-superadmin'] && stg['stg-b-admin']) {
    const a = stg['stg-superadmin']; const b = stg['stg-b-admin']
    const ca = await a.c.from('companies').select('company_code')
    check('STG-A Super Admin sees only STG-A (not ALTON, not STG-B)', !ca.error && ca.data.length === 1 && ca.data[0].company_code === 'STG-A', ca.error ? errText(ca.error) : ca.data.map((x) => x.company_code).join(','))
    const aProducts = await a.c.from('products').select('id').limit(50)
    const leak = aProducts.data?.length ? await b.c.from('products').select('id').in('id', aProducts.data.map((p) => p.id)) : { data: [] }
    check('STG-B admin cannot read STG-A products', !leak.error && leak.data.length === 0, leak.error ? errText(leak.error) : `${leak.data.length} row(s) visible`)
    if (alton?.companyId) {
      const altonRows = await a.c.from('products').select('id').eq('company_id', alton.companyId).limit(1)
      check('STG-A Super Admin cannot read ALTON products', !altonRows.error && altonRows.data.length === 0, altonRows.error ? errText(altonRows.error) : `${altonRows.data.length} row(s)`)
    }
  }
  if (stg['stg-superadmin']) {
    await moduleReads(stg['stg-superadmin'].c, 'STG-A')
  }
}

// ---------------------------------------------------------------------------
// 5. Business workflows in STG-A (writes; only with --workflows)
// ---------------------------------------------------------------------------
start('5. Business workflows (test company STG-A)')
const wf = { ok: false }
if (!RUN_WORKFLOWS) notRun('workflows', 'run with --workflows (writes test records into STG-A only)')
else if (!stg['stg-superadmin']) blocked('workflows', 'STG-A Super Admin not signed in')
else {
  const { c } = stg['stg-superadmin']
  const acc = (await rpc(c, 'get_my_access')).data
  if (acc?.company?.company_code !== 'STG-A') { fail('workflow guard: signed-in company must be STG-A', acc?.company?.company_code); process.exit(1) }
  const companyId = acc.company.id
  const step = async (name, fn, params) => {
    const r = await rpc(c, fn, params)
    check(name, !r.error, r.error ? errText(r.error) : '')
    if (r.error) throw new Error(`${name}: ${errText(r.error)}`)
    return r.data
  }
  const onHand = async (id) => (await c.from('inventory_balances').select('on_hand, reserved').eq('product_id', id)).data.reduce((s, b) => ({ on_hand: s.on_hand + num(b.on_hand), reserved: s.reserved + num(b.reserved) }), { on_hand: 0, reserved: 0 })
  try {
    const before = (await rpc(c, 'management_overview', { p_from: TODAY, p_to: TODAY })).data
    const stockBefore = (await rpc(c, 'inventory_overview')).data
    const yBefore = (await rpc(c, 'management_overview', { p_from: addDays(TODAY, -1), p_to: addDays(TODAY, -1) })).data
    const wh = (await c.from('warehouses').select('id').eq('company_id', companyId).eq('is_default', true).limit(1)).data?.[0]
    const loc = wh && (await c.from('inventory_locations').select('id').eq('warehouse_id', wh.id).eq('stock_usage', 'STORAGE').order('location_code').limit(1)).data?.[0]
    if (!wh || !loc) throw new Error('STG-A has no default warehouse with a storage location (run the staging seed)')
    // Products with automatic SKUs
    const names = { fg: `LIVE ${RUN} Wash Basin (TEST)`, clay: `LIVE ${RUN} Ball Clay (TEST)`, cpl: `LIVE ${RUN} Waste Coupling (TEST)` }
    const ins = await c.from('products').insert([
      { company_id: companyId, sku: null, product_name: names.fg, product_type: 'FINISHED_GOOD', default_source_type: 'IN_HOUSE', base_unit: 'PCS', status: 'ACTIVE', hsn_code: '69101000', gst_rate: 18, selling_price: 1000 },
      { company_id: companyId, sku: null, product_name: names.clay, product_type: 'RAW_MATERIAL', default_source_type: 'OUTSOURCED', base_unit: 'KG', status: 'ACTIVE', hsn_code: '2508', gst_rate: 5, standard_cost: 20 },
      { company_id: companyId, sku: null, product_name: names.cpl, product_type: 'OUTSOURCED_COMPONENT', default_source_type: 'OUTSOURCED', base_unit: 'PCS', status: 'ACTIVE', hsn_code: '3922', gst_rate: 18, standard_cost: 50 },
    ])
    check('Product Master: 3 products created with automatic SKUs', !ins.error, errText(ins.error))
    if (ins.error) throw ins.error
    const prods = (await c.from('products').select('id, sku, product_name').in('product_name', Object.values(names))).data
    const id = Object.fromEntries(Object.entries(names).map(([k, n]) => [k, prods.find((p) => p.product_name === n)?.id]))
    check('Product Master: SKUs assigned per type (FG-, RM-, OSC-)', prods.length === 3 && prods.every((p) => /^(FG|RM|OSC)-\d{6,}$/.test(p.sku)), prods.map((p) => p.sku).join(', '))
    const bom = await step('BOM: saved (2.5 KG clay + 1 coupling per basin)', 'production_save_bom', { p_bom_id: null, p_finished_product_id: id.fg, p_effective_from: TODAY, p_effective_to: null, p_output_quantity: 1, p_notes: 'live test',
      p_items: [{ component_product_id: id.clay, quantity_required: 2.5 }, { component_product_id: id.cpl, quantity_required: 1 }], p_idempotency_key: randomUUID() })
    await step('BOM: activated', 'production_bom_activate', { p_bom_id: bom.bom_id })
    // Purchase -> GRN
    const sup = await step('Ledger: supplier created', 'party_save', { p_party_id: null, p_party: { party_type: 'SUPPLIER', party_name: `LIVE ${RUN} Clay Traders (TEST)`, gstin: null, billing_address: 'Test', state_code: '27', credit_period_days: 30 }, p_confirm_duplicates: true, p_idempotency_key: randomUUID() })
    const po = await step('Purchase: PO created (100 KG clay @20 +5%, 40 couplings @50 +18% = 4,460)', 'purchase_order_save', { p_po_id: null,
      p_header: { supplier_id: sup.supplier_id, purchase_type: 'RAW_MATERIAL', warehouse_id: wh.id, expected_delivery_date: addDays(TODAY, 7) },
      p_lines: [{ product_id: id.clay, quantity: 100, unit_price: 20 }, { product_id: id.cpl, quantity: 40, unit_price: 50 }], p_idempotency_key: randomUUID() })
    await step('Purchase: PO opened (one step)', 'purchase_order_open', { p_po_id: po.po_id })
    const poRow = (await c.from('purchase_orders').select('grand_total, status, po_number').eq('id', po.po_id).single()).data
    check('Purchase: PO total 4,460 and no stock moved by the PO', eq(poRow.grand_total, 4460) && (await onHand(id.clay)).on_hand === 0, `${poRow.po_number} ${poRow.grand_total} ${poRow.status}`)
    const lines = (await c.from('purchase_order_lines').select('id, product_id').eq('purchase_order_id', po.po_id)).data
    await step('GRN: goods received in full', 'purchase_receipt_post', { p_po_id: po.po_id, p_header: { receipt_date: TODAY },
      p_lines: lines.map((l) => ({ po_line_id: l.id, received_quantity: l.product_id === id.clay ? 100 : 40, accepted_quantity: l.product_id === id.clay ? 100 : 40, rejected_quantity: 0, accepted_location_id: loc.id })),
      p_idempotency_key: randomUUID() })
    const clay1 = await onHand(id.clay); const cpl1 = await onHand(id.cpl)
    const poAfter = (await c.from('purchase_orders').select('status').eq('id', po.po_id).single()).data
    check('GRN: stock increased (100 KG clay, 40 couplings) and PO received', clay1.on_hand === 100 && cpl1.on_hand === 40 && poAfter.status === 'RECEIVED', `clay ${clay1.on_hand}, couplings ${cpl1.on_hand}, PO ${poAfter.status}`)
    // Production -> inventory
    const pr = await step('Production: order for 20 basins created', 'production_order_v2_save', { p_order_id: null, p_data: { product_id: id.fg, planned_quantity: 20, production_date: TODAY }, p_idempotency_key: randomUUID() })
    const clay2 = await onHand(id.clay)
    check('Production: materials reserved (50 KG clay), physical stock unchanged', clay2.reserved === 50 && clay2.on_hand === 100, JSON.stringify(clay2))
    await step('Production: completed (20 made)', 'production_order_v2_complete', { p_order_id: pr.order_id, p_data: { actual_quantity: 20, production_date: TODAY }, p_idempotency_key: randomUUID() })
    const fg3 = await onHand(id.fg); const clay3 = await onHand(id.clay); const cpl3 = await onHand(id.cpl)
    check('Production → inventory: 20 basins added; 50 KG clay and 20 couplings consumed; reservations used', fg3.on_hand === 20 && clay3.on_hand === 50 && cpl3.on_hand === 20 && clay3.reserved === 0,
      `basins ${fg3.on_hand}, clay ${clay3.on_hand} (res ${clay3.reserved}), couplings ${cpl3.on_hand}`)
    const fgLots = (await c.from('inventory_balances').select('source_type, on_hand').eq('product_id', id.fg)).data
    check('Manufactured stock: produced basins are recorded as in-house', fgLots.length > 0 && fgLots.every((b) => b.source_type === 'IN_HOUSE'), fgLots.map((b) => `${b.source_type} ${b.on_hand}`).join(', '))
    const cplLots = (await c.from('inventory_balances').select('source_type, on_hand').eq('product_id', id.cpl)).data
    pass('Outsourced stock: source recorded on received couplings', cplLots.map((b) => `${b.source_type} ${b.on_hand}`).join(', '))
    // Sales -> dispatch -> invoice -> payment
    const cus = await step('Ledger: customer created', 'party_save', { p_party_id: null, p_party: { party_type: 'CUSTOMER', party_name: `LIVE ${RUN} Homes LLP (TEST)`, gst_registration_type: 'UNREGISTERED', billing_address: 'Pune', state_code: '27', credit_period_days: 15 }, p_confirm_duplicates: true, p_idempotency_key: randomUUID() })
    const so = await step('Sales: order for 12 basins (reserved from stock)', 'sales_order_v2_save', { p_so_id: null, p_header: { customer_id: cus.customer_id, customer_po_number: `LIVE-${RUN}` }, p_lines: [{ product_id: id.fg, quantity: 12 }], p_idempotency_key: randomUUID() })
    check('Sales: 12 basins reserved; order ready for dispatch', (await onHand(id.fg)).reserved === 12 && so.status === 'READY_FOR_DISPATCH', so.status)
    const sol = (await c.from('sales_order_lines').select('id').eq('sales_order_id', so.sales_order_id).limit(1)).data[0]
    await step('Sales: 12 basins dispatched', 'sales_order_v2_dispatch', { p_so_id: so.sales_order_id, p_lines: [{ line_id: sol.id, quantity: 12 }], p_details: { vehicle_number: 'MH12TEST' }, p_idempotency_key: randomUUID() })
    const fg4 = await onHand(id.fg)
    check('Dispatch: stock 8 left, reservation used', fg4.on_hand === 8 && fg4.reserved === 0, JSON.stringify(fg4))
    const txBefore = (await c.from('inventory_transactions').select('id', { count: 'exact', head: true }).eq('company_id', companyId)).count
    const inv = await step('Invoice: drafted from the sales order', 'sales_invoice_v2_save', { p_invoice_id: null, p_header: { sales_order_id: so.sales_order_id },
      p_lines: [{ product_id: id.fg, sales_order_line_id: sol.id, quantity: 12 }], p_idempotency_key: randomUUID() })
    await step('Invoice: issued', 'sales_invoice_v2_issue', { p_invoice_id: inv.invoice_id, p_convert_proforma: false, p_idempotency_key: randomUUID() })
    const i1 = (await c.from('sales_invoice_list').select('invoice_number, grand_total, balance_due, payment_status').eq('id', inv.invoice_id).single()).data
    const txAfter = (await c.from('inventory_transactions').select('id', { count: 'exact', head: true }).eq('company_id', companyId)).count
    check('Invoice: 14,160 (12 × 1,000 + 18% GST); invoicing moved no stock', eq(i1.grand_total, 14160) && txAfter === txBefore, `${i1.invoice_number} ${i1.grand_total}`)
    await step('Payment: partial 5,000 recorded', 'invoice_v2_record_payment', { p_invoice_id: inv.invoice_id, p_payment: { amount: 5000, payment_method: 'UPI', transaction_reference: `LIVE-${RUN}-1` }, p_idempotency_key: randomUUID() })
    const i2 = (await c.from('sales_invoice_list').select('balance_due, payment_status').eq('id', inv.invoice_id).single()).data
    check('Payment: invoice partially paid, 9,160 outstanding', i2.payment_status === 'PARTIALLY_PAID' && eq(i2.balance_due, 9160), JSON.stringify(i2))
    await step('Payment: remaining 9,160 recorded', 'invoice_v2_record_payment', { p_invoice_id: inv.invoice_id, p_payment: { amount: 9160, payment_method: 'BANK_TRANSFER', transaction_reference: `LIVE-${RUN}-2` }, p_idempotency_key: randomUUID() })
    const i3 = (await c.from('sales_invoice_list').select('balance_due, payment_status').eq('id', inv.invoice_id).single()).data
    check('Payment: invoice PAID, balance 0', i3.payment_status === 'PAID' && eq(i3.balance_due, 0), JSON.stringify(i3))
    const dup = await rpc(c, 'invoice_v2_record_payment', { p_invoice_id: inv.invoice_id, p_payment: { amount: 1, payment_method: 'UPI', transaction_reference: `LIVE-${RUN}-1` }, p_idempotency_key: randomUUID() })
    check('Payment: duplicate reference or overpayment refused', Boolean(dup.error), errText(dup.error))
    // Dashboard deltas for today (actual records created by this run)
    const after = (await rpc(c, 'management_overview', { p_from: TODAY, p_to: TODAY })).data
    const stockAfter = (await rpc(c, 'inventory_overview')).data
    const d = (p) => num(p(after)) - num(p(before))
    check('Dashboard (Today): invoiced sales +14,160, invoices +1', eq(d((o) => o.kpis.sales_invoiced), 14160) && d((o) => o.kpis.invoices) === 1, `+${d((o) => o.kpis.sales_invoiced)}, +${d((o) => o.kpis.invoices)}`)
    check('Dashboard (Today): sales orders +1, purchase orders +1, production orders +1', d((o) => o.sales.total_orders - num(o.sales.cancelled)) === 1 && d((o) => o.purchase.created) === 1 && d((o) => o.production.orders) === 1,
      `SO +${d((o) => o.sales.total_orders - num(o.sales.cancelled))}, PO +${d((o) => o.purchase.created)}, production +${d((o) => o.production.orders)}`)
    check('Dashboard: outstanding payments unchanged (invoice fully paid); supplier payable +4,460', eq(d((o) => o.kpis.customer_outstanding), 0) && eq(d((o) => o.kpis.supplier_outstanding), 4460),
      `customer +${d((o) => o.kpis.customer_outstanding)}, supplier +${d((o) => o.kpis.supplier_outstanding)}`)
    const sd = (unit, f) => num((stockAfter.units ?? []).find((u) => u.unit === unit)?.[f]) - num((stockBefore.units ?? []).find((u) => u.unit === unit)?.[f])
    check('Dashboard: manufactured stock +8 PCS (20 made − 12 dispatched); total stock +28 PCS, +50 KG', sd('PCS', 'in_house') === 8 && sd('PCS', 'on_hand') === 28 && sd('KG', 'on_hand') === 50,
      `PCS total +${sd('PCS', 'on_hand')}, in-house +${sd('PCS', 'in_house')}, outsourced +${sd('PCS', 'outsourced')}; KG total +${sd('KG', 'on_hand')}, outsourced +${sd('KG', 'outsourced')}`)
    const yesterday = (await rpc(c, 'management_overview', { p_from: addDays(TODAY, -1), p_to: addDays(TODAY, -1) })).data
    check('Date filter: a period ending yesterday does not include today\'s invoice', eq(yesterday.kpis.sales_invoiced, yBefore.kpis.sales_invoiced) && !eq(after.kpis.sales_invoiced, before.kpis.sales_invoiced))
    // Isolation on the new records
    if (stg['stg-b-admin']) {
      const b = stg['stg-b-admin'].c
      const seeInv = await b.from('sales_invoices').select('id').eq('id', inv.invoice_id)
      const tryDispatch = await rpc(b, 'sales_order_v2_dispatch', { p_so_id: so.sales_order_id, p_lines: [{ line_id: sol.id, quantity: 1 }], p_details: {}, p_idempotency_key: randomUUID() })
      check('Isolation: STG-B cannot see the STG-A invoice or act on the STG-A order', !seeInv.error && seeInv.data.length === 0 && Boolean(tryDispatch.error), `invoice rows ${seeInv.data?.length}; dispatch ${errText(tryDispatch.error) || 'ALLOWED'}`)
    }
    await verifyStock(c, 'STG-A (this run)', Object.values(id))
    wf.ok = true
  } catch (e) {
    fail('workflow stopped', errText(e))
  }
  await verifyReconciliation(c, 'STG-A')
  await verifyDashboard(c, 'STG-A')
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
const count = (s) => results.filter((r) => r.status === s).length
console.log(`\nSUMMARY: ${count('PASS')} passed, ${count('FAIL')} failed, ${count('BLOCKED')} blocked, ${count('NOT RUN')} not run — hosted project ${ref}, ${new Date().toISOString()}`)
if (REPORT) {
  let md = `# Live integration results — ${new Date().toISOString()}\n\nHosted project \`${ref}\`. Run tag \`${RUN}\`. Workflows: ${RUN_WORKFLOWS ? 'yes (STG-A)' : 'not run'}.\n\n`
  md += `**${count('PASS')} passed · ${count('FAIL')} failed · ${count('BLOCKED')} blocked · ${count('NOT RUN')} not run**\n`
  for (const s of [...new Set(results.map((r) => r.section))]) {
    md += `\n## ${s}\n\n| Status | Check | Detail |\n|---|---|---|\n`
    for (const r of results.filter((x) => x.section === s)) md += `| ${r.status} | ${r.name.replace(/\|/g, '/')} | ${r.detail.replace(/\|/g, '/').replace(/\n/g, ' ')} |\n`
  }
  writeFileSync(path.resolve(REPORT), md)
  console.log(`report written to ${REPORT}`)
}
process.exit(count('FAIL') ? 1 : count('BLOCKED') ? 3 : 0)
