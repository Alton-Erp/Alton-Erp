// Customer Support pipelines (migration 20261227090000): default pipeline and stages, existing tickets placed by
// status (statuses untouched), moves through the existing status / closure / reopen rules, SLA pause, stage history,
// concurrent moves, status changes elsewhere following into the right stage, Manage Stages validation and
// deactivation with ticket moves, other pipelines, board / list filters, pipeline report, permissions, company
// isolation, read-only reads, rollback and re-apply.
//
//   npm run test:db:pipelines

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p) => readFile(p, 'utf8')
const migDir = path.join(root, 'supabase', 'migrations')
const NAME = '20261227090000_support_pipelines'
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
const rows = async (sql, params) => { await db.exec('reset role'); return (await db.query(sql, params)).rows }
async function request(user, sql, params, readOnly = false) {
  await db.exec('reset role')
  await db.exec(readOnly ? 'begin read only' : 'begin')
  try {
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: await val(`select rls_test.id($1)`, [user]), role: 'authenticated' })])
    await db.exec('set local role authenticated')
    const r = await db.query(sql, params)
    await db.exec('commit')
    return { value: Object.values(r.rows[0] ?? {})[0] }
  } catch (e) {
    try { await db.exec('rollback') } catch { /* ended */ }
    return { error: e.message }
  }
}
const as = (user) => async (sql, params) => { const r = await request(user, sql, params); if (r.error) throw new Error(`${user}: ${sql.slice(0, 90)}… → ${r.error}`); return r.value }
const op = as('op')
const refused = async (user, sql, params, pattern) => { const r = await request(user, sql, params); if (r.error && (!pattern || pattern.test(r.error))) return true; console.log('      got:', r.error ?? 'no error'); return false }
const addUser = async (key, uuid, roleCode) => {
  await db.exec(`reset role;
    insert into rls_test.ids (key, id) values ('${key}', '${uuid}');
    insert into auth.users (id, email) values (rls_test.id('${key}'), '${key}@e7.example.invalid');
    update public.profiles set company_id = rls_test.id('company_a'), is_active = true, full_name = '${key}' where id = rls_test.id('${key}');
    insert into public.user_roles (user_id, company_id, role_id) select rls_test.id('${key}'), rls_test.id('company_a'), id from public.roles where code = '${roleCode}'`)
}
await db.exec(`reset role; insert into public.roles (code, name, is_system) values ('PL_VIEW_TEST', 'Support viewer (test)', false);
  insert into public.role_permissions (role_id, permission_id) select r.id, p.id from public.roles r, public.permissions p where r.code = 'PL_VIEW_TEST' and p.code in ('support.view', 'support.view_reports')`)
await addUser('pl_view', 'e7e5d500-0000-4000-8000-0000000000a1', 'PL_VIEW_TEST')
await addUser('pl_sales', 'e7e5d500-0000-4000-8000-0000000000a2', 'SALES_MANAGER')
const A = await val(`select rls_test.id('company_a')::text`)
const B = await val(`select rls_test.id('company_b')::text`)

// ---- existing tickets of every status, before the migration --------------------------------------------------
const mk = async (user, subject, extra = {}) => (await as(user)(`select public.support_ticket_create($1::jsonb)`, [JSON.stringify({ subject, customer_phone: '+91 98765 43210', ...extra })])).id
const upd = (id, p, user = 'op') => as(user)(`select public.support_ticket_update($1, $2::jsonb)`, [id, JSON.stringify(p)])
const T = {}
T.new = await mk('op', 'Old new ticket')
T.open = await mk('op', 'Old open ticket'); await upd(T.open, { status: 'OPEN' })
T.prog = await mk('op', 'Old in progress', { priority: 'HIGH', category: 'Damage' }); await upd(T.prog, { status: 'IN_PROGRESS' })
T.wc = await mk('op', 'Old waiting customer'); await upd(T.wc, { status: 'WAITING_CUSTOMER' })
T.wi = await mk('op', 'Old waiting internal'); await upd(T.wi, { status: 'WAITING_INTERNAL' })
T.res = await mk('op', 'Old resolved'); await upd(T.res, { status: 'RESOLVED' })
T.cls = await mk('op', 'Old closed'); await upd(T.cls, { status: 'RESOLVED' }); await upd(T.cls, { status: 'CLOSED' })
T.b = await mk('b_op', 'Company B ticket')
const before = await rows(`select id::text, status, updated_at::text, resolved_at::text, closed_at::text, ticket_number from public.support_tickets order by id`)
const statusChangedAt = await val(`select max(created_at)::text from public.support_ticket_events where ticket_id = $1 and event_type = 'STATUS_CHANGED'`, [T.prog])

