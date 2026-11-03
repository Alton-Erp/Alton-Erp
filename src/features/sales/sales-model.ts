import type { Tone } from '@/config/status'

/** Labels and tones for Phase 7 statuses (colors: green ready, blue pick/pack, purple transit, orange pending/exception, red failure). */
export const ORDER_STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Draft',
  PENDING_CONFIRMATION: 'Awaiting confirmation',
  CONFIRMED: 'Confirmed (not allocated)',
  PARTIALLY_ALLOCATED: 'Partially allocated',
  READY_FOR_FULFILMENT: 'Ready for fulfilment',
  IN_FULFILMENT: 'In fulfilment',
  PARTIALLY_FULFILLED: 'Partially fulfilled',
  FULFILLED: 'Fulfilled',
  ON_HOLD: 'On hold',
  CANCELLED: 'Cancelled',
}

export const ORDER_STATUS_TONE: Record<string, Tone> = {
  DRAFT: 'neutral',
  PENDING_CONFIRMATION: 'warning',
  CONFIRMED: 'warning',
  PARTIALLY_ALLOCATED: 'warning',
  READY_FOR_FULFILMENT: 'success',
  IN_FULFILMENT: 'info',
  PARTIALLY_FULFILLED: 'info',
  FULFILLED: 'success',
  ON_HOLD: 'warning',
  CANCELLED: 'neutral',
}

export const ORDER_FULFILMENT_LABELS: Record<string, string> = {
  NOT_STARTED: 'Not started',
  IN_PROGRESS: 'Picking / packing',
  PARTIALLY_DISPATCHED: 'Partially dispatched',
  DISPATCHED: 'Dispatched',
  PARTIALLY_DELIVERED: 'Partially delivered',
  DELIVERED: 'Delivered',
}

export const FULFILMENT_STATUS_LABELS: Record<string, string> = {
  PENDING: 'To pick',
  PICKING: 'Picking',
  PICKED: 'Picked',
  PACKING: 'Packing',
  PACKED: 'Packed',
  READY_FOR_DISPATCH: 'Ready for dispatch',
  DISPATCHED: 'Dispatched',
  IN_TRANSIT: 'In transit',
  PARTIALLY_DELIVERED: 'Partially delivered',
  DELIVERED: 'Delivered',
  DELIVERY_EXCEPTION: 'Delivery exception',
  CANCELLED: 'Cancelled',
}

export const FULFILMENT_STATUS_TONE: Record<string, Tone> = {
  PENDING: 'info',
  PICKING: 'info',
  PICKED: 'info',
  PACKING: 'info',
  PACKED: 'info',
  READY_FOR_DISPATCH: 'success',
  DISPATCHED: 'outsourced',
  IN_TRANSIT: 'outsourced',
  PARTIALLY_DELIVERED: 'outsourced',
  DELIVERED: 'success',
  DELIVERY_EXCEPTION: 'danger',
  CANCELLED: 'neutral',
}

export const LINE_STATUS_LABELS: Record<string, string> = { OPEN: 'Open', PARTIALLY_FULFILLED: 'Partially dispatched', FULFILLED: 'Dispatched', CANCELLED: 'Cancelled' }

export const PRIORITY_LABELS: Record<string, string> = { LOW: 'Low', NORMAL: 'Normal', HIGH: 'High', URGENT: 'Urgent' }

export const TRANSPORT_MODE_LABELS: Record<string, string> = {
  ROAD: 'Road',
  RAIL: 'Rail',
  AIR: 'Air',
  SEA: 'Sea',
  COURIER: 'Courier',
  CUSTOMER_PICKUP: 'Customer pickup',
  OTHER: 'Other',
}

export const DELIVERY_EVENT_LABELS: Record<string, string> = {
  DISPATCHED: 'Dispatched',
  PICKED_UP: 'Picked up by carrier',
  IN_TRANSIT: 'In transit',
  ARRIVED: 'Arrived at destination',
  OUT_FOR_DELIVERY: 'Out for delivery',
  PARTIALLY_DELIVERED: 'Partially delivered',
  DELIVERED: 'Delivered',
  DELIVERY_FAILED: 'Delivery failed',
  RETURNED_TO_SENDER: 'Returned to sender',
  EXCEPTION: 'Other exception',
}

export const RETURN_STATUS_LABELS: Record<string, string> = {
  REQUESTED: 'Requested',
  AUTHORIZED: 'Authorised',
  RECEIVED: 'Received (quarantine)',
  UNDER_INSPECTION: 'Under inspection',
  ACCEPTED: 'Accepted',
  REJECTED: 'Rejected',
  CLOSED: 'Closed',
}

export const RETURN_STATUS_TONE: Record<string, Tone> = {
  REQUESTED: 'warning',
  AUTHORIZED: 'info',
  RECEIVED: 'warning',
  UNDER_INSPECTION: 'warning',
  ACCEPTED: 'success',
  REJECTED: 'danger',
  CLOSED: 'neutral',
}

