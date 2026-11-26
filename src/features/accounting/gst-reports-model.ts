// GST period close and the ten control reports (migration 20261231090800): report → tables, the period lifecycle, and the working-file
// builders (Excel with named sheets and INR number formats, CSV, print header). Pure and unit-tested; nothing here changes any record.
// Exports are working documents: never proof of filing.

export const GST_DISCLAIMER = 'Prepared by Alton ERP for review and working purposes. This document is not proof of filing with the GST Portal. The taxpayer must independently verify and file the return on the official GST Portal.'

export type ReportKey = 'TAX_LIABILITY' | 'ITC' | 'GSTR2B' | 'RCM' | 'CASH_LEDGER' | 'CREDIT_LEDGER' | 'VOUCHERS' | 'COMPLETENESS' | 'GSTR1_VS_GSTR3B' | 'PERIOD_AUDIT'
export const REPORTS: { key: ReportKey; no: number; label: string; sources: string; periodOnly?: boolean; paymentPermission?: boolean }[] = [
  { key: 'TAX_LIABILITY', no: 1, label: 'GST tax liability reconciliation', sources: 'Issued invoices and notes, output GST ledgers, GSTR-1 and GSTR-3B working, approved adjustments, approved snapshot.' },
  { key: 'ITC', no: 2, label: 'Input tax credit reconciliation', sources: 'Posted supplier invoices, ITC decision history and adjustments, input / pending / ineligible GST ledgers, GSTR-3B section 4.' },
  { key: 'GSTR2B', no: 3, label: 'GSTR-2B reconciliation', sources: 'GSTR-2B documents, versions, matches (with the versioned tolerance), imports and posted supplier invoices.' },
  { key: 'RCM', no: 4, label: 'Reverse charge reconciliation', sources: 'Posted reverse-charge supplier invoices, RCM payable ledger, RCM set-off lines, ITC decisions.' },
  { key: 'CASH_LEDGER', no: 5, label: 'GST cash ledger reconciliation', sources: 'Challans, payment attempts (only successful posted ones counted), bank voucher lines, electronic cash ledger.', paymentPermission: true },
  { key: 'CREDIT_LEDGER', no: 6, label: 'GST credit ledger reconciliation', sources: 'Input GST ledgers, ITC events, posted credit set-offs, period-end credit position.' },
  { key: 'VOUCHERS', no: 7, label: 'GST voucher reconciliation', sources: 'Vouchers on GST ledgers, their source documents, posting events and reversal links.' },
  { key: 'COMPLETENESS', no: 8, label: 'Document completeness and exceptions', sources: 'Return exceptions of the period and unresolved GSTR-2B supplier notes.' },
  { key: 'GSTR1_VS_GSTR3B', no: 9, label: 'GSTR-1 vs GSTR-3B reconciliation', sources: 'GSTR-1 and GSTR-3B working (calculated and adjusted) and the approved snapshot.' },
  { key: 'PERIOD_AUDIT', no: 10, label: 'GST period close and audit', sources: 'Period, snapshots and hashes, period history, adjustments, filing records, set-offs, close controls, exceptions, late documents.', periodOnly: true },
]

export type ColKind = 'text' | 'amount' | 'number' | 'date' | 'bool' | 'json'
export interface Column { key: string; label: string; kind?: ColKind }
export interface ReportTable { title: string; columns: Column[]; rows: Record<string, unknown>[] }
export interface ReportHeader {
  report: ReportKey
  company: { legal_name: string; display_name: string } | null
  gstin: string
  period_code: string
  from: string
  to: string
  financial_year: string
  period_status: string
  config_version_no: number | null
  snapshot: { id: string; version_no: number; snapshot_hash: string; created_at: string } | null
  filings: { return_type: string; arn: string; filed_on: string }[]
  value_status: 'CALCULATED' | 'ADJUSTED' | 'APPROVED' | 'FILED'
  generated_at: string
  disclaimer: string
}
export type ControlReport = ReportHeader & Record<string, unknown>

