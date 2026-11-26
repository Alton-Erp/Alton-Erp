// ERP search (migration 20261231090900): substring / multi-word matching, related-record search (component → BOM, finished SKU → BOM and
// production, vendor → outsourcing), no duplicates, company isolation and permissions, wildcard safety, large-data timing, rollback.
//
//   npm run test:db:erp-search                       PGlite (in memory, throwaway)
//   ERP_SEARCH_PG_URL=postgres://... ERP_SEARCH_PG_MODULE=<dir containing node_modules/pg> npm run test:db:erp-search
//                                                    an EMPTY disposable PostgreSQL database (uses pg_trgm indexes when available)
//
// Never point this at a shared or production database: it creates its own schema and test data.

import { readdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p) => readFile(p, 'utf8')
const migDir = path.join(root, 'supabase', 'migrations')
const NAME = '20261231090900_erp_search'
const PG_URL = process.env.ERP_SEARCH_PG_URL

async function openDb() {
  if (!PG_URL) {
    const { PGlite } = await import('@electric-sql/pglite')
    const db = new PGlite()
    return { db, label: 'PGlite', close: () => db.close() }
  }
  const Pg = createRequire(path.join(process.env.ERP_SEARCH_PG_MODULE ?? root, 'x.js'))('pg')
  const client = new Pg.Client({ connectionString: PG_URL })
  await client.connect()
  return { db: { exec: (sql) => client.query(sql), query: (sql, params) => client.query(sql, params) }, label: 'PostgreSQL', close: () => client.end() }
}
const { db, label, close } = await openDb()
if (PG_URL) {
  const n = (await db.query(`select count(*)::int as n from pg_namespace where nspname in ('auth', 'private', 'rls_test')`)).rows[0].n
  if (n !== 0) { console.error('✗ ERP_SEARCH_PG_URL must point at an EMPTY disposable database.'); process.exit(1) }
  console.log(`Running on PostgreSQL ${(await db.query('show server_version')).rows[0].server_version}`)
}
const shim = (await read(path.join(root, 'supabase', 'tests', 'local_supabase_shim.sql')))
  .replace(/create role (anon|authenticated|service_role)[^;]*;/g, (m) => (PG_URL ? `do $$ begin ${m} exception when duplicate_object then null; end $$;` : m))
await db.exec(shim)
const files = (await readdir(migDir)).filter((x) => x.endsWith('.sql')).sort()
for (const f of files.filter((x) => x < `${NAME}.sql`)) await db.exec(await read(path.join(migDir, f)))
let suite = await read(path.join(root, 'supabase', 'tests', 'stage7_e2e_verification.sql'))
suite = suite.slice(0, suite.lastIndexOf('\ndo $$'))
await db.exec(suite)
const flowFailed = (await db.query('select name from rls_test.results where not passed')).rows
if (flowFailed.length) { console.error('✗ end-to-end flow failed:', flowFailed.map((r) => r.name).join('; ')); process.exit(1) }
await db.exec('commit')
console.log(`✓ [${label}] migrations before ${NAME} applied, end-to-end business flow`)

let failed = 0
let passed = 0
const ok = (name, cond, detail = '') => {
  if (cond) passed++
  else failed++
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 600)}`}`)
}
const val = async (sql, params) => { await db.exec('reset role'); return Object.values((await db.query(sql, params)).rows[0] ?? {})[0] }
async function request(user, sql, params, { all = false } = {}) {
  await db.exec('reset role')
  await db.exec('begin read only')
  try {
    if (user) {
      await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: await (async () => (await db.query(`select rls_test.id($1)::text as i`, [user])).rows[0].i)(), role: 'authenticated' })])
      await db.exec('set local role authenticated')
    } else await db.exec('set local role anon')
    const r = await db.query(sql, params)
    await db.exec('commit')
    return { rows: r.rows, value: all ? r.rows : Object.values(r.rows[0] ?? {})[0] }
  } catch (e) {
    try { await db.exec('rollback') } catch { /* ended */ }
    return { error: e.message }
  }
}
async function write(sql, params, user = 'op') {
  await db.exec('reset role')
  await db.exec('begin')
  try {
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: await (async () => (await db.query(`select rls_test.id($1)::text as i`, [user])).rows[0].i)(), role: 'authenticated' })])
    await db.exec('set local role authenticated')
    const r = await db.query(sql, params)
    await db.exec('commit')
    return Object.values(r.rows[0] ?? {})[0]
  } catch (e) {
    try { await db.exec('rollback') } catch { /* ended */ }
    throw new Error(`${sql.slice(0, 90)}… → ${e.message}`)
  }
}
const A = await val(`select rls_test.id('company_a')::text`)
const W1 = await val(`select rls_test.id('w1')::text`)
const today = await val(`select rls_test.today()::text`)