await db.exec(await read(path.join(migDir, `${NAME}.sql`)))
await db.exec(await read(path.join(migDir, `${NAME}.sql`)))
for (const f of files.filter((x) => x > `${NAME}.sql`)) await db.exec(await read(path.join(migDir, f)))
console.log(`✓ ${NAME} applied (twice)`)

console.log('\nDefault pipeline and existing tickets')
const stagesOf = async (company) => rows(`select s.id::text, s.stage_name, s.stage_type, s.outcome_type, s.ticket_status, s.is_default, s.display_order
  from public.support_pipeline_stages s join public.support_pipelines p on p.id = s.pipeline_id where p.company_id = $1 and p.is_default order by s.display_order`, [company])
const SA = await stagesOf(A)
ok('every company has the default "Customer Support" pipeline', Number(await val(`select count(*) from public.support_pipelines where is_default and name = 'Customer Support'`)) === Number(await val(`select count(*) from public.companies`)))
ok('six default stages: three open, three closed with outcomes', SA.map((s) => `${s.stage_name}:${s.stage_type}:${s.outcome_type ?? '-'}`).join('|')
  === 'New Ticket:OPEN:-|In Progress:OPEN:-|On Hold:OPEN:-|Closed – Positive:CLOSED:POSITIVE|Deferred – Negative:CLOSED:NEGATIVE|Not an Issue – Negative:CLOSED:NEGATIVE', SA)
ok('"New Ticket" is the default stage for new tickets', SA.filter((s) => s.is_default).map((s) => s.stage_name).join() === 'New Ticket')
const S = Object.fromEntries(SA.map((s) => [s.stage_name, s.id]))
const after = await rows(`select id::text, status, updated_at::text, resolved_at::text, closed_at::text, ticket_number from public.support_tickets order by id`)
ok('existing tickets: status, number, dates and updated_at unchanged', JSON.stringify(after) === JSON.stringify(before))
const stageName = async (id) => val(`select s.stage_name from public.support_tickets t join public.support_pipeline_stages s on s.id = t.stage_id where t.id = $1`, [id])
const mapping = { new: 'New Ticket', open: 'In Progress', prog: 'In Progress', wc: 'On Hold', wi: 'On Hold', res: 'Closed – Positive', cls: 'Closed – Positive' }
const got = {}
for (const k of Object.keys(mapping)) got[k] = await stageName(T[k])
ok('existing statuses mapped: NEW→New Ticket, OPEN/IN_PROGRESS→In Progress, WAITING_*→On Hold, RESOLVED/CLOSED→Closed – Positive', JSON.stringify(got) === JSON.stringify(mapping), got)
ok('company B tickets go to company B\'s own pipeline', await val(`select p.company_id::text from public.support_tickets t join public.support_pipelines p on p.id = t.pipeline_id where t.id = $1`, [T.b]) === B)
ok('history starts at the last status change (from the ticket events)', (await val(`select changed_at::text from public.support_ticket_stage_history where ticket_id = $1 and source = 'MIGRATION'`, [T.prog])) === statusChangedAt)
ok('one history row per existing ticket', Number(await val(`select count(*) from public.support_ticket_stage_history where source = 'MIGRATION'`)) === 8)
const C2 = '0e7e5c80-0000-4000-8000-0000000000c9'
await db.exec(`reset role; insert into public.companies (id, legal_name, display_name, company_code) values ('${C2}', 'New Co', 'New Co', 'NEWCO')`)
ok('a new company gets its default pipeline', Number(await val(`select count(*) from public.support_pipeline_stages s join public.support_pipelines p on p.id = s.pipeline_id where p.company_id = $1`, [C2])) === 6)

console.log('\nPermissions')
const roleCodes = async (role) => (await rows(`select p.code from public.role_permissions rp join public.roles r on r.id = rp.role_id join public.permissions p on p.id = rp.permission_id
  where r.code = $1 and (p.resource = 'support_pipelines' or p.code = 'support_tickets.move_stage') order by p.code`, [role])).map((r) => r.code)
ok('Super Admin and Admin: all six', (await roleCodes('SUPER_ADMIN')).length === 6 && (await roleCodes('ADMIN')).length === 6)
ok('Sales Manager (support.view + manage_tickets): view and move only', JSON.stringify(await roleCodes('SALES_MANAGER')) === JSON.stringify(['support_pipelines.view', 'support_tickets.move_stage']))
ok('a support viewer: view only', JSON.stringify(await roleCodes('PL_VIEW_TEST')) === JSON.stringify(['support_pipelines.view']))
ok('roles without Support Centre access get nothing', (await roleCodes('INVENTORY_MANAGER')).length === 0 && (await roleCodes('MANAGEMENT_VIEWER')).length === 0)