const t = (title: string, columns: [string, string, ColKind?][], rows: unknown): ReportTable => ({
  title, columns: columns.map(([key, label, kind]) => ({ key, label, kind: kind ?? 'text' })), rows: Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [] })
const kv = (title: string, obj: Record<string, unknown> | undefined | null): ReportTable =>
  t(title, [['item', 'Item'], ['value', 'Value', 'amount']], Object.entries(obj ?? {}).map(([item, value]) => ({ item: item.replace(/_/g, ' '), value })))
const counts = (title: string, obj: Record<string, unknown> | undefined | null): ReportTable =>
  t(title, [['item', 'Category'], ['value', 'Count', 'number']], Object.entries(obj ?? {}).map(([item, value]) => ({ item: item.replace(/_/g, ' ').toLowerCase(), value })))

/** The tables of a report, in display / sheet order. */
export function reportTables(r: ControlReport): ReportTable[] {
  const x = r as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
  switch (r.report) {
    case 'TAX_LIABILITY':
      return [t('Tax heads', [['head', 'Head'], ['documents', 'Documents', 'amount'], ['ledger', 'Output ledger', 'amount'], ['ledger_minus_documents', 'Ledger − documents', 'amount'],
        ['gstr1_calculated', 'GSTR-1 calculated', 'amount'], ['gstr1_adjusted', 'GSTR-1 adjusted', 'amount'], ['gstr3b_calculated', 'GSTR-3B calculated', 'amount'],
        ['gstr3b_adjusted', 'GSTR-3B adjusted', 'amount'], ['approved_adjustments_gstr3b', 'Approved 3B adjustments', 'amount'], ['gstr3b_minus_gstr1', 'GSTR-3B − GSTR-1', 'amount'],
        ['gstr3b_rcm', 'Reverse charge 3.1(d)', 'amount'], ['snapshot_gstr3b', 'Approved snapshot 3B', 'amount'], ['snapshot_minus_live_gstr3b', 'Snapshot − live', 'amount']], x.rows),
      t('Unexplained vouchers', [['voucher_number', 'Voucher'], ['date', 'Date', 'date'], ['source', 'Source'], ['account', 'Account'], ['debit', 'Debit', 'amount'], ['credit', 'Credit', 'amount']], x.unexplained_vouchers)]
    case 'ITC':
      return [t('Tax heads', [['head', 'Head'], ['itc_per_decisions', 'ITC per decisions', 'amount'], ['input_ledger', 'Input ledger', 'amount'], ['difference', 'Difference', 'amount'],
        ['gstr3b_4a', 'GSTR-3B 4(A)', 'amount'], ['gstr3b_4b', 'GSTR-3B 4(B)', 'amount'], ['gstr3b_net', 'GSTR-3B net ITC', 'amount']], x.heads),
      t('Invoices by ITC status', [['status', 'Status'], ['invoices', 'Invoices', 'number'], ['igst', 'IGST', 'amount'], ['cgst', 'CGST', 'amount'], ['sgst', 'SGST', 'amount'], ['cess', 'Cess', 'amount']], x.invoices_by_status),
      t('ITC events', [['event', 'Event'], ['count', 'Count', 'number'], ['igst', 'IGST', 'amount'], ['cgst', 'CGST', 'amount'], ['sgst', 'SGST', 'amount'], ['cess', 'Cess', 'amount'], ['ineligible', 'Ineligible', 'amount']], x.events),
      kv('GST pending verification ledger', x.pending_verification_ledger), kv('Ineligible ITC ledger', x.ineligible_ledger)]
    case 'GSTR2B':
      return [counts('Summary', x.summary),
        t('Documents', [['doc_number', 'Document'], ['supplier_gstin', 'Supplier GSTIN'], ['doc_type', 'Type'], ['doc_date', 'Date', 'date'], ['return_period', 'GSTR-2B'], ['version_no', 'Version', 'number'],
          ['category', 'Category'], ['outcome', 'Outcome'], ['exact', 'Exact', 'bool'], ['tolerance', 'Tolerance applied', 'amount'], ['config_version_no', 'Config version', 'number'],
          ['match_status', 'Match'], ['invoice_number', 'Invoice'], ['taxable_value', 'Taxable', 'amount'], ['igst', 'IGST', 'amount'], ['cgst', 'CGST', 'amount'], ['sgst', 'SGST', 'amount']], x.documents),
        t('Reversed / rejected matches', [['doc_number', 'Document'], ['invoice_number', 'Invoice'], ['outcome', 'Outcome'], ['tolerance', 'Tolerance', 'amount'], ['config_version_no', 'Config version', 'number'],
          ['reason', 'Reason']], x.reversed_matches),
        t('Amendments', [['doc_number', 'Document'], ['versions', 'Versions', 'number'], ['needs_review', 'Needs review', 'bool']], x.amendments),
        t('Duplicates', [['file_name', 'File'], ['return_period', 'GSTR-2B'], ['line_no', 'Row', 'number'], ['doc_number', 'Document'], ['kind', 'Kind']], x.duplicates),
        t('Missing in GSTR-2B', [['invoice_number', 'Invoice'], ['supplier_gstin', 'Supplier GSTIN'], ['supplier_invoice_number', 'Supplier invoice'], ['supplier_invoice_date', 'Date', 'date'], ['tax', 'Tax', 'amount']], x.missing_in_2b)]
    case 'RCM':
      return [t('Reverse-charge invoices', [['invoice_number', 'Invoice'], ['supplier_invoice_number', 'Supplier invoice'], ['recorded_date', 'Recorded', 'date'], ['taxable', 'Taxable', 'amount'],
        ['igst', 'IGST', 'amount'], ['cgst', 'CGST', 'amount'], ['sgst', 'SGST', 'amount'], ['cess', 'Cess', 'amount'], ['gst_status', 'ITC'], ['itc_eligible', 'ITC eligible', 'amount']], x.invoices),
      kv('Totals', x.totals), kv('RCM payable ledger', { ...(x.payable_ledger ?? {}), difference_ledger_minus_documents: x.difference }),
      t('RCM set-offs', [['period_code', 'Period'], ['liability_head', 'Head'], ['source', 'Paid from'], ['source_head', 'Source head'], ['amount', 'Amount', 'amount']], x.set_offs)]
    case 'CASH_LEDGER':
      return [t('Payment attempts', [['cpin', 'CPIN'], ['challan_date', 'Challan date', 'date'], ['attempt_no', 'Attempt', 'number'], ['payment_status', 'Status'], ['payment_date', 'Paid on', 'date'],
        ['amount', 'Amount', 'amount'], ['counted', 'Counted', 'bool'], ['flag', 'Flag'], ['cin', 'CIN'], ['bank', 'Bank account (masked)'], ['bank_amount', 'Bank voucher', 'amount'], ['voucher_number', 'Voucher']],
        (x.payments ?? []).map((p: Record<string, any>) => ({ ...p, bank: p.bank_account ? `${p.bank_account.code} ${p.bank_account.number}` : null }))), // eslint-disable-line @typescript-eslint/no-explicit-any
      kv('Electronic cash ledger', { ...(x.cash_ledger ?? {}), counted_payments: x.counted_payments, reversed_payments: x.reversed_payments, deposits_minus_counted: x.deposits_difference }),
      kv('Available by head', x.available_by_head)]
    case 'CREDIT_LEDGER':
      return [t('Credit ledger', [['head', 'Head'], ['opening_historical', 'Opening', 'amount'], ['accrual_ledger', 'Accrual', 'amount'], ['availed', 'Availed', 'amount'], ['reclaimed', 'Reclaimed', 'amount'],
        ['reversed', 'Reversed', 'amount'], ['other_movements', 'Other movements', 'amount'], ['utilised', 'Utilised', 'amount'], ['closing_historical', 'Closing (period end)', 'amount'],
        ['current_available', 'Current available', 'amount']], x.rows)]
    case 'VOUCHERS':
      return [t('GST vouchers', [['voucher_number', 'Voucher'], ['date', 'Date', 'date'], ['type', 'Type'], ['status', 'Status'], ['source_type', 'Source'], ['source_document', 'Document'],
        ['posting', 'Posting event'], ['reversal_of', 'Reverses'], ['reversed_by', 'Reversed by'], ['flags_text', 'Flags'], ['amounts', 'GST amounts']],
        (x.vouchers ?? []).map((v: Record<string, any>) => ({ ...v, posting: v.posting_event?.status ?? null, flags_text: (v.flags ?? []).join(', ') || null, // eslint-disable-line @typescript-eslint/no-explicit-any
          amounts: Object.entries(v.gst_amounts ?? {}).map(([k, a]) => `${k} ${a}`).join('; ') }))),
      t('Documents without a voucher', [['kind', 'Kind'], ['number', 'Number'], ['date', 'Date', 'date']], x.documents_without_voucher),
      t('Posting problems', [['source_type', 'Source'], ['source_number', 'Number'], ['date', 'Date', 'date'], ['status', 'Status'], ['error', 'Error']], x.posting_problems)]
    case 'COMPLETENESS':
      return [t('Summary', [['severity', 'Severity'], ['code', 'Exception'], ['count', 'Count', 'number']], x.summary),
        t('Exceptions', [['severity', 'Severity'], ['code', 'Exception'], ['document_no', 'Document'], ['source_kind', 'Kind'], ['document_date', 'Date', 'date'], ['message', 'Details']], x.rows)]
    case 'GSTR1_VS_GSTR3B':
      return [t('GSTR-1 vs GSTR-3B', [['line', 'Line'], ['head', 'Head'], ['gstr1_calculated', 'GSTR-1 calculated', 'amount'], ['gstr3b_calculated', 'GSTR-3B calculated', 'amount'],
        ['difference_calculated', 'Difference (calculated)', 'amount'], ['gstr1_adjusted', 'GSTR-1 adjusted', 'amount'], ['gstr3b_adjusted', 'GSTR-3B adjusted', 'amount'],
        ['difference_adjusted', 'Difference (adjusted)', 'amount'], ['snapshot_gstr1', 'Snapshot GSTR-1', 'amount'], ['snapshot_gstr3b', 'Snapshot GSTR-3B', 'amount'], ['explanation', 'Explanation']], x.rows)]
    case 'PERIOD_AUDIT':
      return [t('Snapshots', [['version_no', 'Version', 'number'], ['snapshot_hash', 'SHA-256'], ['created_at', 'Approved', 'date'], ['config_version_no', 'Config version', 'number'],
        ['prepared_by', 'Prepared by'], ['approved_by', 'Approved by'], ['current', 'Current', 'bool']], x.snapshots),
      t('History', [['at', 'When', 'date'], ['action', 'Action'], ['from', 'From'], ['to', 'To'], ['by', 'By'], ['reason', 'Reason']], x.history),
      t('Adjustments', [['return_type', 'Return'], ['section', 'Section'], ['field', 'Field'], ['amount', 'Amount', 'amount'], ['status', 'Status'], ['reason', 'Reason']], x.adjustments),
      t('Filing records', [['return_type', 'Return'], ['arn', 'ARN'], ['filed_on', 'Filed on', 'date'], ['status', 'Status'], ['void_reason', 'Void reason']], x.filing_records),
      t('Set-offs', [['status', 'Status'], ['voucher_number', 'Voucher'], ['lines_text', 'Lines']], (x.set_offs ?? []).map((s: Record<string, any>) => ({ ...s, // eslint-disable-line @typescript-eslint/no-explicit-any
        lines_text: (s.lines ?? []).map((l: Record<string, any>) => `${l.liability_kind} ${l.liability_head} ← ${l.source} ${l.source_head} ${l.amount}`).join('; ') }))), // eslint-disable-line @typescript-eslint/no-explicit-any
      t('Close controls', [['severity', 'Severity'], ['code', 'Control'], ['count', 'Count', 'number'], ['state', 'Result'], ['message', 'Details']],
        (x.close_controls ?? []).map((c: Record<string, any>) => ({ ...c, state: controlState(c as Control) }))), // eslint-disable-line @typescript-eslint/no-explicit-any
      t('Exceptions', [['severity', 'Severity'], ['code', 'Exception'], ['count', 'Count', 'number']], x.exceptions_summary),
      t('Late documents', [['kind', 'Kind'], ['source_kind', 'Source'], ['document_no', 'Document'], ['status', 'Status'], ['assigned_period', 'Assigned to']], x.late_documents?.amendment_exceptions)]
  }
}

