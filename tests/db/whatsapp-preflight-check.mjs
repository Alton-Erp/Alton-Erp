// WhatsApp activation preflight (migration 20261219090000): a number already on the Cloud API under this WABA
// becomes Ready to activate from Meta's own evidence; wrong ids / portfolio / token / subscription block it,
// ticks never override Meta, migration and coexistence stay conditional, delivery is never inferred.
//
//   npm run test:db:whatsapp-preflight
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
const NAME = '20261219090000_whatsapp_activation_preflight'
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
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 700)}`}`)
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

// Values of the Alton India setup (non-secret identifiers only).
const IDS = { business_portfolio_id: '3489020898058707', waba_id: '1973917729842030', phone_number_id: '1425662810634514', display_phone_number: '+9118001239722',
  app_id: '1684047306664863', graph_api_version: 'v23.0' }
const PHONE = { display_phone_number: '+91 1800 123 9722', verified_name: 'Alton India', quality_rating: 'GREEN', status: 'CONNECTED', platform_type: 'CLOUD_API', code_verification_status: 'VERIFIED' }
const GOOD = () => ({ checked_at: new Date().toISOString(), waba_id: IDS.waba_id, phone_number_id: IDS.phone_number_id, app_id: IDS.app_id, phone_in_waba: true, waba_phone_count: 1,
  waba_error: null, owner_business_id: IDS.business_portfolio_id, owner_business_name: 'Alton Hi-Tech Sanitary Ware', waba_name: 'Alton India', account_review_status: 'APPROVED',
  owner_error: null, subscribed_app_ids: [IDS.app_id], subscribed_error: null, token_error: null,
  token: { is_valid: true, type: 'SYSTEM_USER', app_id: IDS.app_id, expires_at: 0, scopes: ['whatsapp_business_messaging', 'whatsapp_business_management', 'business_management'],
    targets: { whatsapp_business_messaging: [IDS.waba_id], whatsapp_business_management: [IDS.waba_id] } } })
let ACCOUNT
const get = () => op(`select public.support_whatsapp_config_get()`)
const pf = async () => (await get()).preflight
const check = (pre, key) => pre.checks.find((c) => c.key === key)
const verify = (v) => svc(`select public.support_whatsapp_verification_result($1, $2::jsonb)`, [ACCOUNT, JSON.stringify(v)])
const testResult = (okFlag, info = PHONE, msg = 'Connected: Alton India +91 1800 123 9722 on the Cloud API, quality GREEN.') =>
  svc(`select public.support_whatsapp_test_result($1, $2, $3::jsonb, $4)`, [ACCOUNT, okFlag, JSON.stringify(info), msg])
const key = (o) => createHash('sha256').update(JSON.stringify(o)).digest('hex')
const meta = { display_phone_number: '9118001239722', phone_number_id: IDS.phone_number_id }
const ingest = (value, k = null) => svc(`select public.support_whatsapp_ingest($1, $2, 'messages', $3::jsonb, $4)`, [ACCOUNT, IDS.waba_id, JSON.stringify(value), k ?? key(value)])
const textMsg = (id, from, body) => ({ messaging_product: 'whatsapp', metadata: meta, contacts: [{ profile: { name: 'Customer' }, wa_id: from }],
  messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000) - 30), type: 'text', text: { body } }] })
const enable = () => request('op', `select public.support_whatsapp_set_enabled(true)`)

// The state before this migration (as in production): Cloud API usage, test passed, webhook verified and signed, no ticks.
const saved = await op(`select public.support_whatsapp_config_save($1::jsonb)`, [JSON.stringify({ ...IDS, number_path: 'CLOUD_API' })])
ACCOUNT = saved.config.channel_account_id
await testResult(true)
await svc(`select public.support_whatsapp_webhook_verified($1)`, [ACCOUNT])
await ingest({ messaging_product: 'whatsapp', metadata: meta, statuses: [] })
const beforeState = await val(`select setup_state from public.support_whatsapp_config`)
const beforeMsgs = await val(`select count(*)::int from public.support_whatsapp_messages`)
console.log(`✓ before ${NAME}: Cloud API usage, test passed, webhook verified and signed → ${beforeState} (the reported problem)`)

