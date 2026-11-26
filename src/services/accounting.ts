import type {
  Account, AccountingDashboard, Budget, BudgetImportLine, BudgetSummary, BudgetVsActual, CostCentreLedger, CostCentrePolicy, CostCentreSummary, Profitability, AccountingStatus, Chart, CostCentre, DayBook, GeneralLedger, OpeningBatch, OpeningBatchSummary, OpeningImportLine,
  Party, Period, PostingEvents, PostingRule, PostingRunResult, TrialBalance, ValidationIssue, Voucher, VoucherListRow,
} from '@/features/accounting/accounting-model'
import type {
  BankLookups, BankReportKey, BankReportRow, Book, Brs, ImportReportRow, ImportResult, MoneyAccount, MoneyKind, PaymentCandidate, PaymentPolicy, StatementImport, Suggestion,
  Transfer, Workspace,
} from '@/features/accounting/bank-cash-model'
import type { MatchingCandidate, PiListRow, PiLookups, PiReport, PiReportKey, PurchaseInvoice, SupplierPaymentOption } from '@/features/accounting/purchase-invoice-model'
import type {
  Gstr2bDocument, Gstr2bImport, Gstr2bImportDetail, Gstr2bMatch, Gstr2bReportKey, Gstr2bReportRow, ItcView,
} from '@/features/accounting/gstr2b-model'
import type { FilingRecord, GstPeriod, Gstr1, Gstr3b, ReturnException } from '@/features/accounting/gst-returns-model'
import type { Control, ControlReport, Lifecycle, ReportKey } from '@/features/accounting/gst-reports-model'
import { requireSupabase } from '@/lib/supabase'

/**
 * Alton Accounts data access. Every call is a permission-checked SECURITY DEFINER database function
 * (migrations 20261231090000 / 20261231090100); accounting tables are never read or written directly.
 */
async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await (requireSupabase().rpc as unknown as (f: string, a: Record<string, unknown>) => Promise<{ data: T; error: unknown }>)(fn, args)
  if (error) throw error
  return data
}

// ---- set-up, settings, periods ----------------------------------------------------------------------------------
export const fetchAccountingStatus = () => rpc<AccountingStatus>('accounting_status')
export const initializeAccounting = (booksStartDate: string, fyStartMonth: number) =>
  rpc<AccountingStatus>('accounting_initialize', { p_books_start_date: booksStartDate, p_fy_start_month: fyStartMonth })
export const saveAccountingSettings = (settings: Record<string, unknown>) => rpc<AccountingStatus>('accounting_settings_save', { p_settings: settings })
export const fetchPeriods = (financialYear: string | null = null) => rpc<Period[]>('accounting_periods', { p_financial_year: financialYear })
export const generatePeriods = (anyDate: string) => rpc<{ financial_year: string; periods_created: number }>('accounting_period_generate', { p_any_date: anyDate })
export const setPeriodStatus = (periodId: string, status: 'CLOSED' | 'REOPENED', reason: string | null) =>
  rpc<{ id: string; status: string }>('accounting_period_set_status', { p_period_id: periodId, p_status: status, p_reason: reason })

// ---- chart of accounts ------------------------------------------------------------------------------------------
export const fetchChart = () => rpc<Chart>('accounting_chart')
export const fetchAccounts = (search: string | null = null, includeInactive = false) =>
  rpc<Account[]>('accounting_accounts', { p_search: search, p_include_inactive: includeInactive })
export const saveGroup = (groupId: string | null, group: Record<string, unknown>) => rpc<{ id: string }>('accounting_group_save', { p_group_id: groupId, p_group: group })
export const saveAccount = (accountId: string | null, account: Record<string, unknown>) =>
  rpc<{ id: string }>('accounting_account_save', { p_account_id: accountId, p_account: account })
export const setAccountActive = (accountId: string, active: boolean) => rpc<{ id: string; is_active: boolean }>('accounting_account_set_active', { p_account_id: accountId, p_active: active })
export const fetchAccountingParties = (search: string | null = null, type: 'CUSTOMER' | 'SUPPLIER' | null = null) =>
  rpc<Party[]>('accounting_parties', { p_search: search, p_type: type })
export const fetchCostCentres = () => rpc<CostCentre[]>('accounting_cost_centres')
export const saveCostCentre = (id: string | null, cc: Record<string, unknown>) => rpc<{ id: string }>('accounting_cost_centre_save', { p_cost_centre_id: id, p_cost_centre: cc })

