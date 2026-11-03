// Dry run of scripts/verify-supabase.mjs and scripts/concurrency-check.mjs
// against a LOCAL emulation of the Supabase API (Auth + PostgREST subset +
// Storage list) backed by PGlite with every migration and the staging seed.
//
// Purpose: prove the scripts' logic (function names, arguments, step order and
// expectations) and that the database rules give the expected answers through an
// API path, BEFORE they are run on the real staging project.
//
// Limits (stated in the output): PGlite executes one request at a time, so the
// "parallel" requests are serialised. This validates the scripts and the
// sequential rules; it does NOT prove behaviour under true simultaneity, and it
// does not exercise real Supabase Auth (emails, bans, token expiry).
//
//   node tests/db/staging-scripts-dryrun.mjs

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const PORT = 54401
const PASSWORD = 'Local-DryRun-Only-1'
const db = new PGlite()
await db.exec(await readFile(path.join(root, 'supabase', 'tests', 'local_supabase_shim.sql'), 'utf8'))
for (const f of (await readdir(path.join(root, 'supabase', 'migrations'))).filter((f) => f.endsWith('.sql')).sort()) {
  await db.exec(await readFile(path.join(root, 'supabase', 'migrations', f), 'utf8'))
}
const tags = ['stg-superadmin', 'stg-admin', 'stg-inventory', 'stg-production', 'stg-purchase', 'stg-sales', 'stg-accounts', 'stg-viewer', 'stg-inactive', 'stg-b-admin']
await db.exec(`insert into auth.users (id, email) select gen_random_uuid(), 'qa+' || t || '@example.invalid' from unnest(array['${tags.join("','")}']) t`)
await db.exec((await readFile(path.join(root, 'supabase', 'staging', 'seed_staging_test_data.sql'), 'utf8'))
  .replace("'your.mailbox'", "'qa'").replace("'yourcompany.example'", "'example.invalid'").replace("'app.allow_staging_seed', 'no'", "'app.allow_staging_seed', 'yes'"))

// --- minimal Auth -----------------------------------------------------------
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
const tokenFor = (sub) => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}.dryrun`
const refreshTokens = new Map() // token -> user id
const subOf = (req) => {
  const t = (req.headers.authorization ?? '').replace(/^Bearer /, '')
  try {
    const p = JSON.parse(Buffer.from(t.split('.')[1] ?? '', 'base64url').toString())
    return p.role === 'authenticated' ? p.sub : null
  } catch {
    return null
  }
}
const session = (user) => {
  const refresh = randomUUID()
  refreshTokens.set(refresh, user.id)
  return { access_token: tokenFor(user.id), token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: refresh,
    user: { id: user.id, aud: 'authenticated', role: 'authenticated', email: user.email, app_metadata: {}, user_metadata: {} } }
}

// --- database access as the caller ---------------------------------------------
async function asCaller(sub, fn) {
  return db.transaction(async (tx) => {
    await tx.exec(`set local role ${sub ? 'authenticated' : 'anon'}`)
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(sub ? { sub, role: 'authenticated' } : { role: 'anon' })])
    return fn(tx)
  })
}
const ident = (s) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw Object.assign(new Error(`bad identifier ${s}`), { code: 'PGRST100' })
  return `"${s}"`
}
const argTypes = new Map()
for (const r of (await db.query(`select p.proname, p.proargnames, array(select format_type(t, null) from unnest(p.proargtypes) t) types, p.proretset
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'`)).rows) argTypes.set(r.proname, r)

function filters(params, values) {
  const where = []
  for (const [k, v] of params) {
    if (['select', 'order', 'limit', 'offset', 'or', 'and'].includes(k)) continue
    const [op, ...rest] = v.split('.')
    const val = rest.join('.')
    if (op === 'eq' || op === 'neq') { values.push(val); where.push(`${ident(k)}::text ${op === 'eq' ? '=' : '<>'} $${values.length}`) }
    else if (op === 'is' && val === 'null') where.push(`${ident(k)} is null`)
    else if (op === 'in') { values.push(val.replace(/^\(|\)$/g, '').split(',')); where.push(`${ident(k)}::text = any($${values.length})`) }
    else throw Object.assign(new Error(`filter ${op} not emulated`), { code: 'PGRST100' })
  }
  return where.length ? ` where ${where.join(' and ')}` : ''
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
  res.end(body === undefined ? '' : JSON.stringify(body))
}
const pgError = (res, e) => send(res, e.code === '42501' ? 403 : 400, { code: e.code ?? 'XX000', message: e.message, details: null, hint: null })

