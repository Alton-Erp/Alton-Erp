// Product image links (migration 20261124090000): database, security and rollback checks.
//
//   npm run test:db:image-link
//
// Local PGlite database only (never the live ALTON V2 project).

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p) => readFile(p, 'utf8')
const db = new PGlite()
await db.exec(await read(path.join(root, 'supabase', 'tests', 'local_supabase_shim.sql')))
const migDir = path.join(root, 'supabase', 'migrations')
for (const f of (await readdir(migDir)).filter((x) => x.endsWith('.sql')).sort()) await db.exec(await read(path.join(migDir, f)))
console.log('✓ migrations applied')

let suite = await read(path.join(root, 'supabase', 'tests', 'stage7_e2e_verification.sql'))
suite = suite.slice(0, suite.lastIndexOf('\ndo $$'))
await db.exec(suite)
const flowFailed = (await db.query('select name from rls_test.results where not passed')).rows
if (flowFailed.length) { console.error('✗ end-to-end flow failed:', flowFailed.map((r) => r.name).join('; ')); process.exit(1) }
await db.exec('commit')
console.log('✓ end-to-end business flow (company A)')

let failed = 0
let passed = 0
const ok = (name, cond, detail = '') => {
  if (cond) passed++
  else failed++
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
}
const val = async (sql, params) => Object.values((await db.query(sql, params)).rows[0] ?? {})[0]
/** Runs one request as a user in its own transaction (deferred triggers run at the commit). */
async function request(user, sql, params) {
  await db.exec('reset role')
  await db.exec('begin')
  try {
    if (user) {
      await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: await val(`select rls_test.id($1)`, [user]), role: 'authenticated' })])
      await db.exec('set local role authenticated')
    }
    const r = await db.query(sql, params)
    await db.exec('commit')
    return { value: Object.values(r.rows[0] ?? {})[0], rows: r.rows }
  } catch (e) {
    try { await db.exec('rollback') } catch { /* already ended */ }
    return { error: e.message }
  }
}
const op = async (sql, params) => {
  const r = await request('op', sql, params)
  if (r.error) throw new Error(`${sql.slice(0, 70)}… → ${r.error}`)
  return r.value
}
const owner = (sql, params) => val(sql, params)
const id = (key) => owner(`select rls_test.id($1)`, [key])


const AMAZON = 'https://m.media-amazon.com/images/I/61RypVKnRrL.jpg'
const OTHER = 'https://cdn.example.com/basins/wb-001.webp'
const company = await id('company_a')
const loc = await id('g1')
const wh = await id('w1')
const P = await op(`insert into public.products (company_id, sku, product_name, product_type, default_source_type, base_unit, status, gst_rate, ean, selling_price, mrp, standard_cost, standard_manufacturing_cost)
  values ($1, 'IMG-1', 'Image basin', 'RAW_MATERIAL', 'OUTSOURCED', 'PCS', 'ACTIVE', 18, '8901234567890', 1300, 1500, 800, 1200) returning id`, [company])
const imageOf = (pid) => owner(`select image_url from public.products where id = $1`, [pid])
const setImage = (pid, url, user = 'op') => request(user, `update public.products set image_url = $2 where id = $1 returning image_url`, [pid, url])
const versions = (pid) => owner(`select count(*)::int from public.product_versions where product_id = $1`, [pid])
const audits = (pid) => owner(`select coalesce(jsonb_agg(metadata order by event_timestamp, id), '[]') from public.audit_logs where action = 'product.image_link_changed' and resource_id = $1::text`, [pid])
const fields = (pid) => owner(`select to_jsonb(p) - array['image_url', 'updated_at', 'updated_by'] from public.products p where id = $1`, [pid])
const stock = (pid) => owner(`select coalesce(jsonb_agg(to_jsonb(b) - 'updated_at' order by id), '[]') from public.inventory_balances b where product_id = $1`, [pid])

ok('the column exists and starts empty for every existing product', (await owner(`select count(*)::int from public.products where image_url is not null`)) === 0)

// Stock on hand, so we can prove an image change leaves it alone.
await op(`select public.goods_receipt_direct_post($1::jsonb, $2::jsonb, gen_random_uuid())`, [JSON.stringify({ warehouse_id: wh, receipt_date: await owner(`select private.company_today($1)::text`, [company]) }),
  JSON.stringify([{ product_id: P, received_quantity: 5, accepted_quantity: 5, rejected_quantity: 0, unit_cost: 800, accepted_location_id: loc }])])
const productBefore = JSON.stringify(await fields(P))
const stockBefore = JSON.stringify(await stock(P))
const versionsBefore = await versions(P)

