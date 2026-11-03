import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { dedupeAlerts, filterAlerts, refreshFailedAlert, sortAlerts } from '../../src/features/analytics/analytics-alerts.ts'
import { buildExportSheets, pct, percentOf, reportMetaRows, sumMoney, unitList } from '../../src/features/analytics/analytics-format.ts'
import {
  addDays, bucketFor, dayStartInstant, daysBetween, describePeriod, financialYears, fyLabel, fyStart, isIsoDate, presetRange,
} from '../../src/features/analytics/analytics-period.ts'
import type { ExecutiveAlert } from '../../src/services/analytics.ts'

describe('analytics periods', () => {
  it('computes each quick range from the company "today" without future dates', () => {
    const today = '2026-10-11' // a Sunday
    assert.deepEqual(presetRange('today', today), { from: today, to: today })
    assert.deepEqual(presetRange('this_week', today), { from: '2026-10-05', to: today }) // weeks start on Monday
    assert.deepEqual(presetRange('this_month', today), { from: '2026-10-01', to: today })
    assert.deepEqual(presetRange('previous_month', today), { from: '2026-09-01', to: '2026-09-30' })
    assert.deepEqual(presetRange('this_quarter', today), { from: '2026-10-01', to: today })
    assert.deepEqual(presetRange('current_fy', today), { from: '2026-04-01', to: today })
    assert.deepEqual(presetRange('previous_fy', today), { from: '2025-04-01', to: '2026-03-31' })
  })

  it('handles year and leap-year boundaries', () => {
    assert.deepEqual(presetRange('previous_month', '2026-01-15'), { from: '2025-12-01', to: '2025-12-31' })
    assert.deepEqual(presetRange('previous_month', '2028-03-10'), { from: '2028-02-01', to: '2028-02-29' })
    assert.deepEqual(presetRange('this_quarter', '2027-02-14'), { from: '2027-01-01', to: '2027-02-14' })
    assert.deepEqual(presetRange('current_fy', '2027-03-31'), { from: '2026-04-01', to: '2027-03-31' })
    assert.deepEqual(presetRange('current_fy', '2027-04-01'), { from: '2027-04-01', to: '2027-04-01' })
    assert.equal(addDays('2026-12-31', 1), '2027-01-01')
    assert.equal(daysBetween('2026-10-01', '2026-10-11'), 10)
  })

  it('aligns quarters and years to a non-April financial year', () => {
    assert.equal(fyStart('2026-10-11', 1), '2026-01-01')
    assert.equal(fyLabel('2026-01-01', 1), '2026')
    assert.equal(fyLabel('2026-04-01', 4), '2026-27')
    assert.deepEqual(presetRange('this_quarter', '2026-11-20', 7), { from: '2026-10-01', to: '2026-11-20' })
  })

  it('lists financial years, the current one ending today', () => {
    const years = financialYears('2026-10-11', 4, 3)
    assert.deepEqual(years, [
      { label: '2026-27', from: '2026-04-01', to: '2026-10-11' },
      { label: '2025-26', from: '2025-04-01', to: '2026-03-31' },
      { label: '2024-25', from: '2024-04-01', to: '2025-03-31' },
    ])
  })

  it('chooses a readable bucket and validates ISO dates', () => {
    assert.equal(bucketFor('2026-10-01', '2026-10-31'), 'day')
    assert.equal(bucketFor('2026-07-01', '2026-10-31'), 'week')
    assert.equal(bucketFor('2026-04-01', '2027-03-31'), 'month')
    assert.equal(isIsoDate('2026-02-29'), false)
    assert.equal(isIsoDate('2028-02-29'), true)
    assert.equal(isIsoDate('2026-1-5'), false)
    assert.equal(describePeriod({ from: '2026-10-01', to: '2026-10-11' }), '01 Oct 2026 – 11 Oct 2026')
  })

  it('converts a company calendar day to the instant it starts (IST is UTC+5:30)', () => {
    assert.equal(dayStartInstant('2026-10-01', 'Asia/Kolkata'), '2026-09-30T18:30:00.000Z')
    assert.equal(dayStartInstant('2026-10-01', 'UTC'), '2026-10-01T00:00:00.000Z')
  })
})