// ---- posting rules and automatic posting -------------------------------------------------------------------------
export const fetchPostingRules = () => rpc<PostingRule[]>('accounting_posting_rules')
export const savePostingRule = (ruleKey: string, matchValue: string, accountId: string | null) =>
  rpc<{ rule_key: string }>('accounting_posting_rule_save', { p_rule_key: ruleKey, p_match_value: matchValue, p_account_id: accountId })
export const fetchPostingEvents = (filters: { status?: string | null; source_type?: string | null; search?: string | null; limit?: number }) =>
  rpc<PostingEvents>('accounting_posting_events', { p_filters: filters })
export const runPosting = (limit = 200) => rpc<PostingRunResult>('accounting_posting_run', { p_limit: limit })
export const retryPostingEvent = (eventId: string) => rpc<{ status: string; error_message: string | null }>('accounting_posting_retry', { p_event_id: eventId })
export const dismissPostingEvent = (eventId: string, reason: string) => rpc<{ status: string }>('accounting_posting_dismiss', { p_event_id: eventId, p_reason: reason })

// ---- vouchers ----------------------------------------------------------------------------------------------------
export interface VoucherFilters {
  from?: string | null; to?: string | null; status?: string | null; voucher_type?: string | null; source?: string | null
  search?: string | null; account_id?: string | null; created_by?: string | null; cost_centre_id?: string | null; limit?: number; offset?: number
}
export const fetchVouchers = (filters: VoucherFilters) => rpc<{ total: number; rows: VoucherListRow[] }>('accounting_voucher_list', { p_filters: filters })
export const fetchVoucher = (voucherId: string) => rpc<Voucher>('accounting_voucher_get', { p_voucher_id: voucherId })
export const postVoucher = (voucherId: string, rowVersion: number | null) => rpc<Voucher>('accounting_voucher_post', { p_voucher_id: voucherId, p_row_version: rowVersion })
export const discardVoucher = (voucherId: string, reason: string) => rpc<Voucher>('accounting_voucher_discard', { p_voucher_id: voucherId, p_reason: reason })
export const reverseVoucher = (voucherId: string, reason: string, reversalDate: string | null) =>
  rpc<{ original: Voucher; reversal: Voucher }>('accounting_voucher_reverse', { p_voucher_id: voucherId, p_reason: reason, p_reversal_date: reversalDate })

// ---- reports -----------------------------------------------------------------------------------------------------
export const fetchAccountingDashboard = () => rpc<AccountingDashboard>('accounting_dashboard')
export const fetchTrialBalance = (from: string, to: string, includeZero: boolean) =>
  rpc<TrialBalance>('accounting_trial_balance', { p_from: from, p_to: to, p_include_zero: includeZero })
export const fetchGeneralLedger = (accountId: string, from: string, to: string, partyId: string | null, costCentreId: string | null = null) =>
  rpc<GeneralLedger>('accounting_general_ledger', { p_account_id: accountId, p_from: from, p_to: to, p_party_id: partyId, p_cost_centre_id: costCentreId })
export const fetchDayBook = (from: string, to: string, voucherType: string | null, costCentreId: string | null = null) =>
  rpc<DayBook>('accounting_day_book', { p_from: from, p_to: to, p_voucher_type: voucherType, p_cost_centre_id: costCentreId })

// ---- opening balances --------------------------------------------------------------------------------------------
export const fetchOpeningBatches = () => rpc<OpeningBatchSummary[]>('accounting_opening_batches')
export const fetchOpeningBatch = (batchId: string) => rpc<OpeningBatch>('accounting_opening_batch_get', { p_batch_id: batchId })
export const createOpeningBatch = (notes: string | null) => rpc<OpeningBatch>('accounting_opening_batch_create', { p_notes: notes })
export const replaceOpeningLines = (batchId: string, lines: (OpeningImportLine | Record<string, unknown>)[], source: 'MANUAL' | 'IMPORT', fileName: string | null) =>
  rpc<OpeningBatch>('accounting_opening_lines_replace', { p_batch_id: batchId, p_lines: lines, p_source: source, p_file_name: fileName })
