import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, it } from 'node:test'

import { NAV_GROUPS, NAV_ITEMS, NAV_PERMISSIONS } from '../../src/config/navigation.ts'
import { resolveNotificationLink } from '../../src/features/admin/notification-links.ts'
import {
  bucketLabel, bucketSeries, bucketStart, bucketStarts, chartBucket, mainUnit, sourceText, stockBySource,
} from '../../src/features/management/dashboard-model.ts'

const root = path.resolve(import.meta.dirname, '..', '..')

describe('V2 navigation scope', () => {
  it('has exactly the nine approved sections, in order', () => {
    assert.deepEqual(NAV_GROUPS.map((g) => g.label), [
      'Management Dashboard', 'Product Master & BOM', 'Inventory Management', 'Purchase & GRN',
      'Production & Outsourcing', 'Sales & Orders', 'Billing & Invoicing', 'Ledger', 'Reports & Settings',
    ])
    for (const g of NAV_GROUPS) assert.ok(NAV_ITEMS.some((i) => i.group === g.id), `${g.label} has no page`)
  })

  it('each section has exactly the approved entries (sidebar refinement)', () => {
    const titles = (group: string) => NAV_ITEMS.filter((i) => i.group === group).map((i) => i.title)
    // Stock Adjustments was restored at the owner's request (migration 20261201090000).
    assert.deepEqual(titles('inventory'), ['Inventory Overview', 'Stock Register', 'Stock Movements', 'Stock Reservations', 'Warehouses & Locations', 'Low Stock Alerts', 'Stock Adjustments'])
    assert.deepEqual(titles('production'), ['Production Dashboard', 'Production Orders', 'Production Planning', 'Material Consumption', 'Finished Goods Receipts', 'Production Reports'])
    assert.deepEqual(titles('sales'), ['Sales Dashboard', 'Sales Orders', 'Partial Fulfilment', 'Order Cancellation'])
    assert.deepEqual(titles('billing'), ['Invoice Dashboard', 'Sales Invoices', 'Create Invoice', 'Invoice Register', 'Customer Payments', 'Payment Allocation',
      'Outstanding Receivables', 'Receivables Ageing', 'Credit Notes', 'Debit Notes', 'Customer Statements', 'GST Summary', 'Billing Reports', 'Invoice Settings'])
    assert.deepEqual(titles('ledger'), ['Ledger Dashboard', 'Customer & Supplier Ledger', 'Customer Ledger', 'Supplier Ledger'])
    const removed = /^\/(inventory\/(counts|batches|reports)|production\/(outsourcing|outsourced-receipts)|sales\/(picking|packing|dispatch|delivery|returns|reports|order-details))$/
    for (const item of NAV_ITEMS) assert.doesNotMatch(item.path, removed, `${item.key} was removed from the sidebar`)
  })

  it('contains no legacy modules (analytics, Amazon, customer POs, marketplace, activity, reconciliation, approvals, …)', () => {
    const legacy = /^\/(analytics|amazon|customer-pos|marketplace|activity|reconciliation|notifications|scan|customers|suppliers|settings)(\/|$)|^\/admin\/(approvals|barcodes|documents|user-activity|system-health)|^\/(sales|billing)$|^\/dashboard\//
    for (const item of NAV_ITEMS) assert.doesNotMatch(item.path, legacy, `${item.key} (${item.path}) is a legacy page`)
    assert.ok(NAV_ITEMS.every((i) => !('notImplemented' in i)), 'no "Not built" entries')
  })

  it('every entry has a permission rule and a routed page component', async () => {
    const routes = await readFile(path.join(root, 'src', 'routes.ts'), 'utf8')
    for (const item of NAV_ITEMS) {
      assert.ok(item.key in NAV_PERMISSIONS, `${item.key} has no permission rule`)
      assert.match(routes, new RegExp(`^\\s*'?${item.key}'?: lazy\\(`, 'm'), `${item.key} has no page`)
    }
    assert.equal(Object.keys(NAV_PERMISSIONS).length, NAV_ITEMS.length)
  })

  it('old addresses of merged pages redirect to their V2 page', async () => {
    const routes = await readFile(path.join(root, 'src', 'routes.ts'), 'utf8')
    for (const [from, to] of [['/settings', '/admin/erp-settings?tab=company'], ['/sales', '/sales/dashboard'], ['/billing', '/billing/dashboard'], ['/customers', '/ledger/customers'], ['/suppliers', '/ledger/suppliers']]) {
      assert.ok(routes.includes(`{ from: '${from}', to: '${to}' }`), `${from} → ${to}`)
    }
    assert.doesNotMatch(routes, /pages\/(amazon|analytics|customer-po)\/|activity-centre-page|reconciliation-page|marketplace-orders-page|approvals-page/)
    // Removed in the sidebar refinement: no route opens these pages any more.
    assert.doesNotMatch(routes, /stock-counts-page|count-sheet-page|batch-tracking-page|inventory-reports-page|outsourcing-orders-page|outsourced-receipts-page|outsourcing-order-detail-page|picking-page|packing-page|dispatch-page|delivery-page|returns-page|fulfilment-reports-page|order-details-page/)
  })

  it('the dashboard has no quick-action panel', async () => {
    const page = await readFile(path.join(root, 'src', 'pages', 'management-overview-page.tsx'), 'utf8')
    assert.doesNotMatch(page, /QUICK_ACTIONS|Quick actions/)
    for (const label of ['Total stock', 'Manufactured stock', 'Outsourced stock', 'Purchase orders', 'Pending GRNs', 'Production orders', 'Sales orders', 'Invoiced sales', 'Outstanding payments']) {
      assert.ok(page.includes(`label="${label}"`), `metric ${label}`)
    }
  })
})

