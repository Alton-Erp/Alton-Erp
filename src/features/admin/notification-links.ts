/**
 * Notification links are stored by the database (approvals, imports, alerts).
 * Some point to modules that are no longer part of the V2 ERP (approvals,
 * Amazon, customer POs, analytics, system health). This maps each stored link
 * to a V2 page, or to null when there is no page to open; the notification
 * itself stays readable in the notification centre.
 */
const REPLACEMENTS: [RegExp, string][] = [
  [/^\/customers(\/.*)?$/, '/ledger/customers'],
  [/^\/suppliers(\/.*)?$/, '/ledger/suppliers'],
  [/^\/analytics(\/.*)?$/, '/'],
  [/^\/dashboard\/inventory$/, '/inventory'],
  [/^\/production\/analytics$/, '/production'],
  [/^\/settings$/, '/admin/erp-settings?tab=company'],
]

const REMOVED: RegExp[] = [
  /^\/admin\/(approvals|system-health|documents|barcodes|user-activity)(\/|\?|$)/,
  /^\/(amazon|customer-pos|marketplace-orders|activity|reconciliation|scan)(\/|\?|$)/,
  // Removed from the menu in the sidebar refinement.
  /^\/inventory\/(adjustments|counts|batches|reports)(\/|\?|$)/,
  /^\/production\/(outsourcing|outsourced-receipts)(\/|\?|$)/,
  /^\/sales\/(picking|packing|dispatch|delivery|returns|reports)(\/|\?|$)/,
]

export function resolveNotificationLink(link: string | null | undefined): string | null {
  if (!link || !link.startsWith('/') || link.startsWith('//')) return null
  const path = link.split(/[?#]/)[0]
  if (REMOVED.some((r) => r.test(link))) return null
  // The old warehouse view of an order now opens the sales order page.
  const so = /^\/sales\/order-details\?(?:.*&)?so=([0-9a-f-]+)/i.exec(link)
  if (so) return `/sales/orders/${so[1]}`
  if (path === '/sales/order-details') return '/sales/orders'
  for (const [pattern, target] of REPLACEMENTS) if (pattern.test(path)) return target
  return link
}
