// GST return preparation (migration 20261231090700): types, labels and the working-file builders (pure, unit-tested).
// Every figure comes from the database (stored document totals, decisions, set-offs, ledgers); nothing is recalculated here.
// The system never files returns: "filed" is a record a user enters after filing on the GST portal.
import { GST_DISCLAIMER } from './gst-reports-model.ts'

export type ValueStatus = 'CALCULATED' | 'ADJUSTED' | 'APPROVED' | 'FILED'
export type Amount = number | string
export interface HeadAmounts { documents?: number; taxable: Amount; igst: Amount; cgst: Amount; sgst: Amount; cess: Amount; total?: Amount; inter_state?: Amount; intra_state?: Amount }
export interface ReturnAdjustment { id: string; field: string; tax_head: string | null; amount: Amount; reason: string; status: 'DRAFT' | 'APPROVED' }
export interface ReturnSection {
  label?: string
  calculated: HeadAmounts
  adjusted: HeadAmounts
  adjustments: ReturnAdjustment[]
  value_status: 'CALCULATED' | 'ADJUSTED'
  rows?: Record<string, unknown>[]
}
export interface ReturnException { code: string; severity: 'ERROR' | 'WARNING'; source_kind: string; source_id: string; document_no: string | null; document_date: string | null; message: string }
export interface FilingRecord { id: string; return_type: 'GSTR1' | 'GSTR3B'; arn: string; filed_on: string; note: string | null; recorded_by_name: string | null; recorded_at: string; note_on_filing: string }
interface ReturnBase {
  period: string
  from: string
  to: string
  config_version_no: number | null
  sections: Record<string, ReturnSection>
  unmatched_adjustments: { id: string; section: string; field: string; amount: Amount; status: string }[]
  source: 'LIVE' | 'SNAPSHOT'
  value_status: ValueStatus
  period_status: string
  snapshot: { id: string; version_no: number; snapshot_hash: string; created_at: string; has_return_working: boolean } | null
  live_differs: boolean
  filing: FilingRecord | null
  exceptions: ReturnException[]
  disclaimer: string
}
export interface Gstr1 extends ReturnBase {
  return_type: 'GSTR1'
  b2cl_invoice_threshold: Amount
  hsn: { hsn_sac: string; uqc: string; rate: Amount; b2b: boolean; quantity: Amount; taxable: Amount; igst: Amount; cgst: Amount; sgst: Amount; cess: Amount }[]
  documents_issued: { nature: string; series: string; from: string; to: string; total: number; cancelled: number; net_issued: number }[]
  excluded: { draft_or_pending: number; cancelled: number; proforma: number }
}
export interface PaymentRow { head: string; payable_per_return: Amount; liability_per_ledger: Amount; paid_through_itc: Record<string, Amount>; paid_in_cash: Amount; interest: Amount;
  late_fee: Amount; open_after_set_off: Amount }
export interface CreditHead { accrued_to_period_end: Amount; used_to_period: Amount; used_in_posted_set_offs: Amount; available_at_period_end: Amount; cumulative_headroom: Amount;
  ledger_balance: Amount; current_available: Amount; available: Amount }
export interface Gstr3b extends ReturnBase {
  return_type: 'GSTR3B'
  net_itc: Record<'igst' | 'cgst' | 'sgst' | 'cess', Amount>
  '3.2_inter_state_unregistered': { place_of_supply: string; taxable: Amount; igst: Amount }[]
  '6.1': PaymentRow[]
  credit: Record<string, CreditHead> | null
  itc_evidence: { note: string; by_gstr2b_status: Record<string, { decisions: number; itc: Amount }>; events: Record<string, unknown>[] }
}
export interface GstPeriod { id: string; period_code: string; frequency: string; financial_year?: string; period_start: string; period_end: string; status: string; snapshot_version: number | null;
  open_amendments: number; prepared_by: string | null; row_version: number }

export const VALUE_STATUS_META: Record<ValueStatus, { label: string; tone: 'neutral' | 'info' | 'success' | 'warning'; description: string }> = {
  CALCULATED: { label: 'Calculated', tone: 'neutral', description: 'Live from issued / posted documents; no manual adjustment applied.' },
  ADJUSTED: { label: 'Manually adjusted', tone: 'warning', description: 'Live, with approved manual return adjustments applied (shown separately).' },
  APPROVED: { label: 'Approved (snapshot)', tone: 'info', description: 'From the period\'s approved snapshot; never recalculated.' },
  FILED: { label: 'Filed (recorded)', tone: 'success', description: 'A user recorded the ARN after filing on the GST portal. This system does not file returns.' },
}

