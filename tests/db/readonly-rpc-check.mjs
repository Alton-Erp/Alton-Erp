// PostgREST runs RPCs declared STABLE or IMMUTABLE inside a READ ONLY
// transaction. A function that writes (directly or through a helper) then fails
// on the hosted API with "cannot execute INSERT in a read-only transaction",
// although it works in the normal test suites (which call it read-write).
//
//   npm run test:db:readonly
//
// 1. static check: no public STABLE/IMMUTABLE function (latest definition)
//    writes data, directly or through the functions it calls
// 2. runtime check on PGlite: the read-only RPCs used by ERP Settings and the
//    imports run as a signed-in Super Admin inside a READ ONLY transaction

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const dir = path.join(root, 'supabase', 'migrations')
const files = readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()
let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ` ${detail}`}`)
  if (!ok) failed++
}

// --- 1. Static check ----------------------------------------------------------
const fns = new Map()
for (const f of files) {
  const sql = readFileSync(path.join(dir, f), 'utf8')
  const re = /create\s+or\s+replace\s+function\s+((?:public|private)\.\w+)\s*\(([\s\S]*?)\)\s*returns([\s\S]*?)\sas\s+\$(\w*)\$([\s\S]*?)\$\4\$/gi
  let m
  while ((m = re.exec(sql))) {
    const header = m[3].toLowerCase()
    fns.set(m[1].toLowerCase(), {
      name: m[1].toLowerCase(), file: f, body: m[5].toLowerCase(),
      vol: /\bimmutable\b/.test(header) ? 'immutable' : /\bstable\b/.test(header) ? 'stable' : 'volatile',
    })
  }
  // Later "alter function ... volatile|stable" statements change the volatility.
  for (const a of sql.matchAll(/alter\s+function\s+((?:public|private)\.\w+)\s*\([^)]*\)\s+(volatile|stable|immutable)\s*;/gi)) {
    const fn = fns.get(a[1].toLowerCase())
    if (fn) fn.vol = a[2].toLowerCase()
  }
}
const WRITE = /\b(insert\s+into|update\s+(public|private)\.|delete\s+from|truncate\s|create\s+temp(orary)?\s+table|nextval\s*\(|setval\s*\(|pg_advisory_xact_lock)/
const writes = (b) => WRITE.test(b.replace(/--.*$/gm, ''))
const calls = (b) => [...b.matchAll(/\b((?:public|private)\.\w+)\s*\(/g)].map((x) => x[1])
const memo = new Map()
function writer(name, seen = new Set()) {
  if (memo.has(name)) return memo.get(name)
  if (seen.has(name)) return null
  seen.add(name)
  const f = fns.get(name)
  if (!f) return null
  let out = null
  if (writes(f.body)) out = [name]
  else for (const c of calls(f.body)) {
    if (c === name) continue
    const w = writer(c, seen)
    if (w) { out = [name, ...w]; break }
  }
  memo.set(name, out)
  return out
}
console.log('Read-only RPCs (PostgREST runs STABLE / IMMUTABLE functions read-only)')
const offenders = [...fns.values()].filter((f) => f.vol !== 'volatile' && f.name.startsWith('public.')).map((f) => [f, writer(f.name)]).filter(([, w]) => w)
check(`static: no read-only public function writes (${fns.size} functions scanned)`, offenders.length === 0,
  offenders.map(([f, w]) => `${f.vol} ${w.join(' -> ')} [${f.file}]`).join('; '))

// --- 2. Runtime check -----------------------------------------------------------
const db = new PGlite()
await db.exec(readFileSync(path.join(root, 'supabase', 'tests', 'local_supabase_shim.sql'), 'utf8'))
for (const f of files) await db.exec(readFileSync(path.join(dir, f), 'utf8'))
const COMPANY = 'e7e5cb00-0000-4000-8000-0000000000a1'
const USER = 'e7e5cb00-0000-4000-8000-000000000001'
await db.exec(`
  insert into public.companies (id, legal_name, display_name, company_code, gstin) values ('${COMPANY}', 'Read Only Check Pvt Ltd', 'ROC', 'ROCK', '27AAACP1234A1Z5');
  insert into auth.users (id, email) values ('${USER}', 'roc@example.invalid');
  update public.profiles set company_id = '${COMPANY}', is_active = true where id = '${USER}';
  insert into public.user_roles (user_id, company_id, role_id) select '${USER}', '${COMPANY}', id from public.roles where code = 'SUPER_ADMIN';
  insert into public.products (company_id, sku, product_name, product_type, default_source_type, base_unit, status)
  values ('${COMPANY}', 'ROC-1', 'Read-only check product', 'COMPONENT', 'IN_HOUSE', 'PCS', 'ACTIVE');`)
check('fixture: the company has no invoice settings row yet (first visit to ERP Settings)',
  (await db.query(`select count(*)::int n from public.invoice_settings where company_id = '${COMPANY}'`)).rows[0].n === 0)

// Each call runs as PostgREST would: authenticated role, JWT claims, READ ONLY.
async function readOnlyCall(label, sql) {
  let error = null
  try {
    await db.exec(`begin read only;
      set local role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${USER}","role":"authenticated"}', true);`)
    await db.query(sql)
  } catch (e) {
    error = e.message
  }
  await db.exec('rollback').catch(() => {})
  check(`runtime: ${label} runs in a read-only transaction`, error === null, error ?? '')
}
const volatility = async (fn) => (await db.query(`select provolatile from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and proname = $1`, [fn])).rows[0]?.provolatile
for (const [fn, sql] of [
  ['erp_settings_get', 'select public.erp_settings_get()'],
  ['erp_preferences', 'select public.erp_preferences()'],
  ['invoice_import_preview', `select public.invoice_import_preview('[{"invoice_number":"T-1","invoice_date":"2026-11-01","customer_name":"X","sku":"Y","quantity":1,"rate":1}]'::jsonb)`],
  ['inventory_reorder_plan', 'select public.inventory_reorder_plan(90)'],
  ['erp_report_v2', `select public.erp_report_v2('PRODUCTS', '{}'::jsonb)`],
  ['inventory_stock_position', `select public.inventory_stock_position('{}'::jsonb)`],
  ['inventory_reconciliation', 'select public.inventory_reconciliation(null)'],
  ['invoice_dispatch_exceptions', 'select public.invoice_dispatch_exceptions()'],
  ['product_group_head_options', 'select public.product_group_head_options()'],
  ['sales_invoice_tracking', `select public.sales_invoice_tracking('{"pending_only": false}'::jsonb)`],
  ['invite_role_catalog', 'select public.invite_role_catalog()'],
  ['user_invitations_list', 'select public.user_invitations_list()'],
  ['my_invitation', 'select public.my_invitation()'],
  ['erp_form_draft_get', `select public.erp_form_draft_get('purchase.order', null, '')`],
  ['erp_form_drafts_mine', 'select public.erp_form_drafts_mine()'],
  ['product_version_history', `select public.product_version_history((select id from public.products where company_id = '${COMPANY}' limit 1))`],
  ['erp_report_v2 STOCK_MOVEMENTS', `select public.erp_report_v2('STOCK_MOVEMENTS', '{}'::jsonb)`],
  ['erp_report_v2 MATERIAL_CONSUMPTION', `select public.erp_report_v2('MATERIAL_CONSUMPTION', '{}'::jsonb)`],
  ['production_report', `select count(*) from public.production_report('COST_SUMMARY', current_date - 30, current_date)`],
]) {
  // Volatile functions get a read-write transaction from PostgREST; only read-only ones are run read-only here.
  if ((await volatility(fn)) === 'v') { check(`runtime: ${fn} is VOLATILE (PostgREST runs it read-write)`, true); continue }
  await readOnlyCall(fn, sql)
}

// The settings screen as a whole: read (read-write as PostgREST now does for a volatile function), save, read back.
await db.exec(`begin; set local role authenticated; select set_config('request.jwt.claims', '{"sub":"${USER}","role":"authenticated"}', true);`)
const got = (await db.query('select public.erp_settings_get() r')).rows[0].r
await db.query(`select public.erp_settings_save('{"phone":"+91 20 5555 0101"}'::jsonb, '{"numbering.po_prefix":"PUR"}'::jsonb)`)
const again = (await db.query('select public.erp_settings_get() r')).rows[0].r
await db.exec('commit')
check('runtime: ERP settings load company, settings, defaults, counters and warehouses',
  got.company?.id === COMPANY && got.settings && got.defaults && got.counters && Array.isArray(got.warehouses), JSON.stringify(Object.keys(got)))
check('runtime: a saved change is returned on the next load', again.company.phone === '+91 20 5555 0101' && again.settings['numbering.po_prefix'] === 'PUR',
  JSON.stringify({ phone: again.company.phone, po: again.settings['numbering.po_prefix'] }))

console.log(failed === 0 ? '✓ read-only RPC check passed' : `✗ read-only RPC check: ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