// ---- Fixtures ---------------------------------------------------------------------------------------------------------------------------
const NAME_FG = 'ALTON Premium Ceramic Wash Basin White'
const product = (sku, name, type, extra = {}) => write(`insert into public.products (company_id, sku, product_name, product_type, default_source_type, base_unit, status,
    standard_cost, gst_rate, hsn_code, barcode, description, model_number)
  values ($1, $2, $3, $4, 'IN_HOUSE', 'PCS', 'ACTIVE', 10, 18, '6910', $5, $6, $7) returning id`,
  [A, sku, name, type, extra.barcode ?? null, extra.description ?? null, extra.model ?? null])
const FG = await product('ALT-WB-7001', NAME_FG, 'FINISHED_GOOD', { barcode: '8907000000017', description: 'Wall hung vitreous china, 600 mm', model: 'PCW-600' })
const C_GLAZE = await product('RM-GLZ-501', 'Opal Zircon Glaze Slurry', 'RAW_MATERIAL', { description: 'High gloss zirconium glaze' })
const C_BRACKET = await product('CMP-BRK-88', 'Concealed Steel Bracket Pair', 'COMPONENT')
const OTHER = await product('ALT-WC-9001', 'ALTON Classic Water Closet', 'FINISHED_GOOD', { description: 'Floor mounted, white' })
await product('TAP_10%', 'Pillar Tap Promo', 'FINISHED_GOOD')
const item = (p, q) => ({ component_product_id: p, quantity_required: q, unit: null, wastage_percentage: 0 })
const bom = await write(`select public.production_save_bom(null, $1, rls_test.today(), null, 1, null, $2::jsonb, gen_random_uuid())`,
  [FG, JSON.stringify([item(C_GLAZE, 3), item(C_BRACKET, 1)])])
await write(`select public.production_bom_activate($1, null)`, [bom.bom_id])
const BOM = bom.bom_id
const bomOther = await write(`select public.production_save_bom(null, $1, rls_test.today(), null, 1, null, $2::jsonb, gen_random_uuid())`, [OTHER, JSON.stringify([item(C_BRACKET, 2)])])
await write(`select public.production_bom_activate($1, null)`, [bomOther.bom_id])
await write(`select public.production_order_v2_save(null, $1::jsonb, gen_random_uuid())`, [JSON.stringify({ product_id: FG, planned_quantity: 12, production_date: today })])
const PO = await val(`select id::text from public.production_orders where finished_product_id = $1 order by created_at desc limit 1`, [FG])
const PO_NO = await val(`select production_order_number from public.production_orders where id = $1`, [PO])
// Vendor master record, and an outsourcing order naming it (orders keep the vendor name; supplier_id stays empty).
await db.exec('reset role')
const SUP_CODE = 'KILNWORKS77'
await db.query(`insert into public.suppliers (company_id, supplier_code, legal_name, display_name) values ($1, $2, 'Saurashtra Kilnworks Private Limited', 'Saurashtra Kilnworks')`, [A, SUP_CODE])
const OO = (await db.query(`insert into public.outsourcing_orders (company_id, outsourcing_order_number, order_type, supplier_name, supplier_reference, product_id, unit,
    ordered_quantity, expected_return_date, destination_warehouse_id, reference_number, notes)
  values ($1, 'OSO-2026-00417', 'OUTSOURCED_FINISHED_GOODS', 'Saurashtra Kilnworks', 'SK/JW/9931', $2, 'PCS', 40, rls_test.today() + 14, $3, 'CH-55821', 'Firing job')
  returning id::text`, [A, FG, W1])).rows[0].id
