// Bank & cash management — Alton Accounts Phase 4 (migration 20261231090400).
// Types, statement column mapping / parsing (CSV or Excel rows → normalised statement rows for bank_statement_import),
// form validation and labels. The database validates everything again and is authoritative for every balance.

import { toPaise, type Amount, type Tone } from './accounting-model.ts'

export type MoneyKind = 'BANK' | 'CASH'
export type BankAccountType = 'CURRENT' | 'SAVINGS' | 'CASH_CREDIT' | 'OVERDRAFT' | 'OTHER'
export type MatchState = 'UNMATCHED' | 'PARTIALLY_MATCHED' | 'MATCHED'
export type TransferStatus = 'DRAFT' | 'POSTED' | 'REVERSED' | 'CANCELLED'
export type PaymentAccountState = 'POSTED' | 'REVERSED' | 'ASSIGNED' | 'NEEDS_SELECTION' | 'UNMAPPED' | 'BY_METHOD'
export type BankReportKey = 'ACCOUNT_SUMMARY' | 'OUTSTANDING_CHEQUES' | 'DEPOSITS_IN_TRANSIT' | 'OUTSTANDING_ITEMS' | 'UNMATCHED_STATEMENT' | 'BANK_CHARGES'
  | 'TRANSFER_REGISTER' | 'CASH_POSITION'

