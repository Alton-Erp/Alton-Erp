import type { Severity } from '@/services/admin'

export const SEVERITY_DOT: Record<Severity, string> = {
  INFO: 'bg-blue-500', LOW: 'bg-blue-500', MEDIUM: 'bg-amber-500', HIGH: 'bg-red-500', CRITICAL: 'bg-red-700',
}
export const SEVERITY_TONE: Record<Severity, 'info' | 'warning' | 'danger' | 'neutral'> = {
  INFO: 'info', LOW: 'info', MEDIUM: 'warning', HIGH: 'danger', CRITICAL: 'danger',
}

/** Notification types a user can switch off (approval work assigned to you cannot be muted). */
export const NOTIFICATION_TYPES: { type: string; label: string; group: string; mandatory?: boolean }[] = [
  { type: 'APPROVAL_REQUESTED', label: 'Approval requests assigned to me', group: 'Approvals', mandatory: true },
  { type: 'APPROVAL_ESCALATED', label: 'Overdue approvals escalated to my role', group: 'Approvals', mandatory: true },
  { type: 'APPROVAL_APPROVED', label: 'My requests approved', group: 'Approvals' },
  { type: 'APPROVAL_REJECTED', label: 'My requests rejected', group: 'Approvals' },
  { type: 'APPROVAL_CANCELLED', label: 'My requests cancelled (document changed)', group: 'Approvals' },
  { type: 'ALERT_SO_SHORTAGE', label: 'Stock shortages on open orders', group: 'Alerts' },
  { type: 'ALERT_LOW_STOCK', label: 'Low stock', group: 'Alerts' },
  { type: 'ALERT_ZERO_STOCK', label: 'No available stock', group: 'Alerts' },
  { type: 'ALERT_PRODUCTION_DELAYED', label: 'Production delays', group: 'Alerts' },
  { type: 'ALERT_OUTSOURCING_OVERDUE', label: 'Outsourcing deadlines', group: 'Alerts' },
  { type: 'ALERT_PO_UNMATCHED', label: 'Purchase-order matching exceptions', group: 'Alerts' },
  { type: 'ALERT_PO_UNALLOCATED', label: 'Purchase orders awaiting allocation', group: 'Alerts' },
  { type: 'ALERT_AWAITING_DISPATCH', label: 'Consignments awaiting dispatch', group: 'Alerts' },
  { type: 'ALERT_INVOICE_DUE_SOON', label: 'Invoices approaching due date', group: 'Alerts' },
  { type: 'ALERT_INVOICE_OVERDUE', label: 'Overdue receivables', group: 'Alerts' },
  { type: 'ALERT_PAYMENT_UNALLOCATED', label: 'Payments needing allocation', group: 'Alerts' },
  { type: 'ALERT_INVENTORY_DISCREPANCY', label: 'Stock counts and adjustments awaiting approval', group: 'Alerts' },
  { type: 'IMPORT_FAILED_ROWS', label: 'Imports with rejected rows', group: 'System' },
  { type: 'SYSTEM_ERROR', label: 'Application errors (administrators)', group: 'System' },
]

export const NOTIFICATION_GROUP_FILTERS: { value: string; label: string }[] = [
  { value: 'APPROVAL_*', label: 'Approvals' }, { value: 'ALERT_*', label: 'Alerts' }, { value: 'IMPORT_*', label: 'Imports' }, { value: 'SYSTEM_*', label: 'System' },
]

/** Fired after notifications are read or dismissed so the bell refreshes. */
export const NOTIFICATIONS_CHANGED = 'alton:notifications-changed'
