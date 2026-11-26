// Alton Accounts foundation (migrations 20261231090000 / 20261231090100): frontend model helpers, the
// opening balance import parser, navigation and permission wiring, and a static check that every RPC the
// Accounts screens call exists, is granted to signed-in users only, and never to anon / service_role.
// The database behaviour itself is tested by tests/db/accounting-foundation-check.mjs.

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, it } from 'node:test'

import {
  OPENING_TEMPLATE, buildGroupTree, financialYear, formatAmount, formatBalance, isPositiveAmount, lineTotals, parseOpeningSheet, sourceLink, sumAmounts, toPaise,
  type Account, type AccountGroup,
} from '../../src/features/accounting/accounting-model.ts'
import { PERMISSIONS } from '../../src/auth/permissions.ts'
import { NAV_ITEMS, NAV_PERMISSIONS } from '../../src/config/navigation.ts'

const root = path.resolve(import.meta.dirname, '..', '..')

describe('amounts are handled in paise (no floating-point drift)', () => {
  it('sums and balances exactly', () => {
    assert.equal(sumAmounts(['0.10', '0.20', 0.3]), 0.6)
    assert.equal(toPaise('1000.50'), 100050)
    const t = lineTotals([{ debit: '0.10' }, { debit: '0.20' }, { credit: '0.30' }])
    assert.deepEqual(t, { debit: 0.3, credit: 0.3, difference: 0, balanced: true })
    assert.equal(lineTotals([{ debit: 100 }, { credit: 99.99 }]).balanced, false)
    assert.equal(lineTotals([{ debit: 100 }, { credit: 99.99 }]).difference, 0.01)
    assert.equal(lineTotals([]).balanced, false, 'an empty voucher is not balanced')
  })
  it('formats amounts and Dr / Cr balances', () => {
    assert.equal(formatAmount(123456.7), '1,23,456.70')
    assert.equal(formatAmount(0, true), '')
    assert.equal(formatBalance(-2500), '2,500.00 Cr')
    assert.equal(formatBalance('1000.5'), '1,000.50 Dr')
    assert.equal(formatBalance(0), '0.00')
  })
  it('accepts only positive amounts with at most 2 decimals', () => {
    for (const ok of ['1', '1.5', '1000.25']) assert.ok(isPositiveAmount(ok), ok)
    for (const bad of ['0', '0.00', '-1', '1.005', '1e3', 'abc', '']) assert.ok(!isPositiveAmount(bad), bad)
  })
})

describe('financial year', () => {
  it('April–March by default; any start month', () => {
    assert.deepEqual(financialYear('2026-11-25'), { from: '2026-04-01', to: '2027-03-31', label: '2026-27' })
    assert.deepEqual(financialYear('2027-02-28'), { from: '2026-04-01', to: '2027-03-31', label: '2026-27' })
    assert.deepEqual(financialYear('2027-04-01'), { from: '2027-04-01', to: '2028-03-31', label: '2027-28' })
    assert.deepEqual(financialYear('2026-05-10', 1), { from: '2026-01-01', to: '2026-12-31', label: '2026' })
    assert.deepEqual(financialYear('2026-05-10', 7), { from: '2025-07-01', to: '2026-06-30', label: '2025-26' })
  })
})

describe('chart of accounts tree', () => {
  const g = (id: string, parent: string | null, code: string, sort = 0): AccountGroup => ({
    id, parent_group_id: parent, group_code: code, group_name: code, classification: 'ASSET', normal_balance: 'DEBIT', is_system: true, is_active: true, sort_order: sort, description: null,
  })
  const a = (id: string, group: string, balance: string): Account => ({
    id, group_id: group, account_code: id, account_name: id, group_name: group, classification: 'ASSET', normal_balance: 'DEBIT', account_nature: 'GENERAL',
    is_postable: true, allow_manual_posting: true, requires_party: false, is_system: false, is_active: true, balance,
  })
  it('nests groups and rolls balances up exactly', () => {
    const tree = buildGroupTree([g('ca', 'as', 'AS.CA', 2), g('as', null, 'AS', 1), g('bank', 'ca', 'AS.CA.BANK', 3), g('fa', 'as', 'AS.FA', 1)],
      [a('1210', 'bank', '1000.10'), a('1220', 'bank', '0.20'), a('1100', 'ca', '-500.00')])
    assert.equal(tree.length, 1)
    assert.deepEqual(tree[0].children.map((c) => c.group.group_code), ['AS.FA', 'AS.CA'], 'sorted by sort order')
    const ca = tree[0].children[1]
    assert.equal(ca.children[0].balance, 1000.3)
    assert.equal(ca.balance, 500.3)
    assert.equal(tree[0].balance, 500.3)
    assert.equal(tree[0].accountCount, 3)
  })
  it('a corrupt cycle in the data cannot loop forever', () => {
    assert.doesNotThrow(() => buildGroupTree([g('x', 'y', 'X'), g('y', 'x', 'Y')], []))
  })
})