await db.exec(await read(path.join(migDir, `${NAME}.sql`)))
await db.exec(await read(path.join(migDir, `${NAME}.sql`)))
console.log(`✓ ${NAME} applied (twice)`)

// ---------------------------------------------------------------------------
console.log('\nRoot cause reproduced, then fixed by Meta evidence')
ok('reproduced: before the fix the state stayed Number Eligibility Pending although the test passed', beforeState === 'NUMBER_ELIGIBILITY_PENDING')
ok('deploying the migration changes no state by itself (no recomputation, no message touched)',
  (await val(`select setup_state from public.support_whatsapp_config`)) === beforeState && (await val(`select count(*)::int from public.support_whatsapp_messages`)) === beforeMsgs)
let p = await pf()
ok('without account verification: Pending verification, with the exact reason', p.status === 'PENDING_VERIFICATION' && p.can_activate === false
  && p.blockers.some((b) => /run Test connection/.test(b)), p.blockers)
ok('the app cannot record Meta evidence', Boolean((await request('op', `select public.support_whatsapp_verification_result($1, '{}'::jsonb)`, [ACCOUNT])).error))
await verify(GOOD())
p = await pf()
ok('1. phone number id belongs to the configured WABA (Meta evidence)', check(p, 'phone_in_waba').result === 'OK' && check(p, 'phone_in_waba').source === 'META')
ok('2. WABA belongs to the configured business portfolio', check(p, 'business_portfolio').result === 'OK' && /3489020898058707/.test(check(p, 'business_portfolio').detail))
ok('3. already registered Cloud API number: eligibility Verified without any manual tick', p.eligibility === 'VERIFIED' && check(p, 'cloud_api_eligibility').source === 'META'
  && check(p, 'number_path_confirmed').result === 'OK')
ok('4. quality GREEN reported (recommended check)', check(p, 'quality_rating').result === 'OK' && check(p, 'quality_rating').mandatory === false)
ok('5./6./7. connection test, webhook verification and signed webhook all OK', ['connection_test', 'webhook_verified', 'webhook_signed'].every((k) => check(p, k).result === 'OK'))
ok('token: permanent system-user token with both permissions for this WABA', check(p, 'access_token').result === 'OK' && check(p, 'access_token').source === 'META')
ok('webhook subscription verified from Meta (subscribed apps)', check(p, 'webhook_subscription').result === 'OK')
ok('no migration or coexistence step for this usage', !p.checks.some((c) => ['migration_completed', 'coexistence_approved', 'previous_routing_retired'].includes(c.key)))
ok('all mandatory checks pass: Ready to activate, stored state Connected, Switch on allowed', p.status === 'READY_TO_ACTIVATE' && p.can_activate === true && p.blockers.length === 0
  && (await val(`select setup_state from public.support_whatsapp_config`)) === 'CONNECTED')
const cfg = await get()
ok('checklist: manual items Meta has verified are not required any more and are marked as verified', cfg.checklist_items.filter((i) => ['cloud_api_eligibility', 'number_path_confirmed', 'system_user_token', 'webhook_subscribed'].includes(i.key))
  .every((i) => i.required === false && i.verified_by_meta === true && i.done === false), cfg.checklist_items)
ok('channel status detail says Ready to activate', /Ready to activate/.test((await val(`select status_detail from public.support_channel_accounts where id = $1`, [ACCOUNT])) ?? ''))
ok('message delivery is not claimed: webhook challenge and signed event are no customer message', p.delivery.inbound_proven === false && p.delivery.outbound_proven === false
  && p.delivery.inbound_messages === 0)
const on = await enable()
ok('15. activation succeeds: ACTIVE', !on.error && (await pf()).status === 'ACTIVE' && (await val(`select integration_enabled from public.support_whatsapp_config`)) === true, on.error)