export const GSTR1_SECTIONS: { code: string; label: string }[] = [
  { code: 'B2B', label: '4A B2B — registered recipients' }, { code: 'SEZWP', label: '6B SEZ with payment' }, { code: 'SEZWOP', label: '6B SEZ without payment' },
  { code: 'DE', label: '6C Deemed exports' }, { code: 'B2CL', label: '5 B2C large (inter-state above the threshold)' }, { code: 'B2CS', label: '7 B2C others' },
  { code: 'EXPWP', label: '6A Exports with payment' }, { code: 'EXPWOP', label: '6A Exports without payment' }, { code: 'CDNR', label: '9B Credit / debit notes (registered)' },
  { code: 'CDNUR', label: '9B Credit / debit notes (unregistered)' }, { code: 'NIL', label: '8 Nil rated, exempt, non-GST' },
]
export const GSTR3B_SECTIONS: string[] = ['3.1(a)', '3.1(b)', '3.1(c)', '3.1(d)', '3.1(e)', '4(A)(3)', '4(A)(5)', '4(B)(2)', '4(D)(2)', '5']
export const HEADS = ['taxable', 'igst', 'cgst', 'sgst', 'cess'] as const

type Cell = string | number | null
const n = (x: Amount | null | undefined): number | null => (x === null || x === undefined || x === '' ? null : Number(x))
const heads = (h: HeadAmounts | undefined): Cell[] => HEADS.map((k) => n(h?.[k]))

/** Company, GSTIN and financial year for the working-file header (from the GST registration and the period). */
export interface ReturnMeta { company: string; gstin: string; financial_year: string; generated_at: string }

function header(r: ReturnBase, title: string, meta?: ReturnMeta): Cell[][] {
  return [[title], [`${meta?.company ?? ''} · GSTIN ${meta?.gstin ?? ''}`], [`Financial year ${meta?.financial_year ?? ''} · Tax period ${r.period} (${r.from} to ${r.to})`],
    [`Generated ${meta?.generated_at ?? ''} · Configuration version ${r.config_version_no ?? '—'}`],
    [`Values: ${VALUE_STATUS_META[r.value_status].label} — ${VALUE_STATUS_META[r.value_status].description}`],
    [r.snapshot ? `Snapshot v${r.snapshot.version_no} · ${r.snapshot.snapshot_hash}` : 'Live working (no approved snapshot)'],
    [r.filing ? `Filing recorded: ARN ${r.filing.arn} on ${r.filing.filed_on}` : 'No filing recorded'], [GST_DISCLAIMER], []]
}

function summary(r: ReturnBase, codes: { code: string; label: string }[]): Cell[][] {
  return [['Section', 'Description', 'Status', 'Calculated taxable', 'Calculated IGST', 'Calculated CGST', 'Calculated SGST', 'Calculated cess',
    'Adjusted taxable', 'Adjusted IGST', 'Adjusted CGST', 'Adjusted SGST', 'Adjusted cess', 'Adjustments (approved / pending)'],
  ...codes.filter((c) => r.sections[c.code]).map((c) => {
    const s = r.sections[c.code]
    return [c.code, s.label ?? c.label, s.value_status === 'ADJUSTED' ? 'Manually adjusted' : 'Calculated', ...heads(s.calculated), ...heads(s.adjusted),
      `${s.adjustments.filter((a) => a.status === 'APPROVED').length} / ${s.adjustments.filter((a) => a.status === 'DRAFT').length}`]
  })]
}

/** GSTR-1 working file: summary, one sheet per section, HSN summary, documents issued, exceptions. */
export function gstr1Sheets(r: Gstr1, meta?: ReturnMeta): { name: string; rows: Cell[][] }[] {
  const docRows = (code: string): Cell[][] => {
    const s = r.sections[code]
    if (!s) return []
    if (code === 'B2CS') {
      return [['Place of supply', 'Supply type', 'Rate %', 'Taxable', 'IGST', 'CGST', 'SGST', 'Cess'],
        ...(s.rows ?? []).map((x) => [x.place_of_supply as string, x.supply_type as string, n(x.rate as Amount), n(x.taxable as Amount), n(x.igst as Amount), n(x.cgst as Amount),
          n(x.sgst as Amount), n(x.cess as Amount)])]
    }
    return [['Type', 'Number', 'Date', 'Customer', 'GSTIN', 'Place of supply', 'Document value', 'Original invoice', 'Rate %', 'Taxable', 'IGST', 'CGST', 'SGST', 'Cess'],
      ...(s.rows ?? []).flatMap((x) => {
        const rates = (x.rates as { rate: Amount; taxable: Amount; igst: Amount; cgst: Amount; sgst: Amount }[] | undefined) ?? []
        const base: Cell[] = [x.kind as string, x.number as string, x.date as string, x.customer as string, (x.gstin as string) ?? null, (x.place_of_supply as string) ?? null,
          n(x.value as Amount), (x.original_invoice as string) ?? null]
        const sign = Number(x.sign ?? 1)
        return (rates.length ? rates : [{ rate: 0, taxable: x.taxable as Amount, igst: x.igst as Amount, cgst: x.cgst as Amount, sgst: x.sgst as Amount }])
          .map((t) => [...base, n(t.rate), sign * Number(t.taxable), sign * Number(t.igst), sign * Number(t.cgst), sign * Number(t.sgst), 0])
      })]
  }
  return [
    { name: 'Summary', rows: [...header(r, 'GSTR-1 working', meta), ...summary(r, GSTR1_SECTIONS), [], [`Excluded: ${r.excluded.draft_or_pending} draft / pending, ${r.excluded.cancelled} cancelled, ${r.excluded.proforma} pro-forma`]] },
    ...GSTR1_SECTIONS.filter((c) => (r.sections[c.code]?.calculated.documents ?? 0) > 0).map((c) => ({ name: c.code, rows: docRows(c.code) })),
    { name: 'HSN', rows: [['HSN / SAC', 'UQC', 'Rate %', 'B2B', 'Quantity', 'Taxable', 'IGST', 'CGST', 'SGST', 'Cess'],
      ...r.hsn.map((h) => [h.hsn_sac, h.uqc, n(h.rate), h.b2b ? 'B2B' : 'B2C', n(h.quantity), n(h.taxable), n(h.igst), n(h.cgst), n(h.sgst), n(h.cess)])] },
    { name: 'Documents', rows: [['Nature', 'Series', 'From', 'To', 'Total', 'Cancelled', 'Net issued'],
      ...r.documents_issued.map((d) => [d.nature, d.series, d.from, d.to, d.total, d.cancelled, d.net_issued])] },
    { name: 'Exceptions', rows: exceptionRows(r.exceptions) },
  ]
}