export interface MoneyAccount {
  id: string; account_kind: MoneyKind; account_code: string; account_name: string; ledger_account_id: string; ledger_code: string; ledger_name: string
  bank_name: string | null; branch_name: string | null; account_holder_name: string | null; account_number_masked: string | null; ifsc: string | null
  bank_account_type: BankAccountType | null; currency: string; opening_balance: Amount | null; opening_balance_type: 'DEBIT' | 'CREDIT' | null; opening_balance_date: string | null
  opening_balance_reference: string | null; custodian_user_id: string | null; custodian_name: string | null; allow_negative_balance: boolean; is_active: boolean
  notes: string | null; row_version: number; ledger_balance: Amount; last_statement_date: string | null; unmatched_statement_lines: number
}
export interface BankLookups {
  initialized: boolean; today: string
  accounts: Pick<MoneyAccount, 'id' | 'account_kind' | 'account_code' | 'account_name' | 'bank_name' | 'account_number_masked' | 'ledger_account_id' | 'is_active' | 'allow_negative_balance'>[]
  ledgers: { id: string; account_code: string; account_name: string; account_nature: MoneyKind; linked: boolean }[]
  expense_ledgers: { id: string; account_code: string; account_name: string; cost_centre_policy: string }[]
  users: { id: string; full_name: string }[]
}
export interface BookRow {
  line_id: string; voucher_id: string; voucher_number: string; date: string; txn_type: string; is_reversal: boolean; counterparty: string | null; party_id: string | null
  narration: string | null; debit: Amount; credit: Amount; balance: Amount; reference: string | null; payment_method: string | null; matched: Amount; reconciliation: MatchState
}
export interface Book {
  account: MoneyAccount; from: string; to: string; opening_balance: Amount; closing_balance: Amount; total_debit: Amount; total_credit: Amount; rows: BookRow[]
  daily: { date: string; opening: Amount; receipts: Amount; payments: Amount; closing: Amount }[]
}
export interface Transfer {
  id: string; transfer_number: string; transfer_date: string; from_account_id: string; to_account_id: string; amount: Amount; charges: Amount; charges_account_id: string | null
  reference: string | null; narration: string | null; status: TransferStatus; voucher_id: string | null; voucher_number: string | null; reversal_voucher_number: string | null
  reversal_reason: string | null; cancel_reason: string | null; row_version: number; from_account_code: string; from_account_name: string; from_kind: MoneyKind
  to_account_code: string; to_account_name: string; to_kind: MoneyKind; charges_account_code: string | null; charges_account_name: string | null; created_by_name: string | null
  posted_at: string | null
}
export interface PaymentPolicy {
  direction: 'RECEIPT' | 'PAYMENT'; payment_method: string; require_selection: boolean; rule_account_id: string | null; rule_account_code: string | null
  rule_account_name: string | null; mapped_account_id: string | null; mapped_account_code: string | null; mapped_account_name: string | null
}
export interface PaymentCandidate {
  source_type: 'CUSTOMER_RECEIPT' | 'SUPPLIER_PAYMENT'; source_id: string; number: string; date: string; party: string | null; payment_method: string; amount: Amount
  reference: string | null; payment_status: string; event_status: string | null; event_message: string | null; voucher_number: string | null
  posted_account_code: string | null; posted_ledger_code: string | null; assigned_account_id: string | null; assigned_account_code: string | null; assignment_reason: string | null
  require_selection: boolean; state: PaymentAccountState
}
export interface ImportReportRow { row_no: number; status: 'IMPORTED' | 'DUPLICATE' | 'FAILED'; message: string | null }
export interface ImportResult {
  id?: string; preview: boolean; file_name: string; previously_imported_at: string | null; row_count: number; importable_count?: number; imported_count?: number
  duplicate_count: number; failed_count: number; report: ImportReportRow[]
}
export interface StatementImport {
  id: string; bank_cash_account_id: string; account_code: string; account_name: string; file_name: string; file_size: number; row_count: number; imported_count: number
  duplicate_count: number; failed_count: number; statement_from: string | null; statement_to: string | null; imported_at: string; imported_by_name: string | null
}
export interface LedgerItem {
  line_id: string; voucher_id: string; voucher_number: string; date: string; voucher_type: string; source_type: string | null; is_reversal: boolean
  counterparty: string | null; narration: string | null; reference: string | null; payment_method: string | null; amount: Amount; matched: Amount; remaining: Amount; state: MatchState
}
export interface StatementItem {
  line_id: string; date: string; value_date: string | null; description: string | null; reference: string | null; bank_txn_id: string | null; amount: Amount
  running_balance: Amount | null; category: 'CHARGES' | 'INTEREST' | 'OTHER'; adjustment_voucher_id: string | null; matched: Amount; remaining: Amount; state: MatchState
}
export interface Workspace {
  account: MoneyAccount; ledger: LedgerItem[]; statement: StatementItem[]
  matches: { id: string; method: 'AUTO' | 'MANUAL' | 'ADJUSTMENT'; reason: string | null; total: Amount; effective_date: string; created_at: string; created_by_name: string | null
    items: { statement_line_id: string | null; voucher_line_id: string | null; amount: Amount }[] }[]
}
export interface Suggestion { statement_line_id: string; voucher_line_id: string; amount: Amount; days: number; reference_match: boolean; confident: boolean }
export interface Brs {
  as_of: string; ledger_balance: Amount; statement_balance: Amount | null; statement_balance_source: 'ENTERED' | 'STATEMENT' | 'UNKNOWN'; outstanding_deposits: Amount
  outstanding_payments: Amount; unrecorded_credits: Amount; unrecorded_debits: Amount; adjusted_bank_balance: Amount | null; adjusted_book_balance: Amount
  difference: Amount | null
  ledger_items: { line_id: string; voucher_number: string; voucher_date: string; counterparty: string | null; narration: string | null; reference: string | null;
    remaining: Amount; category: string; days: number }[]
  statement_items: { line_id: string; txn_date: string; description: string | null; reference: string | null; remaining: Amount; category: string; days: number }[]
  last_reconciliation: { as_of_date: string; status: string; difference: Amount } | null
}
export type BankReportRow = Record<string, string | number | boolean | null>