export const prefillOpeningParties = (batchId: string) => rpc<OpeningBatch & { lines_added: number }>('accounting_opening_prefill_parties', { p_batch_id: batchId })
export const approveOpeningBatch = (batchId: string, acknowledgements: { code: string; reason: string }[]) =>
  rpc<OpeningBatch>('accounting_opening_approve', { p_batch_id: batchId, p_acknowledgements: acknowledgements })
export const reopenOpeningBatch = (batchId: string, reason: string) => rpc<OpeningBatch>('accounting_opening_reopen', { p_batch_id: batchId, p_reason: reason })
export const discardOpeningBatch = (batchId: string, reason: string) => rpc<OpeningBatch>('accounting_opening_discard', { p_batch_id: batchId, p_reason: reason })
export const postOpeningBatch = (batchId: string) => rpc<OpeningBatch>('accounting_opening_post', { p_batch_id: batchId })

// ---- manual journal vouchers (Phase 1: the Phase 0 voucher RPCs) -------------------------------------------------
export const createVoucher = (voucher: Record<string, unknown>) => rpc<Voucher>('accounting_voucher_create', { p_voucher: voucher })
export const updateVoucher = (voucherId: string, voucher: Record<string, unknown>, rowVersion: number | null) =>
  rpc<Voucher>('accounting_voucher_update', { p_voucher_id: voucherId, p_voucher: voucher, p_row_version: rowVersion })
export const validateVoucher = (voucherId: string) =>
  rpc<{ voucher_id: string; valid: boolean; issues: ValidationIssue[]; total_debit: number; total_credit: number; difference: number }>('accounting_voucher_validate', { p_voucher_id: voucherId })

// ---- Phase 2: cost centres, allocation rules, budgets and reports (migration 20261231090200) -----------------------
export const deleteCostCentre = (id: string) => rpc<{ deleted: string }>('accounting_cost_centre_delete', { p_cost_centre_id: id })
export const setCostCentrePolicy = (accountId: string, policy: CostCentrePolicy) =>
  rpc<{ id: string; cost_centre_policy: CostCentrePolicy }>('accounting_account_set_cost_centre_policy', { p_account_id: accountId, p_policy: policy })
export const fetchCostCentreSummary = (from: string, to: string) => rpc<CostCentreSummary>('accounting_cost_centre_summary', { p_from: from, p_to: to })
export const fetchCostCentreProfitability = (from: string, to: string) => rpc<Profitability>('accounting_cost_centre_profitability', { p_from: from, p_to: to })
export const fetchCostCentreLedger = (costCentreId: string, from: string, to: string, accountId: string | null) =>
  rpc<CostCentreLedger>('accounting_cost_centre_ledger', { p_cost_centre_id: costCentreId, p_from: from, p_to: to, p_account_id: accountId })
export const fetchBudgetVsActual = (financialYear: string, uptoMonth: number | null, costCentreId: string | null, accountId: string | null) =>
  rpc<BudgetVsActual>('accounting_budget_vs_actual', { p_financial_year: financialYear, p_upto_month: uptoMonth, p_cost_centre_id: costCentreId, p_account_id: accountId })
export const fetchBudgets = (financialYear: string | null = null) => rpc<BudgetSummary[]>('accounting_budgets', { p_financial_year: financialYear })
export const fetchBudget = (id: string) => rpc<Budget>('accounting_budget_get', { p_budget_id: id })
export const createBudget = (anyDate: string, name: string, notes: string | null) => rpc<Budget>('accounting_budget_create', { p_any_date: anyDate, p_name: name, p_notes: notes })
export const replaceBudgetLines = (id: string, lines: (BudgetImportLine | Record<string, unknown>)[], source: 'MANUAL' | 'IMPORT', fileName: string | null) =>
  rpc<Budget>('accounting_budget_lines_replace', { p_budget_id: id, p_lines: lines, p_source: source, p_file_name: fileName })
export const approveBudget = (id: string, note: string | null) => rpc<Budget>('accounting_budget_approve', { p_budget_id: id, p_note: note })
export const reviseBudget = (id: string, note: string) => rpc<Budget>('accounting_budget_revise', { p_budget_id: id, p_note: note })
export const cancelBudget = (id: string, reason: string) => rpc<Budget>('accounting_budget_cancel', { p_budget_id: id, p_reason: reason })

