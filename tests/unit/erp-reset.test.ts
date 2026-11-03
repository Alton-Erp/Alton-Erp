import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, it } from 'node:test'

import { RESET_CONFIRMATION, groupDeletion, isVerifiedSuccess } from '../../src/features/admin/erp-reset-model.ts'

const root = path.resolve(import.meta.dirname, '..', '..')
const read = (...p: string[]) => readFile(path.join(root, ...p), 'utf8')
const MIGRATION = ['supabase', 'migrations', '20261030090000_erp_reset.sql']
const EDGE = ['supabase', 'functions', 'reset-erp-data', 'index.ts']

describe('ERP reset: result handling', () => {
  const ok = { status: 'COMPLETED', verification: { allowlist_empty: true }, post_check: { ok: true } }
  it('success only when completed AND verified in the transaction AND after commit', () => {
    assert.equal(isVerifiedSuccess(ok), true)
    assert.equal(isVerifiedSuccess({ ...ok, post_check: { ok: false } }), false)
    assert.equal(isVerifiedSuccess({ ...ok, post_check: null }), false)
    assert.equal(isVerifiedSuccess({ ...ok, verification: {} }), false)
    assert.equal(isVerifiedSuccess({ ...ok, status: 'BLOCKED' }), false)
    assert.equal(isVerifiedSuccess({ ...ok, status: 'FAILED' }), false)
    assert.equal(isVerifiedSuccess(null), false)
    assert.equal(isVerifiedSuccess({}), false)
  })

  it('groups deletion counts by category, largest first', () => {
    const g = groupDeletion([
      { table: 'customers', label: 'Customers', category: 'Customers & suppliers', rows: 2 },
      { table: 'suppliers', label: 'Suppliers', category: 'Customers & suppliers', rows: 5 },
      { table: 'notifications', label: 'Notifications', category: 'Approvals', rows: 1 },
      { table: 'boms', label: 'BOMs', category: 'Production', rows: 0 },
    ])
    assert.deepEqual(g.map((x) => [x.category, x.total]), [['Customers & suppliers', 7], ['Approvals', 1], ['Production', 0]])
    assert.deepEqual(g[0].tables.map((t) => t.table), ['suppliers', 'customers'])
  })
})

describe('ERP reset: database, Edge Function and UI agree', () => {
  it('the confirmation text is the same everywhere', async () => {
    assert.equal(RESET_CONFIRMATION, 'RESET ERP')
    assert.match(await read(...MIGRATION), /p_confirmation is distinct from 'RESET ERP'/)
    assert.match(await read(...EDGE), /const CONFIRMATION = 'RESET ERP'/)
  })

  it('the permission exists in the migration and the frontend list', async () => {
    assert.match(await read(...MIGRATION), /\('system', 'reset_data'/)
    assert.match(await read('src', 'auth', 'permissions.ts'), /'system\.reset_data'/)
  })

  it('the UI shows the reset card only to Super Admins with the permission', async () => {
    const page = await read('src', 'pages', 'admin', 'erp-settings-page.tsx')
    assert.match(page, /hasRole\('SUPER_ADMIN'\) && has\('system\.reset_data'\)/)
    assert.match(page, /\{canReset && <ErpResetCard \/>\}/)
  })

  it('the modal has the required title, fields and buttons', async () => {
    const card = await read('src', 'features', 'admin', 'erp-reset-card.tsx')
    for (const text of ['Permanently Reset ERP Data?', 'Permanently Reset ERP', 'Cancel', 'type="password"', 'autoComplete="current-password"']) {
      assert.ok(card.includes(text), `missing: ${text}`)
    }
    assert.ok(card.includes("setPassword('')"), 'password is cleared after the request')
  })
})

describe('ERP reset: Edge Function security (static checks)', () => {
  it('takes the user from the verified session, never from the body', async () => {
    const src = await read(...EDGE)
    assert.match(src, /caller\.auth\.getUser\(\)/)
    assert.match(src, /p_actor: user\.id/)
    assert.doesNotMatch(src, /body\.(user_id|actor|company)/)
  })

  it('verifies the password with the verified email and signs that extra session out', async () => {
    const src = await read(...EDGE)
    assert.match(src, /signInWithPassword\(\{ email: user\.email, password \}\)/)
    assert.match(src, /signOut\(\{ scope: 'local' \}\)/)
    assert.match(src, /signIn\.user\?\.id !== user\.id/)
  })

  it('never logs, stores or forwards the password', async () => {
    const src = await read(...EDGE)
    assert.doesNotMatch(src, /console\./)
    const uses = src.split('\n').filter((l) => /\bpassword\b/.test(l) && !l.trim().startsWith('//'))
    for (const line of uses) {
      assert.ok(!/rpc\(|JSON\.stringify|audit/.test(line) || /signInWithPassword/.test(line), `password used in: ${line.trim()}`)
    }
    assert.doesNotMatch(src, /p_password|password:\s*password[^}]*rpc/)
  })

  it('rate-limits wrong passwords and refuses passwordless accounts', async () => {
    const src = await read(...EDGE)
    assert.match(src, /erp_reset_attempt_allowed/)
    assert.match(src, /REAUTH_FAILED/)
    assert.match(src, /REAUTH_UNSUPPORTED/)
  })

  it('reports success only after the post-commit verification', async () => {
    const src = await read(...EDGE)
    const execute = src.indexOf("rpc('erp_reset_execute'")
    const verify = src.indexOf("rpc('erp_reset_verify'")
    const success = src.lastIndexOf('return json(req, 200')
    assert.ok(execute > 0 && verify > execute && success > verify)
    assert.match(src, /VERIFICATION_FAILED/)
  })
})

describe('ERP reset: migration safety (static checks)', () => {
  it('never truncates, disables triggers or row level security', async () => {
    const sql = (await read(...MIGRATION)).split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
    assert.doesNotMatch(sql, /\btruncate\b/i)
    assert.doesNotMatch(sql, /disable\s+trigger/i)
    assert.doesNotMatch(sql, /session_replication_role/i)
    assert.doesNotMatch(sql, /disable\s+row\s+level\s+security|no\s+force\s+row/i)
    assert.doesNotMatch(sql, /\bcascade\b/i)
  })

  it('execute and verify are granted to service_role only', async () => {
    const sql = await read(...MIGRATION)
    assert.match(sql, /revoke all on function public\.erp_reset_execute\(uuid, uuid, text\) from public, anon, authenticated;/)
    assert.match(sql, /grant execute on function public\.erp_reset_execute\(uuid, uuid, text\) to service_role;/)
    assert.doesNotMatch(sql, /grant execute on function public\.erp_reset_execute[^;]*authenticated/)
    assert.match(sql, /revoke all on function public\.erp_reset_verify\(uuid\) from public, anon, authenticated;/)
  })

  it('locks per company and is idempotent per request id', async () => {
    const sql = await read(...MIGRATION)
    assert.match(sql, /pg_try_advisory_xact_lock\(hashtextextended\('erp_reset:'/)
    assert.match(sql, /unique \(company_id, request_id\)/)
  })
})
