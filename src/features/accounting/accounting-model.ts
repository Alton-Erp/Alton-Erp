/**
 * Alton Accounts (Phase 0): types, labels and pure helpers for the Accounts screens.
 * Every figure shown comes from posted accounting vouchers via database RPCs; nothing here
 * calculates balances that the database does not already return.
 */

export type Classification = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'INCOME' | 'EXPENSE'
export type NormalBalance = 'DEBIT' | 'CREDIT'
export type VoucherStatus = 'DRAFT' | 'POSTED' | 'REVERSED' | 'DISCARDED'
export type VoucherSource = 'MANUAL' | 'AUTO' | 'OPENING' | 'REVERSAL'
export type EventStatus = 'PENDING' | 'POSTED' | 'FAILED' | 'NEEDS_ACCOUNT_MAPPING' | 'SKIPPED' | 'DISMISSED'
export type SourceType = 'SALES_INVOICE' | 'CUSTOMER_RECEIPT' | 'CREDIT_NOTE' | 'DEBIT_NOTE' | 'SUPPLIER_PAYMENT' | 'GOODS_RECEIPT'
export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'
export type Amount = number | string

export interface AccountingSettings {
  books_start_date: string
  fy_start_month: number
  currency_code: 'INR'
  allow_future_dates: boolean
  backdate_limit_days: number | null
  segregation_of_duties: boolean
  auto_posting_max_attempts: number
  initialized_at: string
  updated_at: string
}

export interface AccountingStatus {
  initialized: boolean
  settings: AccountingSettings | null
  current_financial_year: string | null
  today: string
  has_postings: boolean
  has_vouchers: boolean
  default_fy_start_month: number
}

export interface AccountGroup {
  id: string
  group_code: string
  group_name: string
  parent_group_id: string | null
  classification: Classification
  normal_balance: NormalBalance
  is_system: boolean
  is_active: boolean
  sort_order: number
  description: string | null
}

export type AccountNature = 'GENERAL' | 'CASH' | 'BANK' | 'RECEIVABLE_CONTROL' | 'PAYABLE_CONTROL' | 'TAX' | 'INVENTORY' | 'ROUND_OFF' | 'CAPITAL' | 'LOAN' | 'FIXED_ASSET'

export interface Account {
  id: string
  account_code: string
  account_name: string
  group_id?: string
  group_name: string
  classification: Classification
  normal_balance: NormalBalance
  account_nature: AccountNature
  is_postable: boolean
  allow_manual_posting: boolean
  requires_party: boolean
  is_control?: boolean
  is_system: boolean
  system_key?: string | null
  is_active: boolean
  description?: string | null
  /** Debit minus credit of posted vouchers. */
  balance: Amount
  line_count?: number
  /** Phase 2: whether postings to the account need / accept a cost-centre allocation. */
  cost_centre_policy?: CostCentrePolicy
}

export interface Chart { groups: AccountGroup[]; accounts: Account[] }

export interface Party {
  id: string
  party_code: string
  party_name: string
  is_customer: boolean
  is_supplier: boolean
  opening_balance: Amount
  opening_balance_type: 'RECEIVABLE' | 'PAYABLE' | null
}

export interface VoucherLine {
  id: string
  line_no: number
  account_id: string
  account_code: string
  account_name: string
  party_id: string | null
  party_name: string | null
  debit: Amount
  credit: Amount
  narration: string | null
  cost_centre_policy?: CostCentrePolicy
  allocations?: Allocation[]
}

export interface Allocation { cost_centre_id: string; cost_centre_code: string; cost_centre_name: string; amount: Amount }

export interface ValidationIssue { code: string; message: string; line_no?: number }

export interface Voucher {
  id: string
  voucher_type: string
  voucher_type_name: string
  voucher_number: string | null
  financial_year: string
  voucher_date: string
  reference_number: string | null
  narration: string | null
  status: VoucherStatus
  source: VoucherSource
  source_type: string | null
  source_id: string | null
  source_number: string | null
  reversal_of_voucher_id: string | null
  reversal_of_number: string | null
  reversed_by_voucher_id: string | null
  reversed_by_number: string | null
  reversal_reason: string | null
  reversed_at: string | null
  reversed_by_name: string | null
  total_debit: Amount
  total_credit: Amount
  row_version: number
  created_at: string
  created_by_name: string | null
  updated_at: string
  posted_at: string | null
  posted_by_name: string | null
  discarded_at: string | null
  discard_reason: string | null
  lines: VoucherLine[]
  issues?: ValidationIssue[]
  audit?: { action: string; at: string; by: string | null; metadata: Record<string, unknown> }[]
}

export interface VoucherListRow {
  id: string
  voucher_number: string | null
  voucher_type: string
  voucher_type_name: string
  voucher_date: string
  reference_number: string | null
  narration: string | null
  status: VoucherStatus
  source: VoucherSource
  source_type: string | null
  source_number: string | null
  total_debit: Amount
  total_credit: Amount
  reversal_of_voucher_id: string | null
  created_by: string | null
  created_by_name: string | null
  created_at: string
  posted_at: string | null
}

