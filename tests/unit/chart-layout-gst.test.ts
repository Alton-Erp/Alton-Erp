// Chart readability (shared chart layout rules) and the GST-exclusive reporting basis of the dashboards
// (migration 20261209090000). The GST-exclusive figures themselves are checked in tests/db/gst-exclusive-reporting-check.mjs.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  BAR_ROW_HEIGHT, axisWidth, barCardHeight, barChartHeight, compactIndian, labelChars, rankTopN, truncateLabel, valueLabelMargin,
} from '../../src/components/charts/chart-layout.ts'
import { EXCL_GST_MISSING, EXCL_GST_NOTE, reviewText } from '../../src/features/management/gst-basis.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const src = (p: string) => readFileSync(path.join(root, p), 'utf8')
const cats = (n: number) => Array.from({ length: n }, (_, i) => ({ label: `Category ${i + 1}`, value: (i * 7919) % 1000 + 1 }))

describe('Horizontal bar chart layout', () => {
  it('gives every bar its own row: height grows with the number of categories (5, 15, 30, 50, 100)', () => {
    for (const n of [5, 15, 30, 50, 100]) {
      const h = barChartHeight(n)
      assert.ok(h >= n * BAR_ROW_HEIGHT, `${n}: ${h}`)
      assert.ok(BAR_ROW_HEIGHT >= 24, 'a 12px label needs at least 24px per row')
    }
  })
  it('card height: at least the minimum, grows with rows, scrolls inside past the maximum', () => {
    assert.equal(barCardHeight(1), 200)
    assert.equal(barCardHeight(11), barChartHeight(11))
    assert.equal(barCardHeight(100), 560)
  })
  it('long labels are shortened with an ellipsis; short ones are kept', () => {
    const long = 'Premium Rimless Wall-Hung Water Closets with Soft-Close Seat Covers'
    const t = truncateLabel(long, labelChars(170))
    assert.ok(t.endsWith('…') && t.length <= labelChars(170) && long.startsWith(t.slice(0, -1)), t)
    assert.equal(truncateLabel('Basins', 20), 'Basins')
  })
  it('value labels get room on the right for the longest value', () => {
    assert.ok(valueLabelMargin(['5,26,000']) >= 8 * 7)
    assert.ok(valueLabelMargin(['₹12,34,56,789.00']) > valueLabelMargin(['5']))
    assert.ok(axisWidth(['1.2Cr']) >= 40 && axisWidth(['12,34,56,78,901']) <= 96)
  })
})

describe('Compact Indian axis ticks (full figures stay in tooltips and labels)', () => {
  it('thousands, lakhs and crores', () => {
    assert.equal(compactIndian(526000), '5.26L')
    assert.equal(compactIndian(12000000), '1.2Cr')
    assert.equal(compactIndian(12500), '12.5K')
    assert.equal(compactIndian(999), '999')
    assert.equal(compactIndian(48.5), '48.5')
    assert.equal(compactIndian(-250000), '-2.5L')
    assert.equal(compactIndian(0), '0')
  })
})

describe('Top-N with "Others"', () => {
  it('sorts largest first and keeps the original index for drill-downs', () => {
    const r = rankTopN([{ label: 'A', value: 3 }, { label: 'B', value: 10 }, { label: 'C', value: 1 }], 10)
    assert.deepEqual(r.map((x) => [x.label, x.index]), [['B', 1], ['A', 0], ['C', 2]])
  })
  it('15, 30, 50 and 100 categories: the top 10 plus one Others row adding up the rest', () => {
    for (const n of [15, 30, 50, 100]) {
      const data = cats(n)
      const r = rankTopN(data, 10)
      assert.equal(r.length, 11)
      const others = r.at(-1)!
      assert.ok(others.others && others.members === n - 10 && others.index === -1 && others.label === `Others (${n - 10})`)
      const total = data.reduce((s, d) => s + d.value, 0)
      assert.equal(r.reduce((s, d) => s + d.value, 0), total, 'nothing lost')
      assert.ok(r.slice(0, 10).every((d, i, a) => i === 0 || a[i - 1].value >= d.value))
    }
  })
  it('no Others row when only one category would go into it; "Show all" keeps every row', () => {
    assert.equal(rankTopN(cats(11), 10).length, 11)
    assert.ok(!rankTopN(cats(11), 10).some((d) => d.others))
    assert.equal(rankTopN(cats(100), null).length, 100)
  })
  it('large and small quantities together keep their order', () => {
    const r = rankTopN([{ label: 'small', value: 3 }, { label: 'huge', value: 526000 }, { label: 'mid', value: 1500 }], 10)
    assert.deepEqual(r.map((d) => d.label), ['huge', 'mid', 'small'])
  })
})

