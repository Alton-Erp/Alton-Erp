// GSTR-2B screens (migration 20261231090600): file checks before upload (type, MIME, size, period), the default return period,
// outcome tones and the approval-note rule, the browser checksum, and that the screens never talk to tables or storage directly
// outside the dedicated file service.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  GSTR2B_XLSX_MIME, defaultReturnPeriod, gstr2bFileKind, needsApprovalNote, outcomeTone, sha256OfFile, shortSha, validateGstr2bFile,
} from '../../src/features/accounting/gstr2b-model.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

describe('GSTR-2B file checks', () => {
  it('accepts only .csv / .xlsx with their exact MIME type', () => {
    assert.deepEqual(gstr2bFileKind('GSTR2B_102026.xlsx'), { kind: 'XLSX', mime: GSTR2B_XLSX_MIME })
    assert.deepEqual(gstr2bFileKind('b2b.CSV'), { kind: 'CSV', mime: 'text/csv' })
    assert.equal(gstr2bFileKind('return.json'), null)
    assert.equal(gstr2bFileKind('old.xls'), null)
    assert.equal(gstr2bFileKind('noext'), null)
  })
  it('validates size, name and period before upload', () => {
    assert.equal(validateGstr2bFile({ name: 'a.csv', size: 10 }, '2026-10'), null)
    assert.match(validateGstr2bFile({ name: 'a.pdf', size: 10 }, '2026-10') ?? '', /CSV or Excel/)
    assert.match(validateGstr2bFile({ name: 'a.csv', size: 0 }, '2026-10') ?? '', /10 MB/)
    assert.match(validateGstr2bFile({ name: 'a.csv', size: 10 * 1024 * 1024 + 1 }, '2026-10') ?? '', /10 MB/)
    assert.match(validateGstr2bFile({ name: 'a.csv', size: 10 }, '2026-13') ?? '', /return period/)
  })
  it('defaults to the previous month (GSTR-2B is generated after the month)', () => {
    assert.equal(defaultReturnPeriod('2026-11-26'), '2026-10')
    assert.equal(defaultReturnPeriod('2027-01-05'), '2026-12')
  })
  it('only an exact match may be approved without a note; tones follow the outcome', () => {
    assert.equal(needsApprovalNote('EXACT'), false)
    assert.equal(needsApprovalNote('PARTIAL'), true)
    assert.equal(needsApprovalNote('GSTIN_MISMATCH'), true)
    assert.equal(outcomeTone('EXACT'), 'success')
    assert.equal(outcomeTone('DATE_MISMATCH'), 'warning')
    assert.equal(outcomeTone('TAX_MISMATCH'), 'danger')
    assert.equal(outcomeTone(null), 'neutral')
  })
  it('computes the same SHA-256 in the browser as the server', async () => {
    const bytes = new TextEncoder().encode('GSTIN of supplier,Invoice number\n27AABCP1234A1Z5,INV-1\n')
    assert.equal(await sha256OfFile(new Blob([bytes])), createHash('sha256').update(bytes).digest('hex'))
    assert.equal(shortSha('a'.repeat(64)), `${'a'.repeat(12)}…${'a'.repeat(6)}`)
  })
})

describe('GSTR-2B data access', () => {
  it('storage and the Edge Function are used only by the file service; the service never deletes or overwrites files', async () => {
    const files = await readFile(path.join(root, 'src', 'services', 'gstr2b-files.ts'), 'utf8')
    assert.match(files, /upsert: false/)
    assert.doesNotMatch(files, /\.remove\(|\.update\(|upsert: true/)
    assert.match(files, /functions\.invoke\('gst-2b-verify'/)
    const page = await readFile(path.join(root, 'src', 'pages', 'accounts', 'gstr2b-page.tsx'), 'utf8')
    assert.doesNotMatch(page, /requireSupabase|\.from\(|\.rpc\(/)
  })
  it('the Phase 3 GST dialog proposes (maker-checker) and the approval is a separate action', async () => {
    const detail = await readFile(path.join(root, 'src', 'pages', 'accounts', 'purchase-invoice-detail-page.tsx'), 'utf8')
    assert.match(detail, /Propose GST decision/)
    assert.match(detail, /itcAction\(x\.id, 'APPROVE'\)/)
    assert.doesNotMatch(detail, /GST verified \$\{status/)
  })
})