export interface TrialBalanceRow {
  account_id: string
  account_code: string
  account_name: string
  group_name: string
  classification: Classification
  normal_balance: NormalBalance
  is_active: boolean
  opening_debit: Amount
  opening_credit: Amount
  period_debit: Amount
  period_credit: Amount
  closing_debit: Amount
  closing_credit: Amount
}

export interface TrialBalance {
  from: string
  to: string
  rows: TrialBalanceRow[]
  totals: Record<'opening_debit' | 'opening_credit' | 'period_debit' | 'period_credit' | 'closing_debit' | 'closing_credit', Amount>
}

export interface LedgerEntry {
  voucher_id: string
  voucher_number: string
  voucher_date: string
  voucher_type: string
  status: VoucherStatus
  narration: string | null
  reference_number: string | null
  source_type: string | null
  source_number: string | null
  party_id: string | null
  party_name: string | null
  debit: Amount
  credit: Amount
  balance: Amount
}

export interface GeneralLedger {
  account: { id: string; account_code: string; account_name: string; normal_balance: NormalBalance; classification: Classification; requires_party: boolean }
  from: string
  to: string
  opening_balance: Amount
  entries: LedgerEntry[]
  closing_balance: Amount
}

export interface DayBook { from: string; to: string; vouchers: Voucher[]; totals: { debit: Amount; credit: Amount; vouchers: number } }

export interface Period {
  id: string
  financial_year: string
  period_no: number
  period_name: string
  start_date: string
  end_date: string
  status: 'OPEN' | 'CLOSED' | 'REOPENED'
  status_reason: string | null
  closed_at: string | null
  reopened_at: string | null
  draft_vouchers: number
  posted_vouchers: number
}

export interface PostingRule {
  id: string
  rule_key: string
  match_value: string
  account_id: string
  account_code: string
  account_name: string
  account_active: boolean
  is_active: boolean
  updated_at: string
}

export interface PostingEvent {
  id: string
  source_type: SourceType
  source_id: string
  event_action: 'POST' | 'REVERSE'
  source_number: string | null
  source_date: string
  amount: Amount | null
  status: EventStatus
  attempts: number
  last_attempt_at: string | null
  error_code: string | null
  error_message: string | null
  voucher_id: string | null
  voucher_number: string | null
  dismiss_reason: string | null
  dismissed_at: string | null
  posted_at: string | null
  created_at: string
}

export interface PostingEvents { counts: Partial<Record<EventStatus, number>>; rows: PostingEvent[]; max_attempts: number | null }

export interface PostingRunResult { busy: boolean; message?: string; queued?: number; processed?: number; results?: Partial<Record<string, number>>; remaining?: number }

export type CostCentreType = 'DEPARTMENT' | 'PRODUCTION' | 'SERVICE' | 'SALES' | 'ADMINISTRATION' | 'WAREHOUSE' | 'PROJECT' | 'BRANCH' | 'OTHER'
export type CostCentrePolicy = 'REQUIRED' | 'OPTIONAL' | 'NOT_APPLICABLE'

export interface CostCentre {
  id: string
  cost_centre_code: string
  cost_centre_name: string
  description: string | null
  parent_cost_centre_id: string | null
  is_active: boolean
  updated_at: string
  /** Phase 2 (migration 20261231090200). */
  cost_centre_type?: CostCentreType
  effective_from?: string | null
  effective_to?: string | null
  allocation_count?: number
  posted_allocation_count?: number
  budget_line_count?: number
  child_count?: number
}

export interface OpeningCheck {
  code: string
  label: string
  status: 'PASS' | 'FAIL'
  acknowledgeable: boolean
  expected?: Amount
  actual?: Amount
  difference?: Amount
  unvalued_lines?: number
  details?: unknown
}

export type OpeningCategory = 'LEDGER' | 'PARTY' | 'CASH_BANK' | 'CAPITAL' | 'LOAN' | 'FIXED_ASSET' | 'INVENTORY' | 'OTHER'

export interface OpeningLine {
  id: string
  line_no: number
  account_id: string
  account_code: string
  account_name: string
  party_id: string | null
  party_name: string | null
  party_code: string | null
  balance_category: OpeningCategory
  debit: Amount
  credit: Amount
  description: string | null
}

export interface OpeningBatch {
  id: string
  batch_number: string
  as_of_date: string
  source: 'MANUAL' | 'IMPORT'
  file_name: string | null
  notes: string | null
  status: 'DRAFT' | 'APPROVED' | 'POSTED' | 'DISCARDED'
  acknowledgements: { code: string; reason: string; difference: Amount }[]
  voucher_number: string | null
  created_by_name: string | null
  approved_by_name: string | null
  posted_by_name: string | null
  created_at: string
  approved_at: string | null
  posted_at: string | null
  line_total_debit: Amount
  line_total_credit: Amount
  lines: OpeningLine[]
  checks?: OpeningCheck[]
}

export interface OpeningBatchSummary {
  id: string
  batch_number: string
  as_of_date: string
  status: OpeningBatch['status']
  source: string
  file_name: string | null
  notes: string | null
  created_at: string
  posted_at: string | null
  voucher_number: string | null
  line_count: number
  total_debit: Amount
  total_credit: Amount
}

