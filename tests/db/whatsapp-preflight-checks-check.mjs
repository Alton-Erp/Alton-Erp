// WhatsApp preflight version 2 (migration 20261220090000): one result per Meta check with its own reason,
// the production #100 errors explained, registration separate from WABA membership, unique blockers,
// webhook evidence in levels (challenge, signed POST, events for this account), stale evidence ignored.
//
//   npm run test:db:whatsapp-preflight-checks
//
// Local PGlite database only. The Edge Function's part is played by the service role.

import { readdir, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p) => readFile(p, 'utf8')
const migDir = path.join(root, 'supabase', 'migrations')
const NAME = '20261220090000_whatsapp_preflight_checks'
const db = new PGlite()
await db.exec(await read(path.join(root, 'supabase', 'tests', 'local_supabase_shim.sql')))
const files = (await readdir(migDir)).filter((x) => x.endsWith('.sql')).sort()
for (const f of files.filter((x) => x < `${NAME}.sql`)) await db.exec(await read(path.join(migDir, f)))
let suite = await read(path.join(root, 'supabase', 'tests', 'stage7_e2e_verification.sql'))
suite = suite.slice(0, suite.lastIndexOf('\ndo $$'))
await db.exec(suite)
await db.exec('commit')

let failed = 0
let passed = 0
const ok = (name, cond, detail = '') => {
  if (cond) passed++
  else failed++
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 900)}`}`)
}
const val = async (sql, params) => { await db.exec('reset role'); return Object.values((await db.query(sql, params)).rows[0] ?? {})[0] }
async function request(user, sql, params, role = 'authenticated') {
  await db.exec('reset role')
  await db.exec('begin')
  try {
    if (user) await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: await val(`select rls_test.id($1)`, [user]), role })])
    else await db.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`)
    await db.exec(`set local role ${role}`)
    const r = await db.query(sql, params)
    await db.exec('commit')
    return { value: Object.values(r.rows[0] ?? {})[0] }
  } catch (e) {
    try { await db.exec('rollback') } catch { /* ended */ }
    return { error: e.message }
  }
}
const op = async (sql, params) => { const r = await request('op', sql, params); if (r.error) throw new Error(`op: ${sql.slice(0, 90)}… → ${r.error}`); return r.value }
const svc = async (sql, params) => { const r = await request(null, sql, params, 'service_role'); if (r.error) throw new Error(`service: ${sql.slice(0, 90)}… → ${r.error}`); return r.value }

// Production values (non-secret identifiers). 1384691633548975 = the id Meta's console showed as messaging account.
const IDS = { business_portfolio_id: '3489020898058707', waba_id: '1973917729842030', phone_number_id: '1425662810634514', display_phone_number: '+9118001239722',
  app_id: '1684047306664863', graph_api_version: 'v23.0' }
const REAL_WABA = '1384691633548975'
const PHONE = { display_phone_number: '+91 1800 123 9722', verified_name: 'Alton India', quality_rating: 'GREEN', status: 'CONNECTED', platform_type: 'CLOUD_API' }
const at = () => new Date().toISOString()
const V = (status, extra = {}, err = null) => ({ status, verified: status === 'VERIFIED', error_code: err?.code ?? null, error_message: err?.message ?? null, checked_at: at(), ...extra })
const GOOD = (ids = IDS) => ({ version: 2, checked_at: at(), waba_id: ids.waba_id, phone_number_id: ids.phone_number_id, app_id: ids.app_id, checks: {
  phone_registration: V('VERIFIED', { phone_status: 'CONNECTED', platform_type: 'CLOUD_API', display_phone_number: '+91 1800 123 9722', verified_name: 'Alton India', quality_rating: 'GREEN' }),
  waba: V('VERIFIED', { waba_type: 'whatsapp_business_account', waba_name: 'Alton India', account_review_status: 'APPROVED' }),
  ownership: V('VERIFIED', { owner_business_id: IDS.business_portfolio_id, owner_business_name: 'Alton Hi-Tech' }),
  phone_in_waba: V('VERIFIED', { waba_phone_count: 1 }),
  subscription: V('VERIFIED', { subscribed_app_ids: [IDS.app_id] }),
  token: V('VERIFIED', { token_type: 'SYSTEM_USER', expires_at: 0, scopes: ['whatsapp_business_messaging', 'whatsapp_business_management'], token_waba_ids: [ids.waba_id], describable: true }),
  app_secret: { configured: true, checked_at: at() } } })
const with_ = (patch) => { const g = GOOD(); g.checks = { ...g.checks, ...patch }; return g }
let ACCOUNT
const get = () => op(`select public.support_whatsapp_config_get()`)
const pf = async () => (await get()).preflight
const ck = (p, key) => p.checks.find((c) => c.key === key)
const verify = (v) => svc(`select public.support_whatsapp_verification_result($1, $2::jsonb)`, [ACCOUNT, JSON.stringify(v)])
const key = (o) => createHash('sha256').update(JSON.stringify(o)).digest('hex')
const ingest = (entry, value, k = null) => svc(`select public.support_whatsapp_ingest($1, $2, 'messages', $3::jsonb, $4)`, [ACCOUNT, entry, JSON.stringify(value), k ?? key({ entry, value })])
const statusEvent = (phoneId, id = 'wamid.T1') => ({ messaging_product: 'whatsapp', metadata: { display_phone_number: '9118001239722', phone_number_id: phoneId },
  statuses: [{ id, status: 'sent', timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: '919876543210' }] })
const unique = (arr) => new Set(arr).size === arr.length

// Production-like state on 20261219090000: Cloud API usage, test passed, challenge verified, version-1 evidence with the #100 errors.
const saved = await op(`select public.support_whatsapp_config_save($1::jsonb)`, [JSON.stringify({ ...IDS, number_path: 'CLOUD_API' })])
ACCOUNT = saved.config.channel_account_id
await svc(`select public.support_whatsapp_test_result($1, true, $2::jsonb, 'Connected: Alton India +91 1800 123 9722 on the Cloud API, quality GREEN.')`, [ACCOUNT, JSON.stringify(PHONE)])
await svc(`select public.support_whatsapp_webhook_verified($1)`, [ACCOUNT])
const v0 = (await get()).preflight // before the first verification: what the screen showed first
await svc(`select public.support_whatsapp_verification_result($1, $2::jsonb)`, [ACCOUNT, JSON.stringify({ checked_at: at(), waba_id: IDS.waba_id, phone_number_id: IDS.phone_number_id,
  app_id: IDS.app_id, phone_in_waba: null, waba_error: '(#100) Tried accessing nonexisting field (phone_numbers) (100)', owner_error: '(#100) Tried accessing nonexisting field (name) (100)' })])
const v1 = (await get()).preflight
console.log(`✓ before ${NAME} (production state): ${v1.status}; blockers:\n    - ${v1.blockers.join('\n    - ')}`)

await db.exec(await read(path.join(migDir, `${NAME}.sql`)))
await db.exec(await read(path.join(migDir, `${NAME}.sql`)))
console.log(`✓ ${NAME} applied (twice)`)

// ---------------------------------------------------------------------------
console.log('\nOne result per check; no repeated or stale messages')
ok('reproduced: before the fix the registration line wrongly said "not CONNECTED" although the test saw CONNECTED',
  v1.blockers.some((b) => /does not report this number as CONNECTED/.test(b)), v1.blockers)
ok('reproduced: before the first verification several checks had the identical text the screen used as list key (stale lines)',
  v0.blockers.filter((b) => b === 'Not verified yet: run Test connection.').length >= 3, v0.blockers)
let p = await pf()
ok('version-1 evidence counts as not tested; each check says which check it is', ['phone_registration', 'waba', 'phone_in_waba', 'business_portfolio', 'access_token', 'webhook_subscription', 'app_secret']
  .every((k) => ck(p, k).result === 'PENDING' && ck(p, k).reason === 'NOT_TESTED'), p.checks.map((c) => `${c.key}:${c.reason}`))
ok('18. no duplicate blocker texts', unique(p.blockers) && p.blockers.every((b) => b !== 'Not verified yet: run Test connection.'), p.blockers)
ok('the app cannot record Meta evidence; version-1 evidence is refused', Boolean((await request('op', `select public.support_whatsapp_verification_result($1, $2::jsonb)`, [ACCOUNT, JSON.stringify(GOOD())])).error)
  && Boolean((await request(null, `select public.support_whatsapp_verification_result($1, '{"waba_id":"1"}'::jsonb)`, [ACCOUNT], 'service_role')).error))

// ---------------------------------------------------------------------------
console.log('\nThe production #100 errors, classified')
await verify(with_({
  waba: V('INVALID_REQUEST', { waba_type: null, hint: 'Meta answered that 1973917729842030 has no WhatsApp Business Account field: the id is probably not a WABA id.' }, { code: 100, message: '(#100) Tried accessing nonexisting field (name) (100)' }),
  ownership: V('INVALID_REQUEST', {}, { code: 100, message: '(#100) Tried accessing nonexisting field (owner_business_info) (100)' }),
  phone_in_waba: V('INVALID_REQUEST', { suggested_waba_id: REAL_WABA }, { code: 100, message: '(#100) Tried accessing nonexisting field (phone_numbers) (100)' }),
  subscription: V('INVALID_REQUEST', {}, { code: 100, message: '(#100) Tried accessing nonexisting field (subscribed_apps) (100)' }) }))
p = await pf()
ok('6. registration evaluated on its own: CONNECTED is verified (not reported as "not CONNECTED")', ck(p, 'phone_registration').result === 'OK' && !p.blockers.some((b) => /not CONNECTED|does not report/.test(b)), ck(p, 'phone_registration'))
ok('8. invalid field #100 shown as an invalid request with Meta\'s code and the explanation', ck(p, 'waba').reason === 'INVALID_REQUEST' && ck(p, 'waba').error_code === 100
  && /invalid request — \(#100\) Tried accessing nonexisting field \(name\).*probably not a WABA id/.test(ck(p, 'waba').detail), ck(p, 'waba'))
ok('the WABA that actually lists the number is named (diagnostic only)', /under WhatsApp Business Account 1384691633548975; check the configured id \(nothing was changed\)/.test(ck(p, 'phone_in_waba').detail), ck(p, 'phone_in_waba'))
ok('the derived eligibility line does not repeat the reasons; every blocker is unique', !p.blockers.some((b) => /Follows the two checks/.test(b)) && unique(p.blockers) && p.eligibility === 'BLOCKED', p.blockers)
ok('20. activation blocked with the exact reasons', p.status === 'ELIGIBILITY_BLOCKED' && p.can_activate === false
  && /cannot be switched on yet \(eligibility blocked\).*nonexisting field/.test((await request('op', `select public.support_whatsapp_set_enabled(true)`)).error ?? ''))
await verify(with_({ waba: V('WRONG_ACCOUNT', { waba_type: 'whatsapp_business_phone_number', suggested_waba_id: REAL_WABA },
  { code: null, message: 'Id 1973917729842030 is a whatsapp business phone number, not a WhatsApp Business Account, so its name cannot be read.' }) }))
ok('9. id of another object type: wrong account, with the type named', ck(await pf(), 'waba').reason === 'WRONG_ACCOUNT' && /is a whatsapp business phone number, not a WhatsApp Business Account/.test(ck(await pf(), 'waba').detail))
await verify(with_({ phone_registration: V('INVALID_REQUEST', {}, { code: 100, message: "Unsupported get request. Object with ID '1425662810634599' does not exist (100)" }) }))
ok('10. invalid phone number id: invalid request', ck(await pf(), 'phone_registration').reason === 'INVALID_REQUEST' && /does not exist/.test(ck(await pf(), 'phone_registration').detail))
await verify(with_({ phone_registration: V('VERIFICATION_FAILED', { phone_status: 'DISCONNECTED' }, { code: null,
  message: 'Meta reports status DISCONNECTED: not connected: the number is not registered on the Cloud API (it may be on the WhatsApp Business app or another platform). CONNECTED is required.' }) }))
p = await pf()
ok('7. non-CONNECTED status: the exact status and its meaning; activation blocked', ck(p, 'phone_registration').result === 'BLOCKED' && /status DISCONNECTED: not connected/.test(ck(p, 'phone_registration').detail) && !p.can_activate)

// ---------------------------------------------------------------------------
console.log('\nAll verified, then each genuine problem')
await verify(GOOD())
p = await pf()
ok('1.–6. WABA, phone numbers edge, subscribed apps, ownership, number match and CONNECTED all verified', ['waba', 'phone_registration', 'phone_in_waba', 'business_portfolio', 'webhook_subscription', 'access_token', 'app_secret']
  .every((k) => ck(p, k).result === 'OK' && ck(p, k).reason === 'VERIFIED'), p.checks.map((c) => `${c.key}:${c.result}`))
ok('16. challenge verified but no signed POST yet: that one check pending, with its own text', ck(p, 'webhook_verified').result === 'OK' && ck(p, 'webhook_signed').result === 'PENDING'
  && p.status === 'PENDING_VERIFICATION' && p.blockers.length === 1 && /Signed webhook POST: none received yet/.test(p.blockers[0]), p.blockers)
const test1 = await ingest('0', statusEvent('123456123'))
p = await pf()
ok('17. a signed POST (e.g. Meta\'s webhook "Test" sample, other account) proves the signature check: Ready to activate',
  test1.result === 'REJECTED' && ck(p, 'webhook_signed').result === 'OK' && ck(p, 'webhook_account').mandatory === false && p.status === 'READY_TO_ACTIVATE', [test1, p.blockers])
ok('the webhook challenge alone never counts as a signed event or a customer message', p.delivery.inbound_proven === false && p.delivery.inbound_messages === 0)
await verify(with_({ ownership: V('VERIFIED', { owner_business_id: '999999999999', owner_business_name: 'Someone else' }) }))
ok('4. WABA owned by another portfolio: wrong account', ck(await pf(), 'business_portfolio').reason === 'WRONG_ACCOUNT' && /owned by portfolio 999999999999.*not the configured 3489020898058707/.test(ck(await pf(), 'business_portfolio').detail))
await verify(with_({ ownership: V('PERMISSION_DENIED', {}, { code: 200, message: 'Permissions error (200)' }) }))
ok('ownership that Meta refuses to show: permission denied, never marked verified', ck(await pf(), 'business_portfolio').reason === 'PERMISSION_DENIED' && (await pf()).can_activate === false)
await verify(with_({ token: V('PERMISSION_DENIED', { scopes: ['whatsapp_business_messaging'], describable: true }, { code: null, message: 'The access token is missing the permission(s): whatsapp_business_management.' }) }))
ok('11. missing permission: permission denied, permission named', ck(await pf(), 'access_token').reason === 'PERMISSION_DENIED' && /whatsapp_business_management/.test(ck(await pf(), 'access_token').detail))
await verify(with_({ token: V('VERIFICATION_FAILED', { describable: false }, { code: 190, message: 'Meta refused the access token (190): it expired or is invalid.' }) }))
await op(`select public.support_whatsapp_checklist_set('system_user_token', true, 'Confirmed by admin')`)
ok('12. expired token (190): blocked, and a checklist tick does not override it', ck(await pf(), 'access_token').result === 'BLOCKED' && ck(await pf(), 'access_token').error_code === 190)
await verify(with_({ token: V('VERIFICATION_FAILED', { describable: false }, { code: null, message: 'Meta could not be reached.' }) }))
ok('token not describable (Meta unreachable): the administrator\'s confirmation is the fallback', ck(await pf(), 'access_token').result === 'OK' && ck(await pf(), 'access_token').source === 'ADMIN')
await op(`select public.support_whatsapp_checklist_set('system_user_token', false, null)`)
await verify(with_({ subscription: V('WRONG_ACCOUNT', { subscribed_app_ids: ['111111111111'] }, { code: null, message: 'App 1684047306664863 is not subscribed to WhatsApp Business Account 1973917729842030 (subscribed: 111111111111).' }) }))
ok('app not subscribed: wrong account', ck(await pf(), 'webhook_subscription').reason === 'WRONG_ACCOUNT')
await verify(with_({ app_secret: { configured: false, checked_at: at() } }))
p = await pf()
ok('13. WHATSAPP_APP_SECRET missing: that exact configuration reported, activation blocked', ck(p, 'app_secret').result === 'BLOCKED' && /WHATSAPP_APP_SECRET is not set/.test(ck(p, 'app_secret').detail) && !p.can_activate)
await verify(GOOD())

// ---------------------------------------------------------------------------
console.log('\nWebhook evidence in levels; wrong WABA seen from Meta\'s own signed events')
const foreign = await ingest(REAL_WABA, statusEvent(IDS.phone_number_id, 'wamid.T2'))
p = await pf()
ok('signed events for THIS phone number under another WABA: rejected, and reported as the wrong account (mandatory)', foreign.result === 'REJECTED'
  && ck(p, 'webhook_account').reason === 'WRONG_ACCOUNT' && ck(p, 'webhook_account').mandatory === true && new RegExp(`under WhatsApp Business Account ${REAL_WABA}`).test(ck(p, 'webhook_account').detail)
  && p.status === 'ELIGIBILITY_BLOCKED', ck(p, 'webhook_account'))
await ingest(IDS.waba_id, statusEvent(IDS.phone_number_id, 'wamid.T3'))
p = await pf()
ok('a signed event for the configured WABA: accepted, Ready to activate', ck(p, 'webhook_account').result === 'OK' && p.status === 'READY_TO_ACTIVATE', p.blockers)
const on = await request('op', `select public.support_whatsapp_set_enabled(true)`)
ok('activation succeeds when every mandatory check passes: ACTIVE', !on.error && (await pf()).status === 'ACTIVE', on.error)

// ---------------------------------------------------------------------------
console.log('\nStale evidence, isolation, rollback')
await op(`select public.support_whatsapp_config_save($1::jsonb)`, [JSON.stringify({ ...IDS, waba_id: REAL_WABA, number_path: 'CLOUD_API' })])
p = await pf()
ok('19. after the WABA id changes, the earlier verification no longer counts (not tested) and the integration is off', ck(p, 'waba').reason === 'NOT_TESTED' && p.evidence_stale === true
  && (await val(`select integration_enabled from public.support_whatsapp_config`)) === false, p.checks.map((c) => `${c.key}:${c.reason}`))
await verify(GOOD({ ...IDS, waba_id: REAL_WABA }))
ok('a fresh verification for the new id counts again', ck(await pf(), 'waba').reason === 'VERIFIED' && (await pf()).evidence_stale === false)
ok('evidence never stores a token (whitelisted fields only)', !(await val(`select meta_verification::text from public.support_whatsapp_config`)).includes('EAAG')
  && await (async () => { await verify({ ...GOOD({ ...IDS, waba_id: REAL_WABA }), access_token: 'EAAGsecret', checks: { ...GOOD({ ...IDS, waba_id: REAL_WABA }).checks, token: { ...GOOD().checks.token, access_token: 'EAAGsecret' } } })
    return !(await val(`select meta_verification::text from public.support_whatsapp_config`)).includes('EAAG') })())
ok('another company sees no WhatsApp settings', (await request('b_op', `select public.support_whatsapp_config_get() -> 'config'`)).value === null)
ok('settings read works in a read-only transaction', await (async () => {
  await db.exec('reset role'); await db.exec('begin read only')
  try {
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: await val(`select rls_test.id('op')`), role: 'authenticated' })])
    await db.exec('set local role authenticated'); await db.query(`select public.support_whatsapp_config_get()`); await db.exec('commit'); return true
  } catch { try { await db.exec('rollback') } catch { /* */ } return false }
})())
await db.exec(await read(path.join(root, 'supabase', 'rollback', `${NAME}_down.sql`)))
ok('rollback restores 20261219090000 (helpers removed, version-2 evidence cleared, messages kept)', (await val(`select to_regprocedure('private.support_whatsapp_meta_part(jsonb, text, text)')::text`)) === null
  && (await val(`select meta_verification::text from public.support_whatsapp_config`)) === '{}' && Number(await val(`select count(*) from public.support_whatsapp_webhook_events`)) >= 3)
await db.exec(await read(path.join(migDir, `${NAME}.sql`)))
ok('re-applying works', (await val(`select to_regprocedure('private.support_whatsapp_meta_part(jsonb, text, text)')::text`)) !== null)

console.log(`\n${failed === 0 ? '✓' : '✗'} WhatsApp preflight checks: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