let materialsOk = true
try {
  await db.query(`insert into public.outsourcing_order_materials (company_id, outsourcing_order_id, line_no, component_product_id, unit, planned_quantity)
    values ($1, $2, 1, $3, 'PCS', 100)`, [A, OO, C_GLAZE])
} catch (e) { materialsOk = false; console.log(`  (outsourcing material line not inserted: ${e.message})`) }
// Company B: a product with the same words, which company A must never see.
await db.query(`insert into public.products (company_id, sku, product_name, product_type, default_source_type, base_unit, status, gst_rate, hsn_code)
  values (rls_test.id('company_b'), 'B-WB-1', 'ALTON Premium Ceramic Wash Basin White (company B)', 'FINISHED_GOOD', 'IN_HOUSE', 'PCS', 'ACTIVE', 18, '6910')`)

// ---- Migration ----------------------------------------------------------------------------------------------------------------------------
const snapshot = () => val(`select md5(coalesce((select string_agg(to_jsonb(p)::text, '|' order by p.id) from public.products p), '')
  || coalesce((select string_agg(to_jsonb(b)::text, '|' order by b.id) from public.boms b), '')
  || coalesce((select string_agg(to_jsonb(o)::text, '|' order by o.id) from public.production_orders o), '')
  || coalesce((select string_agg(to_jsonb(o)::text, '|' order by o.id) from public.outsourcing_orders o), '')
  || coalesce((select string_agg(to_jsonb(t)::text, '|' order by t.id) from public.inventory_transactions t), ''))`)
const before = await snapshot()
const migration = await read(path.join(migDir, `${NAME}.sql`))
await db.exec(migration)
await db.exec(migration)
console.log(`✓ ${NAME} applied (twice: re-runnable)`)
ok('migration changed no data', before === await snapshot())
const trgm = await val(`select count(*)::int from pg_extension where extname = 'pg_trgm'`)
const trgmIdx = await val(`select count(*)::int from pg_indexes where schemaname = 'public' and indexname like '%_search_trgm'`)
ok(`trigram indexes: ${trgm ? `pg_trgm present, ${trgmIdx} indexes` : 'pg_trgm not available here, none created (ILIKE fallback)'}`, trgm ? trgmIdx === 7 : trgmIdx === 0)

// ---- Matching rule --------------------------------------------------------------------------------------------------------------------------
const matches = async (hay, q) => val(`select private.search_match($1, private.search_patterns($2))`, [hay, q])
for (const q of ['ALTON Premium Ceramic Wash Basin White', 'ALTON', 'Premium', 'Ceramic', 'Wash', 'Basin', 'White', 'mic', 'eram', 'asin', 'basin white',
  'white basin', 'BASIN white', '   alton    basin  ']) {
  ok(`rule: “${q}” matches the product name`, await matches(NAME_FG, q) === true)
}
ok('rule: a missing word does not match ("basin black")', await matches(NAME_FG, 'basin black') === false)
ok('rule: empty search matches; patterns are empty', await matches(NAME_FG, '   ') === true && await val(`select cardinality(private.search_patterns('  '))`) === 0)
ok('rule: % and _ are literal', await matches('TAP_10%', '10%') === true && await matches('TAP-100', '10%') === false && await matches('TAPX', 'p_') === false)
ok('rule: at most 8 distinct words', await val(`select cardinality(private.search_patterns('a b c d e f g h i j a b'))`) === 8)

// ---- Searches as the operator --------------------------------------------------------------------------------------------------------------
const ids = async (fn, q, user = 'op') => {
  const r = await request(user, `select e ->> 'id' as id from jsonb_array_elements(public.${fn}($1, null, 2000)) e`, [q], { all: true })
  if (r.error) return { error: r.error }
  return r.value.map((x) => x.id)
}
const bomFor = async (q) => ids('bom_search', q)
for (const q of ['basin white', 'eram', 'ALT-WB', 'WB-70', '7001', 'zircon', 'Opal Glaze', 'RM-GLZ', 'bracket', 'steel concealed', 'vitreous', 'PCW-600', '8907000000017']) {
  const r = await bomFor(q)
  ok(`BOM search “${q}” finds the basin BOM (finished product or component)`, Array.isArray(r) && r.includes(BOM), r)
}
const byBracket = await bomFor('bracket')
ok('component → BOMs: a shared component finds both BOMs that use it', byBracket.includes(BOM) && byBracket.includes(bomOther.bom_id), byBracket)
ok('component → BOMs: a component used by one BOM finds only that BOM', JSON.stringify(await bomFor('zircon glaze')) === JSON.stringify([BOM]))
ok('BOM search: no duplicate rows although several components match', new Set(byBracket).size === byBracket.length && (await bomFor('steel bracket concealed zircon')).length === 1)
ok('BOM search: no results for an unknown word', (await bomFor('qqqzzz')).length === 0)
ok('BOM search: empty text returns nothing (callers use the plain list instead)', (await bomFor('   ')).length === 0)