console.log('\nNew tickets')
const t1 = await mk('pl_sales', 'Basin cracked', { priority: 'URGENT', category: 'Damage' })
ok('a new ticket enters the default open stage, with a CREATED history row', (await stageName(t1)) === 'New Ticket'
  && Number(await val(`select count(*) from public.support_ticket_stage_history where ticket_id = $1 and source = 'CREATED' and to_stage_id = $2`, [t1, S['New Ticket']])) === 1)

console.log('\nMoving tickets (existing status rules, SLA, closure, reopening)')
await db.exec(`reset role; insert into public.support_business_calendar (company_id, enabled, pause_when_waiting_customer) values ('${A}', false, true)
  on conflict (company_id) do update set pause_when_waiting_customer = true`)
const move = (user, id, stage, expected, note = null) => as(user)(`select public.support_ticket_move_stage($1, $2, $3, $4)`, [id, stage, expected, note])
const tk = async (id) => (await rows(`select status, stage_id::text, resolved_at, closed_at, reopen_count, sla_paused_at from public.support_tickets where id = $1`, [id]))[0]
let r = await move('pl_sales', t1, S['In Progress'], S['New Ticket'])
ok('New Ticket → In Progress: status IN_PROGRESS (through support_ticket_update)', r.status === 'IN_PROGRESS' && (await tk(t1)).stage_id === S['In Progress']
  && Number(await val(`select count(*) from public.support_ticket_events where ticket_id = $1 and event_type = 'STATUS_CHANGED' and to_value = 'IN_PROGRESS'`, [t1])) === 1, r)
const h = (await rows(`select from_stage_id::text, to_stage_id::text, from_status, to_status, source, changed_by::text from public.support_ticket_stage_history where ticket_id = $1 and source = 'MOVE'`, [t1]))[0]
ok('history: previous and new stage and status, user, time', h?.from_stage_id === S['New Ticket'] && h.to_stage_id === S['In Progress'] && h.from_status === 'NEW' && h.to_status === 'IN_PROGRESS'
  && h.changed_by === await val(`select rls_test.id('pl_sales')::text`), h)
ok('activity history shows the stage change', Number(await val(`select count(*) from public.support_ticket_events where ticket_id = $1 and event_type = 'STAGE_CHANGED' and from_value = 'New Ticket' and to_value = 'In Progress'`, [t1])) === 1)
r = await move('pl_sales', t1, S['On Hold'], S['In Progress'])
ok('→ On Hold: WAITING_CUSTOMER and the SLA clock pauses (existing pause rule)', r.status === 'WAITING_CUSTOMER' && (await tk(t1)).sla_paused_at !== null, r)
r = await move('pl_sales', t1, S['In Progress'], S['On Hold'])
ok('back to In Progress: the clock resumes', r.status === 'IN_PROGRESS' && (await tk(t1)).sla_paused_at === null)
ok('a stale move is refused (someone else moved it): nothing changes', await refused('op', `select public.support_ticket_move_stage($1, $2, $3)`, [t1, S['Closed – Positive'], S['New Ticket']], /was moved to "In Progress" by someone else/)
  && (await tk(t1)).status === 'IN_PROGRESS')
r = await move('pl_sales', t1, S['Closed – Positive'], S['In Progress'])
ok('→ Closed – Positive: the existing closure (RESOLVED, resolved_at; SLA judged as closed)', r.status === 'RESOLVED' && (await tk(t1)).resolved_at !== null && ['MET', 'BREACHED', 'NO_SLA'].includes(r.sla_status), r)
r = await move('pl_sales', t1, S['Deferred – Negative'], S['Closed – Positive'])
ok('closed → closed (Positive → Negative): status kept, outcome changes', r.status === 'RESOLVED' && (await tk(t1)).stage_id === S['Deferred – Negative'])
ok('closed → open without a reason: refused by the existing reopen rule', await refused('pl_sales', `select public.support_ticket_move_stage($1, $2, $3)`, [t1, S['In Progress'], S['Deferred – Negative']], /reason for reopening/))
r = await move('pl_sales', t1, S['In Progress'], S['Deferred – Negative'], 'Customer called again')
const t1r = await tk(t1)
ok('reopening through the existing reopen: reopen count, REOPENED event, then the stage status', r.status === 'IN_PROGRESS' && t1r.reopen_count === 1 && t1r.resolved_at === null
  && Number(await val(`select count(*) from public.support_ticket_events where ticket_id = $1 and event_type = 'REOPENED'`, [t1])) === 1, t1r)