describe('opening balance import parser', () => {
  it('reads the template and flexible headers', () => {
    const r = parseOpeningSheet(OPENING_TEMPLATE)
    assert.deepEqual(r.errors, [])
    assert.equal(r.lines.length, 2)
    assert.deepEqual(r.lines[0], { account_code: '1210', party_code: null, balance_category: 'CASH_BANK', debit: '250000.00', credit: '', description: 'HDFC current account balance' })
    const r2 = parseOpeningSheet([['Opening balances as at 1 April'], [], ['Ledger code', 'Party', 'Dr', 'Cr'], ['1300', 'pty-000001', '1,500.50', ''], ['2100', 'PTY-000002', '', '900']])
    assert.deepEqual(r2.errors, [])
    assert.deepEqual(r2.lines.map((l) => [l.account_code, l.party_code, l.debit, l.credit]), [['1300', 'PTY-000001', '1500.50', ''], ['2100', 'PTY-000002', '', '900']])
  })
  it('reports row-numbered errors (spreadsheet row numbers) and skips blank rows', () => {
    const r = parseOpeningSheet([['Account code', 'Debit', 'Credit', 'Category'], ['1210', '10', '5', ''], ['', '1', '', ''], ['1300', '-4', '', ''],
      ['1400', '1.234', '', ''], ['3100', '', '', ''], ['', '', '', ''], ['1500', '7', '', 'Furniture']])
    assert.equal(r.lines.length, 0)
    assert.deepEqual(r.errors, [
      'Row 2: enter either a debit or a credit greater than zero.', 'Row 3: the account code is missing.',
      'Row 4: "-4" is not an amount (digits, at most 2 decimals, no minus sign).', 'Row 5: "1.234" is not an amount (digits, at most 2 decimals, no minus sign).',
      'Row 6: enter either a debit or a credit greater than zero.', 'Row 8: unknown category "Furniture" (use LEDGER, PARTY, CASH_BANK, CAPITAL, LOAN, FIXED_ASSET, INVENTORY, OTHER).'])
  })
  it('needs a header row with debit and credit columns', () => {
    assert.match(parseOpeningSheet([['a', 'b'], ['1', '2']]).errors[0], /Account code/)
    assert.match(parseOpeningSheet([['Account code', 'Amount'], ['1210', '5']]).errors[0], /Debit.*Credit/)
    assert.match(parseOpeningSheet([['Account code', 'Debit', 'Credit']]).errors[0], /no opening balance rows/)
  })
})

describe('source document links', () => {
  it('open the ERP document behind an automatic voucher', () => {
    assert.equal(sourceLink('SALES_INVOICE', 'i1'), '/billing/invoices/i1')
    assert.equal(sourceLink('CREDIT_NOTE', 'n1'), '/billing/notes/n1')
    assert.equal(sourceLink('GOODS_RECEIPT', 'g1'), '/goods-receipts/g1')
    assert.equal(sourceLink('SUPPLIER_PAYMENT', 's1'), null)
    assert.equal(sourceLink(null, 'x'), null)
  })
})