// ---------------------------------------------------------------------------
console.log('\nGenuine problems block activation (ticks never override Meta)')
const blockedBy = async (mutate, key2, pattern) => {
  await verify(mutate(GOOD()))
  const q = await pf()
  const c = check(q, key2)
  return { q, c, good: c?.result === 'BLOCKED' && q.status === 'ELIGIBILITY_BLOCKED' && q.can_activate === false && (!pattern || pattern.test(c.detail)) }
}
let r = await blockedBy((v) => ({ ...v, phone_in_waba: false, waba_phone_count: 1 }), 'phone_in_waba', /NOT under WABA 1973917729842030/)
ok('8. wrong WABA (number not listed under it): blocked with the exact reason', r.good, r.c)
ok('a blocked integration is switched off automatically (one gate for state and activation)', (await val(`select integration_enabled from public.support_whatsapp_config`)) === false)
for (const k of ['cloud_api_eligibility', 'number_path_confirmed', 'system_user_token', 'webhook_subscribed']) await op(`select public.support_whatsapp_checklist_set($1, true, 'Ticked by admin 2026-11-18')`, [k])
ok('ticking every checklist item does not override Meta\'s answer', (await pf()).status === 'ELIGIBILITY_BLOCKED')
const refusedOn = await enable()
ok('16. Switch on refused, listing the reason', /cannot be switched on yet \(eligibility blocked\).*NOT under WABA/.test(refusedOn.error ?? ''), refusedOn.error)
for (const k of ['cloud_api_eligibility', 'number_path_confirmed', 'system_user_token', 'webhook_subscribed']) await op(`select public.support_whatsapp_checklist_set($1, false, null)`, [k])
r = await blockedBy((v) => ({ ...v, owner_business_id: '1384691633548975', owner_business_name: 'Other portfolio' }), 'business_portfolio', /owned by portfolio 1384691633548975.*not the configured 3489020898058707/)
ok('2b. WABA owned by another business portfolio: blocked', r.good, r.c)
r = await blockedBy((v) => ({ ...v, owner_business_id: null, owner_error: 'Unsupported get request (100)' }), 'business_portfolio', /Could not be verified/)
ok('ownership that Meta does not confirm keeps activation blocked', r.good, r.c)
r = await blockedBy((v) => ({ ...v, token: { ...v.token, is_valid: false } }), 'access_token', /invalid/)
ok('10. invalid / expired token: blocked', r.good, r.c)
r = await blockedBy((v) => ({ ...v, token: { ...v.token, expires_at: Math.floor(Date.now() / 1000) + 86400 * 30 } }), 'access_token', /permanent/)
ok('expiring (not permanent) token: blocked', r.good, r.c)
r = await blockedBy((v) => ({ ...v, token: { ...v.token, scopes: ['whatsapp_business_messaging'] } }), 'access_token', /missing: whatsapp_business_management/)
ok('11. missing permission: blocked, the permission named', r.good, r.c)
r = await blockedBy((v) => ({ ...v, token: { ...v.token, targets: { whatsapp_business_messaging: ['1384691633548975'], whatsapp_business_management: [IDS.waba_id] } } }), 'access_token', /does not include WABA/)
ok('token limited to another WABA: blocked', r.good, r.c)
r = await blockedBy((v) => ({ ...v, subscribed_app_ids: ['999999999999'] }), 'webhook_subscription', /not subscribed/)
ok('12. app not subscribed to the WABA\'s webhooks: blocked', r.good, r.c)
await op(`select public.support_whatsapp_checklist_set('webhook_subscribed', true, 'Ticked')`)
ok('…and a manual tick does not override it', (await pf()).status === 'ELIGIBILITY_BLOCKED')
await op(`select public.support_whatsapp_checklist_set('webhook_subscribed', false, null)`)
await verify({ ...GOOD(), token: null, token_error: 'Meta could not be reached.' })
ok('token not describable by Meta: pending until an administrator confirms it (fallback only then)', check(await pf(), 'access_token').result === 'PENDING')
await op(`select public.support_whatsapp_checklist_set('system_user_token', true, 'Permanent token created 2026-11-17')`)
ok('…confirmed: Ready to activate again (source Admin)', (await pf()).status === 'READY_TO_ACTIVATE' && check(await pf(), 'access_token').source === 'ADMIN')
await op(`select public.support_whatsapp_checklist_set('system_user_token', false, null)`)
await testResult(false, {}, 'Meta refused the access token (190): it expired or is invalid. Replace WHATSAPP_ACCESS_TOKEN.')
p = await pf()
ok('10b. connection test failing with 190: Error, reason shown', p.status === 'ERROR' && p.blockers.some((b) => /190/.test(b)), p.blockers)
await testResult(true)
await verify(GOOD())
ok('test passing again with good evidence: Ready to activate', (await pf()).status === 'READY_TO_ACTIVATE')