const first = await setImage(P, AMAZON)
ok('a valid https link is saved as entered', !first.error && (await imageOf(P)) === AMAZON, first.error)
ok('changing only the image creates no product version', (await versions(P)) === versionsBefore)
ok('SKU, EAN, prices, costs and other fields are unchanged', JSON.stringify(await fields(P)) === productBefore)
ok('stock balances are unchanged', JSON.stringify(await stock(P)) === stockBefore && JSON.parse(stockBefore).length > 0)
await setImage(P, `  ${OTHER}  `)
ok('surrounding spaces are removed', (await imageOf(P)) === OTHER)
const log = await audits(P)
ok('the audit log records each change with the previous and new link', log.length === 2 && log[0].from === null && log[0].to === AMAZON && log[1].from === AMAZON && log[1].to === OTHER, log)
await setImage(P, '')
ok('an empty value clears the link (the app sends this only for "Remove image link")', (await imageOf(P)) === null)
await setImage(P, AMAZON)

for (const bad of ['ftp://example.com/a.jpg', 'javascript:alert(1)', 'data:image/png;base64,AAAA', 'https://exa mple.com/a.jpg', 'https://user:pw@example.com/a.jpg',
  'http://localhost/a.jpg', 'http://127.0.0.1/a.jpg', 'http://169.254.169.254/latest/meta-data', 'http://192.168.1.4/x.jpg', 'http://10.1.2.3/x.jpg', 'http://172.16.0.1/x.jpg',
  'http://nas.local/x.jpg', 'https://[::1]/x.jpg', `https://example.com/${'a'.repeat(2050)}`]) {
  const r = await setImage(P, bad)
  ok(`rejected: ${bad.slice(0, 50)}`, Boolean(r.error) && (await imageOf(P)) === AMAZON, r.error ?? 'accepted')
}
const ins = await request('op', `insert into public.products (company_id, sku, product_name, product_type, default_source_type, base_unit, status, image_url)
  values ($1, 'IMG-2', 'New with image', 'RAW_MATERIAL', 'OUTSOURCED', 'PCS', 'ACTIVE', $2) returning id`, [company, OTHER])
ok('a new product is saved with its image link', !ins.error && (await imageOf(ins.value)) === OTHER, ins.error)
ok('   and the audit log records it', !ins.error && (await audits(ins.value)).length === 1)

// Security: company isolation and edit permission.
const other = await request('b_op', `update public.products set image_url = $2 where id = $1 returning id`, [P, OTHER])
ok("company B cannot change company A's image", !other.value && (await imageOf(P)) === AMAZON)
const seen = await request('b_op', `select count(*)::int from public.products where id = $1`, [P])
ok("company B cannot read company A's product or its link", seen.value === 0)
const roleRead = await owner(`select r.id from public.roles r where exists (select 1 from public.role_permissions rp join public.permissions p on p.id = rp.permission_id where rp.role_id = r.id and p.code = 'products.read')
  and not exists (select 1 from public.role_permissions rp join public.permissions p on p.id = rp.permission_id where rp.role_id = r.id and p.code in ('products.update', 'products.create')) order by r.code limit 1`)
await db.exec(`insert into rls_test.ids (key, id) values ('img_viewer', 'e7e5c800-0000-4000-8000-0000000000c1');
  insert into auth.users (id, email) values ('e7e5c800-0000-4000-8000-0000000000c1', 'img-viewer@e7.example.invalid');
  update public.profiles set company_id = '${company}', is_active = true where id = 'e7e5c800-0000-4000-8000-0000000000c1';
  insert into public.user_roles (user_id, company_id, role_id) values ('e7e5c800-0000-4000-8000-0000000000c1', '${company}', '${roleRead}');`)
const viewer = await setImage(P, OTHER, 'img_viewer')
ok('a user without product edit permission cannot change the image', !viewer.value && (await imageOf(P)) === AMAZON, viewer.error ?? '')
ok('   but can read it', (await request('img_viewer', `select image_url from public.products where id = $1`, [P])).value === AMAZON)

// Rollback keeps the links; the migration applies again.
await db.exec(await read(path.join(root, 'supabase', 'rollback', '20261124090000_product_image_link_down.sql')))
ok('rollback removes the triggers, check and functions', (await owner(`select count(*)::int from pg_trigger where tgname like 'products_image%' and not tgisinternal`)) === 0
  && (await owner(`select count(*)::int from pg_proc where proname in ('product_image_url_valid', 'audit_product_image_link', 'product_image_url_normalise')`)) === 0
  && (await owner(`select count(*)::int from pg_constraint where conname = 'products_image_url_check'`)) === 0)
ok('rollback keeps the saved links', (await imageOf(P)) === AMAZON)
const vRolled = await versions(P)
await owner(`update public.products set image_url = $2 where id = $1 returning id`, [P, OTHER])
ok('after the rollback a link change still creates no product version', (await versions(P)) === vRolled)
await db.exec(await read(path.join(migDir, '20261124090000_product_image_link.sql')))
await db.exec(await read(path.join(migDir, '20261124090000_product_image_link.sql')))
ok('the migration applies again, twice', (await owner(`select count(*)::int from pg_trigger where tgname like 'products_image%' and not tgisinternal`)) === 2)
ok('   and validates again', Boolean((await setImage(P, 'ftp://x.com/a.jpg')).error))

console.log(`${failed === 0 ? '✓' : '✗'} product image link check: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