describe('Accounts navigation and permissions', () => {
  const ACCOUNTING_PERMISSIONS = ['accounts.read', 'accounts.manage', 'vouchers.read', 'vouchers.create', 'vouchers.post', 'vouchers.reverse', 'accounting_opening.import',
    'accounting_opening.approve', 'accounting_period.close', 'accounting_reports.read', 'accounting_settings.manage', 'accounting_posting.manage']
  it('the 12 permission codes match the migration', async () => {
    const sql = await readFile(path.join(root, 'supabase', 'migrations', '20261231090000_accounting_foundation.sql'), 'utf8')
    for (const code of ACCOUNTING_PERMISSIONS) {
      assert.ok((PERMISSIONS as readonly string[]).includes(code), `${code} missing in the frontend`)
      const [resource, action] = code.split('.')
      assert.match(sql, new RegExp(`\\('${resource}',\\s*'${action}',`), `${code} missing in the migration`)
    }
  })
  it('every Accounts page is under /accounts and needs an accounting permission', () => {
    const items = NAV_ITEMS.filter((i) => i.group === 'accounts')
    assert.equal(items.length, 25)
    for (const i of items) {
      assert.match(i.path, /^\/accounts(\/|$)/)
      assert.ok([...ACCOUNTING_PERMISSIONS, 'accounting_budgets.read', 'bank_accounts.read', 'cash_accounts.read', 'bank_reconciliation.read', 'gst_reconciliation.read', 'gst.read'].includes(NAV_PERMISSIONS[i.key] as string), `${i.key} → ${NAV_PERMISSIONS[i.key]}`)
    }
  })
})