// ---- labels -------------------------------------------------------------------------------------------------------
export const BANK_ACCOUNT_TYPES: BankAccountType[] = ['CURRENT', 'SAVINGS', 'CASH_CREDIT', 'OVERDRAFT', 'OTHER']
export const BANK_ACCOUNT_TYPE_LABELS: Record<BankAccountType, string> = {
  CURRENT: 'Current account', SAVINGS: 'Savings account', CASH_CREDIT: 'Cash credit account', OVERDRAFT: 'Overdraft account', OTHER: 'Other',
}
export const MATCH_STATE_META: Record<MatchState, { label: string; tone: Tone }> = {
  UNMATCHED: { label: 'Unmatched', tone: 'warning' }, PARTIALLY_MATCHED: { label: 'Partially matched', tone: 'info' }, MATCHED: { label: 'Matched', tone: 'success' },
}
export const TRANSFER_STATUS_META: Record<TransferStatus, { label: string; tone: Tone }> = {
  DRAFT: { label: 'Draft', tone: 'neutral' }, POSTED: { label: 'Posted', tone: 'success' }, REVERSED: { label: 'Reversed', tone: 'warning' }, CANCELLED: { label: 'Cancelled', tone: 'neutral' },
}
export const PAYMENT_STATE_META: Record<PaymentAccountState, { label: string; tone: Tone }> = {
  POSTED: { label: 'Posted', tone: 'success' }, REVERSED: { label: 'Payment reversed', tone: 'neutral' }, ASSIGNED: { label: 'Account assigned — posts on the next run', tone: 'info' },
  NEEDS_SELECTION: { label: 'Choose the account', tone: 'danger' }, UNMAPPED: { label: 'Unmapped', tone: 'danger' }, BY_METHOD: { label: 'Uses the payment-method account', tone: 'neutral' },
}
export const TXN_TYPE_LABELS: Record<string, string> = {
  RECEIPT: 'Receipt', PAYMENT: 'Payment', TRANSFER: 'Transfer', BANK_ADJUSTMENT: 'Bank adjustment', JV: 'Journal', OPN: 'Opening', REV: 'Reversal', SAL: 'Sales', PUR: 'Purchase',
  PIN: 'Supplier invoice', CTR: 'Contra', BNK: 'Bank adjustment',
}
export const RECON_CATEGORY_LABELS: Record<string, string> = {
  DEPOSIT_IN_TRANSIT: 'Deposit in transit', OUTSTANDING_CHEQUE: 'Outstanding cheque', OUTSTANDING_PAYMENT: 'Payment not yet on the statement',
  TRANSFER_PENDING: 'Transfer pending confirmation', REVERSED_PAYMENT: 'Reversal not yet on the statement', BANK_CREDIT_NOT_IN_ERP: 'Bank credit not in the books',
  BANK_DEBIT_NOT_IN_ERP: 'Bank debit not in the books', CHARGES_AWAITING_ACCOUNTING: 'Bank charges awaiting accounting', INTEREST_AWAITING_ACCOUNTING: 'Interest awaiting accounting',
}
export const BANK_REPORTS: { key: BankReportKey; label: string; description: string; usesAsOf: boolean; usesPeriod: boolean }[] = [
  { key: 'ACCOUNT_SUMMARY', label: 'Bank account summary', description: 'Ledger balance, last statement balance and open items per account.', usesAsOf: true, usesPeriod: false },
  { key: 'OUTSTANDING_CHEQUES', label: 'Outstanding cheques', description: 'Cheques / drafts issued (posted) but not yet on the bank statement.', usesAsOf: true, usesPeriod: false },
  { key: 'DEPOSITS_IN_TRANSIT', label: 'Deposits in transit', description: 'Receipts posted to a bank but not yet credited on its statement.', usesAsOf: true, usesPeriod: false },
  { key: 'OUTSTANDING_ITEMS', label: 'All outstanding bank entries', description: 'Every posted bank entry not yet matched: cheques, NEFT / RTGS / IMPS / UPI, transfers and reversals.', usesAsOf: true, usesPeriod: false },
  { key: 'UNMATCHED_STATEMENT', label: 'Unmatched statement transactions', description: 'Imported statement lines not yet in the books (charges, interest and other).', usesAsOf: true, usesPeriod: false },
  { key: 'BANK_CHARGES', label: 'Bank charges & interest', description: 'Charges and interest on the statements and their accounting.', usesAsOf: false, usesPeriod: true },
  { key: 'TRANSFER_REGISTER', label: 'Transfer register', description: 'Bank / cash transfers by date with their vouchers.', usesAsOf: false, usesPeriod: true },
  { key: 'CASH_POSITION', label: 'Cash position', description: 'Balance, receipts and payments of each cash account.', usesAsOf: true, usesPeriod: false },
]

// ---- statement import: column mapping and row normalisation --------------------------------------------------------
export type StatementField = 'txn_date' | 'value_date' | 'description' | 'reference' | 'debit' | 'credit' | 'amount' | 'running_balance' | 'bank_txn_id'
export const STATEMENT_FIELDS: { key: StatementField; label: string; required?: boolean }[] = [
  { key: 'txn_date', label: 'Transaction date', required: true }, { key: 'value_date', label: 'Value date' }, { key: 'description', label: 'Description / narration' },
  { key: 'reference', label: 'Reference / cheque no.' }, { key: 'debit', label: 'Debit (withdrawal)' }, { key: 'credit', label: 'Credit (deposit)' },
  { key: 'amount', label: 'Single signed amount (− = withdrawal)' }, { key: 'running_balance', label: 'Running balance' }, { key: 'bank_txn_id', label: 'Bank transaction ID' },
]
export type ColumnMapping = Partial<Record<StatementField, number>>
export type DateOrder = 'DMY' | 'MDY' | 'YMD'

