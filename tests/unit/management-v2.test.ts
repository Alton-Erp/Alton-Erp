// Stage 7 (V2): report definitions and totals, unit formatting, date formats and
// the import date order. The figures themselves are checked end to end in
// supabase/tests/stage7_e2e_verification.sql.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { DATE_PATTERNS, formatDatePattern } from '../../src/lib/date-pattern.ts'
import { ACTIVITY_LABELS, CORRECTION_TYPES, REPORTS, cellValue, findReport, reportSheet, reportTotals, unitsText } from '../../src/features/management/report-defs.ts'
import { normalizeImportDate, setImportDateOrder } from '../../src/features/production/production-v2-model.ts'

describe('reporting centre definitions', () => {
  it('has the 20 required reports plus reorder planning, with unique keys, titles and columns', () => {
    assert.equal(REPORTS.length, 21)
    assert.equal(new Set(REPORTS.map((r) => r.key)).size, 21)
    assert.ok(findReport('reorder_planning'))
    for (const r of REPORTS) {
      assert.ok(r.columns.length > 0, r.key)
      assert.equal(new Set(r.columns.map((c) => c.key)).size, r.columns.length, `${r.key} duplicate column`)
    }
    for (const k of ['PRODUCTS', 'STOCK_REGISTER', 'STOCK_MOVEMENTS', 'INVENTORY_VALUATION', 'LOW_STOCK', 'PURCHASE_REGISTER', 'GRN_REGISTER', 'SUPPLIER_PURCHASES',
      'PRODUCTION_REGISTER', 'MATERIAL_CONSUMPTION', 'PRODUCTION_WASTAGE', 'SALES_ORDER_REGISTER', 'CUSTOMER_SALES', 'PRODUCT_SALES', 'DISPATCH', 'INVOICE_REGISTER',
      'GST_SUMMARY', 'CUSTOMER_OUTSTANDING', 'SUPPLIER_OUTSTANDING', 'PAYMENT_COLLECTION']) assert.ok(findReport(k.toLowerCase()), k)
  })
  it('filters match the report: dated reports have a date filter, party reports a party filter', () => {
    assert.ok(findReport('PAYMENT_COLLECTION')!.filters.includes('date') && findReport('PAYMENT_COLLECTION')!.filters.includes('customer'))
    assert.ok(findReport('SUPPLIER_OUTSTANDING')!.filters.includes('supplier'))
    assert.ok(!findReport('STOCK_REGISTER')!.filters.includes('date'))
  })
  it('row links open the record', () => {
    assert.equal(findReport('INVOICE_REGISTER')!.link!({ id: 'i1' }), '/billing/invoices/i1')
    assert.equal(findReport('CUSTOMER_OUTSTANDING')!.link!({ party_id: 'p1' }), '/ledger/p1')
    assert.equal(findReport('INVOICE_REGISTER')!.link!({}), null)
  })
  it('totals leave out reversed receipts and cancelled invoices', () => {
    const def = findReport('PAYMENT_COLLECTION')!
    const rows = [{ amount: 5000, allocated: 5000, status: 'RECORDED' }, { amount: 9160, allocated: 9160, status: 'RECORDED' }, { amount: 100, allocated: 0, status: 'REVERSED' }]
    assert.deepEqual(reportTotals(def, rows), { amount: 14160, allocated: 14160 })
  })
  it('Excel sheet: header, values as numbers, a total row', () => {
    const def = findReport('PAYMENT_COLLECTION')!
    const sheet = reportSheet(def, [{ receipt_number: 'RCT-1', date: '2026-10-31', amount: '5000.00', allocated: 5000, status: 'RECORDED' }])
    assert.equal(sheet[0][0], 'Receipt')
    assert.equal(sheet[1][def.columns.findIndex((c) => c.key === 'amount')], 5000)
    assert.equal(sheet.at(-1)![0], 'Total')
    assert.equal(cellValue({ key: 'x', label: 'x', type: 'bool' }, true), 'Yes')
    assert.equal(cellValue({ key: 'x', label: 'x' }, null), '')
  })
})

describe('units are never added together', () => {
  it('lists each unit separately and drops zeros', () => {
    assert.equal(unitsText([{ unit: 'PCS', quantity: 8 }, { unit: 'KG', quantity: '50.000' }, { unit: 'LTR', quantity: 0 }]), '8 PCS · 50 KG')
    assert.equal(unitsText([], '—'), '—')
    assert.equal(unitsText([{ unit: 'KG', quantity: 17.5 }]), '17.5 KG')
  })
})

describe('activity centre', () => {
  it('labels every activity the database returns, incl. corrections', () => {
    for (const t of ['PRODUCT_CREATED', 'PRODUCT_UPDATED', 'BOM_UPDATED', 'SUPPLIER_ADDED', 'CUSTOMER_ADDED', 'PURCHASE_ORDER_CREATED', 'GOODS_RECEIVED', 'PRODUCTION_STARTED',
      'PRODUCTION_COMPLETED', 'SALES_ORDER_CREATED', 'STOCK_RESERVED', 'STOCK_DISPATCHED', 'INVOICE_CREATED', 'PAYMENT_RECEIVED', 'STOCK_ADJUSTED']) assert.ok(ACTIVITY_LABELS[t], t)
    for (const t of CORRECTION_TYPES) assert.ok(ACTIVITY_LABELS[t], t)
  })
})

describe('company date format', () => {
  const d = new Date(2026, 9, 31)
  it('formats every supported pattern', () => {
    assert.equal(formatDatePattern(d, 'DD-MM-YYYY'), '31-10-2026')
    assert.equal(formatDatePattern(d, 'DD/MM/YYYY'), '31/10/2026')
    assert.equal(formatDatePattern(d, 'YYYY-MM-DD'), '2026-10-31')
    assert.equal(formatDatePattern(d, 'DD MMM YYYY'), '31 Oct 2026')
    assert.equal(DATE_PATTERNS.length, 4)
  })
})

describe('import date order (ERP Settings → Excel import)', () => {
  it('reads 03/04/2026 as 3 April by default and as 4 March when set to month-day-year', () => {
    setImportDateOrder('DMY')
    assert.equal(normalizeImportDate('03/04/2026'), '2026-04-03')
    setImportDateOrder('MDY')
    assert.equal(normalizeImportDate('03/04/2026'), '2026-03-04')
    assert.equal(normalizeImportDate('13/04/2026'), '13/04/2026', 'impossible month is left for the validator to report')
    assert.equal(normalizeImportDate('2026-04-03'), '2026-04-03')
    setImportDateOrder('DMY')
  })
})