describe('Notification links from the database', () => {
  it('links to removed modules open nothing; merged pages go to their V2 page; V2 links are unchanged', () => {
    // Every link pattern the database writes into notifications (approvals, imports, alerts, Amazon, system health).
    const cases: [string | null, string | null][] = [
      ['/admin/approvals?request=1', null], ['/admin/system-health', null], ['/amazon/recommendations?tab=changes', null],
      ['/customer-pos/fulfilment?po=1', null], ['/customer-pos/matching?po=1', null], ['/customer-pos/register', null],
      ['/customers', '/ledger/customers'], ['/suppliers/abc', '/ledger/suppliers'], ['/analytics/alerts', '/'],
      ['/admin/bulk-operations?job=1', '/admin/bulk-operations?job=1'], ['/billing/invoices/1', '/billing/invoices/1'], ['/billing/notes/1', '/billing/notes/1'],
      ['/billing/payments?receipt=1', '/billing/payments?receipt=1'], ['/inventory/adjustments', '/inventory/adjustments'], ['/inventory/adjustments?adjustment=a1', '/inventory/adjustments?adj=a1'], ['/inventory/counts/1', null],
      ['/inventory/opening-stock', '/inventory/opening-stock'], ['/inventory/stock/1', '/inventory/stock/1'], ['/production/boms/1', '/production/boms/1'],
      ['/production/orders/1', '/production/orders/1'], ['/production/outsourcing/1', null], ['/products', '/products'],
      ['/sales/order-details?so=1a2b', '/sales/orders/1a2b'], ['/sales/delivery?f=1', null], ['/sales/dispatch?f=1', null], ['/sales/returns?r=1', null],
      [null, null], ['', null], ['https://example.com', null], ['//evil.example', null],
    ]
    for (const [link, expected] of cases) assert.equal(resolveNotificationLink(link), expected, String(link))
  })
})

describe('Dashboard charts: buckets for the selected period', () => {
  it('chooses days up to a month, weeks up to four months and months beyond', () => {
    assert.equal(chartBucket('2026-10-31', '2026-10-31'), 'day')
    assert.equal(chartBucket('2026-10-01', '2026-10-31'), 'day')
    assert.equal(chartBucket('2026-08-01', '2026-10-31'), 'week')
    assert.equal(chartBucket('2026-01-01', '2026-10-31'), 'month')
  })

  it('weeks start on Monday and months on the 1st', () => {
    assert.equal(bucketStart('2026-10-31', 'week'), '2026-10-26') // Saturday → Monday
    assert.equal(bucketStart('2026-10-26', 'week'), '2026-10-26')
    assert.equal(bucketStart('2026-11-01', 'week'), '2026-10-26') // Sunday
    assert.equal(bucketStart('2026-10-17', 'month'), '2026-10-01')
    assert.deepEqual(bucketStarts('2026-10-30', '2026-11-02', 'day'), ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02'])
    assert.deepEqual(bucketStarts('2026-01-15', '2026-03-02', 'month'), ['2026-01-01', '2026-02-01', '2026-03-01'])
    assert.equal(bucketLabel('2026-10-26', 'week'), 'w/c 26 Oct')
  })

  it('sums daily rows into a continuous series and ignores rows outside the period', () => {
    const rows = [
      { day: '2026-10-01', value: 100, orders: 1 },
      { day: '2026-10-01', value: '50.5', orders: 1 },
      { day: '2026-10-03', value: 20, orders: 1 },
      { day: '2026-09-30', value: 999, orders: 9 },
    ]
    const s = bucketSeries(rows, ['value', 'orders'] as const, '2026-10-01', '2026-10-03')
    assert.deepEqual(s.map((p) => [p.start, p.value, p.orders]), [['2026-10-01', 150.5, 2], ['2026-10-02', 0, 0], ['2026-10-03', 20, 1]])
    const m = bucketSeries(rows, ['value'] as const, '2026-01-01', '2026-10-31')
    assert.equal(m.length, 10)
    assert.equal(m.at(-1)?.value, 170.5)
    assert.equal(m.at(-2)?.value, 999)
  })
})

describe('Dashboard: manufactured and outsourced stock', () => {
  const units = [
    { unit: 'KG', on_hand: 40, in_house: 0, outsourced: 0, unknown: 40 },
    { unit: 'PCS', on_hand: '1250', in_house: '1000', outsourced: '250', unknown: '0' },
    { unit: 'LTR', on_hand: 0, in_house: 0, outsourced: 0, unknown: 0 },
  ]

  it('keeps units apart, PCS first, and drops units with no stock', () => {
    const split = stockBySource(units)
    assert.deepEqual(split.map((r) => r.unit), ['PCS', 'KG'])
    assert.deepEqual(split[0], { unit: 'PCS', total: 1250, manufactured: 1000, outsourced: 250, unknown: 0 })
    assert.equal(sourceText(split, 'total'), '1,250 PCS · 40 KG')
    assert.equal(sourceText(split, 'manufactured'), '1,000 PCS')
    assert.equal(sourceText(split, 'outsourced'), '250 PCS')
    assert.equal(sourceText(split, 'unknown'), '40 KG')
    assert.equal(sourceText([], 'total'), '0')
    assert.deepEqual(stockBySource(null), [])
  })

  it('charts use the unit with the most quantity, never a mix', () => {
    assert.equal(mainUnit([{ unit: 'KG', quantity: 5 }, { unit: 'PCS', quantity: 3 }, { unit: 'PCS', quantity: 4 }]), 'PCS')
    assert.equal(mainUnit([{ unit: 'KG', quantity: 9 }, { unit: 'PCS', quantity: 3 }]), 'KG')
    assert.equal(mainUnit([]), null)
  })
})
