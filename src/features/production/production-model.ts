// Production & outsourcing labels and pure helpers (unit-testable with Node).
import { bomRequirement, isWholeUnit, parseUnitQty } from '../inventory/whole-units.ts'

export const BOM_STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Draft',
  PENDING_APPROVAL: 'Pending approval',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  ARCHIVED: 'Archived',
}

export const PRODUCTION_STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Draft',
  PENDING_APPROVAL: 'Pending approval',
  APPROVED: 'Approved',
  MATERIALS_RESERVED: 'Materials reserved',
  IN_PROGRESS: 'In progress',
  PARTIALLY_COMPLETED: 'Partially completed',
  COMPLETED: 'Completed',
  ON_HOLD: 'On hold',
  CANCELLED: 'Cancelled',
}

export const OUTSOURCING_STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Draft',
  PENDING_APPROVAL: 'Pending approval',
  APPROVED: 'Approved',
  MATERIALS_DISPATCHED: 'Materials dispatched',
  PARTIALLY_RECEIVED: 'Partially received',
  COMPLETED: 'Completed',
  ON_HOLD: 'On hold',
  CANCELLED: 'Cancelled',
}

export const OUTSOURCING_TYPE_LABELS: Record<string, string> = {
  OUTSOURCED_FINISHED_GOODS: 'Finished goods (bought-in)',
  OUTSOURCED_PROCESSING: 'Processing of company material',
}

export const PRIORITY_LABELS: Record<string, string> = { LOW: 'Low', NORMAL: 'Normal', HIGH: 'High', URGENT: 'Urgent' }

export const QUALITY_STATUS_LABELS: Record<string, string> = {
  NOT_INSPECTED: 'Not inspected',
  ACCEPTED: 'Accepted',
  ACCEPTED_WITH_DEVIATION: 'Accepted with deviation',
}

export const DISPOSITION_LABELS: Record<string, string> = {
  RETURN_TO_SUPPLIER: 'Return to supplier',
  HELD_FOR_REWORK: 'Held for rework',
  SCRAP: 'Scrap (to be written off)',
  PENDING_DECISION: 'Pending decision',
}

export const REQUIREMENT_STATUS_LABELS: Record<string, string> = {
  SUFFICIENT: 'Sufficient',
  PARTIAL: 'Partially available',
  SHORTAGE: 'Shortage',
  INACTIVE: 'Inactive material',
  UNIT_MISMATCH: 'Unit conversion error',
  RESERVED: 'Reserved',
  ISSUED: 'Issued',
}

export const MATERIAL_STATUS_LABELS: Record<string, string> = {
  NOT_ISSUED: 'Not issued',
  PARTIALLY_ISSUED: 'Partially issued',
  FULLY_ISSUED: 'Fully issued',
}

export const EVENT_LABELS: Record<string, string> = {
  CREATED: 'Created',
  UPDATED: 'Edited',
  SUBMIT: 'Submitted for approval',
  WITHDRAW: 'Withdrawn',
  APPROVE: 'Approved',
  REJECT: 'Rejected',
  START: 'Production started',
  HOLD: 'Put on hold',
  RESUME: 'Resumed',
  CANCEL: 'Cancelled',
  COMPLETE: 'Completed',
  MATERIALS_RESERVED: 'Materials reserved',
  RESERVATIONS_RELEASED: 'Reservations released',
  MATERIALS_ISSUED: 'Materials issued',
  ISSUE_REVERSED: 'Material issue reversed',
  OUTPUT_RECEIVED: 'Output received',
  OUTPUT_REVERSED: 'Output receipt reversed',
  PRODUCTION_RECORDED: 'Production recorded (materials consumed, goods received)',
  PRODUCTION_REVERSED: 'Production reversed',
  PRODUCTION_CORRECTED: 'Production corrected',
  REOPENED: 'Reopened',
  MATERIALS_DISPATCHED: 'Materials sent to supplier',
  MATERIALS_RETURNED: 'Materials returned by supplier',
  GOODS_RECEIVED: 'Goods received',
  RECEIPT_REVERSED: 'Receipt reversed',
  // Customer PO events
  IMPORTED: 'PO imported',
  REVISION_IMPORTED: 'Revision imported',
  SUPERSEDED: 'Superseded by a new revision',
  STATUS_CHANGED: 'Status changed',
  REMATCHED: 'Matching re-run',
  LINE_MATCH: 'Line matched manually',
  LINE_CONFIRM_DUPLICATE: 'Duplicate confirmed as separate demand',
  LINE_EXCLUDE: 'Line excluded',
  LINE_RESTORE: 'Line restored',
  LINE_FLAG_NEW_PRODUCT: 'Line flagged for new product',
  LINE_UNFLAG: 'New-product flag removed',
  LINE_CORRECT: 'Line corrected',
  ALLOCATED: 'Stock allocated',
  PLAN_SAVED: 'Allocation plan saved (draft)',
  RESERVATIONS_RELEASED_PO: 'Allocation released',
  DISPATCHED: 'Dispatched',
  DISPATCH_REVERSED: 'Dispatch reversed',
  HEADER_UPDATED: 'PO details updated',
  SHORTAGE_UPDATED: 'Shortage follow-up updated',
}

