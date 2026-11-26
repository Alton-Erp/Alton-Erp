// Alton Accounts Phase 4 (migration 20261231090400): bank & cash model — statement date / amount parsing, column mapping,
// row normalisation, account-number masking, master form validation, matching totals and navigation / permission wiring.
// The database behaviour (balances, transfers, imports, matching, reconciliation, concurrency) is tested by tests/db/accounting-foundation-check.mjs.

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, it } from 'node:test'

import { PERMISSIONS } from '../../src/auth/permissions.ts'
import { NAV_ITEMS, NAV_PERMISSIONS } from '../../src/config/navigation.ts'
import {
  emptyMoneyAccount, guessMapping, mapStatementRows, mappingErrors, maskAccountNumber, moneyAccountErrors, moneyAccountPayload, parseStatementAmount, parseStatementDate,
  parseCsv, selectionTotals, toBase64,
} from '../../src/features/accounting/bank-cash-model.ts'

const root = path.resolve(import.meta.dirname, '..', '..')

describe('statement dates and amounts', () => {
  it('reads ISO, Indian dd/mm/yyyy, dd-Mon-yy, month-first on request and Excel serials; rejects impossible dates', () => {
    assert.equal(parseStatementDate('2026-11-05'), '2026-11-05')
    assert.equal(parseStatementDate('05/11/2026'), '2026-11-05')
    assert.equal(parseStatementDate('05-11-26'), '2026-11-05')
    assert.equal(parseStatementDate('5-Nov-2026'), '2026-11-05')
    assert.equal(parseStatementDate('05 Nov 26'), '2026-11-05')
    assert.equal(parseStatementDate('11/05/2026', 'MDY'), '2026-11-05')
    assert.equal(parseStatementDate('46331'), '2026-11-05')
    assert.equal(parseStatementDate('31/02/2026'), null)
    assert.equal(parseStatementDate('yesterday'), null)
    assert.equal(parseStatementDate(''), null)
  })
  it('reads Indian grouping, rupee signs, brackets and Dr / Cr suffixes; blank stays blank; text is unreadable', () => {
    assert.equal(parseStatementAmount('1,23,456.7'), '123456.70')
    assert.equal(parseStatementAmount('₹ 59.00'), '59.00')
    assert.equal(parseStatementAmount('(59.00)'), '-59.00')
    assert.equal(parseStatementAmount('1,025.00 Dr'), '-1025.00')
    assert.equal(parseStatementAmount('120.00Cr'), '120.00')
    assert.equal(parseStatementAmount('-5'), '-5.00')
    assert.equal(parseStatementAmount(''), '')
    assert.equal(parseStatementAmount('-'), '')
    assert.equal(parseStatementAmount('abc'), null)
  })
})

describe('statement column mapping', () => {
  const sheet = [['HDFC BANK LTD', '', ''], ['Account 50100012345678', '', ''], [],
    ['Date', 'Narration', 'Chq./Ref.No.', 'Value Dt', 'Withdrawal Amt.', 'Deposit Amt.', 'Closing Balance'],
    ['05/11/26', 'NEFT IN OPENING FUNDS', 'UTR1', '05/11/26', '', '2,00,000.00', '2,00,000.00'],
    ['06/11/26', 'SMS CHARGES QTR', '', '06/11/26', '59.00', '', '1,99,941.00'],
    ['', '', '', '', '', '', ''], ['** End of statement **', '', '', '', '', '', '']]
  it('finds the header row below the bank banner and guesses every column', () => {
    const g = guessMapping(sheet)
    assert.equal(g.headerRow, 3)
    assert.deepEqual(g.mapping, { txn_date: 0, value_date: 3, description: 1, reference: 2, debit: 4, credit: 5, running_balance: 6 })
    assert.deepEqual(mappingErrors(g.mapping), [])
  })
  it('normalises rows with spreadsheet row numbers; blank and footer lines are skipped', () => {
    const g = guessMapping(sheet)
    const rows = mapStatementRows(sheet, g.headerRow, g.mapping, 'DMY')
    assert.equal(rows.length, 2)
    assert.deepEqual(rows[0], { row_no: 5, txn_date: '2026-11-05', value_date: '2026-11-05', description: 'NEFT IN OPENING FUNDS', reference: 'UTR1', bank_txn_id: '',
      debit: '', credit: '200000.00', running_balance: '200000.00' })
    assert.equal(rows[1].debit, '59.00')
  })
  it('a single signed amount column becomes debit / credit; unreadable values are passed on for the database to report', () => {
    const s = [['Date', 'Description', 'Amount'], ['2026-11-05', 'Fee', '-59'], ['2026-11-06', 'Interest', '120'], ['2026-11-07', 'Bad', 'x']]
    const rows = mapStatementRows(s, 0, { txn_date: 0, description: 1, amount: 2 }, 'YMD')
    assert.deepEqual(rows.map((r) => [r.debit, r.credit]), [['59.00', ''], ['', '120.00'], ['x', '']])
  })
  it('mapping errors: date required, debit + credit or one amount column, not both, no column twice', () => {
    assert.match(mappingErrors({ debit: 1, credit: 2 }).join(' '), /transaction date/)
    assert.match(mappingErrors({ txn_date: 0, debit: 1 }).join(' '), /both debit and credit/)
    assert.match(mappingErrors({ txn_date: 0, debit: 1, credit: 2, amount: 3 }).join(' '), /not both/)
    assert.match(mappingErrors({ txn_date: 0, debit: 1, credit: 1 }).join(' '), /mapped to two fields/)
  })
  it('CSV text is read verbatim (quotes, embedded commas, CRLF, BOM) so 05/11/26 stays day-first', () => {
    const rows = parseCsv('﻿Date,Narration,Amount\r\n05/11/26,"NEFT, SBI ""X""","1,025.00"\r\n')
    assert.deepEqual(rows, [['Date', 'Narration', 'Amount'], ['05/11/26', 'NEFT, SBI "X"', '1,025.00']])
    assert.equal(parseStatementDate(rows[1][0]), '2026-11-05')
  })
  it('base64 of the original file', () => {
    assert.equal(toBase64(new TextEncoder().encode('date,amount\n').buffer as ArrayBuffer), 'ZGF0ZSxhbW91bnQK')
  })
})