export interface AccountingDashboard {
  initialized: boolean
  books_start_date?: string
  financial_year?: string
  fy_from?: string
  today?: string
  vouchers?: { draft: number; posted: number; reversed: number; posted_this_fy: number; automatic: number; manual: number }
  books?: { total_debit: Amount; total_credit: Amount }
  events?: Partial<Record<EventStatus, number>>
  periods?: { open: number; closed: number; current: string | null }
  opening?: { posted: boolean | null; in_progress: number }
  unmapped_payment_methods?: string[]
  classification?: Partial<Record<Classification, Amount>>
}

// ---- labels ---------------------------------------------------------------------------------------------------
export const CLASSIFICATIONS: Classification[] = ['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE']
export const CLASSIFICATION_LABELS: Record<Classification, string> = {
  ASSET: 'Assets', LIABILITY: 'Liabilities', EQUITY: 'Capital & Reserves', INCOME: 'Income', EXPENSE: 'Expenses',
}

export const NATURE_LABELS: Record<AccountNature, string> = {
  GENERAL: 'General', CASH: 'Cash', BANK: 'Bank', RECEIVABLE_CONTROL: 'Debtors control', PAYABLE_CONTROL: 'Creditors control',
  TAX: 'Tax', INVENTORY: 'Inventory', ROUND_OFF: 'Round off', CAPITAL: 'Capital', LOAN: 'Loan', FIXED_ASSET: 'Fixed asset',
}
/** Natures a user may choose for a new ledger (control accounts are system accounts). */
export const USER_NATURES: AccountNature[] = ['GENERAL', 'CASH', 'BANK', 'TAX', 'INVENTORY', 'ROUND_OFF', 'CAPITAL', 'LOAN', 'FIXED_ASSET']

export const VOUCHER_STATUS_META: Record<VoucherStatus, { label: string; tone: Tone }> = {
  DRAFT: { label: 'Draft', tone: 'warning' },
  POSTED: { label: 'Posted', tone: 'success' },
  REVERSED: { label: 'Reversed', tone: 'neutral' },
  DISCARDED: { label: 'Discarded', tone: 'neutral' },
}

export const SOURCE_LABELS: Record<VoucherSource, string> = { MANUAL: 'Manual', AUTO: 'Automatic', OPENING: 'Opening balance', REVERSAL: 'Reversal' }

export const EVENT_STATUS_META: Record<EventStatus, { label: string; tone: Tone }> = {
  PENDING: { label: 'Pending', tone: 'info' },
  POSTED: { label: 'Posted', tone: 'success' },
  FAILED: { label: 'Failed', tone: 'danger' },
  NEEDS_ACCOUNT_MAPPING: { label: 'Needs account mapping', tone: 'warning' },
  SKIPPED: { label: 'Skipped', tone: 'neutral' },
  DISMISSED: { label: 'Dismissed', tone: 'neutral' },
}
export const EVENT_STATUSES = Object.keys(EVENT_STATUS_META) as EventStatus[]

export const SOURCE_TYPE_LABELS: Record<SourceType, string> = {
  SALES_INVOICE: 'Sales invoice', CUSTOMER_RECEIPT: 'Customer receipt', CREDIT_NOTE: 'Credit note', DEBIT_NOTE: 'Debit note',
  SUPPLIER_PAYMENT: 'Supplier payment', GOODS_RECEIPT: 'Goods receipt',
}

/** Where a source document opens in the ERP (null when it has no page). */
export function sourceLink(type: string | null, id: string | null): string | null {
  if (!type || !id) return null
  switch (type) {
    case 'SALES_INVOICE': return `/billing/invoices/${id}`
    case 'CREDIT_NOTE':
    case 'DEBIT_NOTE': return `/billing/notes/${id}`
    case 'CUSTOMER_RECEIPT': return `/billing/payments?receipt=${id}`
    case 'GOODS_RECEIPT': return `/goods-receipts/${id}`
    default: return null
  }
}

export const PAYMENT_METHODS = ['BANK_TRANSFER', 'UPI', 'CHEQUE', 'CASH', 'CARD', 'DEMAND_DRAFT', 'OTHER'] as const
export const PAYMENT_METHOD_LABELS: Record<(typeof PAYMENT_METHODS)[number], string> = {
  BANK_TRANSFER: 'Bank transfer', UPI: 'UPI', CHEQUE: 'Cheque', CASH: 'Cash', CARD: 'Card', DEMAND_DRAFT: 'Demand draft', OTHER: 'Other',
}

/** The fixed posting rules (one account each) and what they are used for. */
export const RULES: { key: string; label: string; use: string; nature?: AccountNature }[] = [
  { key: 'DEBTORS', label: 'Debtors (control)', use: 'Customer side of invoices, receipts and notes', nature: 'RECEIVABLE_CONTROL' },
  { key: 'CREDITORS', label: 'Creditors (control)', use: 'Supplier side of goods receipts and supplier payments', nature: 'PAYABLE_CONTROL' },
  { key: 'SALES', label: 'Sales', use: 'Taxable value of invoices and debit notes' },
  { key: 'SALES_RETURNS', label: 'Sales returns', use: 'Taxable value of credit notes' },
  { key: 'OUTPUT_CGST', label: 'Output CGST', use: 'CGST on invoices and notes' },
  { key: 'OUTPUT_SGST', label: 'Output SGST', use: 'SGST on invoices and notes' },
  { key: 'OUTPUT_IGST', label: 'Output IGST', use: 'IGST on invoices and notes' },
  { key: 'ROUND_OFF', label: 'Round off', use: 'Invoice round-off' },
  { key: 'PURCHASES', label: 'Purchases', use: 'Net value of goods receipts' },
  { key: 'GST_INPUT_PENDING', label: 'GST input pending verification', use: 'GST calculated on goods receipts (not verified ITC)' },
]