r = await move('pl_sales', t1, S['New Ticket'], S['In Progress'])
ok('back to New Ticket: a ticket that left New becomes Open (existing "never back to New" rule)', r.status === 'OPEN' && (await tk(t1)).stage_id === S['New Ticket'])
ok('the history has every move with its source', (await val(`select string_agg(source, ',' order by changed_at, id) from public.support_ticket_stage_history where ticket_id = $1`, [t1])) === 'CREATED,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE')
r = await move('op', T.res, S['Not an Issue – Negative'], null)
ok('without an expected stage (programmatic) the move still applies', (await tk(T.res)).stage_id === S['Not an Issue – Negative'])
await upd(T.cls, {}).catch(() => {})
r = await move('op', T.cls, S['Deferred – Negative'], S['Closed – Positive'])
ok('a CLOSED ticket can change its closed outcome; it stays CLOSED', r.status === 'CLOSED')

console.log('\nStatus changed elsewhere follows into the right stage')
await upd(T.prog, { status: 'WAITING_CUSTOMER' })
ok('ticket page: In Progress → waiting for customer moves the card to On Hold', (await stageName(T.prog)) === 'On Hold'
  && (await val(`select source from public.support_ticket_stage_history where ticket_id = $1 order by changed_at desc, id desc limit 1`, [T.prog])) === 'STATUS_CHANGE')
await upd(T.prog, { status: 'RESOLVED' })
ok('ticket page: resolved → the first positive closed stage', (await stageName(T.prog)) === 'Closed – Positive')
await op(`select public.support_ticket_reopen($1, 'More damage found')`, [T.prog])
ok('reopen from the ticket page → an open stage (In Progress for status Open)', (await stageName(T.prog)) === 'In Progress')
await upd(T.prog, { status: 'WAITING_INTERNAL' })
ok('waiting internal → On Hold', (await stageName(T.prog)) === 'On Hold')

console.log('\nConcurrent moves')
const t2 = await mk('op', 'Concurrent ticket')
const m1 = await request('op', `select public.support_ticket_move_stage($1, $2, $3)`, [t2, S['In Progress'], S['New Ticket']])
const m2 = await request('pl_sales', `select public.support_ticket_move_stage($1, $2, $3)`, [t2, S['On Hold'], S['New Ticket']])
ok('two agents move the same card from the same board: the second is refused, the first stays', !m1.error && /someone else/.test(m2.error ?? '') && (await stageName(t2)) === 'In Progress', m2)
ok('moving to the stage it is already in changes nothing', (await move('op', t2, S['In Progress'], S['In Progress'])).unchanged === true)

console.log('\nPermissions on moves and stages')
ok('a support viewer cannot move tickets', await refused('pl_view', `select public.support_ticket_move_stage($1, $2, $3)`, [t2, S['On Hold'], S['In Progress']], /support_tickets\.move_stage/))
ok('Sales Manager cannot manage stages', await refused('pl_sales', `select public.support_pipeline_save_stages($1, '[]'::jsonb, '{}'::jsonb, 'x')`, [await val(`select pipeline_id::text from public.support_tickets where id = $1`, [t2])], /manage_stages/))
ok('Sales Manager cannot create pipelines', await refused('pl_sales', `select public.support_pipeline_save(null, '{"name":"Returns"}'::jsonb)`, [], /support_pipelines\.create/))
ok('a merged ticket cannot be moved', await (async () => {
  const a1 = await mk('op', 'Duplicate A'); const a2 = await mk('op', 'Duplicate B')
  await op(`select public.support_ticket_merge($1, $2, 'duplicate')`, [a1, a2])
  return refused('op', `select public.support_ticket_move_stage($1, $2, null)`, [a1, S['In Progress']], /merged/)
})())

console.log('\nManage Stages')
const P = await val(`select id::text from public.support_pipelines where company_id = $1 and is_default`, [A])
const list = async (user = 'op') => (await as(user)(`select public.support_pipelines_list()`)).pipelines.find((p) => p.id === P)
let pl = await list()
ok('pipelines list: stages with ticket counts, stamp and permissions', pl.stages.length === 6 && pl.stages.find((s) => s.stage_name === 'In Progress').tickets >= 1 && typeof pl.stamp === 'string')
const payload = (stages) => stages.map((s) => ({ id: s.id, stage_name: s.stage_name, stage_description: s.stage_description, stage_type: s.stage_type, outcome_type: s.outcome_type,
  ticket_status: s.ticket_status, color: s.color, is_default: s.is_default, is_active: s.is_active }))
