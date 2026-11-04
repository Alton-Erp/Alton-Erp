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

export interface PreviewResult {
  department: DepartmentKey
  operation: Operation
  categories: string[]
  plan_hash: string
  tables: Record<string, number>
  total: number
  by_category: Omit<CategorySummary, 'operation'>[]
  blocked: { category: string; table: string; key: string; record: string; reasons: string[]; references: { table: string; department: string; record: string }[] | null }[]
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
}): string | null {
  const p = input.preview
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

/** Readable table name ("purchase_order_lines" → "Purchase order lines"). */
export const tableLabel = (table: string) => table.charAt(0).toUpperCase() + table.slice(1).replace(/_/g, ' ')

/** Categories of one department grouped by operation, in display order. */
export function groupByOperation(categories: CategorySummary[]): { operation: Operation; categories: CategorySummary[] }[] {
  return OPERATION_ORDER.map((operation) => ({ operation, categories: categories.filter((c) => c.operation === operation) })).filter((g) => g.categories.length > 0)
}