const server = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', async () => {
    const url = new URL(req.url, `http://localhost:${PORT}`)
    const body = raw ? JSON.parse(raw) : null
    const sub = subOf(req)
    try {
      // Auth
      if (url.pathname === '/auth/v1/health') return send(res, 200, { name: 'dryrun' })
      if (url.pathname === '/auth/v1/token') {
        if (url.searchParams.get('grant_type') === 'password') {
          const u = (await db.query('select id, email from auth.users where lower(email) = lower($1)', [body.email])).rows[0]
          if (!u || body.password !== PASSWORD) return send(res, 400, { code: 'invalid_credentials', error_code: 'invalid_credentials', msg: 'Invalid login credentials' })
          return send(res, 200, session(u))
        }
        const uid = refreshTokens.get(body.refresh_token)
        if (!uid) return send(res, 400, { code: 'refresh_token_not_found', error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' })
        refreshTokens.delete(body.refresh_token)
        return send(res, 200, session((await db.query('select id, email from auth.users where id = $1', [uid])).rows[0]))
      }
      if (url.pathname === '/auth/v1/logout') {
        for (const [t, uid] of refreshTokens) if (uid === sub) refreshTokens.delete(t)
        return send(res, 204)
      }
      if (url.pathname === '/auth/v1/recover') return send(res, 200, {})
      if (url.pathname === '/auth/v1/user') {
        const u = (await db.query('select id, email from auth.users where id = $1', [sub])).rows[0]
        return u ? send(res, 200, { id: u.id, email: u.email, aud: 'authenticated', role: 'authenticated' }) : send(res, 401, { code: 'no_user', msg: 'no user' })
      }
      // Storage list (RLS on storage.objects applies)
      if (url.pathname.startsWith('/storage/v1/object/list/')) {
        const bucket = url.pathname.split('/').pop()
        const rows = await asCaller(sub, (tx) => tx.query(`select name from storage.objects where bucket_id = $1 and name like $2 || '%' limit $3`, [bucket, body?.prefix ?? '', body?.limit ?? 100]))
        return send(res, 200, rows.rows.map((r) => ({ name: r.name })))
      }
      // RPC
      if (url.pathname.startsWith('/rest/v1/rpc/')) {
        const fn = url.pathname.slice('/rest/v1/rpc/'.length)
        const meta = argTypes.get(fn)
        if (!meta) return send(res, 404, { code: 'PGRST202', message: `function ${fn} not found` })
        const names = Object.keys(body ?? {})
        const values = []
        const args = names.map((n) => {
          const i = (meta.proargnames ?? []).indexOf(n)
          if (i < 0) throw Object.assign(new Error(`function ${fn} has no argument ${n}`), { code: 'PGRST202' })
          const v = body[n]
          values.push(v === null ? null : typeof v === 'object' ? JSON.stringify(v) : String(v))
          return `${ident(n)} => $${values.length}::${meta.types[i]}`
        })
        const sql = meta.proretset ? `select to_jsonb(x) r from public.${ident(fn)}(${args.join(', ')}) x` : `select to_jsonb(public.${ident(fn)}(${args.join(', ')})) r`
        const rows = (await asCaller(sub, (tx) => tx.query(sql, values))).rows
        return send(res, 200, meta.proretset ? rows.map((r) => r.r) : rows[0]?.r ?? null)
      }
      // Tables / views
      if (url.pathname.startsWith('/rest/v1/')) {
        const table = ident(url.pathname.slice('/rest/v1/'.length))
        const values = []
        const where = filters(url.searchParams, values)
        const prefer = req.headers.prefer ?? ''
        const single = (req.headers.accept ?? '').includes('vnd.pgrst.object')
        let rows
        if (req.method === 'GET' || req.method === 'HEAD') {
          const cols = (url.searchParams.get('select') ?? '*').split(',').map((c) => (c.trim() === '*' ? '*' : ident(c.trim()))).join(', ')
          const limit = url.searchParams.get('limit') ? ` limit ${Number(url.searchParams.get('limit'))}` : ''
          rows = (await asCaller(sub, (tx) => tx.query(`select ${cols} from public.${table}${where}${limit}`, values))).rows
          const total = prefer.includes('count=exact')
            ? Number((await asCaller(sub, (tx) => tx.query(`select count(*)::int n from public.${table}${where}`, values))).rows[0].n) : rows.length
          const range = { 'Content-Range': `${rows.length ? `0-${rows.length - 1}` : '*'}/${total}` }
          if (req.method === 'HEAD') return send(res, 200, undefined, range)
          if (single) return rows.length === 1 ? send(res, 200, rows[0]) : send(res, 406, { code: 'PGRST116', message: `${rows.length} rows` })
          return send(res, 200, rows, range)
        }
        if (req.method === 'PATCH') {
          const sets = Object.keys(body).map((k) => { values.push(body[k] === null ? null : typeof body[k] === 'object' ? JSON.stringify(body[k]) : String(body[k])); return `${ident(k)} = $${values.length}` })
          rows = (await asCaller(sub, (tx) => tx.query(`update public.${table} set ${sets.join(', ')}${where} returning *`, values))).rows
        } else if (req.method === 'POST') {
          const items = Array.isArray(body) ? body : [body]
          rows = []
          for (const item of items) {
            const vals = []
            const cols = Object.keys(item)
            const ph = cols.map((k) => { vals.push(item[k] === null ? null : typeof item[k] === 'object' ? JSON.stringify(item[k]) : String(item[k])); return `$${vals.length}` })
            rows.push(...(await asCaller(sub, (tx) => tx.query(`insert into public.${table} (${cols.map(ident).join(', ')}) values (${ph.join(', ')}) returning *`, vals))).rows)
          }
        } else return send(res, 405, { message: 'method not emulated' })
        if (!prefer.includes('return=representation')) return send(res, 204)
        if (single) return rows.length === 1 ? send(res, 200, rows[0]) : send(res, 406, { code: 'PGRST116', message: `${rows.length} rows` })
        return send(res, 200, rows)
      }
      return send(res, 404, { message: `not emulated: ${url.pathname}` })
    } catch (e) {
      return pgError(res, e)
    }
  })
})
server.keepAliveTimeout = 120_000
await new Promise((r) => server.listen(PORT, r))