const saveStages = (stages, moves = {}, stamp = pl.stamp, user = 'op') => as(user)(`select public.support_pipeline_save_stages($1, $2::jsonb, $3::jsonb, $4)`, [P, JSON.stringify(stages), JSON.stringify(moves), stamp])
const badStages = (stages, pattern, moves = {}) => refused('op', `select public.support_pipeline_save_stages($1, $2::jsonb, $3::jsonb, $4)`, [P, JSON.stringify(stages), JSON.stringify(moves), pl.stamp], pattern)
const base = payload(pl.stages)
ok('duplicate stage names refused (any letter case)', await badStages([...base, { stage_name: 'in progress', stage_type: 'OPEN' }], /unique/))
ok('a closed stage needs an outcome', await badStages([...base, { stage_name: 'Lost', stage_type: 'CLOSED' }], /Positive or Negative/))
ok('at least one active open stage', await badStages(base.map((s) => (s.stage_type === 'OPEN' ? { ...s, is_active: false, is_default: false } : s)), /active Open stage|default/))
ok('at least one active closed stage', await badStages(base.filter((s) => s.stage_type === 'OPEN'), /active Closed stage|contains tickets|history/))
ok('exactly one default stage', await badStages(base.map((s) => (s.stage_type === 'OPEN' ? { ...s, is_default: true } : s)), /exactly one default/))
ok('an open stage cannot carry a closed status', await badStages([...base, { stage_name: 'Odd', stage_type: 'OPEN', ticket_status: 'RESOLVED' }], /must fit/))
ok('a stage with tickets cannot switch between open and closed', await badStages(base.map((s) => (s.stage_name === 'On Hold' ? { ...s, stage_type: 'CLOSED', outcome_type: 'NEGATIVE', ticket_status: 'RESOLVED' } : s)), /cannot change between Open and Closed/))
ok('a stage with tickets cannot be deleted', await badStages(base.filter((s) => s.stage_name !== 'On Hold'), /contains tickets and cannot be deleted/))
ok('a stale save is refused', await refused('op', `select public.support_pipeline_save_stages($1, $2::jsonb, '{}'::jsonb, 'old')`, [P, JSON.stringify(base)], /Someone else changed the stages/))
// Add stages, reorder, rename (including a swap of two names).
const open = base.filter((s) => s.stage_type === 'OPEN')
const closed = base.filter((s) => s.stage_type === 'CLOSED')
const res1 = await saveStages([open[0], { stage_name: 'Waiting for Parts', stage_type: 'OPEN', ticket_status: 'WAITING_INTERNAL', color: '#0ea5e9', client_key: 'k1' }, open[2],
  { ...open[1], stage_name: 'Working' }, closed[1], closed[0], closed[2], { stage_name: 'Duplicate', stage_type: 'CLOSED', outcome_type: 'NEGATIVE', client_key: 'k2' }])
pl = await list()
ok('open and closed stages added, reordered and renamed', pl.stages.map((s) => s.stage_name).join('|')
  === 'New Ticket|Waiting for Parts|On Hold|Working|Deferred – Negative|Closed – Positive|Not an Issue – Negative|Duplicate', pl.stages.map((s) => s.stage_name))
ok('new stages return their ids', Boolean(res1.new_ids.k1) && Boolean(res1.new_ids.k2))
ok('renaming keeps the tickets in the stage (same id)', (await stageName(t2)) === 'Working')
const swap = payload(pl.stages).map((s) => (s.stage_name === 'Working' ? { ...s, stage_name: 'On Hold' } : s.stage_name === 'On Hold' ? { ...s, stage_name: 'Working' } : s))
await saveStages(swap)
pl = await list()
ok('two stage names can be swapped in one save', (await stageName(t2)) === 'On Hold')
const unused = pl.stages.find((s) => s.stage_name === 'Duplicate')
await saveStages(payload(pl.stages).filter((s) => s.id !== unused.id))
pl = await list()
ok('an unused stage can be deleted', !pl.stages.some((s) => s.stage_name === 'Duplicate'))
// Deactivate a stage holding tickets: a destination is required; tickets move through normal, audited moves.
const working = pl.stages.find((s) => s.stage_name === 'Working') // holds the old waiting tickets
const negative = pl.stages.find((s) => s.stage_name === 'Deferred – Negative') // holds closed tickets
ok('deactivating a stage with tickets needs a destination', await badStages(payload(pl.stages).map((s) => (s.id === working.id ? { ...s, is_active: false } : s)), /choose an active stage/))
const inWorking = Number(working.tickets)
const res2 = await saveStages(payload(pl.stages).map((s) => (s.id === working.id || s.id === negative.id ? { ...s, is_active: false } : s)),
  { [working.id]: pl.stages.find((s) => s.stage_name === 'New Ticket').id, [negative.id]: pl.stages.find((s) => s.stage_name === 'In Progress' || s.stage_name === 'On Hold').id })
