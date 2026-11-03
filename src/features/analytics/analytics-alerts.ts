import type { AlertSeverity, ExecutiveAlert } from '@/services/analytics'

export const SEVERITY_ORDER: AlertSeverity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']
export const SEVERITY_LABEL: Record<AlertSeverity, string> = { CRITICAL: 'Critical', HIGH: 'High', MEDIUM: 'Medium', LOW: 'Low' }

export const ALERT_TYPE_LABEL: Record<string, string> = {
  LOW_STOCK: 'Below reorder level',
  ZERO_STOCK: 'No available stock',
  INVENTORY_DISCREPANCY: 'Inventory discrepancy',
  SO_SHORTAGE: 'Order shortage',
  AWAITING_DISPATCH: 'Awaiting dispatch',
  PRODUCTION_DELAYED: 'Production delay',
  OUTSOURCING_OVERDUE: 'Outsourcing overdue',
  PO_UNMATCHED: 'Unmatched PO lines',
  PO_UNALLOCATED: 'PO not allocated',
  INVOICE_OVERDUE: 'Overdue invoice',
  INVOICE_DUE_SOON: 'Invoice due soon',
  PAYMENT_UNALLOCATED: 'Unallocated receipt',
  REFRESH_FAILED: 'Data refresh failed',
}

export const TEAM_LABEL: Record<string, string> = {
  INVENTORY: 'Inventory', SALES: 'Sales', PRODUCTION: 'Production', PURCHASE: 'Purchase', ACCOUNTS: 'Accounts', SYSTEM: 'All',
}

export interface AlertFilter {
  severity: AlertSeverity | 'all'
  type: string | 'all'
  team: string | 'all'
  /** Only alerts detected on or after this date. */
  since: string | null
  search: string
}

/** Most severe first, then oldest detection first (longest-standing issues on top). */
export function sortAlerts(alerts: ExecutiveAlert[]): ExecutiveAlert[] {
  return [...alerts].sort((a, b) =>
    SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)
    || a.detected_at.localeCompare(b.detected_at)
    || a.id.localeCompare(b.id))
}

export function filterAlerts(alerts: ExecutiveAlert[], f: AlertFilter): ExecutiveAlert[] {
  const term = f.search.trim().toLowerCase()
  return alerts.filter((a) =>
    (f.severity === 'all' || a.severity === f.severity)
    && (f.type === 'all' || a.type === f.type)
    && (f.team === 'all' || a.team === f.team)
    && (!f.since || a.detected_at >= f.since)
    && (!term || `${a.title} ${a.reference} ${a.explanation}`.toLowerCase().includes(term)))
}

/** Merge alerts by id so a refresh never shows the same alert twice. */
export function dedupeAlerts(alerts: ExecutiveAlert[]): ExecutiveAlert[] {
  const seen = new Map<string, ExecutiveAlert>()
  for (const a of alerts) if (!seen.has(a.id)) seen.set(a.id, a)
  return [...seen.values()]
}

/** A client-side alert for a section whose data could not be refreshed. */
export function refreshFailedAlert(section: string, message: string, at: string): ExecutiveAlert {
  return {
    id: `REFRESH_FAILED:${section}`, type: 'REFRESH_FAILED', severity: 'HIGH', team: 'SYSTEM', title: `${section} data could not be refreshed`,
    reference: section, record_id: null, detected_at: at.slice(0, 10), explanation: message,
    action: 'Retry the refresh. Figures shown for this section may be out of date or missing.', link: '',
  }
}
