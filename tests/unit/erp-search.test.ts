// ERP search rule (src/lib/search.ts): normalisation, word matching, safe PostgREST filters, and that the server filter and the
// client rule agree on every example. Run: npm run test:unit

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import {
  SEARCH_DEBOUNCE_MS,
  SEARCH_MAX_WORDS,
  ilikeValue,
  inCondition,
  matchesSearch,
  normalizeSearch,
  searchFilter,
  searchWords,
} from '../../src/lib/search.ts'

const NAME = 'ALTON Premium Ceramic Wash Basin White'

// ---- A small evaluator of PostgREST `or` logic trees (ilike / eq / in), enough to run the filters searchFilter builds. ----------------
type Row = Record<string, string | number | null>
function splitTop(s: string): string[] {
  const out: string[] = []
  let depth = 0, quoted = false, cur = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quoted && c === '\\') { cur += c + s[++i]; continue }
    if (c === '"') quoted = !quoted
    else if (!quoted && c === '(') depth++
    else if (!quoted && c === ')') depth--
    if (!quoted && depth === 0 && c === ',') { out.push(cur); cur = '' } else cur += c
  }
  if (cur) out.push(cur)
  return out
}
const unquote = (v: string) => (v.startsWith('"') ? v.slice(1, -1).replace(/\\(.)/g, '$1') : v)
function likeToRegex(pattern: string): RegExp {
  let re = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '\\') re += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    else if (c === '%') re += '.*'
    else if (c === '_') re += '.'
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`, 'is')
}
function evalTerm(term: string, row: Row): boolean {
  const logic = term.match(/^(and|or)\((.*)\)$/s)
  if (logic) {
    const parts = splitTop(logic[2]).map((p) => evalTerm(p, row))
    return logic[1] === 'and' ? parts.every(Boolean) : parts.some(Boolean)
  }
  const m = term.match(/^([a-z_]+)\.(ilike|eq|in)\.(.*)$/s)
  if (!m) throw new Error(`unparsed term ${term}`)
  const [, col, op, raw] = m
  const v = row[col]
  if (op === 'eq') return String(v) === raw
  if (op === 'in') return raw.slice(1, -1).split(',').includes(String(v))
  return v !== null && v !== undefined && likeToRegex(unquote(raw)).test(String(v))
}
const passes = (filter: string | null, row: Row) => filter === null || evalTerm(`or(${filter})`, row)

const FIELDS = ['sku', 'product_name', 'barcode', 'description']
const rows: Row[] = [
  { id: '1', sku: 'WB-100', product_name: NAME, barcode: '8901234567890', description: 'Wall hung, 600 mm' },
  { id: '2', sku: 'WC 200 #A', product_name: 'ALTON Classic Water Closet', barcode: null, description: 'Floor mounted, white' },
  { id: '3', sku: 'TAP_10%', product_name: 'Pillar Tap 10% off', barcode: null, description: null },
  { id: '4', sku: 'A,B.C(1)', product_name: 'Odd "quoted" name', barcode: null, description: 'back\\slash' },
]
const found = (q: string) => rows.filter((r) => passes(searchFilter(q, FIELDS), r)).map((r) => r.id)
const foundClient = (q: string) => rows.filter((r) => matchesSearch(FIELDS.map((f) => r[f]), q)).map((r) => r.id)

describe('normalisation', () => {
  it('trims, collapses spaces, limits words and length', () => {
    assert.equal(normalizeSearch('   basin    white  '), 'basin white')
    assert.equal(normalizeSearch('\tbasin\n white'), 'basin white')
    assert.equal(normalizeSearch(null), '')
    assert.equal(normalizeSearch('x'.repeat(500)).length, 200)
    assert.deepEqual(searchWords('Basin  WHITE basin'), ['basin', 'white'])
    assert.equal(searchWords('a b c d e f g h i j k').length, SEARCH_MAX_WORDS)
    assert.equal(searchWords('y'.repeat(100))[0].length, 60)
    assert.ok(SEARCH_DEBOUNCE_MS >= 250 && SEARCH_DEBOUNCE_MS <= 350)
  })
  it('empty / whitespace search gives no filter (all records)', () => {
    assert.equal(searchFilter('', FIELDS), null)
    assert.equal(searchFilter('    ', FIELDS), null)
    assert.deepEqual(found('   '), ['1', '2', '3', '4'])
  })
})

describe('the required examples find "ALTON Premium Ceramic Wash Basin White"', () => {
  const examples = ['ALTON', 'Premium', 'Ceramic', 'Wash', 'Basin', 'White', 'mic', 'eram', 'asin', 'basin white', 'Basin White', 'white basin',
    'alton   basin', 'PREMIUM', 'remi', 'wb-100', 'B-10', '4567', 'wall hung', '600']
  for (const q of examples) {
    it(`“${q}” (server filter and client rule)`, () => {
      assert.ok(found(q).includes('1'), `server filter missed: ${q}`)
      assert.ok(matchesSearch([rows[0].sku, rows[0].product_name, rows[0].barcode, rows[0].description], q), `client missed: ${q}`)
    })
  }
  it('does not match when a word is absent', () => {
    assert.ok(!found('basin black').includes('1'))
    assert.ok(!matchesSearch([NAME], 'basin black'))
    assert.deepEqual(found('zzzz-no-such'), [])
  })
})

describe('server filter = client rule', () => {
  for (const q of ['alton', 'white', 'alton white', 'WC 200', 'WC 200 #A', '#a', '10%', '%', '_', 'tap_', 'a,b', '(1)', '"quoted"', 'back\\slash', 'c.', 'closet floor', 'floor  closet']) {
    it(`“${q}”`, () => assert.deepEqual(found(q), foundClient(q)))
  }
  it('LIKE wildcards are literal: "%" only finds the record that contains a percent sign', () => {
    assert.deepEqual(found('%'), ['3'])
    assert.deepEqual(found('_'), ['3'])
  })
})

describe('filter shape', () => {
  it('one word: one alternative per field, values quoted, typed case kept', () => {
    assert.equal(searchFilter('  Basin ', ['sku', 'product_name']), 'sku.ilike."%Basin%",product_name.ilike."%Basin%"')
  })
  it('several words: the phrase in any field, or every word in some field', () => {
    const f = searchFilter('WC 200', ['sku'])
    assert.equal(f, 'sku.ilike."%WC 200%",and(or(sku.ilike."%wc%"),or(sku.ilike."%200%"))')
  })
  it('extra conditions join each word group', () => {
    const f = searchFilter('basin 12', ['sku'], (w) => (w === '12' ? ['length_cm.eq.12'] : inCondition('category_id', [])))
    assert.equal(f, 'sku.ilike."%basin 12%",and(or(sku.ilike."%basin%"),or(sku.ilike."%12%",length_cm.eq.12))')
    assert.deepEqual(inCondition('category_id', ['a', 'b']), ['category_id.in.(a,b)'])
  })
  it('escapes wildcards, quotes and backslashes', () => {
    assert.equal(ilikeValue('10%_x'), '"%10\\\\%\\\\_x%"')
    assert.equal(ilikeValue('a"b'), '"%a\\"b%"')
  })
})

describe('DataTable uses the rule', () => {
  const src = readFileSync(new URL('../../src/components/common/data-table.tsx', import.meta.url), 'utf8')
  it('word matching, debounce, clear, server hand-off', () => {
    assert.match(src, /matchesSearch\(searchable\.map/)
    assert.match(src, /SEARCH_DEBOUNCE_MS/)
    assert.match(src, /e\.key === 'Escape'/)
    assert.match(src, /serverQuery/)
    assert.match(src, /q !== lastSent\.current/)
  })
})

describe('services use the shared rule', () => {
  const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8')
  it('no hand-built unquoted ilike search remains in the searched services', () => {
    for (const p of ['src/services/products.ts', 'src/services/inventory.ts', 'src/services/bom-components.ts', 'src/services/production.ts']) {
      const s = read(p)
      assert.ok(!/\.ilike\.%\$\{/.test(s), `${p} builds an unquoted ilike value`)
      assert.match(s, /searchFilter\(/, `${p} does not use searchFilter`)
    }
  })
  it('BOM, production and outsourcing lists search on the server with related records', () => {
    const s = read('src/services/production.ts')
    for (const fn of ['bom_search', 'production_order_search', 'outsourcing_order_search']) assert.match(s, new RegExp(`searchRpc<[A-Za-z]+>\\('${fn}', q, status\\)`))
    assert.match(s, /p_search: search, p_status: status, p_limit: 2000/)
  })
})