const env = { ...process.env, VITE_SUPABASE_URL: `http://localhost:${PORT}`, VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_local_dryrun_only',
  STAGING_EMAIL_PREFIX: 'qa', STAGING_EMAIL_DOMAIN: 'example.invalid', STAGING_TEST_PASSWORD: PASSWORD, CONFIRM_STAGING: 'yes' }
const run = (script) => new Promise((resolve) => {
  const p = spawn(process.execPath, [path.join(root, 'scripts', script)], { env, cwd: root })
  let out = ''
  p.stdout.on('data', (d) => (out += d))
  p.stderr.on('data', (d) => (out += d))
  p.on('close', (code) => resolve({ code, out }))
})

console.log('Dry run against a LOCAL emulation (PGlite serialises requests: script logic and rules are validated, true simultaneity is NOT).\n')
const verify = await run('verify-supabase.mjs')
console.log('--- scripts/verify-supabase.mjs ---\n' + verify.out)
const conc = await run('concurrency-check.mjs')
console.log('--- scripts/concurrency-check.mjs ---\n' + conc.out)
const leaked = [verify.out, conc.out].some((o) => o.includes(PASSWORD))
console.log(`secret printed in any output: ${leaked ? 'YES (FAIL)' : 'no'}`)
server.close()
// verify exits 3 locally by design: the password-reset email is NOT RUN without STAGING_SEND_RESET_EMAIL.
const ok = !leaked && verify.code === 3 && !/^FAIL /m.test(verify.out) && conc.code === 0
console.log(`\nDry run: ${ok ? 'PASS' : 'FAIL'} (verify exit ${verify.code}, concurrency exit ${conc.code})`)
process.exit(ok ? 0 : 1)