// ---- supplier (purchase) invoices (migration 20261231090300) ---------------------------------------------------------
export const fetchPiLookups = () => rpc<PiLookups>('purchase_invoice_lookups')
export const fetchPurchaseInvoices = (filters: { from?: string | null; to?: string | null; status?: string | null; supplier_id?: string | null; search?: string | null; outstanding_only?: boolean }) =>
  rpc<PiListRow[]>('purchase_invoice_list', { p_filters: filters })
export const fetchPurchaseInvoice = (id: string) => rpc<PurchaseInvoice>('purchase_invoice_get', { p_invoice_id: id })
export const savePurchaseInvoice = (id: string | null, invoice: Record<string, unknown>, rowVersion: number | null) =>
  rpc<PurchaseInvoice>('purchase_invoice_save', { p_invoice_id: id, p_invoice: invoice, p_row_version: rowVersion })
export const submitPurchaseInvoice = (id: string) => rpc<PurchaseInvoice>('purchase_invoice_submit', { p_invoice_id: id })
export const approvePurchaseInvoice = (id: string, note: string | null, acceptVariances: boolean) =>
  rpc<PurchaseInvoice>('purchase_invoice_approve', { p_invoice_id: id, p_note: note, p_accept_variances: acceptVariances })
export const returnPurchaseInvoice = (id: string, reason: string) => rpc<PurchaseInvoice>('purchase_invoice_return_to_draft', { p_invoice_id: id, p_reason: reason })
export const cancelPurchaseInvoice = (id: string, reason: string) => rpc<PurchaseInvoice>('purchase_invoice_cancel', { p_invoice_id: id, p_reason: reason })
export const postPurchaseInvoice = (id: string) => rpc<PurchaseInvoice>('purchase_invoice_post', { p_invoice_id: id })
export const verifyPurchaseInvoiceGst = (id: string, status: 'ELIGIBLE' | 'INELIGIBLE', reason: string, checks: Record<string, boolean>) =>
  rpc<PurchaseInvoice>('purchase_invoice_verify_gst', { p_invoice_id: id, p_status: status, p_reason: reason, p_checks: checks })
export const reversePurchaseInvoice = (id: string, reason: string) => rpc<PurchaseInvoice>('purchase_invoice_reverse', { p_invoice_id: id, p_reason: reason })
export const allocateSupplierPayment = (invoiceId: string, paymentId: string, amount: string) =>
  rpc<PurchaseInvoice>('purchase_invoice_allocate_payment', { p_invoice_id: invoiceId, p_payment_id: paymentId, p_amount: amount })
export const unallocateSupplierPayment = (allocationId: string, reason: string) =>
  rpc<PurchaseInvoice>('purchase_invoice_unallocate_payment', { p_allocation_id: allocationId, p_reason: reason })
export const fetchMatchingCandidates = (supplierId: string, purchaseOrderId: string | null, includeDone: boolean) =>
  rpc<MatchingCandidate[]>('purchase_invoice_matching_candidates', { p_supplier_id: supplierId, p_purchase_order_id: purchaseOrderId, p_include_done: includeDone })
export const fetchSupplierPaymentOptions = (supplierId: string) => rpc<SupplierPaymentOption[]>('purchase_invoice_supplier_payments', { p_supplier_id: supplierId })
export const savePiTolerances = (settings: { pi_price_tolerance_percent?: string; pi_amount_tolerance?: string }) =>
  rpc<{ pi_price_tolerance_percent: number; pi_amount_tolerance: number }>('purchase_invoice_settings_save', { p_settings: settings })
export const fetchPiReport = (report: PiReportKey, filters: { from?: string | null; to?: string | null; as_of?: string | null; supplier_id?: string | null }) =>
  rpc<PiReport>('purchase_invoice_report', { p_report: report, p_filters: filters })

// ---- bank & cash (migration 20261231090400) ------------------------------------------------------------------------------
export const fetchBankLookups = () => rpc<BankLookups>('bank_lookups')
export const fetchMoneyAccounts = (kind: MoneyKind | null = null, includeInactive = false) =>
  rpc<MoneyAccount[]>('bank_cash_account_list', { p_kind: kind, p_include_inactive: includeInactive })
export const saveMoneyAccount = (id: string | null, account: Record<string, unknown>, rowVersion: number | null) =>
  rpc<MoneyAccount>('bank_cash_account_save', { p_id: id, p_account: account, p_row_version: rowVersion })
