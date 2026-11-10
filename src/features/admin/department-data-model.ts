/**
 * Department-wise Data Management (Settings → System): departments, operations and the rules the
 * screen checks before it calls the database. The database enforces all of them again
 * (migration 20261119090000); this module only explains them early.
 */

export type DepartmentKey = 'PRODUCTS' | 'INVENTORY' | 'PURCHASE' | 'PRODUCTION' | 'SALES' | 'BILLING' | 'LEDGER'
export type Operation = 'ARCHIVE' | 'RESET' | 'DELETE'

export const DEPARTMENTS: { key: DepartmentKey; label: string; description: string }[] = [
  { key: 'PRODUCTS', label: 'Product Master & BOM', description: 'Products, categories, BOM versions' },
  { key: 'INVENTORY', label: 'Inventory Management', description: 'Warehouses, alerts, reservations, unposted stock documents' },
  { key: 'PURCHASE', label: 'Purchase & GRN', description: 'Draft and cancelled purchase orders' },
  { key: 'PRODUCTION', label: 'Production & Outsourcing', description: 'Draft and cancelled production and outsourcing orders' },
  { key: 'SALES', label: 'Sales & Orders', description: 'Draft and cancelled sales orders, customer codes, legacy customer POs' },
  { key: 'BILLING', label: 'Billing & Invoice', description: 'Draft and discarded invoices and notes' },
  { key: 'LEDGER', label: 'Ledger', description: 'Customers, suppliers and ledger parties' },
]
export const departmentLabel = (key: string) => DEPARTMENTS.find((d) => d.key === key)?.label ?? key

export const OPERATIONS: Record<Operation, { label: string; action: string; explain: string }> = {
  ARCHIVE: { label: 'Archive', action: 'Archive', explain: 'Sets the existing inactive or archived state. Nothing is deleted and it can be undone record by record.' },
  RESET: { label: 'Reset', action: 'Reset', explain: 'Deletes transient working data that the ERP does not need again.' },
  DELETE: { label: 'Permanent delete', action: 'Delete permanently', explain: 'Deletes never-used records and unposted or cancelled documents with their own history. It cannot be undone.' },
}
export const OPERATION_ORDER: Operation[] = ['ARCHIVE', 'RESET', 'DELETE']

/** The exact phrase the database expects. */
export const confirmationPhrase = (operation: Operation, department: DepartmentKey) => `${operation} ${department}`

export interface CategorySummary {
  code: string
  label: string
  description: string
  operation: Operation
  records: number
  rows: number
  blocked: number
}

/** A record (document or master) the operation would change (migration 20261126090000). */
export interface PreviewRecord {
  category: string
  table: string
  key: string
  record: string
  /** PO, GRN draft … (only for documents the database names; otherwise the table is shown). */
  type?: string
  status?: string
  revision?: number
  rows: number
  tables: Record<string, number>
}

export interface BlockedRecord {
  category: string
  table: string
  key: string
  record: string
  type?: string
  status?: string
  revision?: number
  reasons: string[]
  references: { table: string; department: string; record: string; reason?: string }[] | null
}

export interface PreviewResult {
  department: DepartmentKey
  operation: Operation
  categories: string[]
  plan_hash: string
  tables: Record<string, number>
  total: number
  by_category: Omit<CategorySummary, 'operation'>[]
  /** Missing before migration 20261126090000 (the screen then shows counts only). */
  records?: PreviewRecord[]
  records_total?: number
  blocked: BlockedRecord[]
  blocked_total: number
  affected_departments: string[]
  confirmation_phrase: string
  requires_backup: boolean
  requires_password: boolean
  backup: BackupRecord | null
}

export interface BackupRecord {
  id: string
  backup_method: string
  backup_reference: string
  backup_taken_at: string
  recorded_by: string
  valid_until: string
}

/** First reason the execute button must stay disabled, or null. */
export function executeBlocker(input: {
  preview: PreviewResult | null
  phrase: string
  backupId: string | null
  password: string
  currentUserId: string | null
  /** Number of records ticked in the record list (undefined: no list shown). */
  selected?: number
}): string | null {
  const p = input.preview
  if (input.selected === 0) return 'Select at least one eligible record.'
  if (!p) return 'Preview first.'
  if (p.total === 0) return 'Nothing is eligible.'
  if (input.phrase !== p.confirmation_phrase) return `Type ${p.confirmation_phrase} to confirm.`
  if (p.requires_backup) {
    if (!input.backupId) return 'Record a backup taken in the last 24 hours.'
    if (p.backup && p.backup.id === input.backupId && input.currentUserId && p.backup.recorded_by !== input.currentUserId) return 'Use a backup record you made yourself.'
  }
  if (p.requires_password && input.password.length === 0) return 'Enter your password.'
  return null
}

const TABLE_LABELS: Record<string, string> = {
  erp_form_drafts: 'Unposted form drafts',
  purchase_order_events: 'Purchase order history',
  purchase_document_refs: 'Supplier document references',
  purchase_order_import_refs: 'Purchase order import references',
  inventory_transactions: 'Stock movements',
  product_purchase_cost_events: 'Purchase cost history',
  documents: 'Attachments',
}
/** Readable table name ("purchase_order_lines" → "Purchase order lines"). */
export const tableLabel = (table: string) => TABLE_LABELS[table] ?? table.charAt(0).toUpperCase() + table.slice(1).replace(/_/g, ' ')

/** Type column of the record list: the document type the database names (PO, GRN draft), else the table. */
export const recordType = (r: { type?: string; table: string }) => r.type ?? tableLabel(r.table)

/** "DRAFT" → "Draft"; an amended order shows its revision ("Draft (revision 1)"). */
export function statusLabel(status?: string, revision?: number): string {
  if (!status) return '—'
  const s = status.charAt(0) + status.slice(1).toLowerCase().replace(/_/g, ' ')
  return revision ? `${s} (revision ${revision})` : s
}

/** What is deleted together with an eligible record, e.g. "1 purchase order line, 2 history rows". */
export function deletedWith(r: PreviewRecord): string {
  const parts = Object.entries(r.tables).filter(([t]) => t !== r.table).sort(([a], [b]) => a.localeCompare(b))
    .map(([t, n]) => `${tableLabel(t)}: ${n}`)
  return parts.length ? parts.join(' · ') : 'Nothing else'
}

/**
 * Why a department's permanent delete cannot run although records exist: every candidate is blocked.
 * Null when something is eligible or nothing is blocked.
 */
export function nothingDeletableReason(categories: CategorySummary[]): string | null {
  const del = categories.filter((c) => c.operation === 'DELETE')
  const eligible = del.reduce((n, c) => n + c.records, 0)
  const blocked = del.reduce((n, c) => n + c.blocked, 0)
  if (eligible > 0 || blocked === 0) return null
  return `Nothing can be deleted permanently: ${blocked} record${blocked === 1 ? ' is' : 's are'} kept because other records depend on ${blocked === 1 ? 'it' : 'them'}.`
}

/** Categories of one department grouped by operation, in display order. */
export function groupByOperation(categories: CategorySummary[]): { operation: Operation; categories: CategorySummary[] }[] {
  return OPERATION_ORDER.map((operation) => ({ operation, categories: categories.filter((c) => c.operation === operation) })).filter((g) => g.categories.length > 0)
}