export const OPENING_CATEGORIES: OpeningCategory[] = ['LEDGER', 'PARTY', 'CASH_BANK', 'CAPITAL', 'LOAN', 'FIXED_ASSET', 'INVENTORY', 'OTHER']
export const OPENING_CATEGORY_LABELS: Record<OpeningCategory, string> = {
  LEDGER: 'Ledger', PARTY: 'Customer / supplier', CASH_BANK: 'Cash & bank', CAPITAL: 'Capital', LOAN: 'Loan', FIXED_ASSET: 'Fixed asset',
  INVENTORY: 'Inventory', OTHER: 'Other',
}

// ---- amounts --------------------------------------------------------------------------------------------------
const AMOUNT = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** Converts a numeric value from the API to paise (an integer), so totals never drift. */
export const toPaise = (v: Amount | null | undefined): number => Math.round(Number(v ?? 0) * 100)

/** "1,23,456.78" (blank for zero when `blankZero`). */
export function formatAmount(v: Amount | null | undefined, blankZero = false): string {
  const p = toPaise(v)
  if (blankZero && p === 0) return ''
  return AMOUNT.format(p / 100)
}

/** A signed balance (debit − credit) as "1,234.00 Dr" / "1,234.00 Cr" / "0.00". */
export function formatBalance(v: Amount | null | undefined): string {
  const p = toPaise(v)
  if (p === 0) return '0.00'
  return `${AMOUNT.format(Math.abs(p) / 100)} ${p > 0 ? 'Dr' : 'Cr'}`
}

/** A user-typed amount: digits with at most 2 decimals and greater than zero. */
export const isPositiveAmount = (v: string) => /^\d+(\.\d{1,2})?$/.test(v.trim()) && toPaise(v.trim()) > 0

/** Sums amounts in paise; returns rupees as a number with 2 decimals. */
export function sumAmounts(values: (Amount | null | undefined)[]): number {
  return values.reduce<number>((t, v) => t + toPaise(v), 0) / 100
}

/** Debit / credit totals and whether a set of lines balances (exact, in paise). */
export function lineTotals(lines: { debit?: Amount | null; credit?: Amount | null }[]) {
  const dr = lines.reduce((t, l) => t + toPaise(l.debit), 0)
  const cr = lines.reduce((t, l) => t + toPaise(l.credit), 0)
  return { debit: dr / 100, credit: cr / 100, difference: (dr - cr) / 100, balanced: dr === cr && dr > 0 }
}

// ---- dates ----------------------------------------------------------------------------------------------------
/** Financial year containing an ISO date: { from, to, label } (e.g. 2026-04-01 .. 2027-03-31, "2026-27"). */
export function financialYear(isoDate: string, startMonth = 4) {
  const [y, m] = isoDate.split('-').map(Number)
  const start = m >= startMonth ? y : y - 1
  const pad = (n: number) => String(n).padStart(2, '0')
  const endMonth = startMonth === 1 ? 12 : startMonth - 1
  const endYear = startMonth === 1 ? start : start + 1
  const lastDay = new Date(Date.UTC(endYear, endMonth, 0)).getUTCDate()
  return {
    from: `${start}-${pad(startMonth)}-01`,
    to: `${endYear}-${pad(endMonth)}-${pad(lastDay)}`,
    label: startMonth === 1 ? String(start) : `${start}-${pad((start + 1) % 100)}`,
  }
}

// ---- chart of accounts tree ---------------------------------------------------------------------------------
export interface GroupNode {
  group: AccountGroup
  children: GroupNode[]
  accounts: Account[]
  /** Debit − credit of every account in the group and its sub-groups (paise-exact). */
  balance: number
  accountCount: number
}

export function buildGroupTree(groups: AccountGroup[], accounts: Account[]): GroupNode[] {
  const byParent = new Map<string | null, AccountGroup[]>()
  for (const g of groups) byParent.set(g.parent_group_id, [...(byParent.get(g.parent_group_id) ?? []), g])
  const accountsBy = new Map<string, Account[]>()
  for (const a of accounts) if (a.group_id) accountsBy.set(a.group_id, [...(accountsBy.get(a.group_id) ?? []), a])
  const seen = new Set<string>()
  const build = (g: AccountGroup): GroupNode => {
    seen.add(g.id)
    const children = (byParent.get(g.id) ?? []).filter((c) => !seen.has(c.id)).sort(groupOrder).map(build)
    const own = (accountsBy.get(g.id) ?? []).sort((a, b) => a.account_code.localeCompare(b.account_code))
    const paise = own.reduce((t, a) => t + toPaise(a.balance), 0) + children.reduce((t, c) => t + Math.round(c.balance * 100), 0)
    return { group: g, children, accounts: own, balance: paise / 100, accountCount: own.length + children.reduce((t, c) => t + c.accountCount, 0) }
  }
  return (byParent.get(null) ?? []).sort(groupOrder).map(build)
}
const groupOrder = (a: AccountGroup, b: AccountGroup) => a.sort_order - b.sort_order || a.group_code.localeCompare(b.group_code)

