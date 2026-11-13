// Gmail presentation model: recipients, reply-all, subjects, attachment checks, send states, and that the
// browser code never handles Google tokens or secrets.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { EMAIL_SEND_META, GMAIL_CONNECT_REASONS, emailAttachmentProblem, parseRecipients, replyRecipients, replySubject } from '../../src/features/support/support-model.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const src = (p: string) => readFileSync(path.join(root, p), 'utf8')

describe('email model', () => {
  it('recipients: names, separators, duplicates and invalid entries', () => {
    assert.deepEqual(parseRecipients('Ravi <Ravi@X.example>; b@y.example,\nravi@x.example, nope'), { emails: ['ravi@x.example', 'b@y.example'], invalid: ['nope'] })
  })
  it('reply goes to Reply-To or the sender; reply all adds To / Cc without the support mailbox', () => {
    const e = { direction: 'INBOUND' as const, from_address: 'ravi@x.example', reply_to: null, to: [{ email: 'support@alton.example' }, { email: 'c@x.example' }], cc: [{ email: 'boss@x.example' }] }
    assert.deepEqual(replyRecipients(e, 'support@alton.example', false), { to: ['ravi@x.example'], cc: [] })
    assert.deepEqual(replyRecipients(e, 'support@alton.example', true), { to: ['ravi@x.example'], cc: ['c@x.example', 'boss@x.example'] })
    assert.deepEqual(replyRecipients({ ...e, reply_to: 'orders@x.example' }, null, false).to, ['orders@x.example'])
    assert.deepEqual(replyRecipients({ ...e, direction: 'OUTBOUND', to: [{ email: 'ravi@x.example' }] }, 'support@alton.example', false).to, ['ravi@x.example'])
  })
  it('reply subject keeps the thread subject', () => {
    assert.equal(replySubject('RE: Fwd: re: Cracked basin'), 'Re: Cracked basin')
    assert.equal(replySubject('Cracked basin'), 'Re: Cracked basin')
  })
  it('attachments: permitted types, count and total size', () => {
    assert.equal(emailAttachmentProblem([{ name: 'a.pdf', size: 100 }, { name: 'b.XLSX', size: 100 }]), null)
    assert.match(emailAttachmentProblem([{ name: 'run.exe', size: 10 }])!, /cannot be sent/)
    assert.match(emailAttachmentProblem([{ name: 'noext', size: 10 }])!, /cannot be sent/)
    assert.match(emailAttachmentProblem([{ name: 'a.pdf', size: 6 * 1048576 }, { name: 'b.pdf', size: 5 * 1048576 }])!, /10 MB/)
    assert.match(emailAttachmentProblem(Array.from({ length: 11 }, (_, i) => ({ name: `${i}.pdf`, size: 1 })))!, /At most 10/)
  })
  it('send states: Sent only after Gmail accepted; every OAuth return reason explained', () => {
    assert.deepEqual(Object.keys(EMAIL_SEND_META).sort(), ['FAILED', 'PENDING', 'SENT'])
    assert.match(EMAIL_SEND_META.SENT.hint, /Gmail accepted/)
    const reasons = [...src('supabase/functions/google-oauth-callback/handler.ts').matchAll(/fail\('([a-z_]+)'/g)].map((m) => m[1])
    for (const r of new Set(reasons)) assert.ok(GMAIL_CONNECT_REASONS[r], r)
  })
})

describe('no Google secrets in the browser code', () => {
  it('front-end email code never handles tokens, client secrets or Google endpoints', () => {
    for (const f of ['src/services/email.ts', 'src/features/support/email-components.tsx', 'src/features/support/email-settings.tsx']) {
      const s = src(f)
      // client_secret appears only as a yes / no status flag, never as a value.
      assert.ok(!/refresh_token|access_token|client_secret:\s*string|oauth2\.googleapis|gmail\.googleapis|SERVICE_ROLE/i.test(s), f)
    }
  })
  it('formatted email is shown only in a sandboxed frame without scripts', () => {
    const s = src('src/features/support/email-components.tsx')
    assert.ok(s.includes('sandbox="allow-popups allow-popups-to-escape-sandbox"') && !s.includes('allow-scripts') && !s.includes('dangerouslySetInnerHTML'))
    assert.ok(s.includes("default-src 'none'"))
  })
})
