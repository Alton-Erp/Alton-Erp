// Support Centre live updates (migration 20261225090000): badge text, change detection, and the wiring rules
// (one loop in the app shell, Realtime + 3 s fallback, paused when hidden, in-place reloads, no browser-driven sync).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { BADGE_FOR, badgeText, POLL_MS, RECONNECT_MS, sameSummary } from '../../src/features/support/live/live-model.ts'
import type { LiveSummary } from '../../src/services/support.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const src = (p: string) => readFileSync(path.join(root, p), 'utf8')
const S = (o: Partial<LiveSummary> = {}): LiveSummary => ({ whatsapp_unread: 5, email_unread: 12, missed_calls: 3,
  stamps: { whatsapp: 'w1', email: 'e1', calls: 'c1' }, at: 'now', ...o })

describe('badges', () => {
  it('hidden at zero, the number up to 99, then 99+', () => {
    assert.equal(badgeText(0), null)
    assert.equal(badgeText(null), null)
    assert.equal(badgeText(-1), null)
    assert.equal(badgeText(5), '5')
    assert.equal(badgeText(99), '99')
    assert.equal(badgeText(100), '99+')
    assert.equal(badgeText(2500), '99+')
  })
  it('WhatsApp, Emails and Calls carry their own count', () => {
    assert.deepEqual(BADGE_FOR, { 'support-whatsapp': 'whatsapp_unread', 'support-emails': 'email_unread', 'support-calls': 'missed_calls' })
  })
  it('a poll that finds nothing new changes nothing (no re-render every 3 s)', () => {
    assert.equal(sameSummary(S(), S({ at: 'later' })), true)
    assert.equal(sameSummary(S(), S({ email_unread: 13 })), false)
    assert.equal(sameSummary(S(), S({ stamps: { whatsapp: 'w2', email: 'e1', calls: 'c1' } })), false)
    assert.equal(sameSummary(null, null), true)
  })
  it('the sidebar shows the badge right of the entry and on the icon in the collapsed rail; red with white text', () => {
    const s = src('src/components/layout/sidebar.tsx')
    assert.match(s, /data-testid=\{`nav-badge-\$\{item\.key\}`\}/)
    assert.match(s, /ml-auto inline-flex .* bg-red-600 .* text-white/)
    assert.match(s, /absolute -top-1\.5 -right-2 .* bg-red-600/)
  })
})

describe('live loop', () => {
  const provider = src('src/features/support/live/support-live.tsx')
  it('one provider, mounted once in the app shell (navigating never starts a second loop)', () => {
    assert.match(src('src/components/layout/app-layout.tsx'), /<SupportLiveProvider>/)
    const users = ['src/pages/support/support-whatsapp-page.tsx', 'src/pages/support/support-emails-page.tsx', 'src/features/support/call-log.tsx']
    for (const f of users) assert.doesNotMatch(src(f), /SupportLiveProvider|setInterval/, f)
  })
  it('Realtime on conversations, WhatsApp messages and call signals, with reconnect; 3 s polling only while visible; cleaned up', () => {
    assert.equal(POLL_MS, 3000)
    assert.ok(RECONNECT_MS.length >= 3 && RECONNECT_MS.every((x, i) => i === 0 || x >= RECONNECT_MS[i - 1]))
    for (const t of ['support_conversations', 'support_whatsapp_messages', 'support_call_signals']) assert.match(provider, new RegExp(`table: '${t}'`))
    assert.match(provider, /document\.visibilityState === 'visible'\) load\(\)/)
    assert.match(provider, /CHANNEL_ERROR' \|\| status === 'TIMED_OUT' \|\| status === 'CLOSED'/)
    assert.match(provider, /window\.clearInterval\(t\)/)
    assert.match(provider, /removeChannel\(channel\)/)
  })
  it('requests never overlap (one in flight, a change during it is read right after)', () => {
    assert.match(provider, /if \(inFlight\.current\) \{ again\.current = true; return \}/)
  })
  it('the browser never drives the Gmail sync: no call to google-gmail-sync from the live loop or the pages', () => {
    for (const f of ['src/features/support/live/support-live.tsx', 'src/pages/support/support-emails-page.tsx', 'src/pages/support/support-whatsapp-page.tsx']) {
      assert.doesNotMatch(src(f), /google-gmail-sync|syncMailboxNow/, f)
    }
  })
  it('screens reload in place when their stamp moves; reading updates the badge at once', () => {
    assert.match(src('src/pages/support/support-whatsapp-page.tsx'), /useReloadOnChange\(live\.summary\?\.stamps\.whatsapp, list\.reload\)/)
    assert.match(src('src/pages/support/support-emails-page.tsx'), /useReloadOnChange\(live\.summary\?\.stamps\.email, list\.reload\)/)
    assert.match(src('src/features/support/call-log.tsx'), /useReloadOnChange\(live\.summary\?\.stamps\.calls, list\.reload\)/)
    assert.match(src('src/features/support/wa-web/chat-workspace.tsx'), /markConversationRead\(id\)\.then\(\(\) => \{ onChanged\(\); live\.refresh\(\) \}/)
    assert.match(src('src/features/support/mail/mail-thread.tsx'), /onChanged\(\)\n\s+live\.refresh\(\)/)
  })
  it('a new message never scrolls a reader who is reading older messages to the bottom', () => {
    assert.match(src('src/features/support/wa-web/chat-workspace.tsx'), /\(atBottom \|\| lastCount\.current === 0\)\) el\.scrollTop = el\.scrollHeight/)
  })
})

describe('database and scheduler', () => {
  const m = src('supabase/migrations/20261225090000_support_live_updates.sql')
  it('the Gmail job runs every 2 minutes through the existing google-gmail-sync; secrets only from Vault', () => {
    assert.match(m, /cron\.schedule\('alton-gmail-sync', '\*\/2 \* \* \* \*', 'select private\.support_gmail_sync_tick\(\)'\)/)
    assert.match(m, /\/functions\/v1\/google-gmail-sync/)
    assert.match(m, /vault\.decrypted_secrets/)
    assert.doesNotMatch(m, /x-cron-secret', '[^v]/) // the secret is a variable, never a literal
  })
  it('counts need support.view and are read-only aggregates', () => {
    assert.match(m, /support_live_summary\(\)[\s\S]*stable[\s\S]*require_permission\('support\.view'\)/)
  })
  it('the migration is additive', () => {
    assert.doesNotMatch(m, /delete from|drop table|update public\.support_(email_messages|whatsapp_messages|conversations) /)
  })
})
