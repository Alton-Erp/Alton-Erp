// Acefone telephony (migration 20261211090000): presentation model and front-end wiring.
// Status transitions, matching and idempotency run in the database: tests/db/acefone-telephony-check.mjs.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { WEBHOOK_EVENTS } from '../../supabase/functions/_shared/acefone/acefone.ts'
import { CALL_STATUS_META, PHONE_WEBHOOK_EVENTS, phoneWebhookUrl } from '../../src/features/support/support-model.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const src = (p: string) => readFileSync(path.join(root, p), 'utf8')

describe('call status model', () => {
  it('covers exactly the statuses the database allows', () => {
    assert.deepEqual(Object.keys(CALL_STATUS_META).sort(), ['COMPLETED', 'CONNECTED', 'FAILED', 'INITIATED', 'MISSED', 'RINGING'])
  })
})

describe('webhook URLs', () => {
  it('uses a placeholder for the secret, never a value', () => {
    const u = phoneWebhookUrl('https://x.supabase.co/', 'acc-1', 'hangup')
    assert.equal(u, 'https://x.supabase.co/functions/v1/acefone-webhook?account=acc-1&event=hangup&token=<ACEFONE_WEBHOOK_SECRET>')
  })
  it('lists only events the webhook function accepts', () => {
    for (const [e] of PHONE_WEBHOOK_EVENTS) assert.ok(e in WEBHOOK_EVENTS, e)
  })
})

describe('no secrets in the browser bundle sources', () => {
  it('front-end phone code never reads Acefone secrets or the service role key', () => {
    for (const f of ['src/services/phone.ts', 'src/features/support/phone-settings.tsx', 'src/features/support/phone-components.tsx']) {
      const s = src(f)
      assert.ok(!/SERVICE_ROLE|Deno\.env|api\.acefone\.in\/v1/.test(s), f)
    }
  })
  it('the call detail page never asks for the recording link', () => {
    assert.ok(!src('src/pages/support/support-call-detail-page.tsx').includes('provider_recording_ref'))
  })
})