export const setMoneyAccountActive = (id: string, active: boolean, reason: string) => rpc<MoneyAccount>('bank_cash_account_set_active', { p_id: id, p_active: active, p_reason: reason })
export const revealBankAccountNumber = (id: string) => rpc<string>('bank_account_reveal_number', { p_id: id })
export const fetchPaymentPolicies = () => rpc<PaymentPolicy[]>('bank_payment_policies')
export const savePaymentPolicy = (direction: 'RECEIPT' | 'PAYMENT', method: string, requireSelection: boolean) =>
  rpc<PaymentPolicy>('bank_payment_policy_save', { p_direction: direction, p_method: method, p_require_selection: requireSelection })
export const fetchPaymentCandidates = (filters: { state?: string | null; from?: string | null; to?: string | null }) =>
  rpc<PaymentCandidate[]>('bank_payment_candidates', { p_filters: filters })
export const assignPaymentAccount = (sourceType: 'CUSTOMER_RECEIPT' | 'SUPPLIER_PAYMENT', sourceId: string, accountId: string, reason: string) =>
  rpc<{ assignment_id: string }>('bank_payment_assign', { p_source_type: sourceType, p_source_id: sourceId, p_account_id: accountId, p_reason: reason })
export const fetchMoneyBook = (accountId: string, from: string, to: string, filters: Record<string, string | null> = {}) =>
  rpc<Book>('bank_cash_book', { p_account_id: accountId, p_from: from, p_to: to, p_filters: filters })
export const fetchTransfers = (filters: { from?: string | null; to?: string | null; status?: string | null; account_id?: string | null }) =>
  rpc<Transfer[]>('bank_transfer_list', { p_filters: filters })
export const saveTransfer = (id: string | null, transfer: Record<string, unknown>, rowVersion: number | null) =>
  rpc<Transfer>('bank_transfer_save', { p_id: id, p_transfer: transfer, p_row_version: rowVersion })
export const postTransfer = (id: string) => rpc<Transfer>('bank_transfer_post', { p_id: id })
export const cancelTransfer = (id: string, reason: string) => rpc<Transfer>('bank_transfer_cancel', { p_id: id, p_reason: reason })
export const reverseTransfer = (id: string, reason: string) => rpc<Transfer>('bank_transfer_reverse', { p_id: id, p_reason: reason })
export const importBankStatement = (accountId: string, file: { name: string; mime: string; content_base64: string }, mapping: Record<string, unknown>,
  rows: unknown[], commit: boolean) => rpc<ImportResult>('bank_statement_import', { p_account_id: accountId, p_file: file, p_mapping: mapping, p_rows: rows, p_commit: commit })
export const fetchStatementImports = (accountId: string | null = null) => rpc<StatementImport[]>('bank_statement_imports_list', { p_account_id: accountId })
export const fetchStatementImport = (id: string) => rpc<StatementImport & { report: ImportReportRow[] }>('bank_statement_import_get', { p_import_id: id })
export const downloadStatementFile = (id: string) =>
  rpc<{ file_name: string; mime_type: string | null; content_base64: string }>('bank_statement_file', { p_import_id: id })
export const fetchReconWorkspace = (accountId: string, from: string | null, to: string | null, includeMatched: boolean) =>
  rpc<Workspace>('bank_reconciliation_workspace', { p_account_id: accountId, p_from: from, p_to: to, p_include_matched: includeMatched })
export const fetchReconSuggestions = (accountId: string, toleranceDays: number) =>
  rpc<Suggestion[]>('bank_reconciliation_suggestions', { p_account_id: accountId, p_tolerance_days: toleranceDays })
export const reconMatch = (accountId: string, items: { statement_line_id?: string; voucher_line_id?: string; amount?: string }[], reason: string) =>
  rpc<{ match_id: string }>('bank_reconciliation_match', { p_account_id: accountId, p_items: items, p_reason: reason })
export const reconAutoMatch = (accountId: string, toleranceDays: number) => rpc<{ matched: number }>('bank_reconciliation_auto_match', { p_account_id: accountId, p_tolerance_days: toleranceDays })
export const reconUnmatch = (matchId: string, reason: string) => rpc<{ match_id: string }>('bank_reconciliation_unmatch', { p_match_id: matchId, p_reason: reason })
export const fetchAdjustmentProposal = (lineId: string) =>
  rpc<{ direction: 'WITHDRAWAL' | 'DEPOSIT'; proposal: string; suggested_category: string; possible_duplicates: { line_id: string; voucher_number: string; date: string; narration: string | null }[];
    accounts: { id: string; account_code: string; account_name: string; cost_centre_policy: string }[] }>('bank_statement_adjustment_proposal', { p_line_id: lineId })