describe('analytics formatting', () => {
  it('never adds different units together and shows zero for an empty list', () => {
    assert.equal(unitList([{ unit: 'PCS', on_hand: 110 }, { unit: 'KG', on_hand: 175.5 }], 'on_hand'), '110 PCS · 175.5 KG')
    assert.equal(unitList([], 'on_hand'), '0')
    assert.equal(unitList([{ unit: 'PCS', quantity: 0 }], 'quantity'), '0')
  })

  it('distinguishes an undefined rate from 0%', () => {
    assert.equal(percentOf(3000, 3000 + 7620), 28.2)
    assert.equal(percentOf(0, 5), 0)
    assert.equal(percentOf(5, 0), null)
    assert.equal(pct(null), '—')
    assert.equal(pct(0), '0%')
  })

  it('sums money exactly in paise', () => {
    assert.equal(sumMoney([0.1, 0.2]), 0.3)
    assert.equal(sumMoney(['11800.00', '-1180.00', '-3000.00']), 7620)
  })

  it('exports carry the period, filters and generation time, and the same figures as the screen', () => {
    const meta = reportMetaRows({ title: 'Financial overview', company: 'Alton', generatedAt: '11 Oct 2026, 10:00', period: '01 Oct 2026 – 11 Oct 2026',
      asOf: '11 Oct 2026', filters: [{ label: 'Customer', value: 'Pune Traders' }], notes: ['Receipts are not bank-verified.'] })
    assert.deepEqual(meta[3], ['Reporting period', '01 Oct 2026 – 11 Oct 2026'])
    assert.ok(meta.some((r) => r[0] === 'Filters' && r[1] === 'Customer: Pune Traders'))
    const section = { name: 'Totals', headers: ['Metric', 'Value'], rows: [['Invoiced', 11800], ['Collected', 5000]] as (string | number)[][] }
    const xlsx = buildExportSheets(meta, [section], 'xlsx')
    assert.equal(xlsx.length, 2)
    assert.deepEqual(xlsx[1].rows, [['Metric', 'Value'], ['Invoiced', 11800], ['Collected', 5000]])
    const csv = buildExportSheets(meta, [section], 'csv')
    assert.equal(csv.length, 1)
    assert.deepEqual(csv[0].rows.slice(-3), [['Metric', 'Value'], ['Invoiced', 11800], ['Collected', 5000]])
    assert.ok(csv[0].rows.some((r) => r[0] === 'Generated at'))
  })
})

describe('executive alerts', () => {
  const a = (id: string, severity: ExecutiveAlert['severity'], detected: string, team = 'SALES', type = 'SO_SHORTAGE'): ExecutiveAlert => ({
    id, type, severity, team, title: id, reference: id, record_id: null, detected_at: detected, explanation: 'x', action: 'y', link: '/x',
  })

  it('sorts by severity, then oldest first', () => {
    const sorted = sortAlerts([a('3', 'LOW', '2026-10-01'), a('1', 'CRITICAL', '2026-10-05'), a('2', 'HIGH', '2026-09-01'), a('4', 'HIGH', '2026-08-01')])
    assert.deepEqual(sorted.map((x) => x.id), ['1', '4', '2', '3'])
  })

  it('filters by severity, type, team and date', () => {
    const list = [a('1', 'HIGH', '2026-10-05', 'SALES'), a('2', 'HIGH', '2026-09-01', 'ACCOUNTS', 'INVOICE_OVERDUE'), a('3', 'LOW', '2026-10-06')]
    assert.deepEqual(filterAlerts(list, { severity: 'HIGH', type: 'all', team: 'all', since: null, search: '' }).map((x) => x.id), ['1', '2'])
    assert.deepEqual(filterAlerts(list, { severity: 'all', type: 'INVOICE_OVERDUE', team: 'all', since: null, search: '' }).map((x) => x.id), ['2'])
    assert.deepEqual(filterAlerts(list, { severity: 'all', type: 'all', team: 'SALES', since: '2026-10-06', search: '' }).map((x) => x.id), ['3'])
  })

  it('never shows the same alert twice and reports refresh failures as alerts', () => {
    assert.equal(dedupeAlerts([a('1', 'HIGH', '2026-10-05'), a('1', 'HIGH', '2026-10-05'), a('2', 'LOW', '2026-10-05')]).length, 2)
    const failed = refreshFailedAlert('Billing', 'Network error', '2026-10-11T10:00:00Z')
    assert.equal(failed.id, 'REFRESH_FAILED:Billing')
    assert.equal(failed.detected_at, '2026-10-11')
  })
})
