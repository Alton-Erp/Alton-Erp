// GSTR-2B import and reconciliation (migration 20261231090600): types and pure helpers for the screens.
// The GSTR-2B file is the Excel / CSV the user downloads from the GST portal; there is no portal / GSTN / JSON integration.
// Imported data never posts vouchers and never approves ITC.

export const GSTR2B_MAX_BYTES = 10 * 1024 * 1024
export const GSTR2B_XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

export type Gstr2bImportStatus = 'PENDING_UPLOAD' | 'UPLOADED' | 'VERIFIED' | 'REJECTED' | 'COMMITTED' | 'DISCARDED' | 'EXPIRED'
export type Gstr2bRowStatus = 'VALID' | 'ERROR' | 'DUPLICATE_IN_FILE'
export type Gstr2bOutcome = 'EXACT' | 'PARTIAL' | 'DATE_MISMATCH' | 'TAXABLE_MISMATCH' | 'TAX_MISMATCH' | 'NUMBER_MISMATCH' | 'GSTIN_MISMATCH'
export type Gstr2bMatchStatus = 'PROPOSED' | 'APPROVED' | 'REJECTED' | 'REVERSED' | 'SUPERSEDED'
export type Gstr2bReportKey = 'SUMMARY' | 'DOCUMENTS' | 'MISSING_IN_BOOKS' | 'MISSING_IN_2B' | 'CREDIT_NOTES' | 'DUPLICATES' | 'AMENDMENTS' | 'MATCH_EXCEPTIONS' | 'HISTORY'
type Amount = number | string

export interface Gstr2bImport {
  id: string
  return_period: string
  file_name: string
  file_kind: 'CSV' | 'XLSX'
  mime_type: string
  file_size: number
  declared_sha256: string
  computed_sha256: string | null
  storage_path: string
  bucket: string
  status: Gstr2bImportStatus
  rejection_reason: string | null
  status_reason: string | null
  total_rows: number
  valid_rows: number
  error_rows: number
  duplicate_rows: number
  parser: { sheets?: { sheet: string; section: string; rows: number }[]; skipped?: string[] }
  commit_summary: Record<string, number>
  uploaded_by_name: string | null
  committed_by_name: string | null
  created_at: string
  verified_at: string | null
  committed_at: string | null
  row_version: number
}
export interface Gstr2bLine {
  id: string
  line_no: number
  sheet_name: string | null
  source_row: number | null
  section: string
  original_row: Record<string, string>
  supplier_gstin: string | null
  supplier_name: string | null
  doc_type: 'INVOICE' | 'CREDIT_NOTE' | 'DEBIT_NOTE'
  doc_number: string | null
  doc_date: string | null
  is_amendment: boolean
  original_doc_number: string | null
  taxable_value: Amount | null
  igst: Amount | null
  cgst: Amount | null
  sgst: Amount | null
  cess: Amount | null
  row_status: Gstr2bRowStatus
  errors: string[]
  duplicate_of_line: number | null
  commit_outcome: string | null
}
export interface Gstr2bPreview { new_documents: number; amendments: number; changed: number; already_imported: number; credit_debit_notes: number }
export interface Gstr2bImportDetail extends Gstr2bImport { preview: Gstr2bPreview; lines: Gstr2bLine[]; line_count: number }
export interface Gstr2bHistory { action: string; reason: string | null; by: string | null; created_at: string }
export interface Gstr2bMatch {
  id: string
  document_id: string
  purchase_invoice_id: string
  method: 'AUTO' | 'MANUAL'
  outcome: Gstr2bOutcome
  mismatches: string[]
  differences: Record<string, { gstr2b: unknown; books: unknown; difference?: Amount }>
  /** Tolerance per amount applied when the match was proposed, and the configuration version it came from (Gate D). */
  tolerance: Amount
  config_version_no: number | null
  status: Gstr2bMatchStatus
  reason: string | null
  decision_note: string | null
  reversal_reason: string | null
  invoice_number: string
  supplier_invoice_number: string
  supplier_gstin: string
  doc_number: string
  version_no: number
  is_current_version: boolean
  proposed_by_name: string | null
  decided_by_name: string | null
  proposed_at: string
  history: Gstr2bHistory[]
}
export interface Gstr2bVersion { id: string; version_no: number; version_kind: 'ORIGINAL' | 'AMENDMENT' | 'CHANGED'; return_period: string; doc_number: string; doc_date: string;
  taxable_value: Amount; igst: Amount; cgst: Amount; sgst: Amount; cess: Amount; original_row: Record<string, string>; file_name: string; source_row: number | null }
export interface Gstr2bCandidate { id: string; invoice_number: string; supplier_invoice_number: string; supplier_invoice_date: string; taxable_value: Amount; igst: Amount; cgst: Amount;
  sgst: Amount; cess: Amount; gst_status: string }
