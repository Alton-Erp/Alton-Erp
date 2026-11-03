import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { parseAmazonReport, parseNumber, parseReportDate, type ParsedReport } from '../../src/features/amazon/report-import.ts'

const ok = (r: ReturnType<typeof parseAmazonReport>) => {
  if ('error' in r) throw new Error(r.error)
  return r as ParsedReport
}

describe('amazon report import', () => {
  it('parses numbers and dates in the formats Amazon exports use', () => {
    assert.equal(parseNumber('₹1,234.50'), 1234.5)
    assert.equal(parseNumber('INR 2,000'), 2000)
    assert.equal(parseNumber('12.5%'), 12.5)
    assert.equal(parseNumber('-'), null)
    assert.equal(parseNumber('abc'), null)
    assert.equal(parseReportDate('2026-10-03'), '2026-10-03')
    assert.equal(parseReportDate('03/10/2026'), '2026-10-03')
    assert.equal(parseReportDate('Oct 03, 2026'), '2026-10-03')
    assert.equal(parseReportDate('3 Oct 2026'), '2026-10-03')
    assert.equal(parseReportDate('31/02/2026'), null)
  })

  it('Business Report by child item: needs a chosen date; maps SKU, sessions, units, sales', () => {
    const rows = [['(Parent) ASIN', '(Child) ASIN', 'Title', 'SKU', 'Sessions - Total', 'Page Views - Total', 'Units Ordered', 'Ordered Product Sales', 'Total Order Items'],
      ['B0P', 'B0C0000001', 'Basin', 'BASIN-1', '1,200', '1,900', '30', '₹35,400.00', '29'],
      ['B0P', 'B0C0000002', 'Seat', '', '10', '12', '1', '₹999', '1']]
    assert.ok('error' in parseAmazonReport(rows))
    const r = ok(parseAmazonReport(rows, '2026-10-03'))
    assert.equal(r.type, 'BUSINESS_REPORT')
    assert.deepEqual(r.batches[0].rows[0], { seller_sku: 'BASIN-1', asin: 'B0C0000001', sessions: 1200, page_views: 1900, units_ordered: 30, ordered_sales: 35400, total_order_items: 29, metric_date: '2026-10-03' })
    assert.deepEqual(r.errors, [{ row: 3, message: 'seller_sku is empty' }])
  })

  it('search term report: daily rows, derived campaign/ad-group ids when the export has none, campaigns batch', () => {
    const rows = [['Date', 'Portfolio name', 'Currency', 'Campaign Name', 'Ad Group Name', 'Targeting', 'Match Type', 'Customer Search Term', 'Impressions', 'Clicks', 'Spend',
      '7 Day Total Sales', '7 Day Total Orders (#)', '7 Day Total Units (#)'],
      ['Oct 03, 2026', '', 'INR', 'SP Basins', 'AG 1', 'wash basin', 'EXACT', 'wash basin', '1000', '8', '96.40', '2,499', '1', '1'],
      ['Oct 03, 2026', '', 'INR', 'SP Basins', 'AG 1', 'wash basin', 'Exact', 'basin sink', '300', '3', '30', '0', '0', '0']]
    const r = ok(parseAmazonReport(rows))
    assert.equal(r.type, 'SP_SEARCH_TERM')
    assert.equal(r.batches[0].kind, 'CAMPAIGNS')
    assert.equal(r.batches[0].rows.length, 1)
    const t = r.batches[1].rows[0]
    assert.equal(t.campaign_id, 'CSV:sp basins')
    assert.equal(t.ad_group_id, 'CSV:ag 1')
    assert.equal(t.spend, 96.4)
    assert.equal(r.batches[1].rows[1].match_type, 'EXACT')
    assert.equal(r.dateFrom, '2026-10-03')
  })

  it('rejects non-daily advertising reports and rows with invalid numbers', () => {
    const rows = [['Start Date', 'End Date', 'Campaign Name', 'Impressions', 'Clicks', 'Spend', '7 Day Total Sales', '7 Day Total Orders (#)'],
      ['01/10/2026', '07/10/2026', 'SP A', '100', '5', '50', '0', '0'],
      ['08/10/2026', '08/10/2026', 'SP A', '1x0', '5', '50', '0', '0'],
      ['09/10/2026', '09/10/2026', 'SP A', '100', '5', '50', '0', '0']]
    const r = ok(parseAmazonReport(rows))
    assert.equal(r.type, 'SP_CAMPAIGN')
    assert.equal(r.batches[1].rows.length, 1)
    assert.equal(r.errors.length, 2)
    assert.match(r.errors[0].message, /not daily/)
    assert.match(r.errors[1].message, /not a number/)
  })

  it('FBA inventory report and unknown files', () => {
    const r = ok(parseAmazonReport([['sku', 'fnsku', 'asin', 'product-name', 'afn-fulfillable-quantity', 'afn-reserved-quantity'], ['BASIN-1', 'X0', 'B0C0000001', 'Basin', '42', '3']]))
    assert.equal(r.type, 'FBA_INVENTORY')
    assert.equal(r.batches[0].rows[0].fulfillable_qty, 42)
    assert.ok('error' in parseAmazonReport([['a', 'b'], ['1', '2']]))
  })
})