export const postStatementAdjustment = (lineId: string, accountId: string, narration: string, duplicateReason: string | null) =>
  rpc<{ voucher_number: string }>('bank_statement_adjust', { p_line_id: lineId, p_account_id: accountId, p_narration: narration, p_allocations: null, p_duplicate_reason: duplicateReason })
export const fetchBrs = (accountId: string, asOf: string, statementBalance: string | null) =>
  rpc<Brs>('bank_reconciliation_statement', { p_account_id: accountId, p_as_of: asOf, p_statement_balance: statementBalance })
export const saveReconciliation = (accountId: string, asOf: string, statementBalance: string | null, acceptReason: string | null) =>
  rpc<Brs & { id: string; status: string }>('bank_reconciliation_save', { p_account_id: accountId, p_as_of: asOf, p_statement_balance: statementBalance, p_accept_reason: acceptReason })
export const fetchReconHistory = (accountId: string | null = null) =>
  rpc<{ id: string; as_of_date: string; account_code: string; status: string; difference: number; difference_reason: string | null; created_at: string; created_by_name: string | null;
    ledger_balance: number; statement_balance: number }[]>('bank_reconciliation_history', { p_account_id: accountId })
export const fetchBankReport = (report: BankReportKey, filters: Record<string, string | null>) =>
  rpc<{ report: BankReportKey; rows: BankReportRow[] }>('bank_report', { p_report: report, p_filters: filters })

// ---- GST: ITC decisions and GSTR-2B reconciliation (migrations 20261231090500 / 20261231090600) ----------------------
// Uploading the original file and the server-side checksum verification are in services/gstr2b-files.ts.
export const fetchItc = (invoiceId: string) => rpc<ItcView>('gst_itc_get', { p_invoice_id: invoiceId })
export const itcAction = (invoiceId: string, action: 'APPROVE' | 'REJECT', body: { reason?: string } = {}) =>
  rpc<ItcView>('gst_itc_action', { p_invoice_id: invoiceId, p_action: action, p: body })
export const prepareGstr2bUpload = (body: { file_name: string; mime_type: string; file_size: number; sha256: string; return_period: string }) =>
  rpc<Gstr2bImport>('gst_2b_upload_prepare', { p: body })
export const completeGstr2bUpload = (importId: string) => rpc<Gstr2bImport>('gst_2b_upload_complete', { p_import_id: importId })
export const fetchGstr2bImports = (filters: { status?: string | null; return_period?: string | null } = {}) => rpc<Gstr2bImport[]>('gst_2b_imports_list', { p_filters: filters })
export const fetchGstr2bImport = (importId: string, filters: { row_status?: string | null; offset?: number; limit?: number } = {}) =>
  rpc<Gstr2bImportDetail>('gst_2b_import_get', { p_import_id: importId, p_filters: filters })
export const commitGstr2bImport = (importId: string, acceptErrors: boolean, rowVersion: number | null) =>
  rpc<Gstr2bImport>('gst_2b_import_commit', { p_import_id: importId, p_accept_errors: acceptErrors, p_row_version: rowVersion })
export const discardGstr2bImport = (importId: string, reason: string) => rpc<Gstr2bImport>('gst_2b_import_discard', { p_import_id: importId, p_reason: reason })
export const autoMatchGstr2b = (importId: string | null = null) =>
  rpc<{ proposed: number; ambiguous: number; no_candidate: number; by_outcome: Record<string, number>; note: string }>('gst_2b_auto_match', { p: importId ? { import_id: importId } : {} })
export const matchGstr2bManually = (documentId: string, purchaseInvoiceId: string, reason: string) =>
  rpc<Gstr2bMatch>('gst_2b_match_manual', { p: { document_id: documentId, purchase_invoice_id: purchaseInvoiceId, reason } })
export const decideGstr2bMatch = (matchId: string, action: 'APPROVE' | 'REJECT', note: string | null) =>
  rpc<Gstr2bMatch>('gst_2b_match_decide', { p_match_id: matchId, p_action: action, p_note: note })