// ---- opening balance import ---------------------------------------------------------------------------------
export interface OpeningImportLine {
  account_code: string
  party_code: string | null
  balance_category: OpeningCategory | null
  debit: string
  credit: string
  description: string | null
}

const HEADER_ALIASES: Record<keyof OpeningImportLine, string[]> = {
  account_code: ['account code', 'account_code', 'ledger code', 'account'],
  party_code: ['party code', 'party_code', 'party'],
  balance_category: ['category', 'balance category', 'balance_category', 'type'],
  debit: ['debit', 'dr', 'debit amount'],
  credit: ['credit', 'cr', 'credit amount'],
  description: ['description', 'narration', 'remarks', 'notes'],
}

/** Template rows for the opening balance import (header + one example per side). */
export const OPENING_TEMPLATE: string[][] = [
  ['Account code', 'Party code', 'Category', 'Debit', 'Credit', 'Description'],
  ['1210', '', 'CASH_BANK', '250000.00', '', 'HDFC current account balance'],
  ['3100', '', 'CAPITAL', '', '250000.00', 'Capital introduced'],
]

/**
 * Reads opening balance rows from a sheet (CSV / XLSX cells as text). The header row may be anywhere in
 * the first 10 rows. Returns the lines to send and row-numbered errors; the database validates everything
 * again (accounts, parties, duplicates, balance), so this only catches obvious mistakes early.
 */
export function parseOpeningSheet(rows: string[][]): { lines: OpeningImportLine[]; errors: string[] } {
  const norm = (s: string | undefined) => (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
  const headerIndex = rows.slice(0, 10).findIndex((r) => r.some((c) => HEADER_ALIASES.account_code.includes(norm(c))))
  if (headerIndex < 0) return { lines: [], errors: ['No header row found: the sheet needs an "Account code" column (download the template).'] }
  const header = rows[headerIndex].map(norm)
  const col = Object.fromEntries(Object.entries(HEADER_ALIASES).map(([k, names]) => [k, header.findIndex((h) => names.includes(h))])) as Record<keyof OpeningImportLine, number>
  if (col.debit < 0 || col.credit < 0) return { lines: [], errors: ['The sheet needs both a "Debit" and a "Credit" column.'] }
  const cell = (r: string[], k: keyof OpeningImportLine) => (col[k] >= 0 ? (r[col[k]] ?? '').trim() : '')
  const lines: OpeningImportLine[] = []
  const errors: string[] = []
  for (let i = headerIndex + 1; i < rows.length; i++) {
    const r = rows[i]
    const rowNo = i + 1
    if (r.every((c) => !(c ?? '').trim())) continue
    const code = cell(r, 'account_code').toUpperCase()
    const debit = cell(r, 'debit').replace(/,/g, '')
    const credit = cell(r, 'credit').replace(/,/g, '')
    const category = cell(r, 'balance_category').toUpperCase().replace(/[\s&/-]+/g, '_')
    if (!code) { errors.push(`Row ${rowNo}: the account code is missing.`); continue }
    const bad = [debit, credit].find((v) => v && !/^\d+(\.\d{1,2})?$/.test(v))
    if (bad) { errors.push(`Row ${rowNo}: "${bad}" is not an amount (digits, at most 2 decimals, no minus sign).`); continue }
    if ((toPaise(debit) > 0) === (toPaise(credit) > 0)) { errors.push(`Row ${rowNo}: enter either a debit or a credit greater than zero.`); continue }
    if (category && !OPENING_CATEGORIES.includes(category as OpeningCategory)) {
      errors.push(`Row ${rowNo}: unknown category "${cell(r, 'balance_category')}" (use ${OPENING_CATEGORIES.join(', ')}).`); continue
    }
    lines.push({
      account_code: code, party_code: cell(r, 'party_code').toUpperCase() || null, balance_category: (category || null) as OpeningCategory | null,
      debit: toPaise(debit) > 0 ? debit : '', credit: toPaise(credit) > 0 ? credit : '', description: cell(r, 'description') || null,
    })
  }
  if (!lines.length && !errors.length) errors.push('The sheet has no opening balance rows.')
  return { lines, errors }
}

// ---- manual journal voucher form (Phase 1) --------------------------------------------------------------------
export interface AllocationForm { key: string; cost_centre_id: string; amount: string }
export interface JournalLineForm { key: string; account_id: string; debit: string; credit: string; narration: string; allocations: AllocationForm[] }
export interface JournalForm { voucher_date: string; reference_number: string; narration: string; lines: JournalLineForm[] }

let journalKey = 0
export const newJournalLine = (): JournalLineForm => ({ key: `jl${++journalKey}`, account_id: '', debit: '', credit: '', narration: '', allocations: [] })
export const newAllocation = (): AllocationForm => ({ key: `al${++journalKey}`, cost_centre_id: '', amount: '' })
export const emptyJournal = (today: string): JournalForm => ({ voucher_date: today, reference_number: '', narration: '', lines: [newJournalLine(), newJournalLine()] })

/** Form state from a saved draft. */
export function journalFromVoucher(v: Voucher): JournalForm {
  return {
    voucher_date: v.voucher_date, reference_number: v.reference_number ?? '', narration: v.narration ?? '',
    lines: v.lines.map((l) => ({ key: l.id, account_id: l.account_id, debit: toPaise(l.debit) ? formatPlain(l.debit) : '', credit: toPaise(l.credit) ? formatPlain(l.credit) : '', narration: l.narration ?? '',
      allocations: (l.allocations ?? []).map((a) => ({ key: `${l.id}-${a.cost_centre_id}`, cost_centre_id: a.cost_centre_id, amount: formatPlain(a.amount) })) })),
  }
}
const formatPlain = (v: Amount) => (toPaise(v) / 100).toFixed(2)

/** A line the user has not started (no account, no amounts, no narration) is ignored when saving. */
export const isBlankJournalLine = (l: JournalLineForm) => !l.account_id && !l.debit.trim() && !l.credit.trim() && !l.narration.trim()

/**
 * Client-side checks before saving / posting (the database checks everything again, including dates,
 * periods, active accounts and control accounts). `forPosting` adds the balance rules.
 */
export function validateJournal(form: JournalForm, forPosting: boolean): { lineErrors: Record<string, string>; errors: string[] } {
  const lineErrors: Record<string, string> = {}
  const errors: string[] = []
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.voucher_date)) errors.push('Enter the voucher date.')
  if (form.narration.length > 1000) errors.push('The narration is too long (maximum 1000 characters).')
  if (form.reference_number.length > 100) errors.push('The reference number is too long (maximum 100 characters).')
  const used = form.lines.filter((l) => !isBlankJournalLine(l))
  for (const l of used) {
    const d = l.debit.trim()
    const c = l.credit.trim()
    if (!l.account_id) lineErrors[l.key] = 'Select a ledger account.'
    else if ((d !== '') === (c !== '')) lineErrors[l.key] = 'Enter either a debit or a credit amount.'
    else if (!isPositiveAmount(d || c)) lineErrors[l.key] = 'Amount: greater than zero, digits with at most 2 decimals.'
    else if (l.narration.length > 500) lineErrors[l.key] = 'Line narration: at most 500 characters.'
    else { const a = allocationError(l); if (a) lineErrors[l.key] = a }
  }
  if (used.length > 500) errors.push('A voucher can have at most 500 lines.')
  if (forPosting) {
    const t = lineTotals(used.map((l) => ({ debit: l.debit.trim() || 0, credit: l.credit.trim() || 0 })))
    if (used.length < 2) errors.push('A journal needs at least two lines.')
    if (!used.some((l) => l.debit.trim()) || !used.some((l) => l.credit.trim())) errors.push('A journal needs at least one debit and one credit line.')
    if (!t.balanced && used.length >= 2) errors.push(`Total debit (${formatAmount(t.debit)}) does not equal total credit (${formatAmount(t.credit)}).`)
  }
  return { lineErrors, errors }
}