export const DISCREPANCY_LABELS: Record<string, string> = {
  OUTPUT_SHORT: 'Output below plan',
  MATERIAL_UNDER_ISSUED: 'Material issued below standard for the output',
  RECEIPT_SHORT: 'Received less than ordered',
  MATERIAL_HELD: 'Company material still at the supplier',
}

/** Statuses from which each production action is offered (mirrors the server rules). */
export const PRODUCTION_ACTION_FROM: Record<string, string[]> = {
  SUBMIT: ['DRAFT'],
  WITHDRAW: ['PENDING_APPROVAL'],
  APPROVE: ['PENDING_APPROVAL'],
  REJECT: ['PENDING_APPROVAL'],
  START: ['APPROVED', 'MATERIALS_RESERVED'],
  HOLD: ['APPROVED', 'MATERIALS_RESERVED', 'IN_PROGRESS', 'PARTIALLY_COMPLETED'],
  RESUME: ['ON_HOLD'],
  CANCEL: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'MATERIALS_RESERVED', 'IN_PROGRESS', 'ON_HOLD'],
  COMPLETE: ['IN_PROGRESS', 'PARTIALLY_COMPLETED'],
  RESERVE: ['APPROVED', 'MATERIALS_RESERVED', 'IN_PROGRESS', 'PARTIALLY_COMPLETED'],
  ISSUE: ['IN_PROGRESS', 'PARTIALLY_COMPLETED'],
  OUTPUT: ['IN_PROGRESS', 'PARTIALLY_COMPLETED'],
}

export const OUTSOURCING_ACTION_FROM: Record<string, string[]> = {
  SUBMIT: ['DRAFT'],
  WITHDRAW: ['PENDING_APPROVAL'],
  APPROVE: ['PENDING_APPROVAL'],
  REJECT: ['PENDING_APPROVAL'],
  HOLD: ['APPROVED', 'MATERIALS_DISPATCHED', 'PARTIALLY_RECEIVED'],
  RESUME: ['ON_HOLD'],
  CANCEL: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'MATERIALS_DISPATCHED', 'PARTIALLY_RECEIVED', 'ON_HOLD'],
  COMPLETE: ['APPROVED', 'MATERIALS_DISPATCHED', 'PARTIALLY_RECEIVED'],
  DISPATCH: ['APPROVED', 'MATERIALS_DISPATCHED', 'PARTIALLY_RECEIVED'],
  RETURN: ['APPROVED', 'MATERIALS_DISPATCHED', 'PARTIALLY_RECEIVED', 'COMPLETED', 'ON_HOLD', 'CANCELLED'],
  RECEIVE: ['APPROVED', 'MATERIALS_DISPATCHED', 'PARTIALLY_RECEIVED'],
}

export const canDo = (table: Record<string, string[]>, action: string, status: string) => (table[action] ?? []).includes(status)

/** Rounds a quantity UP to the 3 decimals stock is kept in (never understates a requirement). */
export { ceil3 as ceilQty } from '../inventory/whole-units.ts'

/**
 * Material requirement for a planned output (same formula as the database,
 * private.bom_requirement_lines). Wastage is applied before rounding; whole-piece
 * units (PCS, NOS, SET, PAIR) are then rounded UP to whole pieces:
 *   base      theoretical requirement from the BOM ratio (3 dp) — not physical stock
 *   allowance theoretical wastage
 *   total     planned quantity to procure / issue
 */
export function requirement(quantityRequired: number, outputQuantity: number, planned: number, wastagePct: number, available: number | null, unit?: string | null) {
  const r = bomRequirement(quantityRequired, outputQuantity, planned, wastagePct, unit, available)
  return { base: r.theoretical, allowance: r.wastage, total: r.planned, shortage: r.shortage }
}

/** Quantity that may be zero (blank = 0): whole numbers for whole-piece units, else up to 3 decimals; null when invalid. */
export function parseNonNegativeQty(value: string, unit?: string | null): number | null {
  return parseUnitQty(value, unit, { allowZero: true })
}

/**
 * Validates one BOM component line as entered in the editor. Returns a message or null.
 * Whole-piece components need whole pieces per BOM batch (e.g. 1 washer per 2 units:
 * component 1, output quantity 2) so the BOM can be submitted.
 */
export function validateBomLine(line: { quantity: string; wastage: string; unit?: string | null }, maxDecimals = 6): string | null {
  const q = line.quantity.trim()
  if (!/^\d+(\.\d+)?$/.test(q) || Number(q) <= 0) return 'Quantity must be greater than zero.'
  if (isWholeUnit(line.unit) && !/^\d+(\.0+)?$/.test(q)) {
    return `Enter whole ${line.unit?.toUpperCase()} per BOM batch. For a fraction per finished unit, raise the BOM output quantity instead (1 per 2 units = 1 per output of 2).`
  }
  if ((q.split('.')[1]?.length ?? 0) > maxDecimals) return `Quantity allows at most ${maxDecimals} decimals.`
  const w = line.wastage.trim() === '' ? '0' : line.wastage.trim()
  if (!/^\d+(\.\d{1,2})?$/.test(w)) return 'Wastage must be a number with up to 2 decimals.'
  if (Number(w) >= 100) return 'Wastage must be below 100%.'
  return null
}