/** GSTR-3B working file: summary of every table, payment of tax, credit position, ITC evidence, exceptions. */
export function gstr3bSheets(r: Gstr3b, meta?: ReturnMeta): { name: string; rows: Cell[][] }[] {
  return [
    { name: 'Summary', rows: [...header(r, 'GSTR-3B working', meta), ...summary(r, GSTR3B_SECTIONS.map((code) => ({ code, label: code }))), [],
      ['Net ITC (4C)', null, null, null, ...(['igst', 'cgst', 'sgst', 'cess'] as const).map((h) => n(r.net_itc[h]))]] },
    { name: '3.2 Inter-state', rows: [['Place of supply', 'Taxable', 'IGST'], ...r['3.2_inter_state_unregistered'].map((x) => [x.place_of_supply, n(x.taxable), n(x.igst)])] },
    { name: '6.1 Payment', rows: [['Head', 'Payable per return', 'Liability per ledger', 'Paid through ITC (IGST)', 'Paid through ITC (CGST)', 'Paid through ITC (SGST)',
      'Paid through ITC (cess)', 'Paid in cash', 'Interest', 'Late fee', 'Open after set-off'],
      ...r['6.1'].map((p) => [p.head, n(p.payable_per_return), n(p.liability_per_ledger), n(p.paid_through_itc.IGST), n(p.paid_through_itc.CGST), n(p.paid_through_itc.SGST),
        n(p.paid_through_itc.CESS), n(p.paid_in_cash), n(p.interest), n(p.late_fee), n(p.open_after_set_off)])] },
    { name: 'Credit', rows: [['Head', 'Accrued by period end', 'Used through the period', 'Available at period end (historical)', 'Cumulative headroom',
      'Ledger balance (current)', 'Available for set-off'],
      ...Object.entries(r.credit ?? {}).map(([h, c]) => [h, n(c.accrued_to_period_end), n(c.used_to_period), n(c.available_at_period_end), n(c.cumulative_headroom), n(c.ledger_balance), n(c.available)])] },
    { name: 'ITC evidence', rows: [[r.itc_evidence.note], ['GSTR-2B status', 'Decisions', 'ITC'],
      ...Object.entries(r.itc_evidence.by_gstr2b_status).map(([k, v]) => [k.replace(/_/g, ' '), v.decisions, n(v.itc)])] },
    { name: 'Exceptions', rows: exceptionRows(r.exceptions) },
  ]
}

export function exceptionRows(rows: ReturnException[]): Cell[][] {
  return [['Severity', 'Code', 'Document', 'Kind', 'Date', 'Message'], ...rows.map((e) => [e.severity, e.code, e.document_no, e.source_kind, e.document_date, e.message])]
}

/** Exceptions grouped by code, errors first. */
export function exceptionSummary(rows: ReturnException[]): { code: string; severity: 'ERROR' | 'WARNING'; count: number }[] {
  const m = new Map<string, { code: string; severity: 'ERROR' | 'WARNING'; count: number }>()
  for (const e of rows) {
    const x = m.get(e.code) ?? { code: e.code, severity: e.severity, count: 0 }
    x.count++
    m.set(e.code, x)
  }
  return [...m.values()].sort((a, b) => (a.severity === b.severity ? a.code.localeCompare(b.code) : a.severity === 'ERROR' ? -1 : 1))
}

export const ARN_PATTERN = /^[A-Z0-9]{15}$/
export const normaliseArn = (s: string) => s.trim().toUpperCase()