/** The payload accounting_voucher_create / _update expect (blank lines dropped, amounts as strings). */
export function journalPayload(form: JournalForm) {
  return {
    voucher_type: 'JV', voucher_date: form.voucher_date, reference_number: form.reference_number.trim() || null, narration: form.narration.trim() || null,
    lines: form.lines.filter((l) => !isBlankJournalLine(l)).map((l) => ({
      account_id: l.account_id, debit: l.debit.trim() || null, credit: l.credit.trim() || null, narration: l.narration.trim() || null,
      allocations: l.allocations.filter((a) => a.cost_centre_id || a.amount.trim()).map((a) => ({ cost_centre_id: a.cost_centre_id, amount: a.amount.trim() })),
    })),
  }
}

// ---- Phase 2: cost centres, allocations, budgets ----------------------------------------------------------------
export const COST_CENTRE_TYPES: CostCentreType[] = ['DEPARTMENT', 'PRODUCTION', 'SERVICE', 'SALES', 'ADMINISTRATION', 'WAREHOUSE', 'PROJECT', 'BRANCH', 'OTHER']
export const COST_CENTRE_TYPE_LABELS: Record<CostCentreType, string> = {
  DEPARTMENT: 'Department', PRODUCTION: 'Production', SERVICE: 'Service', SALES: 'Sales', ADMINISTRATION: 'Administration', WAREHOUSE: 'Warehouse',
  PROJECT: 'Project', BRANCH: 'Branch', OTHER: 'Other',
}
export const COST_CENTRE_POLICY_LABELS: Record<CostCentrePolicy, string> = { REQUIRED: 'Required', OPTIONAL: 'Optional', NOT_APPLICABLE: 'Not applicable' }