const GUESS: Record<StatementField, RegExp> = {
  txn_date: /^(txn|tran|transaction|posting)?\s*date$|^date$/i, value_date: /value\s*d(ate|t)/i, description: /desc|narration|particular|remark|details/i,
  reference: /ref|chq|cheque|instrument/i, debit: /debit|withdraw|dr\b/i, credit: /credit|deposit|cr\b/i, amount: /^amount$/i, running_balance: /balance|bal\b/i,
  bank_txn_id: /(txn|transaction)\s*id|utr|unique/i,
}
/** The header row (first row with at least three non-empty cells) and a best-guess mapping; the user confirms or changes it. */
export function guessMapping(rows: string[][]): { headerRow: number; mapping: ColumnMapping } {
  const headerRow = Math.max(0, rows.findIndex((r) => r.filter((c) => c.trim()).length >= 3))
  const header = rows[headerRow] ?? []
  const mapping: ColumnMapping = {}
  for (const f of STATEMENT_FIELDS) {
    const i = header.findIndex((h, k) => GUESS[f.key].test(h.trim()) && !Object.values(mapping).includes(k))
    if (i >= 0) mapping[f.key] = i
  }
  return { headerRow, mapping }
}

/** A date cell as ISO yyyy-mm-dd: ISO, dd-mm-yyyy / dd/mm/yyyy (or the chosen order), dd-Mon-yyyy, or an Excel serial number. Null when unreadable. */
export function parseStatementDate(raw: string, order: DateOrder = 'DMY'): string | null {
  const v = raw.trim()
  if (!v) return null
  const iso = (y: number, m: number, d: number) => {
    const dt = new Date(Date.UTC(y, m - 1, d))
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null
  }
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T].*)?$/.exec(v)
  if (m) return iso(+m[1], +m[2], +m[3])
  const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
  m = /^(\d{1,2})[-/ .]([A-Za-z]{3})[A-Za-z]*[-/ .,]+(\d{2,4})$/.exec(v)
  if (m) { const mo = MON.indexOf(m[2].toLowerCase()) + 1; const y = +m[3] < 100 ? 2000 + +m[3] : +m[3]; return mo ? iso(y, mo, +m[1]) : null }
  m = /^(\d{1,4})[-/.](\d{1,2})[-/.](\d{1,4})$/.exec(v)
  if (m) {
    const [a, b, c] = [+m[1], +m[2], +m[3]]
    const y4 = (x: number) => (x < 100 ? 2000 + x : x)
    if (order === 'YMD' || m[1].length === 4) return iso(a, b, c)
    return order === 'MDY' ? iso(y4(c), a, b) : iso(y4(c), b, a)
  }
  if (/^\d{5}(\.\d+)?$/.test(v)) { // Excel serial date
    const dt = new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(v)) * 86400000)
    return dt.toISOString().slice(0, 10)
  }
  return null
}

/** An amount cell as a plain decimal string ("1,23,456.70" → "123456.70", "(59.00)" / "59.00 Dr" → "-59.00"); '' when empty; null when unreadable. */
export function parseStatementAmount(raw: string): string | null {
  let v = raw.trim().replace(/[₹,\s]/g, '').replace(/^INR/i, '')
  if (!v || v === '-') return ''
  let neg = false
  if (/^\(.*\)$/.test(v)) { neg = true; v = v.slice(1, -1) }
  if (/dr$/i.test(v)) { neg = true; v = v.slice(0, -2) } else if (/cr$/i.test(v)) v = v.slice(0, -2)
  if (v.startsWith('-')) { neg = !neg; v = v.slice(1) }
  if (!/^\d+(\.\d+)?$/.test(v)) return null
  const p = Math.round(Number(v) * 100)
  return `${neg && p ? '-' : ''}${(p / 100).toFixed(2)}`
}