// ---- period lifecycle and close controls --------------------------------------------------------------------------------------
export interface Control { code: string; severity: 'BLOCKER' | 'WARNING'; count: number; passed: boolean; message: string }
export interface Lifecycle { status: string; label: string; filed: { return_type: string; arn: string; filed_on: string }[]; reopened_count: number }
/** A blocker passes or fails; a warning is clear or open — an open warning is never shown as passed. */
export const controlState = (c: Control) => (c.severity === 'BLOCKER' ? (c.passed ? 'Passed' : 'Failed') : c.passed ? 'Clear' : 'Open warning')
export const LIFECYCLE_STEPS: { key: string; label: string }[] = [
  { key: 'OPEN', label: 'Open' }, { key: 'UNDER_REVIEW', label: 'In review' }, { key: 'READY_FOR_APPROVAL', label: 'Ready for approval' }, { key: 'APPROVED', label: 'Approved' },
  { key: 'CLOSED', label: 'Closed' }, { key: 'FILED', label: 'Filed (recorded)' },
]
export function lifecycleSteps(l: Lifecycle): { key: string; label: string; state: 'done' | 'current' | 'todo' }[] {
  const order = ['OPEN', 'UNDER_REVIEW', 'READY_FOR_APPROVAL', 'APPROVED', 'CLOSED']
  const at = order.indexOf(l.status)
  return LIFECYCLE_STEPS.map((s) => {
    if (s.key === 'FILED') return { ...s, state: l.filed.length > 0 ? 'current' : 'todo' }
    const i = order.indexOf(s.key)
    return { ...s, state: i < at ? 'done' : i === at ? (l.filed.length > 0 ? 'done' : 'current') : 'todo' }
  })
}