/** Why a line's cost-centre split is wrong (null when it is fine or there is no split). Mirrors the database checks. */
export function allocationError(l: Pick<JournalLineForm, 'debit' | 'credit' | 'allocations'>): string | null {
  const used = l.allocations.filter((a) => a.cost_centre_id || a.amount.trim())
  if (!used.length) return null
  if (used.some((a) => !a.cost_centre_id)) return 'Cost centres: select a cost centre on every split row.'
  if (used.some((a) => !isPositiveAmount(a.amount))) return 'Cost centres: each amount must be greater than zero (at most 2 decimals).'
  if (new Set(used.map((a) => a.cost_centre_id)).size !== used.length) return 'Cost centres: the same cost centre appears twice; combine the amounts.'
  const line = toPaise((l.debit.trim() || l.credit.trim() || '0'))
  const total = used.reduce((t, a) => t + toPaise(a.amount), 0)
  if (total !== line) return `Cost centres: the split totals ${formatAmount(total / 100)} but the line is ${formatAmount(line / 100)}.`
  return null
}

/** Splits an amount over cost centres by percentages (paise-exact; the last row takes the rounding). */
export function splitByPercent(amount: string, percents: number[]): string[] {
  const total = toPaise(amount)
  const parts = percents.map((p) => Math.floor((total * p) / 100))
  parts[parts.length - 1] += total - parts.reduce((t, x) => t + x, 0)
  return parts.map((p) => (p / 100).toFixed(2))
}

export interface CostCentreNode { centre: CostCentre; children: CostCentreNode[]; depth: number }

/** Cost centres as a tree (sorted by code); a corrupt cycle in the data cannot loop. */
export function buildCostCentreTree(centres: CostCentre[]): CostCentreNode[] {
  const byParent = new Map<string | null, CostCentre[]>()
  const ids = new Set(centres.map((c) => c.id))
  for (const c of centres) {
    const p = c.parent_cost_centre_id && ids.has(c.parent_cost_centre_id) ? c.parent_cost_centre_id : null
    byParent.set(p, [...(byParent.get(p) ?? []), c])
  }
  const seen = new Set<string>()
  const build = (c: CostCentre, depth: number): CostCentreNode => {
    seen.add(c.id)
    return { centre: c, depth, children: (byParent.get(c.id) ?? []).filter((k) => !seen.has(k.id)).sort((a, b) => a.cost_centre_code.localeCompare(b.cost_centre_code)).map((k) => build(k, depth + 1)) }
  }
  return (byParent.get(null) ?? []).sort((a, b) => a.cost_centre_code.localeCompare(b.cost_centre_code)).map((c) => build(c, 0))
}
export const flattenCostCentreTree = (nodes: CostCentreNode[]): CostCentreNode[] => nodes.flatMap((n) => [n, ...flattenCostCentreTree(n.children)])

/** Rolls a per-centre figure up the hierarchy: each centre gets its own value plus all its descendants' (paise-exact). */
export function rollUp(centres: CostCentre[], own: Record<string, Amount>): Record<string, number> {
  const out: Record<string, number> = {}
  const walk = (n: CostCentreNode): number => {
    const p = toPaise(own[n.centre.id] ?? 0) + n.children.reduce((t, c) => t + walk(c), 0)
    out[n.centre.id] = p / 100
    return p
  }
  buildCostCentreTree(centres).forEach(walk)
  return out
}

