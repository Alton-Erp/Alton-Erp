/**
 * Shared domain types used by the UI. Database row types live in
 * ./database.ts and ./database-inventory.ts.
 */

export type OrderStatus =
  | 'draft'
  | 'pending'
  | 'confirmed'
  | 'in_production'
  | 'shortage'
  | 'partially_dispatched'
  | 'dispatched'
  | 'delivered'
  | 'cancelled'

export type SalesChannel = 'direct' | 'dealer' | 'marketplace' | 'project'

export type DateRangePreset = 'today' | 'this_week' | 'last_7_days' | 'this_month' | 'last_month' | 'this_year' | 'previous_year' | 'custom'

export interface DateRangeValue {
  preset: DateRangePreset
  from: Date
  to: Date
}

/** Sales order summary (sample data until the sales order module is built). */
export interface SalesOrderSummary {
  id: string
  orderNumber: string
  customerName: string
  channel: SalesChannel
  orderDate: string // ISO date (yyyy-mm-dd)
  lineCount: number
  totalAmount: number
  status: OrderStatus
}

/**
 * Every service call reports whether its payload is development sample data
 * so the UI can label it. Real (Supabase) results set `isSample: false`.
 */
export interface ServiceResult<T> {
  data: T
  isSample: boolean
}