export const RETURN_REASON_LABELS: Record<string, string> = {
  DAMAGED_IN_TRANSIT: 'Damaged in transit',
  DEFECTIVE: 'Defective',
  WRONG_ITEM: 'Wrong item',
  EXCESS_QUANTITY: 'Excess quantity',
  NOT_REQUIRED: 'No longer required',
  DELIVERY_REFUSED: 'Delivery refused',
  OTHER: 'Other',
}

export const DISPOSITION_LABELS: Record<string, string> = {
  RESTOCK: 'Restock (sellable)',
  QUARANTINE: 'Keep in quarantine',
  REPAIR: 'Repair',
  SCRAP: 'Scrap (rejected location)',
  RETURN_TO_CUSTOMER: 'Return to customer',
  PENDING_REVIEW: 'Pending review',
}

export const SALES_EVENT_LABELS: Record<string, string> = {
  CREATED_FROM_PO: 'Sales order created from customer PO',
  CREATED_MANUALLY: 'Sales order created manually',
  CONFIRMED: 'Confirmed',
  UPDATED: 'Order details updated',
  HOLD: 'Put on hold',
  RESUME: 'Resumed',
  STATUS_CHANGED: 'Status changed',
  ALLOCATED: 'Stock allocated',
  RESERVATIONS_RELEASED: 'Reservations released',
  BACKORDER_UPDATED: 'Backorder details updated',
  LINE_QUANTITY_REDUCED: 'Quantity reduced (customer approved)',
  FULFILMENT_CREATED: 'Pick list created',
  PICK_RECORDED: 'Picking recorded',
  PICKING_COMPLETED: 'Picking completed',
  PACK_RECORDED: 'Packing recorded',
  PACKING_COMPLETED: 'Packing completed',
  FULFILMENT_READY: 'Ready for dispatch',
  FULFILMENT_REOPEN_PACKING: 'Packing reopened',
  FULFILMENT_REOPEN_PICKING: 'Picking reopened',
  FULFILMENT_CANCEL: 'Fulfilment cancelled',
  DISPATCHED: 'Dispatched (stock issued)',
  RETURN_REQUESTED: 'Return requested',
  RETURN_AUTHORIZED: 'Return authorised',
  RETURN_REJECTED: 'Return rejected',
  RETURN_RECEIVED: 'Return received into quarantine',
  RETURN_INSPECTION_SAVED: 'Return inspection saved',
  RETURN_ACCEPTED: 'Return inspection accepted',
  RETURN_CLOSED: 'Return dispositions posted',
  CANCELLED: 'Order cancelled',
  ...Object.fromEntries(Object.entries(DELIVERY_EVENT_LABELS).map(([k, v]) => [`DELIVERY_${k}`, `Delivery: ${v.toLowerCase()}`])),
}

/** Fulfilment statuses before dispatch (still open pick lists). */
export const OPEN_FULFILMENT_STATUSES = ['PENDING', 'PICKING', 'PICKED', 'PACKING', 'PACKED', 'READY_FOR_DISPATCH'] as const
/** Fulfilment statuses after dispatch. */
export const SHIPPED_STATUSES = ['DISPATCHED', 'IN_TRANSIT', 'PARTIALLY_DELIVERED', 'DELIVERED', 'DELIVERY_EXCEPTION'] as const
/** Order statuses that allow allocation and fulfilment work. */
export const WORKABLE_ORDER_STATUSES = ['CONFIRMED', 'PARTIALLY_ALLOCATED', 'READY_FOR_FULFILMENT', 'IN_FULFILMENT', 'PARTIALLY_FULFILLED'] as const

export const DISPATCH_FIELD_LABELS: Record<string, string> = {
  carrier_name: 'Carrier / transporter',
  transport_mode: 'Transport mode',
  vehicle_number: 'Vehicle number',
  lr_number: 'LR / consignment note',
  tracking_number: 'Tracking number',
  eway_bill_number: 'E-way bill number',
}

/** Page where a consignment is worked on next. */
export const fulfilmentPath = (f: { id: string; fulfilment_status: string }) => {
  if (['PENDING', 'PICKING'].includes(f.fulfilment_status)) return `/sales/picking?f=${f.id}`
  if (['PICKED', 'PACKING', 'PACKED'].includes(f.fulfilment_status)) return `/sales/packing?f=${f.id}`
  if (f.fulfilment_status === 'READY_FOR_DISPATCH') return `/sales/dispatch?f=${f.id}`
  return `/sales/delivery?f=${f.id}`
}

export const statusText =(s: string | null | undefined) => (s ? s.replace(/_/g, ' ').toLowerCase() : '')

/** Parses a user-entered quantity (empty = 0). Returns null when invalid. */
export function parseQty(value: string): number | null {
  const v = value.trim()
  if (v === '') return 0
  if (!/^\d+(\.\d{1,3})?$/.test(v)) return null
  return Number(v)
}