export const reverseGstr2bMatch = (matchId: string, reason: string) => rpc<Gstr2bMatch>('gst_2b_match_reverse', { p_match_id: matchId, p_reason: reason })
export const fetchGstr2bMatch = (matchId: string) => rpc<Gstr2bMatch>('gst_2b_match_get', { p_match_id: matchId })
export const fetchGstr2bDocument = (documentId: string) => rpc<Gstr2bDocument>('gst_2b_document_get', { p_document_id: documentId })
export const fetchGstr2bReport = (report: Gstr2bReportKey, filters: Record<string, string | null> = {}) =>
  rpc<{ report: Gstr2bReportKey; rows?: Gstr2bReportRow[] } & Record<string, unknown>>('gst_2b_report', { p_report: report, p_filters: filters })
export const gstr2bFileAccess = (importId: string) =>
  rpc<{ bucket: string; storage_path: string; file_name: string; expires_at: string; declared_sha256: string; computed_sha256: string | null }>('gst_2b_file_access', { p_import_id: importId })

// ---- GST return preparation (migration 20261231090700): working data only — nothing is filed or posted ------------------
export const fetchGstPeriods = (financialYear: string | null = null) => rpc<GstPeriod[]>('gst_periods_list', { p_financial_year: financialYear })
export const createGstPeriod = (periodStart: string) => rpc<GstPeriod>('gst_period_create', { p_period_start: periodStart })
export const transitionGstPeriod = (periodId: string, action: 'START_REVIEW' | 'READY' | 'RETURN' | 'APPROVE' | 'CLOSE' | 'REOPEN', reason: string | null = null) =>
  rpc<GstPeriod>('gst_period_transition', { p_period_id: periodId, p_action: action, p_reason: reason })
export const fetchGstr1 = (periodId: string) => rpc<Gstr1>('gst_return_get', { p_period_id: periodId, p_return_type: 'GSTR1' })
export const fetchGstr3b = (periodId: string) => rpc<Gstr3b>('gst_return_get', { p_period_id: periodId, p_return_type: 'GSTR3B' })
export const fetchGstRegister = (register: 'SALES' | 'PURCHASE' | 'RCM', filters: { period_id?: string; from?: string; to?: string }) =>
  rpc<{ register: string; from: string; to: string; rows: Record<string, unknown>[]; totals: Record<string, number>; note: string }>('gst_register', { p_register: register, p_filters: filters })
export const fetchGstReconciliation = (periodId: string) => rpc<Record<string, unknown> & { tax_heads: Record<string, unknown>[]; unexplained_vouchers: Record<string, unknown>[] }>(
  'gst_reconciliation_get', { p_period_id: periodId })
export const fetchGstExceptions = (periodId: string) => rpc<{ period: string; rows: ReturnException[] }>('gst_return_exceptions', { p_period_id: periodId })
export const fetchGstDashboard = () => rpc<Record<string, unknown> & { periods: Record<string, unknown>[] }>('gst_dashboard')
export const fetchGstPayments = (periodId: string | null = null) =>
  rpc<{ challans: Record<string, unknown>[]; set_offs: Record<string, unknown>[]; cash_ledger: number }>('gst_payments_view', { p_filters: periodId ? { period_id: periodId } : {} })
export const recordGstFiling = (periodId: string, returnType: 'GSTR1' | 'GSTR3B', arn: string, filedOn: string, note: string | null) =>
  rpc<FilingRecord>('gst_return_filing', { p_action: 'RECORD', p_id: null, p: { period_id: periodId, return_type: returnType, arn, filed_on: filedOn, note } })
export const voidGstFiling = (filingId: string, reason: string) => rpc<FilingRecord>('gst_return_filing', { p_action: 'VOID', p_id: filingId, p: { reason } })

// ---- GST period close and control reports (migration 20261231090800): read only; CLOSE / REOPEN go through gst_period_transition ------
export interface GstReadiness { period_id: string; period_code: string; lifecycle: Lifecycle; controls: Control[]; blockers_failed: number; warnings_open: number; can_close: boolean; note: string }
export const fetchGstReadiness = (periodId: string) => rpc<GstReadiness>('gst_period_readiness', { p_period_id: periodId })
export const fetchGstControlReport = (report: ReportKey, filters: { period_id?: string; from?: string; to?: string }) =>
  rpc<ControlReport>('gst_control_report', { p_report: report, p_filters: filters })