const poFor = async (q) => ids('production_order_search', q)
const mid = PO_NO.slice(Math.floor(PO_NO.length / 2) - 2, Math.floor(PO_NO.length / 2) + 2)
for (const q of [PO_NO, PO_NO.toLowerCase(), mid, 'basin white', 'ALT-WB-7001', 'zircon', 'W1']) {
  const r = await poFor(q)
  ok(`production order search “${q}” finds the order (number, product, component, warehouse)`, Array.isArray(r) && r.includes(PO), r)
}
ok('production order search: no duplicates', (await poFor('basin')).filter((x) => x === PO).length === 1)

const ooFor = async (q) => ids('outsourcing_order_search', q)
const ooQueries = ['OSO-2026', '00417', 'kilnworks', 'Saurashtra', SUP_CODE.toLowerCase(), 'LNWOR', 'private limited', 'SK/JW', '55821', 'basin white', 'firing']
if (materialsOk) ooQueries.push('zircon')
for (const q of ooQueries) {
  const r = await ooFor(q)
  ok(`outsourcing search “${q}” finds the order (number, vendor name / code, references, product, material)`, Array.isArray(r) && r.includes(OO), r)
}
ok('outsourcing search: unknown vendor finds nothing', (await ooFor('nonexistent vendor')).length === 0)

// Filters and paging on the RPC rows (as PostgREST adds them).
const cnt = async (fn, args) => request('op', `select jsonb_array_length(public.${fn}(${args}))`)
const notArchived = await cnt('bom_search', "'bracket', 'ACTIVE', 2000")
const bomStatus = await val('select status from public.boms where id = $1', [BOM])
const sameStatus = await cnt('bom_search', `'bracket', '${bomStatus}', 2000`)
const noneStatus = await cnt('bom_search', "'bracket', 'ARCHIVED', 2000")
ok('status filter: ACTIVE (not archived), an exact status, and a status with no rows', notArchived.value === 2 && sameStatus.value === 2 && noneStatus.value === 0, { notArchived, sameStatus, noneStatus })
const openOrders = await cnt('production_order_search', "'zircon', 'OPEN', 2000")
const doneOrders = await cnt('production_order_search', "'zircon', 'COMPLETED', 2000")
ok('production order status filter: OPEN includes the new order, COMPLETED does not', openOrders.value === 1 && doneOrders.value === 0, { openOrders, doneOrders })
const limited = await cnt('bom_search', "'bracket', null, 1")
ok('limit parameter caps the result', limited.value === 1, limited)
const ordered = await request('op', "select string_agg(e ->> 'bom_code', ',' order by n) from jsonb_array_elements(public.bom_search('bracket', null, 10)) with ordinality t (e, n)")
ok('results come back in a stable order (BOM code)', ordered.value?.split(',').length === 2 && ordered.value === ordered.value.split(',').sort().join(','), ordered)
const shape = await request('op', `select (select array_agg(k order by k) from jsonb_object_keys(public.bom_search('zircon', null, 10) -> 0) k)::text
  = (select array_agg(column_name::text order by column_name::text) from information_schema.columns where table_schema = 'public' and table_name = 'bom_list_v2')::text`)
ok("each result has exactly the list view's columns (the page keeps its row type)", shape.value === true, shape)
// The RPCs must not pin the views: later migrations drop and re-create them (the full suite re-applies every migration).
const pinned = await val(`select coalesce(string_agg(p.proname || ' -> ' || c.relname, ', '), '') from pg_depend d join pg_proc p on p.oid = d.objid
  join pg_class c on c.oid = d.refobjid or c.reltype = d.refobjid
  where d.classid = 'pg_proc'::regclass and p.proname in ('bom_search', 'production_order_search', 'outsourcing_order_search')
    and c.relname in ('bom_list_v2', 'production_order_list', 'outsourcing_order_list')`)