// ---- working files ----------------------------------------------------------------------------------------------------------
export type Cell = string | number | boolean | null
export interface WorkingDoc { title: string; header: ReportHeader | null; meta?: { company?: string; gstin?: string; financial_year?: string; period?: string; generated_at: string;
  config_version_no?: number | null; snapshot?: string | null; value_status?: string }; tables: ReportTable[] }

export const VALUE_STATUS_LABEL: Record<string, string> = { CALCULATED: 'Calculated (live)', ADJUSTED: 'Manually adjusted (live)', APPROVED: 'Approved snapshot', FILED: 'Filed (recorded by the user)' }

export function headerLines(d: WorkingDoc): string[] {
  const h = d.header
  const m = d.meta
  const company = h?.company?.legal_name ?? m?.company ?? ''
  const snap = h?.snapshot ? `Snapshot v${h.snapshot.version_no} · ${h.snapshot.snapshot_hash}` : m?.snapshot ?? 'Live data (no approved snapshot)'
  return [d.title, `${company} · GSTIN ${h?.gstin ?? m?.gstin ?? ''}`, `Financial year ${h?.financial_year ?? m?.financial_year ?? ''} · Tax period ${h?.period_code ?? m?.period ?? ''}${h ? ` (${h.from} to ${h.to})` : ''}`,
    `Generated ${h?.generated_at ?? m?.generated_at ?? ''} · Configuration version ${h?.config_version_no ?? m?.config_version_no ?? '—'}`, snap,
    `Values: ${VALUE_STATUS_LABEL[h?.value_status ?? m?.value_status ?? 'CALCULATED'] ?? ''}${h?.filings?.length ? ` · Filing recorded: ${h.filings.map((f) => `${f.return_type} ARN ${f.arn} (${f.filed_on})`).join(', ')}` : ''}`,
    GST_DISCLAIMER]
}