pl = await list()
ok('tickets moved out of the deactivated stages; none orphaned', res2.moved === inWorking + Number(negative.tickets) && pl.stages.find((s) => s.id === working.id).tickets === 0
  && pl.stages.find((s) => s.id === working.id).is_active === false && Number(await val(`select count(*) from public.support_tickets where stage_id in ($1, $2)`, [working.id, negative.id])) === 0, res2)
ok('closed tickets moved to an open stage were reopened with the reason, audited as STAGE_DEACTIVATED',
  Number(await val(`select count(*) from public.support_ticket_stage_history where source = 'STAGE_DEACTIVATED' and from_stage_id = $1`, [negative.id])) === Number(negative.tickets)
  && Number(await val(`select count(*) from public.support_ticket_events e join public.support_ticket_stage_history h on h.ticket_id = e.ticket_id
     where h.from_stage_id = $1 and e.event_type = 'REOPENED' and e.details ->> 'reason' like 'Stage "Deferred%deactivated'`, [negative.id])) >= 1)
ok('an inactive stage with history cannot be deleted', await badStages(payload(pl.stages).filter((s) => s.id !== working.id), /history/))
await saveStages(payload(pl.stages).map((s) => (s.id === working.id || s.id === negative.id ? { ...s, is_active: true } : s)))
pl = await list()
ok('stages can be reactivated', pl.stages.every((s) => s.is_active))
ok('company B cannot change company A\'s stages', await refused('b_op', `select public.support_pipeline_save_stages($1, $2::jsonb, '{}'::jsonb, $3)`, [P, JSON.stringify(payload(pl.stages)), pl.stamp], /not found in your company/))

console.log('\nOther pipelines')
const P2 = (await op(`select public.support_pipeline_save(null, '{"name":"Returns","description":"Return requests"}'::jsonb)`)).id
ok('a new pipeline gets the six default stages', Number(await val(`select count(*) from public.support_pipeline_stages where pipeline_id = $1`, [P2])) === 6)
ok('pipeline names are unique', await refused('op', `select public.support_pipeline_save(null, '{"name":"returns"}'::jsonb)`, [], /already exists/))
const t3 = (await as('pl_sales')(`select public.support_ticket_create_v2($1::jsonb)`, [JSON.stringify({ subject: 'Return a basin', customer_email: 'r@x.example', pipeline_id: P2, custom_fields: {}, products: [] })])).id
ok('a ticket created from another pipeline\'s board enters that pipeline\'s default stage', (await val(`select pipeline_id::text from public.support_tickets where id = $1`, [t3])) === P2 && (await stageName(t3)) === 'New Ticket')
ok('a stage of another pipeline cannot be used', await refused('op', `select public.support_ticket_move_stage($1, $2, null)`, [t3, S['On Hold']], /another pipeline/))
const t4 = (await op(`select public.support_ticket_create_v2($1::jsonb)`, [JSON.stringify({ subject: 'Wrong pipeline', customer_email: 'r@x.example', pipeline_id: await val(`select id::text from public.support_pipelines where company_id = $1`, [B]), custom_fields: {}, products: [] })])).id
ok('another company\'s pipeline id is ignored (the default pipeline is used)', (await val(`select pipeline_id::text from public.support_tickets where id = $1`, [t4])) === P)
ok('the default pipeline cannot be deactivated', await refused('op', `select public.support_pipeline_save($1, '{"is_active":false}'::jsonb)`, [P], /default pipeline cannot be deactivated/))
ok('a pipeline with open tickets cannot be deactivated', await refused('op', `select public.support_pipeline_save($1, '{"is_active":false}'::jsonb)`, [P2], /open tickets/))
await op(`select public.support_pipeline_save($1, '{"is_default":true}'::jsonb)`, [P2])
ok('the default pipeline can be changed (one default per company)', Number(await val(`select count(*) from public.support_pipelines where company_id = $1 and is_default`, [A])) === 1
  && (await val(`select is_default from public.support_pipelines where id = $1`, [P2])) === true)
await op(`select public.support_pipeline_save($1, '{"is_default":true}'::jsonb)`, [P])