export interface StatementRowOut { row_no: number; txn_date: string; value_date: string; description: string; reference: string; bank_txn_id: string; debit: string; credit: string; running_balance: string }
/**
 * Normalises the sheet rows below the header with the mapping. Rows with no readable date and no amount are skipped (blank / footer lines);
 * every other row is sent, and the database reports the ones it cannot accept (with their spreadsheet row numbers).
 */
export function mapStatementRows(rows: string[][], headerRow: number, mapping: ColumnMapping, order: DateOrder): StatementRowOut[] {
  const out: StatementRowOut[] = []
  const cell = (r: string[], f: StatementField) => (mapping[f] === undefined ? '' : (r[mapping[f]!] ?? '').trim())
  rows.forEach((r, i) => {
    if (i <= headerRow) return
    const rawDate = cell(r, 'txn_date')
    let debit = cell(r, 'debit')
    let credit = cell(r, 'credit')
    if (mapping.amount !== undefined) {
      const a = parseStatementAmount(cell(r, 'amount'))
      if (a && a.startsWith('-')) { debit = a.slice(1); credit = '' } else if (a) { credit = a; debit = '' } else if (a === null) { debit = cell(r, 'amount'); credit = '' }
    }
    // Not a transaction: no readable date and no amount (blank lines, banners, "end of statement" footers).
    if (!parseStatementDate(rawDate, order) && !debit && !credit) return
    const amt = (v: string) => { const p = parseStatementAmount(v); return p === null ? v : p.replace(/^-/, '') }
    out.push({ row_no: i + 1, txn_date: parseStatementDate(rawDate, order) ?? rawDate, value_date: parseStatementDate(cell(r, 'value_date'), order) ?? cell(r, 'value_date'),
      description: cell(r, 'description'), reference: cell(r, 'reference'), bank_txn_id: cell(r, 'bank_txn_id'), debit: amt(debit), credit: amt(credit),
      running_balance: parseStatementAmount(cell(r, 'running_balance')) ?? cell(r, 'running_balance') })
  })
  return out
}
export function mappingErrors(mapping: ColumnMapping): string[] {
  const e: string[] = []
  if (mapping.txn_date === undefined) e.push('Map the transaction date column.')
  if (mapping.amount === undefined && (mapping.debit === undefined || mapping.credit === undefined)) e.push('Map both debit and credit columns, or one signed amount column.')
  if (mapping.amount !== undefined && (mapping.debit !== undefined || mapping.credit !== undefined)) e.push('Use either debit + credit columns or one signed amount column, not both.')
  const used = Object.values(mapping)
  if (new Set(used).size !== used.length) e.push('A column is mapped to two fields.')
  return e
}

/** Base64 of a file's bytes (the original statement is stored with the import). */
export function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

// ---- matching helpers ----------------------------------------------------------------------------------------------
/** Sum of the selected items in paise; a manual match is valid when both sides are non-empty and equal. */
export function selectionTotals(statement: { remaining: Amount }[], ledger: { remaining: Amount }[]) {
  const s = statement.reduce((t, x) => t + toPaise(x.remaining), 0)
  const l = ledger.reduce((t, x) => t + toPaise(x.remaining), 0)
  return { statement: s, ledger: l, difference: s - l, valid: statement.length > 0 && ledger.length > 0 && s === l }
}