export const cellValue = (v: unknown, kind: ColKind = 'text'): Cell => {
  if (v === null || v === undefined || v === '') return null
  if (kind === 'amount' || kind === 'number') { const n = Number(v); return Number.isFinite(n) ? n : String(v) }
  if (kind === 'bool') return v === true ? 'Yes' : v === false ? 'No' : String(v)
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

export function tableRows(tb: ReportTable): Cell[][] {
  return [tb.columns.map((c) => c.label), ...tb.rows.map((r) => tb.columns.map((c) => cellValue(r[c.key], c.kind)))]
}

/** Excel sheet names: ≤ 31 characters, no []:*?/\ , unique. */
export function sheetNames(titles: string[]): string[] {
  const used = new Set<string>()
  return titles.map((tl) => {
    const base = tl.replace(/[[\]:*?/\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31) || 'Sheet'
    let name = base
    for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base.slice(0, 31 - String(i).length - 1)} ${i}`
    used.add(name.toLowerCase())
    return name
  })
}

export const INR_FORMAT = '#,##,##0.00;[Red]-#,##,##0.00'

interface XlsxLike {
  utils: { book_new(): unknown; aoa_to_sheet(rows: Cell[][]): Record<string, unknown>; book_append_sheet(wb: unknown, ws: unknown, name: string): void; encode_cell(c: { r: number; c: number }): string }
}
/** Workbook: one sheet per table, each starting with the header block (company, GSTIN, period, status, disclaimer); amounts in INR format. */
export function buildWorkbook(XLSX: XlsxLike, d: WorkingDoc): unknown {
  const wb = XLSX.utils.book_new()
  const head = headerLines(d).map((l) => [l] as Cell[])
  const names = sheetNames(d.tables.map((tb) => tb.title))
  d.tables.forEach((tb, i) => {
    const rows = [...head, [], ...tableRows(tb)]
    const ws = XLSX.utils.aoa_to_sheet(rows)
    const start = head.length + 2
    tb.columns.forEach((c, ci) => {
      if (c.kind !== 'amount') return
      for (let ri = start; ri < rows.length; ri++) {
        const cell = ws[XLSX.utils.encode_cell({ r: ri, c: ci })] as { t?: string; z?: string } | undefined
        if (cell && cell.t === 'n') cell.z = INR_FORMAT
      }
    })
    ws['!cols'] = tb.columns.map((c) => ({ wch: Math.min(60, Math.max(10, c.label.length + 2)) }))
    XLSX.utils.book_append_sheet(wb, ws, names[i])
  })
  return wb
}

export const csvCell = (v: Cell): string => {
  if (v === null) return ''
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2)
  // Text that a spreadsheet would read as a formula is prefixed with an apostrophe.
  const s = /^[=+\-@]/.test(String(v)) ? `'${String(v)}` : String(v)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
/** CSV of one table with the header block and disclaimer as leading lines (amounts with 2 decimals; formula-like text neutralised). */
export function buildCsv(d: WorkingDoc, tableIndex = 0): string {
  const tb = d.tables[tableIndex]
  const body = tb ? [csvCell(tb.title), tb.columns.map((c) => csvCell(c.label)).join(','),
    ...tb.rows.map((r) => tb.columns.map((c) => { const v = cellValue(r[c.key], c.kind); return c.kind === 'amount' && typeof v === 'number' ? v.toFixed(2) : csvCell(v) }).join(','))] : []
  const lines = [...headerLines(d).map((l) => csvCell(l)), '', ...body]
  return '﻿' + lines.join('\r\n') + '\r\n'
}

export const isNegative = (v: unknown) => v !== null && v !== undefined && v !== '' && Number(v) < 0