describe('GST-exclusive reporting basis', () => {
  it('wording used by every dashboard', () => {
    assert.equal(EXCL_GST_NOTE, 'All monetary values are in INR, excluding GST. Stock and outstanding balances are as of the current date and time.')
    assert.match(EXCL_GST_MISSING, /20261209090000/)
  })
  it('review flag: shown only when balances cannot be split, with the GST-inclusive amount named as such', () => {
    const money = (v: number) => `₹${v.toFixed(2)}`
    assert.equal(reviewText({ count: 0, balance: 0 }, 'part-paid invoice(s)', money), null)
    assert.equal(reviewText(null, 'x', money), null)
    assert.equal(reviewText({ count: 2, balance: 1360 }, 'part-paid invoice(s)', money),
      '2 part-paid invoice(s) (₹1360.00 incl. GST) not included: payments are not split into taxable value and GST — review')
  })
  it('no dashboard still says "including GST"; every money dashboard reads the GST-exclusive figures', () => {
    for (const f of ['src/pages/management-overview-page.tsx', 'src/pages/billing/invoice-dashboard-page.tsx', 'src/pages/sales/sales-dashboard-page.tsx',
      'src/features/management/module-dashboard-shell.tsx']) {
      const s = src(f)
      assert.ok(!/including GST/i.test(s), `${f} says including GST`)
      assert.ok(s.includes('fetchExclGst'), `${f} does not read the GST-exclusive figures`)
    }
    for (const f of ['src/pages/purchasing/purchase-dashboard-page.tsx', 'src/pages/purchasing/grn-dashboard-page.tsx', 'src/pages/ledger/ledger-dashboard-page.tsx']) {
      assert.match(src(f), /exclGst="(PURCHASE|GRN|LEDGER)"/, f)
    }
  })
  it('drill-downs sum the GST-exclusive columns of the GST-exclusive views', () => {
    const reg = src('src/features/drilldown/drill-registry.ts')
    for (const rel of ["relation: 'purchase_order_list_excl_gst'", "relation: 'sales_invoice_list_excl_gst'", "fn: 'sales_orders_v2_list_excl_gst'", "fn: 'ledger_parties_excl_gst'"]) {
      assert.ok(reg.includes(rel), rel)
    }
    for (const key of ['purchase.pending_value', 'purchase.period', 'purchase.supplier', 'purchase.month', 'sales.value', 'billing.value', 'billing.outstanding', 'billing.overdue',
      'billing.month_invoiced', 'billing.issued_period', 'billing.outstanding_all', 'ledger.receivables', 'ledger.payables']) {
      const line = reg.slice(reg.indexOf(`key: '${key}'`), reg.indexOf(`key: '${key}'`) + 600)
      assert.ok(!/measure: money\('(grand_total|balance_due|pending_value|receivable|payable)'\)/.test(line.slice(0, line.indexOf('conditions'))), `${key} still sums a GST-inclusive column`)
    }
  })
  it('the migration only adds read-only objects (no table, no update of posted data)', () => {
    const sql = src('supabase/migrations/20261209090000_gst_exclusive_reporting.sql').toLowerCase()
    assert.ok(!/\b(create table|alter table|insert into|update public\.|delete from|drop )/.test(sql.replace(/--.*$/gm, '')))
    const down = src('supabase/rollback/20261209090000_gst_exclusive_reporting_down.sql').toLowerCase()
    assert.ok(!/drop table/.test(down))
  })
})
