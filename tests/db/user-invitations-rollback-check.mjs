// Rollback / roll-forward check of 20261116090000_user_invitations.sql on PGlite.
//   npm run test:db:rollback
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (...p) => readFile(path.join(root, ...p), 'utf8')
const MIGRATION = '20261116090000_user_invitations.sql'
const db = new PGlite()
let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ` ${detail}`}`)
  if (!ok) failed++
}
const yes = async (sql) => (await db.query(`select (${sql}) as ok`)).rows[0].ok === true
const NEW = `('invite_role_catalog', 'user_invitation_prepare', 'user_invitation_finalize', 'user_invitation_fail', 'user_invitation_revoke',
  'my_invitation', 'user_invitation_accept', 'user_invitations_list', 'role_assignment_problem', 'actor_has_permission', 'actor_has_role', 'role_is_admin', 'role_category')`
const kept = (fn) => `(select coalesce(bool_or(t::text like '%user_invitations%'), false) from private.${fn}() t)`

await db.exec(await read('supabase', 'tests', 'local_supabase_shim.sql'))
for (const f of (await readdir(path.join(root, 'supabase', 'migrations'))).filter((x) => x.endsWith('.sql')).sort()) {
  await db.exec(await read('supabase', 'migrations', f))
}
console.log('User invitations: rollback / roll-forward')
check('migration applied', await yes(`(select count(*) from pg_proc where proname in ${NEW}) = 13 and to_regclass('public.user_invitations') is not null
  and ${kept('erp_reset_kept_tables')} and ${kept('erp_force_reset_retained_tables')}`))
const counts = `select (select count(*) from public.roles)::int r, (select count(*) from public.role_permissions)::int rp,
  (select count(*) from public.user_roles)::int ur, (select count(*) from public.profiles)::int p`
const before = (await db.query(counts)).rows[0]

await db.exec(await read('supabase', 'rollback', MIGRATION.replace('.sql', '_down.sql')))
check('rollback: invitation functions and helpers removed', await yes(`not exists (select 1 from pg_proc where proname in ${NEW})`))
check('rollback: invitation table removed', await yes(`to_regclass('public.user_invitations') is null`))
check('rollback: reset table lists restored', await yes(`not ${kept('erp_reset_kept_tables')} and not ${kept('erp_force_reset_retained_tables')}`))
check('rollback: original user_roles insert policy restored',
  await yes(`exists (select 1 from pg_policies where tablename = 'user_roles' and policyname = 'user_roles_insert_company_admin' and with_check not like '%role_is_admin%')`))
const after = (await db.query(counts)).rows[0]
check('rollback: roles, grants, user roles and profiles preserved', JSON.stringify(after) === JSON.stringify(before), JSON.stringify({ before, after }))

await db.exec(await read('supabase', 'migrations', MIGRATION))
check('roll forward: migration applies again', await yes(`(select count(*) from pg_proc where proname in ${NEW}) = 13 and to_regclass('public.user_invitations') is not null`))
let message = ''
try { await db.exec(await read('supabase', 'tests', 'user_invitations_verification.sql')) } catch (e) { message = e.message ?? String(e) }
await db.exec('rollback').catch(() => {})
const m = /USER_INVITATIONS_RESULT passed=(\d+) failed=(\d+)/.exec(message)
check(`roll forward: verification suite passes (${m ? `${m[1]} passed, ${m[2]} failed` : message})`, Boolean(m) && m[2] === '0')

console.log(failed === 0 ? '✓ rollback check passed' : `✗ rollback check: ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