describe('bank / cash account form', () => {
  it('masks all but the last four characters (spaces and hyphens ignored)', () => {
    assert.equal(maskAccountNumber('5010 0012-345678'), 'XXXXXXXXXX5678')
    assert.equal(maskAccountNumber('1234'), '1234')
  })
  it('validates code, ledger, IFSC, number and opening balance; the number is optional when editing', () => {
    const f = { ...emptyMoneyAccount('BANK'), account_code: 'hdfc-ca', account_name: 'HDFC', ledger_account_id: 'l1', bank_name: 'HDFC Bank', account_holder_name: 'Alton', ifsc: 'hdfc0001234',
      account_number: '50100012345678' }
    assert.deepEqual(moneyAccountErrors(f, true), [])
    assert.match(moneyAccountErrors({ ...f, ifsc: 'HDFC1234567' }, true).join(' '), /IFSC/)
    assert.match(moneyAccountErrors({ ...f, account_number: '' }, true).join(' '), /account number/)
    assert.deepEqual(moneyAccountErrors({ ...f, account_number: '' }, false), [])
    assert.match(moneyAccountErrors({ ...f, account_number: '12' }, true).join(' '), /6 to 34/)
    assert.match(moneyAccountErrors({ ...f, opening_balance: '-5' }, true).join(' '), /Opening balance/)
    assert.deepEqual(moneyAccountErrors({ ...emptyMoneyAccount('CASH'), account_code: 'PETTY', account_name: 'Petty', ledger_account_id: 'l2' }, true), [])
  })
  it('payload: upper-cased code / IFSC, normalised number only when entered, no bank fields for cash', () => {
    const p = moneyAccountPayload({ ...emptyMoneyAccount('BANK'), account_code: 'hdfc', account_name: ' HDFC ', ledger_account_id: 'l1', bank_name: 'HDFC', account_holder_name: 'A',
      ifsc: 'hdfc0001234', account_number: '5010 0012' })
    assert.equal(p.account_code, 'HDFC')
    assert.equal(p.ifsc, 'HDFC0001234')
    assert.equal(p.account_number, '50100012')
    assert.equal(p.opening_balance_type, null)
    assert.equal('account_number' in moneyAccountPayload({ ...emptyMoneyAccount('BANK'), account_number: '' }), false)
    assert.equal('ifsc' in moneyAccountPayload({ ...emptyMoneyAccount('CASH'), account_code: 'PC' }), false)
  })
})

describe('matching selection', () => {
  it('valid only with both sides selected and equal to the paisa', () => {
    assert.deepEqual(selectionTotals([{ remaining: '-1025.00' }], [{ remaining: '-1000' }, { remaining: '-25.00' }]), { statement: -102500, ledger: -102500, difference: 0, valid: true })
    assert.equal(selectionTotals([{ remaining: '-1025.00' }], [{ remaining: '-1000' }]).valid, false)
    assert.equal(selectionTotals([], [{ remaining: '10' }]).valid, false)
  })
})

describe('bank & cash wiring', () => {
  it('the nine permission codes match the migration; screens are under /accounts with a bank / cash permission', async () => {
    const sql = await readFile(path.join(root, 'supabase', 'migrations', '20261231090400_accounting_bank_cash.sql'), 'utf8')
    for (const code of ['bank_accounts.read', 'bank_accounts.manage', 'cash_accounts.read', 'cash_accounts.manage', 'bank_reconciliation.read', 'bank_reconciliation.manage',
      'bank_reconciliation.approve', 'bank_transfers.create', 'bank_transfers.post']) {
      assert.ok((PERMISSIONS as readonly string[]).includes(code), code)
      const [resource, action] = code.split('.')
      assert.match(sql, new RegExp(`\\('${resource}',\\s*'${action}',`))
    }
    const paths = ['/accounts/bank-accounts', '/accounts/cash-accounts', '/accounts/bank-book', '/accounts/cash-book', '/accounts/transfers', '/accounts/payment-accounts',
      '/accounts/bank-reconciliation', '/accounts/bank-reconciliation/reports']
    for (const p of paths) {
      const item = NAV_ITEMS.find((i) => i.path === p)
      assert.ok(item, p)
      assert.ok(['bank_accounts.read', 'cash_accounts.read', 'bank_reconciliation.read'].includes(NAV_PERMISSIONS[item!.key] as string), p)
    }
    const routes = await readFile(path.join(root, 'src', 'routes.ts'), 'utf8')
    assert.ok(routes.includes("{ path: '/accounts/bank-reconciliation/import', permission: 'bank_reconciliation.manage'"))
  })
  it('the full account number never leaves the database except through the audited reveal RPC', async () => {
    const service = await readFile(path.join(root, 'src', 'services', 'accounting.ts'), 'utf8')
    assert.doesNotMatch(service, /bank_account_numbers/)
    assert.match(service, /rpc<string>\('bank_account_reveal_number'/)
  })
})