ok('the search RPCs do not depend on the list views (later migrations can drop and re-create them)', pinned === '', pinned)

// Existing searches moved to the rule.
const stock = await request('op', `select public.inventory_stock_position(jsonb_build_object('search', 'eram basin'))::text`)
ok('inventory stock position: middle-word multi-term search finds the basin', !stock.error && stock.value.includes('ALT-WB-7001'), stock.error ?? stock.value?.slice(0, 200))
const comp = await request('op', `select public.bom_component_search('steel bracket', 20)::text`)
ok('BOM component picker (RPC): words in any order', !comp.error && comp.value.includes('CMP-BRK-88'), comp.error ?? comp.value?.slice(0, 200))
const cur = await request('op', `select public.bom_bulk_current_boms('zircon', 200)::text`)
ok('bulk BOM list: finds BOMs by component', !cur.error && cur.value.includes('ALT-WB-7001') && !cur.value.includes('ALT-WC-9001'), cur.error ?? cur.value?.slice(0, 200))
const gs = await request('op', `select public.global_search('ceramic white', 30)::text`)
ok('global search: middle words in any order find the product', !gs.error && gs.value.includes('ALT-WB-7001'), gs.error ?? gs.value?.slice(0, 200))
const gsw = await request('op', `select public.global_search('10%', 30)::text`)
ok('global search: % is literal (finds TAP_10% only, not every product)', !gsw.error && gsw.value.includes('TAP_10%') && !gsw.value.includes('ALT-WB-7001'), gsw.error ?? gsw.value)

// ---- Security --------------------------------------------------------------------------------------------------------------------------
const bB = await ids('bom_search', 'basin', 'b_op')
const pB = await ids('production_order_search', 'basin', 'b_op')
const oB = await ids('outsourcing_order_search', 'kilnworks', 'b_op')
ok('company isolation: company B finds none of company A\'s BOMs / orders / outsourcing', Array.isArray(bB) && bB.length === 0 && pB.length === 0 && oB.length === 0, { bB, pB, oB })
const gsB = await request('b_op', `select public.global_search('basin white', 30)::text`)
ok('company isolation: company B\'s global search sees only its own product', !gsB.error && gsB.value.includes('B-WB-1') && !gsB.value.includes('ALT-WB-7001'), gsB.error ?? gsB.value)
for (const fn of ['bom_search', 'production_order_search', 'outsourcing_order_search']) {
  const anon = await request(null, `select public.${fn}('basin', null, 10)`)
  ok(`${fn}: anonymous callers are refused`, Boolean(anon.error), anon)
}
const grants = await val(`select count(*)::int from information_schema.routine_privileges where routine_schema = 'public'
  and routine_name in ('bom_search', 'production_order_search', 'outsourcing_order_search') and grantee in ('anon', 'public', 'service_role')`)
ok('search RPCs: no grant to anon / public / service_role', grants === 0)
const definer = await val(`select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where p.prosecdef and p.proname in ('bom_search', 'production_order_search', 'outsourcing_order_search', 'bom_search_ids', 'production_order_search_ids',
    'outsourcing_order_search_ids', 'search_match', 'search_patterns', 'product_search_text')`)
ok('search functions are security invoker (row-level security applies)', definer === 0)
// A user with no production permissions sees nothing through the search RPCs.
const noRole = await val(`select r.code from public.roles r where not exists (select 1 from public.role_permissions rp join public.permissions p on p.id = rp.permission_id
  where rp.role_id = r.id and p.code like 'production%') order by r.code limit 1`)
if (noRole) {
  await db.exec(`reset role;
    insert into rls_test.ids (key, id) values ('srch_np', 'e7e5c800-0000-4000-8000-0000000000c9');
    insert into auth.users (id, email) values ('e7e5c800-0000-4000-8000-0000000000c9', 'srch_np@e7.example.invalid');
    update public.profiles set company_id = rls_test.id('company_a'), is_active = true where id = 'e7e5c800-0000-4000-8000-0000000000c9';
    insert into public.user_roles (user_id, company_id, role_id) values ('e7e5c800-0000-4000-8000-0000000000c9', rls_test.id('company_a'), (select id from public.roles where code = '${noRole}'))`)
  const np = await ids('bom_search', 'basin', 'srch_np')
  const npo = await ids('production_order_search', 'basin', 'srch_np')
  ok(`permissions: a ${noRole} user without production rights finds no BOMs / orders`, (np.error || np.length === 0) && (npo.error || npo.length === 0), { np, npo })
}
const inj = await request('op', `select jsonb_array_length(public.bom_search($1, null, 100))`, [`'); drop table public.boms; --`])
ok('hostile input is just text (no error, no match, table intact)', !inj.error && inj.value === 0 && await val(`select count(*)::int from public.boms`) > 0, inj)