// ---------------------------------------------------------------------------
console.log('\nWrong phone number id, stale evidence, conditional onboarding')
await op(`select public.support_whatsapp_config_save($1::jsonb)`, [JSON.stringify({ ...IDS, phone_number_id: '1384691633548975', number_path: 'CLOUD_API' })])
p = await pf()
ok('9. another phone number id: earlier evidence no longer counts (pending, test needed again)', p.status === 'PENDING_VERIFICATION' && check(p, 'phone_in_waba').result === 'PENDING', p.status)
await testResult(true)
await verify({ ...GOOD(), phone_number_id: '1384691633548975', phone_in_waba: false })
ok('…and Meta does not list it under the WABA: blocked', (await pf()).status === 'ELIGIBILITY_BLOCKED')
await op(`select public.support_whatsapp_config_save($1::jsonb)`, [JSON.stringify({ ...IDS, number_path: 'BSP' })])
await testResult(true)
await verify(GOOD())
p = await pf()
ok('13. number on another provider: migration required before activation', p.status === 'ELIGIBILITY_BLOCKED' && check(p, 'migration_completed')?.result === 'BLOCKED'
  && p.can_activate === false && p.blockers.some((b) => /must first be migrated/.test(b)), p.checks.map((c) => `${c.key}:${c.result}`))
ok('…and its eligibility still needs a confirmation with evidence (not on the Cloud API yet)', check(p, 'cloud_api_eligibility').source === 'ADMIN' && check(p, 'cloud_api_eligibility').result === 'PENDING')
await op(`select public.support_whatsapp_config_save($1::jsonb)`, [JSON.stringify({ ...IDS, number_path: 'COEXISTENCE' })])
p = await pf()
ok('14. coexistence: coexistence approval and routing required; no migration step', check(p, 'coexistence_approved')?.mandatory === true && check(p, 'previous_routing_retired')?.mandatory === true
  && !check(p, 'migration_completed'))
await op(`select public.support_whatsapp_config_save($1::jsonb)`, [JSON.stringify({ ...IDS, number_path: 'CLOUD_API' })])
p = await pf()
ok('back to Cloud API usage: no coexistence or migration step required', !check(p, 'coexistence_approved') && !check(p, 'migration_completed'))
await testResult(true)
await verify(GOOD())
ok('changing the usage clears the earlier signed-webhook evidence (existing rule): pending until a new signed event', (await pf()).status === 'PENDING_VERIFICATION'
  && check(await pf(), 'webhook_signed').result === 'PENDING')
await ingest({ messaging_product: 'whatsapp', metadata: meta, statuses: [{ id: 'wamid.none', status: 'sent', timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: '1' }] })
const on2 = await enable()
ok('activated again after a fresh test and a new signed event', !on2.error && (await pf()).status === 'ACTIVE', on2.error)

// ---------------------------------------------------------------------------
console.log('\nMessages: idempotent inbound, outbound failure, delivery proof')
const in1 = await ingest(textMsg('wamid.PF1', '919876543210', 'Need a spare cartridge'))
const dupSame = await ingest(textMsg('wamid.PF1', '919876543210', 'Need a spare cartridge'))
const dupOther = await ingest(textMsg('wamid.PF1', '919876543210', 'Need a spare cartridge'), 'f'.repeat(64))
ok('17. the same message delivered twice (same and different event key): stored once', in1.result !== 'REJECTED' && dupSame.result === 'DUPLICATE'
  && Number(await val(`select count(*) from public.support_whatsapp_messages where wa_message_id = 'wamid.PF1'`)) === 1, [in1, dupSame, dupOther])
ok('inbound proven only by a real message from the configured phone number id', (await pf()).delivery.inbound_proven === true && (await pf()).delivery.inbound_messages === 1)
const other = await svc(`select public.support_whatsapp_ingest($1, $2, 'messages', $3::jsonb, $4)`, [ACCOUNT, IDS.waba_id,
  JSON.stringify({ ...textMsg('wamid.PF2', '919876543210', 'x'), metadata: { phone_number_id: '1384691633548975' } }), 'e'.repeat(64)])
