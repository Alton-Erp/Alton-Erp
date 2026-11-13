// WhatsApp presentation model: setup states, statuses, window text, template placeholders and files — and that
// the browser code never handles Meta tokens or calls Meta directly.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { WA_NUMBER_PATHS, WA_SETUP_META, WA_STATUS_META, waFileProblem, waTemplatePlaceholders, waTemplatePreview, waWindowText } from '../../src/features/support/support-model.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const src = (p: string) => readFileSync(path.join(root, p), 'utf8')
const sqlList = (re: RegExp) => [...(re.exec(src('supabase/migrations/20261213090000_whatsapp_cloud.sql'))![1].matchAll(/'([A-Z_]+)'/g))].map((m) => m[1]).sort()

describe('WhatsApp model', () => {
  it('setup states, number paths and statuses match the database', () => {
    assert.deepEqual(Object.keys(WA_SETUP_META).sort(), sqlList(/setup_state in \(([^)]+)\)/))
    assert.deepEqual(Object.keys(WA_NUMBER_PATHS).sort(), sqlList(/number_path in \(([^)]+)\)/))
    assert.deepEqual(Object.keys(WA_STATUS_META).sort(), sqlList(/status in \('RECEIVED'([^)]*)\)/).concat('RECEIVED').sort())
  })
  it('pending is never shown as sent', () => {
    assert.equal(WA_STATUS_META.PENDING.label, 'Pending')
    assert.match(WA_STATUS_META.PENDING.hint, /until Meta reports Sent/)
  })
  it('window text', () => {
    const now = Date.parse('2026-11-13T10:00:00Z')
    assert.match(waWindowText(true, '2026-11-13T12:30:00Z', now), /2 h 30 min/)
    assert.match(waWindowText(false, null, now), /only approved templates/)
  })
  it('template placeholders (positional and named), preview, unsupported media headers / URL buttons', () => {
    const pos = [{ type: 'BODY', text: 'Hi {{1}}, order {{2}} ({{1}})' }]
    assert.deepEqual(waTemplatePlaceholders(pos), { vars: ['1', '2'], supported: true })
    assert.equal(waTemplatePreview(pos, { 1: 'Ravi' }), 'Hi Ravi, order {{2}} (Ravi)')
    assert.deepEqual(waTemplatePlaceholders([{ type: 'HEADER', format: 'TEXT', text: 'Ticket {{ticket}}' }, { type: 'BODY', text: 'Dear {{name}}' }]).vars, ['ticket', 'name'])
    assert.equal(waTemplatePlaceholders([{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'x' }]).supported, false)
    assert.equal(waTemplatePlaceholders([{ type: 'BODY', text: 'x' }, { type: 'BUTTONS', buttons: [{ url: 'https://x.example/{{1}}' }] }]).supported, false)
  })
  it('files: JPEG / PNG up to 5 MB, documents up to 25 MB, nothing else', () => {
    assert.equal(waFileProblem({ name: 'a.JPG', size: 100 }), null)
    assert.match(waFileProblem({ name: 'a.png', size: 6 * 1048576 })!, /5 MB/)
    assert.equal(waFileProblem({ name: 'q.pdf', size: 20 * 1048576 }), null)
    assert.match(waFileProblem({ name: 'q.pdf', size: 26 * 1048576 })!, /25 MB/)
    assert.match(waFileProblem({ name: 'run.exe', size: 10 })!, /accepts/)
  })
})

describe('no Meta secrets in the browser code', () => {
  it('front-end WhatsApp code never handles tokens or calls graph.facebook.com', () => {
    for (const f of ['src/services/whatsapp.ts', 'src/features/support/whatsapp-components.tsx', 'src/features/support/whatsapp-settings.tsx', 'src/pages/support/support-whatsapp-page.tsx']) {
      const s = src(f)
      // Secret names appear only as yes / no status flags and help text, never as values.
      assert.ok(!/graph\.facebook\.com|access_token\s*:\s*string|app_secret\s*:\s*string|Bearer |SERVICE_ROLE/i.test(s), f)
    }
  })
  it('no Zoho Bigin or WhatsApp Web automation anywhere in the integration', () => {
    const files = ['supabase/migrations/20261213090000_whatsapp_cloud.sql', 'supabase/functions/_shared/whatsapp/whatsapp.ts', 'supabase/functions/_shared/whatsapp/send.ts',
      'src/services/whatsapp.ts', 'src/features/support/whatsapp-components.tsx']
    for (const f of files) assert.ok(!/bigin\.zoho|zohoapis|web\.whatsapp\.com|whatsapp-web\.js|baileys|puppeteer/i.test(src(f)), f)
  })
})