// ---- Larger data: timing ---------------------------------------------------------------------------------------------------------------
const N = Number(process.env.ERP_SEARCH_ROWS ?? 20000)
await db.exec('reset role')
await db.query(`insert into public.products (company_id, sku, product_name, product_type, default_source_type, base_unit, status, gst_rate, hsn_code, description)
  select $1, 'BULK-' || lpad(g::text, 6, '0'), 'Bulk ' || (array['Ceramic','Steel','Brass','Glass'])[1 + g % 4] || ' item ' || g, 'COMPONENT', 'IN_HOUSE', 'PCS', 'ACTIVE', 18, '6910',
    'generated row ' || md5(g::text)
  from generate_series(1, $2) g`, [A, N])
await db.exec('analyze public.products')
const time = async (sql, params) => { const t = Date.now(); const r = await request('op', sql, params); return { ms: Date.now() - t, r } }
const t1 = await time(`select public.global_search('eram 001236', 30)::text`)
ok(`${N} extra products: global search middle-word ("eram 001236") in ${t1.ms} ms`, !t1.r.error && t1.ms < 5000 && t1.r.value.includes('BULK-001236'), t1.r.error)
const t2 = await time(`select jsonb_array_length(public.bom_search('bracket', null, 2000))`)
ok(`${N} extra products: BOM related search in ${t2.ms} ms`, !t2.r.error && t2.ms < 5000 && t2.r.value === 2, t2.r)
const t3 = await time(`select public.inventory_stock_position(jsonb_build_object('search', 'basin white'))::text`)
ok(`${N} extra products: stock position search in ${t3.ms} ms`, !t3.r.error && t3.ms < 10000, t3.r.error)
const t4 = await time(`select count(*)::int from public.products where company_id = $1 and (sku ilike '%ULK-0123%' or product_name ilike '%ULK-0123%')`, [A])
ok(`${N} extra products: list-style ILIKE substring filter in ${t4.ms} ms`, !t4.r.error && t4.r.value === 100, t4.r)
if (trgm) {
  await db.exec('reset role; set enable_seqscan = off')
  const plan = (await db.query(`explain select id from public.products where sku ilike '%ULK-01234%'`)).rows.map((r) => Object.values(r)[0]).join('\n')
  await db.exec('reset enable_seqscan')
  ok('pg_trgm: the planner can use the trigram index for a middle-of-SKU search', /products_search_trgm/.test(plan), plan)
}

// ---- Rollback ----------------------------------------------------------------------------------------------------------------------------------
const rbBefore = await snapshot()
await db.exec('reset role')
await db.exec(await read(path.join(root, 'supabase', 'rollback', `${NAME}_down.sql`)))
const left = await val(`select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where (n.nspname, p.proname) in
  (('public','bom_search'),('public','production_order_search'),('public','outsourcing_order_search'),('private','search_match'),('private','search_patterns'),
   ('private','product_search_text'),('private','bom_search_ids'),('private','production_order_search_ids'),('private','outsourcing_order_search_ids'))`)
ok('rollback: search functions removed', left === 0)
ok('rollback: trigram indexes removed', await val(`select count(*)::int from pg_indexes where indexname like '%_search_trgm'`) === 0)
ok('rollback: no data changed', rbBefore === await snapshot())
const restored = await request('op', `select public.global_search('ALT-WB-7001', 30)::text`)
const restoredStock = await request('op', `select public.inventory_stock_position(jsonb_build_object('search', 'ALT-WB'))::text`)
ok('rollback: the restored functions still work (previous behaviour)', !restored.error && restored.value.includes('ALT-WB-7001') && !restoredStock.error, restored.error ?? restoredStock.error)
await db.exec(migration)
ok('re-apply after rollback works', (await bomFor('zircon')).includes(BOM))

await close()
console.log(`\n${failed ? '✗' : '✓'} ERP search [${label}]: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
