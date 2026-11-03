import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  acceptScan, CODE128_PATTERNS, code128Values, code128Widths, extensionOf, fileSignatureMatches, isCode128B, parseScanPayload, scanPayload,
} from '../../src/features/admin/barcode.ts'

describe('Code 128', () => {
  it('has 107 well-formed symbols (11 modules each, stop 13) with unique patterns', () => {
    assert.equal(CODE128_PATTERNS.length, 107)
    for (const [i, p] of CODE128_PATTERNS.entries()) {
      const sum = [...p].reduce((s, d) => s + Number(d), 0)
      assert.equal(sum, i === 106 ? 13 : 11, `symbol ${i}`)
    }
    assert.equal(new Set(CODE128_PATTERNS).size, 107)
  })

  it('encodes code set B with the standard weighted checksum', () => {
    // Start B (104) + "A" (33) * 1 = 137 -> 137 % 103 = 34
    assert.deepEqual(code128Values('A'), [104, 33, 34])
    // "PJJ123C": 104 + 48*1 + 42*2 + 42*3 + 17*4 + 18*5 + 19*6 + 35*7 = 879 -> 879 % 103 = 55
    assert.equal(code128Values('PJJ123C').at(-1), 55)
  })

  it('produces start + data + checksum + stop modules', () => {
    const widths = code128Widths('8900000000017')
    assert.equal(widths.reduce((s, w) => s + w, 0), 11 * (13 + 2) + 13)
    assert.equal(widths.length, 6 * (13 + 2) + 7)
  })

  it('rejects text outside printable ASCII', () => {
    assert.equal(isCode128B('ABC-123'), true)
    assert.equal(isCode128B('₹100'), false)
    assert.throws(() => code128Values(''))
  })
})

describe('internal QR payloads', () => {
  const id = 'E7E5A000-0000-4000-8000-0000000000C1'
  it('carries only an internal link with a record id', () => {
    const p = scanPayload('https://erp.example.com/', 'P', id)
    assert.equal(p, 'https://erp.example.com/scan?c=P-e7e5a000-0000-4000-8000-0000000000c1')
    assert.deepEqual(parseScanPayload(p), { kind: 'P', id: id.toLowerCase() })
    assert.deepEqual(parseScanPayload('B-' + id), { kind: 'B', id: id.toLowerCase() })
  })

  it('ignores ordinary barcodes and malformed ids', () => {
    assert.equal(parseScanPayload('8900000000017'), null)
    assert.equal(parseScanPayload('P-not-a-uuid'), null)
    assert.throws(() => scanPayload('https://x', 'P', 'abc'))
  })
})

describe('scan handling', () => {
  it('ignores an identical repeat within the window (scanner double-read)', () => {
    assert.equal(acceptScan(null, '8900000000017', 1000), true)
    assert.equal(acceptScan({ code: '8900000000017', at: 1000 }, '8900000000017', 1800), false)
    assert.equal(acceptScan({ code: '8900000000017', at: 1000 }, '8900000000017', 2600), true)
    assert.equal(acceptScan({ code: '8900000000017', at: 1000 }, 'OTHER', 1100), true)
    assert.equal(acceptScan(null, '   ', 1000), false)
  })
})

describe('file signatures', () => {
  it('accepts files whose content matches the extension', () => {
    assert.equal(fileSignatureMatches('pdf', new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])), true)
    assert.equal(fileSignatureMatches('png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), true)
    assert.equal(fileSignatureMatches('xlsx', new Uint8Array([0x50, 0x4b, 0x03, 0x04])), true)
    assert.equal(fileSignatureMatches('csv', new TextEncoder().encode('sku,qty\nA,1')), true)
  })

  it('rejects renamed or binary files', () => {
    assert.equal(fileSignatureMatches('pdf', new Uint8Array([0x4d, 0x5a, 0x90])), false) // an .exe renamed to .pdf
    assert.equal(fileSignatureMatches('csv', new Uint8Array([0x41, 0x00, 0x42])), false)
    assert.equal(fileSignatureMatches('exe', new Uint8Array([0x4d, 0x5a])), false)
    assert.equal(extensionOf('Drawing.Final.PDF'), 'pdf')
    assert.equal(extensionOf('noext'), '')
  })
})
