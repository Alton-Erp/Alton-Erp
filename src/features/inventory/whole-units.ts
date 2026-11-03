// Whole-piece quantity rules. Pure TypeScript (no React, no path aliases) so it
// can be unit-tested with Node. Mirrors the database policy in
// supabase/migrations/20261029090000_whole_piece_quantities.sql
// (private.whole_unit_codes / private.plan_qty); tests/unit/whole-units.test.ts
// fails if the unit lists drift apart. The database enforces every rule again.

/** Units counted in whole pieces (PCS, NOS, SET, PAIR and common aliases). */
export const WHOLE_UNIT_CODES = [
  'PCS', 'PC', 'PIECE', 'PIECES', 'NOS', 'NO', 'NUMBER', 'NUMBERS', 'EA', 'EACH', 'UNIT', 'UNITS', 'SET', 'SETS', 'PAIR', 'PAIRS', 'PR',
] as const

const WHOLE = new Set<string>(WHOLE_UNIT_CODES)

export function isWholeUnit(unit: string | null | undefined): boolean {
  return WHOLE.has((unit ?? '').trim().toUpperCase())
}

/** How a quantity must be entered, for messages: "whole PCS" or "up to 3 decimals". */
export function quantityRule(unit: string | null | undefined): string {
  return isWholeUnit(unit) ? `whole ${(unit ?? '').trim().toUpperCase()}` : 'up to 3 decimals'
}

/** Keyboard hint for a quantity input. */
export const qtyInputMode = (unit: string | null | undefined): 'numeric' | 'decimal' => (isWholeUnit(unit) ? 'numeric' : 'decimal')

/**
 * Parses a typed quantity by text (never by float comparison). Whole-piece
 * units accept only whole numbers ("10" or "10.0"); others up to 3 decimals.
 * Returns null when invalid; blank is invalid unless allowZero (then 0).
 */
export function parseUnitQty(value: string, unit: string | null | undefined, opts: { allowZero?: boolean } = {}): number | null {
  const v = value.trim().replace(/,/g, '')
  if (v === '') return opts.allowZero ? 0 : null
  const ok = isWholeUnit(unit) ? /^\d+(\.0+)?$/.test(v) : /^\d+(\.\d{1,3})?$/.test(v)
  if (!ok) return null
  const n = Number(v)
  if (n === 0) return opts.allowZero ? 0 : null
  return n
}

/** True for a stored quantity of a whole-piece item that is not a whole number (needs reconciliation). */
export function isFractionalForUnit(value: number | string | null | undefined, unit: string | null | undefined): boolean {
  if (value === null || value === undefined || value === '' || !isWholeUnit(unit)) return false
  const n = Number(value)
  return Number.isFinite(n) && !Number.isInteger(n)
}

const roundTo = (value: number, places: number) => Math.round(value * 10 ** places) / 10 ** places

/** Rounds UP to the 3 decimals stock is kept in (other units). */
export const ceil3 = (value: number) => Math.ceil(Math.round(value * 1e9) / 1e6) / 1000

/** Planned (procurement / issue) quantity: whole pieces rounded up, or 3 decimals rounded up. */
export function planQty(value: number, unit: string | null | undefined): number {
  return isWholeUnit(unit) ? Math.ceil(roundTo(value, 9)) : ceil3(value)
}

/**
 * Material requirement for a planned output (same formula as
 * private.bom_requirement_lines): wastage is applied BEFORE rounding.
 *   theoretical = quantity_required x planned / output_quantity           (3 dp, up)
 *   withWastage = theoretical x (1 + wastage% / 100)                        (3 dp, up)
 *   planned     = whole pieces rounded up (whole-piece units) or withWastage
 */
export function bomRequirement(
  quantityRequired: number,
  outputQuantity: number,
  plannedOutput: number,
  wastagePct: number,
  unit: string | null | undefined,
  available: number | null = null,
) {
  const whole = isWholeUnit(unit)
  const exact = whole
    ? (quantityRequired * plannedOutput) / outputQuantity
    : (quantityRequired / outputQuantity) * plannedOutput
  const exactWithWastage = whole
    ? (quantityRequired * plannedOutput * (100 + wastagePct)) / (100 * outputQuantity)
    : (quantityRequired / outputQuantity) * plannedOutput * (1 + wastagePct / 100)
  const theoretical = ceil3(exact)
  const withWastage = ceil3(exactWithWastage)
  const planned = whole ? Math.ceil(roundTo(exactWithWastage, 9)) : withWastage
  return {
    theoretical,
    wastage: roundTo(withWastage - theoretical, 3),
    planned,
    shortage: available === null ? null : Math.max(roundTo(planned - available, 3), 0),
  }
}
