// Alton Accounts Phase 0 (migrations 20261231090000 + 20261231090100): chart of accounts, settings and periods,
// vouchers (draft, validate, post, discard, reverse), numbering, immutability and the transaction-bound token,
// RLS / RBAC / company isolation, service-role restrictions, automatic posting (idempotency, mapping, retry,
// dismissal, reversals, reconciliation with the ERP ledgers), opening balances (reconciliation, approval,
// posting), reports (drafts and discarded vouchers excluded), reset registries, rollback and re-apply.
//
//   npm run test:db:accounting                      PGlite (PostgreSQL 18, single connection)
//   ACCOUNTING_PG_URL=postgres://... ACCOUNTING_PG_MODULE=<path to the pg package> npm run test:db:accounting
//                                                   a real, EMPTY, disposable PostgreSQL server (e.g. 17, the
//                                                   production major version): same checks plus true
//                                                   multi-connection concurrency (duplicate posting, numbering,
//                                                   reversal, posting runs). Never point it at a real database.

import { createHash, randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p) => readFile(p, 'utf8')
const migDir = path.join(root, 'supabase', 'migrations')
const rbDir = path.join(root, 'supabase', 'rollback')
const FOUNDATION = '20261231090000_accounting_foundation'
const AUTO = '20261231090100_accounting_auto_posting'
const CC = '20261231090200_accounting_cost_centres'
const PI = '20261231090300_accounting_purchase_invoices'
const BC = '20261231090400_accounting_bank_cash'
const GT = '20261231090500_accounting_gst'
const G2B = '20261231090600_accounting_gst_2b'
const GR = '20261231090700_accounting_gst_returns'
const GE = '20261231090800_accounting_gst_close'
const PG_URL = process.env.ACCOUNTING_PG_URL

// ---- database adapter: PGlite, or a real PostgreSQL server through the pg package ------------------------------
let Pg = null
async function openDb() {
  if (!PG_URL) {
    const { PGlite } = await import('@electric-sql/pglite')
    const db = new PGlite()
    return { db, label: 'PGlite', close: () => db.close() }
  }
  if (!Pg) Pg = createRequire(path.join(process.env.ACCOUNTING_PG_MODULE ?? root, 'x.js'))('pg')
  const client = new Pg.Client({ connectionString: PG_URL })
  await client.connect()
  const db = {
    exec: (sql) => client.query(sql),
    query: (sql, params) => client.query(sql, params),
  }
  return { db, client, label: 'PostgreSQL', close: () => client.end() }
}

// The test shim; on a real server the API roles are cluster-wide and may already exist from an earlier run.
const shimSql = async () => (await read(path.join(root, 'supabase', 'tests', 'local_supabase_shim.sql')))
  .replace(/create role (anon|authenticated|service_role)[^;]*;/g, (m) => PG_URL ? `do $$ begin ${m} exception when duplicate_object then null; end $$;` : m)

let failed = 0
let passed = 0
const ok = (name, cond, detail = '') => {
  if (cond) passed++
  else failed++
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 900)}`}`)
}

const files = (await readdir(migDir)).filter((x) => x.endsWith('.sql')).sort()
const before = files.filter((x) => x < `${FOUNDATION}.sql`)
const after = files.filter((x) => x > `${AUTO}.sql`)

const main = await openDb()
const db = main.db
if (PG_URL) {
  const empty = (await db.query(`select count(*)::int as n from pg_namespace where nspname in ('auth', 'private', 'rls_test')`)).rows[0].n
  if (empty !== 0) { console.error('✗ ACCOUNTING_PG_URL must point at an EMPTY disposable database.'); process.exit(1) }
  const v = (await db.query('show server_version')).rows[0].server_version
  console.log(`Running on PostgreSQL ${v}`)
}
await db.exec(await shimSql())
for (const f of before) await db.exec(await read(path.join(migDir, f)))
let suite = await read(path.join(root, 'supabase', 'tests', 'stage7_e2e_verification.sql'))
suite = suite.slice(0, suite.lastIndexOf('\ndo $$'))
await db.exec(suite)
await db.exec('commit')

const val = async (sql, params) => { await db.exec('reset role'); return Object.values((await db.query(sql, params)).rows[0] ?? {})[0] }
const rows = async (sql, params) => { await db.exec('reset role'); return (await db.query(sql, params)).rows }
async function requestOn(conn, user, sql, params, { commit = true } = {}) {
  await conn.exec('reset role')
  await conn.exec('begin')
  try {
    if (user === 'service_role') {
      await conn.exec('set local role service_role')
    } else {
      const uid = Object.values((await conn.query(`select rls_test.id($1) as id`, [user])).rows[0])[0]
      await conn.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: 'authenticated' })])
      await conn.exec('set local role authenticated')
    }
    const r = await conn.query(sql, params ?? undefined)
    if (commit) await conn.exec('commit')
    return { value: Object.values(r.rows[0] ?? {})[0], rows: r.rows }
  } catch (e) {
    try { await conn.exec('rollback') } catch { /* ended */ }
    return { error: e.message, code: e.code }
  }
}
const request = (user, sql, params) => requestOn(db, user, sql, params)
const as = (user) => async (sql, params) => { const r = await request(user, sql, params); if (r.error) throw new Error(`${user}: ${sql.slice(0, 100)}… → ${r.error}`); return r.value }
const refused = async (user, sql, params, pattern) => {
  const r = await request(user, sql, params)
  if (r.error && (!pattern || pattern.test(r.error))) return true
  console.log('      got:', r.error ?? `no error (${JSON.stringify(r.value)?.slice(0, 200)})`)
  return false
}
const ownerRefused = async (sql, pattern) => {
  await db.exec('reset role')
  await db.exec('begin')
  try { await db.exec(sql); await db.exec('rollback'); console.log('      got: no error'); return false } catch (e) {
    try { await db.exec('rollback') } catch { /* ended */ }
    if (!pattern || pattern.test(e.message)) return true
    console.log('      got:', e.message); return false
  }
}
const addUser = async (key, uuid, roleCode, company = 'company_a') => {
  await db.exec(`reset role;
    insert into rls_test.ids (key, id) values ('${key}', '${uuid}');
    insert into auth.users (id, email) values (rls_test.id('${key}'), '${key}@acc.example.invalid');
    update public.profiles set company_id = rls_test.id('${company}'), is_active = true, full_name = '${key}' where id = rls_test.id('${key}');
    insert into public.user_roles (user_id, company_id, role_id) select rls_test.id('${key}'), rls_test.id('${company}'), id from public.roles where code = '${roleCode}'`)
}
await addUser('acct', 'acc00000-0000-4000-8000-0000000000a1', 'ACCOUNTS_MANAGER')
await addUser('acct2', 'acc00000-0000-4000-8000-0000000000a2', 'ACCOUNTS_MANAGER')
await addUser('viewer', 'acc00000-0000-4000-8000-0000000000a3', 'MANAGEMENT_VIEWER')
await addUser('sales', 'acc00000-0000-4000-8000-0000000000a4', 'SALES_MANAGER')
await addUser('admin', 'acc00000-0000-4000-8000-0000000000a5', 'ADMIN')
const A = await val(`select rls_test.id('company_a')::text`)
const B = await val(`select rls_test.id('company_b')::text`)
const acct = as('acct')
const op = as('op')

// ---- business data before the migration (must stay exactly as it is) -----------------------------------------
const businessFingerprint = () => val(`select md5(string_agg(t, '|' order by t)) from (
  select 'inv' || id || status || grand_total || coalesce(updated_at::text, '') as t from public.sales_invoices
  union all select 'pay' || id || status || amount_received from public.customer_payments
  union all select 'grn' || id || status from public.goods_receipts
  union all select 'spay' || id || status || amount from public.supplier_payments
  union all select 'note' || id || status from public.invoice_adjustment_notes
  union all select 'party' || id || opening_balance || coalesce(updated_at::text, '') from public.parties
  union all select 'tx' || id || quantity from public.inventory_transactions) x`)
let businessBefore = await businessFingerprint()
const triggersBefore = await val(`select count(*)::int from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and not t.tgisinternal and c.relname not like 'accounting%' and c.relname not like 'purchase_invoice%' and c.relname not like 'bank_%' and c.relname not like 'gst_%'
  and c.relname not in ('accounts', 'account_groups', 'supplier_payment_allocations')`)

for (let i = 0; i < 2; i++) {
  await db.exec(await read(path.join(migDir, `${FOUNDATION}.sql`)))
  await db.exec(await read(path.join(migDir, `${AUTO}.sql`)))
}
for (const f of after) await db.exec(await read(path.join(migDir, f)))
console.log(`✓ ${FOUNDATION} and ${AUTO} applied twice (${main.label})`)

console.log('\nA. Permissions, set-up and isolation')
ok('12 accounting permissions exist', await val(`select count(*)::int from public.permissions where code in ('accounts.read', 'accounts.manage', 'vouchers.read',
  'vouchers.create', 'vouchers.post', 'vouchers.reverse', 'accounting_opening.import', 'accounting_opening.approve', 'accounting_period.close',
  'accounting_reports.read', 'accounting_settings.manage', 'accounting_posting.manage')`) === 12)
const permsOf = (role) => val(`select coalesce(string_agg(p.code, ',' order by p.code), '') from public.role_permissions rp join public.roles r on r.id = rp.role_id
  join public.permissions p on p.id = rp.permission_id where r.code = $1 and (p.resource in ('accounts', 'vouchers') or p.resource like 'accounting%') and p.resource <> 'accounting_budgets'`, [role])
ok('role matrix: Accounts Manager has all 12; Super Admin all; Management Viewer read-only; Admin read + settings; Sales Manager none',
  (await permsOf('ACCOUNTS_MANAGER')).split(',').length === 12 && (await permsOf('SUPER_ADMIN')).split(',').length === 12
  && await permsOf('MANAGEMENT_VIEWER') === 'accounting_reports.read,accounts.read,vouchers.read'
  && await permsOf('ADMIN') === 'accounting_reports.read,accounting_settings.manage,accounts.read,vouchers.read' && await permsOf('SALES_MANAGER') === '')
ok('business tables: no row changed; the only trigger added is the Phase 3 goods-receipt reversal lock', triggersBefore + 1 === await val(`select count(*)::int from pg_trigger t join pg_class c on c.oid = t.tgrelid
  join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and not t.tgisinternal and c.relname not like 'accounting%' and c.relname not like 'purchase_invoice%' and c.relname not like 'bank_%' and c.relname not like 'gst_%'
  and c.relname not in ('accounts', 'account_groups', 'supplier_payment_allocations')`)
  && await val(`select count(*)::int from pg_trigger where tgname = 'goods_receipts_invoice_lock' and tgrelid = 'public.goods_receipts'::regclass`) === 1
  && businessBefore === await businessFingerprint())
ok('not set up: status says so and a voucher is refused', (await acct(`select public.accounting_status()`)).initialized === false
  && await refused('acct', `select public.accounting_voucher_create('{"voucher_date":"2026-04-01","lines":[]}'::jsonb)`, null, /not set up/))
ok('a user without accounting_settings.manage cannot set up accounting', await refused('sales', `select public.accounting_initialize(current_date)`, null, /not allowed/)
  && await refused('viewer', `select public.accounting_initialize(current_date)`, null, /not allowed/))
const today = await val(`select private.company_today($1::uuid)::text`, [A])
const fyStart = await val(`select private.accounting_fy_start($1::date, 4)::text`, [today])
const init = await acct(`select public.accounting_initialize($1::date)`, [fyStart])
ok('initialize: books start = start of the current FY, April-March, INR, chart (23 ledgers incl. Phase 3 and Phase 5 GST) / 13 types (Phase 4 CTR, BNK; Phase 5 GST) / 20 rules / 12 periods seeded', init.initialized && init.settings.fy_start_month === 4
  && init.settings.currency_code === 'INR' && await val(`select count(*)::int from public.account_groups where company_id = $1`, [A]) === 25
  && await val(`select count(*)::int from public.accounts where company_id = $1`, [A]) === 23
  && await val(`select count(*)::int from public.accounting_voucher_types where company_id = $1`, [A]) === 13
  && await val(`select count(*)::int from public.accounting_posting_rules where company_id = $1`, [A]) === 20
  && await val(`select count(*)::int from public.accounting_periods where company_id = $1`, [A]) === 12, init)
ok('no payment method is mapped to a cash / bank account by default (never assumed)',
  await val(`select count(*)::int from public.accounting_posting_rules where company_id = $1 and rule_key in ('RECEIPT_ACCOUNT', 'SUPPLIER_PAYMENT_ACCOUNT')`, [A]) === 0)
ok('initialize twice is refused', await refused('acct', `select public.accounting_initialize($1::date)`, [fyStart], /already set up/))
ok('company B is not set up and sees nothing of company A (RLS)', (await as('b_op')(`select public.accounting_status()`)).initialized === false
  && (await request('b_op', `select count(*)::int from public.accounts`)).value === 0 && (await request('b_op', `select count(*)::int from public.accounting_settings`)).value === 0)
ok('RLS: a member without accounting permissions reads no accounting rows', (await request('sales', `select count(*)::int from public.accounts`)).value === 0
  && (await request('sales', `select count(*)::int from public.account_groups`)).value === 0)

console.log('\nB. Chart of accounts')
const id = (sql, params) => val(sql, params)
const grp = (code) => id(`select id::text from public.account_groups where company_id = $1 and group_code = $2`, [A, code])
const accId = (code) => id(`select id::text from public.accounts where company_id = $1 and account_code = $2`, [A, code])
const bank = (await acct(`select public.accounting_account_save(null, $1::jsonb)`, [JSON.stringify({ account_code: '1210', account_name: 'HDFC Current A/c', group_id: await grp('AS.CA.BANK'), account_nature: 'BANK' })])).id
const expense = (await acct(`select public.accounting_account_save(null, $1::jsonb)`, [JSON.stringify({ account_code: '6100', account_name: 'Office Expenses', group_id: await grp('EX.IND') })])).id
const rent = (await acct(`select public.accounting_account_save(null, $1::jsonb)`, [JSON.stringify({ account_code: '6200', account_name: 'Rent', group_id: await grp('EX.IND') })])).id
ok('ledger accounts created; classification taken from the group', await val(`select classification from public.accounts where id = $1`, [bank]) === 'ASSET'
  && await val(`select classification from public.accounts where id = $1`, [expense]) === 'EXPENSE')
ok('duplicate account code and duplicate name are refused',
  await refused('acct', `select public.accounting_account_save(null, $1::jsonb)`, [JSON.stringify({ account_code: '1210', account_name: 'Other', group_id: await grp('AS.CA.BANK') })], /already exists/)
  && await refused('acct', `select public.accounting_account_save(null, $1::jsonb)`, [JSON.stringify({ account_code: '1299', account_name: 'hdfc current a/c', group_id: await grp('AS.CA.BANK') })], /already exists/))
ok('Debtors / Creditors control accounts cannot be created by hand',
  await refused('acct', `select public.accounting_account_save(null, $1::jsonb)`, [JSON.stringify({ account_code: '1399', account_name: 'Debtors 2', group_id: await grp('AS.CA.DEB'), account_nature: 'RECEIVABLE_CONTROL' })], /control accounts/))
ok('Management Viewer and Sales Manager cannot change the chart',
  await refused('viewer', `select public.accounting_account_save(null, $1::jsonb)`, [JSON.stringify({ account_code: '7000', account_name: 'X', group_id: await grp('EX.IND') })], /not allowed/)
  && await refused('sales', `select public.accounting_chart()`, null, /not allowed/))
const g1 = (await acct(`select public.accounting_group_save(null, $1::jsonb)`, [JSON.stringify({ group_code: 'EX.ADM', group_name: 'Administrative Expenses', parent_group_id: await grp('EX.IND') })])).id
const g2 = (await acct(`select public.accounting_group_save(null, $1::jsonb)`, [JSON.stringify({ group_code: 'EX.ADM.OFF', group_name: 'Office Running', parent_group_id: g1 })])).id
ok('sub-groups inherit the parent classification', await val(`select classification from public.account_groups where id = $1`, [g2]) === 'EXPENSE')
ok('a group cannot be placed under its own sub-group (cycle)', await refused('acct', `select public.accounting_group_save($1::uuid, $2::jsonb)`,
  [g1, JSON.stringify({ group_name: 'Administrative Expenses', parent_group_id: g2 })], /own sub-groups/))
await acct(`select public.accounting_account_save(null, $1::jsonb)`, [JSON.stringify({ account_code: '6300', account_name: 'Stationery', group_id: g2 })])
ok('a group with accounts cannot move to another classification', await refused('acct', `select public.accounting_group_save($1::uuid, $2::jsonb)`,
  [g1, JSON.stringify({ group_name: 'Administrative Expenses', parent_group_id: await grp('IN.OTH') })], /classification/))
ok('system accounts cannot be deactivated', await refused('acct', `select public.accounting_account_set_active($1::uuid, false)`, [await accId('4100')], /System account/))

console.log('\nC. Vouchers: drafts, validation, posting, numbering')
const jv = (date, lines, extra = {}) => JSON.stringify({ voucher_date: date, narration: 'Test JV', ...extra, lines })
const d1 = await acct(`select public.accounting_voucher_create($1::jsonb)`, [jv(today, [{ account_id: expense, debit: '1000.50' }, { account_id: bank, credit: 1000.5 }])])
ok('draft created: no number, balanced, no issues', d1.status === 'DRAFT' && d1.voucher_number === null && Number(d1.total_debit) === 1000.5 && d1.issues.length === 0, d1)
const tb = async (from = fyStart, to = today) => acct(`select public.accounting_trial_balance($1::date, $2::date)`, [from, to])
ok('a draft does not reach the trial balance', (await tb()).rows.length === 0)
ok('lines: zero, negative, both sides, 3 decimals and text amounts are refused',
  await refused('acct', `select public.accounting_voucher_create($1::jsonb)`, [jv(today, [{ account_id: expense, debit: 0 }, { account_id: bank, credit: 1 }])], /either a debit or a credit/)
  && await refused('acct', `select public.accounting_voucher_create($1::jsonb)`, [jv(today, [{ account_id: expense, debit: -5 }, { account_id: bank, credit: 5 }])], /negative/)
  && await refused('acct', `select public.accounting_voucher_create($1::jsonb)`, [jv(today, [{ account_id: expense, debit: 5, credit: 5 }, { account_id: bank, credit: 5 }])], /either a debit or a credit/)
  && await refused('acct', `select public.accounting_voucher_create($1::jsonb)`, [jv(today, [{ account_id: expense, debit: '1.005' }, { account_id: bank, credit: 1 }])], /2 decimal/)
  && await refused('acct', `select public.accounting_voucher_create($1::jsonb)`, [jv(today, [{ account_id: expense, debit: '1e3' }, { account_id: bank, credit: 1 }])], /must be a number/))
const unb = await acct(`select public.accounting_voucher_create($1::jsonb)`, [jv(today, [{ account_id: expense, debit: 100 }, { account_id: bank, credit: 99.99 }])])
ok('unbalanced draft: validation explains it and posting is refused', unb.issues.some((i) => i.code === 'UNBALANCED')
  && await refused('acct', `select public.accounting_voucher_post($1::uuid)`, [unb.id], /does not equal total credit/))
const one = await acct(`select public.accounting_voucher_create($1::jsonb)`, [jv(today, [{ account_id: expense, debit: 100 }])])
ok('a single line is not postable (at least two lines, both sides)', one.issues.some((i) => i.code === 'MIN_LINES') && one.issues.some((i) => i.code === 'ONE_SIDED'))
const both = await acct(`select public.accounting_voucher_create($1::jsonb)`, [jv(today, [{ account_id: expense, debit: 100 }, { account_id: expense, credit: 100 }])])
ok('the same account on both sides is reported', both.issues.some((i) => i.code === 'SAME_ACCOUNT_BOTH_SIDES'))
const debtors = await accId('1300')
const ctl = await acct(`select public.accounting_voucher_create($1::jsonb)`, [jv(today, [{ account_id: debtors, debit: 100 }, { account_id: bank, credit: 100 }])])
ok('manual vouchers cannot post to the Debtors control account (and it needs a party)', ctl.issues.some((i) => i.code === 'ACCOUNT_NO_MANUAL')
  && ctl.issues.some((i) => i.code === 'PARTY_REQUIRED'))
const upd = await acct(`select public.accounting_voucher_update($1::uuid, $2::jsonb, $3)`, [unb.id, JSON.stringify({ lines: [{ account_id: expense, debit: 100 }, { account_id: bank, credit: 100 }] }), unb.row_version])
ok('draft editing: lines replaced, row version advances, now valid', upd.issues.length === 0 && upd.row_version === unb.row_version + 1)
ok('editing with a stale row version is refused', await refused('acct', `select public.accounting_voucher_update($1::uuid, '{"narration":"x"}'::jsonb, $2)`, [unb.id, unb.row_version], /changed by someone else/))
const lineAdd = await acct(`select public.accounting_voucher_line_save($1::uuid, null, $2::jsonb, null)`, [one.id, JSON.stringify({ account_id: bank, credit: 100 })])
ok('a line can be added to a draft', lineAdd.lines.length === 2 && lineAdd.issues.length === 0)
const lineDel = await acct(`select public.accounting_voucher_line_delete($1::uuid, $2::uuid, null)`, [one.id, lineAdd.lines[0].id])
ok('a line can be deleted; numbering stays consecutive', lineDel.lines.length === 1 && lineDel.lines[0].line_no === 1)

const p1 = await acct(`select public.accounting_voucher_post($1::uuid, $2)`, [d1.id, d1.row_version])
const fyLabel = await val(`select private.financial_year($1::date, 4)`, [today])
const fyShort = `${fyLabel.slice(2, 4)}-${fyLabel.slice(5, 7)}`
ok(`posted: number JV/${fyShort}/000001, totals stored`, p1.status === 'POSTED' && p1.voucher_number === `JV/${fyShort}/000001` && Number(p1.total_debit) === 1000.5, p1)
ok('posting again is refused (duplicate posting)', await refused('acct', `select public.accounting_voucher_post($1::uuid)`, [d1.id], /already posted/))
const p2 = await acct(`select public.accounting_voucher_post($1::uuid)`, [unb.id])
ok('numbering is consecutive per type and financial year', p2.voucher_number === `JV/${fyShort}/000002`)
let t = await tb()
ok('trial balance: posted vouchers only; debit = credit', Number(t.totals.closing_debit) === 1100.5 && Number(t.totals.closing_credit) === 1100.5
  && t.rows.length === 2, t.totals)
const disc = await acct(`select public.accounting_voucher_discard($1::uuid, 'entered twice')`, [both.id])
ok('discard: draft becomes DISCARDED; it cannot be edited or posted afterwards', disc.status === 'DISCARDED'
  && await refused('acct', `select public.accounting_voucher_post($1::uuid)`, [both.id], /already discarded/)
  && await refused('acct', `select public.accounting_voucher_update($1::uuid, '{"narration":"x"}'::jsonb, null)`, [both.id], /only drafts/))

console.log('\nD. Immutability, security token and direct-write protection')
ok('owner SQL: a posted voucher cannot be edited', await ownerRefused(`update public.accounting_vouchers set narration = 'changed' where id = '${d1.id}'`, /cannot be changed/))
ok('owner SQL: posted lines cannot be edited or deleted', await ownerRefused(`update public.accounting_voucher_lines set debit = 1 where voucher_id = '${d1.id}'`, /cannot be changed/)
  && await ownerRefused(`delete from public.accounting_voucher_lines where voucher_id = '${d1.id}'`, /cannot be changed/))
ok('owner SQL: vouchers are never deleted or truncated', await ownerRefused(`delete from public.accounting_vouchers where id = '${d1.id}'`, /never deleted/)
  && await ownerRefused(`truncate public.accounting_voucher_lines cascade`, /cannot be truncated/))
ok('owner SQL: status changes without a token are refused (post, reverse, discard)',
  await ownerRefused(`update public.accounting_vouchers set status = 'REVERSED', reversed_at = now(), reversal_reason = 'x' where id = '${d1.id}'`, /cannot be changed/)
  && await ownerRefused(`update public.accounting_vouchers set status = 'DISCARDED', discarded_at = now() where id = '${one.id}'`, /posting engine/))
ok('owner SQL: a forged token (wrong value, or issued in another transaction) is refused',
  await ownerRefused(`select set_config('app.accounting_token', gen_random_uuid()::text, true);
     update public.accounting_vouchers set status = 'DISCARDED', discarded_at = now() where id = '${one.id}'`, /posting engine/)
  && await ownerRefused(`insert into private.accounting_transition_tokens (token, txid, voucher_id, purpose) values ('11111111-2222-4333-8444-555555555555', txid_current() - 1, '${one.id}', 'DISCARD');
     select set_config('app.accounting_token', '11111111-2222-4333-8444-555555555555', true);
     update public.accounting_vouchers set status = 'DISCARDED', discarded_at = now() where id = '${one.id}'`, /posting engine/))
ok('owner SQL: a voucher cannot be inserted as POSTED', await ownerRefused(`insert into public.accounting_vouchers (company_id, voucher_type_id, financial_year, voucher_date, status, voucher_number, posted_at, total_debit, total_credit)
  select company_id, voucher_type_id, financial_year, voucher_date, 'POSTED', 'JV/X/1', now(), 1, 1 from public.accounting_vouchers where id = '${d1.id}'`, /created as a draft/))
ok('signed-in users have no direct write access to any accounting table',
  await refused('acct', `update public.accounting_vouchers set narration = 'x'`, null, /permission denied/)
  && await refused('acct', `insert into public.accounting_voucher_lines (company_id, voucher_id, line_no, account_id, debit) values ('${A}', '${one.id}', 9, '${bank}', 1)`, null, /permission denied/)
  && await refused('acct', `delete from public.accounts`, null, /permission denied/)
  && await refused('acct', `update public.accounting_settings set allow_future_dates = true`, null, /permission denied/)
  && await refused('acct', `select count(*) from public.accounting_voucher_sequences`, null, /permission denied/))
ok('service_role: no table access and no accounting RPC (cannot post or reverse)',
  await refused('service_role', `select count(*) from public.accounting_vouchers`, null, /permission denied/)
  && await refused('service_role', `update public.accounting_vouchers set status = 'REVERSED'`, null, /permission denied/)
  && await refused('service_role', `select public.accounting_voucher_post('${one.id}'::uuid)`, null, /permission denied/)
  && await refused('service_role', `select public.accounting_voucher_reverse('${d1.id}'::uuid, 'service role attempt')`, null, /permission denied/)
  && await refused('service_role', `select private.accounting_post_voucher('${one.id}'::uuid)`, null, /permission denied/))
ok('anon cannot call accounting RPCs', !(await val(`select has_function_privilege('anon', 'public.accounting_voucher_post(uuid, integer)', 'EXECUTE')`))
  && !(await val(`select has_function_privilege('anon', 'public.accounting_trial_balance(date, date, boolean)', 'EXECUTE')`)))
ok('the token table is unreachable for API roles', !(await val(`select has_table_privilege('authenticated', 'private.accounting_transition_tokens', 'INSERT')`))
  && !(await val(`select has_table_privilege('service_role', 'private.accounting_transition_tokens', 'INSERT')`))
  && await val(`select count(*)::int from private.accounting_transition_tokens`) === 0)

console.log('\nE. Permissions, isolation and segregation of duties')
ok('Management Viewer reads vouchers and reports but cannot create, post or reverse',
  (await as('viewer')(`select public.accounting_voucher_list('{}'::jsonb)`)).total >= 2
  && await refused('viewer', `select public.accounting_voucher_create($1::jsonb)`, [jv(today, [{ account_id: expense, debit: 1 }, { account_id: bank, credit: 1 }])], /not allowed/)
  && await refused('viewer', `select public.accounting_voucher_post($1::uuid)`, [one.id], /not allowed/)
  && await refused('viewer', `select public.accounting_voucher_reverse($1::uuid, 'viewer tries')`, [d1.id], /not allowed/))
ok('Sales Manager (no accounting permission) cannot read vouchers or reports',
  await refused('sales', `select public.accounting_voucher_list('{}'::jsonb)`, null, /not allowed/)
  && await refused('sales', `select public.accounting_trial_balance(current_date - 30, current_date)`, null, /not allowed/))
ok('company B cannot read, post, reverse or edit company A vouchers',
  await refused('b_op', `select public.accounting_voucher_get($1::uuid)`, [d1.id], /not found|not set up/)
  && await refused('b_op', `select public.accounting_voucher_post($1::uuid)`, [one.id], /not found|not set up/)
  && await refused('b_op', `select public.accounting_voucher_reverse($1::uuid, 'cross company')`, [d1.id], /not found|not set up/)
  && (await request('b_op', `select count(*)::int from public.accounting_vouchers`)).value === 0)
await as('b_op')(`select public.accounting_initialize($1::date)`, [fyStart])
const bBank = (await as('b_op')(`select public.accounting_account_save(null, $1::jsonb)`, [JSON.stringify({ account_code: '1210', account_name: 'B Bank',
  group_id: await val(`select id::text from public.account_groups where company_id = $1 and group_code = 'AS.CA.BANK'`, [B]), account_nature: 'BANK' })])).id
ok('company B set up separately (same codes allowed per company) and cannot use company A accounts',
  await refused('b_op', `select public.accounting_voucher_create($1::jsonb)`, [jv(today, [{ account_id: expense, debit: 1 }, { account_id: bBank, credit: 1 }])], /does not exist in this company/)
  && await refused('acct', `select public.accounting_voucher_create($1::jsonb)`, [jv(today, [{ account_id: bBank, debit: 1 }, { account_id: bank, credit: 1 }])], /does not exist in this company/))
await acct(`select public.accounting_settings_save('{"segregation_of_duties": true}'::jsonb)`)
const sod = await acct(`select public.accounting_voucher_create($1::jsonb)`, [jv(today, [{ account_id: rent, debit: 500 }, { account_id: bank, credit: 500 }])])
ok('segregation of duties (when on): the creator cannot post; another accountant can',
  await refused('acct', `select public.accounting_voucher_post($1::uuid)`, [sod.id], /Segregation of duties/)
  && (await as('acct2')(`select public.accounting_voucher_post($1::uuid)`, [sod.id])).status === 'POSTED')
await acct(`select public.accounting_settings_save('{"segregation_of_duties": false}'::jsonb)`)

console.log('\nF. Dates and periods')
const future = await val(`select ($1::date + 3)::text`, [today])
const fv = await acct(`select public.accounting_voucher_create($1::jsonb)`, [jv(future, [{ account_id: rent, debit: 10 }, { account_id: bank, credit: 10 }])])
ok('future dates are refused by default', fv.issues.some((i) => i.code === 'FUTURE_DATE'))
const early = await val(`select ($1::date - 1)::text`, [fyStart])
const ev = await acct(`select public.accounting_voucher_create($1::jsonb)`, [jv(early, [{ account_id: rent, debit: 10 }, { account_id: bank, credit: 10 }])])
ok('dates before the books start date are refused', ev.issues.some((i) => i.code === 'BEFORE_BOOKS_START'))
const period = await val(`select id::text from public.accounting_periods where company_id = $1 and $2::date between start_date and end_date`, [A, today])
ok('closing a period needs accounting_period.close', await refused('viewer', `select public.accounting_period_set_status($1::uuid, 'CLOSED')`, [period], /not allowed/))
await acct(`select public.accounting_period_set_status($1::uuid, 'CLOSED', 'month end')`, [period])
const cv = await acct(`select public.accounting_voucher_create($1::jsonb)`, [jv(today, [{ account_id: rent, debit: 20 }, { account_id: bank, credit: 20 }])])
ok('a closed period blocks posting', cv.issues.some((i) => i.code === 'PERIOD_CLOSED')
  && await refused('acct', `select public.accounting_voucher_post($1::uuid)`, [cv.id], /is closed/))
ok('reopening needs a reason', await refused('acct', `select public.accounting_period_set_status($1::uuid, 'REOPENED', '')`, [period], /reason/))
await acct(`select public.accounting_period_set_status($1::uuid, 'REOPENED', 'late supplier bill')`, [period])
ok('after reopening the voucher posts', (await acct(`select public.accounting_voucher_post($1::uuid)`, [cv.id])).status === 'POSTED')
await acct(`select public.accounting_settings_save('{"backdate_limit_days": 0}'::jsonb)`)
const yesterday = await val(`select greatest(($1::date - 1), $2::date)::text`, [today, fyStart])
const bv = await acct(`select public.accounting_voucher_create($1::jsonb)`, [jv(yesterday, [{ account_id: rent, debit: 5 }, { account_id: bank, credit: 5 }])])
ok('the back-dating limit (when set) applies to manual vouchers', yesterday === today || bv.issues.some((i) => i.code === 'BACKDATE_LIMIT'))
await acct(`select public.accounting_settings_save('{"backdate_limit_days": null}'::jsonb)`)
ok('the books start date cannot change once vouchers exist', await refused('acct', `select public.accounting_settings_save($1::jsonb)`, [JSON.stringify({ books_start_date: early })], /cannot change once vouchers exist/))

console.log('\nG. Reversal')
const rv = await acct(`select public.accounting_voucher_reverse($1::uuid, 'wrong expense head', null)`, [d1.id])
ok('reversal: linked opposite-entry voucher (REV series); original REVERSED with the reason', rv.original.status === 'REVERSED'
  && rv.reversal.voucher_number === `REV/${fyShort}/000001` && rv.reversal.reversal_of_voucher_id === d1.id && rv.original.reversed_by_voucher_id === rv.reversal.id
  && rv.reversal.lines.every((l, i) => Number(l.debit) === Number(rv.original.lines[i].credit) && Number(l.credit) === Number(rv.original.lines[i].debit))
  && rv.original.reversal_reason === 'wrong expense head', rv)
t = await tb()
const expRow = t.rows.find((r) => r.account_code === '6100')
ok('after reversal the reversed 1,000.50 nets out (only the other 100.00 JV remains); trial balance still balances',
  Number(expRow.closing_debit) === 100 && Number(expRow.period_debit) === 1100.5 && Number(expRow.period_credit) === 1000.5
  && Number(t.totals.closing_debit) === Number(t.totals.closing_credit), expRow)
ok('a voucher cannot be reversed twice; a reversal cannot be reversed; a reason is required; not before the original date',
  await refused('acct', `select public.accounting_voucher_reverse($1::uuid, 'again please')`, [d1.id], /already been reversed/)
  && await refused('acct', `select public.accounting_voucher_reverse($1::uuid, 'reverse the reversal')`, [rv.reversal.id], /itself a reversal/)
  && await refused('acct', `select public.accounting_voucher_reverse($1::uuid, 'no')`, [p2.id], /at least 5/)
  && await refused('acct', `select public.accounting_voucher_reverse($1::uuid, 'too early date', $2::date)`, [p2.id, early], /cannot be before/))
ok('drafts cannot be reversed', await refused('acct', `select public.accounting_voucher_reverse($1::uuid, 'draft reversal')`, [one.id], /Only posted/))
const audit = await rows(`select action from public.audit_logs where company_id = $1 and resource_type = 'accounting_voucher' and resource_id = $2 order by event_timestamp`, [A, d1.id])
ok('audit trail: created, posted and reversed are logged for the voucher', ['accounting.voucher.created', 'accounting.voucher.posted', 'accounting.voucher.reversed']
  .every((a) => audit.some((r) => r.action === a)), audit)
const got = await acct(`select public.accounting_voucher_get($1::uuid)`, [d1.id])
ok('voucher detail shows lines, totals, reversal link and audit history', got.lines.length === 2 && got.reversed_by_number === rv.reversal.voucher_number && got.audit.length >= 3)

console.log('\nH. Automatic posting')
const counts0 = await rows(`select source_type, status, count(*)::int as n from public.accounting_posting_events where company_id = $1 group by 1, 2`, [A])
ok('nothing is queued before the first run', counts0.length === 0)
ok('posting run needs accounting_posting.manage', await refused('viewer', `select public.accounting_posting_run(100)`, null, /not allowed/))
const run1 = await acct(`select public.accounting_posting_run(500)`)
const ev1 = await rows(`select source_type, event_action, status, error_code, count(*)::int as n from public.accounting_posting_events where company_id = $1 group by 1, 2, 3, 4 order by 1, 2, 3`, [A])
console.log('      first run:', JSON.stringify(run1.results), JSON.stringify(ev1))
const issued = await val(`select count(*)::int from public.sales_invoices where company_id = $1 and status in ('ISSUED', 'CANCELLED') and invoice_date >= $2::date`, [A, fyStart])
const receipts = await val(`select count(*)::int from public.customer_payments where company_id = $1 and receipt_date >= $2::date`, [A, fyStart])
const grns = await val(`select count(*)::int from public.goods_receipts where company_id = $1 and receipt_date >= $2::date`, [A, fyStart])
ok(`every eligible source document is queued once (invoices ${issued}, receipts ${receipts}, goods receipts ${grns})`,
  issued > 0 && receipts > 0 && grns > 0
  && await val(`select count(*)::int from public.accounting_posting_events where company_id = $1 and source_type = 'SALES_INVOICE' and event_action = 'POST'`, [A]) === issued
  && await val(`select count(*)::int from public.accounting_posting_events where company_id = $1 and source_type = 'CUSTOMER_RECEIPT' and event_action = 'POST'`, [A]) === receipts
  && await val(`select count(*)::int from public.accounting_posting_events where company_id = $1 and source_type = 'GOODS_RECEIPT' and event_action = 'POST'`, [A]) === grns)
const recordedReceipt = `select e.id from public.accounting_posting_events e join public.customer_payments p on p.id = e.source_id
  where e.company_id = '${A}' and e.event_action = 'POST' and p.status = 'RECORDED'`
ok('recorded receipts wait for a payment-method account mapping (NEEDS_ACCOUNT_MAPPING, no bank guessed)',
  await val(`select bool_and(status = 'NEEDS_ACCOUNT_MAPPING' and error_message like '%Customer receipts by%') from public.accounting_posting_events where id in (${recordedReceipt})`)
  && await val(`select count(*)::int from public.accounting_vouchers where company_id = $1 and source_type = 'CUSTOMER_RECEIPT'`, [A]) === 0)
ok('a receipt reversed before it could be posted: neither the receipt nor its reversal is posted (net zero)', await val(`select bool_and(e.status = 'SKIPPED')
  from public.accounting_posting_events e join public.customer_payments p on p.id = e.source_id where e.company_id = $1 and p.status = 'REVERSED'`, [A]))
ok('issued invoices are posted: Debtors (party) = grand total; Sales + output GST + round-off = grand total', await val(`
  select bool_and(v.status in ('POSTED', 'REVERSED') and v.total_debit = i.grand_total
    and (select sum(l.debit) from public.accounting_voucher_lines l join public.accounts a on a.id = l.account_id where l.voucher_id = v.id and a.system_key = 'DEBTORS_CONTROL'
         and l.party_id = (select id from public.parties where customer_id = i.customer_id)) = i.grand_total
    and coalesce((select sum(l.credit) from public.accounting_voucher_lines l join public.accounts a on a.id = l.account_id where l.voucher_id = v.id and a.system_key = 'SALES'), 0) = i.taxable_subtotal
    and coalesce((select sum(l.credit - l.debit) from public.accounting_voucher_lines l join public.accounts a on a.id = l.account_id where l.voucher_id = v.id
         and a.system_key in ('OUTPUT_CGST', 'OUTPUT_SGST', 'OUTPUT_IGST')), 0) = i.cgst_total + i.sgst_total + i.igst_total)
  from public.sales_invoices i join public.accounting_vouchers v on v.source_type = 'SALES_INVOICE' and v.source_id = i.id and v.source = 'AUTO'
  where i.company_id = $1`, [A]))
ok('goods receipts: Creditors (party) = ERP payable; Purchases + GST Input Pending = payable', await val(`
  select bool_and(v.total_credit = private.goods_receipt_value(g.id)
    and (select sum(l.credit) from public.accounting_voucher_lines l join public.accounts a on a.id = l.account_id where l.voucher_id = v.id and a.system_key = 'CREDITORS_CONTROL'
         and l.party_id = (select id from public.parties where supplier_id = g.supplier_id)) = private.goods_receipt_value(g.id)
    and (select sum(l.debit) from public.accounting_voucher_lines l join public.accounts a on a.id = l.account_id where l.voucher_id = v.id
         and a.system_key in ('PURCHASES', 'GST_INPUT_PENDING')) = private.goods_receipt_value(g.id))
  from public.goods_receipts g join public.accounting_vouchers v on v.source_type = 'GOODS_RECEIPT' and v.source_id = g.id and v.source = 'AUTO'
  where g.company_id = $1 and g.supplier_id is not null`, [A]))
ok('reversed goods receipts get a linked reversal voucher', await val(`select bool_and(e.status = 'POSTED' and r.reversal_of_voucher_id is not null)
  from public.goods_receipts g join public.accounting_posting_events e on e.source_id = g.id and e.event_action = 'REVERSE'
  join public.accounting_vouchers r on r.id = e.voucher_id where g.company_id = $1 and g.status = 'REVERSED'`, [A]) !== false
  && await val(`select count(*)::int from public.goods_receipts where company_id = $1 and status = 'REVERSED'`, [A])
     === await val(`select count(*)::int from public.accounting_posting_events where company_id = $1 and source_type = 'GOODS_RECEIPT' and event_action = 'REVERSE' and status = 'POSTED'`, [A]))
const mappingEvent = await val(`select id::text from public.accounting_posting_events where id in (${recordedReceipt}) limit 1`)
ok('retrying an unmapped event leaves it NEEDS_ACCOUNT_MAPPING', (await acct(`select public.accounting_posting_retry($1::uuid)`, [mappingEvent])).status === 'NEEDS_ACCOUNT_MAPPING')
ok('payment methods map only to cash / bank accounts', await refused('acct', `select public.accounting_posting_rule_save('RECEIPT_ACCOUNT', 'UPI', $1::uuid)`, [rent], /cash or bank/))
const methods = (await rows(`select distinct payment_method from public.customer_payments where company_id = $1`, [A])).map((r) => r.payment_method)
for (const m of methods) await acct(`select public.accounting_posting_rule_save('RECEIPT_ACCOUNT', $1, $2::uuid)`, [m, bank])
// Closed period: the receipts fail, are retried up to the limit, then wait for a manual retry.
await acct(`select public.accounting_settings_save('{"auto_posting_max_attempts": 2}'::jsonb)`)
await acct(`select public.accounting_period_set_status($1::uuid, 'CLOSED', 'month end')`, [period])
await acct(`select public.accounting_posting_run(500)`)
ok('posting into a closed period fails (FAILED, error kept, attempt counted)', await val(`select bool_and(status = 'FAILED' and error_message like '%closed%' and attempts = 1)
  from public.accounting_posting_events where id in (${recordedReceipt})`))
await acct(`select public.accounting_posting_run(500)`)
await acct(`select public.accounting_posting_run(500)`)
ok('automatic retries stop at the configured limit (2)', await val(`select max(attempts)::int from public.accounting_posting_events where id in (${recordedReceipt})`) === 2
  && await val(`select bool_and(status = 'FAILED') from public.accounting_posting_events where id in (${recordedReceipt})`))
await acct(`select public.accounting_period_set_status($1::uuid, 'REOPENED', 'post receipts')`, [period])
const failedIds = (await rows(`select id::text from public.accounting_posting_events where id in (${recordedReceipt})`)).map((r) => r.id)
for (const e of failedIds) await acct(`select public.accounting_posting_retry($1::uuid)`, [e])
ok('manual retry after reopening posts them (Dr mapped bank / Cr Debtors with the party)',
  await val(`select bool_and(e.status = 'POSTED' and v.total_debit = p.amount_received
     and exists (select 1 from public.accounting_voucher_lines l where l.voucher_id = v.id and l.account_id = '${bank}' and l.debit = p.amount_received)
     and exists (select 1 from public.accounting_voucher_lines l where l.voucher_id = v.id and l.account_id = '${debtors}' and l.credit = p.amount_received and l.party_id is not null))
   from public.accounting_posting_events e join public.customer_payments p on p.id = e.source_id join public.accounting_vouchers v on v.id = e.voucher_id
   where e.id in (${recordedReceipt})`))
// A posted receipt reversed in Billing afterwards: the next run posts a linked reversal dated the reversal date.
const toReverse = await val(`select source_id::text from public.accounting_posting_events where id in (${recordedReceipt}) limit 1`)
await op(`select public.customer_payment_reverse($1::uuid, 'cheque bounced (accounting test)', gen_random_uuid())`, [toReverse])
// A supplier payment recorded and then reversed in the Ledger, with and without a payment-method mapping.
const supplierId = await val(`select supplier_id::text from public.parties where company_id = $1 and supplier_id is not null limit 1`, [A])
const sp = await op(`select public.supplier_payment_record($1::uuid, $2::date, 1250.75, 'BANK_TRANSFER', 'UTR123', 'accounting test', gen_random_uuid())`, [supplierId, today])
await acct(`select public.accounting_posting_run(500)`)
ok('a supplier payment without a mapped bank account waits (NEEDS_ACCOUNT_MAPPING)', await val(`select status from public.accounting_posting_events where source_id = $1 and event_action = 'POST'`, [sp.payment_id]) === 'NEEDS_ACCOUNT_MAPPING')
await acct(`select public.accounting_posting_rule_save('SUPPLIER_PAYMENT_ACCOUNT', 'BANK_TRANSFER', $1::uuid)`, [bank])
await acct(`select public.accounting_posting_run(500)`)
ok('…and posts once mapped: Dr Creditors (party) / Cr bank', await val(`select bool_and(l.debit = 1250.75 and l.party_id is not null) from public.accounting_posting_events e
  join public.accounting_voucher_lines l on l.voucher_id = e.voucher_id join public.accounts a on a.id = l.account_id
  where e.source_id = $1 and e.event_action = 'POST' and a.system_key = 'CREDITORS_CONTROL'`, [sp.payment_id]))
await op(`select public.supplier_payment_reverse($1::uuid, 'paid to the wrong account')`, [sp.payment_id])
await acct(`select public.accounting_posting_run(500)`)
ok('reversed receipts and supplier payments get linked reversal vouchers (one each)', await val(`select count(*)::int from public.accounting_vouchers r
  join public.accounting_vouchers o on o.id = r.reversal_of_voucher_id where r.company_id = $1 and r.source = 'REVERSAL' and o.status = 'REVERSED'
  and r.source_id in ($2::uuid, $3::uuid)`, [A, toReverse, sp.payment_id]) === 2)
// The receipt and supplier-payment actions above were deliberate ERP actions; from here on the ERP data must not change.
businessBefore = await businessFingerprint()
const vouchersBefore = await val(`select count(*)::int from public.accounting_vouchers where company_id = $1`, [A])
const run3 = await acct(`select public.accounting_posting_run(500)`)
ok('idempotent: another scan and run queue and post nothing new', Number(run3.queued) === 0 && Number(run3.processed) === 0
  && vouchersBefore === await val(`select count(*)::int from public.accounting_vouchers where company_id = $1`, [A]))
ok('one automatic voucher per source document (database-enforced)', await ownerRefused(`select private.accounting_create_voucher('${A}', 'SAL', current_date, 'dup', 'dup', 'AUTO',
  'SALES_INVOICE', (select source_id from public.accounting_vouchers where company_id = '${A}' and source_type = 'SALES_INVOICE' limit 1), 'dup', null, '[]'::jsonb)`, /duplicate key|unique/))
const autoV = await val(`select id::text from public.accounting_vouchers where company_id = $1 and source = 'AUTO' and status = 'POSTED' limit 1`, [A])
ok('automatic vouchers cannot be reversed by hand (reverse the source document instead)', await refused('acct', `select public.accounting_voucher_reverse($1::uuid, 'manual attempt')`, [autoV], /cancel or reverse that document/))
// Ledger reconciliation: Debtors / Creditors per party equal the ERP receivable / payable movements since the books start date.
const recon = await rows(`select p.id, p.customer_id, p.supplier_id,
    coalesce((select sum(l.debit - l.credit) from public.accounting_voucher_lines l join public.accounting_vouchers v on v.id = l.voucher_id
      join public.accounts a on a.id = l.account_id where l.party_id = p.id and a.system_key = 'DEBTORS_CONTROL' and v.status in ('POSTED', 'REVERSED')), 0) as acc_recv,
    coalesce((select sum(grand_total) from public.sales_invoices where customer_id = p.customer_id and status = 'ISSUED'), 0)
      - coalesce((select sum(amount_received) from public.customer_payments where customer_id = p.customer_id and status = 'RECORDED'), 0)
      + coalesce((select sum(case note_type when 'DEBIT' then total_amount else -total_amount end) from public.invoice_adjustment_notes where customer_id = p.customer_id and status = 'ISSUED'), 0) as erp_recv,
    coalesce((select sum(l.credit - l.debit) from public.accounting_voucher_lines l join public.accounting_vouchers v on v.id = l.voucher_id
      join public.accounts a on a.id = l.account_id where l.party_id = p.id and a.system_key = 'CREDITORS_CONTROL' and v.status in ('POSTED', 'REVERSED')), 0) as acc_pay,
    case when p.supplier_id is null then 0 else private.supplier_payable(p.supplier_id) end as erp_pay
  from public.parties p where p.company_id = $1`, [A])
ok('reconciliation: Debtors and Creditors per party equal the ERP receivable and payable', recon.length > 0
  && recon.every((r) => Number(r.acc_recv) === Number(r.erp_recv) && Number(r.acc_pay) === Number(r.erp_pay)), recon)

// Foreign currency and pre-books-start documents (crafted directly by the database owner, test only).
const invSample = await val(`select id::text from public.sales_invoices where company_id = $1 and status = 'ISSUED' limit 1`, [A])
await db.exec(`reset role; set session_replication_role = replica;
  insert into public.sales_invoices select (jsonb_populate_record(i, jsonb_build_object('id', 'acc0ffee-0000-4000-8000-000000000001', 'invoice_number', 'USD-TEST-1', 'currency', 'USD'))).*
  from public.sales_invoices i where i.id = '${invSample}';
  insert into public.sales_invoices select (jsonb_populate_record(i, jsonb_build_object('id', 'acc0ffee-0000-4000-8000-000000000002', 'invoice_number', 'OLD-TEST-1',
    'invoice_date', '${early}', 'due_date', '${early}', 'status', 'CANCELLED', 'cancelled_at', now(), 'cancelled_by', i.issued_by, 'cancellation_reason', 'pre-books test'))).*
  from public.sales_invoices i where i.id = '${invSample}';
  set session_replication_role = origin;`)
await acct(`select public.accounting_posting_run(500)`)
ok('foreign-currency documents are not posted (FAILED / UNSUPPORTED_CURRENCY)', await val(`select status || '/' || error_code from public.accounting_posting_events
  where source_id = 'acc0ffee-0000-4000-8000-000000000001' and event_action = 'POST'`) === 'FAILED/UNSUPPORTED_CURRENCY')
ok('a pre-books-start document cancelled afterwards is flagged for manual correction (never guessed)',
  await val(`select count(*)::int from public.accounting_posting_events where source_id = 'acc0ffee-0000-4000-8000-000000000002' and event_action = 'POST'`) === 0
  && await val(`select status || '/' || error_code from public.accounting_posting_events where source_id = 'acc0ffee-0000-4000-8000-000000000002' and event_action = 'REVERSE'`) === 'FAILED/PRE_BOOKS_SOURCE')
const usdEvent = await val(`select id::text from public.accounting_posting_events where source_id = 'acc0ffee-0000-4000-8000-000000000001'`)
ok('dismissal needs a reason; a dismissed event is not processed again', await refused('acct', `select public.accounting_posting_dismiss($1::uuid, 'no')`, [usdEvent], /at least 5/)
  && (await acct(`select public.accounting_posting_dismiss($1::uuid, 'USD invoice: handled outside, see JV')`, [usdEvent])).status === 'DISMISSED'
  && await refused('acct', `select public.accounting_posting_retry($1::uuid)`, [usdEvent], /Only pending/))
await db.exec(`reset role; set session_replication_role = replica; delete from public.accounting_posting_events where source_id in ('acc0ffee-0000-4000-8000-000000000001', 'acc0ffee-0000-4000-8000-000000000002');
  delete from public.sales_invoices where id in ('acc0ffee-0000-4000-8000-000000000001', 'acc0ffee-0000-4000-8000-000000000002'); set session_replication_role = origin;`)
ok('business documents are still unchanged after posting runs', businessBefore === await businessFingerprint())

console.log('\nI. Opening balances')
const cust = await rows(`select id::text from public.parties where company_id = $1 and customer_id is not null order by party_code limit 1`, [A])
const supp = await rows(`select id::text from public.parties where company_id = $1 and supplier_id is not null order by party_code limit 1`, [A])
await db.exec(`reset role; update public.parties set opening_balance = 5000, opening_balance_type = 'RECEIVABLE', opening_balance_date = '${fyStart}' where id = '${cust[0].id}';
  update public.parties set opening_balance = 3000, opening_balance_type = 'PAYABLE', opening_balance_date = '${fyStart}' where id = '${supp[0].id}' and customer_id is null;`)
const ob = await acct(`select public.accounting_opening_batch_create('first opening')`)
ok('batch created as DRAFT dated the books start date; a second batch in progress is refused', ob.status === 'DRAFT' && ob.as_of_date === fyStart
  && await refused('acct', `select public.accounting_opening_batch_create(null)`, null, /already in progress/))
const pre = await acct(`select public.accounting_opening_prefill_parties($1::uuid)`, [ob.id])
ok('prefill adds one line per ERP party opening balance (explicitly, never automatically)', pre.lines_added === 2 && pre.lines.length === 2)
ok('prefilling again adds nothing (no duplicate Debtors / Creditors balances)', (await acct(`select public.accounting_opening_prefill_parties($1::uuid)`, [ob.id])).lines_added === 0)
const base = pre.lines.map((l) => ({ account_id: l.account_id, party_id: l.party_id, debit: l.debit, credit: l.credit }))
ok('import: unknown account code, duplicate accounts and bad amounts are refused with row numbers; nothing saved',
  await refused('acct', `select public.accounting_opening_lines_replace($1::uuid, $2::jsonb, 'IMPORT', 'ob.xlsx')`, [ob.id, JSON.stringify([...base, { account_code: '9999', debit: 1 }])], /Row 3: account 9999 not found/)
  && await refused('acct', `select public.accounting_opening_lines_replace($1::uuid, $2::jsonb)`, [ob.id, JSON.stringify([...base, { account_code: '1210', debit: 1 }, { account_code: '1210', debit: 2 }])], /appears 2 times/)
  && await refused('acct', `select public.accounting_opening_lines_replace($1::uuid, $2::jsonb)`, [ob.id, JSON.stringify([...base, { account_code: '1210', debit: 'abc' }])], /must be a number/)
  && (await acct(`select public.accounting_opening_batch_get($1::uuid)`, [ob.id])).lines.length === 2)
let obv = await acct(`select public.accounting_opening_lines_replace($1::uuid, $2::jsonb, 'IMPORT', 'opening.xlsx')`, [ob.id, JSON.stringify([...base,
  { account_code: '1210', debit: '20000', balance_category: 'CASH_BANK' }, { account_code: '3100', credit: '22000', balance_category: 'CAPITAL' }])])
const chk = (b, code) => b.checks.find((c) => c.code === code)
ok('reconciliation: balanced, parties match the ERP, inventory matches (no opening stock value)', chk(obv, 'BALANCED').status === 'PASS'
  && chk(obv, 'RECEIVABLE_MATCH').status === 'PASS' && chk(obv, 'PAYABLE_MATCH').status === 'PASS', obv.checks)
// Unbalanced and unreconciled versions.
obv = await acct(`select public.accounting_opening_lines_replace($1::uuid, $2::jsonb)`, [ob.id, JSON.stringify([
  { account_id: debtors, party_id: cust[0].id, debit: 4000 }, { account_code: '2100', party_code: await val(`select party_code from public.parties where id = $1`, [supp[0].id]), credit: 3000 },
  { account_code: '1210', debit: 20000 }, { account_code: '1400', debit: 750 }, { account_code: '3100', credit: 21000 }])])
ok('unbalanced batch: approval refused (never acknowledgeable)', chk(obv, 'BALANCED').status === 'FAIL'
  && await refused('acct', `select public.accounting_opening_approve($1::uuid, $2::jsonb)`, [ob.id, JSON.stringify([{ code: 'BALANCED', reason: 'please accept this' }])], /Total debit equals total credit/))
obv = await acct(`select public.accounting_opening_lines_replace($1::uuid, $2::jsonb)`, [ob.id, JSON.stringify([
  { account_id: debtors, party_id: cust[0].id, debit: 4000 }, { account_code: '2100', party_id: supp[0].id, credit: 3000 },
  { account_code: '1210', debit: 20000 }, { account_code: '1400', debit: 750 }, { account_code: '3100', credit: 21750 }])])
ok('balanced but unreconciled (Debtors 4,000 vs ERP 5,000; inventory 750 vs ERP 0): approval refused without acknowledgement',
  chk(obv, 'BALANCED').status === 'PASS' && chk(obv, 'RECEIVABLE_MATCH').status === 'FAIL' && Number(chk(obv, 'RECEIVABLE_MATCH').difference) === -1000
  && chk(obv, 'INVENTORY_MATCH').status === 'FAIL'
  && await refused('acct', `select public.accounting_opening_approve($1::uuid, '[]'::jsonb)`, [ob.id], /Not reconciled/)
  && await refused('acct', `select public.accounting_opening_approve($1::uuid, $2::jsonb)`, [ob.id, JSON.stringify([{ code: 'RECEIVABLE_MATCH', reason: 'short' }, { code: 'INVENTORY_MATCH', reason: 'short' }])], /at least 10/))
const noParty = await acct(`select public.accounting_opening_lines_replace($1::uuid, $2::jsonb)`, [ob.id, JSON.stringify([{ account_id: debtors, debit: 10 }, { account_code: '3100', credit: 10 }])])
ok('control-account lines without a party fail the PARTIES check (not acknowledgeable)', chk(noParty, 'PARTIES').status === 'FAIL' && chk(noParty, 'PARTIES').acknowledgeable === false)
obv = await acct(`select public.accounting_opening_lines_replace($1::uuid, $2::jsonb)`, [ob.id, JSON.stringify([
  { account_id: debtors, party_id: cust[0].id, debit: 4000 }, { account_code: '2100', party_id: supp[0].id, credit: 3000 },
  { account_code: '1210', debit: 20000 }, { account_code: '1400', debit: 750 }, { account_code: '3100', credit: 21750 }])])
const approved = await acct(`select public.accounting_opening_approve($1::uuid, $2::jsonb)`, [ob.id, JSON.stringify([
  { code: 'RECEIVABLE_MATCH', reason: '1,000 disputed with the customer; agreed balance is 4,000' }, { code: 'INVENTORY_MATCH', reason: 'Stock-in-transit valued at 750, not in ERP stock' }])])
ok('approved with documented acknowledgements; lines are then locked', approved.status === 'APPROVED' && approved.acknowledgements.length === 2
  && await ownerRefused(`update public.accounting_opening_balance_lines set debit = 1 where batch_id = '${ob.id}'`, /only be changed while the batch is a draft/)
  && await refused('acct', `select public.accounting_opening_lines_replace($1::uuid, '[]'::jsonb)`, [ob.id], /Only a draft/))
const posted = await acct(`select public.accounting_opening_post($1::uuid)`, [ob.id])
ok('posted as one OPN voucher dated the books start date', posted.status === 'POSTED' && posted.voucher_number === `OPN/${fyShort}/000001`
  && await val(`select voucher_date::text from public.accounting_vouchers where id = $1`, [posted.voucher_id]) === fyStart)
ok('posting twice, a new batch, and reversing the opening voucher are refused',
  await refused('acct', `select public.accounting_opening_post($1::uuid)`, [ob.id], /already been posted/)
  && await refused('acct', `select public.accounting_opening_batch_create(null)`, null, /already been posted/)
  && await refused('acct', `select public.accounting_voucher_reverse($1::uuid, 'undo opening')`, [posted.voucher_id], /opening balance voucher cannot be reversed/))
ok('ERP party opening balances are unchanged by the accounting opening', await val(`select opening_balance from public.parties where id = $1`, [cust[0].id]) === '5000.00')
ok('opening audit: created, lines saved, prefilled, approved, posted', await val(`select count(distinct action)::int from public.audit_logs
  where resource_type = 'accounting_opening_batch' and resource_id = $1 and action in ('accounting.opening.created', 'accounting.opening.lines_saved',
  'accounting.opening.prefilled', 'accounting.opening.approved', 'accounting.opening.posted')`, [ob.id]) === 5)

console.log('\nJ. Reports')
t = await tb()
ok('trial balance: opening + period movements; closing debit = closing credit', Number(t.totals.closing_debit) === Number(t.totals.closing_credit)
  && Number(t.totals.period_debit) === Number(t.totals.period_credit) && t.rows.some((r) => r.account_code === '3100' && Number(r.closing_credit) === 21750))
const allLines = await val(`select sum(l.debit)::text from public.accounting_voucher_lines l join public.accounting_vouchers v on v.id = l.voucher_id
  where v.company_id = $1 and v.status in ('POSTED', 'REVERSED')`, [A])
const draftAmt = await val(`select coalesce(sum(l.debit), 0)::text from public.accounting_voucher_lines l join public.accounting_vouchers v on v.id = l.voucher_id
  where v.company_id = $1 and v.status in ('DRAFT', 'DISCARDED')`, [A])
ok(`drafts and discarded vouchers (₹${draftAmt}) never reach the books`, Number(draftAmt) > 0 && Number(t.totals.period_debit) === Number(allLines))
const gl = await acct(`select public.accounting_general_ledger($1::uuid, $2::date, $3::date)`, [bank, fyStart, today])
const glLast = gl.entries.at(-1)
ok('general ledger: running balance ends at the closing balance; only posted / reversed vouchers', gl.entries.length > 0
  && Number(glLast.balance) === Number(gl.closing_balance) && Number(gl.closing_balance) === Number(await val(`select private.accounting_account_balance($1::uuid)`, [bank]))
  && gl.entries.every((e) => ['POSTED', 'REVERSED'].includes(e.status)))
const partyGl = await acct(`select public.accounting_general_ledger($1::uuid, $2::date, $3::date, $4::uuid)`, [debtors, fyStart, today, cust[0].id])
ok('general ledger by party (Debtors sub-ledger)', partyGl.entries.every((e) => e.party_id === cust[0].id) && partyGl.entries.length > 0)
const dbk = await acct(`select public.accounting_day_book($1::date, $2::date)`, [fyStart, today])
ok('day book: posted and reversed vouchers only, debit = credit', dbk.vouchers.every((v) => ['POSTED', 'REVERSED'].includes(v.status))
  && Number(dbk.totals.debit) === Number(dbk.totals.credit) && Number(dbk.totals.debit) === Number(allLines))
const reg = await acct(`select public.accounting_voucher_list('{"status":"DRAFT"}'::jsonb)`)
ok('voucher register filters (status, type, source, account, created by)', reg.rows.every((r) => r.status === 'DRAFT')
  && (await acct(`select public.accounting_voucher_list('{"voucher_type":"SAL"}'::jsonb)`)).rows.every((r) => r.voucher_type === 'SAL')
  && (await acct(`select public.accounting_voucher_list($1::jsonb)`, [JSON.stringify({ account_id: rent })])).total >= 2
  && (await acct(`select public.accounting_voucher_list($1::jsonb)`, [JSON.stringify({ created_by: await val(`select rls_test.id('acct2')::text`) })])).total === 0)
const dash = await as('viewer')(`select public.accounting_dashboard()`)
ok('dashboard (Management Viewer): counts and books totals; Sales Manager refused', dash.initialized && Number(dash.books.total_debit) === Number(dash.books.total_credit)
  && dash.vouchers.posted > 0 && await refused('sales', `select public.accounting_dashboard()`, null, /not allowed/))
ok('read-only RPCs run inside a READ ONLY transaction', await (async () => {
  await db.exec('reset role'); await db.exec('begin read only')
  try {
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: await (async () => (await db.query(`select rls_test.id('acct') as i`)).rows[0].i)(), role: 'authenticated' })])
    await db.exec('set local role authenticated')
    for (const q of [`select public.accounting_dashboard()`, `select public.accounting_chart()`, `select public.accounting_trial_balance(current_date - 400, current_date)`,
      `select public.accounting_voucher_list('{}'::jsonb)`, `select public.accounting_posting_events('{}'::jsonb)`, `select public.accounting_opening_batches()`,
      `select public.accounting_periods(null)`, `select public.accounting_status()`, `select public.accounting_posting_rules()`, `select public.accounting_cost_centres()`,
      `select public.accounting_accounts(null, false)`, `select public.accounting_parties(null, null)`, `select public.accounting_voucher_validate('${one.id}'::uuid)`, `select public.accounting_opening_batch_get('${ob.id}'::uuid)`]) await db.query(q)
    await db.exec('rollback'); return true
  } catch (e) { await db.exec('rollback').catch(() => {}); console.log('      got:', e.message); return false }
})())

const pp = await acct(`select public.accounting_parties(null, 'CUSTOMER')`)
ok('party picker: company parties only, filtered by type; refused without an accounting permission', pp.length > 0 && pp.every((x) => x.is_customer)
  && (await as('b_op')(`select public.accounting_parties(null, null)`)).length === 0
  && await refused('sales', `select public.accounting_parties(null, null)`, null, /not allowed/))

console.log('\nK. Cost centres (master only)')
const cc1 = (await acct(`select public.accounting_cost_centre_save(null, '{"cost_centre_code":"PROD","cost_centre_name":"Production"}'::jsonb)`)).id
const cc2 = (await acct(`select public.accounting_cost_centre_save(null, $1::jsonb)`, [JSON.stringify({ cost_centre_code: 'PROD-1', cost_centre_name: 'Line 1', parent_cost_centre_id: cc1 })])).id
ok('cost centres: hierarchy, duplicate code refused, no cycle', (await acct(`select public.accounting_cost_centres()`)).length === 2
  && await refused('acct', `select public.accounting_cost_centre_save(null, '{"cost_centre_code":"prod","cost_centre_name":"Dup"}'::jsonb)`, null, /already exists/)
  && await refused('acct', `select public.accounting_cost_centre_save($1::uuid, $2::jsonb)`, [cc1, JSON.stringify({ cost_centre_name: 'Production', parent_cost_centre_id: cc2 })], /under itself/))

console.log('\nP1. Manual journal vouchers (Phase 1 screens: the payloads the Journal Entry page sends)')
// Payload shape of src/features/accounting/accounting-model.ts journalPayload(): amounts as strings, null for the empty side.
const jvPayload = (lines, extra = {}) => JSON.stringify({ voucher_type: 'JV', voucher_date: today, reference_number: 'MEMO-7', narration: 'Month-end accruals', ...extra,
  lines: lines.map(([account_id, debit, credit, narration = null]) => ({ account_id, debit, credit, narration })) })
const salaries = (await acct(`select public.accounting_account_save(null, $1::jsonb)`, [JSON.stringify({ account_code: '6400', account_name: 'Salaries', group_id: await grp('EX.IND') })])).id
const payable = (await acct(`select public.accounting_account_save(null, $1::jsonb)`, [JSON.stringify({ account_code: '2300', account_name: 'Expenses Payable', group_id: await grp('LI.CL.PRV') })])).id
const tbOf = async (code) => (await tb()).rows.find((r) => r.account_code === code) ?? { period_debit: 0, period_credit: 0, closing_debit: 0, closing_credit: 0 }
const dayBookCount = async () => (await acct(`select public.accounting_day_book($1::date, $2::date, 'JV')`, [today, today])).vouchers.length
const tbBefore = await tb()
const dbBefore = await dayBookCount()
const j1 = await acct(`select public.accounting_voucher_create($1::jsonb)`, [jvPayload([[salaries, '45000.00', null, 'June salaries'], [rent, '12000.50', null],
  [expense, '0.50', null], [payable, null, '50000.00'], [bank, null, '7001.00', 'paid in cash at bank']])])
ok('draft with 3 debit and 2 credit lines, line narrations kept, balanced, no number', j1.status === 'DRAFT' && j1.voucher_number === null && j1.lines.length === 5
  && j1.lines[0].narration === 'June salaries' && Number(j1.total_debit) === 57001 && Number(j1.total_credit) === 57001 && j1.issues.length === 0 && j1.reference_number === 'MEMO-7', j1)
ok('a draft changes no report (trial balance, day book)', (await tb()).totals.period_debit === tbBefore.totals.period_debit && await dayBookCount() === dbBefore)
const j1b = await acct(`select public.accounting_voucher_update($1::uuid, $2::jsonb, $3)`, [j1.id, jvPayload([[salaries, '45000.00', null], [rent, '12000.00', null],
  [payable, null, '50000.00'], [bank, null, '7000.00']], { narration: 'Month-end accruals (corrected)' }), j1.row_version])
ok('editing a draft replaces lines and header; the row version advances', j1b.lines.length === 4 && j1b.narration === 'Month-end accruals (corrected)'
  && j1b.row_version === j1.row_version + 1 && Number(j1b.total_debit) === 57000)
const v1 = await acct(`select public.accounting_voucher_validate($1::uuid)`, [j1.id])
ok('validate: valid, totals and zero difference', v1.valid && Number(v1.difference) === 0 && Number(v1.total_debit) === 57000)
const unbal = await acct(`select public.accounting_voucher_update($1::uuid, $2::jsonb, $3)`, [j1.id, jvPayload([[salaries, '45000.00', null], [payable, null, '44999.99']]), j1b.row_version])
const v2 = await acct(`select public.accounting_voucher_validate($1::uuid)`, [j1.id])
ok('validate reports an unbalanced journal and posting refuses it', !v2.valid && Number(v2.difference) === 0.01 && v2.issues.some((i) => i.code === 'UNBALANCED')
  && await refused('acct', `select public.accounting_voucher_post($1::uuid, $2)`, [j1.id, unbal.row_version], /does not equal total credit/))
const j1c = await acct(`select public.accounting_voucher_update($1::uuid, $2::jsonb, $3)`, [j1.id, jvPayload([[salaries, '45000.00', null], [rent, '12000.00', null],
  [payable, null, '50000.00'], [bank, null, '7000.00']]), unbal.row_version])
ok('posting with a stale row version is refused (someone else changed the draft)', await refused('acct', `select public.accounting_voucher_post($1::uuid, $2)`, [j1.id, j1b.row_version], /changed by someone else/))
const jp = await acct(`select public.accounting_voucher_post($1::uuid, $2)`, [j1.id, j1c.row_version])
ok('posted: next JV number in the financial year, totals stored', jp.status === 'POSTED' && /^JV\/\d{2}-\d{2}\/\d{6}$/.test(jp.voucher_number) && Number(jp.total_debit) === 57000)
const sal = await tbOf('6400')
ok('trial balance: the posted journal appears with exact amounts and still balances', Number(sal.period_debit) === 45000
  && Number((await tbOf('2300')).period_credit) === 50000 && (await tb()).totals.closing_debit === (await tb()).totals.closing_credit)
const glSal = await acct(`select public.accounting_general_ledger($1::uuid, $2::date, $3::date)`, [salaries, fyStart, today])
ok('general ledger: the journal line with its voucher number and running balance', glSal.entries.length === 1 && glSal.entries[0].voucher_number === jp.voucher_number
  && Number(glSal.entries[0].debit) === 45000 && Number(glSal.closing_balance) === 45000)
const dbk1 = await acct(`select public.accounting_day_book($1::date, $2::date, 'JV')`, [today, today])
ok('day book: the posted journal is listed with all its lines', await dayBookCount() === dbBefore + 1 && dbk1.vouchers.some((x) => x.id === j1.id && x.lines.length === 4))
const jreg = await acct(`select public.accounting_voucher_list($1::jsonb)`, [JSON.stringify({ voucher_type: 'JV', source: 'MANUAL', search: jp.voucher_number })])
const me = await val(`select rls_test.id('acct')::text`)
ok('journal register: by voucher number, account, status and creator', jreg.total === 1 && jreg.rows[0].id === j1.id && jreg.rows[0].created_by === me
  && jreg.rows[0].created_by_name === 'acct' && Number(jreg.rows[0].total_debit) === 57000
  && (await acct(`select public.accounting_voucher_list($1::jsonb)`, [JSON.stringify({ voucher_type: 'JV', account_id: salaries, status: 'POSTED' })])).total === 1
  && (await acct(`select public.accounting_voucher_list($1::jsonb)`, [JSON.stringify({ voucher_type: 'JV', account_id: salaries, created_by: await val(`select rls_test.id('acct2')::text`) })])).total === 0)
ok('posted journal: lines, header and status cannot be changed by any route', await refused('acct', `select public.accounting_voucher_update($1::uuid, '{"narration":"x"}'::jsonb, null)`, [j1.id], /only drafts/)
  && await refused('acct', `select public.accounting_voucher_line_save($1::uuid, null, $2::jsonb, null)`, [j1.id, JSON.stringify({ account_id: rent, debit: 1 })], /only drafts/)
  && await refused('acct', `select public.accounting_voucher_discard($1::uuid, 'too late')`, [j1.id], /only drafts/)
  && await ownerRefused(`update public.accounting_voucher_lines set credit = credit + 1 where voucher_id = '${j1.id}' and credit > 0`, /cannot be changed/))
const jr = await acct(`select public.accounting_voucher_reverse($1::uuid, 'accrual booked twice', null)`, [j1.id])
ok('reversal: linked REV voucher, opposite lines, original REVERSED; the journal nets to zero in the trial balance', jr.original.status === 'REVERSED'
  && jr.reversal.reversal_of_voucher_id === j1.id && jr.reversal.lines.length === 4 && Number((await tbOf('6400')).closing_debit) === 0
  && Number((await tbOf('6400')).period_credit) === 45000)
ok('the reversal shows in the day book and general ledger as its own voucher', (await acct(`select public.accounting_day_book($1::date, $2::date, 'REV')`, [today, today])).vouchers.some((x) => x.id === jr.reversal.id)
  && (await acct(`select public.accounting_general_ledger($1::uuid, $2::date, $3::date)`, [salaries, fyStart, today])).entries.length === 2)
ok('journal reversal audit: created, updated, posted, reversed', await val(`select count(distinct action)::int from public.audit_logs where resource_type = 'accounting_voucher'
  and resource_id = $1 and action in ('accounting.voucher.created', 'accounting.voucher.updated', 'accounting.voucher.posted', 'accounting.voucher.reversed')`, [j1.id]) === 4)
ok('journal rules: non-JV types, control accounts, inactive accounts, other companies and users without permission are refused',
  await refused('acct', `select public.accounting_voucher_create($1::jsonb)`, [jvPayload([[rent, '1', null], [bank, null, '1']], { voucher_type: 'SAL' })], /cannot be entered by hand/)
  && (await acct(`select public.accounting_voucher_create($1::jsonb)`, [jvPayload([[debtors, '1', null], [bank, null, '1']])])).issues.some((i) => i.code === 'ACCOUNT_NO_MANUAL')
  && await refused('b_op', `select public.accounting_voucher_create($1::jsonb)`, [jvPayload([[rent, '1', null], [bBank, null, '1']])], /does not exist in this company/)
  && await refused('viewer', `select public.accounting_voucher_create($1::jsonb)`, [jvPayload([[rent, '1', null], [bank, null, '1']])], /not allowed/)
  && await refused('sales', `select public.accounting_voucher_validate($1::uuid)`, [j1.id], /not allowed/))
const inactiveDraft = await acct(`select public.accounting_voucher_create($1::jsonb)`, [jvPayload([[payable, '10', null], [bank, null, '10']])])
await acct(`select public.accounting_voucher_discard($1::uuid, 'test cleanup')`, [inactiveDraft.id])
const temp = (await acct(`select public.accounting_account_save(null, $1::jsonb)`, [JSON.stringify({ account_code: '6999', account_name: 'Temporary', group_id: await grp('EX.IND') })])).id
const tempDraft = await acct(`select public.accounting_voucher_create($1::jsonb)`, [jvPayload([[temp, '10', null], [bank, null, '10']])])
await acct(`select public.accounting_voucher_discard($1::uuid, 'remove before deactivating')`, [tempDraft.id])
await acct(`select public.accounting_account_set_active($1::uuid, false)`, [temp])
ok('an account deactivated after drafting is reported and posting is refused', (await acct(`select public.accounting_voucher_create($1::jsonb)`, [jvPayload([[temp, '10', null], [bank, null, '10']])]))
  .issues.some((i) => i.code === 'ACCOUNT_INACTIVE'))

console.log('\nP2. Cost centre management (migration 20261231090200)')
// Lines: [account_id, debit, credit, allocations?] with allocations [[cost_centre_id, amount], ...].
const jvA = (lines, extra = {}) => JSON.stringify({ voucher_type: 'JV', voucher_date: today, narration: 'Cost centre test', ...extra,
  lines: lines.map(([account_id, debit, credit, allocs]) => ({ account_id, debit, credit, ...(allocs ? { allocations: allocs.map(([cost_centre_id, amount]) => ({ cost_centre_id, amount })) } : {}) })) })
const ccSave = (body, idArg = null, user = 'acct') => as(user)(`select public.accounting_cost_centre_save($1::uuid, $2::jsonb)`, [idArg, JSON.stringify(body)])
ok('3 budget permissions: Accounts Manager all, Management Viewer and Admin read only, Sales Manager none',
  await val(`select count(*)::int from public.permissions where resource = 'accounting_budgets'`) === 3
  && await val(`select count(*)::int from public.role_permissions rp join public.roles r on r.id = rp.role_id join public.permissions p on p.id = rp.permission_id
      where p.resource = 'accounting_budgets' and r.code = 'ACCOUNTS_MANAGER'`) === 3
  && await val(`select string_agg(p.code, ',') from public.role_permissions rp join public.roles r on r.id = rp.role_id join public.permissions p on p.id = rp.permission_id
      where p.resource = 'accounting_budgets' and r.code = 'MANAGEMENT_VIEWER'`) === 'accounting_budgets.read'
  && await val(`select count(*)::int from public.role_permissions rp join public.roles r on r.id = rp.role_id join public.permissions p on p.id = rp.permission_id
      where p.resource = 'accounting_budgets' and r.code = 'SALES_MANAGER'`) === 0)
// Master: types, effective dates, hierarchy.
const ccProd = cc1
const ccAdmin = (await ccSave({ cost_centre_code: 'ADMIN', cost_centre_name: 'Administration', cost_centre_type: 'ADMINISTRATION' })).id
const ccWh = (await ccSave({ cost_centre_code: 'WH', cost_centre_name: 'Warehouse', cost_centre_type: 'WAREHOUSE', parent_cost_centre_id: ccAdmin })).id
const ccOld = (await ccSave({ cost_centre_code: 'OLD', cost_centre_name: 'Closed unit', cost_centre_type: 'BRANCH', effective_from: fyStart,
  effective_to: await val(`select ($1::date - 1)::text`, [today]) })).id
const centres = await acct(`select public.accounting_cost_centres()`)
ok('cost centre master: type, effective dates, parent, usage counts', centres.find((c) => c.id === ccWh).cost_centre_type === 'WAREHOUSE'
  && centres.find((c) => c.id === ccWh).parent_cost_centre_id === ccAdmin && centres.find((c) => c.id === ccOld).effective_from === fyStart
  && centres.find((c) => c.id === ccAdmin).child_count === 1)
ok('master rules: unknown type, end before start, other-company parent, cycle, deactivating a parent with active children, viewer edits — all refused',
  await refused('acct', `select public.accounting_cost_centre_save(null, '{"cost_centre_code":"X1","cost_centre_name":"Bad type","cost_centre_type":"SECRET"}'::jsonb)`, null, /Unknown cost centre type/)
  && await refused('acct', `select public.accounting_cost_centre_save(null, '{"cost_centre_code":"X2","cost_centre_name":"Bad dates","effective_from":"2026-05-01","effective_to":"2026-04-01"}'::jsonb)`, null, /end date cannot be before/)
  && await refused('b_op', `select public.accounting_cost_centre_save(null, $1::jsonb)`, [JSON.stringify({ cost_centre_code: 'X3', cost_centre_name: 'Other co', parent_cost_centre_id: ccAdmin })], /does not exist in this company/)
  && await refused('acct', `select public.accounting_cost_centre_save($1::uuid, $2::jsonb)`, [ccAdmin, JSON.stringify({ cost_centre_name: 'Administration', parent_cost_centre_id: ccWh })], /under itself/)
  && await refused('acct', `select public.accounting_cost_centre_save($1::uuid, $2::jsonb)`, [ccAdmin, JSON.stringify({ cost_centre_name: 'Administration', is_active: false })], /active sub-centres/)
  && await refused('viewer', `select public.accounting_cost_centre_save(null, '{"cost_centre_code":"X4","cost_centre_name":"Viewer"}'::jsonb)`, null, /not allowed/))
await ccSave({ cost_centre_code: 'CLOSED', cost_centre_name: 'Closed department', is_active: false })
const ccTemp = (await ccSave({ cost_centre_code: 'TMP', cost_centre_name: 'Temporary' })).id
ok('an unused cost centre can be deleted', (await acct(`select public.accounting_cost_centre_delete($1::uuid)`, [ccTemp])).deleted === ccTemp)
// Account rules.
const electricity = (await acct(`select public.accounting_account_save(null, $1::jsonb)`, [JSON.stringify({ account_code: '6500', account_name: 'Electricity', group_id: await grp('EX.IND') })])).id
const power = (await acct(`select public.accounting_account_save(null, $1::jsonb)`, [JSON.stringify({ account_code: '5200', account_name: 'Factory Power', group_id: await grp('EX.DIR') })])).id
const sales = await accId('4100')
ok('allocation rule defaults: OPTIONAL for new and existing accounts, NOT_APPLICABLE for control accounts', await val(`select cost_centre_policy from public.accounts where id = $1`, [electricity]) === 'OPTIONAL'
  && await val(`select cost_centre_policy from public.accounts where id = $1`, [debtors]) === 'NOT_APPLICABLE'
  && await val(`select cost_centre_policy from public.accounts where id = $1`, [rent]) === 'OPTIONAL')
await acct(`select public.accounting_account_set_cost_centre_policy($1::uuid, 'REQUIRED')`, [electricity])
await acct(`select public.accounting_account_set_cost_centre_policy($1::uuid, 'NOT_APPLICABLE')`, [bank])
ok('allocation rule: set by accounts.manage only; control accounts stay NOT_APPLICABLE; shown in the account list',
  await refused('acct', `select public.accounting_account_set_cost_centre_policy($1::uuid, 'OPTIONAL')`, [debtors], /never allocated/)
  && await refused('viewer', `select public.accounting_account_set_cost_centre_policy($1::uuid, 'OPTIONAL')`, [rent], /not allowed/)
  && await refused('acct', `select public.accounting_account_set_cost_centre_policy($1::uuid, 'SOMETIMES')`, [rent], /REQUIRED, OPTIONAL or NOT_APPLICABLE/)
  && (await acct(`select public.accounting_accounts(null, false)`)).find((a) => a.id === electricity).cost_centre_policy === 'REQUIRED')
// The electricity example: Dr 1,00,000 split Production 60,000 / Administration 20,000 / Warehouse 20,000; Cr bank (no cost centre).
const tbTotalsBefore = (await tb()).totals
const el = await acct(`select public.accounting_voucher_create($1::jsonb)`, [jvA([[electricity, '100000.00', null, [[ccProd, '60000.00'], [ccAdmin, '20000.00'], [ccWh, '20000.00']]],
  [bank, null, '100000.00']], { narration: 'Electricity bill' })])
ok('split allocation saved on the draft; no extra voucher lines; valid', el.issues.length === 0 && el.lines.length === 2 && el.lines[0].allocations.length === 3
  && el.lines[0].allocations.reduce((t, a) => t + Number(a.amount), 0) === 100000 && el.lines[1].allocations.length === 0)
const mis = await acct(`select public.accounting_voucher_create($1::jsonb)`, [jvA([[electricity, '100000.00', null, [[ccProd, '60000.00'], [ccAdmin, '39999.99']]], [bank, null, '100000.00']])])
ok('allocations must equal the line: a 0.01 shortfall is reported and posting is refused', mis.issues.some((i) => i.code === 'ALLOCATION_MISMATCH' && /difference 0.01/.test(i.message))
  && await refused('acct', `select public.accounting_voucher_post($1::uuid)`, [mis.id], /cost-centre allocations total/))
const req = await acct(`select public.accounting_voucher_create($1::jsonb)`, [jvA([[electricity, '500.00', null], [bank, null, '500.00']])])
const na = await acct(`select public.accounting_voucher_create($1::jsonb)`, [jvA([[rent, '500.00', null], [bank, null, '500.00', [[ccAdmin, '500.00']]]])])
const inact = await acct(`select public.accounting_voucher_create($1::jsonb)`, [jvA([[rent, '500.00', null, [[ccOld, '500.00']]], [payable, null, '500.00']])])
ok('REQUIRED without allocation, NOT_APPLICABLE with allocation, and a cost centre outside its effective dates are reported',
  req.issues.some((i) => i.code === 'COST_CENTRE_REQUIRED') && na.issues.some((i) => i.code === 'COST_CENTRE_NOT_ALLOWED') && inact.issues.some((i) => i.code === 'COST_CENTRE_INACTIVE'))
ok('zero and negative allocations, the same cost centre twice on a line and another company\'s cost centre are refused',
  await refused('acct', `select public.accounting_voucher_create($1::jsonb)`, [jvA([[rent, '10', null, [[ccAdmin, '0']]], [payable, null, '10']])], /greater than zero/)
  && await refused('acct', `select public.accounting_voucher_create($1::jsonb)`, [jvA([[rent, '10', null, [[ccAdmin, '-10']]], [payable, null, '10']])], /negative/)
  && await refused('acct', `select public.accounting_voucher_create($1::jsonb)`, [jvA([[rent, '10', null, [[ccAdmin, '5'], [ccAdmin, '5']]], [payable, null, '10']])], /allocated twice/)
  && await refused('b_op', `select public.accounting_voucher_create($1::jsonb)`, [jvA([[bBank, '10', null, [[ccAdmin, '10']]], [bBank, null, '10']])], /does not exist in this company/))
// Draft editing of allocations.
const ed1 = await acct(`select public.accounting_voucher_update($1::uuid, $2::jsonb, $3)`, [mis.id, jvA([[electricity, '100000.00', null, [[ccProd, '100000.00']]], [bank, null, '100000.00']]), mis.row_version])
ok('draft editing replaces the allocations with the lines (single cost centre now)', ed1.issues.length === 0 && ed1.lines[0].allocations.length === 1)
const ed2 = await acct(`select public.accounting_voucher_line_save($1::uuid, $2::uuid, $3::jsonb, $4)`, [mis.id, ed1.lines[0].id,
  JSON.stringify({ account_id: electricity, debit: '100000.00', allocations: [{ cost_centre_id: ccProd, amount: '70000' }, { cost_centre_id: ccWh, amount: '30000' }] }), ed1.row_version])
ok('a line can be saved with a new split', ed2.lines.find((l) => l.id === ed1.lines[0].id).allocations.length === 2 && ed2.issues.length === 0)
const ed3 = await acct(`select public.accounting_voucher_line_delete($1::uuid, $2::uuid, $3)`, [mis.id, ed1.lines[0].id, ed2.row_version])
ok('deleting a draft line deletes its allocations', ed3.lines.length === 1 && await val(`select count(*)::int from public.accounting_cost_allocations where voucher_id = $1`, [mis.id]) === 0)
// Credit-side allocation (income) and posting.
const inc = await acct(`select public.accounting_voucher_create($1::jsonb)`, [jvA([[payable, '9000.00', null], [sales, null, '9000.00', [[ccProd, '6000.00'], [ccWh, '3000.00']]]], { narration: 'Scrap sale' })])
const elPosted = await acct(`select public.accounting_voucher_post($1::uuid)`, [el.id])
await acct(`select public.accounting_voucher_post($1::uuid)`, [inc.id])
const pw = await acct(`select public.accounting_voucher_create($1::jsonb)`, [jvA([[power, '4000.00', null, [[ccProd, '4000.00']]], [payable, null, '4000.00']], { narration: 'Factory power' })])
await acct(`select public.accounting_voucher_post($1::uuid)`, [pw.id])
ok('vouchers with debit- and credit-side allocations post; company totals unchanged by allocations (lines only)',
  elPosted.status === 'POSTED' && Number((await tb()).totals.period_debit) === Number(tbTotalsBefore.period_debit) + 113000
  && (await tb()).totals.closing_debit === (await tb()).totals.closing_credit)
ok('posted allocations are immutable for every role; users and service_role have no direct access',
  await ownerRefused(`update public.accounting_cost_allocations set amount = amount + 1 where voucher_id = '${el.id}'`, /cannot be changed/)
  && await ownerRefused(`delete from public.accounting_cost_allocations where voucher_id = '${el.id}'`, /cannot be changed/)
  && await ownerRefused(`insert into public.accounting_cost_allocations (company_id, voucher_id, voucher_line_id, cost_centre_id, amount)
       select company_id, voucher_id, id, '${ccAdmin}', 1 from public.accounting_voucher_lines where voucher_id = '${el.id}' and line_no = 2`, /cannot be changed/)
  && await ownerRefused(`truncate public.accounting_cost_allocations`, /cannot be truncated/)
  && await refused('acct', `update public.accounting_cost_allocations set amount = 1`, null, /permission denied/)
  && await refused('service_role', `select count(*) from public.accounting_cost_allocations`, null, /permission denied/))
const summary = async (from = fyStart, to = today) => acct(`select public.accounting_cost_centre_summary($1::date, $2::date)`, [from, to])
const s1 = await summary()
const row = (s, id) => s.rows.find((r) => r.cost_centre_id === id)
const sumRows = (s, k) => s.rows.reduce((t, r) => t + Math.round(Number(r[k]) * 100), 0) / 100
ok('cost centre summary: Production expense 64,000 (incl. direct power) and income 6,000; Warehouse 20,000 / 3,000; Administration 20,000',
  Number(row(s1, ccProd).expense) === 64000 && Number(row(s1, ccProd).income) === 6000 && Number(row(s1, ccWh).expense) === 20000
  && Number(row(s1, ccWh).income) === 3000 && Number(row(s1, ccAdmin).expense) === 20000 && Number(row(s1, ccProd).net) === -58000, s1.rows)
ok('allocated + unallocated income and expense equal the company totals (unallocated shown separately)',
  Math.round((sumRows(s1, 'expense') + Number(s1.unallocated.expense)) * 100) === Math.round(Number(s1.company.expense) * 100)
  && Math.round((sumRows(s1, 'income') + Number(s1.unallocated.income)) * 100) === Math.round(Number(s1.company.income) * 100) && Number(s1.unallocated.expense) > 0, s1)
ok('drafts never reach the cost centre reports', !(await summary()).rows.some((r) => r.cost_centre_id === ccOld && Number(r.expense) !== 0)
  && Number(row(await summary(), ccProd).expense) === 64000)
const prof = await acct(`select public.accounting_cost_centre_profitability($1::date, $2::date)`, [fyStart, today])
const pp1 = prof.rows.find((r) => r.cost_centre_id === ccProd)
ok('profitability: revenue, direct expenses (EX.DIR / EX.PUR groups), indirect expenses, net contribution', Number(pp1.revenue) === 6000
  && Number(pp1.direct_expenses) === 4000 && Number(pp1.indirect_expenses) === 60000 && Number(pp1.net_contribution) === -58000 && prof.unallocated !== null, pp1)
const led = await acct(`select public.accounting_cost_centre_ledger($1::uuid, $2::date, $3::date)`, [ccProd, fyStart, today])
ok('cost centre ledger: date, voucher, account, debit / credit at the allocated amount, running balance', led.entries.length === 3
  && led.entries.some((e) => e.account_code === '6500' && Number(e.debit) === 60000) && led.entries.some((e) => e.account_code === '4100' && Number(e.credit) === 6000)
  && Number(led.closing_balance) === 58000 && Number(led.entries.at(-1).balance) === 58000, led)
const glAll = await acct(`select public.accounting_general_ledger($1::uuid, $2::date, $3::date)`, [electricity, fyStart, today])
const glProd = await acct(`select public.accounting_general_ledger($1::uuid, $2::date, $3::date, null, $4::uuid)`, [electricity, fyStart, today, ccProd])
ok('general ledger cost-centre filter: the centre\'s share only; without the filter the company-wide figure is unchanged', Number(glAll.closing_balance) === 100000
  && Number(glProd.closing_balance) === 60000 && glProd.entries.length === 1)
ok('day book and voucher register cost-centre filters', (await acct(`select public.accounting_day_book($1::date, $2::date, null, $3::uuid)`, [today, today, ccAdmin])).vouchers.every((v) => v.lines.some((l) => l.allocations.some((a) => a.cost_centre_id === ccAdmin)))
  && (await acct(`select public.accounting_day_book($1::date, $2::date, null, $3::uuid)`, [today, today, ccAdmin])).vouchers.length === 1
  && (await acct(`select public.accounting_voucher_list($1::jsonb)`, [JSON.stringify({ cost_centre_id: ccWh, status: 'POSTED' })])).total === 2
  && Number((await acct(`select public.accounting_day_book($1::date, $2::date)`, [today, today])).totals.debit) >= 113000)
// Reversal keeps and reverses the allocations.
const elRev = await acct(`select public.accounting_voucher_reverse($1::uuid, 'billed to the wrong period')`, [el.id])
ok('reversal copies the allocations onto the opposite lines; every cost centre nets to zero for the voucher', elRev.reversal.lines[0].allocations.length === 3
  && Number(elRev.reversal.lines[0].credit) === 100000 && elRev.reversal.lines[0].allocations.reduce((t, a) => t + Number(a.amount), 0) === 100000
  && Number(row(await summary(), ccProd).expense) === 4000 && Number(row(await summary(), ccAdmin).expense) === 0 && Number(row(await summary(), ccWh).expense) === 0)
ok('a used cost centre cannot be deleted (only deactivated)', await refused('acct', `select public.accounting_cost_centre_delete($1::uuid)`, [ccProd], /used on vouchers/))
// Automatic postings: never guessed. A REQUIRED account without cost-centre data stops the event for correction.
const cash = await accId('1100')
await acct(`select public.accounting_posting_rule_save('SUPPLIER_PAYMENT_ACCOUNT', 'CASH', $1::uuid)`, [cash])
await acct(`select public.accounting_account_set_cost_centre_policy($1::uuid, 'REQUIRED')`, [cash])
const sp2 = await op(`select public.supplier_payment_record($1::uuid, $2::date, 777.00, 'CASH', 'CC-TEST', 'cost centre test', gen_random_uuid())`, [supplierId, today])
await acct(`select public.accounting_posting_run(500)`)
ok('automatic posting to a REQUIRED account is flagged (FAILED with the reason), not posted and no cost centre guessed',
  await val(`select status || '|' || (error_message like '%needs a cost-centre allocation%')::text from public.accounting_posting_events where source_id = $1 and event_action = 'POST'`, [sp2.payment_id]) === 'FAILED|true'
  && await val(`select count(*)::int from public.accounting_vouchers where source_id = $1`, [sp2.payment_id]) === 0
  && await val(`select count(*)::int from public.accounting_cost_allocations x join public.accounting_vouchers v on v.id = x.voucher_id where v.source = 'AUTO'`) === 0)
await acct(`select public.accounting_account_set_cost_centre_policy($1::uuid, 'OPTIONAL')`, [cash])
const sp2e = await val(`select id::text from public.accounting_posting_events where source_id = $1 and event_action = 'POST'`, [sp2.payment_id])
ok('after the rule is corrected the retry posts it (without allocations)', (await acct(`select public.accounting_posting_retry($1::uuid)`, [sp2e])).status === 'POSTED')
// Budgets.
const fyLbl = await val(`select private.financial_year($1::date, 4)`, [today])
const bud1 = await acct(`select public.accounting_budget_create($1::date, 'Annual operating budget', 'first cut')`, [today])
ok('budget created as DRAFT version 1 of the financial year; viewers cannot create', bud1.status === 'DRAFT' && bud1.version === 1 && bud1.financial_year === fyLbl
  && await refused('viewer', `select public.accounting_budget_create(current_date, 'Viewer budget')`, null, /not allowed/))
const months = (v) => Array.from({ length: 12 }, () => v)
ok('budget import validation: months ≠ annual, inactive cost centre, balance-sheet account, duplicates and bad numbers are refused with row numbers; nothing saved',
  await refused('acct', `select public.accounting_budget_lines_replace($1::uuid, $2::jsonb, 'IMPORT', 'b.xlsx')`, [bud1.id, JSON.stringify([
    { cost_centre_code: 'PROD', account_code: '6500', annual: '600000', months: months('50000') }, { cost_centre_code: 'ADMIN', account_code: '6500', annual: '1000', months: months('1') }])],
    /Row 2: the monthly budgets total 12\.00 but the annual budget is 1000/)
  && await refused('acct', `select public.accounting_budget_lines_replace($1::uuid, $2::jsonb)`, [bud1.id, JSON.stringify([{ cost_centre_code: 'CLOSED', account_code: '6500', annual: '10' }])], /Row 1: cost centre CLOSED is inactive/)
  && await refused('acct', `select public.accounting_budget_lines_replace($1::uuid, $2::jsonb)`, [bud1.id, JSON.stringify([{ cost_centre_code: 'PROD', account_code: '1210', annual: '10' }])], /not an income or expense account/)
  && await refused('acct', `select public.accounting_budget_lines_replace($1::uuid, $2::jsonb)`, [bud1.id, JSON.stringify([{ cost_centre_code: 'PROD', account_code: '6500', annual: '10' },
    { cost_centre_code: 'PROD', account_code: '6500', annual: '20' }])], /appear 2 times/)
  && await refused('acct', `select public.accounting_budget_lines_replace($1::uuid, $2::jsonb)`, [bud1.id, JSON.stringify([{ cost_centre_code: 'PROD', account_code: '6500', annual: '1e5' }])], /must be a number/)
  && (await acct(`select public.accounting_budget_get($1::uuid)`, [bud1.id])).lines.length === 0)
const b1 = await acct(`select public.accounting_budget_lines_replace($1::uuid, $2::jsonb, 'IMPORT', 'budget.xlsx')`, [bud1.id, JSON.stringify([
  { cost_centre_code: 'PROD', account_code: '6500', annual: '600000.00', months: months('50000') },
  { cost_centre_code: 'ADMIN', account_code: '6500', annual: '1000.00' },
  { cost_centre_code: 'PROD', account_code: '4100', m01: '100', m12: '200' }])])
const l2 = b1.lines.find((l) => l.cost_centre_code === 'ADMIN')
ok('imported: monthly + annual kept; annual only is spread evenly (paise-exact, remainder in the last month); months only give the annual',
  b1.lines.length === 3 && Number(l2.months[0]) === 83.33 && Number(l2.months[11]) === 83.37 && l2.months.reduce((t, m) => t + Math.round(Number(m) * 100), 0) === 100000
  && Number(b1.lines.find((l) => l.account_code === '4100').annual_amount) === 300 && b1.source === 'IMPORT' && b1.file_name === 'budget.xlsx')
await db.exec(`reset role; update public.accounting_settings set segregation_of_duties = true where company_id = '${A}'`)
ok('approval needs accounting_budgets.approve; with segregation of duties the preparer cannot approve',
  await refused('viewer', `select public.accounting_budget_approve($1::uuid)`, [bud1.id], /not allowed/)
  && await refused('acct', `select public.accounting_budget_approve($1::uuid)`, [bud1.id], /Segregation of duties/))
const ap1 = await as('acct2')(`select public.accounting_budget_approve($1::uuid, 'agreed with plant head')`, [bud1.id])
await db.exec(`reset role; update public.accounting_settings set segregation_of_duties = false where company_id = '${A}'`)
ok('approved; approved budgets are immutable (lines and header)', ap1.status === 'APPROVED'
  && await refused('acct', `select public.accounting_budget_lines_replace($1::uuid, '[]'::jsonb)`, [bud1.id], /Only a draft budget/)
  && await ownerRefused(`update public.accounting_budget_lines set m01 = m01 + 1, annual_amount = annual_amount + 1 where budget_id = '${bud1.id}'`, /only be changed while the budget is a draft/)
  && await ownerRefused(`update public.accounting_budgets set budget_name = 'changed' where id = '${bud1.id}'`, /create a revision/))
const vouchersBeforeBudget = await val(`select count(*)::int from public.accounting_vouchers where company_id = $1`, [A])
const rev = await acct(`select public.accounting_budget_revise($1::uuid, 'power tariff increase')`, [bud1.id])
await acct(`select public.accounting_budget_lines_replace($1::uuid, $2::jsonb)`, [rev.id, JSON.stringify([{ cost_centre_code: 'PROD', account_code: '6500', annual: '720000.00', months: months('60000') },
  { cost_centre_code: 'ADMIN', account_code: '6500', annual: '1000.00' }])])
const ap2 = await acct(`select public.accounting_budget_approve($1::uuid, 'revision approved')`, [rev.id])
const old = await acct(`select public.accounting_budget_get($1::uuid)`, [bud1.id])
ok('revision: version 2 copied from version 1, approved; version 1 superseded; history kept; budgets never create vouchers', rev.version === 2 && rev.revision_of_version === 1
  && ap2.status === 'APPROVED' && old.status === 'SUPERSEDED' && old.history.map((h) => h.action).join(',') === 'CREATED,IMPORTED,APPROVED,SUPERSEDED'
  && ap2.history.map((h) => h.action).join(',') === 'REVISED,LINES_SAVED,APPROVED'
  && vouchersBeforeBudget === await val(`select count(*)::int from public.accounting_vouchers where company_id = $1`, [A])
  && await ownerRefused(`update public.accounting_budget_history set note = 'x'`, /append-only/))
const fyMonth = await val(`select (extract(month from age($1::date, $2::date)) + 1)::int`, [today, fyStart])
const bva = await acct(`select public.accounting_budget_vs_actual($1, $2)`, [fyLbl, fyMonth])
const bvaProd = bva.rows.find((r) => r.cost_centre_id === ccProd && r.account_code === '6500')
ok(`budget vs actual (month ${fyMonth} of the year): annual 7,20,000, monthly 60,000, period budget, actual, remaining, variance and %`, bva.budget.version === 2
  && Number(bvaProd.annual_budget) === 720000 && Number(bvaProd.monthly_budget) === 60000 && Number(bvaProd.period_budget) === 60000 * fyMonth
  && Number(bvaProd.actual) === 0 && Number(bvaProd.remaining) === 720000 && Number(bvaProd.variance) === 60000 * fyMonth && Number(bvaProd.variance_percent) === 100, bvaProd)
ok('budget vs actual includes actuals without a budget line (Factory Power, Production)', bva.rows.some((r) => r.account_code === '5200' && Number(r.actual) === 4000 && Number(r.annual_budget) === 0))
const s2 = await summary()
ok('summary shows the approved budget and the variance per cost centre', Number(row(s2, ccProd).budget) > 0 && Number(row(s2, ccProd).variance) === Number(row(s2, ccProd).budget) - Number(row(s2, ccProd).actual))
const bud3 = await acct(`select public.accounting_budget_create($1::date, 'Scenario', null)`, [today])
ok('a draft can be cancelled with a reason; one approved budget per year is enforced by the database',
  (await acct(`select public.accounting_budget_cancel($1::uuid, 'not needed')`, [bud3.id])).status === 'CANCELLED'
  && await ownerRefused(`update public.accounting_budgets set status = 'APPROVED', approved_at = now() where id = '${bud3.id}'`, /cannot be changed/)
  && await ownerRefused(`insert into public.accounting_budgets (company_id, financial_year, fy_start, version, budget_name, status, approved_at)
       values ('${A}', '${fyLbl}', '${fyStart}', 99, 'Second approved', 'APPROVED', now())`, /duplicate key|unique/))
ok('company isolation: company B sees no budgets, allocations or cost centres of company A',
  (await as('b_op')(`select public.accounting_budgets(null)`)).length === 0 && (await as('b_op')(`select public.accounting_cost_centres()`)).length === 0
  && (await request('b_op', `select count(*)::int from public.accounting_cost_allocations`)).value === 0
  && await refused('b_op', `select public.accounting_budget_get($1::uuid)`, [bud1.id], /not found/)
  && await refused('b_op', `select public.accounting_cost_centre_ledger($1::uuid, current_date - 30, current_date)`, [ccProd], /not found/))
ok('Phase 2 read-only reports run inside a READ ONLY transaction', await (async () => {
  await db.exec('reset role'); await db.exec('begin read only')
  try {
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: await val(`select rls_test.id('acct')::text`), role: 'authenticated' })])
    await db.exec('reset role'); await db.exec('set local role authenticated')
    for (const q of [`select public.accounting_cost_centre_summary(current_date - 30, current_date)`, `select public.accounting_cost_centre_profitability(current_date - 30, current_date)`,
      `select public.accounting_cost_centre_ledger('${ccProd}'::uuid, current_date - 30, current_date)`, `select public.accounting_budget_vs_actual('${fyLbl}', null)`,
      `select public.accounting_budgets(null)`, `select public.accounting_budget_get('${bud1.id}'::uuid)`, `select public.accounting_cost_centres()`,
      `select public.accounting_general_ledger('${electricity}'::uuid, current_date - 30, current_date, null, '${ccProd}'::uuid)`,
      `select public.accounting_day_book(current_date - 3, current_date, null, '${ccProd}'::uuid)`]) await db.query(q)
    await db.exec('rollback'); return true
  } catch (e) { await db.exec('rollback').catch(() => {}); console.log('      got:', e.message); return false }
})())

console.log('\nP. Supplier invoices (Phase 3)')
await addUser('pm', 'acc00000-0000-4000-8000-0000000000a6', 'PURCHASE_MANAGER')
const pm = as('pm')
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005
const piPerms = (role) => val(`select coalesce(string_agg(p.code, ',' order by p.code), '') from public.role_permissions rp join public.roles r on r.id = rp.role_id
  join public.permissions p on p.id = rp.permission_id where r.code = $1 and p.resource = 'purchase_invoices'`, [role])
ok('permissions: Accounts Manager all six; Purchase Manager read + create; Admin / Management Viewer read; Sales Manager none',
  await piPerms('ACCOUNTS_MANAGER') === 'purchase_invoices.approve,purchase_invoices.create,purchase_invoices.post,purchase_invoices.read,purchase_invoices.reverse,purchase_invoices.verify_gst'
  && await piPerms('PURCHASE_MANAGER') === 'purchase_invoices.create,purchase_invoices.read' && await piPerms('ADMIN') === 'purchase_invoices.read'
  && await piPerms('MANAGEMENT_VIEWER') === 'purchase_invoices.read' && await piPerms('SALES_MANAGER') === '')
ok('seeded: input CGST / SGST / IGST / cess, RCM payable, price variance and ineligible-GST ledgers with their rules; PIN voucher type (not manual)',
  await val(`select count(*)::int from public.accounting_posting_rules r join public.accounts a on a.id = r.account_id where r.company_id = $1
    and r.rule_key in ('INPUT_CGST', 'INPUT_SGST', 'INPUT_IGST', 'INPUT_CESS', 'RCM_GST_PAYABLE', 'PURCHASE_PRICE_VARIANCE', 'GST_INPUT_INELIGIBLE') and a.system_key = r.rule_key`, [A]) === 7
  && await val(`select allow_manual from public.accounting_voucher_types where company_id = $1 and type_code = 'PIN'`, [A]) === false)

// Fixtures: an intra-state supplier (state 27, as the company) and an inter-state one (29); one stock item.
const mkSupplier = async (name, gstin, state) => (await op(`select public.party_save(null, $1::jsonb, true, gen_random_uuid())`,
  [JSON.stringify({ party_type: 'SUPPLIER', party_name: name, gstin, state_code: state })])).supplier_id
const sup1 = await mkSupplier('PI Intra Supplier', '27AABCP1234A1Z5', '27')
const sup2 = await mkSupplier('PI Inter Supplier', '29AABCQ1234A1Z5', '29')
const sup1Party = await val(`select id::text from public.parties where supplier_id = $1`, [sup1])
const piProds = (await rows(`insert into public.products (company_id, sku, product_name, product_type, default_source_type, base_unit, status, standard_cost, gst_rate, hsn_code)
  select $1, 'PI-RM-' || n, 'PI raw material ' || n, 'RAW_MATERIAL', 'OUTSOURCED', 'PCS', 'ACTIVE', 10, 18, '6910' from generate_series(1, 2) n returning id::text`, [A])).map((r) => r.id)
const w1 = await val(`select rls_test.id('w1')::text`)
const loc1 = await val(`select rls_test.id('g1')::text`)
const grnPost = async (sup, lines) => {
  const r = await op(`select public.goods_receipt_direct_post($1::jsonb, $2::jsonb, gen_random_uuid())`, [JSON.stringify({ warehouse_id: w1, supplier_id: sup, receipt_date: today }),
    JSON.stringify(lines.map(([qty, cost, rate], k) => ({ product_id: piProds[k], received_quantity: qty, accepted_quantity: qty, rejected_quantity: 0, unit_cost: cost, gst_rate: rate,
      accepted_location_id: loc1 })))])
  const ls = await rows(`select id::text, unit_cost::float8 as cost from public.goods_receipt_lines where goods_receipt_id = $1`, [r.receipt_id])
  return { id: r.receipt_id, number: r.receipt_number, line: (cost) => ls.find((x) => x.cost === cost).id }
}
const credOf = async (party) => Number(await val(`select coalesce(sum(l.credit - l.debit), 0)::text from public.accounting_voucher_lines l
  join public.accounting_vouchers v on v.id = l.voucher_id join public.accounts a on a.id = l.account_id
  where l.party_id = $1 and a.system_key = 'CREDITORS_CONTROL' and v.status in ('POSTED', 'REVERSED')`, [party]))
const vlines = (voucher) => rows(`select a.system_key as key, a.account_code as code, l.debit::float8 as dr, l.credit::float8 as cr, l.party_id::text as party,
  (select count(*)::int from public.accounting_cost_allocations x where x.voucher_line_id = l.id) as allocs
  from public.accounting_voucher_lines l join public.accounts a on a.id = l.account_id where l.voucher_id = $1 order by l.line_no`, [voucher])
const pinv = (sup, number, lines, extra = {}) => JSON.stringify({ supplier_id: sup, supplier_invoice_number: number, supplier_invoice_date: today, invoice_type: 'GOODS',
  ...extra, lines })
const grnL = (glid, qty, price, rate) => ({ kind: 'GRN', goods_receipt_line_id: glid, quantity: qty, unit_price: price, gst_rate: rate })
const dirL = (acc, price, rate, extra = {}) => ({ kind: 'DIRECT', account_id: acc, quantity: 1, unit_price: price, gst_rate: rate, ...extra })
const save = (user, payload, invId = null, rv = null) => as(user)(`select public.purchase_invoice_save($1::uuid, $2::jsonb, $3::int)`, [invId, payload, rv])
const saveRefused = (user, payload, pattern) => refused(user, `select public.purchase_invoice_save(null, $1::jsonb)`, [payload], pattern)
const act = (user, fn, ...args) => as(user)(`select public.purchase_invoice_${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')})`, args)
// Phase 5 Gate C: GST verification is maker-checker — acct proposes through the Phase 3 RPC, acct2 approves.
const gstVerify = async (id, status, reason, checks) => {
  await act('acct', 'verify_gst', id, status, reason, checks)
  await as('acct2')(`select public.gst_itc_action($1::uuid, 'APPROVE', '{}'::jsonb)`, [id])
  return as('acct')(`select public.purchase_invoice_get($1::uuid)`, [id])
}
const codes = (inv) => inv.issues.map((x) => x.code)

// Goods receipts of supplier 1 (direct, no PO): 10 × 100 @ 18% (payable 1,180) + 4 × 250 @ 12% (1,120); 5 × 100 @ 18% (590). Posted to the books first.
const G1 = await grnPost(sup1, [[10, 100, 18], [4, 250, 12]])
const G2 = await grnPost(sup1, [[5, 100, 18]])
await acct(`select public.accounting_posting_run(500)`)
const lk = await pm(`select public.purchase_invoice_lookups()`)
ok('entry lookups with purchase_invoices.read alone: active suppliers, postable non-control ledgers (no Creditors, cash or bank), active cost centres',
  lk.initialized === true && lk.suppliers.some((x) => x.id === sup1) && lk.accounts.some((a) => a.id === rent)
  && !lk.accounts.some((a) => a.id === bank || a.account_code === '2100') && lk.cost_centres.some((c) => c.id === ccProd)
  && await refused('sales', `select public.purchase_invoice_lookups()`, null, /not allowed/))
ok('goods receipts are in the books first: Creditors of the supplier = receipt payables (1,180 + 1,120 + 590)', near(await credOf(sup1Party), 2890))

// 1. Matched invoice at the receipt prices, partly invoicing receipt 1 and fully receipt 2.
const m1 = await save('pm', pinv(sup1, 'S1/M-001', [grnL(G1.line(100), 6, 100, 18), grnL(G2.line(100), 5, 100, 18)], { supplier_stated_total: '1298.00' }))
ok('matched invoice: PINV- number, taxes computed on the server (CGST + SGST intra-state), totals 1,100 + 99 + 99 = 1,298, no issues, GST pending verification',
  /^PINV-\d{6}$/.test(m1.invoice_number) && m1.status === 'DRAFT' && near(m1.taxable_value, 1100) && near(m1.cgst_total, 99) && near(m1.sgst_total, 99)
  && near(m1.igst_total, 0) && near(m1.grand_total, 1298) && m1.tax_treatment === 'INTRA_STATE' && m1.issues.length === 0 && m1.gst_status === 'PENDING_VERIFICATION'
  && m1.lines[0].receipt_number === G1.number && near(m1.lines[0].grn_payable, 1180))
ok('quantity on another invoice (even a draft) is reserved: over-invoicing the receipt is refused',
  await saveRefused('pm', pinv(sup1, 'S1/M-OVER', [grnL(G1.line(100), 5, 100, 18)]), /only 4(\.0+)? of goods receipt/))
ok('the same receipt line twice on one invoice is refused', await saveRefused('pm', pinv(sup1, 'S1/M-DUP', [grnL(G1.line(250), 1, 250, 12), grnL(G1.line(250), 1, 250, 12)]), /appears twice/))
ok('a receipt of another supplier cannot be matched', await saveRefused('pm', pinv(sup2, 'S2/M-X', [grnL(G1.line(250), 1, 250, 12)]), /belongs to another supplier/))
ok('a stale row version is refused (no lost update)', await refused('pm', `select public.purchase_invoice_save($1::uuid, $2::jsonb, $3::int)`,
  [m1.id, pinv(sup1, 'S1/M-001', [grnL(G1.line(100), 6, 100, 18), grnL(G2.line(100), 5, 100, 18)], { supplier_stated_total: '1298.00' }), m1.row_version + 5], /changed by someone else/))
const m1s = await act('pm', 'submit', m1.id)
ok('submitted: matched within tolerance; the Purchase Manager cannot approve or post', m1s.status === 'SUBMITTED' && m1s.variance_status === 'WITHIN_TOLERANCE'
  && await refused('pm', `select public.purchase_invoice_approve($1::uuid)`, [m1.id], /not allowed/) && await refused('pm', `select public.purchase_invoice_post($1::uuid)`, [m1.id], /not allowed/))
ok('a submitted invoice cannot be edited', await refused('pm', `select public.purchase_invoice_save($1::uuid, $2::jsonb)`, [m1.id, pinv(sup1, 'S1/M-001', [])], /Only a draft/))
await act('acct', 'approve', m1.id, null, false)
const m1p = await act('acct', 'post', m1.id)
ok('matched at the receipt prices: POSTED with NO voucher — the receipts already carry Purchases, GST and Creditors (no duplicate payable); reconciled',
  m1p.status === 'POSTED' && m1p.voucher_id === null && m1p.reconciliation.reconciled === true && near(m1p.reconciliation.receipt_share_total, 1298)
  && await val(`select count(*)::int from public.accounting_vouchers where source_id = $1`, [m1.id]) === 0 && near(await credOf(sup1Party), 2890)
  && near(m1p.lines[0].matched_payable, 708) && near(m1p.lines[0].matched_net, 600) && near(m1p.outstanding, 1298))

// 2. The rest of receipt 1, line 1 at a higher price (variance) and line 2 at the receipt price.
const m2 = await save('pm', pinv(sup1, 'S1/M-002', [grnL(G1.line(100), 4, 105, 18), grnL(G1.line(250), 4, 250, 12)], { supplier_stated_total: '1615.60' }))
ok('price above the receipt cost is flagged PRICE_VARIANCE (amount 20, not blocking); totals 1,420 + 97.80 + 97.80',
  near(m2.grand_total, 1615.6) && near(m2.cgst_total, 97.8) && m2.issues.length === 1 && m2.issues[0].code === 'PRICE_VARIANCE' && near(m2.issues[0].amount, 20)
  && m2.issues[0].blocking === false)
const m2s = await act('pm', 'submit', m2.id)
ok('variance outside the tolerance: EXCEPTION; approval needs explicit acceptance and a reason of at least 10 characters', m2s.variance_status === 'EXCEPTION'
  && await refused('acct', `select public.purchase_invoice_approve($1::uuid)`, [m2.id], /approve them explicitly/)
  && await refused('acct', `select public.purchase_invoice_approve($1::uuid, 'ok', true)`, [m2.id], /approve them explicitly/))
const m2a = await act('acct', 'approve', m2.id, 'Supplier price revision agreed by purchase', true)
ok('…approved with the reason recorded', m2a.status === 'APPROVED' && m2a.variance_status === 'APPROVED' && m2a.variance_note === 'Supplier price revision agreed by purchase')
const m2p = await act('acct', 'post', m2.id)
const m2v = await vlines(m2p.voucher_id)
ok('matched with a variance: only the differences post — Dr Price Variance 20, Dr GST pending 3.60 / Cr Creditors (party) 23.60; no Purchases line',
  m2v.length === 3 && m2v[0].key === 'PURCHASE_PRICE_VARIANCE' && near(m2v[0].dr, 20) && m2v[1].key === 'GST_INPUT_PENDING' && near(m2v[1].dr, 3.6)
  && m2v[2].key === 'CREDITORS_CONTROL' && near(m2v[2].cr, 23.6) && m2v[2].party === sup1Party && !m2v.some((l) => l.key === 'PURCHASES')
  && await val(`select t.type_code || '|' || v.source || '|' || v.source_type || '|' || v.status from public.accounting_vouchers v
       join public.accounting_voucher_types t on t.id = v.voucher_type_id where v.id = $1`, [m2p.voucher_id]) === 'PIN|AUTO|PURCHASE_INVOICE|POSTED')
ok('no duplicate Creditors: the supplier\'s Creditors = sum of its invoices (receipts fully invoiced) = 1,298 + 1,615.60',
  near(await credOf(sup1Party), 2913.6) && near(m2p.lines[0].matched_net, 400) && near(m2p.lines[0].matched_payable, 472) && m2p.reconciliation.reconciled === true)
const recon3 = await acct(`select public.purchase_invoice_report('GRN_RECONCILIATION', $1::jsonb)`, [JSON.stringify({ supplier_id: sup1 })])
ok('GRN vs invoice report: every receipt line fully invoiced, nothing uninvoiced, the posted difference is the 23.60 adjustment',
  recon3.rows.length === 3 && recon3.rows.every((r) => r.state === 'FULLY_INVOICED' && near(r.uninvoiced_payable, 0))
  && near(recon3.rows.reduce((t, r) => t + Number(r.difference_posted), 0), 23.6))
const ppvRep = await acct(`select public.purchase_invoice_report('PRICE_VARIANCE', $1::jsonb)`, [JSON.stringify({ supplier_id: sup1 })])
ok('price variance report: the one line, receipt 400 vs invoice 420 (+5%)', ppvRep.rows.length === 1 && near(ppvRep.rows[0].variance, 20) && near(ppvRep.rows[0].variance_percent, 5))

// 3. Tolerances, GST-rate variance, totals and reservations on a third receipt.
const G3 = await grnPost(sup1, [[1, 100, 18]])
await acct(`select public.accounting_posting_run(500)`)
const t1 = await save('pm', pinv(sup1, 'S1/T-001', [grnL(G3.line(100), 1, 102, 18)], { supplier_stated_total: '120.36' }))
ok('2% price difference with no tolerance: PRICE_VARIANCE', codes(t1).join() === 'PRICE_VARIANCE')
ok('tolerances are set with accounting_settings.manage only', await refused('pm', `select public.purchase_invoice_settings_save('{"pi_price_tolerance_percent": 5}'::jsonb)`, null, /not allowed/)
  && await refused('acct', `select public.purchase_invoice_settings_save('{"pi_price_tolerance_percent": 150}'::jsonb)`, null, /between 0 and 100/))
await acct(`select public.purchase_invoice_settings_save('{"pi_price_tolerance_percent": 5, "pi_amount_tolerance": 50}'::jsonb)`)
const t1b = await save('pm', pinv(sup1, 'S1/T-001', [grnL(G3.line(100), 1, 102, 18)], { supplier_stated_total: '120.36' }), t1.id, t1.row_version)
const t1c = await save('pm', pinv(sup1, 'S1/T-001', [grnL(G3.line(100), 1, 102, 12)], { supplier_stated_total: '120.36' }), t1.id, t1b.row_version)
ok('within 5% / ₹50 the difference is accepted; a GST rate different from the receipt is flagged; a total different from the supplier\'s blocks',
  t1b.issues.length === 0 && codes(t1c).includes('GST_RATE_VARIANCE') && codes(t1c).includes('TOTAL_MISMATCH')
  && await refused('pm', `select public.purchase_invoice_submit($1::uuid)`, [t1.id], /differs from the calculated total/))
await acct(`select public.purchase_invoice_settings_save('{"pi_price_tolerance_percent": 0, "pi_amount_tolerance": 0}'::jsonb)`)
ok('a second invoice for the same receipt quantity is refused while the first (draft) holds it',
  await saveRefused('pm', pinv(sup1, 'S1/T-002', [grnL(G3.line(100), 1, 100, 18)]), /only 0(\.0+)? of goods receipt/))
ok('cancel needs a reason; viewers cannot enter invoices', await refused('pm', `select public.purchase_invoice_cancel($1::uuid, '')`, [t1.id], /reason/)
  && await saveRefused('viewer', pinv(sup1, 'S1/V-1', []), /not allowed/))
await act('pm', 'cancel', t1.id, 'entered for the tolerance test')
ok('goods receipt locked: a receipt matched to a live invoice cannot be reversed; one whose invoice was cancelled can',
  await refused('op', `select public.goods_receipt_reverse($1::uuid, 'wrong supplier', gen_random_uuid())`, [G1.id], /matched to supplier invoice/)
  && !!(await op(`select public.goods_receipt_reverse($1::uuid, 'wrong supplier', gen_random_uuid())`, [G3.id])))
ok('…and a reversed receipt cannot be invoiced', await saveRefused('pm', pinv(sup1, 'S1/T-003', [grnL(G3.line(100), 1, 100, 18)]), /has been reversed/))

// 4. A receipt not yet in the books cannot be invoiced past submission; return to draft.
const G4 = await grnPost(sup1, [[2, 50, 5]])
const n1 = await save('pm', pinv(sup1, 'S1/N-001', [grnL(G4.line(50), 2, 50, 5)], { supplier_stated_total: '105.00' }))
ok('receipt not posted to the accounts yet: blocking GRN_NOT_POSTED (the invoice would otherwise adjust a payable that is not in the books)',
  codes(n1).includes('GRN_NOT_POSTED') && await refused('pm', `select public.purchase_invoice_submit($1::uuid)`, [n1.id], /not posted to the accounts yet/))
await acct(`select public.accounting_posting_run(500)`)
const cands = await acct(`select public.purchase_invoice_matching_candidates($1::uuid, null, false)`, [sup1])
const candsAll = await acct(`select public.purchase_invoice_matching_candidates($1::uuid, null, true)`, [sup1])
ok('matching candidates: only lines with quantity left (the drafted G4 line is reserved); with fully invoiced lines on request; reversed receipts never',
  cands.length === 0 && candsAll.length === 4 && candsAll.every((c) => c.receipt_number !== G3.number)
  && near(candsAll.find((c) => c.line_id === G1.line(100)).invoiced_quantity, 10))
await act('pm', 'submit', n1.id)
ok('return to draft needs a reason; then the draft can be edited again', await refused('pm', `select public.purchase_invoice_return_to_draft($1::uuid, 'x')`, [n1.id], /reason/)
  && (await act('pm', 'return_to_draft', n1.id, 'supplier sent a revised copy')).status === 'DRAFT')
await act('pm', 'cancel', n1.id, 'replaced by the revised copy')

// 5. Direct (non-receipt) service invoice: GST, cost centres and validation.
const creditorsAcc = await val(`select id::text from public.accounts where company_id = $1 and system_key = 'CREDITORS_CONTROL'`, [A])
const svc = (lines, extra = {}) => pinv(sup1, 'INV/2026-001', lines, { invoice_type: 'SERVICE', supplier_stated_total: '17700.00', ...extra })
const split = [{ cost_centre_id: ccProd, amount: '6000.00' }, { cost_centre_id: ccAdmin, amount: '4000.00' }]
ok('save-time validation: unknown GST rate, invalid GSTIN, GST on an exempt / non-GST supply, an unknown invoice type',
  await saveRefused('pm', svc([dirL(rent, 1000, 17)]), /is not a GST rate/)
  && await saveRefused('pm', svc([dirL(rent, 1000, 18)], { supplier_gstin: '27ABC' }), /not a valid GSTIN/)
  && await saveRefused('pm', svc([dirL(rent, 1000, 18)], { supply_category: 'EXEMPT' }), /carry no GST/)
  && await saveRefused('pm', svc([dirL(rent, 1000, 5)], { supply_category: 'NON_GST' }), /carry no GST/)
  && await saveRefused('pm', svc([dirL(rent, 1000, 18)], { invoice_type: 'CAPITAL' }), /Unknown invoice type/))
const inv1 = await save('pm', svc([dirL(electricity, 10000, 18, { description: 'Power, October' }), dirL(rent, 5000, 18, { description: 'Office rent' }),
  dirL(creditorsAcc, 1, 0)], { supplier_invoice_date: future }))
ok('submit-time issues: cost-centre split required (none assumed), control account not allowed, future date, total mismatch',
  ['ALLOCATION_REQUIRED', 'ACCOUNT_NOT_ALLOWED', 'FUTURE_INVOICE_DATE', 'TOTAL_MISMATCH'].every((c) => codes(inv1).includes(c))
  && await refused('pm', `select public.purchase_invoice_submit($1::uuid)`, [inv1.id], /./))
const d1b = await save('pm', svc([dirL(electricity, 10000, 18, { allocations: [{ cost_centre_id: ccProd, amount: '6000.00' }] }), dirL(rent, 5000, 18)]), inv1.id)
ok('a split that does not add up to the taxable value is refused at submit', codes(d1b).join() === 'ALLOCATION_MISMATCH')
const d1c = await save('pm', svc([dirL(electricity, 10000, 18, { description: 'Power, October', allocations: split }), dirL(rent, 5000, 18, { description: 'Office rent' })]), inv1.id)
ok('corrected: 15,000 + CGST 1,350 + SGST 1,350 = 17,700, no issues, split stored', d1c.issues.length === 0 && near(d1c.grand_total, 17700)
  && d1c.lines[0].allocations.length === 2 && near(d1c.cgst_total, 1350))
ok('duplicate supplier invoice number (case, spaces and separators ignored) for the same supplier is refused; another supplier may use it',
  await saveRefused('pm', pinv(sup1, 'inv 2026 001', [dirL(rent, 10, 0)]), /already been entered/)
  && !!(await save('pm', pinv(sup2, 'INV/2026-001', [dirL(rent, 10, 0)]))).id)
await act('pm', 'submit', inv1.id)
await act('acct', 'approve', inv1.id, null, false)
const credBeforeD1 = await credOf(sup1Party)
const d1p = await act('acct', 'post', inv1.id)
const d1v = await vlines(d1p.voucher_id)
ok('direct invoice posts Dr expense lines (with their cost-centre split), Dr GST pending 2,700 / Cr Creditors (party) 17,700',
  d1v.length === 4 && d1v[0].code === '6500' && near(d1v[0].dr, 10000) && d1v[0].allocs === 2 && d1v[1].code === '6200' && near(d1v[1].dr, 5000) && d1v[1].allocs === 0
  && d1v[2].key === 'GST_INPUT_PENDING' && near(d1v[2].dr, 2700) && d1v[3].key === 'CREDITORS_CONTROL' && near(d1v[3].cr, 17700) && d1v[3].party === sup1Party
  && near(await credOf(sup1Party), credBeforeD1 + 17700))
ok('a posted invoice is immutable (owner included); its lines and splits too; history is append-only',
  await ownerRefused(`update public.purchase_invoices set narration = 'changed' where id = '${inv1.id}'`, /cannot be changed; reverse it/)
  && await ownerRefused(`update public.purchase_invoice_lines set description = 'x' where invoice_id = '${inv1.id}'`, /only be changed while the invoice is a draft/)
  && await ownerRefused(`update public.purchase_invoice_allocations set amount = 1 where invoice_line_id in (select id from public.purchase_invoice_lines where invoice_id = '${inv1.id}')`, /only be changed while it is a draft/)
  && await ownerRefused(`update public.purchase_invoice_history set note = 'x' where invoice_id = '${inv1.id}'`, /append-only/))
ok('no direct writes from the API roles', await refused('acct', `insert into public.purchase_invoices (company_id) values ($1)`, [A], /permission denied/)
  && await refused('acct', `update public.purchase_invoices set narration = 'x'`, null, /permission denied/)
  && await refused('acct', `delete from public.supplier_payment_allocations`, null, /permission denied/)
  && await refused('service_role', `select count(*) from public.purchase_invoices`, null, /permission denied/))

// 6. Inter-state (IGST), exempt and reverse-charge invoices.
const d2 = await save('pm', pinv(sup2, 'S2-IG-77', [dirL(rent, 1000, 18)], { invoice_type: 'EXPENSE', supplier_stated_total: '1180.00' }))
ok('inter-state supplier: IGST 180 (no CGST / SGST), treatment derived from the place of supply', d2.tax_treatment === 'INTER_STATE' && d2.place_of_supply_state_code === '29'
  && near(d2.igst_total, 180) && near(d2.cgst_total, 0) && d2.issues.length === 0)
for (const f of ['submit']) await act('pm', f, d2.id)
await act('acct', 'approve', d2.id, null, false); await act('acct', 'post', d2.id)
const d3 = await save('pm', pinv(sup1, 'S1-EX-5', [dirL(rent, 500, 0)], { invoice_type: 'OTHER', supply_category: 'EXEMPT', supplier_stated_total: '500' }))
ok('exempt supply: no GST, GST not applicable', near(d3.grand_total, 500) && d3.gst_status === 'NOT_APPLICABLE' && d3.issues.length === 0)
await act('pm', 'submit', d3.id); await act('acct', 'approve', d3.id, null, false); await act('acct', 'post', d3.id)
const d4 = await save('pm', pinv(sup1, 'S1-RCM-9', [dirL(rent, 1000, 5)], { invoice_type: 'FREIGHT', reverse_charge: true, supplier_stated_total: '1000.00' }))
ok('reverse charge: tax computed (CGST 25 + SGST 25) but not payable to the supplier (total 1,000)', near(d4.grand_total, 1000) && near(d4.cgst_total, 25) && d4.issues.length === 0)
await act('pm', 'submit', d4.id); await act('acct', 'approve', d4.id, null, false)
const d4v = await vlines((await act('acct', 'post', d4.id)).voucher_id)
ok('reverse-charge posting: Dr expense 1,000, Dr GST pending 50 / Cr GST payable (RCM) 50, Cr Creditors 1,000',
  d4v.length === 4 && near(d4v[0].dr, 1000) && d4v[1].key === 'GST_INPUT_PENDING' && near(d4v[1].dr, 50) && d4v[2].key === 'RCM_GST_PAYABLE' && near(d4v[2].cr, 50)
  && d4v[3].key === 'CREDITORS_CONTROL' && near(d4v[3].cr, 1000))
const rcmGrn = await save('pm', pinv(sup1, 'S1-RCM-GRN', [grnL(G4.line(50), 2, 50, 5)], { reverse_charge: true, supplier_stated_total: '100.00' }))
ok('reverse charge cannot be matched to receipts here (blocking)', codes(rcmGrn).includes('RCM_GRN'))
await act('pm', 'cancel', rcmGrn.id, 'test only')

// 7. Segregation of duties.
await acct(`select public.accounting_settings_save('{"segregation_of_duties": true}'::jsonb)`)
const sod1 = await save('acct', pinv(sup1, 'S1-SOD-1', [dirL(rent, 100, 0)], { supplier_stated_total: '100' }))
await act('acct', 'submit', sod1.id)
ok('segregation of duties (when on): the person who entered the invoice cannot approve it; another accountant can',
  await refused('acct', `select public.purchase_invoice_approve($1::uuid)`, [sod1.id], /Segregation of duties/)
  && (await act('acct2', 'approve', sod1.id, null, false)).status === 'APPROVED')
await act('acct', 'cancel', sod1.id, 'segregation test')
await acct(`select public.accounting_settings_save('{"segregation_of_duties": false}'::jsonb)`)

// 8. GST verification: never claimed automatically.
const checks = JSON.stringify({ invoice_verified: true, goods_services_received: true, gstin_valid: true })
ok('GST verification needs purchase_invoices.verify_gst, the three checks for ELIGIBLE and a reason of 10+ characters',
  await refused('pm', `select public.purchase_invoice_verify_gst($1::uuid, 'ELIGIBLE', 'checked with the portal', $2::jsonb)`, [inv1.id, checks], /not allowed/)
  && await refused('viewer', `select public.purchase_invoice_verify_gst($1::uuid, 'ELIGIBLE', 'checked with the portal', $2::jsonb)`, [inv1.id, checks], /not allowed/)
  && await refused('acct', `select public.purchase_invoice_verify_gst($1::uuid, 'ELIGIBLE', 'checked with the portal', '{"invoice_verified": true}'::jsonb)`, [inv1.id], /needs the checks/)
  && await refused('acct', `select public.purchase_invoice_verify_gst($1::uuid, 'ELIGIBLE', 'ok', $2::jsonb)`, [inv1.id, checks], /at least 10 characters/)
  && await refused('acct', `select public.purchase_invoice_verify_gst($1::uuid, 'MAYBE', 'checked with the portal', $2::jsonb)`, [inv1.id, checks], /ELIGIBLE or INELIGIBLE/))
const gp1 = await act('acct', 'verify_gst', inv1.id, 'ELIGIBLE', 'Invoice and GSTIN checked against the supplier copy', checks)
ok('ITC maker-checker (Gate C): the Phase 3 verification only proposes — no voucher, GST still pending; the proposer cannot approve; no second proposal',
  gp1.gst_status === 'PENDING_VERIFICATION' && gp1.itc_stage === 'PROPOSED' && !gp1.gst_voucher_id
  && await val(`select count(*)::int from public.accounting_vouchers where source_id = $1 and source_type in ('PURCHASE_INVOICE_GST', 'GST_ITC_DECISION')`, [inv1.id]) === 0
  && await refused('acct', `select public.gst_itc_action($1::uuid, 'APPROVE', '{}'::jsonb)`, [inv1.id], /Maker-checker/)
  && await refused('acct2', `select public.purchase_invoice_verify_gst($1::uuid, 'INELIGIBLE', 'another proposal attempt', '{}'::jsonb)`, [inv1.id], /awaiting approval/))
await as('acct2')(`select public.gst_itc_action($1::uuid, 'APPROVE', '{}'::jsonb)`, [inv1.id])
const d1g = await acct(`select public.purchase_invoice_get($1::uuid)`, [inv1.id])
ok('…approved by another user: the same Phase 3 voucher identity (PIN, PURCHASE_INVOICE_GST) and decision history PROPOSED (acct) → DECIDED (acct2)',
  await val(`select t.type_code || ':' || v.source_type || ':' || (v.source_id = $2) from public.accounting_vouchers v join public.accounting_voucher_types t on t.id = v.voucher_type_id where v.id = $1`,
    [d1g.gst_voucher_id, inv1.id]) === 'PIN:PURCHASE_INVOICE_GST:true'
  && await val(`select string_agg(stage || '/' || (actor_id = rls_test.id(case stage when 'PROPOSED' then 'acct' else 'acct2' end)), ',' order by seq) from public.gst_itc_decisions where purchase_invoice_id = $1`, [inv1.id])
     === 'PROPOSED/true,DECIDED/true')
const d1gv = await vlines(d1g.gst_voucher_id)
ok('ELIGIBLE: Dr Input CGST 1,350 + Input SGST 1,350 / Cr GST pending 2,700 (separate PIN voucher); recorded with the checks', d1g.gst_status === 'ELIGIBLE'
  && d1gv.length === 3 && d1gv[0].key === 'INPUT_CGST' && near(d1gv[0].dr, 1350) && d1gv[1].key === 'INPUT_SGST' && near(d1gv[1].dr, 1350)
  && d1gv[2].key === 'GST_INPUT_PENDING' && near(d1gv[2].cr, 2700) && d1g.gst_verification.checks.gstin_valid === true
  && await refused('acct', `select public.purchase_invoice_verify_gst($1::uuid, 'INELIGIBLE', 'second attempt here', '{}'::jsonb)`, [inv1.id], /only pending GST/))
await act('acct', 'verify_gst', m2.id, 'INELIGIBLE', 'Proposed in error — to be rejected', '{}')
const m2r = await as('acct2')(`select public.gst_itc_action($1::uuid, 'REJECT', '{"reason": "wrong basis"}'::jsonb)`, [m2.id])
ok('a rejected proposal posts nothing and leaves the GST pending for a new proposal', m2r.stage === 'REJECTED' && m2r.gst_status === 'PENDING_VERIFICATION' && !m2r.gst_voucher_id)
const m2g = await gstVerify(m2.id, 'INELIGIBLE', 'Goods used for exempt supplies (blocked credit)', '{}')
const m2gv = await vlines(m2g.gst_voucher_id)
ok('INELIGIBLE (matched invoice): the whole invoice GST 195.60 — receipt share 192 + invoice difference 3.60 — moves to the ineligible-GST expense',
  m2g.gst_status === 'INELIGIBLE' && m2gv.length === 2 && m2gv[0].key === 'GST_INPUT_INELIGIBLE' && near(m2gv[0].dr, 195.6) && near(m2gv[1].cr, 195.6))
const d2g = await gstVerify(d2.id, 'ELIGIBLE', 'IGST invoice verified with GSTR-2B copy', checks)
ok('IGST goes to Input IGST; exempt invoices have no GST to verify', (await vlines(d2g.gst_voucher_id))[0].key === 'INPUT_IGST'
  && await refused('acct', `select public.purchase_invoice_verify_gst($1::uuid, 'ELIGIBLE', 'nothing to verify here', $2::jsonb)`, [d3.id, checks], /only pending GST/))
const gstPend = await acct(`select public.purchase_invoice_report('GST_PENDING', '{}'::jsonb)`)
ok('GST pending report lists the unverified invoices only (M1, the RCM invoice)', gstPend.rows.some((r) => r.invoice_id === m1.id) && gstPend.rows.some((r) => r.invoice_id === d4.id)
  && !gstPend.rows.some((r) => [inv1.id, m2.id, d2.id, d3.id].includes(r.invoice_id)) && typeof gstPend.ledger_pending_balance === 'number')
const itc = await acct(`select public.purchase_invoice_report('ITC_SUMMARY', '{}'::jsonb)`)
ok('ITC summary comes from the ledgers: Input CGST 1,350, Input IGST 180, ineligible 195.60', near(itc.rows.find((r) => r.rule_key === 'INPUT_CGST').closing_balance, 1350)
  && near(itc.rows.find((r) => r.rule_key === 'INPUT_IGST').closing_balance, 180) && near(itc.rows.find((r) => r.rule_key === 'GST_INPUT_INELIGIBLE').closing_balance, 195.6))

// 9. Supplier payments against invoices (existing payments; their vouchers are unchanged).
const pay = await op(`select public.supplier_payment_record($1::uuid, $2::date, 5000.00, 'BANK_TRANSFER', 'PI-PAY', 'invoice test', gen_random_uuid())`, [sup1, today])
ok('available payments of the supplier with the unallocated amount', near((await pm(`select public.purchase_invoice_supplier_payments($1::uuid)`, [sup1])).find((p) => p.id === pay.payment_id).unallocated, 5000))
const d1pay = await act('pm', 'allocate_payment', inv1.id, pay.payment_id, 3000)
ok('allocation: outstanding 14,700, paid 3,000', near(d1pay.outstanding, 14700) && near(d1pay.paid, 3000) && d1pay.payments.length === 1)
ok('allocation limits: never more than the payment\'s unallocated amount or the invoice outstanding; same supplier; posted invoices; permission',
  await refused('pm', `select public.purchase_invoice_allocate_payment($1::uuid, $2::uuid, 3000)`, [inv1.id, pay.payment_id], /Only 2000(\.0+)? of payment/)
  && await refused('pm', `select public.purchase_invoice_allocate_payment($1::uuid, $2::uuid, 1500)`, [m1.id, pay.payment_id], /has only 1298(\.0+)? outstanding/)
  && await refused('pm', `select public.purchase_invoice_allocate_payment($1::uuid, $2::uuid, 10)`, [d2.id, pay.payment_id], /belongs to another supplier/)
  && await refused('pm', `select public.purchase_invoice_allocate_payment($1::uuid, $2::uuid, 10)`, [sod1.id, pay.payment_id], /needs it to be posted/)
  && await refused('viewer', `select public.purchase_invoice_allocate_payment($1::uuid, $2::uuid, 10)`, [m1.id, pay.payment_id], /not allowed/)
  && await refused('pm', `select public.purchase_invoice_allocate_payment($1::uuid, $2::uuid, 10.005)`, [m1.id, pay.payment_id], /at most 2 decimals/))
const outRep = await acct(`select public.purchase_invoice_report('OUTSTANDING', $1::jsonb)`, [JSON.stringify({ supplier_id: sup1 })])
const ageRep = await acct(`select public.purchase_invoice_report('AGEING', $1::jsonb)`, [JSON.stringify({ supplier_id: sup1 })])
const sup1Out = outRep.rows.reduce((t, r) => t + Number(r.outstanding), 0)
ok('outstanding and ageing: D1 partly paid; ageing buckets add up to the outstanding invoices; the ledger Creditors figure is shown beside it',
  outRep.rows.find((r) => r.invoice_id === inv1.id).payment_status === 'PARTLY_PAID' && outRep.rows.find((r) => r.invoice_id === m1.id).payment_status === 'UNPAID'
  && ageRep.rows.length === 1 && near(ageRep.rows[0].total, sup1Out) && near(ageRep.rows[0].total, Number(ageRep.rows[0].not_due) + Number(ageRep.rows[0].d1_30)
    + Number(ageRep.rows[0].d31_60) + Number(ageRep.rows[0].d61_90) + Number(ageRep.rows[0].d90_plus)) && typeof ageRep.rows[0].ledger_creditors === 'number')
ok('an allocation can only be reversed (never edited)', await ownerRefused(`update public.supplier_payment_allocations set amount = 1 where invoice_id = '${inv1.id}'`, /only be reversed/))
ok('an invoice with payments allocated cannot be reversed', await refused('acct', `select public.purchase_invoice_reverse($1::uuid, 'wrong supplier')`, [inv1.id], /Payments are allocated/))
const d1un = await act('pm', 'unallocate_payment', d1pay.payments[0].id, 'allocated to the wrong invoice')
ok('unallocating restores the outstanding', near(d1un.outstanding, 17700) && d1un.payments[0].status === 'REVERSED')
await act('pm', 'allocate_payment', m1.id, pay.payment_id, 1000)
await op(`select public.supplier_payment_reverse($1::uuid, 'cheque bounced (invoice test)')`, [pay.payment_id])
ok('a reversed supplier payment no longer pays the invoice (outstanding back to 1,298) and is no longer offered',
  near((await acct(`select public.purchase_invoice_get($1::uuid)`, [m1.id])).outstanding, 1298)
  && !(await pm(`select public.purchase_invoice_supplier_payments($1::uuid)`, [sup1])).some((p) => p.id === pay.payment_id))

// 10. Cost-centre purchase expense, registers, then reversal.
const ccRep = await acct(`select public.purchase_invoice_report('COST_CENTRE_EXPENSE', '{}'::jsonb)`)
ok('cost-centre purchase expense (from posted vouchers): Production 6,000 and Administration 4,000 on Electricity; un-split expense reported separately',
  near(ccRep.rows.find((r) => r.cost_centre_code === 'PROD' && r.account_code === '6500').amount, 6000)
  && near(ccRep.rows.find((r) => r.cost_centre_code === 'ADMIN' && r.account_code === '6500').amount, 4000) && Number(ccRep.unallocated) > 0)
const preg = await acct(`select public.purchase_invoice_report('PURCHASE_REGISTER', $1::jsonb)`, [JSON.stringify({ supplier_id: sup1 })])
const sreg = await acct(`select public.purchase_invoice_report('SUPPLIER_INVOICE_REGISTER', $1::jsonb)`, [JSON.stringify({ supplier_id: sup1 })])
ok('purchase register: posted invoices only; supplier invoice register: every status', preg.rows.every((r) => ['POSTED', 'REVERSED'].includes(r.status)) && preg.rows.length === 5
  && sreg.rows.some((r) => r.status === 'CANCELLED') && sreg.rows.length > preg.rows.length
  && await refused('acct', `select public.purchase_invoice_report('BALANCE_SHEET', '{}'::jsonb)`, null, /Unknown report/))
ok('list: search by supplier invoice number, status and outstanding filters', (await pm(`select public.purchase_invoice_list('{"search": "2026-001"}'::jsonb)`)).length === 2
  && (await pm(`select public.purchase_invoice_list('{"status": "CANCELLED"}'::jsonb)`)).every((x) => x.status === 'CANCELLED')
  && (await pm(`select public.purchase_invoice_list('{"outstanding_only": true}'::jsonb)`)).every((x) => x.status === 'POSTED' && Number(x.outstanding) > 0))
const credBeforeRev = await credOf(sup1Party)
ok('reversal needs purchase_invoices.reverse and a reason', await refused('pm', `select public.purchase_invoice_reverse($1::uuid, 'wrong supplier')`, [inv1.id], /not allowed/)
  && await refused('acct', `select public.purchase_invoice_reverse($1::uuid, 'x')`, [inv1.id], /reason/))
const d1r = await act('acct', 'reverse', inv1.id, 'billed to the wrong supplier')
ok('reversal: REVERSED; the posting and GST vouchers get linked reversals (one each); Creditors back by 17,700; cost-centre expense nets to zero',
  d1r.status === 'REVERSED' && await val(`select count(*)::int from public.accounting_vouchers where reversal_of_voucher_id in ($1::uuid, $2::uuid) and status = 'POSTED'`,
    [d1r.voucher_id, d1r.gst_voucher_id]) === 2
  && await val(`select string_agg(status, ',' order by status) from public.accounting_vouchers where id in ($1::uuid, $2::uuid)`, [d1r.voucher_id, d1r.gst_voucher_id]) === 'REVERSED,REVERSED'
  && near(await credOf(sup1Party), credBeforeRev - 17700)
  && !(await acct(`select public.purchase_invoice_report('COST_CENTRE_EXPENSE', '{}'::jsonb)`)).rows.some((r) => r.account_code === '6500')
  && await refused('acct', `select public.purchase_invoice_reverse($1::uuid, 'second time')`, [inv1.id], /needs it to be posted/)
  && await ownerRefused(`update public.purchase_invoices set narration = 'x' where id = '${inv1.id}'`, /reversed or cancelled/))
ok('after a reversal the supplier invoice number can be entered again (correct re-entry)', !!(await save('pm', pinv(sup1, 'INV/2026-001', [dirL(rent, 10, 0)]))).id)
ok('history: every step recorded in order', (await acct(`select public.purchase_invoice_get($1::uuid)`, [m2.id])).history.map((h) => h.action).join()
  === 'CREATED,SUBMITTED,APPROVED,POSTED,GST_VERIFIED'
  && await val(`select count(*)::int from public.audit_logs where resource_type = 'purchase_invoice' and resource_id = $1`, [m2.id]) === 5)
ok('attachments: supplier invoices are a documents entity read with purchase_invoices.read', await val(`select private.document_entity_permission('PURCHASE_INVOICE')`) === 'purchase_invoices.read')

// 11. Isolation and read-only.
ok('company isolation: company B sees no supplier invoices, allocations or receipts of company A',
  (await as('b_op')(`select public.purchase_invoice_list()`)).length === 0 && (await request('b_op', `select count(*)::int from public.purchase_invoices`)).value === 0
  && (await request('b_op', `select count(*)::int from public.supplier_payment_allocations`)).value === 0
  && await refused('b_op', `select public.purchase_invoice_get($1::uuid)`, [m2.id], /not found/)
  && (await as('b_op')(`select public.purchase_invoice_matching_candidates($1::uuid)`, [sup1])).length === 0
  && await refused('b_op', `select public.purchase_invoice_post($1::uuid)`, [m2.id], /not found|not set up/)
  && await refused('sales', `select public.purchase_invoice_list()`, null, /not allowed/))
ok('Phase 3 rollback is refused while supplier invoices exist', await ownerRefused(await read(path.join(rbDir, `${PI}_down.sql`)), /Supplier invoices exist/))
ok('Phase 3 read-only RPCs run inside a READ ONLY transaction', await (async () => {
  await db.exec('reset role'); await db.exec('begin read only')
  try {
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: await val(`select rls_test.id('acct')::text`), role: 'authenticated' })])
    await db.exec('reset role'); await db.exec('set local role authenticated')
    for (const q of [`select public.purchase_invoice_list('{}'::jsonb)`, `select public.purchase_invoice_lookups()`, `select public.purchase_invoice_get('${m2.id}'::uuid)`,
      `select public.purchase_invoice_matching_candidates('${sup1}'::uuid, null, true)`, `select public.purchase_invoice_supplier_payments('${sup1}'::uuid)`,
      ...['PURCHASE_REGISTER', 'SUPPLIER_INVOICE_REGISTER', 'OUTSTANDING', 'AGEING', 'GRN_RECONCILIATION', 'GST_PENDING', 'ITC_SUMMARY', 'PRICE_VARIANCE', 'COST_CENTRE_EXPENSE']
        .map((r) => `select public.purchase_invoice_report('${r}', '{}'::jsonb)`)]) await db.query(q)
    await db.exec('rollback'); return true
  } catch (e) { await db.exec('rollback').catch(() => {}); console.log('      got:', e.message); return false }
})())

console.log('\nQ. Bank & cash (Phase 4)')
const bcPerms = (role) => val(`select coalesce(string_agg(p.code, ',' order by p.code), '') from public.role_permissions rp join public.roles r on r.id = rp.role_id
  join public.permissions p on p.id = rp.permission_id where r.code = $1 and p.resource in ('bank_accounts', 'cash_accounts', 'bank_reconciliation', 'bank_transfers')`, [role])
ok('permissions: Accounts Manager all nine; Admin and Management Viewer read only; Sales Manager none',
  await bcPerms('ACCOUNTS_MANAGER') === 'bank_accounts.manage,bank_accounts.read,bank_reconciliation.approve,bank_reconciliation.manage,bank_reconciliation.read,bank_transfers.create,bank_transfers.post,cash_accounts.manage,cash_accounts.read'
  && await bcPerms('ADMIN') === 'bank_accounts.read,bank_reconciliation.read,cash_accounts.read' && await bcPerms('MANAGEMENT_VIEWER') === 'bank_accounts.read,bank_reconciliation.read,cash_accounts.read'
  && await bcPerms('SALES_MANAGER') === '')
ok('CTR (contra) and BNK (bank adjustment) voucher types seeded, automatic only',
  await val(`select string_agg(type_code || ':' || allow_manual, ',' order by type_code) from public.accounting_voucher_types where company_id = $1 and type_code in ('CTR', 'BNK')`, [A]) === 'BNK:false,CTR:false')
const ledger = async (code, name, groupCode, nature) => (await acct(`select public.accounting_account_save(null, $1::jsonb)`,
  [JSON.stringify({ account_code: code, account_name: name, group_id: await grp(groupCode), ...(nature ? { account_nature: nature } : {}) })])).id
const hdfcL = await ledger('1230', 'HDFC Current A/c 5678', 'AS.CA.BANK', 'BANK')
const sbiL = await ledger('1240', 'SBI Current A/c', 'AS.CA.BANK', 'BANK')
const pettyL = await ledger('1110', 'Petty Cash', 'AS.CA.CASH', 'CASH')
const chargesL = await ledger('6600', 'Bank Charges', 'EX.IND')
const interestL = await ledger('4500', 'Bank Interest', 'IN.OTH')
const bca = (id, body, rv = null) => acct(`select public.bank_cash_account_save($1::uuid, $2::jsonb, $3::int)`, [id, JSON.stringify(body), rv])
const bcaRefused = (user, body, pattern) => refused(user, `select public.bank_cash_account_save(null, $1::jsonb)`, [JSON.stringify(body)], pattern)
const hdfcBody = { account_kind: 'BANK', account_code: 'HDFC-CA', account_name: 'HDFC Current', ledger_account_id: hdfcL, bank_name: 'HDFC Bank', branch_name: 'Pune MIDC',
  account_holder_name: 'Alton E2E Sanitary Pvt Ltd', account_number: '5010 0012 345678', ifsc: 'hdfc0001234', bank_account_type: 'CURRENT' }
const hdfc = await bca(null, hdfcBody)
ok('bank account: full number stored apart, only a masked number shown; current accounts refuse a negative balance by default',
  hdfc.account_number_masked === 'XXXXXXXXXX5678' && hdfc.ifsc === 'HDFC0001234' && hdfc.account_fingerprint === undefined && hdfc.allow_negative_balance === false
  && hdfc.ledger_code === '1230' && !JSON.stringify(hdfc).includes('50100012345678'))
ok('the number and its fingerprint are not readable by API roles; reveal needs bank_accounts.manage and is audited',
  await refused('acct', `select account_fingerprint from public.bank_cash_accounts`, null, /permission denied/)
  && await refused('acct', `select * from public.bank_account_numbers`, null, /permission denied/)
  && await refused('service_role', `select count(*) from public.bank_cash_accounts`, null, /permission denied/)
  && await acct(`select public.bank_account_reveal_number($1::uuid)`, [hdfc.id]) === '50100012345678'
  && await refused('viewer', `select public.bank_account_reveal_number($1::uuid)`, [hdfc.id], /not allowed/)
  && await val(`select count(*)::int from public.audit_logs where action = 'bank_cash_account.number_revealed' and resource_id = $1`, [hdfc.id]) === 1)
ok('master rules: the same bank account twice, a ledger already linked, a cash ledger for a bank, a bad IFSC and viewers are refused',
  await bcaRefused('acct', { ...hdfcBody, account_code: 'HDFC-2', ledger_account_id: sbiL, account_number: '50100012345678' }, /already registered/)
  && await bcaRefused('acct', { ...hdfcBody, account_code: 'HDFC-3', account_number: '99999999' }, /already linked/)
  && await bcaRefused('acct', { ...hdfcBody, account_code: 'HDFC-4', ledger_account_id: pettyL, account_number: '88888888' }, /not a bank ledger/)
  && await bcaRefused('acct', { ...hdfcBody, account_code: 'HDFC-5', ledger_account_id: sbiL, ifsc: 'HDFC1234567', account_number: '77777777' }, /IFSC/)
  && await bcaRefused('viewer', { ...hdfcBody, account_code: 'V1', ledger_account_id: sbiL }, /not allowed/))
const sbi = await bca(null, { ...hdfcBody, account_code: 'SBI-CA', account_name: 'SBI Current', ledger_account_id: sbiL, bank_name: 'State Bank of India', ifsc: 'SBIN0000456',
  account_number: '30123456789' })
const acctUser = await val(`select rls_test.id('acct')::text`)
ok('cash accounts: a cash ledger, a custodian of the company, no bank details', await bcaRefused('acct', { account_kind: 'CASH', account_code: 'PC', account_name: 'Petty',
  ledger_account_id: pettyL, ifsc: 'HDFC0001234' }, /no bank details/))
const petty = await bca(null, { account_kind: 'CASH', account_code: 'PETTY', account_name: 'Petty Cash', ledger_account_id: pettyL, custodian_user_id: acctUser,
  opening_balance: '0', opening_balance_type: 'DEBIT', opening_balance_date: fyStart })
ok('…saved with its custodian; viewers see masked bank accounts and cash accounts', petty.account_kind === 'CASH' && petty.custodian_name === 'acct'
  && (await as('viewer')(`select public.bank_cash_account_list()`)).length === 3 && (await as('viewer')(`select public.bank_cash_account_list('BANK')`)).every((x) => /^X+\d{4}$/.test(x.account_number_masked)))
await acct(`select public.accounting_voucher_post($1::uuid)`, [(await acct(`select public.accounting_voucher_create($1::jsonb)`, [jv(today, [{ account_id: hdfcL, debit: '200000' }, { account_id: rent, credit: '200000' }])])).id])

// Transfers.
const trf = (body) => acct(`select public.bank_transfer_save(null, $1::jsonb)`, [JSON.stringify({ transfer_date: today, ...body })])
const postTrf = (id, user = 'acct') => as(user)(`select public.bank_transfer_post($1::uuid)`, [id])
const book = (id, extra = {}) => acct(`select public.bank_cash_book($1::uuid, $2::date, $3::date, $4::jsonb)`, [id, fyStart, today, JSON.stringify(extra)])
const bt1 = await trf({ from_account_id: hdfc.id, to_account_id: sbi.id, amount: '100000', reference: 'RTGS-1' })
ok('transfer draft: TRF number; same source and destination refused; posting needs bank_transfers.post', /^TRF-\d{6}$/.test(bt1.transfer_number) && bt1.status === 'DRAFT'
  && await refused('acct', `select public.bank_transfer_save(null, $1::jsonb)`, [JSON.stringify({ transfer_date: today, from_account_id: hdfc.id, to_account_id: hdfc.id, amount: '5' })], /two different accounts/)
  && await refused('viewer', `select public.bank_transfer_post($1::uuid)`, [bt1.id], /not allowed/))
const t1p = await postTrf(bt1.id)
const t1v = await rows(`select a.account_code as code, l.debit::float8 as dr, l.credit::float8 as cr from public.accounting_voucher_lines l join public.accounts a on a.id = l.account_id
  where l.voucher_id = $1 order by l.line_no`, [t1p.voucher_id])
ok('posted: one CTR voucher, Dr SBI 1,00,000 / Cr HDFC 1,00,000 — no income or expense', t1p.status === 'POSTED' && t1v.length === 2 && t1v[0].code === '1240' && t1v[0].dr === 100000
  && t1v[1].code === '1230' && t1v[1].cr === 100000 && await val(`select t.type_code from public.accounting_vouchers v join public.accounting_voucher_types t on t.id = v.voucher_type_id where v.id = $1`, [t1p.voucher_id]) === 'CTR')
ok('no duplicate posting; a posted transfer is immutable', await refused('acct', `select public.bank_transfer_post($1::uuid)`, [bt1.id], /already posted/)
  && await ownerRefused(`update public.bank_transfers set amount = 1 where id = '${bt1.id}'`, /cannot be changed/)
  && Number((await book(hdfc.id)).closing_balance) === 100000 && Number((await book(sbi.id)).closing_balance) === 100000)
const t1r = await acct(`select public.bank_transfer_reverse($1::uuid, 'wrong destination bank')`, [bt1.id])
ok('reversal: linked opposite entries, transfer REVERSED, balances back', t1r.status === 'REVERSED' && /^REV/.test(t1r.reversal_voucher_number)
  && Number((await book(hdfc.id)).closing_balance) === 200000 && Number((await book(sbi.id)).closing_balance) === 0)
await postTrf((await trf({ from_account_id: hdfc.id, to_account_id: petty.id, amount: '5000', reference: 'CASH WDL' })).id)
const t3 = await trf({ from_account_id: hdfc.id, to_account_id: sbi.id, amount: '1000', charges: '25', charges_account_id: chargesL, reference: 'NEFT-SBI' })
const t3p = await postTrf(t3.id)
ok('transfer charges: Dr Bank Charges 25 / Cr source on the same voucher; refused without an expense ledger',
  (await rows(`select 1 from public.accounting_voucher_lines where voucher_id = $1`, [t3p.voucher_id])).length === 4
  && await refused('acct', `select public.bank_transfer_save(null, $1::jsonb)`, [JSON.stringify({ transfer_date: today, from_account_id: hdfc.id, to_account_id: sbi.id, amount: '5', charges: '1', charges_account_id: pettyL })], /expense ledger/))
const over = await trf({ from_account_id: petty.id, to_account_id: sbi.id, amount: '6000' })
ok('cash restriction (database trigger): a cash transfer above the cash balance is refused; nothing posted',
  await refused('acct', `select public.bank_transfer_post($1::uuid)`, [over.id], /Cash account PETTY .* would go below zero/)
  && (await acct(`select public.bank_transfer_list('{"status": "DRAFT"}'::jsonb)`)).some((x) => x.id === over.id)
  && Number((await book(petty.id)).closing_balance) === 5000)
await acct(`select public.bank_transfer_cancel($1::uuid, 'over the cash balance')`, [over.id])
await postTrf((await trf({ from_account_id: petty.id, to_account_id: hdfc.id, amount: '4000', reference: 'CASH DEP' })).id)

// Payment / receipt account mapping.
const runPosting = () => acct(`select public.accounting_posting_run(500)`)
const evt = (src) => rows(`select status, error_message, voucher_id::text from public.accounting_posting_events where source_id = $1 and event_action = 'POST'`, [src]).then((r) => r[0])
const cand = async (src) => (await acct(`select public.bank_payment_candidates('{}'::jsonb)`)).find((c) => c.source_id === src)
await acct(`select public.bank_payment_policy_save('PAYMENT', 'CASH', true)`)
const cashPay = await op(`select public.supplier_payment_record($1::uuid, $2::date, 500.00, 'CASH', 'PC-1', 'petty payment', gen_random_uuid())`, [supplierId, today])
await runPosting()
ok('a method set to "choose per payment" waits visibly (NEEDS_ACCOUNT_MAPPING) even though a CASH rule exists — never the first account',
  (await evt(cashPay.payment_id)).status === 'NEEDS_ACCOUNT_MAPPING' && /Choose the bank \/ cash account/.test((await evt(cashPay.payment_id)).error_message)
  && (await cand(cashPay.payment_id)).state === 'NEEDS_SELECTION')
ok('assignment rules: reason required, a cash payment needs a cash account, viewers cannot assign',
  await refused('acct', `select public.bank_payment_assign('SUPPLIER_PAYMENT', $1::uuid, $2::uuid, 'x')`, [cashPay.payment_id, petty.id], /at least 5/)
  && await refused('acct', `select public.bank_payment_assign('SUPPLIER_PAYMENT', $1::uuid, $2::uuid, 'petty voucher PC-1')`, [cashPay.payment_id, hdfc.id], /cash account/)
  && await refused('viewer', `select public.bank_payment_assign('SUPPLIER_PAYMENT', $1::uuid, $2::uuid, 'petty voucher PC-1')`, [cashPay.payment_id, petty.id], /not allowed/))
await acct(`select public.bank_payment_assign('SUPPLIER_PAYMENT', $1::uuid, $2::uuid, 'petty voucher PC-1 signed')`, [cashPay.payment_id, petty.id])
await runPosting()
const cashEvt = await evt(cashPay.payment_id)
ok('…assigned: posted Cr Petty Cash (the selected account), one voucher, never re-assignable once posted', cashEvt.status === 'POSTED'
  && await val(`select count(*)::int from public.accounting_voucher_lines where voucher_id = $1 and account_id = $2 and credit = 500`, [cashEvt.voucher_id, pettyL]) === 1
  && await val(`select count(*)::int from public.accounting_vouchers where source_id = $1 and source = 'AUTO'`, [cashPay.payment_id]) === 1
  && (await cand(cashPay.payment_id)).state === 'POSTED' && (await cand(cashPay.payment_id)).posted_account_code === 'PETTY'
  && await refused('acct', `select public.bank_payment_assign('SUPPLIER_PAYMENT', $1::uuid, $2::uuid, 'moved to another account')`, [cashPay.payment_id, petty.id], /already posted/))
const custId = await val(`select customer_id::text from public.parties where company_id = $1 and customer_id is not null order by party_code limit 1`, [A])
const rcptMethod = await val(`select m from unnest((select payment_methods from public.invoice_settings where company_id = $1)) m where m not in ('CASH') order by m limit 1`, [A])
await acct(`select public.bank_payment_policy_save('RECEIPT', $1, true)`, [rcptMethod])
const rcpt = await op(`select public.customer_payment_record($1::jsonb, null, gen_random_uuid())`, [JSON.stringify({ customer_id: custId, amount: '3000', payment_method: rcptMethod,
  receipt_date: today, transaction_reference: 'UTR-SBI-77' })])
const rcptId = rcpt.payment_id ?? rcpt.id ?? rcpt.receipt_id
await runPosting()
ok('a receipt whose method is set to "choose" waits; assigned to SBI it posts Dr SBI', (await evt(rcptId)).status === 'NEEDS_ACCOUNT_MAPPING'
  && !!(await acct(`select public.bank_payment_assign('CUSTOMER_RECEIPT', $1::uuid, $2::uuid, 'seen on the SBI statement')`, [rcptId, sbi.id]))
  && (await runPosting()) && (await evt(rcptId)).status === 'POSTED'
  && await val(`select count(*)::int from public.accounting_voucher_lines where voucher_id = $1 and account_id = $2 and debit = 3000`, [(await evt(rcptId)).voucher_id, sbiL]) === 1)
const upiPay = await op(`select public.supplier_payment_record($1::uuid, $2::date, 700.00, 'UPI', 'UPI-9', 'upi payment', gen_random_uuid())`, [supplierId, today])
await runPosting()
ok('an unmapped method stays visibly unmapped (no bank guessed) until an account is assigned', (await cand(upiPay.payment_id)).state === 'UNMAPPED'
  && (await evt(upiPay.payment_id)).status === 'NEEDS_ACCOUNT_MAPPING'
  && !!(await acct(`select public.bank_payment_assign('SUPPLIER_PAYMENT', $1::uuid, $2::uuid, 'UPI debit on the SBI statement')`, [upiPay.payment_id, sbi.id]))
  && (await runPosting()) && (await evt(upiPay.payment_id)).status === 'POSTED')
ok('payment policies list each method with its rule ledger and mapped account', (await acct(`select public.bank_payment_policies()`)).find((p) => p.direction === 'PAYMENT'
  && p.payment_method === 'CASH').require_selection === true && (await acct(`select public.bank_payment_policies()`)).length === 14)
await acct(`select public.bank_payment_policy_save('PAYMENT', 'CASH', false)`)
await acct(`select public.bank_payment_policy_save('RECEIPT', $1, false)`, [rcptMethod])

// Negative-balance policy can be allowed explicitly (audited); reversal restores the balance.
await bca(petty.id, { account_code: 'PETTY', account_name: 'Petty Cash', ledger_account_id: pettyL, custodian_user_id: acctUser, allow_negative_balance: true })
const neg = await trf({ from_account_id: petty.id, to_account_id: sbi.id, amount: '800' })
ok('with "allow negative balance" set on the account, the same kind of overdraw posts', (await postTrf(neg.id)).status === 'POSTED' && Number((await book(petty.id)).closing_balance) === -300)
await acct(`select public.bank_transfer_reverse($1::uuid, 'entered by mistake')`, [neg.id])
await bca(petty.id, { account_code: 'PETTY', account_name: 'Petty Cash', ledger_account_id: pettyL, custodian_user_id: acctUser, allow_negative_balance: false })

// Statement import (HDFC).
const b64 = (s) => Buffer.from(s).toString('base64')
const csv = 'date,description,debit,credit,balance\n(original file)'
const fileOf = (name = 'hdfc-nov.csv', body = csv) => JSON.stringify({ name, mime: 'text/csv', content_base64: b64(body) })
const sr = (row_no, description, debit, credit, running_balance, extra = {}) => ({ row_no, txn_date: today, description, debit, credit, running_balance, ...extra })
const hdfcRows = [sr(1, 'NEFT IN OPENING FUNDS', '', '200000', '200000'), sr(2, 'RTGS-1 TO SBI', '100000', '', '100000'), sr(3, 'RTGS-1 RETURN', '', '100000', '200000'),
  sr(4, 'CASH WDL SELF', '5000', '', '195000'), sr(5, 'NEFT-SBI INCL CHG', '1025', '', '193975'), sr(6, 'CASH DEP', '', '4000', '197975'),
  sr(7, 'SMS CHARGES QTR', '59', '', '197916'), sr(8, 'INT.CR SAVINGS', '', '120', '198036'),
  sr(9, 'BOTH SIDES', '10', '10', ''), sr(10, 'BAD DATE', '5', '', '', { txn_date: '2026-13-40' }), sr(11, 'NEGATIVE', '-5', '', '')]
const imp = (rowsIn, commit, account = hdfc.id, file = fileOf()) => acct(`select public.bank_statement_import($1::uuid, $2::jsonb, $3::jsonb, $4::jsonb, $5)`,
  [account, file, JSON.stringify({ date: 'Date', description: 'Narration', debit: 'Withdrawal', credit: 'Deposit', balance: 'Balance' }), JSON.stringify(rowsIn), commit])
const prev = await imp(hdfcRows, false)
ok('preview: 8 importable, 3 failed with reasons (both sides, invalid date, negative amount); nothing written', prev.preview === true && prev.importable_count === 8
  && prev.failed_count === 3 && prev.report.filter((r) => r.status === 'FAILED').map((r) => r.row_no).join() === '9,10,11'
  && /Exactly one of debit/.test(prev.report.find((r) => r.row_no === 9).message)
  && await val(`select count(*)::int from public.bank_statement_lines where bank_cash_account_id = $1`, [hdfc.id]) === 0)
const hdfcImp = await imp(hdfcRows, true)
ok('import: batch history with user and counts; original file kept (downloadable, audited); lines never create vouchers',
  hdfcImp.imported_count === 8 && hdfcImp.failed_count === 3 && hdfcImp.imported_by === acctUser
  && (await acct(`select public.bank_statement_file($1::uuid)`, [hdfcImp.id])).content_base64 === b64(csv)
  && (await acct(`select public.bank_statement_imports_list($1::uuid)`, [hdfc.id])).length === 1
  && await val(`select count(*)::int from public.accounting_vouchers where source_type = 'BANK_STATEMENT_LINE'`) === 0)
ok('the same transactions are never imported twice (re-import: all duplicates, refused)', (await imp(hdfcRows, false)).duplicate_count === 8
  && await refused('acct', `select public.bank_statement_import($1::uuid, $2::jsonb, '{}'::jsonb, $3::jsonb, true)`, [hdfc.id, fileOf(), JSON.stringify(hdfcRows)], /Nothing new to import/))
const sbiImp = await imp([sr(1, 'NEFT-SBI CR', '', '600', ''), sr(2, 'NEFT-SBI CR PART 2', '', '400', ''), sr(3, 'ATM FEE', '10', '', ''), sr(4, 'ATM FEE', '10', '', ''),
  sr(5, 'IMPS', '', '1', '', { bank_txn_id: 'TX1' }), sr(6, 'IMPS', '', '1', '', { bank_txn_id: 'tx1' })], true, sbi.id, fileOf('sbi.csv', 'sbi'))
ok('identical rows without a bank ID are both kept (flagged); a repeated bank transaction ID is refused', sbiImp.imported_count === 5 && sbiImp.failed_count === 1
  && /Identical to an earlier row/.test(sbiImp.report.find((r) => r.row_no === 4).message) && /appears twice/.test(sbiImp.report.find((r) => r.row_no === 6).message))
ok('statement evidence is protected: no direct writes, the file table is not readable, lines are immutable',
  await refused('acct', `insert into public.bank_statement_lines (company_id) values ($1)`, [A], /permission denied/)
  && await refused('acct', `select * from public.bank_statement_files`, null, /permission denied/)
  && await ownerRefused(`update public.bank_statement_lines set debit = 1 where import_id = '${hdfcImp.id}'`, /evidence/)
  && await refused('viewer', `select public.bank_statement_import($1::uuid, $2::jsonb, '{}'::jsonb, $3::jsonb, false)`, [hdfc.id, fileOf(), JSON.stringify(hdfcRows)], /not allowed/))

// Matching.
const ws = (id) => acct(`select public.bank_reconciliation_workspace($1::uuid, null, null, true)`, [id])
const stmtLine = async (id, rowNo) => (await rows(`select id::text from public.bank_statement_lines where bank_cash_account_id = $1 and row_no = $2`, [id, rowNo]))[0].id
const sugg = await acct(`select public.bank_reconciliation_suggestions($1::uuid, 3)`, [hdfc.id])
ok('suggestions: exact amount within the date tolerance; the five unique pairs are confident', sugg.filter((s) => s.confident).length === 5)
ok('auto-match confirms them (method AUTO, no voucher created)', (await acct(`select public.bank_reconciliation_auto_match($1::uuid, 3)`, [hdfc.id])).matched === 5
  && await val(`select count(*)::int from public.bank_reconciliation_matches where bank_cash_account_id = $1 and method = 'AUTO' and status = 'ACTIVE'`, [hdfc.id]) === 5)
const wsH = await ws(hdfc.id)
const ledOf = (amt) => wsH.ledger.find((l) => Number(l.amount) === amt).line_id
const s5 = await stmtLine(hdfc.id, 5)
const m5 = [{ statement_line_id: s5 }, { voucher_line_id: ledOf(-1000) }, { voucher_line_id: ledOf(-25) }]
ok('manual match needs a reason; one statement line (1,025) to two ledger entries (1,000 + 25) when the sums are equal',
  await refused('acct', `select public.bank_reconciliation_match($1::uuid, $2::jsonb, '')`, [hdfc.id, JSON.stringify(m5)], /reason/)
  && await refused('acct', `select public.bank_reconciliation_match($1::uuid, $2::jsonb, 'transfer plus charges')`, [hdfc.id, JSON.stringify(m5.slice(0, 2))], /must be equal/)
  && !!(await acct(`select public.bank_reconciliation_match($1::uuid, $2::jsonb, 'transfer plus charges')`, [hdfc.id, JSON.stringify(m5)])).match_id)
ok('a line is never matched beyond its amount', await refused('acct', `select public.bank_reconciliation_match($1::uuid, $2::jsonb, 'second time around')`,
  [hdfc.id, JSON.stringify([{ statement_line_id: await stmtLine(hdfc.id, 1) }, { voucher_line_id: ledOf(200000) }])], /exceeds what is left/)
  && await refused('acct', `select public.bank_reconciliation_match($1::uuid, $2::jsonb, 'other account lines')`,
    [hdfc.id, JSON.stringify([{ statement_line_id: await stmtLine(sbi.id, 1) }, { voucher_line_id: ledOf(-1000) }])], /does not belong/))
// Partial matching on SBI: one ledger entry (1,000 in) against two statement deposits (600 + 400).
const sbiIn = (await ws(sbi.id)).ledger.find((l) => Number(l.amount) === 1000).line_id
const pm1 = await acct(`select public.bank_reconciliation_match($1::uuid, $2::jsonb, 'NEFT received in two parts')`,
  [sbi.id, JSON.stringify([{ statement_line_id: await stmtLine(sbi.id, 1) }, { voucher_line_id: sbiIn, amount: '600' }])])
ok('partial match: the ledger entry is PARTIALLY_MATCHED with 400 remaining', (await ws(sbi.id)).ledger.find((l) => l.line_id === sbiIn).state === 'PARTIALLY_MATCHED'
  && Number((await ws(sbi.id)).ledger.find((l) => l.line_id === sbiIn).remaining) === 400)
await acct(`select public.bank_reconciliation_match($1::uuid, $2::jsonb, 'NEFT received in two parts')`, [sbi.id, JSON.stringify([{ statement_line_id: await stmtLine(sbi.id, 2) }, { voucher_line_id: sbiIn }])])
ok('…the second part completes it (MATCHED)', (await ws(sbi.id)).ledger.find((l) => l.line_id === sbiIn).state === 'MATCHED')
ok('unmatch: reason required, the match is kept as REVERSED (history), the remainder comes back; matches are immutable',
  await refused('acct', `select public.bank_reconciliation_unmatch($1::uuid, '')`, [pm1.match_id], /reason/)
  && (await acct(`select public.bank_reconciliation_unmatch($1::uuid, 'split was wrong')`, [pm1.match_id])).status === 'REVERSED'
  && Number((await ws(sbi.id)).ledger.find((l) => l.line_id === sbiIn).remaining) === 600
  && await refused('acct', `select public.bank_reconciliation_unmatch($1::uuid, 'split was wrong')`, [pm1.match_id], /already been reversed/)
  && await ownerRefused(`update public.bank_reconciliation_matches set total = 1 where id = '${pm1.match_id}'`, /only be reversed/))

// Bank charges and interest from the statement.
const s7 = await stmtLine(hdfc.id, 7)
const s8 = await stmtLine(hdfc.id, 8)
const prop7 = await acct(`select public.bank_statement_adjustment_proposal($1::uuid)`, [s7])
ok('proposal: SMS charges recognised as CHARGES, withdrawal → expense ledgers offered; no voucher until confirmed', prop7.suggested_category === 'CHARGES'
  && prop7.direction === 'WITHDRAWAL' && prop7.accounts.some((a) => a.id === chargesL) && !prop7.accounts.some((a) => a.id === interestL)
  && await val(`select count(*)::int from public.accounting_vouchers where source_id = $1`, [s7]) === 0)
ok('posting an adjustment needs bank_reconciliation.approve and a ledger of the right kind', await refused('viewer', `select public.bank_statement_adjust($1::uuid, $2::uuid, 'SMS')`, [s7, chargesL], /not allowed/)
  && await refused('acct', `select public.bank_statement_adjust($1::uuid, $2::uuid, 'interest')`, [s8, chargesL], /income ledger/))
const adj7 = await acct(`select public.bank_statement_adjust($1::uuid, $2::uuid, 'SMS alert charges')`, [s7, chargesL])
const adj8 = await acct(`select public.bank_statement_adjust($1::uuid, $2::uuid, 'Savings interest')`, [s8, interestL])
ok('charges: BNK voucher Dr Bank Charges 59 / Cr HDFC; interest Dr HDFC 120 / Cr Bank Interest; both matched to their lines; never twice',
  await val(`select string_agg(a.account_code || ':' || l.debit || ':' || l.credit, ',' order by l.line_no) from public.accounting_voucher_lines l join public.accounts a on a.id = l.account_id
    where l.voucher_id = $1`, [adj7.voucher_id]) === '6600:59.00:0.00,1230:0.00:59.00'
  && await val(`select string_agg(a.account_code || ':' || l.debit, ',' order by l.line_no) from public.accounting_voucher_lines l join public.accounts a on a.id = l.account_id
    where l.voucher_id = $1`, [adj8.voucher_id]) === '1230:120.00,4500:0.00'
  && (await ws(hdfc.id)).statement.filter((s) => s.state === 'MATCHED').length === 8
  && await refused('acct', `select public.bank_statement_adjust($1::uuid, $2::uuid, 'again')`, [s7, chargesL], /already has an adjustment/))

// Reconciliation statement.
const brs = (extra) => acct(`select public.bank_reconciliation_statement($1::uuid, $2::date, $3::numeric)`, [hdfc.id, today, extra ?? null])
const brs1 = await brs()
ok('fully matched: ledger 1,98,036 = statement 1,98,036 (from the running balance), nothing outstanding, difference 0',
  Number(brs1.ledger_balance) === 198036 && Number(brs1.statement_balance) === 198036 && brs1.statement_balance_source === 'STATEMENT' && Number(brs1.difference) === 0
  && brs1.ledger_items.length === 0 && brs1.statement_items.length === 0)
await acct(`select public.bank_payment_policy_save('PAYMENT', 'CHEQUE', false)`)
const chq = await op(`select public.supplier_payment_record($1::uuid, $2::date, 2000.00, 'CHEQUE', 'CHQ-000123', 'cheque payment', gen_random_uuid())`, [supplierId, today])
await acct(`select public.bank_payment_assign('SUPPLIER_PAYMENT', $1::uuid, $2::uuid, 'cheque book of HDFC')`, [chq.payment_id, hdfc.id])
await runPosting()
const b2 = await brs()
ok('an issued cheque not yet on the statement is an OUTSTANDING_CHEQUE: adjusted bank (1,98,036 − 2,000) = book (1,96,036); difference 0',
  Number(b2.ledger_balance) === 196036 && Number(b2.outstanding_payments) === 2000 && b2.ledger_items.length === 1 && b2.ledger_items[0].category === 'OUTSTANDING_CHEQUE'
  && Number(b2.adjusted_bank_balance) === 196036 && Number(b2.adjusted_book_balance) === 196036 && Number(b2.difference) === 0)
const saved = await acct(`select public.bank_reconciliation_save($1::uuid, $2::date, null, null)`, [hdfc.id, today])
ok('saved as COMPLETED (difference zero); viewers cannot save', saved.status === 'COMPLETED'
  && await refused('viewer', `select public.bank_reconciliation_save($1::uuid, $2::date, null, null)`, [hdfc.id, today], /not allowed/))
ok('a difference is never labelled complete: refused, or accepted by an approver with a documented reason',
  await refused('acct', `select public.bank_reconciliation_save($1::uuid, $2::date, 197000, null)`, [hdfc.id, today], /Not reconciled: difference/)
  && (await acct(`select public.bank_reconciliation_save($1::uuid, $2::date, 197000, 'Bank statement balance disputed with branch')`, [hdfc.id, today])).status === 'ACCEPTED_DIFFERENCE'
  && (await acct(`select public.bank_reconciliation_history($1::uuid)`, [hdfc.id])).length === 2
  && await ownerRefused(`update public.bank_reconciliations set difference = 0 where bank_cash_account_id = '${hdfc.id}'`, /history/))

// Books and reports.
const hb = await book(hdfc.id)
ok('bank book from posted vouchers: opening, running balance = closing 1,96,036, reconciliation status per entry, references',
  Number(hb.closing_balance) === 196036 && Number(hb.rows.at(-1).balance) === 196036 && hb.rows.filter((r) => r.reconciliation === 'UNMATCHED').length === 1
  && hb.rows.find((r) => r.reconciliation === 'UNMATCHED').reference === 'CHQ-000123' && hb.rows.some((r) => r.txn_type === 'TRANSFER' && r.is_reversal)
  && (await book(hdfc.id, { reconciliation: 'UNMATCHED' })).rows.length === 1 && (await book(hdfc.id, { type: 'BANK_ADJUSTMENT' })).rows.length === 2)
const pb = await book(petty.id)
ok('cash book: receipts, payments, closing 500 and a daily opening / closing summary', Number(pb.closing_balance) === 500 && pb.daily.length >= 1
  && Number(pb.daily.at(-1).closing) === 500 && Number(pb.total_debit) - Number(pb.total_credit) === 500
  && await refused('sales', `select public.bank_cash_book($1::uuid, current_date - 1, current_date, '{}'::jsonb)`, [petty.id], /not allowed/))
const rep = (key, f = {}) => acct(`select public.bank_report($1, $2::jsonb)`, [key, JSON.stringify(f)])
ok('reports: account summary, outstanding cheques, unmatched statement, bank charges, transfer register, cash position',
  (await rep('ACCOUNT_SUMMARY')).rows.length === 3 && (await rep('OUTSTANDING_CHEQUES')).rows.length === 1
  && (await rep('UNMATCHED_STATEMENT', { account_id: sbi.id })).rows.length === 4
  && (await rep('BANK_CHARGES')).rows.some((r) => r.state === 'POSTED' && Number(r.amount) === -59)
  && (await rep('TRANSFER_REGISTER')).rows.length >= 6 && Number((await rep('CASH_POSITION')).rows[0].balance) === 500
  && await refused('acct', `select public.bank_report('NOPE', '{}'::jsonb)`, null, /Unknown report/))
ok('deposits in transit: the 600 left on SBI after the unmatch is listed as a deposit not yet on the statement',
  (await rep('DEPOSITS_IN_TRANSIT', { account_id: sbi.id })).rows.some((r) => Number(r.remaining) === 600 && r.category === 'DEPOSIT_IN_TRANSIT'))
ok('company isolation: company B sees no bank accounts, statements or transfers of A',
  (await request('b_op', `select count(*)::int from public.bank_cash_accounts`)).value === 0 && (await request('b_op', `select count(*)::int from public.bank_statement_lines`)).value === 0
  && await refused('b_op', `select public.bank_cash_book($1::uuid, current_date - 1, current_date, '{}'::jsonb)`, [hdfc.id], /not found|not allowed/)
  && await refused('b_op', `select public.bank_reconciliation_match($1::uuid, '[]'::jsonb, 'cross company')`, [hdfc.id], /not found/))
ok('Phase 4 read-only RPCs run inside a READ ONLY transaction', await (async () => {
  await db.exec('reset role'); await db.exec('begin read only')
  try {
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: await val(`select rls_test.id('acct')::text`), role: 'authenticated' })])
    await db.exec('reset role'); await db.exec('set local role authenticated')
    for (const q of [`select public.bank_cash_account_list()`, `select public.bank_payment_policies()`, `select public.bank_payment_candidates('{}'::jsonb)`,
      `select public.bank_cash_book('${hdfc.id}'::uuid, current_date - 30, current_date, '{}'::jsonb)`, `select public.bank_transfer_list('{}'::jsonb)`,
      `select public.bank_statement_imports_list(null)`, `select public.bank_statement_import_get('${hdfcImp.id}'::uuid)`,
      `select public.bank_reconciliation_workspace('${hdfc.id}'::uuid, null, null, true)`, `select public.bank_reconciliation_suggestions('${hdfc.id}'::uuid, 3)`,
      `select public.bank_statement_adjustment_proposal('${s7}'::uuid)`, `select public.bank_reconciliation_statement('${hdfc.id}'::uuid, current_date, null)`,
      `select public.bank_reconciliation_history(null)`, `select public.bank_lookups()`,
      ...['ACCOUNT_SUMMARY', 'OUTSTANDING_CHEQUES', 'DEPOSITS_IN_TRANSIT', 'OUTSTANDING_ITEMS', 'UNMATCHED_STATEMENT', 'BANK_CHARGES', 'TRANSFER_REGISTER', 'CASH_POSITION']
        .map((r) => `select public.bank_report('${r}', '{}'::jsonb)`)]) await db.query(q)
    await db.exec('rollback'); return true
  } catch (e) { await db.exec('rollback').catch(() => {}); console.log('      got:', e.message); return false }
})())
ok('deactivating an account keeps its history; the ledger may then be linked again', (await acct(`select public.bank_cash_account_set_active($1::uuid, false, 'account closed')`, [sbi.id])).is_active === false
  && Number((await book(sbi.id)).closing_balance) !== 0 && (await bca(null, { ...hdfcBody, account_code: 'SBI-NEW', account_name: 'SBI (new)', ledger_account_id: sbiL, bank_name: 'SBI',
    ifsc: 'SBIN0000456', account_number: '30123456789' })).is_active === true)

ok('Phase 4 rollback is refused while bank / cash records exist', await ownerRefused(await read(path.join(rbDir, `${BC}_down.sql`)), /cash records exist/))
console.log('\nR. GST (Phase 5, Gate B)')
const gstPerms = (role) => val(`select coalesce(string_agg(p.code, ',' order by p.code), '') from public.role_permissions rp join public.roles r on r.id = rp.role_id
  join public.permissions p on p.id = rp.permission_id where r.code = $1 and p.resource in ('gst', 'gst_reconciliation', 'gst_returns', 'gst_payments', 'gst_periods')`, [role])
ok('permissions: Accounts Manager all but reopen; Super Admin all incl. reopen; Admin / Management Viewer read only; Sales Manager none',
  await gstPerms('ACCOUNTS_MANAGER') === 'gst.manage,gst.read,gst_payments.create,gst_payments.post,gst_periods.close,gst_reconciliation.approve,gst_reconciliation.manage,gst_reconciliation.read,gst_returns.approve,gst_returns.prepare'
  && (await gstPerms('SUPER_ADMIN')).includes('gst_periods.reopen') && await gstPerms('MANAGEMENT_VIEWER') === 'gst.read,gst_reconciliation.read'
  && await gstPerms('ADMIN') === 'gst.read,gst_reconciliation.read' && await gstPerms('SALES_MANAGER') === '')
const companyGstin = await val(`select gstin from public.companies where id = $1`, [A])
ok('registration: never invented — a GSTIN other than the company GSTIN is refused; viewers cannot save',
  await refused('acct', `select public.gst_registration_save($1::jsonb)`, [JSON.stringify({ gstin: '29AABCQ1234A1Z5', effective_from: fyStart, frequency: 'MONTHLY', frequency_effective_from: fyStart })], /must use the company GSTIN/)
  && await refused('viewer', `select public.gst_registration_save($1::jsonb)`, [JSON.stringify({ gstin: companyGstin })], /not allowed/))
const gstReg = await acct(`select public.gst_registration_save($1::jsonb)`, [JSON.stringify({ gstin: companyGstin, registration_type: 'REGULAR', effective_from: fyStart,
  frequency: 'MONTHLY', frequency_effective_from: fyStart })])
ok('one active registration per company (database index), state code from the GSTIN', gstReg.state_code === companyGstin.slice(0, 2)
  && await ownerRefused(`insert into public.gst_registrations (company_id, gstin, legal_name, state_code, registration_type, effective_from)
     values ('${A}', '${companyGstin}', 'Second', '${companyGstin.slice(0, 2)}', 'REGULAR', current_date)`, /duplicate key|unique/))

// Configuration: validation, maker-checker, effective-date overlap.
const cfgPayload = (extra = {}) => ({ gst_rates: [0, 0.25, 3, 5, 12, 18, 28], b2cl_invoice_threshold: 100000,
  due_days: { gstr1_monthly_day: 11, gstr1_quarterly_day: 13, gstr3b_monthly_day: 20, gstr3b_quarterly_day: 22 }, uqc_map: { PCS: 'PCS', KG: 'KGS' },
  set_off_matrix: { IGST: ['IGST', 'CGST', 'SGST'], CGST: ['IGST', 'CGST'], SGST: ['IGST', 'SGST'], CESS: ['CESS'] }, set_off_order: 'IGST_FIRST', rcm_cash_only: true,
  challan: { cpin_pattern: '^[0-9]{14}$', cin_pattern: '^[0-9]{14}[A-Z0-9]{4}$', cin_starts_with_cpin: true },
  section_map: { B2B: 'Registered', B2CL: 'Large B2C inter-state', B2CS: 'Other B2C', EXP: 'Exports', CDNR: 'Notes registered', CDNUR: 'Notes unregistered', NIL: 'Nil / exempt / non-GST' }, ...extra })
const cfgSave = (user, from, payload, id = null) => as(user)(`select public.gst_config_save($1::uuid, $2::date, $3::jsonb, null, null)`, [id, from, JSON.stringify(payload)])
const bad = await cfgSave('acct', fyStart, cfgPayload({ b2cl_invoice_threshold: -1, set_off_matrix: { IGST: ['IGST', 'CESS'], CGST: ['CGST'], SGST: ['SGST'], CESS: ['CESS'] },
  challan: { cpin_pattern: '([', cin_pattern: 'x', cin_starts_with_cpin: true } }))
ok('invalid configuration: every problem listed; it cannot be submitted (so never approved)', bad.validation_errors.length === 3
  && bad.validation_errors.some((e) => /b2cl_invoice_threshold/.test(e)) && bad.validation_errors.some((e) => /cess credit may pay only cess/.test(e))
  && bad.validation_errors.some((e) => /valid regular expressions/.test(e))
  && await refused('acct', `select public.gst_config_submit($1::uuid)`, [bad.id], /incomplete or invalid/))
const cfg1 = await cfgSave('acct', fyStart, cfgPayload())
await acct(`select public.gst_config_submit($1::uuid)`, [cfg1.id])
ok('maker-checker: the preparer cannot approve (even with permission); another manager can', await refused('acct', `select public.gst_config_approve($1::uuid)`, [cfg1.id], /Maker-checker/)
  && (await as('acct2')(`select public.gst_config_approve($1::uuid, 'checked against the GST notification')`, [cfg1.id])).status === 'APPROVED')
const cfgDup = await cfgSave('acct', fyStart, cfgPayload())
await acct(`select public.gst_config_submit($1::uuid)`, [cfgDup.id])
ok('effective-date overlap: a second version from the same date is refused', await refused('acct2', `select public.gst_config_approve($1::uuid)`, [cfgDup.id], /already starts on or after/))
const nextYear = await val(`select (date_trunc('month', $1::date) + interval '1 month')::date::text`, [today])
const cfg2 = await cfgSave('acct', nextYear, cfgPayload({ b2cl_invoice_threshold: 250000 }))
await acct(`select public.gst_config_submit($1::uuid)`, [cfg2.id])
await as('acct2')(`select public.gst_config_approve($1::uuid)`, [cfg2.id])
const cfg1Now = await acct(`select public.gst_config_get($1::uuid)`, [cfg1.id])
ok('a later version supersedes: the earlier keeps its payload, approval and historical range (to the day before)', cfg1Now.status === 'SUPERSEDED'
  && cfg1Now.effective_to === await val(`select ($1::date - 1)::text`, [nextYear]) && cfg1Now.reviewed_by === await val(`select rls_test.id('acct2')::text`)
  && JSON.stringify(cfg1Now.payload) === JSON.stringify(cfg1.payload) && cfg1Now.superseded_by === cfg2.id)
ok('database-level protection: an overlapping approved row and edits of an approved payload are refused',
  await ownerRefused(`insert into public.gst_config_versions (company_id, version_no, effective_from, status, payload, reviewed_by, reviewed_at, prepared_by)
     values ('${A}', 99, '${today}', 'APPROVED', '{}', rls_test.id('acct2'), now(), rls_test.id('acct'))`, /would overlap/)
  && await ownerRefused(`update public.gst_config_versions set payload = '{}' where id = '${cfg2.id}'`, /cannot be changed/))

// Ledgers: explicit, never silently skipped or altered.
const ov = await acct(`select public.gst_overview()`)
ok('GST ledgers 1524 / 5920 / 5930 seeded for this company and mapped; setup is idempotent', ['GST_ELECTRONIC_CASH', 'GST_INTEREST', 'GST_LATE_FEE']
  .every((k) => ov.ledgers.find((l) => l.rule_key === k)?.account_code) && (await acct(`select public.gst_ledgers_setup()`)).created_or_mapped === 0)
ok('ledger conflicts are explicit errors (code taken, system key elsewhere, name taken) and nothing is created',
  await ownerRefused(`delete from public.accounting_posting_rules where company_id = '${A}' and rule_key = 'GST_INTEREST';
     update public.accounts set system_key = null, is_system = false where company_id = '${A}' and account_code = '5920';
     select private.gst_ledgers_ensure('${A}')`, /Code 5920 is already used/)
  && await ownerRefused(`delete from public.accounting_posting_rules where company_id = '${A}' and rule_key = 'GST_INTEREST';
     update public.accounts set account_code = '5921' where company_id = '${A}' and account_code = '5920';
     select private.gst_ledgers_ensure('${A}')`, /System key GST_INTEREST is already on account 5921/)
  && await ownerRefused(`delete from public.accounting_posting_rules where company_id = '${A}' and rule_key = 'GST_INTEREST';
     update public.accounts set account_code = '5921', system_key = null where company_id = '${A}' and account_code = '5920';
     select private.gst_ledgers_ensure('${A}')`, /named "GST Interest" already exists with code 5921/)
  && await ownerRefused(`delete from public.accounting_posting_rules where company_id = '${A}' and rule_key = 'GST_INTEREST';
     do $x$ begin perform private.gst_ledgers_ensure('${A}'); if private.accounting_rule_account('${A}', 'GST_INTEREST', '') is not null then raise exception 'OK-REMAPPED'; end if; end $x$`, /OK-REMAPPED/))

// Sales GST details: exactly one source, company-checked.
const anInvoice = await val(`select id::text from public.sales_invoices where company_id = $1 and status = 'ISSUED' limit 1`, [A])
ok('sales details: exactly one of invoice / note; another company\'s or unknown document refused; history kept',
  !!(await acct(`select public.gst_sales_details_save($1::jsonb)`, [JSON.stringify({ sales_invoice_id: anInvoice, export_type: 'WITHOUT_PAYMENT', port_code: 'INNSA1' })])).id
  && await refused('acct', `select public.gst_sales_details_save($1::jsonb)`, [JSON.stringify({ sales_invoice_id: anInvoice, adjustment_note_id: anInvoice })], /exactly one/)
  && await refused('acct', `select public.gst_sales_details_save($1::jsonb)`, [JSON.stringify({ sales_invoice_id: '00000000-0000-4000-8000-000000000001' })], /does not exist/)
  && await ownerRefused(`insert into public.gst_sales_document_details (company_id, sales_invoice_id) values ('${B}', '${anInvoice}')`, /foreign key|violates/)
  && await val(`select count(*)::int from public.gst_sales_document_detail_history where company_id = $1`, [A]) === 1)

// ITC decisions: partial ITC, maker-checker, adjustments, reversal sequence.
const piPost = async (sup, number, lines, total, extra = {}) => {
  const inv = await save('acct', pinv(sup, number, lines, { supplier_stated_total: total, ...extra }))
  await act('acct', 'submit', inv.id); await act('acct2', 'approve', inv.id, null, false)
  return act('acct', 'post', inv.id)
}
const itcAct = (user, inv, action, body = {}) => as(user)(`select public.gst_itc_action($1::uuid, $2, $3::jsonb)`, [inv, action, JSON.stringify(body)])
const itcAdj = (user, action, id, body = {}) => as(user)(`select public.gst_itc_adjustment($1, $2::uuid, $3::jsonb)`, [action, id, JSON.stringify(body)])
const gstChecks = { invoice_verified: true, goods_services_received: true, gstin_valid: true }
const X = await piPost(sup1, 'GST-X-1', [dirL(rent, 10000, 18)], '11800.00', { invoice_type: 'SERVICE' })
ok('review stages are recorded without accounting (under review, on hold)', (await itcAct('acct', X.id, 'UNDER_REVIEW', { reason: 'awaiting supplier copy' })).stage === 'UNDER_REVIEW'
  && (await itcAct('acct', X.id, 'ON_HOLD', { reason: 'supplier not in GSTR-2B yet' })).stage === 'ON_HOLD'
  && await val(`select count(*)::int from public.accounting_vouchers where source_id = $1 and source_type like 'GST%'`, [X.id]) === 0)
ok('partial ITC split validated per head (CGST, SGST, IGST, cess) against the GST pending; checks needed for any eligible amount',
  await refused('acct', `select public.gst_itc_action($1::uuid, 'PROPOSE', $2::jsonb)`, [X.id, JSON.stringify({ reason: 'partly for exempt supplies', checks: gstChecks,
    eligible: { cgst: '700', sgst: '600' }, ineligible: { cgst: '300', sgst: '300' } })], /CGST: eligible 700 \+ ineligible 300 must equal the GST pending 900/)
  && await refused('acct', `select public.gst_itc_action($1::uuid, 'PROPOSE', $2::jsonb)`, [X.id, JSON.stringify({ reason: 'partly for exempt supplies',
    eligible: { cgst: '600', sgst: '600' }, ineligible: { cgst: '300', sgst: '300' } })], /needs the checks/))
const prop = await itcAct('acct', X.id, 'PROPOSE', { reason: 'One third used for exempt supplies (rule 42)', checks: gstChecks,
  eligible: { cgst: '600', sgst: '600' }, ineligible: { cgst: '300', sgst: '300' } })
ok('proposal (maker) blocks the Phase 3 one-step path until decided; the proposer cannot approve', prop.stage === 'PROPOSED'
  && await refused('acct2', `select public.purchase_invoice_verify_gst($1::uuid, 'ELIGIBLE', 'checked with the portal', $2::jsonb)`, [X.id, JSON.stringify(gstChecks)], /awaiting approval/)
  && await refused('acct', `select public.gst_itc_action($1::uuid, 'APPROVE', '{}'::jsonb)`, [X.id], /Maker-checker/))
const Xd = await itcAct('acct2', X.id, 'APPROVE')
const xLines = await vlines(Xd.gst_voucher_id)
ok('approved partial ITC: one GST voucher Dr Input CGST 600, Dr Input SGST 600, Dr Ineligible ITC 600 / Cr GST pending 1,800; status PARTIALLY_ELIGIBLE',
  Xd.gst_status === 'PARTIALLY_ELIGIBLE' && xLines.length === 4 && xLines[0].key === 'INPUT_CGST' && near(xLines[0].dr, 600) && xLines[1].key === 'INPUT_SGST' && near(xLines[1].dr, 600)
  && xLines[2].key === 'GST_INPUT_INELIGIBLE' && near(xLines[2].dr, 600) && xLines[3].key === 'GST_INPUT_PENDING' && near(xLines[3].cr, 1800)
  && await val(`select t.type_code from public.accounting_vouchers v join public.accounting_voucher_types t on t.id = v.voucher_type_id where v.id = $1`, [Xd.gst_voucher_id]) === 'GST'
  && Xd.history.map((h) => h.stage).join() === 'UNDER_REVIEW,ON_HOLD,PROPOSED,DECIDED')
ok('decision history is append-only (no update / delete even by the owner)', await ownerRefused(`update public.gst_itc_decisions set reason = 'x' where purchase_invoice_id = '${X.id}'`, /permanent GST history/)
  && await ownerRefused(`delete from public.gst_itc_decisions where purchase_invoice_id = '${X.id}'`, /permanent GST history/))
const rv1 = await itcAdj('acct', 'CREATE', null, { purchase_invoice_id: X.id, kind: 'REVERSAL', cgst: '100', sgst: '100', reason: 'Supplier not paid within the allowed time' })
ok('ITC reversal: maker cannot post; more than the eligible still claimed is refused', await refused('acct', `select public.gst_itc_adjustment('POST', $1::uuid, '{}'::jsonb)`, [rv1.id], /Maker-checker/)
  && await refused('acct2', `select public.gst_itc_adjustment('POST', $1::uuid, '{}'::jsonb)`,
    [(await itcAdj('acct', 'CREATE', null, { purchase_invoice_id: X.id, kind: 'REVERSAL', cgst: '700', reason: 'Too much reversal attempted' })).id], /more than the eligible ITC still claimed/))
await acct(`select public.gst_itc_adjustment('CANCEL', id, '{"reason": "entered wrongly"}'::jsonb) from public.gst_itc_adjustments where purchase_invoice_id = $1 and status = 'DRAFT' and cgst = 700`, [X.id])
const rv1p = await itcAdj('acct2', 'POST', rv1.id)
const rc1 = await itcAdj('acct', 'CREATE', null, { purchase_invoice_id: X.id, kind: 'RECLAIM', cgst: '50', reason: 'Supplier paid; reclaiming part of the reversal' })
const rc1p = await itcAdj('acct2', 'POST', rc1.id)
ok('reversal posts Dr Ineligible 200 / Cr Input CGST 100, Input SGST 100; reclaim posts the opposite for 50; net eligible tracked',
  (await vlines(rv1p.voucher_id)).map((l) => `${l.key}:${l.dr || -l.cr}`).join() === 'INPUT_CGST:-100,INPUT_SGST:-100,GST_INPUT_INELIGIBLE:200'
  && (await vlines(rc1p.voucher_id)).map((l) => `${l.key}:${l.dr || -l.cr}`).join() === 'INPUT_CGST:50,GST_INPUT_INELIGIBLE:-50'
  && near((await acct(`select public.gst_itc_get($1::uuid)`, [X.id])).net.eligible_cgst, 550))
ok('adjustments are reversed newest first only', await refused('acct', `select public.gst_itc_adjustment('REVERSE', $1::uuid, '{"reason": "wrong amount entered"}'::jsonb)`, [rv1.id], /newest first/))
const draftAdj = await itcAdj('acct', 'CREATE', null, { purchase_invoice_id: X.id, kind: 'REVERSAL', igst: '0', cgst: '10', reason: 'Draft left open for the test' })
ok('invoice reversal is refused while an ITC adjustment is still a draft', await refused('acct', `select public.purchase_invoice_reverse($1::uuid, 'wrong supplier')`, [X.id], /still a draft/))
await itcAdj('acct', 'CANCEL', draftAdj.id, { reason: 'not needed' })
const xSources = async () => (await rows(`select id::text from public.gst_itc_decisions where purchase_invoice_id = $1 union select id::text from public.gst_itc_adjustments where purchase_invoice_id = $1
  union select $1::text`, [X.id])).map((r) => r.id)
await act('acct', 'reverse', X.id, 'billed against the wrong supplier')
const xNet = await rows(`select a.system_key as key, sum(l.debit - l.credit)::float8 as net from public.accounting_voucher_lines l join public.accounting_vouchers v on v.id = l.voucher_id
  join public.accounts a on a.id = l.account_id where v.source_id = any($1::uuid[]) and a.system_key in ('INPUT_CGST', 'INPUT_SGST', 'GST_INPUT_INELIGIBLE', 'GST_INPUT_PENDING', 'CREDITORS_CONTROL')
  group by 1`, [await xSources()])
ok('invoice reversal: reclaim, reversal, decision and invoice vouchers each reversed exactly once (newest first); every GST and Creditors ledger nets to zero',
  xNet.length === 5 && xNet.every((r) => near(r.net, 0))
  && await val(`select count(*)::int from public.accounting_vouchers o where o.source_id = any($1::uuid[]) and o.source = 'AUTO'
       and (select count(*) from public.accounting_vouchers r where r.reversal_of_voucher_id = o.id) <> 1`, [await xSources()]) === 0
  && (await acct(`select public.gst_itc_get($1::uuid)`, [X.id])).history.at(-1).stage === 'REVERSED_WITH_INVOICE'
  && await val(`select string_agg(status, ',' order by posted_at) from public.gst_itc_adjustments where purchase_invoice_id = $1 and voucher_id is not null`, [X.id]) === 'REVERSED,REVERSED')

// Challans and payments.
const challan = (user, action, id, body = {}) => as(user)(`select public.gst_challan($1, $2::uuid, $3::jsonb)`, [action, id, JSON.stringify(body)])
const cpay = (user, action, id, body = {}) => as(user)(`select public.gst_challan_payment($1, $2::uuid, $3::jsonb)`, [action, id, JSON.stringify(body)])
ok('challan: CPIN format from the approved configuration; duplicates refused', await refused('acct', `select public.gst_challan('SAVE', null, $1::jsonb)`,
  [JSON.stringify({ cpin: 'ABC', challan_date: today, heads: [{ major_head: 'CGST', minor_head: 'TAX', amount: '1000' }] })], /does not match the configured format/))
const ch1 = await challan('acct', 'SAVE', null, { cpin: '26112700000001', challan_date: today, heads: [{ major_head: 'CGST', minor_head: 'TAX', amount: '1000' },
  { major_head: 'CGST', minor_head: 'INTEREST', amount: '20' }] })
ok('…the same CPIN again is refused', await refused('acct', `select public.gst_challan('SAVE', null, $1::jsonb)`, [JSON.stringify({ cpin: '26112700000001', challan_date: today,
  heads: [{ major_head: 'IGST', minor_head: 'TAX', amount: '5' }] })], /already recorded/))
const failedAttempt = await cpay('acct', 'RECORD', ch1.id, { status: 'FAILED', mode: 'NET_BANKING', amount: '1020', failure_reason: 'bank timeout' })
ok('a failed attempt is kept; a success needs a CIN in the configured format starting with the CPIN, the full amount and a bank account',
  failedAttempt.attempt_no === 1 && failedAttempt.status === 'FAILED'
  && await refused('acct', `select public.gst_challan_payment('RECORD', $1::uuid, $2::jsonb)`, [ch1.id, JSON.stringify({ status: 'SUCCESS', cin: '99999999999999HDFC', amount: '1020', bank_cash_account_id: hdfc.id, payment_date: today })], /CIN in the configured format/)
  && await refused('acct', `select public.gst_challan_payment('RECORD', $1::uuid, $2::jsonb)`, [ch1.id, JSON.stringify({ status: 'SUCCESS', cin: '26112700000001HDFC', amount: '1000', bank_cash_account_id: hdfc.id, payment_date: today })], /must equal the challan total/))
const ok1 = await cpay('acct', 'RECORD', ch1.id, { status: 'SUCCESS', cin: '26112700000001HDFC', amount: '1020', bank_cash_account_id: hdfc.id, payment_date: today, bank_reference: 'UTRGST001' })
ok('at most one successful payment per challan; the CIN is unique', ok1.attempt_no === 2
  && await refused('acct', `select public.gst_challan_payment('RECORD', $1::uuid, $2::jsonb)`, [ch1.id, JSON.stringify({ status: 'SUCCESS', cin: '26112700000001SBIN', amount: '1020', bank_cash_account_id: hdfc.id, payment_date: today })], /already has a successful payment/))
const hdfcBefore = Number((await book(hdfc.id)).closing_balance)
ok('posting: the recorder cannot post (maker-checker)', await refused('acct', `select public.gst_challan_payment('POST', $1::uuid, '{}'::jsonb)`, [ok1.id], /Maker-checker/))
const ok1p = await cpay('acct2', 'POST', ok1.id)
ok('posted once: Dr GST Electronic Cash 1,020 / Cr HDFC (Phase 4 bank book shows it); a second post is refused', !!ok1p.voucher_number
  && (await vlines(ok1p.voucher_id)).map((l) => `${l.code}:${l.dr || -l.cr}`).join() === '1524:1020,1230:-1020'
  && near(Number((await book(hdfc.id)).closing_balance), hdfcBefore - 1020)
  && await refused('acct2', `select public.gst_challan_payment('POST', $1::uuid, '{}'::jsonb)`, [ok1.id], /successful, unposted/)
  && await val(`select status from public.gst_challans where id = $1`, [ch1.id]) === 'PAID')

// Set-off.
const outIgst = await accId('2230')
const outCgst = await accId('2210')
await acct(`select public.accounting_voucher_post($1::uuid)`, [(await acct(`select public.accounting_voucher_create($1::jsonb)`, [jv(today, [{ account_id: rent, debit: '15000' },
  { account_id: outIgst, credit: '10000' }, { account_id: outCgst, credit: '5000' }])])).id])
const W = await piPost(sup2, 'GST-W-1', [dirL(rent, 1000, 18)], '1180.00', { invoice_type: 'EXPENSE' })
await gstVerify(W.id, 'ELIGIBLE', 'IGST invoice verified with the supplier copy', JSON.stringify(gstChecks))
const nov = await acct(`select public.gst_period_create($1::date)`, [await val(`select date_trunc('month', $1::date)::date::text`, [today])])
const liab = await acct(`select public.gst_liability_summary($1::uuid)`, [nov.id])
const igstCredit = Number(liab.credit.IGST)
const setOff = (user, action, id, body = {}) => as(user)(`select public.gst_set_off($1, $2::uuid, $3::jsonb)`, [action, id, JSON.stringify(body)])
const line = (liability_kind, liability_head, source, source_head, amount, cash_minor_head) => ({ liability_kind, liability_head, source, source_head, amount, cash_minor_head })
ok('liability summary: output IGST includes the 10,000 credited in the period; RCM liability from reverse-charge invoices; credit and cash by head',
  Number(liab.output.IGST) >= 10000 && Number(liab.cash['CGST:TAX']) === 1000 && Number(liab.cash['CGST:INTEREST']) === 20 && igstCredit >= 360 && Number(liab.rcm.CGST) >= 25)
const tryPost = async (lines, pattern) => { const d = await setOff('acct', 'SAVE', null, { period_id: nov.id, lines }); const r = await refused('acct2', `select public.gst_set_off('POST', $1::uuid, '{}'::jsonb)`, [d.id], pattern)
  await setOff('acct', 'CANCEL', d.id, { reason: 'test draft' }); return r }
ok('set-off validation: invalid head pairing, cash of another head, RCM from credit, too much credit, too much cash, too much liability',
  await tryPost([line('OUTPUT', 'CGST', 'CREDIT', 'SGST', '10')], /SGST credit may not pay CGST/)
  && await tryPost([line('OUTPUT', 'CESS', 'CREDIT', 'IGST', '10')], /IGST credit may not pay CESS/)
  && await tryPost([line('OUTPUT', 'CGST', 'CASH', 'SGST', '10', 'TAX')], /paid from CGST electronic cash only/)
  && await tryPost([line('RCM', 'CGST', 'CREDIT', 'IGST', '10')], /paid in cash only/)
  && await tryPost([line('OUTPUT', 'IGST', 'CREDIT', 'IGST', String(igstCredit + 1))], /Input IGST credit available/)
  && await tryPost([line('OUTPUT', 'CGST', 'CASH', 'CGST', '1001', 'TAX')], /Electronic cash CGST TAX available is 1000/)
  && await tryPost([line('RCM', 'CGST', 'CASH', 'CGST', String(Number(liab.rcm.CGST) + 1), 'TAX')], /Rcm CGST liability/))
const so = await setOff('acct', 'SAVE', null, { period_id: nov.id, lines: [line('OUTPUT', 'IGST', 'CREDIT', 'IGST', String(igstCredit)), line('OUTPUT', 'CGST', 'CASH', 'CGST', '500', 'TAX'),
  line('INTEREST', 'CGST', 'CASH', 'CGST', '20', 'INTEREST')] })
ok('maker-checker on set-off posting', await refused('acct', `select public.gst_set_off('POST', $1::uuid, '{}'::jsonb)`, [so.id], /Maker-checker/))
const sop = await setOff('acct2', 'POST', so.id)
ok(`set-off posted: Dr Output IGST ${igstCredit}, Dr Output CGST 500, Dr GST Interest 20 / Cr Input IGST, Cr Electronic Cash 520; cash left 500`, sop.status === 'POSTED'
  && (await vlines(sop.voucher_id)).map((l) => `${l.code}:${l.dr || -l.cr}`).sort().join() === [`1522:${-igstCredit}`, '1524:-520', `2210:500`, `2230:${igstCredit}`, '5920:20'].sort().join()
  && Number((await acct(`select public.gst_liability_summary($1::uuid)`, [nov.id])).cash['CGST:TAX']) === 500)
const so2 = await setOff('acct', 'SAVE', null, { period_id: nov.id, lines: [line('OUTPUT', 'CGST', 'CASH', 'CGST', '10', 'TAX')] })
ok('a second posted set-off for the period is refused', await refused('acct2', `select public.gst_set_off('POST', $1::uuid, '{}'::jsonb)`, [so2.id], /already posted/))
ok('ITC used in a set-off is never taken back silently: invoice reversal and decision reversal refused; the payment whose cash was used cannot be reversed',
  await refused('acct', `select public.purchase_invoice_reverse($1::uuid, 'wrong supplier')`, [W.id], /ITC already utilised/)
  && await refused('acct', `select public.gst_itc_action($1::uuid, 'REVERSE_DECISION', '{"reason": "decided on the wrong basis"}'::jsonb)`, [W.id], /ITC already utilised/)
  && await refused('acct2', `select public.gst_challan_payment('REVERSE', $1::uuid, '{"reason": "entered against the wrong challan"}'::jsonb)`, [ok1.id], /already used by a posted set-off/))
await setOff('acct', 'CANCEL', so2.id, { reason: 'not needed' })
ok('set-off history is complete and append-only', await val(`select string_agg(action, ',' order by created_at) from public.gst_set_off_events where set_off_id = $1`, [so.id]) === 'SAVED,POSTED'
  && await ownerRefused(`delete from public.gst_set_off_events where set_off_id = '${so.id}'`, /permanent GST history/)
  && await ownerRefused(`update public.gst_set_offs set notes = 'x' where id = '${so.id}'`, /cannot be changed; reverse it/))

// Return periods: overlap protection, frozen shape, review → approval → close, snapshots, amendment queue, reopen.
ok('periods: overlapping (a quarter over an existing month) and duplicate starts refused at database level; dates and frequency frozen',
  await ownerRefused(`insert into public.gst_return_periods (company_id, registration_id, period_code, frequency, financial_year, period_start, period_end)
     values ('${A}', '${gstReg.id}', '${nov.period_start.slice(0, 4)}-Q3', 'QUARTERLY', '${nov.financial_year}', (date '${nov.period_start}' - interval '1 month')::date,
             (date '${nov.period_start}' + interval '2 months' - interval '1 day')::date)`, /overlaps the existing period/)
  && await refused('acct', `select public.gst_period_create($1::date)`, [nov.period_start], /already starts|overlaps/)
  && await ownerRefused(`update public.gst_return_periods set period_end = period_end + 1 where id = '${nov.id}'`, /never change/)
  && await ownerRefused(`insert into public.gst_return_periods (company_id, registration_id, period_code, frequency, financial_year, period_start, period_end)
     values ('${A}', '${gstReg.id}', '2030-01', 'MONTHLY', '2029-30', '2030-01-01', '2030-02-15')`, /gst_return_periods_shape|check constraint/))
const tr = (user, id, action, reason = null) => as(user)(`select public.gst_period_transition($1::uuid, $2, $3)`, [id, action, reason])
await tr('acct', nov.id, 'START_REVIEW')
const adjR = await as('acct')(`select public.gst_return_adjustment('CREATE', null, $1::jsonb)`, [JSON.stringify({ period_id: nov.id, return_type: 'GSTR3B', section: '3.1(a)',
  field: 'taxable', tax_head: 'TAXABLE', amount: '-100', reason: 'Advance adjusted against the invoice' })])
ok('a draft return adjustment blocks READY; its maker cannot approve it', await refused('acct', `select public.gst_period_transition($1::uuid, 'READY', null)`, [nov.id], /await approval/)
  && await refused('acct', `select public.gst_return_adjustment('APPROVE', $1::uuid, '{}'::jsonb)`, [adjR.id], /Maker-checker/))
await as('acct2')(`select public.gst_return_adjustment('APPROVE', $1::uuid, '{}'::jsonb)`, [adjR.id])
await tr('acct', nov.id, 'READY')
ok('maker-checker on approval: the preparer cannot approve the period', await refused('acct', `select public.gst_period_transition($1::uuid, 'APPROVE', null)`, [nov.id], /Maker-checker/))
const novA = await tr('acct2', nov.id, 'APPROVE')
const snap1 = novA.current_snapshot
const snap1Docs = await val(`select count(*)::int from public.gst_snapshot_documents where snapshot_id = $1`, [snap1.id])
ok('approval inserts snapshot v1 with per-document content hashes, the config version and the approved adjustment', novA.status === 'APPROVED' && snap1.version_no === 1
  && snap1Docs > 0 && snap1.config_version_id === cfg1.id && /^[0-9a-f]{64}$/.test(snap1.snapshot_hash)
  && await val(`select jsonb_array_length(data -> 'adjustments')::int from public.gst_period_snapshots where id = $1`, [snap1.id]) === 1)
ok('snapshots are immutable for everyone (update / delete refused)', await ownerRefused(`update public.gst_period_snapshots set totals = '{}' where id = '${snap1.id}'`, /permanent GST history/)
  && await ownerRefused(`delete from public.gst_snapshot_documents where snapshot_id = '${snap1.id}'`, /permanent GST history/))
ok('closing: not by the preparer, not without gst_periods.close', await refused('acct', `select public.gst_period_transition($1::uuid, 'CLOSE', null)`, [nov.id], /Maker-checker/)
  && await refused('viewer', `select public.gst_period_transition($1::uuid, 'CLOSE', null)`, [nov.id], /not allowed/))
await tr('acct2', nov.id, 'CLOSE', 'Reviewed: open warnings acknowledged for the test period')
ok('a configuration may not take effect inside a closed period', await (async () => {
  const c = await cfgSave('acct', nov.period_start, cfgPayload()); await acct(`select public.gst_config_submit($1::uuid)`, [c.id])
  const r = await refused('acct2', `select public.gst_config_approve($1::uuid)`, [c.id], /already starts on or after|approved or closed/)
  await as('acct2')(`select public.gst_config_reject($1::uuid, 'test of closed-period rule')`, [c.id]); return r })())
// Changes after approval: a late ITC decision and a reversed purchase invoice in November.
const L = await piPost(sup1, 'GST-L-1', [dirL(rent, 2000, 5)], '2100.00', { invoice_type: 'SERVICE' })
await gstVerify(L.id, 'INELIGIBLE', 'Blocked credit: used for personal consumption', '{}')
const scan1 = await acct(`select public.gst_amendments_scan()`)
const queued = await rows(`select kind, source_kind, status, assigned_period_id from public.gst_amendment_exceptions where origin_period_id = $1`, [nov.id])
ok('changes after approval with no later period: queued as PENDING_ASSIGNMENT (not dropped, not assigned elsewhere)', scan1.detected >= 2
  && queued.every((q) => q.status === 'PENDING_ASSIGNMENT' && q.assigned_period_id === null) && queued.some((q) => q.kind === 'LATE_DOCUMENT' && q.source_kind === 'PURCHASE_INVOICE')
  && queued.some((q) => q.kind === 'LATE_DOCUMENT' && q.source_kind === 'ITC_DECISION'))
ok('the scan is idempotent', (await acct(`select public.gst_amendments_scan()`)).detected === 0)
const dec = await acct(`select public.gst_period_create($1::date)`, [nextYear])
ok('creating the next period assigns the queued exceptions to it (OPEN)', dec.amendments_assigned === queued.length
  && await val(`select count(*)::int from public.gst_amendment_exceptions where origin_period_id = $1 and assigned_period_id = $2 and status = 'OPEN'`, [nov.id, dec.id]) === queued.length)
await tr('acct', dec.id, 'START_REVIEW')
ok('unresolved amendments block READY of the next period', await refused('acct', `select public.gst_period_transition($1::uuid, 'READY', null)`, [dec.id], /Amendment exceptions/))
const amIds = (await rows(`select id::text from public.gst_amendment_exceptions where assigned_period_id = $1`, [dec.id])).map((r) => r.id)
for (const id of amIds) await acct(`select public.gst_amendment_resolve($1::uuid, 'PROPOSE', 'INCLUDED_AS_AMENDMENT', 'Reported in the next return as an amendment')`, [id])
ok('amendment resolution: maker cannot approve; a checker resolves', await refused('acct', `select public.gst_amendment_resolve($1::uuid, 'APPROVE', null, null)`, [amIds[0]], /Maker-checker/)
  && await (async () => { for (const id of amIds) await as('acct2')(`select public.gst_amendment_resolve($1::uuid, 'APPROVE', null, null)`, [id]); return true })()
  && !!(await tr('acct', dec.id, 'READY')))
ok('reopen: only with gst_periods.reopen (Super Admin) and a reason of 10+ characters', await refused('acct2', `select public.gst_period_transition($1::uuid, 'REOPEN', 'amend the return')`, [nov.id], /not allowed/)
  && await refused('op', `select public.gst_period_transition($1::uuid, 'REOPEN', 'short')`, [nov.id], /at least 10/))
const snap1Hash = await val(`select snapshot_hash || ':' || md5(totals::text) || ':' || (select count(*) from public.gst_snapshot_documents where snapshot_id = s.id)
  from public.gst_period_snapshots s where id = $1`, [snap1.id])
await tr('op', nov.id, 'REOPEN', 'Late supplier invoice to be included in the original return')
await tr('acct', nov.id, 'START_REVIEW'); await tr('acct', nov.id, 'READY')
const novA2 = await tr('acct2', nov.id, 'APPROVE')
ok('re-approval adds snapshot v2 and moves the pointer; v1 is exactly as it was (hash, totals, documents)', novA2.current_snapshot.version_no === 2
  && novA2.snapshots.length === 2 && await val(`select snapshot_hash || ':' || md5(totals::text) || ':' || (select count(*) from public.gst_snapshot_documents where snapshot_id = s.id)
     from public.gst_period_snapshots s where id = $1`, [snap1.id]) === snap1Hash
  && await val(`select count(*)::int from public.gst_snapshot_documents where snapshot_id = $1`, [novA2.current_snapshot.id]) > snap1Docs
  && novA2.events.map((e) => e.action).filter((x) => x === 'APPROVED').length === 2)

// Filing frequency history and HSN reference rates.
ok('filing frequency: quarterly must start on a financial-year quarter; never before the current one or inside existing periods; history kept',
  await refused('acct', `select public.gst_frequency_add('QUARTERLY', '2027-02-01', 'moving to the quarterly scheme')`, null, /quarter/)
  && await refused('acct', `select public.gst_frequency_add('MONTHLY', $1::date, 'back to monthly from November')`, [nov.period_start], /already exist on or after|must start after/)
  && (await acct(`select public.gst_frequency_add('QUARTERLY', '2027-01-01', 'moving to the quarterly scheme')`)).frequency === 'QUARTERLY'
  && (await acct(`select public.gst_period_create('2027-01-01'::date)`)).period_code.endsWith('-Q4')
  && await val(`select string_agg(frequency, ',' order by period_start) from public.gst_return_periods where registration_id = $1`, [gstReg.id]) === 'MONTHLY,MONTHLY,QUARTERLY'
  && await ownerRefused(`update public.gst_registration_frequencies set frequency = 'QUARTERLY' where registration_id = '${gstReg.id}'`, /permanent GST history/))
ok('HSN / SAC reference rates are effective-dated (warnings only); a duplicate start is refused', !!(await acct(`select public.gst_hsn_rate_save($1::jsonb)`,
  [JSON.stringify({ hsn_sac: '6910', gst_rate: 18, effective_from: fyStart, description: 'Ceramic sanitary ware' })])).id
  && await refused('acct', `select public.gst_hsn_rate_save($1::jsonb)`, [JSON.stringify({ hsn_sac: '6910', gst_rate: 12, effective_from: fyStart })], /already starts/)
  && await refused('viewer', `select public.gst_hsn_rate_save($1::jsonb)`, [JSON.stringify({ hsn_sac: '6911', gst_rate: 12, effective_from: fyStart })], /not allowed/))
// Isolation, read-only and rollback safety.
ok('company isolation: company B sees no GST data of A and cannot act on it', (await request('b_op', `select count(*)::int from public.gst_return_periods`)).value === 0
  && (await request('b_op', `select count(*)::int from public.gst_itc_decisions`)).value === 0
  && await refused('b_op', `select public.gst_itc_get($1::uuid)`, [W.id], /not found/) && await refused('b_op', `select public.gst_period_get($1::uuid)`, [nov.id], /not found/)
  && await refused('sales', `select public.gst_overview()`, null, /not allowed/))
ok('no direct writes by API roles', await refused('acct', `insert into public.gst_return_periods (company_id) values ($1)`, [A], /permission denied/)
  && await refused('acct', `update public.gst_itc_adjustments set cgst = 0`, null, /permission denied/) && await refused('service_role', `select count(*) from public.gst_registrations`, null, /permission denied/))
ok('Phase 5 read-only RPCs run inside a READ ONLY transaction', await (async () => {
  await db.exec('reset role'); await db.exec('begin read only')
  try {
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: await val(`select rls_test.id('acct')::text`), role: 'authenticated' })])
    await db.exec('reset role'); await db.exec('set local role authenticated')
    for (const q of [`select public.gst_overview()`, `select public.gst_config_get('${cfg1.id}'::uuid)`, `select public.gst_periods_list(null)`, `select public.gst_period_get('${nov.id}'::uuid)`,
      `select public.gst_itc_get('${W.id}'::uuid)`, `select public.gst_itc_queue('{}'::jsonb)`, `select public.gst_liability_summary('${nov.id}'::uuid)`]) await db.query(q)
    await db.exec('rollback'); return true
  } catch (e) { await db.exec('rollback').catch(() => {}); console.log('      got:', e.message); return false }
})())
ok('Phase 5 rollback is refused while GST records exist', await ownerRefused(await read(path.join(rbDir, `${GT}_down.sql`)), /GST records exist/))

console.log('\nS. GSTR-2B import and reconciliation (Phase 5, Gate C)')
const tryPostOn = async (pid, lines, pattern) => { const d = await setOff('acct', 'SAVE', null, { period_id: pid, lines })
  const r = await refused('acct2', `select public.gst_set_off('POST', $1::uuid, '{}'::jsonb)`, [d.id], pattern)
  await setOff('acct', 'CANCEL', d.id, { reason: 'test draft' }); return r }
const sha256 = (b) => createHash('sha256').update(b).digest('hex')
const dmy = (iso) => iso.split('-').reverse().join('-')
const yday2b = await val(`select ($1::date - 1)::text`, [today])
const ownGstin = companyGstin
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
let rowNo = 0
const f2b = (gstin, number, date, taxable, igst, cgst, sgst, extra = {}) => ({ supplier_gstin: gstin, supplier_name: 'GSTR-2B supplier', doc_number: number, doc_date: dmy(date),
  place_of_supply: '27-Maharashtra', reverse_charge: 'N', taxable_value: String(taxable), igst: String(igst), cgst: String(cgst), sgst: String(sgst), cess: '0',
  itc_availability: 'Yes', ...extra })
const asRow = (fields, section = 'B2B') => ({ sheet: section, section, row_no: ++rowNo, original: Object.fromEntries(Object.entries(fields).map(([k, v]) => [`Original ${k}`, v])), fields })
const prep = (user, body) => as(user)(`select public.gst_2b_upload_prepare($1::jsonb)`, [JSON.stringify(body)])
const fileBody = (bytes, extra = {}) => ({ file_name: 'GSTR2B.csv', mime_type: 'text/csv', file_size: bytes.length, sha256: sha256(bytes), return_period: '2026-11', ...extra })
const putObject = (user, imp, size, mime = 'text/csv') => request(user, `insert into storage.objects (bucket_id, name, owner, metadata) values ('gst-files', $1, auth.uid(), $2::jsonb)`,
  [imp.storage_path, JSON.stringify({ size, mimetype: mime })])
const target2b = (user, id) => as(user)(`select public.gst_2b_verify_target($1::uuid)`, [id])
const record2b = async (id, token, result) => (await request('service_role', `select public.gst_2b_verify_record($1::uuid, $2::uuid, $3::jsonb)`, [id, token, JSON.stringify(result)]))
const uploadVerified = async (bytes, rows, extra = {}, result = {}) => {
  const imp = await prep('acct', fileBody(bytes, extra))
  const put = await putObject('acct', imp, bytes.length, extra.mime_type ?? 'text/csv')
  if (put.error) throw new Error(put.error)
  await acct(`select public.gst_2b_upload_complete($1::uuid)`, [imp.id])
  const t = await target2b('acct', imp.id)
  const r = await record2b(imp.id, t.token, { sha256: sha256(bytes), size: bytes.length, ok: true, rows, parser: { sheets: [{ sheet: 'B2B' }] }, ...result })
  if (r.error) throw new Error(r.error)
  return r.value
}
const vouchersNow = () => val(`select count(*)::int from public.accounting_vouchers where company_id = $1`, [A])
const itcDecisionsNow = () => val(`select count(*)::int from public.gst_itc_decisions where company_id = $1`, [A])

// Purchase invoices to reconcile (posted; GST pending verification).
const G = {}
for (const [k, sup, num, price] of [['g1', sup1, 'S2B-001', 1000], ['g2', sup1, 'S2B-002', 2000], ['g3', sup2, 'S2B-003', 500], ['g4', sup1, 'S2B-004', 1000],
  ['g5', sup1, 'S2B-005', 1000], ['g6', sup2, 'S2B-006', 700], ['g7', sup1, 'S2B-007', 1000], ['g8', sup1, 'S2B-008', 1000]]) {
  G[k] = await piPost(sup, num, [dirL(rent, price, 18)], String(price * 1.18), { invoice_type: 'SERVICE' })
}
const S1 = '27AABCP1234A1Z5'
const S2 = '29AABCQ1234A1Z5'

// 1. Upload preparation: file type, size, checksum, permission.
const csvA = Buffer.from(`gstr2b-oct-${Date.now()}`)
ok('upload prepare: only .csv / .xlsx, MIME must match the extension, 1 byte – 10 MB, SHA-256 required',
  await refused('acct', `select public.gst_2b_upload_prepare($1::jsonb)`, [JSON.stringify(fileBody(csvA, { file_name: 'g.pdf', mime_type: 'application/pdf' }))], /Only CSV or Excel/)
  && await refused('acct', `select public.gst_2b_upload_prepare($1::jsonb)`, [JSON.stringify(fileBody(csvA, { mime_type: XLSX_MIME }))], /does not match the .csv extension/)
  && await refused('acct', `select public.gst_2b_upload_prepare($1::jsonb)`, [JSON.stringify(fileBody(csvA, { file_name: 'g.xlsx', mime_type: 'application/vnd.ms-excel' }))], /does not match the .xlsx extension/)
  && await refused('acct', `select public.gst_2b_upload_prepare($1::jsonb)`, [JSON.stringify(fileBody(csvA, { file_size: 0 }))], /between 1 byte and 10 MB/)
  && await refused('acct', `select public.gst_2b_upload_prepare($1::jsonb)`, [JSON.stringify(fileBody(csvA, { file_size: 10485761 }))], /between 1 byte and 10 MB/)
  && await refused('acct', `select public.gst_2b_upload_prepare($1::jsonb)`, [JSON.stringify(fileBody(csvA, { sha256: 'abc' }))], /SHA-256/)
  && await refused('acct', `select public.gst_2b_upload_prepare($1::jsonb)`, [JSON.stringify(fileBody(csvA, { file_name: '../x.csv' }))], /no folders/)
  && await refused('acct', `select public.gst_2b_upload_prepare($1::jsonb)`, [JSON.stringify(fileBody(csvA, { return_period: '2026-13' }))], /YYYY-MM/))
ok('upload prepare needs gst_reconciliation.manage (viewer / sales / admin refused)', await refused('viewer', `select public.gst_2b_upload_prepare($1::jsonb)`, [JSON.stringify(fileBody(csvA))], /not allowed/)
  && await refused('sales', `select public.gst_2b_upload_prepare($1::jsonb)`, [JSON.stringify(fileBody(csvA))], /not allowed/)
  && await refused('admin', `select public.gst_2b_upload_prepare($1::jsonb)`, [JSON.stringify(fileBody(csvA))], /not allowed/))
ok('the bucket is private with the MIME / size limits; there are no update or delete policies on its objects',
  await val(`select public::text || ':' || file_size_limit || ':' || array_to_string(allowed_mime_types, ',') from storage.buckets where id = 'gst-files'`) === `false:10485760:text/csv,${XLSX_MIME}`
  && await val(`select count(*)::int from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'gst_files%' and cmd in ('UPDATE', 'DELETE', 'ALL')`) === 0)

// 2. Upload: only the uploader, only the prepared path, only within the hour.
const impA = await prep('acct', fileBody(csvA))
ok('the storage path is server-chosen (company / gstr2b / import id); upload by another user, a viewer, or to any other path is refused',
  impA.storage_path === `${A}/gstr2b/${impA.id}.csv` && impA.status === 'PENDING_UPLOAD'
  && /row-level security|violates/.test((await putObject('acct2', impA, csvA.length)).error ?? '')
  && /row-level security|violates/.test((await putObject('viewer', impA, csvA.length)).error ?? '')
  && /row-level security|violates/.test((await request('acct', `insert into storage.objects (bucket_id, name) values ('gst-files', $1)`, [`${A}/gstr2b/other.csv`])).error ?? '')
  && /row-level security|violates/.test((await request('b_op', `insert into storage.objects (bucket_id, name) values ('gst-files', $1)`, [impA.storage_path])).error ?? ''))
ok('completing before the file exists is refused; only the uploader completes', await refused('acct', `select public.gst_2b_upload_complete($1::uuid)`, [impA.id], /not been uploaded/)
  && !(await putObject('acct', impA, csvA.length)).error
  && await refused('acct2', `select public.gst_2b_upload_complete($1::uuid)`, [impA.id], /Only the person who started the upload/))
const impAc = await acct(`select public.gst_2b_upload_complete($1::uuid)`, [impA.id])
ok('after completion the path is closed: the file cannot be uploaded again (no overwrite)', impAc.status === 'UPLOADED'
  && /row-level security|violates/.test((await putObject('acct', impA, csvA.length)).error ?? ''))
ok('a duplicate upload of the same file (same SHA-256) is refused', await refused('acct', `select public.gst_2b_upload_prepare($1::jsonb)`, [JSON.stringify(fileBody(csvA))], /Duplicate file/)
  && await refused('acct2', `select public.gst_2b_upload_prepare($1::jsonb)`, [JSON.stringify(fileBody(csvA, { file_name: 'renamed.csv' }))], /Duplicate file/))

// 3. Server-side verification (Edge Function role): token, checksum, corruption.
ok('verification record: service role only (users refused), with the one-time token issued to a permitted user',
  await refused('acct', `select public.gst_2b_verify_record($1::uuid, gen_random_uuid(), '{}'::jsonb)`, [impA.id], /permission denied/)
  && await refused('viewer', `select public.gst_2b_verify_target($1::uuid)`, [impA.id], /not allowed/)
  && await refused('b_op', `select public.gst_2b_verify_target($1::uuid)`, [impA.id], /not allowed|not found/)
  && /not valid or has expired/.test((await record2b(impA.id, '00000000-0000-4000-8000-000000000000', { sha256: sha256(csvA), size: csvA.length, ok: true, rows: [] })).error ?? ''))
const tA = await target2b('acct', impA.id)
const tamperedSha = sha256(Buffer.from('tampered bytes'))
const rejA = (await record2b(impA.id, tA.token, { sha256: tamperedSha, size: csvA.length, ok: true, rows: [asRow(f2b(S1, 'X-1', today, 1, 0, 0, 0))] })).value
ok('checksum mismatch (stored bytes differ from the declared SHA-256): REJECTED, computed checksum recorded, no rows kept, cannot be committed',
  rejA.status === 'REJECTED' && /Checksum mismatch/.test(rejA.rejection_reason) && rejA.computed_sha256 === tamperedSha
  && await val(`select count(*)::int from public.gst_2b_lines where import_id = $1`, [impA.id]) === 0
  && await refused('acct', `select public.gst_2b_import_commit($1::uuid, true, null)`, [impA.id], /only a file verified/)
  && await refused('acct', `select public.gst_2b_verify_target($1::uuid)`, [impA.id], /only an uploaded file/))
const csvB = Buffer.from(`gstr2b-corrupt-${Date.now()}`)
const impB = await prep('acct', fileBody(csvB, { file_name: 'corrupt.xlsx', mime_type: XLSX_MIME }))
await putObject('acct', impB, csvB.length, XLSX_MIME)
await acct(`select public.gst_2b_upload_complete($1::uuid)`, [impB.id])
const rejB = (await record2b(impB.id, (await target2b('acct', impB.id)).token, { sha256: sha256(csvB), size: csvB.length, ok: false,
  reason: 'The file is not a valid Excel .xlsx workbook (corrupted, or another format such as .xls / CSV renamed).' })).value
ok('file corruption (unreadable workbook): REJECTED with the reason; the file can then be uploaded again correctly', rejB.status === 'REJECTED' && /not a valid Excel/.test(rejB.rejection_reason)
  && (await acct(`select public.gst_2b_import_discard($1::uuid, 'corrupted download')`, [impB.id])).status === 'DISCARDED')
const csvS = Buffer.from(`gstr2b-size-${Date.now()}`)
const impS = await prep('acct', fileBody(csvS))
await putObject('acct', impS, csvS.length + 5)
ok('a stored object whose size differs from the declared size is rejected at completion', (await acct(`select public.gst_2b_upload_complete($1::uuid)`, [impS.id])).status === 'REJECTED')

// 4. A verified file: row validation, original rows, duplicates within the file.
const rowA = asRow(f2b(S1, 'S2B-001', today, 1000, 0, 90, 90))
const rows1 = [rowA, asRow(f2b(S1, 'S2B/002', today, 2000, 0, 180, '180.50')), asRow(f2b(S2, 'S2B-003', today, 600, 90, 0, 0)),
  asRow(f2b(S1, 'S2B-004', yday2b, 1000, 0, 90, 90)), asRow(f2b(S1, 'S2B-008', today, 1000, 0, 95, 95)), asRow(f2b(S1, 'S2B-005X', today, 1000, 0, 90, 90)),
  asRow(f2b(S2, 'S2B-007', today, 1000, 0, 90, 90)), asRow(f2b(S1, 'CN-1', today, 100, 0, 9, 9, { note_type: 'Credit Note' }), 'CDNR'),
  asRow(f2b(S1, 'NOT-IN-BOOKS-1', today, 300, 0, 27, 27)), asRow(f2b(S1, 'NOT-IN-BOOKS-2', today, 400, 0, 36, 36)),
  { ...rowA, row_no: ++rowNo },
  asRow(f2b('BADGSTIN', 'E-1', '2026-02-31', '12.345', 0, 0, 0)), asRow(f2b(ownGstin, 'E-2', today, 1, 0, 0, 0))]
const bytes1 = Buffer.from(`gstr2b-1-${Date.now()}`)
const vouchers0 = await vouchersNow()
const itc0 = await itcDecisionsNow()
const imp1 = await uploadVerified(bytes1, rows1)
const lines1 = (await acct(`select public.gst_2b_import_get($1::uuid, '{}'::jsonb)`, [imp1.id])).lines
const errLine = lines1.find((l) => l.doc_number === 'E-1')
ok('verified: checksum recomputed on the server equals the declared one; 13 rows: 10 valid, 1 duplicate in the file, 2 with errors',
  imp1.status === 'VERIFIED' && imp1.computed_sha256 === sha256(bytes1) && imp1.total_rows === 13 && imp1.valid_rows === 10 && imp1.duplicate_rows === 1 && imp1.error_rows === 2)
ok('validation: invalid GSTIN, impossible date, 3-decimal amount and the company\'s own GSTIN are errors; the original row is preserved as read',
  errLine.row_status === 'ERROR' && errLine.errors.some((e) => /not a valid GSTIN/.test(e)) && errLine.errors.some((e) => /not a valid date/.test(e))
  && errLine.errors.some((e) => /not a valid amount/.test(e)) && lines1.find((l) => l.doc_number === 'E-2').errors.some((e) => /your own GSTIN/.test(e))
  && errLine.original_row['Original taxable_value'] === '12.345' && lines1[0].original_row['Original doc_number'] === 'S2B-001' && lines1[0].source_row === rowA.row_no)
const dupLine = lines1.find((l) => l.row_status === 'DUPLICATE_IN_FILE')
ok('duplicate row within the import: flagged with the earlier row number, never imported twice', dupLine.doc_number === 'S2B-001' && dupLine.duplicate_of_line === 1)
ok('credit note row recognised (CDNR, CREDIT_NOTE); amounts are exact numerics', lines1.find((l) => l.doc_number === 'CN-1').doc_type === 'CREDIT_NOTE'
  && lines1.find((l) => l.doc_number === 'S2B/002').sgst === 180.5)
const prev1 = (await acct(`select public.gst_2b_import_get($1::uuid, '{}'::jsonb)`, [imp1.id])).preview
ok('preview before commit: 10 new documents, 1 credit / debit note, no vouchers, no ITC', prev1.new_documents === 10 && prev1.credit_debit_notes === 1
  && prev1.vouchers_created === 0 && prev1.itc_approved === 0)

// 5. Commit: errors must be acknowledged; nothing posted; immutability.
ok('commit with error rows needs an explicit acknowledgement; viewers cannot commit',
  await refused('acct', `select public.gst_2b_import_commit($1::uuid, false, null)`, [imp1.id], /have errors/)
  && await refused('viewer', `select public.gst_2b_import_commit($1::uuid, true, null)`, [imp1.id], /not allowed/))
const imp1c = await acct(`select public.gst_2b_import_commit($1::uuid, true, null)`, [imp1.id])
ok('committed: 10 new documents, 3 rows skipped; imported GSTR-2B data creates no voucher and no ITC decision', imp1c.status === 'COMMITTED' && imp1c.commit_summary.NEW === 10
  && imp1c.commit_summary.SKIPPED === 3 && await vouchersNow() === vouchers0 && await itcDecisionsNow() === itc0
  && await val(`select count(*)::int from public.purchase_invoices where id = any($1::uuid[]) and gst_status = 'PENDING_VERIFICATION'`, [Object.values(G).map((x) => x.id)]) === 8)
ok('a committed file cannot be committed or imported again (same SHA-256)', await refused('acct2', `select public.gst_2b_import_commit($1::uuid, true, null)`, [imp1.id], /only a file verified/)
  && await refused('acct', `select public.gst_2b_upload_prepare($1::jsonb)`, [JSON.stringify(fileBody(bytes1))], /Duplicate file/))
ok('original file immutability: users cannot update or delete the stored object; file details, checksum and rows never change, even for the owner',
  (await request('acct', `update storage.objects set metadata = '{"size": 1}' where bucket_id = 'gst-files' and name = $1 returning name`, [imp1.storage_path])).rows?.length === 0
  && (await request('acct', `delete from storage.objects where bucket_id = 'gst-files' and name = $1 returning name`, [imp1.storage_path])).rows?.length === 0
  && await val(`select count(*)::int from storage.objects where bucket_id = 'gst-files' and name = $1`, [imp1.storage_path]) === 1
  && await ownerRefused(`update public.gst_2b_imports set declared_sha256 = repeat('0', 64) where id = '${imp1.id}'`, /never change/)
  && await ownerRefused(`update public.gst_2b_imports set computed_sha256 = repeat('0', 64) where id = '${impA.id}'`, /never change/)
  && await ownerRefused(`update public.gst_2b_lines set original_row = '{}' where import_id = '${imp1.id}'`, /permanent GST history/)
  && await ownerRefused(`delete from public.gst_2b_imports where id = '${imp1.id}'`, /cannot be deleted/)
  && await ownerRefused(`update public.gst_2b_imports set status = 'VERIFIED' where id = '${imp1.id}'`, /cannot move|cannot be changed/)
  && await refused('acct', `update public.gst_2b_imports set file_name = 'x'`, null, /permission denied/))

// 6. Matching: auto proposals with exact / partial / mismatch outcomes; maker-checker approval.
const doc = async (number) => val(`select id::text from public.gst_2b_documents where company_id = $1 and doc_number = $2`, [A, number])
const matchOf = async (number) => (await rows(`select * from public.gst_2b_matches where document_id = $1 order by proposed_at desc limit 1`, [await doc(number)]))[0]
const am1 = await acct(`select public.gst_2b_auto_match('{}'::jsonb)`)
ok('auto-match proposes only (5 invoices found by supplier GSTIN + normalised number); credit notes and documents without a book entry are left open',
  am1.proposed === 5 && am1.no_candidate === 4 && am1.ambiguous === 0 && await vouchersNow() === vouchers0
  && await val(`select count(*)::int from public.gst_2b_matches where company_id = $1 and status = 'APPROVED'`, [A]) === 0)
const mxA = await matchOf('S2B-001'); const mB = await matchOf('S2B/002'); const mC = await matchOf('S2B-003'); const mD = await matchOf('S2B-004'); const mE = await matchOf('S2B-008')
ok('outcomes: exact; partial (0.50 within the 1.00 tolerance, number written differently); taxable mismatch; date mismatch; tax mismatch',
  mxA.outcome === 'EXACT' && mxA.purchase_invoice_id === G.g1.id && mB.outcome === 'PARTIAL' && mB.purchase_invoice_id === G.g2.id && Number(mB.differences.sgst.difference) === 0.5
  && mC.outcome === 'TAXABLE_MISMATCH' && mC.mismatches.join() === 'TAXABLE' && mD.outcome === 'DATE_MISMATCH' && mD.mismatches.join() === 'DATE'
  && mE.outcome === 'TAX_MISMATCH' && mE.method === 'AUTO')
ok('maker-checker: the user who ran the proposals cannot approve; viewers cannot approve; a match with differences needs a note',
  await refused('acct', `select public.gst_2b_match_decide($1::uuid, 'APPROVE', null)`, [mxA.id], /Maker-checker/)
  && await refused('viewer', `select public.gst_2b_match_decide($1::uuid, 'APPROVE', null)`, [mxA.id], /not allowed/)
  && await refused('acct2', `select public.gst_2b_match_decide($1::uuid, 'APPROVE', null)`, [mB.id], /record why they are acceptable/))
const mAa = await as('acct2')(`select public.gst_2b_match_decide($1::uuid, 'APPROVE', null)`, [mxA.id])
const mBa = await as('acct2')(`select public.gst_2b_match_decide($1::uuid, 'APPROVE', 'Supplier rounding of 50 paise on SGST')`, [mB.id])
ok('approved by a checker (exact without a note; partial with one); history records proposer and checker', mAa.status === 'APPROVED' && mBa.status === 'APPROVED'
  && mAa.history.map((h) => h.action).join() === 'PROPOSED,APPROVED' && mBa.decision_note.startsWith('Supplier rounding')
  && await refused('acct2', `select public.gst_2b_match_decide($1::uuid, 'APPROVE', null)`, [mxA.id], /only a proposed match/))

// 7. Manual matching with a reason (number / GSTIN mismatches), credit notes, one active match per document and per invoice.
const docF = await doc('S2B-005X'); const docG = await doc('S2B-007'); const docCN = await doc('CN-1')
ok('manual match needs gst_reconciliation.manage and a reason of 10+ characters', await refused('viewer', `select public.gst_2b_match_manual($1::jsonb)`,
  [JSON.stringify({ document_id: docF, purchase_invoice_id: G.g5.id, reason: 'supplier typo in number' })], /not allowed/)
  && await refused('acct', `select public.gst_2b_match_manual($1::jsonb)`, [JSON.stringify({ document_id: docF, purchase_invoice_id: G.g5.id, reason: 'typo' })], /at least 10/))
const mF = await acct(`select public.gst_2b_match_manual($1::jsonb)`, [JSON.stringify({ document_id: docF, purchase_invoice_id: G.g5.id, reason: 'Supplier added an X to the invoice number' })])
const mG = await acct(`select public.gst_2b_match_manual($1::jsonb)`, [JSON.stringify({ document_id: docG, purchase_invoice_id: G.g7.id, reason: 'Supplier reported under its other-state GSTIN' })])
ok('manual matches record the invoice-number mismatch and the GSTIN mismatch; method MANUAL with the reason', mF.outcome === 'NUMBER_MISMATCH' && mF.method === 'MANUAL'
  && mF.differences.doc_number.books === 'S2B-005' && mG.outcome === 'GSTIN_MISMATCH' && mG.mismatches.includes('GSTIN') && mG.reason.startsWith('Supplier reported'))
ok('refused: a credit note, a document already matched, an invoice already matched, an unposted / unknown invoice',
  await refused('acct', `select public.gst_2b_match_manual($1::jsonb)`, [JSON.stringify({ document_id: docCN, purchase_invoice_id: G.g6.id, reason: 'credit note against invoice' })], /credit \/ debit notes/)
  && await refused('acct', `select public.gst_2b_match_manual($1::jsonb)`, [JSON.stringify({ document_id: await doc('S2B-001'), purchase_invoice_id: G.g6.id, reason: 'second match of a document' })], /already has a proposed or approved match/)
  && await refused('acct', `select public.gst_2b_match_manual($1::jsonb)`, [JSON.stringify({ document_id: await doc('NOT-IN-BOOKS-1'), purchase_invoice_id: G.g1.id, reason: 'invoice already matched elsewhere' })], /already has a proposed or approved GSTR-2B match/)
  && await refused('acct', `select public.gst_2b_match_manual($1::jsonb)`, [JSON.stringify({ document_id: await doc('NOT-IN-BOOKS-1'), purchase_invoice_id: '00000000-0000-4000-8000-000000000009', reason: 'unknown invoice id' })], /not found/))
await as('acct2')(`select public.gst_2b_match_decide($1::uuid, 'REJECT', 'Different supplier, not the same document')`, [mG.id])
const mFa = await as('acct2')(`select public.gst_2b_match_decide($1::uuid, 'APPROVE', 'Number confirmed with the supplier by email')`, [mF.id])
ok('a checker rejects the GSTIN mismatch and approves the number mismatch with a note; a rejected match frees the document', mFa.status === 'APPROVED'
  && await val(`select status from public.gst_2b_matches where id = $1`, [mG.id]) === 'REJECTED'
  && (await acct(`select public.gst_2b_document_get($1::uuid)`, [docG])).matches.length === 1)

// 8. Cross-company prevention.
ok('cross-company: company B sees no GSTR-2B rows of A and cannot read, match, approve, reverse, verify or download them',
  (await request('b_op', `select count(*)::int from public.gst_2b_documents`)).value === 0 && (await request('b_op', `select count(*)::int from public.gst_2b_lines`)).value === 0
  && await refused('b_op', `select public.gst_2b_import_get($1::uuid, '{}'::jsonb)`, [imp1.id], /not found/)
  && await refused('b_op', `select public.gst_2b_document_get($1::uuid)`, [docF], /not found/)
  && await refused('b_op', `select public.gst_2b_match_manual($1::jsonb)`, [JSON.stringify({ document_id: await doc('NOT-IN-BOOKS-1'), purchase_invoice_id: G.g6.id, reason: 'cross company attempt' })], /not found|GST registration/)
  && await refused('b_op', `select public.gst_2b_match_decide($1::uuid, 'APPROVE', 'cross company attempt')`, [mC.id], /not found/)
  && await refused('b_op', `select public.gst_2b_match_reverse($1::uuid, 'cross company attempt')`, [mxA.id], /not found/)
  && await refused('b_op', `select public.gst_2b_file_access($1::uuid)`, [imp1.id], /not found/)
  && (await request('b_op', `select count(*)::int from storage.objects where bucket_id = 'gst-files'`)).value === 0)
ok('…and the database refuses a match linking a document or invoice of another company (composite company foreign keys)',
  await ownerRefused(`insert into public.gst_2b_matches (company_id, registration_id, document_id, document_version_id, purchase_invoice_id, method, outcome, proposed_by)
     select '${B}', d.registration_id, d.id, v.id, '${G.g6.id}', 'AUTO', 'EXACT', rls_test.id('acct') from public.gst_2b_documents d
     join public.gst_2b_document_versions v on v.document_id = d.id where d.id = '${await doc('NOT-IN-BOOKS-1')}'`, /foreign key|violates/))

// 9. Duplicates across imports, amendments and changed supplier versions.
const rows2 = [asRow(f2b(S1, 'S2B-001', today, 1000, 0, 90, 90)), asRow(f2b(S1, 'S2B-002', today, 2000, 0, 180, 180)),
  asRow(f2b(S1, 'S2B-004', today, 1000, 0, 90, 90, { original_doc_number: 'S2B-004', original_doc_date: dmy(yday2b) }), 'B2BA')]
const imp2 = await uploadVerified(Buffer.from(`gstr2b-2-${Date.now()}`), rows2, { return_period: '2026-12' })
const prev2 = (await acct(`select public.gst_2b_import_get($1::uuid, '{}'::jsonb)`, [imp2.id])).preview
ok('preview of the next file: 1 already imported, 1 changed, 1 amendment, nothing new', prev2.already_imported === 1 && prev2.changed === 1 && prev2.amendments === 1 && prev2.new_documents === 0)
const imp2c = await acct(`select public.gst_2b_import_commit($1::uuid, false, null)`, [imp2.id])
const docB = await acct(`select public.gst_2b_document_get($1::uuid)`, [await doc('S2B-002')])
const docD = await acct(`select public.gst_2b_document_get($1::uuid)`, [await doc('S2B-004')])
ok('duplicate document across imports: recognised, no new version; changed values: version 2 (CHANGED); B2BA row: version 2 (AMENDMENT)',
  imp2c.commit_summary.DUPLICATE_OF_EARLIER === 1 && imp2c.commit_summary.CHANGED === 1 && imp2c.commit_summary.AMENDMENT === 1
  && (await acct(`select public.gst_2b_document_get($1::uuid)`, [await doc('S2B-001')])).versions.length === 1
  && docB.versions.map((v) => `${v.version_no}:${v.version_kind}:${v.return_period}`).join() === '1:ORIGINAL:2026-11,2:CHANGED:2026-12'
  && docD.versions.map((v) => `${v.version_no}:${v.version_kind}`).join() === '1:ORIGINAL,2:AMENDMENT' && docD.versions[1].doc_date === today
  && docB.appearances.length === 2)
ok('a changed document flags its approved match for review (match kept, history DOCUMENT_CHANGED); the proposal on an amended document is superseded',
  docB.needs_review === true && docB.matches[0].status === 'APPROVED' && docB.matches[0].history.map((h) => h.action).join() === 'PROPOSED,APPROVED,DOCUMENT_CHANGED'
  && docD.matches[0].status === 'SUPERSEDED' && imp2c.commit_summary.proposals_superseded === 1 && imp2c.commit_summary.approved_matches_to_review === 1
  && await refused('acct2', `select public.gst_2b_match_decide($1::uuid, 'APPROVE', 'approving a superseded match')`, [mD.id], /only a proposed match/))
ok('version history is insert-only', await ownerRefused(`update public.gst_2b_document_versions set taxable_value = 0 where document_id = '${docB.id}'`, /permanent GST history/)
  && await ownerRefused(`update public.gst_2b_documents set doc_number_key = 'X' where id = '${docB.id}'`, /identity of a GSTR-2B document never changes/))

// 10. Reversal of an approved match; re-matching the current version.
ok('reversal of an approved match: checker permission and a reason of 10+ characters', await refused('viewer', `select public.gst_2b_match_reverse($1::uuid, 'values changed by supplier')`, [mB.id], /not allowed/)
  && await refused('acct2', `select public.gst_2b_match_reverse($1::uuid, 'short')`, [mB.id], /at least 10/)
  && await refused('acct2', `select public.gst_2b_match_reverse($1::uuid, 'not an approved match')`, [mE.id], /Only an approved match/))
const mBr = await as('acct2')(`select public.gst_2b_match_reverse($1::uuid, 'Supplier corrected the SGST; re-match the new version')`, [mB.id])
const am2 = await acct(`select public.gst_2b_auto_match($1::jsonb)`, [JSON.stringify({ import_id: imp2.id })])
const mxB2 = await matchOf('S2B-002'); const mD2 = await matchOf('S2B-004')
ok('reversed (history kept, review flag cleared); auto-match then proposes the current versions — now exact', mBr.status === 'REVERSED' && mBr.reversal_reason.startsWith('Supplier corrected')
  && mBr.history.map((h) => h.action).join() === 'PROPOSED,APPROVED,DOCUMENT_CHANGED,REVERSED' && (await acct(`select public.gst_2b_document_get($1::uuid)`, [docB.id])).needs_review === false
  && am2.proposed === 2 && mxB2.outcome === 'EXACT' && mxB2.document_version_id === docB.versions[1].id && mD2.outcome === 'EXACT'
  && await ownerRefused(`update public.gst_2b_matches set outcome = 'EXACT' where id = '${mC.id}'`, /cannot be changed/)
  && await ownerRefused(`update public.gst_2b_matches set status = 'APPROVED' where id = '${mBr.id}'`, /cannot move|cannot be changed/)
  && await ownerRefused(`delete from public.gst_2b_match_history where match_id = '${mB.id}'`, /permanent GST history/))

// 11. Reports.
const rep2b = (r, f = {}) => acct(`select public.gst_2b_report($1, $2::jsonb)`, [r, JSON.stringify(f)])
const sum = await rep2b('SUMMARY')
const mib = (await rep2b('MISSING_IN_BOOKS')).rows
const mi2b = (await rep2b('MISSING_IN_2B', { from: today, to: today })).rows
const cn = (await rep2b('CREDIT_NOTES')).rows
const dups = (await rep2b('DUPLICATES')).rows
const amends = (await rep2b('AMENDMENTS')).rows
ok('reports: summary; missing in books (with candidate invoices); missing in GSTR-2B; supplier credit notes as unresolved exceptions; duplicates; amendments',
  sum.documents === 10 && sum.approved === 2 && sum.credit_debit_notes === 1 && sum.missing_in_books === 3
  && mib.map((r) => r.doc_number).sort().join() === 'NOT-IN-BOOKS-1,NOT-IN-BOOKS-2,S2B-007' && mib.every((r) => r.exception === 'MISSING_IN_BOOKS')
  && mi2b.some((r) => r.purchase_invoice_id === G.g6.id) && !mi2b.some((r) => r.purchase_invoice_id === G.g1.id) && mi2b.some((r) => r.purchase_invoice_id === G.g2.id)
  && cn.length === 1 && cn[0].exception === 'CREDIT_NOTE_UNRESOLVED'
  && dups.filter((d) => d.kind === 'DUPLICATE_IN_FILE').length === 1 && dups.filter((d) => d.kind === 'DUPLICATE_OF_EARLIER').length === 1
  && amends.map((a) => a.doc_number).sort().join() === 'S2B-002,S2B-004'
  && (await rep2b('MATCH_EXCEPTIONS')).rows.some((r) => r.outcome === 'TAXABLE_MISMATCH') && (await rep2b('HISTORY')).rows.length > 0
  && await refused('sales', `select public.gst_2b_report('SUMMARY', '{}'::jsonb)`, null, /not allowed/))

// 12. ITC: GSTR-2B is evidence only; the decision still needs maker-checker (Phase 3 regression).
const itcG1 = await acct(`select public.gst_itc_get($1::uuid)`, [G.g1.id])
ok('ITC view shows the approved GSTR-2B match as evidence; GST stays pending and no ITC decision exists (never approved automatically)',
  itcG1.gstr2b.match_status === 'APPROVED' && itcG1.gstr2b.outcome === 'EXACT' && itcG1.gstr2b.itc_availability === 'YES' && itcG1.gst_status === 'PENDING_VERIFICATION'
  && itcG1.history.length === 0 && (await acct(`select public.gst_itc_get($1::uuid)`, [G.g6.id])).gstr2b.match_status === 'NOT_MATCHED')
await act('acct', 'verify_gst', G.g1.id, 'ELIGIBLE', 'Matched with GSTR-2B and the supplier invoice', JSON.stringify(gstChecks))
ok('…the ITC decision is still proposed and approved by two different users', await refused('acct', `select public.gst_itc_action($1::uuid, 'APPROVE', '{}'::jsonb)`, [G.g1.id], /Maker-checker/)
  && (await as('acct2')(`select public.gst_itc_action($1::uuid, 'APPROVE', '{}'::jsonb)`, [G.g1.id])).gst_status === 'ELIGIBLE')

// 13. Original file download: audited, short-lived, permission-checked.
ok('download: a reader gets a 5-minute grant (audited) and can then read the object; without a grant nobody can; sales refused',
  (await request('acct2', `select count(*)::int from storage.objects where bucket_id = 'gst-files' and name = $1`, [imp1.storage_path])).value === 0
  && (await as('viewer')(`select public.gst_2b_file_access($1::uuid)`, [imp1.id])).storage_path === imp1.storage_path
  && (await request('viewer', `select count(*)::int from storage.objects where bucket_id = 'gst-files' and name = $1`, [imp1.storage_path])).value === 1
  && (await request('acct2', `select count(*)::int from storage.objects where bucket_id = 'gst-files' and name = $1`, [imp1.storage_path])).value === 0
  && await refused('sales', `select public.gst_2b_file_access($1::uuid)`, [imp1.id], /not allowed/)
  && await val(`select count(*)::int from public.audit_logs where action = 'gst.itc_statement_file_download' and resource_id = $1`, [imp1.id]) === 1
  && await ownerRefused(`update public.gst_file_access_grants set expires_at = now() + interval '1 year'`, /permanent GST history/))

// 14. Set-off availability (safeguard 2): qualified credit, previous-period liability, reversed set-offs.
await gstVerify(G.g3.id, 'ELIGIBLE', 'IGST invoice matched with GSTR-2B', JSON.stringify(gstChecks))
const oct = await acct(`select public.gst_period_create($1::date)`, ['2026-10-01'])
await acct(`select public.accounting_voucher_post($1::uuid)`, [(await acct(`select public.accounting_voucher_create($1::jsonb)`, [jv('2026-10-15', [{ account_id: rent, debit: '300' },
  { account_id: outIgst, credit: '200' }, { account_id: outCgst, credit: '100' }])])).id])
const octL = await acct(`select public.gst_liability_summary($1::uuid)`, [oct.id])
const novL = await acct(`select public.gst_liability_summary($1::uuid)`, [nov.id])
ok('credit is qualified, not the ledger balance: October has IGST on the books today but none accrued by 31 October → 0 available',
  Number(octL.credit_detail.IGST.ledger_balance) >= 90 && Number(octL.credit_detail.IGST.accrued_to_period_end) === 0 && Number(octL.credit.IGST) === 0
  && Number(novL.credit.IGST) === Math.max(0, Math.min(Number(novL.credit_detail.IGST.accrued_to_period_end) - Number(novL.credit_detail.IGST.used_in_posted_set_offs),
    Number(novL.credit_detail.IGST.ledger_balance))) && Number(novL.credit_detail.IGST.used_in_posted_set_offs) === igstCredit)
ok('…so an October set-off using IGST credit is refused although the ledger shows a balance', await tryPostOn(oct.id, [line('OUTPUT', 'IGST', 'CREDIT', 'IGST', '50')],
  /Input IGST credit available for 2026-10 is 0/))
ok('liability: October open output IGST 200 / CGST 100; November shows October as previous-period outstanding (with a warning)',
  Number(octL.open['OUTPUT:IGST']) === 200 && Number(octL.open['OUTPUT:CGST']) === 100 && Number(novL.previous_outstanding['OUTPUT:IGST']) === 200
  && novL.warnings.some((w) => /Output IGST of earlier periods is still outstanding: 200/.test(w)))
const soOct = await setOff('acct', 'SAVE', null, { period_id: oct.id, lines: [line('OUTPUT', 'CGST', 'CASH', 'CGST', '100', 'TAX')] })
await setOff('acct2', 'POST', soOct.id)
const octL2 = await acct(`select public.gst_liability_summary($1::uuid)`, [oct.id])
const cashAfter = Number(octL2.cash['CGST:TAX'])
ok('a posted set-off settles only its own period: October CGST open 0, November no longer shows it outstanding', Number(octL2.open['OUTPUT:CGST']) === 0
  && Number((await acct(`select public.gst_liability_summary($1::uuid)`, [nov.id])).previous_outstanding['OUTPUT:CGST']) === 0
  && await tryPostOn(oct.id, [line('OUTPUT', 'CGST', 'CASH', 'CGST', '1', 'TAX')], /already posted/))
await setOff('acct2', 'REVERSE', soOct.id, { reason: 'Paid against the wrong period' })
const octL3 = await acct(`select public.gst_liability_summary($1::uuid)`, [oct.id])
ok('a reversed set-off is excluded: the October liability and the electronic cash are available again', Number(octL3.open['OUTPUT:CGST']) === 100
  && Number(octL3.cash['CGST:TAX']) === cashAfter + 100 && !('OUTPUT:CGST' in octL3.set_off))

// 15. Read-only RPCs, rollback guard.
ok('Gate C read-only RPCs run inside a READ ONLY transaction', await (async () => {
  await db.exec('reset role'); await db.exec('begin read only')
  try {
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: await val(`select rls_test.id('acct')::text`), role: 'authenticated' })])
    await db.exec('reset role'); await db.exec('set local role authenticated')
    for (const q of [`select public.gst_2b_imports_list('{}'::jsonb)`, `select public.gst_2b_import_get('${imp1.id}'::uuid, '{"row_status": "ERROR"}'::jsonb)`,
      `select public.gst_2b_document_get('${docB.id}'::uuid)`, `select public.gst_2b_match_get('${mxA.id}'::uuid)`, `select public.gst_itc_get('${G.g1.id}'::uuid)`,
      ...['SUMMARY', 'DOCUMENTS', 'MISSING_IN_BOOKS', 'MISSING_IN_2B', 'CREDIT_NOTES', 'DUPLICATES', 'AMENDMENTS', 'MATCH_EXCEPTIONS', 'HISTORY'].map((r) => `select public.gst_2b_report('${r}', '{}'::jsonb)`)]) await db.query(q)
    await db.exec('rollback'); return true
  } catch (e) { await db.exec('rollback').catch(() => {}); console.log('      got:', e.message); return false }
})())
ok('Gate C rollback is refused while GSTR-2B records or original files exist', await ownerRefused(await read(path.join(rbDir, `${G2B}_down.sql`)), /GSTR-2B records exist/))

console.log('\nT. GST return preparation (Phase 5, Gate D)')
// Fixtures: October sales documents cloned from an issued invoice (owner session, triggers off only for the fixture insert).
const octDate = '2026-10-15'
const ownerFixture = async (fn) => {
  await db.exec('reset role'); await db.exec('begin'); await db.exec('set local session_replication_role = replica')
  try { const r = await fn(); await db.exec('commit'); return r } catch (e) { await db.exec('rollback'); throw e }
}
const cloneInvoice = (num, status, o, l) => ownerFixture(async () => {
  const id = randomUUID(); const lid = randomUUID()
  const taxable = o.taxable; const ig = o.igst ?? 0; const cg = o.cgst ?? 0; const sg = o.sgst ?? 0
  const issued = status === 'ISSUED' || status === 'CANCELLED'
  await db.query(`insert into public.sales_invoices select (jsonb_populate_record(null::public.sales_invoices, to_jsonb(i) || $2::jsonb)).* from public.sales_invoices i where i.id = $1`,
    [anInvoice, JSON.stringify({ id, invoice_number: issued ? num : null, invoice_date: octDate, due_date: octDate, status, customer_registration_type: o.reg, customer_gstin: o.gstin ?? null,
      place_of_supply_state_code: o.pos ?? null, tax_treatment: o.treatment, supply_category: o.category ?? 'TAXABLE', gross_total: taxable, discount_total: 0, taxable_subtotal: taxable,
      other_charges_total: 0, cgst_total: cg, sgst_total: sg, igst_total: ig, round_off: 0, grand_total: taxable + ig + cg + sg, is_proforma: false,
      issued_at: issued ? `${octDate}T10:00:00Z` : null, cancelled_at: status === 'CANCELLED' ? `${octDate}T11:00:00Z` : null,
      cancellation_reason: status === 'CANCELLED' ? 'Raised in error' : null })])
  await db.query(`insert into public.sales_invoice_lines select (jsonb_populate_record(null::public.sales_invoice_lines, to_jsonb(l) || $2::jsonb)).* from public.sales_invoice_lines l
    where l.id = (select id from public.sales_invoice_lines where invoice_id = $1 order by line_no limit 1)`, [anInvoice, JSON.stringify({ id: lid, invoice_id: id, line_no: 1,
      hsn_sac: l?.hsn === undefined ? '6910' : l.hsn, unit: 'PCS', quantity: 2, unit_price: taxable / 2, gross_amount: taxable, discount_amount: 0, taxable_value: taxable,
      gst_rate: o.rate ?? 18, cgst_rate: cg ? 9 : 0, sgst_rate: sg ? 9 : 0, igst_rate: ig ? 18 : 0, cgst_amount: cg, sgst_amount: sg, igst_amount: ig, line_total: taxable + ig + cg + sg })])
  return { id, lid }
})
const cloneNote = (num, status, inv, o) => ownerFixture(async () => {
  const id = randomUUID()
  const issued = status === 'ISSUED'
  await db.query(`insert into public.invoice_adjustment_notes select (jsonb_populate_record(null::public.invoice_adjustment_notes, $1::jsonb)).*`, [JSON.stringify({ id, company_id: A,
    note_number: issued ? num : null, note_type: 'CREDIT', customer_id: await val(`select customer_id::text from public.sales_invoices where id = $1`, [inv.id]),
    original_invoice_id: inv.id, note_date: '2026-10-20', reason_code: 'PRICE_CORRECTION', reason: 'Rate correction', tax_treatment: o.treatment, taxable_amount: o.taxable,
    cgst_amount: o.cgst ?? 0, sgst_amount: o.sgst ?? 0, igst_amount: o.igst ?? 0, total_amount: o.taxable + (o.igst ?? 0) + (o.cgst ?? 0) + (o.sgst ?? 0), status,
    issued_at: issued ? '2026-10-20T10:00:00Z' : null, created_at: '2026-10-20T10:00:00Z', updated_at: '2026-10-20T10:00:00Z' })])
  await db.query(`insert into public.invoice_adjustment_note_lines (company_id, note_id, line_no, invoice_line_id, description, hsn_sac, taxable_amount, gst_rate, cgst_amount, sgst_amount,
    igst_amount, line_total) values ($1, $2, 1, $3, 'Rate correction', '6910', $4, 18, $5, $6, $7, $8)`, [A, id, inv.lid, o.taxable, o.cgst ?? 0, o.sgst ?? 0, o.igst ?? 0,
    o.taxable + (o.igst ?? 0) + (o.cgst ?? 0) + (o.sgst ?? 0)])
  return { id }
})
const GSTIN_B = '29AABCQ1234A1Z5'
const F = {}
F.b2b = await cloneInvoice('GSTD-001', 'ISSUED', { reg: 'REGISTERED', gstin: GSTIN_B, pos: '29', treatment: 'INTER_STATE', taxable: 1000, igst: 180 })
F.b2cl = await cloneInvoice('GSTD-002', 'ISSUED', { reg: 'UNREGISTERED', pos: '29', treatment: 'INTER_STATE', taxable: 200000, igst: 36000 })
F.b2cs = await cloneInvoice('GSTD-003', 'ISSUED', { reg: 'UNREGISTERED', pos: '27', treatment: 'INTRA_STATE', taxable: 500, cgst: 45, sgst: 45 })
F.exp = await cloneInvoice('GSTD-004', 'ISSUED', { reg: 'OVERSEAS', pos: '96', treatment: 'INTER_STATE', category: 'ZERO_RATED', taxable: 2000, rate: 0 })
F.nil = await cloneInvoice('GSTD-005', 'ISSUED', { reg: 'UNREGISTERED', pos: '27', treatment: 'INTRA_STATE', category: 'EXEMPT', taxable: 100, rate: 0 })
F.bad = await cloneInvoice('GSTD-006', 'ISSUED', { reg: 'REGISTERED', gstin: null, pos: null, treatment: 'INTRA_STATE', taxable: 100, igst: 18 }, { hsn: null })
F.draft = await cloneInvoice('GSTD-007', 'DRAFT', { reg: 'UNREGISTERED', pos: '27', treatment: 'INTRA_STATE', taxable: 999, cgst: 89.91, sgst: 89.91 })
F.cancelled = await cloneInvoice('GSTD-008', 'CANCELLED', { reg: 'UNREGISTERED', pos: '27', treatment: 'INTRA_STATE', taxable: 777, cgst: 69.93, sgst: 69.93 })
F.cn = await cloneNote('GSTD-CN-1', 'ISSUED', F.b2b, { treatment: 'INTER_STATE', taxable: 100, igst: 18 })
F.cnDraft = await cloneNote('GSTD-CN-2', 'DRAFT', F.b2cs, { treatment: 'INTRA_STATE', taxable: 50, cgst: 4.5, sgst: 4.5 })
const ret = (user, period, type) => as(user)(`select public.gst_return_get($1::uuid, $2)`, [period, type])
const num = (x) => Number(x ?? 0)

ok('return working needs gst.read (viewer allowed, sales refused); return type validated', !!(await ret('viewer', oct.id, 'GSTR1')).sections
  && await refused('sales', `select public.gst_return_get($1::uuid, 'GSTR1')`, [oct.id], /not allowed/)
  && await refused('acct', `select public.gst_return_get($1::uuid, 'GSTR9')`, [oct.id], /GSTR1 or GSTR3B/)
  && await refused('b_op', `select public.gst_return_get($1::uuid, 'GSTR1')`, [oct.id], /not found/))
const r1 = await ret('acct', oct.id, 'GSTR1')
const sec = (r, k) => r.sections[k].calculated
ok('GSTR-1 (live, CALCULATED): B2B, B2CL (above the approved 1,00,000 threshold), B2CS, export without payment, nil / exempt and CDNR — from stored totals only',
  r1.source === 'LIVE' && r1.value_status === 'CALCULATED' && r1.config_version_no === cfg1.version_no && num(r1.b2cl_invoice_threshold) === 100000
  && sec(r1, 'B2B').documents === 1 && num(sec(r1, 'B2B').taxable) === 1000 && num(sec(r1, 'B2B').igst) === 180
  && sec(r1, 'B2CL').documents === 1 && num(sec(r1, 'B2CL').igst) === 36000
  && sec(r1, 'B2CS').documents === 2 && num(sec(r1, 'B2CS').taxable) === 600 && num(sec(r1, 'B2CS').cgst) === 45
  && sec(r1, 'EXPWOP').documents === 1 && num(sec(r1, 'EXPWOP').taxable) === 2000 && sec(r1, 'NIL').documents === 1 && num(sec(r1, 'NIL').taxable) === 100
  && sec(r1, 'CDNR').documents === 1 && num(sec(r1, 'CDNR').taxable) === -100 && num(sec(r1, 'CDNR').igst) === -18
  && r1.sections.B2B.rows[0].number === 'GSTD-001' && r1.sections.B2B.rows[0].rates[0].rate === 18 && r1.sections.CDNR.rows[0].original_invoice === 'GSTD-001')
ok('drafts, pending and cancelled documents never enter the return (counted as excluded); the document summary counts the cancelled invoice',
  !JSON.stringify(r1.sections).includes('GSTD-007') && !JSON.stringify(r1.sections).includes('GSTD-008') && !JSON.stringify(r1.sections).includes('GSTD-CN-2')
  && r1.excluded.draft_or_pending >= 2 && r1.excluded.cancelled >= 1
  && r1.documents_issued.some((d) => d.nature === 'Invoices for outward supply' && d.total === 7 && d.cancelled === 1 && d.net_issued === 6)
  && r1.documents_issued.some((d) => d.nature === 'Credit notes' && d.total === 1))
ok('B2CS is aggregated by place of supply / rate; the HSN summary splits B2B and B2C and nets the credit note, with UQC from the configuration',
  r1.sections.B2CS.rows.some((x) => x.place_of_supply === '27' && x.supply_type === 'INTRA' && num(x.taxable) === 500)
  && r1.hsn.some((h) => h.hsn_sac === '6910' && h.b2b === true && h.uqc === 'PCS' && num(h.taxable) === 900)
  && r1.hsn.some((h) => h.hsn_sac === '(missing)'))
const ex = r1.exceptions
const hasEx = (code, doc) => ex.some((e) => e.code === code && (!doc || e.document_no === doc))
ok('exceptions: missing GSTIN, place of supply and HSN, invalid classification, export details, unposted / draft sources (warnings and errors listed, not hidden)',
  hasEx('MISSING_GSTIN', 'GSTD-006') && hasEx('MISSING_PLACE_OF_SUPPLY', 'GSTD-006') && hasEx('MISSING_HSN', 'GSTD-006') && hasEx('INVALID_CLASSIFICATION', 'GSTD-006')
  && hasEx('EXPORT_DETAILS_MISSING', 'GSTD-004') && hasEx('UNPOSTED_SOURCE', 'GSTD-001') && ex.some((e) => e.code === 'UNPOSTED_SOURCE' && e.document_no === '(draft)')
  && (await acct(`select public.gst_return_exceptions($1::uuid)`, [oct.id])).rows.length === ex.length)

// GSTR-3B with manual adjustments as a separate layer.
const adjD = await as('acct')(`select public.gst_return_adjustment('CREATE', null, $1::jsonb)`, [JSON.stringify({ period_id: oct.id, return_type: 'GSTR3B', section: '3.1(a)',
  field: 'taxable', tax_head: 'TAXABLE', amount: '500', reason: 'Advance received, tax paid on it in October' })])
const adjPending = await as('acct')(`select public.gst_return_adjustment('CREATE', null, $1::jsonb)`, [JSON.stringify({ period_id: oct.id, return_type: 'GSTR1', section: 'B2CS',
  field: 'taxable', tax_head: 'TAXABLE', amount: '10', reason: 'Pending review of a B2CS rounding entry' })])
const r3pre = await ret('acct', oct.id, 'GSTR3B')
await as('acct2')(`select public.gst_return_adjustment('APPROVE', $1::uuid, '{}'::jsonb)`, [adjD.id])
const r3 = await ret('acct', oct.id, 'GSTR3B')
const s31a = r3.sections['3.1(a)']
ok('GSTR-3B 3.1: (a) taxable net of the credit note, (b) zero rated, (c) nil / exempt; 3.2 inter-state supplies to unregistered persons by place of supply',
  num(s31a.calculated.taxable) === 201500 && num(s31a.calculated.igst) === 36180 && num(s31a.calculated.cgst) === 45
  && num(r3.sections['3.1(b)'].calculated.taxable) === 2000 && num(r3.sections['3.1(c)'].calculated.taxable) === 100
  && r3['3.2_inter_state_unregistered'].some((x) => x.place_of_supply === '29' && num(x.taxable) === 200000 && num(x.igst) === 36000))
ok('calculated and manually adjusted values are kept apart: a draft adjustment is listed but not applied; once approved the section is ADJUSTED',
  num(r3pre.sections['3.1(a)'].adjusted.taxable) === 201500 && r3pre.sections['3.1(a)'].adjustments[0].status === 'DRAFT' && r3pre.value_status === 'CALCULATED'
  && num(s31a.adjusted.taxable) === 202000 && num(s31a.calculated.taxable) === 201500 && s31a.value_status === 'ADJUSTED' && r3.value_status === 'ADJUSTED'
  && (await ret('acct', oct.id, 'GSTR1')).sections.B2CS.adjustments.some((a) => a.id === adjPending.id && a.status === 'DRAFT'))

// Reconciliation with the ledgers.
const inIgst = await accId('1522')
await acct(`select public.accounting_voucher_post($1::uuid)`, [(await acct(`select public.accounting_voucher_create($1::jsonb)`, [jv('2026-10-20', [{ account_id: inIgst, debit: '500' },
  { account_id: rent, credit: '500' }])])).id])
const recOct = await acct(`select public.gst_reconciliation_get($1::uuid)`, [oct.id])
const headOf = (r, h) => r.tax_heads.find((x) => x.head === h)
ok('ledger reconciliation (October): documents vs output / input ledgers per head; differences explained by vouchers without a GST document (manual journals, unposted invoices)',
  num(headOf(recOct, 'IGST').output_documents) === 36180 && num(headOf(recOct, 'IGST').output_ledger) === 200 && num(headOf(recOct, 'IGST').output_difference) === 200 - 36180
  && num(headOf(recOct, 'IGST').itc_ledger) === 500 && num(headOf(recOct, 'IGST').itc_documents) === 0
  && recOct.unexplained_vouchers.some((v) => v.rule_key === 'OUTPUT_IGST' && num(v.credit) === 200 && v.source === 'MANUAL')
  && recOct.unexplained_vouchers.some((v) => v.rule_key === 'INPUT_IGST' && num(v.debit) === 500))
const novPeriod = await rows(`select * from public.gst_return_periods where id = $1`, [nov.id])
const recNov = await acct(`select public.gst_reconciliation_get($1::uuid)`, [nov.id])
ok('ITC per the decision history equals the input-ledger movement of November for every head (availed, reversed decisions, reversals, reclaims, invoice reversals)',
  ['IGST', 'CGST', 'SGST', 'CESS'].every((h) => num(headOf(recNov, h).itc_difference) === 0) && num(headOf(recNov, 'CGST').itc_documents) !== 0 && novPeriod.length === 1)

// Approved periods are always shown from the snapshot.
const novR3 = await ret('acct', nov.id, 'GSTR3B')
const novLive3 = await val(`select private.gst_gstr3b(p) from public.gst_return_periods p where p.id = $1`, [nov.id])
ok('approved period (November): GSTR-3B comes from snapshot v2 (APPROVED), not recalculated; the live working differs (ITC decided since) and is flagged',
  novR3.source === 'SNAPSHOT' && novR3.value_status === 'APPROVED' && novR3.snapshot.version_no === 2 && novR3.live_differs === true
  && num(novR3.sections['4(A)(5)'].calculated.igst) !== num(novLive3.sections['4(A)(5)'].calculated.igst)
  && num(novR3.sections['3.1(a)'].adjusted.taxable) === num(novR3.sections['3.1(a)'].calculated.taxable) - 100
  && JSON.stringify(novR3.sections) === JSON.stringify(await val(`select s.data -> 'returns' -> 'GSTR3B' -> 'sections' from public.gst_period_snapshots s where s.id = $1`, [novR3.snapshot.id])))

// Registers, dashboard, payments.
const regS = await acct(`select public.gst_register('SALES', $1::jsonb)`, [JSON.stringify({ period_id: oct.id })])
const regP = await acct(`select public.gst_register('PURCHASE', $1::jsonb)`, [JSON.stringify({ period_id: nov.id })])
const regR = await acct(`select public.gst_register('RCM', $1::jsonb)`, [JSON.stringify({ from: fyStart, to: today })])
ok('registers: sales (issued only, signed totals), purchases (ITC net, stage, GSTR-2B evidence), RCM (reverse-charge invoices and their period)',
  regS.rows.length === 7 && !regS.rows.some((x) => ['GSTD-007', 'GSTD-008'].includes(x.number)) && num(regS.totals.taxable) === 1000 + 200000 + 500 + 2000 + 100 + 100 - 100
  && regP.rows.some((x) => x.id === G.g1.id && x.gstr2b === 'APPROVED' && x.gst_status === 'ELIGIBLE' && num(x.itc_eligible) === 180)
  && regR.rows.length > 0 && regR.rows.every((x) => x.reverse_charge === true)
  && await refused('acct', `select public.gst_register('SALES', '{}'::jsonb)`, null, /period or a date range/))
const gstDash = await acct(`select public.gst_dashboard()`)
const pays = await acct(`select public.gst_payments_view('{}'::jsonb)`)
ok('dashboard (periods with open liability, credit, set-off and filing status) and payment / challan views', gstDash.registration.gstin === companyGstin
  && gstDash.periods.some((x) => x.period_code === nov.period_code && x.snapshot_version === 2) && typeof gstDash.itc_pending === 'number'
  && pays.challans.some((c) => c.cpin === '26112700000001' && c.payments.length === 2) && pays.set_offs.some((s) => s.period_code === nov.period_code && s.status === 'POSTED'))

// Historical vs current credit (October, November, December) with subsequent utilisation and reversal.
const pos = async (period) => (await acct(`select public.gst_liability_summary($1::uuid)`, [period])).credit_detail.IGST
const novSnapHash = await val(`select snapshot_hash || md5(data::text) from public.gst_period_snapshots where id = $1`, [novR3.snapshot.id])
const oct0 = await pos(oct.id)
const nov0 = await pos(nov.id)
ok('historical credit: October shows 500 accrued by 31 October and fully available then, although November\'s set-off (posted earlier) used IGST since',
  num(oct0.accrued_to_period_end) === 500 && num(oct0.used_to_period) === 0 && num(oct0.available_at_period_end) === 500 && num(oct0.used_in_posted_set_offs) === igstCredit
  && num(nov0.used_to_period) === igstCredit && num(nov0.current_available) === num(nov0.ledger_balance))
const soO = await setOff('acct', 'SAVE', null, { period_id: oct.id, lines: [line('OUTPUT', 'IGST', 'CREDIT', 'IGST', '150')] })
await setOff('acct2', 'POST', soO.id)
const oct1 = await pos(oct.id); const nov1 = await pos(nov.id); const dec1 = await pos(dec.id)
ok('an October set-off of 150: October historical 350, November and December positions include it (used through those periods); the current ledger drops by 150',
  num(oct1.available_at_period_end) === 350 && num(nov1.used_to_period) === igstCredit + 150 && num(dec1.used_to_period) === igstCredit + 150
  && num(nov1.ledger_balance) === num(nov0.ledger_balance) - 150 && num(oct1.available) <= num(oct1.ledger_balance))
const laterIds = (await rows(`select id::text from public.gst_return_periods where registration_id = $1 and period_start >= $2::date order by period_start`, [gstReg.id, oct.period_start])).map((r) => r.id)
const headroom = Math.min(...(await Promise.all(laterIds.map(pos))).map((x) => num(x.accrued_to_period_end) - num(x.used_to_period)))
ok(`cumulative utilisation never exceeds accrual at any later period end (${laterIds.length} periods): October's headroom and availability follow the formula`,
  laterIds.length >= 4 && num(oct1.cumulative_headroom) === Math.max(0, headroom)
  && num(oct1.available) === Math.max(0, Math.min(num(oct1.available_at_period_end), num(oct1.cumulative_headroom), num(oct1.ledger_balance))))
await setOff('acct2', 'REVERSE', soO.id, { reason: 'October set-off entered in error' })
const oct2 = await pos(oct.id); const nov2 = await pos(nov.id)
ok('the reversed set-off is excluded again (October 500, November back); the approved November snapshot is byte-for-byte unchanged throughout',
  num(oct2.available_at_period_end) === 500 && num(nov2.used_to_period) === igstCredit && num(nov2.ledger_balance) === num(nov0.ledger_balance)
  && await val(`select snapshot_hash || md5(data::text) from public.gst_period_snapshots where id = $1`, [novR3.snapshot.id]) === novSnapHash
  && JSON.stringify((await ret('acct', nov.id, 'GSTR3B')).credit) === JSON.stringify(novR3.credit))

// Match tolerance: validated, versioned, shown on every match.
ok('match tolerance: configuration key validated (0–100, 2 decimals); every GSTR-2B match records the configuration version whose tolerance it applied',
  (await cfgSave('acct', '2027-06-01', cfgPayload({ gstr2b_match_tolerance: 150 }))).validation_errors.some((e) => /gstr2b_match_tolerance/.test(e))
  && (await cfgSave('acct', '2027-06-01', cfgPayload({ gstr2b_match_tolerance: 0.555 }))).validation_errors.some((e) => /gstr2b_match_tolerance/.test(e))
  && (await cfgSave('acct', '2027-06-01', cfgPayload({ gstr2b_match_tolerance: 0.25 }))).validation_errors.length === 0
  && await (async () => { const m = await acct(`select public.gst_2b_match_get($1::uuid)`, [(await matchOf('S2B-002')).id])
       return num(m.tolerance) === 1 && m.config_version_no === cfg1.version_no && m.config_version_id === cfg1.id && m.outcome === 'EXACT' })()
  && await val(`select count(*)::int from public.gst_2b_matches where company_id = $1 and config_version_id is null`, [A]) === 0)

// Approval stores the return working in the snapshot; later documents never change it.
await as('acct2')(`select public.gst_return_adjustment('REJECT', $1::uuid, '{"reason": "not needed"}'::jsonb)`, [adjPending.id])
await tr('acct', oct.id, 'START_REVIEW'); await tr('acct', oct.id, 'READY')
const octA = await tr('acct2', oct.id, 'APPROVE')
const octR1 = await ret('acct', oct.id, 'GSTR1')
await cloneInvoice('GSTD-009', 'ISSUED', { reg: 'REGISTERED', gstin: GSTIN_B, pos: '29', treatment: 'INTER_STATE', taxable: 3000, igst: 540 })
const octR1b = await ret('acct', oct.id, 'GSTR1')
ok('approving October stores GSTR-1 and GSTR-3B in snapshot v1; a late October invoice changes only the live working (flagged), never the approved values',
  octA.status === 'APPROVED' && octR1.source === 'SNAPSHOT' && octR1.value_status === 'APPROVED' && octR1.snapshot.has_return_working === true
  && octR1b.sections.B2B.calculated.documents === 1 && octR1b.live_differs === true
  && num((await ret('acct', oct.id, 'GSTR3B')).sections['3.1(a)'].adjusted.taxable) === 202000)

// Filing records: manual, after filing on the portal.
const fileRec = (user, body) => as(user)(`select public.gst_return_filing('RECORD', null, $1::jsonb)`, [JSON.stringify(body)])
ok('filing record: gst_returns.approve, an approved period with the working in its snapshot, a 15-character ARN and a date within the period → today',
  await refused('viewer', `select public.gst_return_filing('RECORD', null, $1::jsonb)`, [JSON.stringify({ period_id: oct.id, return_type: 'GSTR3B', arn: 'AA2710261234567', filed_on: today })], /not allowed/)
  && await refused('acct2', `select public.gst_return_filing('RECORD', null, $1::jsonb)`, [JSON.stringify({ period_id: oct.id, return_type: 'GSTR3B', arn: 'BAD', filed_on: today })], /ARN/)
  && await refused('acct2', `select public.gst_return_filing('RECORD', null, $1::jsonb)`, [JSON.stringify({ period_id: oct.id, return_type: 'GSTR3B', arn: 'AA2710261234567', filed_on: '2099-01-01' })], /filing date/)
  && await refused('acct2', `select public.gst_return_filing('RECORD', null, $1::jsonb)`, [JSON.stringify({ period_id: dec.id, return_type: 'GSTR3B', arn: 'AA2710261234567', filed_on: today })], /approved or closed/))
const filed = await fileRec('acct2', { period_id: oct.id, return_type: 'GSTR3B', arn: 'aa2710261234567', filed_on: today, note: 'Filed on the GST portal' })
const octFiled = await ret('acct', oct.id, 'GSTR3B')
ok('recorded: the GSTR-3B shows FILED with the ARN; GSTR-1 stays APPROVED; a second record or the same ARN is refused; a filed period cannot be reopened',
  filed.arn === 'AA2710261234567' && /does not file returns/.test(filed.note_on_filing) && octFiled.value_status === 'FILED' && octFiled.filing.arn === 'AA2710261234567'
  && (await ret('acct', oct.id, 'GSTR1')).value_status === 'APPROVED'
  && await refused('acct2', `select public.gst_return_filing('RECORD', null, $1::jsonb)`, [JSON.stringify({ period_id: oct.id, return_type: 'GSTR3B', arn: 'AA2710269999999', filed_on: today })], /already recorded/)
  && await refused('acct2', `select public.gst_return_filing('RECORD', null, $1::jsonb)`, [JSON.stringify({ period_id: oct.id, return_type: 'GSTR1', arn: 'AA2710261234567', filed_on: today })], /already recorded/)
  && await refused('op', `select public.gst_period_transition($1::uuid, 'REOPEN', 'need to change the return')`, [oct.id], /recorded as filed/))
ok('filing records are permanent: a wrong one is voided with a reason (then the period shows APPROVED again); never edited or deleted',
  await ownerRefused(`update public.gst_return_filings set arn = 'X' where id = '${filed.id}'`, /cannot be changed/)
  && await ownerRefused(`delete from public.gst_return_filings where id = '${filed.id}'`, /permanent/)
  && await refused('acct2', `select public.gst_return_filing('VOID', $1::uuid, '{"reason": "short"}'::jsonb)`, [filed.id], /at least 10/)
  && (await as('acct2')(`select public.gst_return_filing('VOID', $1::uuid, '{"reason": "ARN belonged to another GSTIN"}'::jsonb)`, [filed.id])).status === 'VOIDED'
  && (await ret('acct', oct.id, 'GSTR3B')).value_status === 'APPROVED'
  && (await fileRec('acct2', { period_id: oct.id, return_type: 'GSTR3B', arn: 'AA2710261234568', filed_on: today })).status === 'RECORDED')
ok('no vouchers are posted by return preparation or filing records', await val(`select count(*)::int from public.accounting_vouchers where source_type like 'GST_RETURN%'`) === 0)

ok('Gate D read-only RPCs run inside a READ ONLY transaction', await (async () => {
  await db.exec('reset role'); await db.exec('begin read only')
  try {
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: await val(`select rls_test.id('acct')::text`), role: 'authenticated' })])
    await db.exec('reset role'); await db.exec('set local role authenticated')
    for (const q of [`select public.gst_return_get('${oct.id}'::uuid, 'GSTR1')`, `select public.gst_return_get('${dec.id}'::uuid, 'GSTR3B')`,
      `select public.gst_register('SALES', '{"period_id": "${oct.id}"}'::jsonb)`, `select public.gst_register('PURCHASE', '{"period_id": "${nov.id}"}'::jsonb)`,
      `select public.gst_reconciliation_get('${nov.id}'::uuid)`, `select public.gst_return_exceptions('${dec.id}'::uuid)`, `select public.gst_dashboard()`,
      `select public.gst_payments_view('{}'::jsonb)`]) await db.query(q)
    await db.exec('rollback'); return true
  } catch (e) { await db.exec('rollback').catch(() => {}); console.log('      got:', e.message); return false }
})())
ok('Gate D rollback is refused while filing records exist', await ownerRefused(await read(path.join(rbDir, `${GR}_down.sql`)), /filing records/))

console.log('\nU. GST period close, control reports and integrity (Phase 5, Gate E)')
const DISCLAIMER = 'Prepared by Alton ERP for review and working purposes. This document is not proof of filing with the GST Portal. The taxpayer must independently verify and file the return on the official GST Portal.'
const ready = (user, period) => as(user)(`select public.gst_period_readiness($1::uuid)`, [period])
const report = (user, name, filters) => as(user)(`select public.gst_control_report($1, $2::jsonb)`, [name, JSON.stringify(filters)])
const ctlOf = (rd, code) => rd.controls.find((c) => c.code === code)
const integrity = () => val(`select md5(concat_ws('|',
  (select count(*) || ':' || coalesce(md5(string_agg(id::text || status || coalesce(voucher_number, ''), ',' order by id)), '') from public.accounting_vouchers where company_id = $1),
  (select count(*) || ':' || coalesce(md5(string_agg(id::text || stage, ',' order by id)), '') from public.gst_itc_decisions where company_id = $1),
  (select count(*) || ':' || coalesce(md5(string_agg(snapshot_hash || md5(data::text), ',' order by id)), '') from public.gst_period_snapshots where company_id = $1),
  (select count(*) || ':' || coalesce(md5(string_agg(id::text || status, ',' order by id)), '') from public.gst_return_filings where company_id = $1),
  (select count(*) || ':' || coalesce(md5(string_agg(id::text || status || row_version, ',' order by id)), '') from public.gst_2b_matches where company_id = $1),
  (select count(*) || ':' || coalesce(md5(string_agg(id::text || status || row_version, ',' order by id)), '') from public.gst_set_offs where company_id = $1),
  (select count(*) || ':' || coalesce(md5(string_agg(id::text || status || row_version, ',' order by id)), '') from public.gst_return_periods where company_id = $1),
  (select count(*) || ':' || coalesce(md5(string_agg(id::text || gst_status || row_version, ',' order by id)), '') from public.purchase_invoices where company_id = $1),
  (select count(*) from public.gst_period_events where company_id = $1)))`, [A])

// 1. Readiness: blockers and warnings, never a warning treated as passed.
const rdOct = await ready('viewer', oct.id)
const rdNov = await ready('acct', nov.id)
ok('readiness lists mandatory blockers and warnings separately; open warnings are not passed; October (filed) can close, November is blocked by unapproved GSTR-2B matches',
  rdOct.lifecycle.label === 'FILED' && rdOct.controls.filter((c) => c.severity === 'BLOCKER').length === 8 && rdOct.controls.filter((c) => c.severity === 'WARNING').length === 8
  && rdOct.blockers_failed === 0 && rdOct.can_close === true && ctlOf(rdOct, 'SOURCE_ERRORS').count > 0 && ctlOf(rdOct, 'SOURCE_ERRORS').passed === false
  && ctlOf(rdOct, 'LIVE_DIFFERS').passed === false && ctlOf(rdOct, 'UNEXPLAINED_VOUCHERS').passed === false && rdOct.warnings_open > 0
  && ctlOf(rdNov, 'GSTR2B_UNAPPROVED_MATCHES').count >= 2 && rdNov.can_close === false
  && await refused('sales', `select public.gst_period_readiness($1::uuid)`, [oct.id], /not allowed/) && await refused('b_op', `select public.gst_period_readiness($1::uuid)`, [oct.id], /not found/))

// 2. Close: blockers enforced in the database, warnings acknowledged with a reason, maker-checker, permission.
const draftOct = await setOff('acct', 'SAVE', null, { period_id: oct.id, lines: [line('OUTPUT', 'CGST', 'CASH', 'CGST', '1', 'TAX')] })
ok('close is refused while a blocker fails (a draft set-off of the period), even with a reason', ctlOf(await ready('acct', oct.id), 'SET_OFF_DRAFT').passed === false
  && await refused('acct2', `select public.gst_period_transition($1::uuid, 'CLOSE', 'All warnings reviewed by the checker')`, [oct.id], /Close controls not passed: Set-off drafts/))
await setOff('acct', 'CANCEL', draftOct.id, { reason: 'not needed' })
ok('…and with open warnings a close needs an acknowledgement reason; not by the preparer; not without gst_periods.close',
  await refused('acct2', `select public.gst_period_transition($1::uuid, 'CLOSE', null)`, [oct.id], /Open warnings must be acknowledged before closing: source errors/)
  && await refused('acct', `select public.gst_period_transition($1::uuid, 'CLOSE', 'All warnings reviewed by the checker')`, [oct.id], /Maker-checker/)
  && await refused('viewer', `select public.gst_period_transition($1::uuid, 'CLOSE', 'All warnings reviewed by the checker')`, [oct.id], /not allowed/))
const beforeClose = await integrity()
const octClosed = await tr('acct2', oct.id, 'CLOSE', 'Warnings reviewed: late invoice GSTD-009 goes to the next return')
const closeEv = octClosed.events.filter((e) => e.action === 'CLOSED').at(-1)
const closeDetails = await val(`select details from public.gst_period_events where period_id = $1 and action = 'CLOSED' order by created_at desc limit 1`, [oct.id])
ok('closed: the CLOSED event records the reason, previous / new status, every control and the acknowledged warnings (audit log too)', octClosed.status === 'CLOSED'
  && closeEv.from === 'APPROVED' && closeEv.to === 'CLOSED' && /late invoice GSTD-009/.test(closeEv.reason) && closeDetails.close_controls.length === 16
  && /source errors/.test(closeDetails.warnings_acknowledged)
  && await val(`select count(*)::int from public.audit_logs where company_id = $1 and action = 'gst.period_closed' and resource_id = $2`, [A, oct.id]) === 1)
ok('November cannot close while its GSTR-2B matches await approval (database-enforced)', await refused('acct2', `select public.gst_period_transition($1::uuid, 'CLOSE', 'All warnings reviewed by the checker')`,
  [nov.id], /GSTR-2B matches of the period awaiting approval/))
const octR3closed = await ret('acct', oct.id, 'GSTR3B')
ok('a closed, filed period still shows its snapshot (FILED), is never recalculated, and cannot be reopened', octR3closed.source === 'SNAPSHOT' && octR3closed.value_status === 'FILED'
  && octR3closed.period_status === 'CLOSED' && num(octR3closed.sections['3.1(a)'].adjusted.taxable) === 202000
  && await refused('op', `select public.gst_period_transition($1::uuid, 'REOPEN', 'need to change the return')`, [oct.id], /recorded as filed/)
  && await refused('acct2', `select public.gst_period_transition($1::uuid, 'REOPEN', 'need to change the return')`, [oct.id], /not allowed/))

// 3. The ten reports.
const tl = await report('acct', 'TAX_LIABILITY', { period_id: oct.id })
const tlRow = (h) => tl.rows.find((r) => r.head === h)
ok('report header: company, GSTIN, financial year, period, generation time, configuration version, snapshot reference, value status and the exact disclaimer',
  tl.company.legal_name.length > 0 && tl.gstin === companyGstin && tl.financial_year === '2026-27' && tl.period_code === oct.period_code && !!tl.generated_at
  && tl.config_version_no === cfg1.version_no && /^[0-9a-f]{64}$/.test(tl.snapshot.snapshot_hash) && tl.value_status === 'FILED' && tl.disclaimer === DISCLAIMER)
ok('1 tax liability: documents = GSTR-1 = GSTR-3B (live); output ledger difference shown; the approved snapshot differs by the late invoice; the approved adjustment is separate',
  num(tlRow('IGST').documents) === 36720 && num(tlRow('IGST').gstr1_calculated) === 36720 && num(tlRow('IGST').gstr3b_calculated) === 36720
  && num(tlRow('IGST').ledger) === 200 && num(tlRow('IGST').ledger_minus_documents) === 200 - 36720 && num(tlRow('IGST').snapshot_gstr3b) === 36180
  && num(tlRow('IGST').snapshot_minus_live_gstr3b) === -540 && num(tlRow('TAXABLE').approved_adjustments_gstr3b) === 500 && num(tlRow('TAXABLE').gstr3b_minus_gstr1) === 0
  && tl.unexplained_vouchers.some((v) => v.rule_key === 'OUTPUT_IGST'))
const itcR = await report('acct', 'ITC', { period_id: nov.id })
ok('2 ITC: per head decisions = input ledger; GSTR-3B 4A / 4B / net; invoices by status (pending, proposed, eligible, partial, ineligible); pending and ineligible ledgers',
  itcR.heads.every((x) => num(x.difference) === 0) && itcR.heads.some((x) => num(x.itc_per_decisions) !== 0)
  && itcR.invoices_by_status.some((x) => x.status === 'ELIGIBLE') && itcR.invoices_by_status.some((x) => x.status === 'PENDING_VERIFICATION')
  && itcR.events.some((x) => x.event === 'AVAILED') && typeof itcR.pending_verification_ledger.closing === 'number' && /never creates a decision/.test(itcR.note))
const b2N = await report('acct', 'GSTR2B', { period_id: nov.id })
const b2D = await report('acct', 'GSTR2B', { period_id: dec.id })
const b2doc = (r, n) => r.documents.find((d) => d.doc_number === n)
ok('3 GSTR-2B: exact / partial / non-exact / unapproved / missing in books / supplier notes; every match shows the tolerance and configuration version it applied; only EXACT is labelled exact',
  b2doc(b2N, 'S2B-001').category === 'EXACT' && b2doc(b2N, 'S2B-001').exact === true && b2doc(b2N, 'S2B-005X').category === 'NON_EXACT' && b2doc(b2N, 'S2B-005X').exact === false
  && b2doc(b2N, 'S2B-003').category === 'UNAPPROVED' && b2doc(b2N, 'NOT-IN-BOOKS-1').category === 'MISSING_IN_BOOKS' && b2doc(b2N, 'CN-1').category === 'SUPPLIER_NOTE'
  && b2N.documents.filter((d) => d.match_id).every((d) => num(d.tolerance) === 1 && d.config_version_no === cfg1.version_no)
  && b2N.documents.every((d) => d.exact === (d.outcome === 'EXACT') || !d.match_id) && b2N.reversed_matches.some((m) => m.doc_number === 'S2B-007')
  && b2D.amendments.some((a) => a.doc_number === 'S2B-002') && b2D.duplicates.some((d) => d.kind === 'DUPLICATE_OF_EARLIER') && b2D.reversed_matches.some((m) => /re-match/.test(m.reason ?? ''))
  && b2N.summary.MISSING_IN_BOOKS >= 1 && typeof b2N.summary.missing_in_2b === 'number')
const rcmR = await report('acct', 'RCM', { from: fyStart, to: today })
ok('4 reverse charge: RCM invoices and tax heads agree with the RCM payable ledger credited in the range (difference 0); set-offs listed', rcmR.invoices.length > 0
  && num(rcmR.difference) === 0 && num(rcmR.totals.tax) > 0 && /not supported/.test(rcmR.note))
const cashR = await report('acct', 'CASH_LEDGER', { from: fyStart, to: today })
ok('5 GST cash ledger: failed attempts listed but never counted; counted payments = cash-ledger deposits; bank account masked; needs a GST payments permission',
  cashR.payments.some((x) => x.payment_status === 'FAILED' && x.counted === false && x.flag === 'NOT_A_PAYMENT')
  && cashR.payments.some((x) => x.cpin === '26112700000001' && x.counted === true && num(x.bank_amount) === 1020)
  && num(cashR.deposits_difference) === 0 && cashR.payments.filter((x) => x.bank_account).every((x) => /^X+[0-9A-Z]{1,4}$/.test(x.bank_account.number))
  && await refused('viewer', `select public.gst_control_report('CASH_LEDGER', $1::jsonb)`, [JSON.stringify({ from: fyStart, to: today })], /gst_payments/)
  && await refused('admin', `select public.gst_control_report('CASH_LEDGER', $1::jsonb)`, [JSON.stringify({ from: fyStart, to: today })], /gst_payments/))
const crO = await report('acct', 'CREDIT_LEDGER', { period_id: oct.id })
const crN = await report('acct', 'CREDIT_LEDGER', { period_id: nov.id })
const crRow = (r, h) => r.rows.find((x) => x.head === h)
ok('6 GST credit ledger: opening + accrual − utilisation = closing historical = the period-end position; November opens with October\'s closing; current credit apart',
  num(crRow(crO, 'IGST').accrual_ledger) === 500 && num(crRow(crO, 'IGST').closing_historical) === 500 && num(crRow(crO, 'IGST').position.available_at_period_end) === 500
  && num(crRow(crO, 'IGST').other_movements) === 500 && num(crRow(crN, 'IGST').opening_historical) === num(crRow(crO, 'IGST').closing_historical)
  && crN.rows.every((x) => num(x.closing_historical) === num(x.position.accrued_to_period_end) - num(x.position.used_to_period))
  && num(crRow(crN, 'IGST').current_available) === num(crRow(crN, 'IGST').position.ledger_balance))
const vOct = await report('acct', 'VOUCHERS', { period_id: oct.id })
const vNov = await report('acct', 'VOUCHERS', { period_id: nov.id })
ok('7 GST vouchers: sources and documents, unexplained manual journals, reversals with their originals, documents without a voucher; no duplicate source postings',
  vOct.vouchers.some((x) => x.flags.includes('UNEXPLAINED') && x.source === 'MANUAL' && 'INPUT_IGST' in x.gst_amounts)
  && vOct.documents_without_voucher.some((d) => d.number === 'GSTD-001')
  && vNov.vouchers.some((x) => x.source_type === 'GST_SET_OFF' && x.flags.includes('REVERSAL') && !!x.reversal_of)
  && vNov.vouchers.some((x) => x.source_type === 'PURCHASE_INVOICE_GST' && !!x.source_document)
  && vNov.vouchers.some((x) => x.source_type === 'GST_CHALLAN_PAYMENT' && x.source_document === '26112700000001')
  && !vNov.vouchers.some((x) => x.flags.includes('DUPLICATE_SOURCE')) && /never creates or posts/.test(vNov.note))
const compN = await report('acct', 'COMPLETENESS', { period_id: nov.id })
const compO = await report('acct', 'COMPLETENESS', { period_id: oct.id })
ok('8 completeness: GSTIN / place of supply / HSN / classification / export details / unposted sources, unresolved supplier notes, ITC pending and ITC without evidence',
  ['MISSING_GSTIN', 'MISSING_PLACE_OF_SUPPLY', 'MISSING_HSN', 'INVALID_CLASSIFICATION', 'EXPORT_DETAILS_MISSING', 'UNPOSTED_SOURCE'].every((c) => compO.rows.some((x) => x.code === c))
  && compN.rows.some((x) => x.code === 'SUPPLIER_NOTE_UNRESOLVED' && x.document_no === 'CN-1') && compN.rows.some((x) => x.code === 'ITC_PENDING')
  && compN.rows.some((x) => x.code === 'ITC_WITHOUT_GSTR2B') && compN.summary.length > 0)
const v13 = await report('acct', 'GSTR1_VS_GSTR3B', { period_id: oct.id })
const vrow = (line, head) => v13.rows.find((x) => x.line.startsWith(line) && x.head === head)
ok('9 GSTR-1 vs GSTR-3B: calculated values agree for every line and head; the approved 3B adjustment and the late invoice are explained, never forced',
  v13.rows.length === 15 && v13.rows.every((x) => num(x.difference_calculated) === 0)
  && num(vrow('Outward', 'TAXABLE').difference_adjusted) === 500 && /Approved GSTR-3B adjustments 500/.test(vrow('Outward', 'TAXABLE').explanation)
  && /late documents/.test(vrow('Outward', 'IGST').explanation) && num(vrow('Zero', 'TAXABLE').gstr1_calculated) === 2000)
const aud = await report('acct', 'PERIOD_AUDIT', { period_id: oct.id })
ok('10 period close and audit: status, registration, snapshot hashes, history (approve / close with reason), adjustments, filing records (voided too), set-offs, controls, exceptions, late documents',
  aud.lifecycle.label === 'FILED' && aud.registration.gstin === companyGstin && aud.snapshots.length === 1 && aud.snapshots[0].snapshot_hash === octR3closed.snapshot.snapshot_hash
  && aud.snapshots[0].current === true && aud.history.some((e) => e.action === 'APPROVED') && aud.history.some((e) => e.action === 'CLOSED' && /GSTD-009/.test(e.reason))
  && aud.adjustments.length >= 2 && aud.filing_records.some((f) => f.status === 'VOIDED') && aud.filing_records.some((f) => f.status === 'RECORDED')
  && aud.set_offs.some((s) => s.status === 'REVERSED') && aud.close_controls.length === 16 && aud.exceptions_summary.length > 0
  && aud.late_documents.gstr1_live_differs === true && Array.isArray(aud.payment_of_tax))
ok('date-range filtering: a range gives live CALCULATED values without snapshots; the audit report needs a period; unknown reports / bad ranges refused; company isolation',
  await (async () => { const r = await report('acct', 'TAX_LIABILITY', { from: oct.period_start, to: oct.period_end })
    return r.value_status === 'CALCULATED' && r.snapshot === null && num(r.rows.find((x) => x.head === 'IGST').documents) === 36720 })()
  && await refused('acct', `select public.gst_control_report('PERIOD_AUDIT', $1::jsonb)`, [JSON.stringify({ from: fyStart, to: today })], /needs a return period/)
  && await refused('acct', `select public.gst_control_report('GSTR9', '{}'::jsonb)`, null, /Unknown GST report/)
  && await refused('acct', `select public.gst_control_report('ITC', $1::jsonb)`, [JSON.stringify({ from: today, to: fyStart })], /period or a date range/)
  && await refused('b_op', `select public.gst_control_report('ITC', $1::jsonb)`, [JSON.stringify({ period_id: nov.id })], /not found|registration first/)
  && await refused('sales', `select public.gst_control_report('ITC', $1::jsonb)`, [JSON.stringify({ period_id: nov.id })], /not allowed/))

// 4. Integrity: nothing is mutated by readiness, reports or return views; GSTR-2B never decides ITC.
const fp0 = await integrity()
for (const name of ['TAX_LIABILITY', 'ITC', 'GSTR2B', 'RCM', 'CASH_LEDGER', 'CREDIT_LEDGER', 'VOUCHERS', 'COMPLETENESS', 'GSTR1_VS_GSTR3B', 'PERIOD_AUDIT']) {
  await report('acct', name, { period_id: oct.id }); await report('acct', name, { period_id: nov.id })
}
await ready('acct', nov.id); await ret('acct', oct.id, 'GSTR1'); await ret('acct', nov.id, 'GSTR3B')
ok('no report, readiness check or return view changes any record (vouchers, ITC decisions, snapshots, filings, matches, set-offs, periods, invoices, events)',
  await integrity() === fp0 && fp0 !== beforeClose)
ok('a GSTR-2B match never makes ITC eligible or creates a decision: the invoice with an approved (number-mismatch) match is still pending with no decision',
  await val(`select gst_status from public.purchase_invoices where id = $1`, [G.g5.id]) === 'PENDING_VERIFICATION'
  && await val(`select count(*)::int from public.gst_itc_decisions where purchase_invoice_id = $1`, [G.g5.id]) === 0
  && (await acct(`select public.gst_itc_get($1::uuid)`, [G.g5.id])).gstr2b.match_status === 'APPROVED')
ok('approved snapshots stay immutable for everyone (update / delete refused), and the current-snapshot pointer moves only through approval',
  await ownerRefused(`update public.gst_period_snapshots set data = data || '{"x": 1}' where period_id = '${oct.id}'`, /permanent GST history/)
  && await ownerRefused(`delete from public.gst_period_snapshots where period_id = '${oct.id}'`, /permanent GST history|violates/)
  && await refused('acct', `update public.gst_period_current_snapshot set set_at = now()`, null, /permission denied/))
ok('Gate E reports run inside a READ ONLY transaction', await (async () => {
  await db.exec('reset role'); await db.exec('begin read only')
  try {
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: await val(`select rls_test.id('acct')::text`), role: 'authenticated' })])
    await db.exec('reset role'); await db.exec('set local role authenticated')
    await db.query(`select public.gst_period_readiness('${nov.id}'::uuid)`)
    for (const name of ['TAX_LIABILITY', 'ITC', 'GSTR2B', 'RCM', 'CASH_LEDGER', 'CREDIT_LEDGER', 'VOUCHERS', 'COMPLETENESS', 'GSTR1_VS_GSTR3B', 'PERIOD_AUDIT']) {
      await db.query(`select public.gst_control_report('${name}', '{"period_id": "${dec.id}"}'::jsonb)`)
    }
    await db.exec('rollback'); return true
  } catch (e) { await db.exec('rollback').catch(() => {}); console.log('      got:', e.message); return false }
})())

console.log('\nL. Reset registries')
ok('standard reset: 47 accounting record tables resettable (Phase 2 allocations and budgets, Phase 3 supplier invoices, Phase 4 bank and cash records, Phase 5 GST, GSTR-2B and filing records), 8 configuration tables kept; every public table classified',
  await val(`select count(*)::int from private.erp_reset_tables() where category = 'Accounting'`) === 47
  && await val(`select count(*)::int from private.erp_reset_kept_tables() where table_name like 'account%'`) === 8
  && await val(`select count(*)::int from private.erp_reset_tables()`) === 191
  && await val(`select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r'
      and (c.relname like 'accounting%' or c.relname in ('accounts', 'account_groups'))
      and c.relname not in (select table_name from private.erp_reset_tables()) and c.relname not in (select table_name from private.erp_reset_kept_tables())`) === 0)
ok('standard reset stops while vouchers exist (delete guards on vouchers, lines and allocations); posted vouchers protected',
  await val(`select count(*)::int from private.erp_reset_guarded_tables() where table_name in ('accounting_vouchers', 'accounting_voucher_lines', 'accounting_cost_allocations')`) === 3)
ok('force reset: GSTR-2B tables purged children first (history / grants → matches → versions → rows / documents → imports); original files included in the storage cleanup',
  await val(`with o as (select table_name, ord from private.erp_force_reset_order())
     select (select ord from o where table_name = 'gst_2b_match_history') < (select ord from o where table_name = 'gst_2b_matches')
        and (select ord from o where table_name = 'gst_2b_matches') < (select ord from o where table_name = 'gst_2b_document_versions')
        and (select ord from o where table_name = 'gst_2b_document_versions') < (select ord from o where table_name = 'gst_2b_lines')
        and (select ord from o where table_name = 'gst_2b_lines') < (select ord from o where table_name = 'gst_2b_imports')
        and (select ord from o where table_name = 'gst_2b_matches') < (select ord from o where table_name = 'purchase_invoices')`)
  && await val(`select count(*)::int from private.erp_force_reset_storage_objects($1::uuid) where bucket = 'gst-files'`, [A]) >= 3)
ok('force reset purges all 17 accounting tables, in a cycle-free order (children before parents)',
  await val(`select count(*)::int from private.erp_force_reset_tables() where table_name like 'account%'`) === 17
  && await val(`select bool_and(o.ord < 100) from private.erp_force_reset_order() o where o.table_name like 'account%'`)
  && await val(`with o as (select table_name, ord from private.erp_force_reset_order())
     select (select ord from o where table_name = 'accounting_voucher_lines') < (select ord from o where table_name = 'accounting_vouchers')
        and (select ord from o where table_name = 'accounting_voucher_lines') < (select ord from o where table_name = 'accounts')
        and (select ord from o where table_name = 'accounts') < (select ord from o where table_name = 'account_groups')
        and (select ord from o where table_name = 'accounting_posting_events') < (select ord from o where table_name = 'accounting_vouchers')`))
ok('the force-purge exemption is the only way a posted voucher can be deleted', await ownerRefused(`select set_config('app.erp_force_purge', gen_random_uuid()::text, true);
  delete from public.accounting_vouchers where company_id = '${A}'`, /never deleted/))

// ---- true concurrency (real PostgreSQL only) ---------------------------------------------------------------------
if (PG_URL) {
  console.log('\nM. Concurrency (two connections, real PostgreSQL)')
  const c2 = await openDb()
  const conn2 = c2.db
  const draft = async () => (await acct(`select public.accounting_voucher_create($1::jsonb)`, [jv(today, [{ account_id: rent, debit: 7 }, { account_id: bank, credit: 7 }])])).id
  const seqNow = () => val(`select last_number from public.accounting_voucher_sequences s join public.accounting_voucher_types t on t.id = s.voucher_type_id
    where s.company_id = $1 and t.type_code = 'JV' and s.financial_year = $2`, [A, fyLabel])
  // 1. Same draft posted from two sessions at once: the second waits on the row lock, then is refused.
  const v1 = await draft()
  const seq1 = Number(await seqNow())
  const first = await requestOn(db, 'acct', `select public.accounting_voucher_post($1::uuid)`, [v1], { commit: false })
  let secondDone = false
  const second = requestOn(conn2, 'acct2', `select public.accounting_voucher_post($1::uuid)`, [v1]).then((r) => { secondDone = true; return r })
  await new Promise((r) => setTimeout(r, 400))
  ok('concurrent post of one voucher: the second session waits on the lock', !first.error && secondDone === false, first)
  await db.exec('commit')
  const sr = await second
  ok('…and is refused once the first commits (no duplicate posting, one number used)', /already posted/.test(sr.error ?? '') && Number(await seqNow()) === seq1 + 1, sr)
  // 2. Different drafts posted at the same time get distinct consecutive numbers.
  const drafts = []
  for (let i = 0; i < 6; i++) drafts.push(await draft())
  // Two sessions, each posting its own drafts one after another, racing each other.
  const chain = async (conn, user, list) => { const out = []; for (const d of list) out.push(await requestOn(conn, user, `select public.accounting_voucher_post($1::uuid)`, [d])); return out }
  const res = (await Promise.all([chain(db, 'acct', drafts.filter((_, i) => i % 2 === 0)), chain(conn2, 'acct2', drafts.filter((_, i) => i % 2 === 1))])).flat()
  const nums = res.map((r) => r.value?.voucher_number).filter(Boolean)
  ok('concurrent postings: every number unique and consecutive (no gaps, no duplicates)', nums.length === 6 && new Set(nums).size === 6
    && Number(await seqNow()) === seq1 + 7, res.map((r) => r.error ?? r.value?.voucher_number))
  // 3. The same voucher reversed from two sessions: exactly one reversal.
  const target = drafts[0]
  const rA = await requestOn(db, 'acct', `select public.accounting_voucher_reverse($1::uuid, 'concurrent reversal A')`, [target], { commit: false })
  const rBp = requestOn(conn2, 'acct2', `select public.accounting_voucher_reverse($1::uuid, 'concurrent reversal B')`, [target])
  await new Promise((r) => setTimeout(r, 300))
  await db.exec('commit')
  const rB = await rBp
  ok('concurrent reversal: exactly one reversal voucher', !rA.error && /already been reversed/.test(rB.error ?? '')
    && await val(`select count(*)::int from public.accounting_vouchers where reversal_of_voucher_id = $1`, [target]) === 1, { rA: rA.error, rB: rB.error })
  // 4. Two posting runs at the same time: the second reports busy; nothing is posted twice.
  const runA = await requestOn(db, 'acct', `select public.accounting_posting_run(500)`, null, { commit: false })
  const runB = await requestOn(conn2, 'acct2', `select public.accounting_posting_run(500)`)
  await db.exec('commit')
  ok('concurrent posting runs: the second is told another run is in progress', !runA.error && runB.value?.busy === true, { runA: runA.error, runB })
  ok('no source document has more than one automatic voucher', await val(`select count(*)::int from (select source_type, source_id from public.accounting_vouchers
    where source = 'AUTO' group by 1, 2 having count(*) > 1) x`) === 0)
  // 5. Phase 1: the same journal draft saved from two sessions with the same row version: one save wins, the other must reload.
  const jd = await acct(`select public.accounting_voucher_create($1::jsonb)`, [jv(today, [{ account_id: rent, debit: 3 }, { account_id: bank, credit: 3 }])])
  const eA = await requestOn(db, 'acct', `select public.accounting_voucher_update($1::uuid, '{"narration":"session A"}'::jsonb, $2)`, [jd.id, jd.row_version], { commit: false })
  const eBp = requestOn(conn2, 'acct2', `select public.accounting_voucher_update($1::uuid, '{"narration":"session B"}'::jsonb, $2)`, [jd.id, jd.row_version])
  await new Promise((r) => setTimeout(r, 300))
  await db.exec('commit')
  const eB = await eBp
  ok('concurrent edits of one journal draft: the second save is refused (stale row version), no lost update', !eA.error && /changed by someone else/.test(eB.error ?? '')
    && await val(`select narration from public.accounting_vouchers where id = $1`, [jd.id]) === 'session A', { eA: eA.error, eB: eB.error })
  // 6. Phase 2: two budget versions of one year approved at the same time: serialized, exactly one APPROVED at the end.
  const da = await acct(`select public.accounting_budget_create($1::date, 'Race A', null)`, [today])
  const dbb = await acct(`select public.accounting_budget_create($1::date, 'Race B', null)`, [today])
  for (const d of [da, dbb]) await acct(`select public.accounting_budget_lines_replace($1::uuid, $2::jsonb)`, [d.id, JSON.stringify([{ cost_centre_code: 'PROD', account_code: '6500', annual: '1200' }])])
  const apA = await requestOn(db, 'acct', `select public.accounting_budget_approve($1::uuid)`, [da.id], { commit: false })
  const apBp = requestOn(conn2, 'acct2', `select public.accounting_budget_approve($1::uuid)`, [dbb.id])
  await new Promise((r) => setTimeout(r, 300))
  await db.exec('commit')
  const apB = await apBp
  ok('concurrent budget approvals are serialized: both succeed in turn and exactly one budget of the year stays APPROVED', !apA.error && !apB.error
    && await val(`select count(*)::int from public.accounting_budgets where company_id = $1 and financial_year = $2 and status = 'APPROVED'`, [A, fyLbl]) === 1
    && await val(`select status from public.accounting_budgets where id = $1`, [da.id]) === 'SUPERSEDED', { apA: apA.error, apB: apB.error })
  // 7. Two opposite hierarchy moves at the same time cannot create a cycle.
  const cx = (await ccSave({ cost_centre_code: 'CX', cost_centre_name: 'Race X' })).id
  const cy = (await ccSave({ cost_centre_code: 'CY', cost_centre_name: 'Race Y' })).id
  const mA = await requestOn(db, 'acct', `select public.accounting_cost_centre_save($1::uuid, $2::jsonb)`, [cx, JSON.stringify({ cost_centre_name: 'Race X', parent_cost_centre_id: cy })], { commit: false })
  const mBp = requestOn(conn2, 'acct2', `select public.accounting_cost_centre_save($1::uuid, $2::jsonb)`, [cy, JSON.stringify({ cost_centre_name: 'Race Y', parent_cost_centre_id: cx })])
  await new Promise((r) => setTimeout(r, 300))
  await db.exec('commit')
  const mB = await mBp
  ok('concurrent opposite cost-centre moves: the second waits and is refused (no cycle)', !mA.error && /under itself/.test(mB.error ?? '')
    && await val(`select parent_cost_centre_id::text from public.accounting_cost_centres where id = $1`, [cy]) === null, { mA: mA.error, mB: mB.error })
  // 8. Allocations edited while the voucher is being posted: the edit waits, then is refused; the posted split is unchanged.
  const pv = await acct(`select public.accounting_voucher_create($1::jsonb)`, [jvA([[electricity, '300.00', null, [[ccProd, '300.00']]], [payable, null, '300.00']])])
  const pA = await requestOn(db, 'acct', `select public.accounting_voucher_post($1::uuid)`, [pv.id], { commit: false })
  const eBp2 = requestOn(conn2, 'acct2', `select public.accounting_voucher_line_save($1::uuid, $2::uuid, $3::jsonb, null)`, [pv.id, pv.lines[0].id,
    JSON.stringify({ account_id: electricity, debit: '300.00', allocations: [{ cost_centre_id: ccAdmin, amount: '300.00' }] })])
  await new Promise((r) => setTimeout(r, 300))
  await db.exec('commit')
  const eB2 = await eBp2
  ok('allocations changed during posting: refused once posted; the posted allocation is unchanged', !pA.error && /only drafts/.test(eB2.error ?? '')
    && await val(`select string_agg(cost_centre_id::text, ',') from public.accounting_cost_allocations where voucher_id = $1`, [pv.id]) === ccProd, { pA: pA.error, eB2: eB2.error })
  // 9. Phase 3: two sessions invoice the same remaining receipt quantity: the second waits on the receipt-line lock, then is refused.
  const G5 = await grnPost(sup1, [[3, 10, 0]])
  await acct(`select public.accounting_posting_run(500)`)
  const piA = await requestOn(db, 'pm', `select public.purchase_invoice_save(null, $1::jsonb)`, [pinv(sup1, 'RACE-A', [grnL(G5.line(10), 3, 10, 0)])], { commit: false })
  const piBp = requestOn(conn2, 'acct2', `select public.purchase_invoice_save(null, $1::jsonb)`, [pinv(sup1, 'RACE-B', [grnL(G5.line(10), 3, 10, 0)])])
  await new Promise((r) => setTimeout(r, 300))
  await db.exec('commit')
  const piB = await piBp
  ok('concurrent invoices for the same receipt quantity: the second waits, then is refused (no over-invoicing)', !piA.error && /only 0(\.0+)? of goods receipt/.test(piB.error ?? '')
    && await val(`select count(*)::int from public.purchase_invoice_lines where goods_receipt_line_id = $1`, [G5.line(10)]) === 1, { piA: piA.error, piB: piB.error })
  // 10. One payment allocated to two invoices at once beyond its amount: serialized on the payment, the second is refused.
  const pay2 = await op(`select public.supplier_payment_record($1::uuid, $2::date, 1000.00, 'BANK_TRANSFER', 'RACE-PAY', null, gen_random_uuid())`, [sup1, today])
  const alA = await requestOn(db, 'pm', `select public.purchase_invoice_allocate_payment($1::uuid, $2::uuid, 800)`, [m1.id, pay2.payment_id], { commit: false })
  const alBp = requestOn(conn2, 'acct2', `select public.purchase_invoice_allocate_payment($1::uuid, $2::uuid, 800)`, [d4.id, pay2.payment_id])
  await new Promise((r) => setTimeout(r, 300))
  await db.exec('commit')
  const alB = await alBp
  ok('concurrent allocations of one payment: never more than the payment (second refused, 800 allocated)', !alA.error && /Only 200(\.0+)? of payment/.test(alB.error ?? '')
    && near(await val(`select sum(amount)::text from public.supplier_payment_allocations where payment_id = $1 and status = 'ACTIVE'`, [pay2.payment_id]), 800), { alA: alA.error, alB: alB.error })
  // 11. The same approved invoice posted from two sessions: one voucher.
  const dp = await save('pm', pinv(sup1, 'RACE-POST', [dirL(rent, 100, 0)], { supplier_stated_total: '100' }))
  await act('pm', 'submit', dp.id); await act('acct', 'approve', dp.id, null, false)
  const ppA = await requestOn(db, 'acct', `select public.purchase_invoice_post($1::uuid)`, [dp.id], { commit: false })
  const ppBp = requestOn(conn2, 'acct2', `select public.purchase_invoice_post($1::uuid)`, [dp.id])
  await new Promise((r) => setTimeout(r, 300))
  await db.exec('commit')
  const ppB = await ppBp
  ok('concurrent posting of one supplier invoice: the second is refused; exactly one voucher', !ppA.error && /is posted/.test(ppB.error ?? '')
    && await val(`select count(*)::int from public.accounting_vouchers where source_id = $1`, [dp.id]) === 1, { ppA: ppA.error, ppB: ppB.error })
  // 12. Phase 4: two cash payments from the same cash account at once that together exceed it: the second waits on the account lock, then is refused.
  await postTrf((await trf({ from_account_id: hdfc.id, to_account_id: petty.id, amount: '1000', reference: 'TOP-UP' })).id)
  const cA = await trf({ from_account_id: petty.id, to_account_id: hdfc.id, amount: '1000' })
  const cB = await trf({ from_account_id: petty.id, to_account_id: hdfc.id, amount: '1000' })
  const ctA = await requestOn(db, 'acct', `select public.bank_transfer_post($1::uuid)`, [cA.id], { commit: false })
  const ctBp = requestOn(conn2, 'acct2', `select public.bank_transfer_post($1::uuid)`, [cB.id])
  await new Promise((r) => setTimeout(r, 300))
  await db.exec('commit')
  const ctB = await ctBp
  ok('concurrent cash payments: serialized on the cash account; the one that would overdraw is refused (no concurrent overspending)', !ctA.error
    && /would go below zero/.test(ctB.error ?? '') && Number((await book(petty.id)).closing_balance) === 500, { ctA: ctA.error, ctB: ctB.error })
  // 13. The same statement line matched from two sessions: the second waits on the ledger lock, then is refused.
  const ms = [{ statement_line_id: await stmtLine(sbi.id, 1) }, { voucher_line_id: sbiIn }]
  const mtA = await requestOn(db, 'acct', `select public.bank_reconciliation_match($1::uuid, $2::jsonb, 'session A match')`, [sbi.id, JSON.stringify(ms)], { commit: false })
  const mBp2 = requestOn(conn2, 'acct2', `select public.bank_reconciliation_match($1::uuid, $2::jsonb, 'session B match')`, [sbi.id, JSON.stringify(ms)])
  await new Promise((r) => setTimeout(r, 300))
  await db.exec('commit')
  const mB2 = await mBp2
  ok('concurrent matching of one statement line: exactly one match, the second refused (never matched twice)', !mtA.error && /exceeds what is left/.test(mB2.error ?? '')
    && await val(`select count(*)::int from public.bank_reconciliation_match_items i join public.bank_reconciliation_matches m on m.id = i.match_id
      where i.statement_line_id = $1 and m.status = 'ACTIVE'`, [ms[0].statement_line_id]) === 1, { mtA: mtA.error, mB: mB2.error })
  // 14. One transfer posted from two sessions: one voucher.
  const dT = await trf({ from_account_id: hdfc.id, to_account_id: petty.id, amount: '10' })
  const pA2 = await requestOn(db, 'acct', `select public.bank_transfer_post($1::uuid)`, [dT.id], { commit: false })
  const pBp2 = requestOn(conn2, 'acct2', `select public.bank_transfer_post($1::uuid)`, [dT.id])
  await new Promise((r) => setTimeout(r, 300))
  await db.exec('commit')
  const pB2 = await pBp2
  ok('concurrent posting of one transfer: the second is refused; exactly one voucher', !pA2.error && /already posted/.test(pB2.error ?? '')
    && await val(`select count(*)::int from public.accounting_vouchers where source_id = $1`, [dT.id]) === 1, { pA: pA2.error, pB: pB2.error })
  // 15. Phase 5: two approvals of configuration versions effective on the same date — serialized; exactly one wins.
  const c3 = await cfgSave('acct', '2027-03-01', cfgPayload()); await acct(`select public.gst_config_submit($1::uuid)`, [c3.id])
  const c4 = await cfgSave('acct', '2027-03-01', cfgPayload()); await acct(`select public.gst_config_submit($1::uuid)`, [c4.id])
  const caA = await requestOn(db, 'acct2', `select public.gst_config_approve($1::uuid)`, [c3.id], { commit: false })
  const caBp = requestOn(conn2, 'op', `select public.gst_config_approve($1::uuid)`, [c4.id])
  await new Promise((r) => setTimeout(r, 300))
  await db.exec('commit')
  const caB = await caBp
  ok('concurrent config approvals for the same effective date: one approved, the other refused (no overlap)', !caA.error && /already starts on or after/.test(caB.error ?? '')
    && await val(`select count(*)::int from public.gst_config_versions where company_id = $1 and effective_from = '2027-03-01' and status = 'APPROVED'`, [A]) === 1, { caA: caA.error, caB: caB.error })
  // 16. The same return period created from two sessions: one period.
  const pcA = await requestOn(db, 'acct', `select public.gst_period_create('2027-04-01'::date)`, null, { commit: false })
  const pcBp = requestOn(conn2, 'acct2', `select public.gst_period_create('2027-04-01'::date)`)
  await new Promise((r) => setTimeout(r, 300))
  await db.exec('commit')
  const pcB = await pcBp
  ok('concurrent creation of one return period: one created, the other refused', !pcA.error && /overlaps|already starts/.test(pcB.error ?? '')
    && await val(`select count(*)::int from public.gst_return_periods where registration_id = $1 and period_start = '2027-04-01'`, [gstReg.id]) === 1, { pcA: pcA.error, pcB: pcB.error })
  // 17. Two set-off drafts of one period posted at once: one posted set-off.
  await setOff('acct2', 'REVERSE', so.id, { reason: 'Re-done with the concurrency test' })
  const sA = await setOff('acct', 'SAVE', null, { period_id: nov.id, lines: [line('OUTPUT', 'CGST', 'CASH', 'CGST', '100', 'TAX')] })
  const sB = await setOff('acct', 'SAVE', null, { period_id: nov.id, lines: [line('OUTPUT', 'CGST', 'CASH', 'CGST', '100', 'TAX')] })
  const spA = await requestOn(db, 'acct2', `select public.gst_set_off('POST', $1::uuid, '{}'::jsonb)`, [sA.id], { commit: false })
  const spBp = requestOn(conn2, 'op', `select public.gst_set_off('POST', $1::uuid, '{}'::jsonb)`, [sB.id])
  await new Promise((r) => setTimeout(r, 300))
  await db.exec('commit')
  const spB = await spBp
  ok('concurrent set-off posting for one period: exactly one posted (no double utilisation)', !spA.error && /already posted/.test(spB.error ?? '')
    && await val(`select count(*)::int from public.gst_set_offs where period_id = $1 and status = 'POSTED'`, [nov.id]) === 1, { spA: spA.error, spB: spB.error })
  // 18. One ITC proposal approved from two sessions: one decision voucher.
  const Y = await piPost(sup1, 'GST-Y-1', [dirL(rent, 1000, 18)], '1180.00', { invoice_type: 'SERVICE' })
  await itcAct('acct', Y.id, 'PROPOSE', { reason: 'Partly exempt use — concurrency test', checks: gstChecks, eligible: { cgst: '45', sgst: '45' }, ineligible: { cgst: '45', sgst: '45' } })
  const iaA = await requestOn(db, 'acct2', `select public.gst_itc_action($1::uuid, 'APPROVE', '{}'::jsonb)`, [Y.id], { commit: false })
  const iaBp = requestOn(conn2, 'op', `select public.gst_itc_action($1::uuid, 'APPROVE', '{}'::jsonb)`, [Y.id])
  await new Promise((r) => setTimeout(r, 300))
  await db.exec('commit')
  const iaB = await iaBp
  ok('concurrent approval of one ITC proposal: one decision voucher, the second refused', !iaA.error && /no proposal awaiting approval/.test(iaB.error ?? '')
    && await val(`select count(*)::int from public.gst_itc_decisions where purchase_invoice_id = $1 and stage = 'DECIDED'`, [Y.id]) === 1, { iaA: iaA.error, iaB: iaB.error })
  // 19. One successful challan payment posted from two sessions: one voucher.
  const ch2 = await challan('acct', 'SAVE', null, { cpin: '26112700000002', challan_date: today, heads: [{ major_head: 'SGST', minor_head: 'TAX', amount: '300' }] })
  const p2 = await cpay('acct', 'RECORD', ch2.id, { status: 'SUCCESS', cin: '26112700000002HDFC', amount: '300', bank_cash_account_id: hdfc.id, payment_date: today })
  const ppA3 = await requestOn(db, 'acct2', `select public.gst_challan_payment('POST', $1::uuid, '{}'::jsonb)`, [p2.id], { commit: false })
  const ppBp3 = requestOn(conn2, 'op', `select public.gst_challan_payment('POST', $1::uuid, '{}'::jsonb)`, [p2.id])
  await new Promise((r) => setTimeout(r, 300))
  await db.exec('commit')
  const ppB3 = await ppBp3
  ok('concurrent posting of one GST payment: exactly one voucher', !ppA3.error && /successful, unposted/.test(ppB3.error ?? '')
    && await val(`select count(*)::int from public.accounting_vouchers where source_id = $1`, [p2.id]) === 1, { ppA: ppA3.error, ppB: ppB3.error })
  // 20. Two GSTR-2B documents matched to the same invoice from two sessions: one proposal.
  const conc = (d) => JSON.stringify({ document_id: d, purchase_invoice_id: G.g6.id, reason: 'Concurrency test manual match' })
  const cmA = await requestOn(db, 'acct', `select public.gst_2b_match_manual($1::jsonb)`, [conc(await doc('NOT-IN-BOOKS-1'))], { commit: false })
  const cmBp = requestOn(conn2, 'acct2', `select public.gst_2b_match_manual($1::jsonb)`, [conc(await doc('NOT-IN-BOOKS-2'))])
  await new Promise((r) => setTimeout(r, 300))
  await db.exec('commit')
  const cmB = await cmBp
  ok('concurrent GSTR-2B matching of one invoice: one proposal, the other refused (never two active matches)', !cmA.error && /already has a proposed or approved/.test(cmB.error ?? '')
    && await val(`select count(*)::int from public.gst_2b_matches where purchase_invoice_id = $1 and status in ('PROPOSED', 'APPROVED')`, [G.g6.id]) === 1, { cmA: cmA.error, cmB: cmB.error })
  // 21. One GSTR-2B match approved from two sessions: approved once.
  const caA2 = await requestOn(db, 'acct2', `select public.gst_2b_match_decide($1::uuid, 'APPROVE', 'Checked with the supplier ledger')`, [cmA.value.id], { commit: false })
  const caBp2 = requestOn(conn2, 'op', `select public.gst_2b_match_decide($1::uuid, 'APPROVE', 'Checked with the supplier ledger')`, [cmA.value.id])
  await new Promise((r) => setTimeout(r, 300))
  await db.exec('commit')
  const caB2 = await caBp2
  ok('concurrent approval of one GSTR-2B match: approved once, the second refused', !caA2.error && /only a proposed match/.test(caB2.error ?? '')
    && await val(`select count(*)::int from public.gst_2b_match_history where match_id = $1 and action = 'APPROVED'`, [cmA.value.id]) === 1, { caA: caA2.error, caB: caB2.error })
  // 22. One verified GSTR-2B import committed from two sessions: committed once.
  const imp3 = await uploadVerified(Buffer.from(`gstr2b-3-${Date.now()}`), [asRow(f2b(S1, 'CONC-1', today, 100, 0, 9, 9))], { return_period: '2027-01' })
  const ccA = await requestOn(db, 'acct', `select public.gst_2b_import_commit($1::uuid, false, null)`, [imp3.id], { commit: false })
  const ccBp = requestOn(conn2, 'acct2', `select public.gst_2b_import_commit($1::uuid, false, null)`, [imp3.id])
  await new Promise((r) => setTimeout(r, 300))
  await db.exec('commit')
  const ccB = await ccBp
  ok('concurrent commit of one GSTR-2B import: committed once (one document version), the second refused', !ccA.error && /only a file verified/.test(ccB.error ?? '')
    && await val(`select count(*)::int from public.gst_2b_document_versions v join public.gst_2b_documents d on d.id = v.document_id where d.company_id = $1 and d.doc_number = 'CONC-1'`, [A]) === 1,
    { ccA: ccA.error, ccB: ccB.error })
  // 23. The same file prepared from two sessions: one import.
  const bytes4 = Buffer.from(`gstr2b-4-${Date.now()}`)
  const cpA = await requestOn(db, 'acct', `select public.gst_2b_upload_prepare($1::jsonb)`, [JSON.stringify(fileBody(bytes4))], { commit: false })
  const cpBp = requestOn(conn2, 'acct2', `select public.gst_2b_upload_prepare($1::jsonb)`, [JSON.stringify(fileBody(bytes4, { file_name: 'copy.csv' }))])
  await new Promise((r) => setTimeout(r, 300))
  await db.exec('commit')
  const cpB = await cpBp
  ok('concurrent upload of the same file: one import, the other refused as a duplicate', !cpA.error && /Duplicate file/.test(cpB.error ?? '')
    && await val(`select count(*)::int from public.gst_2b_imports where company_id = $1 and declared_sha256 = $2`, [A, sha256(bytes4)]) === 1, { cpA: cpA.error, cpB: cpB.error })
  // 24. The same filing recorded from two sessions: one record.
  const frA = await requestOn(db, 'acct2', `select public.gst_return_filing('RECORD', null, $1::jsonb)`, [JSON.stringify({ period_id: oct.id, return_type: 'GSTR1', arn: 'AA2710260000024', filed_on: today })], { commit: false })
  const frBp = requestOn(conn2, 'op', `select public.gst_return_filing('RECORD', null, $1::jsonb)`, [JSON.stringify({ period_id: oct.id, return_type: 'GSTR1', arn: 'AA2710260000025', filed_on: today })])
  await new Promise((r) => setTimeout(r, 300))
  await db.exec('commit')
  const frB = await frBp
  ok('concurrent filing records of one return: one recorded, the other refused', !frA.error && /already recorded/.test(frB.error ?? '')
    && await val(`select count(*)::int from public.gst_return_filings where period_id = $1 and return_type = 'GSTR1' and status = 'RECORDED'`, [oct.id]) === 1, { frA: frA.error, frB: frB.error })
  // 25. One period approved from two sessions: one snapshot with the return working.
  const paA = await requestOn(db, 'acct2', `select public.gst_period_transition($1::uuid, 'APPROVE', null)`, [dec.id], { commit: false })
  const paBp = requestOn(conn2, 'op', `select public.gst_period_transition($1::uuid, 'APPROVE', null)`, [dec.id])
  await new Promise((r) => setTimeout(r, 300))
  await db.exec('commit')
  const paB = await paBp
  ok('concurrent approval of one return period: one snapshot (with GSTR-1 / GSTR-3B), the second refused', !paA.error && /not possible while the period is approved/.test(paB.error ?? '')
    && await val(`select count(*)::int from public.gst_period_snapshots where period_id = $1 and data -> 'returns' ? 'GSTR3B'`, [dec.id]) === 1, { paA: paA.error, paB: paB.error })
  // 26. One period closed from two sessions: closed once (the close controls run under the period lock).
  for (const n of ['S2B-002', 'S2B-004']) { const m = await matchOf(n); if (m.status === 'PROPOSED') await as('acct2')(`select public.gst_2b_match_decide($1::uuid, 'APPROVE', null)`, [m.id]) }
  const clA = await requestOn(db, 'acct2', `select public.gst_period_transition($1::uuid, 'CLOSE', 'Warnings reviewed for the concurrency test')`, [dec.id], { commit: false })
  const clBp = requestOn(conn2, 'op', `select public.gst_period_transition($1::uuid, 'CLOSE', 'Warnings reviewed for the concurrency test')`, [dec.id])
  await new Promise((r) => setTimeout(r, 300))
  await db.exec('commit')
  const clB = await clBp
  ok('concurrent close of one period: closed once (one CLOSED event), the second refused', !clA.error && /not possible while the period is closed/.test(clB.error ?? '')
    && await val(`select count(*)::int from public.gst_period_events where period_id = $1 and action = 'CLOSED'`, [dec.id]) === 1, { clA: clA.error, clB: clB.error })
  await c2.close()
}

// ---- rollback and re-apply (fresh database) -----------------------------------------------------------------------
console.log('\nN. Rollback and re-apply')
await main.close()
const fresh = await (async () => {
  if (!PG_URL) return openDb()
  // Real server: use a second, empty database next to the given one.
  const admin = await openDb()
  const name = `acc_rb_${Date.now()}`
  await admin.db.exec(`create database ${name}`)
  await admin.close()
  const url = new URL(PG_URL); url.pathname = `/${name}`
  const c = new Pg.Client({ connectionString: url.toString() }); await c.connect()
  return { db: { exec: (s) => c.query(s), query: (s, p) => c.query(s, p) }, close: async () => { await c.end(); const a = await openDb(); await a.db.exec(`drop database ${name}`); await a.close() } }
})()
const fdb = fresh.db
const fval = async (sql) => Object.values((await fdb.query(sql)).rows[0] ?? {})[0]
await fdb.exec(await shimSql())
for (const f of before) await fdb.exec(await read(path.join(migDir, f)))
const regBefore = await fval(`select md5(string_agg(table_name, ',' order by table_name)) from (select table_name from private.erp_reset_tables()
  union all select 'k:' || table_name from private.erp_reset_kept_tables() union all select 'f:' || table_name from private.erp_force_reset_tables()) x`)
const permsBefore = await fval(`select count(*)::int from public.permissions`)
for (const f of [FOUNDATION, AUTO]) await fdb.exec(await read(path.join(migDir, `${f}.sql`)))
// Phase 2 rollback: everything Phase 2 changed is restored exactly to the Phase 0 / Phase 1 state.
const p01 = () => fval(`select md5(coalesce((select string_agg(pg_get_functiondef(p.oid), '' order by p.oid::regprocedure::text) from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'private') and p.proname like 'accounting%'), '')
  || coalesce((select string_agg(table_name || '.' || column_name, ',' order by table_name, column_name) from information_schema.columns
     where table_schema = 'public' and (table_name like 'accounting%' or table_name in ('accounts', 'account_groups'))), '')
  || coalesce((select string_agg(conname, ',' order by conname) from pg_constraint where conrelid in ('public.accounts'::regclass, 'public.accounting_voucher_lines'::regclass,
     'public.accounting_cost_centres'::regclass)), '')
  || (select string_agg(table_name, ',' order by table_name) from private.erp_reset_tables())
  || (select count(*)::text from public.permissions))`)
const beforeP2 = await p01()
for (const f of after) await fdb.exec(await read(path.join(migDir, f)))
ok('Phase 2 migration applies on top of Phase 0 / 1 and changes them', beforeP2 !== await p01())
await fdb.exec(await read(path.join(rbDir, `${GE}_down.sql`)))
await fdb.exec(await read(path.join(rbDir, `${GR}_down.sql`)))
await fdb.exec(await read(path.join(rbDir, `${G2B}_down.sql`)))
await fdb.exec(await read(path.join(rbDir, `${GT}_down.sql`)))
await fdb.exec(await read(path.join(rbDir, `${BC}_down.sql`)))
await fdb.exec(await read(path.join(rbDir, `${PI}_down.sql`)))
await fdb.exec(await read(path.join(rbDir, `${CC}_down.sql`)))
ok('Phase 5 (Gates E, D, C, B) + Phase 4 + Phase 3 + Phase 2 rollbacks restore every Phase 0 / 1 accounting function, column, constraint, reset entry and permission exactly; the goods-receipt lock is removed',
  beforeP2 === await p01() && await fval(`select count(*)::int from pg_trigger where tgname = 'goods_receipts_invoice_lock'`) === 0
  && await fval(`select count(*)::int from pg_class where relname in ('purchase_invoices', 'supplier_payment_allocations', 'bank_cash_accounts', 'bank_statement_lines')`) === 0
  && await fval(`select count(*)::int from pg_trigger where tgname = 'accounting_vouchers_bank_cash_balance'`) === 0)
for (const f of after) await fdb.exec(await read(path.join(migDir, f)))
const company = await fval(`insert into public.companies (legal_name, display_name, company_code) values ('Rollback Co', 'Rollback Co', 'ACCRB') returning id::text`)
await fdb.exec(`insert into public.accounting_settings (company_id, books_start_date) values ('${company}', current_date);
  insert into public.accounting_budgets (company_id, financial_year, fy_start, version, budget_name) values ('${company}', '2026-27', '2026-04-01', 1, 'Rollback budget')`)
let ccRefused = false
await fdb.exec(await read(path.join(rbDir, `${GE}_down.sql`)))
await fdb.exec(await read(path.join(rbDir, `${GR}_down.sql`)))
await fdb.exec(await read(path.join(rbDir, `${G2B}_down.sql`)))
await fdb.exec(await read(path.join(rbDir, `${GT}_down.sql`)))
await fdb.exec(await read(path.join(rbDir, `${BC}_down.sql`)))
await fdb.exec(await read(path.join(rbDir, `${PI}_down.sql`)))
try { await fdb.exec(await read(path.join(rbDir, `${CC}_down.sql`))) } catch (e) { ccRefused = /allocations or budgets exist/.test(e.message) }
ok('Phase 2 rollback is refused while budgets or allocations exist', ccRefused)
await fdb.exec(`set app.accounting_cost_centre_rollback_force = 'on'`)
await fdb.exec(await read(path.join(rbDir, `${CC}_down.sql`)))
let rbRefused = false
try { await fdb.exec(await read(path.join(rbDir, `${AUTO}_down.sql`))); await fdb.exec(await read(path.join(rbDir, `${FOUNDATION}_down.sql`))) } catch (e) { rbRefused = /Accounting data exists/.test(e.message) }
ok('rollback is refused while accounting data exists', rbRefused)
await fdb.exec(`set app.accounting_rollback_force = 'on'`)
await fdb.exec(await read(path.join(rbDir, `${AUTO}_down.sql`)))
await fdb.exec(await read(path.join(rbDir, `${FOUNDATION}_down.sql`)))
ok('rollback: accounting tables, functions and permissions removed; reset registries restored exactly',
  await fval(`select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public', 'private')
    and c.relkind = 'r' and (c.relname like 'accounting%' or c.relname in ('accounts', 'account_groups'))`) === 0
  && await fval(`select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'private') and p.proname like 'accounting%'`) === 0
  && await fval(`select count(*)::int from public.permissions`) === permsBefore
  && regBefore === await fval(`select md5(string_agg(table_name, ',' order by table_name)) from (select table_name from private.erp_reset_tables()
       union all select 'k:' || table_name from private.erp_reset_kept_tables() union all select 'f:' || table_name from private.erp_force_reset_tables()) x`))
for (const f of [FOUNDATION, AUTO]) await fdb.exec(await read(path.join(migDir, `${f}.sql`)))
for (const f of after) await fdb.exec(await read(path.join(migDir, f)))
ok('re-apply after rollback works', await fval(`select count(*)::int from private.erp_reset_tables()`) === 191
  && await fval(`select count(*)::int from public.permissions where code like 'vouchers.%'`) === 4)
await fresh.close()

console.log(`\n${failed === 0 ? '✓' : '✗'} Accounting foundation (${main.label}): ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