console.log('\nBoard and list')
const prod = await op(`insert into public.products (company_id, sku, product_name, product_type, default_source_type, base_unit, status) values (private.current_company_id(), 'PL-BASIN-1', 'Pipeline Basin', 'FINISHED_GOOD', 'IN_HOUSE', 'PCS', 'ACTIVE') returning id::text`)
await op(`select public.support_ticket_products_save($1, $2::jsonb, false)`, [T.prog, JSON.stringify([{ product_id: prod, quantity: 2 }])])
const board = (p, user = 'op') => as(user)(`select public.support_pipeline_board($1::jsonb)`, [JSON.stringify({ pipeline_id: P, ...p })])
let b = await board({})
const total = Number(await val(`select count(*) from public.support_tickets where pipeline_id = $1 and merged_into_ticket_id is null`, [P]))
ok('board: every stage with its count; counts add up to the pipeline\'s tickets (merged ones left out)', b.stages.length === 7 && b.stages.reduce((n, s) => n + Number(s.count), 0) === total && b.total === total, b.stages.map((s) => [s.stage_name, s.count]))
const card = b.stages.flatMap((s) => s.cards).find((c) => c.id === T.prog)
ok('cards: number, subject, phone, priority, agent, created, SLA, products with SKU', card.ticket_number && card.subject === 'Old in progress' && card.customer_phone === '+91 98765 43210'
  && card.priority === 'HIGH' && card.sla_status && card.products[0].sku === 'PL-BASIN-1', card)
ok('a viewer without ticket-products permission sees no products on cards', (await board({}, 'pl_view')).stages.flatMap((s) => s.cards).find((c) => c.id === T.prog).products === null)
ok('filter: search by ticket number', (await board({ search: card.ticket_number })).total === 1)
ok('filter: search by phone digits', (await board({ search: '98765 43210' })).total >= 8)
ok('filter: priority', (await board({ priority: 'HIGH' })).total === 1)
ok('filter: category', (await board({ category: 'damage' })).total === 2)
ok('filter: product by SKU', (await board({ product: 'pl-basin' })).total === 1)
ok('filter: created date range', (await board({ from: '2000-01-01', to: '2000-01-02' })).total === 0)
ok('scope: closed stages only', (await board({ scope: 'CLOSED' })).stages.every((s) => s.stage_type === 'CLOSED' || Number(s.count) === 0))
ok('scope: unassigned', (await board({ scope: 'UNASSIGNED' })).total === total)
const L = await board({ mode: 'list', sort: 'priority', limit: 3, offset: 0 })
ok('list view: sorted by priority, paged', L.rows.length === 3 && L.total === total && ['URGENT', 'HIGH'].includes(L.rows[0].priority), L.rows.map((x) => x.priority))
ok('company B\'s board shows only its tickets', (await as('b_op')(`select public.support_pipeline_board('{}'::jsonb)`)).total === 1)
ok('company B cannot open company A\'s pipeline', await refused('b_op', `select public.support_pipeline_board($1::jsonb)`, [JSON.stringify({ pipeline_id: P })], /not found in your company/))
ok('company B cannot move company A\'s ticket', await refused('b_op', `select public.support_ticket_move_stage($1, $2, null)`, [t2, S['In Progress']], /not found in your company/))
const info = await op(`select public.support_ticket_stage_info($1)`, [t1])
ok('ticket page: pipeline, stage, stages and history (newest first)', info.pipeline.name === 'Customer Support' && info.stage_id === S['New Ticket'] && info.history.length === 8 && info.history[0].to_stage === 'New Ticket' && info.can_move)
const rls = await request('b_op', `select (select count(*) from public.support_pipelines where company_id = '${A}') + (select count(*) from public.support_ticket_stage_history where company_id = '${A}')`)
ok('RLS: company B reads none of company A\'s pipelines or history', Number(rls.value) === 0, rls)

console.log('\nPipeline report')
const rep = await as('pl_view')(`select public.support_pipeline_report($1, current_date - 30, current_date)`, [P])
const byName = Object.fromEntries(rep.by_stage.map((s) => [s.stage_id, s]))
ok('tickets by stage add up; open vs closed; positive vs negative', rep.by_stage.reduce((n, s) => n + Number(s.tickets), 0) === Number(rep.open) + Number(rep.closed)
  && Number(rep.positive) + Number(rep.negative) === Number(rep.closed), rep)
const manual = await val(`select round(extract(epoch from avg(spent)) / 3600.0, 1)::text from (
    select coalesce(lead(changed_at) over (partition by ticket_id order by changed_at, id), now()) - changed_at as spent, to_stage_id
    from public.support_ticket_stage_history where pipeline_id = $1) x where to_stage_id = $2`, [P, S['In Progress']])