export interface Gstr2bDocument {
  id: string
  supplier_gstin: string
  doc_type: 'INVOICE' | 'CREDIT_NOTE' | 'DEBIT_NOTE'
  doc_number: string
  doc_fy: string
  supplier_name: string | null
  version_count: number
  needs_review: boolean
  review_reason: string | null
  versions: Gstr2bVersion[]
  matches: Gstr2bMatch[]
  candidates: Gstr2bCandidate[]
}
export type Gstr2bReportRow = Record<string, unknown>

/** The ITC view of a purchase invoice (gst_itc_get), as far as the screens use it. */
export interface ItcView {
  invoice_id: string
  gst_status: string
  stage: string | null
  history: { seq: number; stage: string; decision: string | null; reason: string | null; by: string | null; created_at: string; actor_id: string | null }[]
  gstr2b: { match_status: string; outcome?: Gstr2bOutcome; doc_number?: string; doc_date?: string; return_period?: string; itc_availability?: string | null;
    needs_review?: boolean; is_current_version?: boolean; note: string }
}

export const IMPORT_STATUS_LABELS: Record<Gstr2bImportStatus, string> = {
  PENDING_UPLOAD: 'Uploading', UPLOADED: 'Awaiting verification', VERIFIED: 'Verified — preview', REJECTED: 'Rejected', COMMITTED: 'Imported', DISCARDED: 'Discarded', EXPIRED: 'Expired',
}
export const OUTCOME_LABELS: Record<Gstr2bOutcome, string> = {
  EXACT: 'Exact', PARTIAL: 'Partial (within tolerance)', DATE_MISMATCH: 'Date mismatch', TAXABLE_MISMATCH: 'Taxable value mismatch', TAX_MISMATCH: 'Tax mismatch',
  NUMBER_MISMATCH: 'Invoice number mismatch', GSTIN_MISMATCH: 'GSTIN mismatch',
}
export const MATCH_STATUS_LABELS: Record<Gstr2bMatchStatus, string> = {
  PROPOSED: 'Awaiting approval', APPROVED: 'Approved', REJECTED: 'Rejected', REVERSED: 'Reversed', SUPERSEDED: 'Superseded (document changed)',
}
export const REPORT_LABELS: Record<Gstr2bReportKey, string> = {
  SUMMARY: 'Summary', DOCUMENTS: 'All documents', MISSING_IN_BOOKS: 'Missing in books', MISSING_IN_2B: 'Missing in GSTR-2B', CREDIT_NOTES: 'Supplier credit / debit notes',
  DUPLICATES: 'Duplicates', AMENDMENTS: 'Amendments and changed versions', MATCH_EXCEPTIONS: 'Match exceptions', HISTORY: 'Match history',
}

/** File type from the name: only .csv and .xlsx are accepted, with their exact MIME type (the server checks the same). */
export function gstr2bFileKind(name: string): { kind: 'CSV' | 'XLSX'; mime: string } | null {
  const ext = /\.([A-Za-z0-9]+)$/.exec(name.trim())?.[1]?.toLowerCase()
  if (ext === 'csv') return { kind: 'CSV', mime: 'text/csv' }
  if (ext === 'xlsx') return { kind: 'XLSX', mime: GSTR2B_XLSX_MIME }
  return null
}

/** Client-side check before uploading (the database and the Edge Function check again). */
export function validateGstr2bFile(file: { name: string; size: number }, returnPeriod: string): string | null {
  if (!gstr2bFileKind(file.name)) return 'Choose the GSTR-2B file as CSV or Excel (.xlsx), as downloaded from the GST portal.'
  if (/[/\\]/.test(file.name) || file.name.length > 200) return 'The file name is not valid.'
  if (file.size < 1 || file.size > GSTR2B_MAX_BYTES) return 'The file must be between 1 byte and 10 MB.'
  if (!/^[0-9]{4}-(0[1-9]|1[0-2])$/.test(returnPeriod)) return 'Choose the GSTR-2B return period (month).'
  return null
}

/** GSTR-2B for a month is generated in the following month, so the default period is the previous month. */
export function defaultReturnPeriod(today: string): string {
  const [y, m] = today.split('-').map(Number)
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`
}

/** A match with differences can only be approved with a note (the database enforces the same rule). */
export const needsApprovalNote = (outcome: Gstr2bOutcome) => outcome !== 'EXACT'

export function outcomeTone(outcome: Gstr2bOutcome | null | undefined): 'success' | 'warning' | 'danger' | 'neutral' {
  if (!outcome) return 'neutral'
  if (outcome === 'EXACT') return 'success'
  if (outcome === 'PARTIAL' || outcome === 'DATE_MISMATCH') return 'warning'
  return 'danger'
}

export const shortSha = (sha: string | null | undefined) => (sha ? `${sha.slice(0, 12)}…${sha.slice(-6)}` : '—')

export async function sha256OfFile(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
