import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, it } from 'node:test'

import {
  canStartForceReset,
  forceGates,
  isVerifiedForceSuccess,
  type ForceGateSource,
} from '../../src/features/admin/erp-force-reset-model.ts'

const root = path.resolve(import.meta.dirname, '..', '..')
const read = (...p: string[]) => readFile(path.join(root, ...p), 'utf8')
const MIGRATION = ['supabase', 'migrations', '20261031090000_erp_force_reset.sql']
const DIRECT = ['supabase', 'migrations', '20261113090000_force_reset_direct.sql']
const EDGE = ['supabase', 'functions', 'force-reset-erp-data', 'index.ts']
const code = (sql: string) => sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')

const open: ForceGateSource = { gates: { authorized: true, plan_reviewed: true }, can_execute: true, blockers: [], delete_total: 2768 }

describe('Force reset: direct delete (no approval steps)', () => {
  it('the preview lists permission, deletion plan and records, with no approval, backup or password gates', () => {
    assert.deepEqual(forceGates(open).map((g) => g.key), ['authorized', 'plan', 'data'])
    assert.ok(forceGates(open).every((g) => g.ok))
    assert.equal(canStartForceReset(open), true)
    assert.equal(canStartForceReset({ ...open, can_execute: false }), false)
    assert.equal(canStartForceReset(null), false)
  })

  it('success only when the FORCE reset completed and was verified in the transaction', () => {
    const ok = { status: 'COMPLETED', mode: 'FORCE', verification: { purge_tables_empty: true } }
    assert.equal(isVerifiedForceSuccess(ok), true)
    assert.equal(isVerifiedForceSuccess({ ...ok, verification: { rolled_back: true } }), false)
    assert.equal(isVerifiedForceSuccess({ ...ok, status: 'BLOCKED' }), false)
    assert.equal(isVerifiedForceSuccess({ ...ok, mode: 'STANDARD' }), false)
    assert.equal(isVerifiedForceSuccess(null), false)
  })

  it('the section is shown only to Super Admins; the red button is always clickable and deletes after one confirmation', async () => {
    const page = await read('src', 'pages', 'admin', 'erp-settings-page.tsx')
    assert.match(page, /\{canReset && access\?\.company && \(/)
    const section = await read('src', 'features', 'admin', 'erp-force-reset-section.tsx')
    for (const text of ['Preview Force Reset', 'Force Reset / Delete Everything', 'View Reset History', 'Delete everything now']) {
      assert.ok(section.includes(text), `missing: ${text}`)
    }
    for (const gone of ['Verify Backup', 'type="password"', 'disabled={!canReset}', 'Final confirmation']) {
      assert.ok(!section.includes(gone), `still present: ${gone}`)
    }
    const service = await read('src', 'services', 'erp-force-reset.ts')
    assert.match(service, /'erp_force_reset_now'/)
    assert.doesNotMatch(service, /functions\.invoke/)
  })

  it('the direct function keeps permission, own-company, lock, idempotency and in-transaction verification', async () => {
    const sql = code(await read(...DIRECT))
    assert.match(sql, /private\.erp_reset_actor_ok\(v_actor, v_company\)/)
    assert.match(sql, /You can only reset the company your account belongs to/)
    assert.match(sql, /pg_try_advisory_xact_lock\(hashtextextended\('erp_reset:'/)
    assert.match(sql, /where company_id = v_company and request_id = p_request_id/)
    assert.match(sql, /ERP_FORCE_RESET_VERIFICATION_FAILED/)
    assert.doesNotMatch(sql, /erp_force_reset_active_approval|erp_force_reset_valid_backup|p_reauth_ticket/)
    assert.doesNotMatch(sql, /\btruncate\b|disable\s+trigger|session_replication_role|\bcascade\b/i)
    assert.match(sql, /revoke all on function public\.erp_force_reset_now\(uuid, uuid\) from public, anon;/)
  })
})

// The earlier Edge Function path stays deployed-able but is no longer used by the screen.
describe('Force reset: earlier Edge Function path (unused; static checks)', () => {
  it('takes the user from the verified session and checks the requested company against it', async () => {
    const src = await read(...EDGE)
    assert.match(src, /caller\.auth\.getUser\(\)/)
    assert.match(src, /access\.company\.id !== companyId/)
    assert.doesNotMatch(src, /body\.(user_id|actor)/)
  })

  it('verifies the password, rate-limits it and never logs or forwards it', async () => {
    const src = await read(...EDGE)
    assert.match(src, /signInWithPassword\(\{ email: user\.email, password \}\)/)
    assert.match(src, /signOut\(\{ scope: 'local' \}\)/)
    assert.match(src, /erp_reset_attempt_allowed/)
    assert.doesNotMatch(src, /console\./)
    const uses = src.split('\n').filter((l) => /\bpassword\b/.test(l) && !l.trim().startsWith('//'))
    for (const line of uses) assert.ok(!/rpc\(|JSON\.stringify|p_reason/.test(line) || /signInWithPassword/.test(line), `password used in: ${line.trim()}`)
  })

  it('executes as the user (auth.uid) with a ticket issued only after the password check', async () => {
    const src = await read(...EDGE)
    const signIn = src.indexOf('signInWithPassword(')
    const ticket = src.indexOf("admin.rpc('erp_force_reset_issue_ticket'")
    const execute = src.indexOf("caller.rpc('erp_force_reset_execute'")
    assert.ok(signIn > 0 && ticket > signIn && execute > ticket)
    assert.doesNotMatch(src, /admin\.rpc\('erp_force_reset_execute'/)
  })

  it('removes Storage files and reports success only after the post-commit verification', async () => {
    const src = await read(...EDGE)
    const execute = src.indexOf("caller.rpc('erp_force_reset_execute'")
    const remove = src.indexOf('.remove(batch)')
    const verify = src.lastIndexOf('await verify()')
    const success = src.lastIndexOf('return json(req, 200')
    assert.ok(execute > 0 && remove > execute && verify > remove && success > verify)
    assert.match(src, /VERIFICATION_FAILED/)
  })
})

describe('Force reset: migration safety (static checks)', () => {
  it('never truncates, disables triggers, RLS or uses cascade', async () => {
    const sql = code(await read(...MIGRATION))
    assert.doesNotMatch(sql, /\btruncate\b/i)
    assert.doesNotMatch(sql, /disable\s+trigger/i)
    assert.doesNotMatch(sql, /session_replication_role/i)
    assert.doesNotMatch(sql, /disable\s+row\s+level\s+security|no\s+force\s+row/i)
    assert.doesNotMatch(sql, /\bcascade\b/i)
  })

  it('every changed guard gets the same narrow exemption and still raises otherwise', async () => {
    const sql = code(await read(...MIGRATION))
    const exemptions = sql.match(/if private\.erp_force_purge_allows\(tg_table_name, \(to_jsonb\(old\) ->> 'company_id'\)::uuid\) then return old; end if;/g) ?? []
    assert.equal(exemptions.length, 11)
    assert.match(sql, /s\.txid = txid_current\(\)/)
    assert.match(sql, /s\.company_id = p_company/)
    assert.doesNotMatch(sql, /prevent_audit_log_mutation/)
  })

  it('approval is for the database owner only; ticket, verify and failure records for service_role only', async () => {
    const sql = await read(...MIGRATION)
    assert.match(sql, /revoke all on function private\.erp_force_reset_approve\(text, uuid, text, text, text, int\) from public, anon, authenticated, service_role;/)
    assert.match(sql, /grant execute on function public\.erp_force_reset_issue_ticket\(uuid, uuid\) to service_role;/)
    assert.doesNotMatch(sql, /grant execute on function public\.erp_force_reset_(issue_ticket|verify|record_failure)[^;]*authenticated/)
    assert.match(sql, /environment in \('DEVELOPMENT', 'DEMO', 'TEST'\)/)
  })

  it('locks per company (shared with the standard reset), is idempotent and checks auth.uid()', async () => {
    const sql = await read(...MIGRATION)
    assert.match(sql, /pg_try_advisory_xact_lock\(hashtextextended\('erp_reset:'/)
    assert.match(sql, /v_actor\s+uuid := auth\.uid\(\);/)
    assert.match(sql, /where company_id = v_company and request_id = p_request_id/)
  })
})