// ---- master form ---------------------------------------------------------------------------------------------------
export const IFSC_PATTERN = /^[A-Z]{4}0[A-Z0-9]{6}$/
export const normaliseAccountNumber = (v: string) => v.toUpperCase().replace(/[\s-]/g, '')
export const maskAccountNumber = (v: string) => { const n = normaliseAccountNumber(v); return 'X'.repeat(Math.max(n.length - 4, 0)) + n.slice(-4) }
export interface MoneyAccountForm {
  account_kind: MoneyKind; account_code: string; account_name: string; ledger_account_id: string; bank_name: string; branch_name: string; account_holder_name: string
  account_number: string; ifsc: string; bank_account_type: BankAccountType; opening_balance: string; opening_balance_type: 'DEBIT' | 'CREDIT'; opening_balance_date: string
  opening_balance_reference: string; custodian_user_id: string; allow_negative_balance: boolean; notes: string
}
export const emptyMoneyAccount = (kind: MoneyKind): MoneyAccountForm => ({
  account_kind: kind, account_code: '', account_name: '', ledger_account_id: '', bank_name: '', branch_name: '', account_holder_name: '', account_number: '', ifsc: '',
  bank_account_type: 'CURRENT', opening_balance: '', opening_balance_type: 'DEBIT', opening_balance_date: '', opening_balance_reference: '', custodian_user_id: '',
  allow_negative_balance: false, notes: '',
})
export const moneyAccountForm = (a: MoneyAccount): MoneyAccountForm => ({
  account_kind: a.account_kind, account_code: a.account_code, account_name: a.account_name, ledger_account_id: a.ledger_account_id, bank_name: a.bank_name ?? '',
  branch_name: a.branch_name ?? '', account_holder_name: a.account_holder_name ?? '', account_number: '', ifsc: a.ifsc ?? '', bank_account_type: a.bank_account_type ?? 'CURRENT',
  opening_balance: a.opening_balance === null ? '' : Number(a.opening_balance).toFixed(2), opening_balance_type: a.opening_balance_type ?? 'DEBIT',
  opening_balance_date: a.opening_balance_date ?? '', opening_balance_reference: a.opening_balance_reference ?? '', custodian_user_id: a.custodian_user_id ?? '',
  allow_negative_balance: a.allow_negative_balance, notes: a.notes ?? '',
})
/** Browser checks before saving (the number is optional when editing: blank keeps the stored one). */
export function moneyAccountErrors(f: MoneyAccountForm, isNew: boolean): string[] {
  const e: string[] = []
  if (!/^[A-Z0-9][A-Z0-9_-]{0,19}$/.test(f.account_code.trim().toUpperCase())) e.push('Account code: up to 20 letters, digits, - or _.')
  if (!f.account_name.trim()) e.push('Enter the account name.')
  if (!f.ledger_account_id) e.push('Select the linked ledger.')
  if (f.opening_balance.trim() && !/^\d+(\.\d{1,2})?$/.test(f.opening_balance.trim())) e.push('Opening balance: an amount with at most 2 decimals.')
  if (f.account_kind === 'BANK') {
    if (!f.bank_name.trim() || !f.account_holder_name.trim()) e.push('Bank name and account holder are required.')
    if (!IFSC_PATTERN.test(f.ifsc.trim().toUpperCase())) e.push('IFSC: 11 characters — 4 letters, 0, then 6 letters or digits.')
    const n = normaliseAccountNumber(f.account_number)
    if (isNew && !n) e.push('Enter the bank account number.')
    if (n && !/^[0-9A-Z]{6,34}$/.test(n)) e.push('The account number must be 6 to 34 letters or digits.')
  }
  return e
}
export function moneyAccountPayload(f: MoneyAccountForm): Record<string, unknown> {
  const opt = (v: string) => (v.trim() ? v.trim() : null)
  const bank = f.account_kind === 'BANK'
  return {
    account_kind: f.account_kind, account_code: f.account_code.trim().toUpperCase(), account_name: f.account_name.trim(), ledger_account_id: f.ledger_account_id,
    ...(bank ? { bank_name: opt(f.bank_name), branch_name: opt(f.branch_name), account_holder_name: opt(f.account_holder_name), ifsc: f.ifsc.trim().toUpperCase(),
      bank_account_type: f.bank_account_type, ...(normaliseAccountNumber(f.account_number) ? { account_number: normaliseAccountNumber(f.account_number) } : {}) } : {}),
    opening_balance: opt(f.opening_balance), opening_balance_type: opt(f.opening_balance) ? f.opening_balance_type : null, opening_balance_date: opt(f.opening_balance_date),
    opening_balance_reference: opt(f.opening_balance_reference), custodian_user_id: opt(f.custodian_user_id), allow_negative_balance: f.allow_negative_balance, notes: opt(f.notes),
  }
}

/**
 * CSV text → rows of trimmed strings, cells kept verbatim (quoted fields, doubled quotes, CRLF / LF). Used instead of the
 * spreadsheet library for .csv statements, which would read text dates like 05/11/26 month-first.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  const src = text.replace(/^﻿/, '')
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i++ } else if (c === '"') quoted = false
      else cell += c
    } else if (c === '"') quoted = true
    else if (c === ',') { row.push(cell.trim()); cell = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++
      row.push(cell.trim()); rows.push(row); row = []; cell = ''
    } else cell += c
  }
  if (cell !== '' || row.length) { row.push(cell.trim()); rows.push(row) }
  return rows
}