ok('a message for another phone number id is rejected, not stored', other.result === 'REJECTED' && Number(await val(`select count(*) from public.support_whatsapp_messages where wa_message_id = 'wamid.PF2'`)) === 0)
await op(`select public.support_agent_save(null, jsonb_build_object('user_id', rls_test.id('op'), 'display_name', 'Operator'))`)
const conv = await val(`select conversation_id from public.support_whatsapp_messages where wa_message_id = 'wamid.PF1'`)
const out = await op(`select public.support_whatsapp_send_prepare($1::jsonb)`, [JSON.stringify({ kind: 'TEXT', idempotency_key: 'k00000000000000000pf1', conversation_id: conv, text: 'Test reply' })])
await svc(`select public.support_whatsapp_send_result($1, 'FAILED', null, null, 131047, 'Re-engagement message', 'More than 24 hours have passed', 400)`, [out.id])
p = await pf()
ok('18. outgoing failure recorded with Meta\'s error; not counted as delivered', p.delivery.outbound_failed === 1 && p.delivery.outbound_proven === false
  && (await val(`select status from public.support_whatsapp_messages where id = $1`, [out.id])) === 'FAILED', p.delivery)
const out2 = await op(`select public.support_whatsapp_send_prepare($1::jsonb)`, [JSON.stringify({ kind: 'TEXT', idempotency_key: 'k00000000000000000pf2', conversation_id: conv, text: 'Second reply' })])
await svc(`select public.support_whatsapp_send_result($1, 'ACCEPTED', 'wamid.OUTPF2', '919876543210', null, null, null, 200)`, [out2.id])
ok('accepted by Meta is not delivered yet', (await pf()).delivery.outbound_proven === false && (await pf()).delivery.outbound_accepted >= 1)
await ingest({ messaging_product: 'whatsapp', metadata: meta, statuses: [{ id: 'wamid.OUTPF2', status: 'delivered', timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: '919876543210' }] })
p = await pf()
ok('outbound proven only after Meta\'s delivered status callback', p.delivery.outbound_proven === true && p.delivery.outbound_delivered === 1 && p.delivery.status_callbacks >= 1, p.delivery)

// ---------------------------------------------------------------------------
console.log('\nSecurity, isolation, rollback')
await verify({ ...GOOD(), access_token: 'EAAGsecretvalue', token: { ...GOOD().token, access_token: 'EAAGsecretvalue' } })
ok('evidence keeps whitelisted fields only (a token sent by mistake is dropped)', !(await val(`select meta_verification::text from public.support_whatsapp_config`)).includes('EAAG'))
ok('settings read is read-only (runs in a read-only transaction)', !(await (async () => {
  await db.exec('reset role'); await db.exec('begin read only')
  try {
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: await val(`select rls_test.id('op')`), role: 'authenticated' })])
    await db.exec('set local role authenticated')
    await db.query(`select public.support_whatsapp_config_get()`)
    await db.exec('commit'); return null
  } catch (e) { try { await db.exec('rollback') } catch { /* */ } return e.message }
})()))
ok('another company sees no WhatsApp settings', (await request('b_op', `select public.support_whatsapp_config_get() -> 'config'`)).value === null)
const down = await read(path.join(root, 'supabase', 'rollback', `${NAME}_down.sql`))
await db.exec(down)
ok('rollback: preflight and evidence removed; messages kept', (await val(`select to_regprocedure('private.support_whatsapp_preflight(public.support_whatsapp_config)')::text`)) === null
  && (await val(`select count(*)::int from information_schema.columns where table_name = 'support_whatsapp_config' and column_name = 'meta_verification'`)) === 0
  && Number(await val(`select count(*) from public.support_whatsapp_messages`)) >= 3)
await db.exec(await read(path.join(migDir, `${NAME}.sql`)))
ok('re-applying works', (await val(`select to_regprocedure('private.support_whatsapp_preflight(public.support_whatsapp_config)')::text`)) !== null)

console.log(`\n${failed === 0 ? '✓' : '✗'} WhatsApp preflight check: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
