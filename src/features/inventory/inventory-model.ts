// Inventory labels and helpers. Pure TypeScript (no aliases) so the import
// validator can be unit-tested with Node.

export type StockSourceCode = 'IN_HOUSE' | 'OUTSOURCED' | 'UNKNOWN'

export const STOCK_SOURCE_LABELS: Record<StockSourceCode, string> = {
  IN_HOUSE: 'In-House',
  OUTSOURCED: 'Outsourced',
  UNKNOWN: 'Unverified source',
}

export const TRANSACTION_TYPE_LABELS: Record<string, string> = {
  OPENING_STOCK: 'Opening stock',
  RECEIPT: 'Receipt',
  ISSUE: 'Issue',
  TRANSFER_OUT: 'Transfer out',
  TRANSFER_IN: 'Transfer in',
  ADJUSTMENT_IN: 'Adjustment in',
  ADJUSTMENT_OUT: 'Adjustment out',
  CUSTOMER_RETURN: 'Customer return',
  SUPPLIER_RETURN: 'Supplier return',
  REVERSAL: 'Reversal',
  PRODUCTION_ISSUE: 'Issued to production',
  PRODUCTION_RECEIPT: 'Production output',
  SUBCONTRACT_CONSUMPTION: 'Used by outside processor',
  SUBCONTRACT_RECEIPT: 'Outsourced receipt',
}

export const LOCATION_USAGE_LABELS: Record<string, string> = {
  STORAGE: 'Storage (usable stock)',
  REJECTED: 'Rejected goods (non-saleable)',
  EXTERNAL_PROCESSING: 'Held by outside processor',
  QUARANTINE: 'Quarantine (returns awaiting inspection)',
}

export const STOCK_STATUS_LABELS: Record<string, string> = {
  HEALTHY: 'Healthy',
  LOW_STOCK: 'Low stock',
  OUT_OF_STOCK: 'Out of stock',
  FULLY_RESERVED: 'Fully reserved',
  NO_THRESHOLD: 'No reorder level',
}

export const RESERVATION_STATUS_LABELS: Record<string, string> = {
  ACTIVE: 'Active',
  PARTIALLY_FULFILLED: 'Partially fulfilled',
  FULFILLED: 'Fulfilled',
  RELEASED: 'Released',
  CANCELLED: 'Cancelled',
  EXPIRED: 'Expired',
}

export const APPROVAL_STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Draft',
  PENDING_APPROVAL: 'Pending approval',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  POSTED: 'Posted',
  CANCELLED: 'Cancelled',
  OPEN: 'Open',
  SUBMITTED: 'Submitted',
}

export const ADJUSTMENT_REASONS: { code: string; label: string }[] = [
  { code: 'DAMAGE', label: 'Damage / breakage' },
  { code: 'LOSS', label: 'Loss' },
  { code: 'THEFT', label: 'Theft' },
  { code: 'FOUND', label: 'Found stock' },
  { code: 'COUNT_VARIANCE', label: 'Count variance' },
  { code: 'EXPIRED', label: 'Expired / write-off' },
  { code: 'DATA_CORRECTION', label: 'Data entry correction' },
  { code: 'OTHER', label: 'Other (explain in notes)' },
]

export const LOCATION_TYPES = ['GENERAL', 'ZONE', 'AREA', 'RACK', 'SHELF', 'BIN'] as const

export const ALERT_TYPE_LABELS: Record<string, string> = {
  LOW_STOCK: 'Low stock',
  OUT_OF_STOCK: 'Out of stock',
  FULLY_RESERVED: 'No available stock',
  EXPIRED: 'Expired batch',
  EXPIRING: 'Batch expiring soon',
  INVALID_LOCATION: 'Stock in inactive location',
  UNKNOWN_SOURCE: 'Source needs review',
}

const SOURCE_ALIASES: Record<string, StockSourceCode> = {
  IN_HOUSE: 'IN_HOUSE',
  INHOUSE: 'IN_HOUSE',
  MANUFACTURED: 'IN_HOUSE',
  OUTSOURCED: 'OUTSOURCED',
  OUT_SOURCED: 'OUTSOURCED',
  PURCHASED: 'OUTSOURCED',
  BOUGHT_OUT: 'OUTSOURCED',
  UNKNOWN: 'UNKNOWN',
  UNVERIFIED: 'UNKNOWN',
  NOT_KNOWN: 'UNKNOWN',
}

export function parseStockSource(value: string): StockSourceCode | null {
  const key = value.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '')
  return SOURCE_ALIASES[key] ?? null
}

/**
 * Parses a date typed or exported from a spreadsheet. Accepts ISO
 * (2026-04-01) and day-first Indian formats (01-04-2026, 01/04/2026, 1.4.2026).
 * Ambiguous month-first US dates are not accepted.
 */
export function parseSheetDate(value: string): string | null | undefined {
  const v = value.trim()
  if (v === '') return undefined
  let y: number, m: number, d: number
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(v)
  if (match) {
    ;[y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])]
  } else {
    match = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(v)
    if (!match) return null
    ;[d, m, y] = [Number(match[1]), Number(match[2]), Number(match[3])]
  }
  const date = new Date(Date.UTC(y, m - 1, d))
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/** Positive quantity with up to `maxDecimals` decimals, or null if invalid. */
export function parseQuantity(value: string, maxDecimals = 3): number | null {
  const v = value.trim().replace(/,/g, '')
  if (!/^\d+(\.\d+)?$/.test(v)) return null
  if ((v.split('.')[1]?.length ?? 0) > maxDecimals) return null
  const n = Number(v)
  return n > 0 ? n : null
}

export function formatQty(value: number | null | undefined, unit?: string): string {
  if (value === null || value === undefined) return '—'
  const n = Number(value)
  const text = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 3 }).format(n)
  return unit ? `${text} ${unit}` : text
}