describe('Accounts screens call only granted accounting RPCs', () => {
  it('each RPC used by the service exists, is granted to authenticated and never to anon or service_role, and no table is touched directly', async () => {
    const service = await readFile(path.join(root, 'src', 'services', 'accounting.ts'), 'utf8')
    const migrations = (await Promise.all(['20261231090000_accounting_foundation.sql', '20261231090100_accounting_auto_posting.sql', '20261231090200_accounting_cost_centres.sql',
      '20261231090300_accounting_purchase_invoices.sql', '20261231090400_accounting_bank_cash.sql', '20261231090500_accounting_gst.sql', '20261231090600_accounting_gst_2b.sql',
      '20261231090700_accounting_gst_returns.sql', '20261231090800_accounting_gst_close.sql']
      .map((f) => readFile(path.join(root, 'supabase', 'migrations', f), 'utf8')))).join('\n')
    // Names may contain digits (gst_2b_*) and result types may nest generics.
    const used = [...new Set([...service.matchAll(/\brpc<[\s\S]*?>\('([a-z0-9_]+)'/g), ...service.matchAll(/\brpc\('([a-z0-9_]+)'/g)].map((m) => m[1]))]
    assert.equal(used.length, 128, `found ${used.length} RPCs`)
    for (const fn of used) {
      assert.match(migrations, new RegExp(`create or replace function public\\.${fn}\\(`), `${fn} is not defined`)
      assert.match(migrations, new RegExp(`'public\\.${fn}\\(`), `${fn} is not in a grant list`)
    }
    assert.match(migrations, /revoke all on function %s from public, anon, service_role/)
    assert.doesNotMatch(service, /\.from\(/, 'accounting tables are never queried directly')
  })
})

// ---- Phase 1: manual journal voucher form ----------------------------------------------------------------------
import { emptyJournal, journalFromVoucher, journalPayload, validateJournal, type JournalForm, type Voucher } from '../../src/features/accounting/accounting-model.ts'

const jl = (key: string, account_id: string, debit = '', credit = '', narration = '') => ({ key, account_id, debit, credit, narration, allocations: [] as { key: string; cost_centre_id: string; amount: string }[] })
const jf = (lines: JournalForm['lines'], extra: Partial<JournalForm> = {}): JournalForm => ({ voucher_date: '2026-11-25', reference_number: '', narration: '', lines, ...extra })

describe('journal voucher form', () => {
  it('starts with today and two empty lines', () => {
    const f = emptyJournal('2026-11-25')
    assert.equal(f.voucher_date, '2026-11-25')
    assert.equal(f.lines.length, 2)
    assert.notEqual(f.lines[0].key, f.lines[1].key)
  })
  it('a draft may be unbalanced; posting needs two lines, both sides and debit = credit (paise-exact)', () => {
    const draft = jf([jl('a', 'acc1', '100.10'), jl('b', 'acc2', '', '100')])
    assert.deepEqual(validateJournal(draft, false), { lineErrors: {}, errors: [] })
    assert.match(validateJournal(draft, true).errors.join(' '), /Total debit \(100\.10\) does not equal total credit \(100\.00\)/)
    assert.deepEqual(validateJournal(jf([jl('a', 'acc1', '0.10'), jl('b', 'acc1', '0.20'), jl('c', 'acc2', '', '0.30')]), true).errors, [])
    assert.match(validateJournal(jf([jl('a', 'acc1', '5')]), true).errors.join(' '), /at least two lines/)
    assert.match(validateJournal(jf([jl('a', 'acc1', '5'), jl('b', 'acc2', '5')]), true).errors.join(' '), /one debit and one credit/)
  })
  it('flags bad lines: no account, both or neither side, zero, negative, 3 decimals; blank lines are ignored', () => {
    const r = validateJournal(jf([jl('a', '', '5'), jl('b', 'x', '5', '5'), jl('c', 'x'), jl('d', 'x', '0'), jl('e', 'x', '-1'), jl('f', 'x', '1.005'), jl('g', '')]), false)
    assert.deepEqual(Object.keys(r.lineErrors).sort(), ['a', 'b', 'c', 'd', 'e', 'f'])
    assert.match(r.lineErrors.a, /ledger account/)
    assert.match(r.lineErrors.b, /either a debit or a credit/)
    assert.match(r.lineErrors.f, /2 decimals/)
    assert.match(validateJournal(jf([], { voucher_date: '' }), false).errors[0], /voucher date/)
  })
  it('payload: JV type, trimmed text, blank lines dropped, amounts as strings and null for the empty side', () => {
    const p = journalPayload(jf([jl('a', 'acc1', ' 1500.50 ', '', '  rent  '), jl('b', ''), jl('c', 'acc2', '', '1500.50')], { reference_number: ' M-1 ', narration: '  ' }))
    assert.deepEqual(p, { voucher_type: 'JV', voucher_date: '2026-11-25', reference_number: 'M-1', narration: null, lines: [
      { account_id: 'acc1', debit: '1500.50', credit: null, narration: 'rent', allocations: [] }, { account_id: 'acc2', debit: null, credit: '1500.50', narration: null, allocations: [] }] })
  })
  it('a saved draft reopens with its lines and two-decimal amounts', () => {
    const v = { voucher_date: '2026-11-20', reference_number: null, narration: 'n', lines: [
      { id: 'l1', account_id: 'a1', debit: '250', credit: '0', narration: null }, { id: 'l2', account_id: 'a2', debit: 0, credit: '250.5', narration: 'x' }] } as unknown as Voucher
    assert.deepEqual(journalFromVoucher(v), { voucher_date: '2026-11-20', reference_number: '', narration: 'n', lines: [
      { key: 'l1', account_id: 'a1', debit: '250.00', credit: '', narration: '', allocations: [] }, { key: 'l2', account_id: 'a2', debit: '', credit: '250.50', narration: 'x', allocations: [] }] })
  })
})

// ---- Phase 2: cost centres, allocations and budgets ------------------------------------------------------------
import { allocationError, buildCostCentreTree, budgetTemplate, flattenCostCentreTree, fyMonthLabels, parseBudgetSheet, rollUp, splitByPercent, type CostCentre } from '../../src/features/accounting/accounting-model.ts'

const al = (cost_centre_id: string, amount: string) => ({ key: `${cost_centre_id}${amount}`, cost_centre_id, amount })

describe('cost-centre split of a journal line', () => {
  it('no split is fine (the account rule is checked by the database); an exact split is fine', () => {
    assert.equal(allocationError({ debit: '100', credit: '', allocations: [] }), null)
    assert.equal(allocationError({ debit: '100000', credit: '', allocations: [al('P', '60000'), al('A', '20000'), al('W', '20000.00')] }), null)
    assert.equal(allocationError({ debit: '', credit: '0.30', allocations: [al('P', '0.10'), al('A', '0.20')] }), null, 'credit lines, paise-exact')
  })
  it('flags a short or excess split, missing cost centres, zero or bad amounts and the same centre twice', () => {
    assert.match(allocationError({ debit: '100000', credit: '', allocations: [al('P', '60000'), al('A', '39999.99')] })!, /totals 99,999.99 but the line is 1,00,000.00/)
    assert.match(allocationError({ debit: '10', credit: '', allocations: [al('', '10')] })!, /select a cost centre/)
    assert.match(allocationError({ debit: '10', credit: '', allocations: [al('P', '0')] })!, /greater than zero/)
    assert.match(allocationError({ debit: '10', credit: '', allocations: [al('P', '5.555')] })!, /2 decimals/)
    assert.match(allocationError({ debit: '10', credit: '', allocations: [al('P', '5'), al('P', '5')] })!, /appears twice/)
  })
  it('percent splits are paise-exact; the last row takes the rounding', () => {
    assert.deepEqual(splitByPercent('100000', [60, 20, 20]), ['60000.00', '20000.00', '20000.00'])
    assert.deepEqual(splitByPercent('100', [33.33, 33.33, 33.34]), ['33.33', '33.33', '33.34'])
    assert.deepEqual(splitByPercent('0.10', [50, 50]), ['0.05', '0.05'])
  })
})

describe('cost centre hierarchy', () => {
  const c = (id: string, code: string, parent: string | null): CostCentre => ({ id, cost_centre_code: code, cost_centre_name: code, description: null, parent_cost_centre_id: parent, is_active: true, updated_at: '' })
  const list = [c('w', 'WH', 'a'), c('p', 'PROD', null), c('a', 'ADMIN', null), c('l1', 'PROD-1', 'p')]
  it('builds a sorted tree with depth', () => {
    const flat = flattenCostCentreTree(buildCostCentreTree(list))
    assert.deepEqual(flat.map((n) => `${n.depth}:${n.centre.cost_centre_code}`), ['0:ADMIN', '1:WH', '0:PROD', '1:PROD-1'])
  })
  it('rolls figures up to parents exactly; a corrupt cycle or missing parent cannot loop', () => {
    assert.deepEqual(rollUp(list, { w: '20000.10', a: '0.20', p: '1', l1: '2.5' }), { a: 20000.3, w: 20000.1, p: 3.5, l1: 2.5 })
    assert.doesNotThrow(() => buildCostCentreTree([c('x', 'X', 'y'), c('y', 'Y', 'x')]))
    assert.equal(flattenCostCentreTree(buildCostCentreTree([c('z', 'Z', 'missing')])).length, 1, 'an unknown parent is shown at the top level')
  })
})

describe('budget import parser', () => {
  it('reads the template (months in financial-year order) and month-name headers', () => {
    assert.deepEqual(fyMonthLabels(4).slice(0, 3), ['Apr', 'May', 'Jun'])
    const r = parseBudgetSheet(budgetTemplate(4), 4)
    assert.deepEqual(r.errors, [])
    assert.equal(r.lines.length, 2)
    assert.equal(r.lines[0].months.filter(Boolean).length, 12)
    assert.deepEqual(r.lines[1], { cost_centre_code: 'ADMIN', account_code: '6200', annual: '120000.00', months: Array(12).fill(null), notes: 'Rent, spread evenly' })
    const m = parseBudgetSheet([['Cost centre', 'Account', 'M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9', 'M10', 'M11', 'M12'], ['prod', '6500', '1,000', '', '', '', '', '', '', '', '', '', '', '2000']], 4)
    assert.deepEqual(m.errors, [])
    assert.deepEqual([m.lines[0].cost_centre_code, m.lines[0].annual, m.lines[0].months[0], m.lines[0].months[11]], ['PROD', null, '1000', '2000'])
  })
  it('row-numbered errors: months ≠ annual, missing codes, bad numbers, nothing entered', () => {
    const r = parseBudgetSheet([['Cost centre code', 'Account code', 'Annual', 'Apr', 'May'], ['PROD', '6500', '100', '60', '30'], ['', '6500', '10', '', ''], ['PROD', '6500', '-5', '', ''],
      ['PROD', '6510', '', '', '']], 4)
    assert.deepEqual(r.errors, ['Row 2: the months total 90.00 but the annual budget is 100.00.', 'Row 3: the cost centre code and account code are required.',
      'Row 4: "-5" is not an amount (digits, at most 2 decimals, no minus sign).', 'Row 5: enter the annual budget or the monthly budgets.'])
    assert.match(parseBudgetSheet([['Account code', 'Annual']], 4).errors[0], /Cost centre code/)
  })
})