ok('average time in a stage comes from the stage history', String(byName[S['In Progress']].avg_hours) === String(Number(manual)), { report: byName[S['In Progress']].avg_hours, manual })
ok('reopened after closure counted from history', Number(rep.reopened) >= 2 && Number(rep.reopened_tickets) >= 2, rep)
ok('conversion: share of the period\'s tickets that reached each stage', byName[S['New Ticket']].conversion_percent > 0 && byName[S['New Ticket']].conversion_percent <= 100)
const repOp = await op(`select public.support_pipeline_report($1, current_date - 30, current_date)`, [P])
ok('agent-wise distribution and product-wise complaints (products only with the products permission)', Array.isArray(rep.by_agent) && rep.by_agent.length >= 1
  && rep.by_product === null && repOp.by_product.some((x) => x.sku === 'PL-BASIN-1'), repOp.by_product)


console.log('\nRead-only (PostgREST GET)')
for (const q of [`select public.support_pipelines_list()`, `select public.support_pipeline_board('{}'::jsonb)`, `select public.support_pipeline_board('{"mode":"list"}'::jsonb)`,
  `select public.support_ticket_stage_info('${t1}')`, `select public.support_pipeline_report(null, null, null)`]) {
  const x = await request('op', q, [], true)
  ok(`${q.slice(14, 60)} runs read-only`, !x.error, x.error)
}

console.log('\nHistory is append-only; reset allowlist; rollback')
await db.exec('reset role')
ok('stage history rows cannot be changed', await db.query(`update public.support_ticket_stage_history set notes = 'x' where ticket_id = $1`, [t1]).then(() => false, (e) => /cannot be changed/.test(e.message)))
ok('reset allowlist: the three pipeline tables (history first, pipelines last)', Number(await val(`select count(*) from private.erp_reset_tables() where table_name in ('support_pipelines', 'support_pipeline_stages', 'support_ticket_stage_history')`)) === 3
  && Number(await val(`select ord from private.erp_reset_tables() where table_name = 'support_pipelines'`)) > Number(await val(`select ord from private.erp_reset_tables() where table_name = 'support_tickets'`)))
const statusesBefore = await rows(`select id::text, status, reopen_count from public.support_tickets order by id`)
// Later migrations are rolled back first (newest first), as a real rollback of this migration would be done.
for (const f of files.filter((x) => x > `${NAME}.sql`).reverse()) {
  const downFile = path.join(root, 'supabase', 'rollback', f.replace(/\.sql$/, '_down.sql'))
  const sql = await read(downFile).catch(() => null)
  if (!sql) continue
  await db.exec(`reset role; set app.support_crm_rollback_force = 'on'; set app.support_pipelines_rollback_force = 'on'`)
  await db.exec(sql)
  await db.exec(`reset app.support_crm_rollback_force; reset app.support_pipelines_rollback_force`)
}
const down = await read(path.join(root, 'supabase', 'rollback', `${NAME}_down.sql`))
ok('rollback refuses while tickets have been moved', await db.exec(down).then(() => false, (e) => /Export the stage history/.test(e.message)))
await db.exec(`set app.support_pipelines_rollback_force = 'on'`)
await db.exec(down)
await db.exec(`reset app.support_pipelines_rollback_force`)
ok('rollback: pipeline tables and columns gone; tickets, statuses and events kept', !(await val(`select to_regclass('public.support_pipelines') is not null`))
  && !(await val(`select exists (select 1 from information_schema.columns where table_name = 'support_tickets' and column_name = 'stage_id')`))
  && JSON.stringify(await rows(`select id::text, status, reopen_count from public.support_tickets order by id`)) === JSON.stringify(statusesBefore)
  && Number(await val(`select count(*) from public.support_ticket_events where event_type = 'STAGE_CHANGED'`)) > 0)
ok('rollback: pipeline tables out of the reset allowlist, permissions removed, ticket creation still works', Number(await val(`select count(*) from private.erp_reset_tables() where table_name in ('support_pipelines', 'support_pipeline_stages', 'support_ticket_stage_history')`)) === 0
  && Number(await val(`select count(*) from public.permissions where resource = 'support_pipelines'`)) === 0 && Boolean(await mk('op', 'After rollback')))
await db.exec(await read(path.join(migDir, `${NAME}.sql`)))
ok('re-applies after the rollback: every ticket placed again', Number(await val(`select count(*) from public.support_tickets where stage_id is null`)) === 0
  && Number(await val(`select count(*) from private.erp_reset_tables() where table_name in ('support_pipelines', 'support_pipeline_stages', 'support_ticket_stage_history')`)) === 3)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