export type BudgetStatus = 'DRAFT' | 'APPROVED' | 'SUPERSEDED' | 'CANCELLED'
export const BUDGET_STATUS_META: Record<BudgetStatus, { label: string; tone: Tone }> = {
  DRAFT: { label: 'Draft', tone: 'warning' }, APPROVED: { label: 'Approved', tone: 'success' }, SUPERSEDED: { label: 'Superseded', tone: 'neutral' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
}
export interface BudgetSummary {
  id: string; financial_year: string; version: number; budget_name: string; status: BudgetStatus; source: string; notes: string | null; created_at: string
  approved_at: string | null; created_by_name: string | null; line_count: number; total_annual: Amount
}
export interface BudgetLine {
  id: string; line_no: number; cost_centre_id: string; cost_centre_code: string; cost_centre_name: string; account_id: string; account_code: string
  account_name: string; classification: Classification; annual_amount: Amount; months: Amount[]; notes: string | null
}
export interface Budget extends Omit<BudgetSummary, 'line_count'> {
  fy_start: string; file_name: string | null; revision_of_budget_id: string | null; revision_of_version: number | null; approved_by_name: string | null
  lines: BudgetLine[]; history: { action: string; note: string | null; at: string; by: string | null; details: Record<string, unknown> }[]
}

/** Month labels of a financial year starting in `startMonth` (1 = January). */
export function fyMonthLabels(startMonth = 4): string[] {
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return Array.from({ length: 12 }, (_, i) => names[(startMonth - 1 + i) % 12])
}

export interface BudgetImportLine { cost_centre_code: string; account_code: string; annual: string | null; months: (string | null)[]; notes: string | null }

/** Budget template: header + one example with months, one with only the annual amount (spread evenly by the database). */
export function budgetTemplate(startMonth = 4): string[][] {
  return [['Cost centre code', 'Account code', 'Annual', ...fyMonthLabels(startMonth), 'Notes'],
    ['PROD', '6500', '600000.00', ...Array.from({ length: 12 }, () => '50000.00'), 'Electricity'],
    ['ADMIN', '6200', '120000.00', ...Array.from({ length: 12 }, () => ''), 'Rent, spread evenly']]
}

/**
 * Reads budget rows from a sheet. Columns: cost centre code, account code, annual and 12 month columns (named by month or
 * M1..M12, in financial-year order). Annual blank = sum of the months; months blank = spread evenly. Checked again by the database.
 */
export function parseBudgetSheet(rows: string[][], startMonth = 4): { lines: BudgetImportLine[]; errors: string[] } {
  const norm = (s: string | undefined) => (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
  const headerIndex = rows.slice(0, 10).findIndex((r) => r.some((c) => ['cost centre code', 'cost center code', 'cost centre'].includes(norm(c))))
  if (headerIndex < 0) return { lines: [], errors: ['No header row found: the sheet needs a "Cost centre code" column (download the template).'] }
  const header = rows[headerIndex].map(norm)
  const find = (names: string[]) => header.findIndex((h) => names.includes(h))
  const ccCol = find(['cost centre code', 'cost center code', 'cost centre'])
  const accCol = find(['account code', 'ledger code', 'account'])
  const annualCol = find(['annual', 'annual budget', 'annual amount'])
  const labels = fyMonthLabels(startMonth).map((m) => m.toLowerCase())
  const monthCols = labels.map((m, i) => find([m, `m${i + 1}`, `month ${i + 1}`]))
  const notesCol = find(['notes', 'remarks', 'description'])
  if (accCol < 0) return { lines: [], errors: ['The sheet needs an "Account code" column.'] }
  const amount = /^\d+(\.\d{1,2})?$/
  const lines: BudgetImportLine[] = []
  const errors: string[] = []
  for (let i = headerIndex + 1; i < rows.length; i++) {
    const r = rows[i]
    if (r.every((c) => !(c ?? '').trim())) continue
    const cell = (k: number) => (k >= 0 ? (r[k] ?? '').trim() : '')
    // Thousands separators are removed from amounts only (never from codes or notes).
    const amt = (k: number) => cell(k).replace(/,/g, '')
    const cc = cell(ccCol).toUpperCase()
    const acc = cell(accCol).toUpperCase()
    const annual = amt(annualCol)
    const months = monthCols.map((k) => amt(k) || null)
    if (!cc || !acc) { errors.push(`Row ${i + 1}: the cost centre code and account code are required.`); continue }
    const bad = [annual, ...months].find((v) => v && !amount.test(v))
    if (bad) { errors.push(`Row ${i + 1}: "${bad}" is not an amount (digits, at most 2 decimals, no minus sign).`); continue }
    const monthTotal = months.reduce((t, v) => t + toPaise(v ?? 0), 0)
    if (!annual && months.every((m) => !m)) { errors.push(`Row ${i + 1}: enter the annual budget or the monthly budgets.`); continue }
    if (annual && months.some((m) => m) && monthTotal !== toPaise(annual)) {
      errors.push(`Row ${i + 1}: the months total ${formatAmount(monthTotal / 100)} but the annual budget is ${formatAmount(annual)}.`); continue
    }
    lines.push({ cost_centre_code: cc, account_code: acc, annual: annual || null, months, notes: cell(notesCol) || null })
  }
  if (!lines.length && !errors.length) errors.push('The sheet has no budget rows.')
  return { lines, errors }
}

export interface CostCentreSummaryRow {
  cost_centre_id: string; cost_centre_code: string; cost_centre_name: string; parent_cost_centre_id: string | null; cost_centre_type: CostCentreType; is_active: boolean
  income: Amount; expense: Amount; net: Amount; budget: Amount; actual: Amount; variance: Amount; income_budget: Amount
}
export interface CostCentreSummary { from: string; to: string; rows: CostCentreSummaryRow[]; unallocated: { income: Amount; expense: Amount; net: Amount }; company: { income: Amount; expense: Amount } }
export interface ProfitabilityRow {
  cost_centre_id: string; cost_centre_code: string; cost_centre_name: string; parent_cost_centre_id: string | null; revenue: Amount; direct_expenses: Amount
  indirect_expenses: Amount; contribution: Amount; net_contribution: Amount
}
export interface Profitability { from: string; to: string; rows: ProfitabilityRow[]; unallocated: { revenue: Amount; direct_expenses: Amount; indirect_expenses: Amount; net_contribution: Amount } }
export interface CostCentreLedgerEntry {
  voucher_id: string; voucher_number: string; voucher_date: string; voucher_type: string; status: VoucherStatus; account_id: string; account_code: string
  account_name: string; narration: string | null; debit: Amount; credit: Amount; balance: Amount
}
export interface CostCentreLedger { cost_centre: { id: string; cost_centre_code: string; cost_centre_name: string }; from: string; to: string; opening_balance: Amount; entries: CostCentreLedgerEntry[]; closing_balance: Amount }
export interface BudgetVsActualRow {
  cost_centre_id: string; cost_centre_code: string; cost_centre_name: string; account_id: string; account_code: string; account_name: string; classification: Classification
  annual_budget: Amount; monthly_budget: Amount; period_budget: Amount; actual: Amount; remaining: Amount; variance: Amount; variance_percent: Amount | null
}
export interface BudgetVsActual {
  financial_year: string; from: string; to: string; upto_month: number; budget: { id: string; version: number; budget_name: string; approved_at: string } | null; rows: BudgetVsActualRow[]
}
