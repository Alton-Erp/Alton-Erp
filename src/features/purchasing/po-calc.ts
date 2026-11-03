// Purchase order line and total calculation for the browser PREVIEW.
//
// The database (private.po_recalculate) is the source of truth: it recalculates
// and stores every amount when a draft is saved. This module uses the same
// formulas and rounding (exact decimal arithmetic, round half away from zero),
// so the preview and the saved order agree to the paisa:
//   gross    = round(qty x price, 2)
//   discount = round(gross x % / 100, 2), or the entered amount capped at gross
//   taxable  = gross - discount
//   INTRA_STATE: CGST = SGST = round(taxable x (rate / 2) / 100, 2); INTER_STATE: IGST = round(taxable x rate / 100, 2)
//   NO_GST / IMPORT / UNRESOLVED: no tax
//   grand    = sum of line totals, rounded to the rupee only when round-off is enabled

import type { PoLineType, PoTaxTreatment } from '@/types/database-purchasing'

type Dec = number | string | null | undefined

/** Parses a decimal into an integer scaled by 10^scale (half away from zero beyond the scale). null = invalid. */
export function toScaled(value: Dec, scale: number): bigint | null {
  if (value === null || value === undefined) return null
  const text = typeof value === 'number' ? (Number.isFinite(value) ? value.toString() : '') : value.trim()
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(text.includes('e') || text.includes('E') ? Number(text).toFixed(12) : text)
  if (!m || (m[2] === '' && (m[3] ?? '') === '')) return null
  const sign = m[1] === '-' ? -1n : 1n
  const frac = m[3] ?? ''
  const kept = (frac + '0'.repeat(scale)).slice(0, scale)
  let n = BigInt((m[2] || '0') + kept)
  if (frac.length > scale && Number(frac[scale]) >= 5) n += 1n
  return sign * n
}

/** n / d rounded half away from zero (d > 0). */
export function roundDiv(n: bigint, d: bigint): bigint {
  const q = n / d
  const r = n % d
  if (r === 0n) return q
  const twice = (r < 0n ? -r : r) * 2n
  return twice >= d ? q + (n < 0n ? -1n : 1n) : q
}

const paiseToNumber = (p: bigint) => Number(p) / 100

export interface CalcLineInput {
  line_type: PoLineType
  quantity: Dec
  unit_price: Dec
  discount_percent?: Dec
  discount_amount?: Dec
  gst_rate: Dec
}

export interface CalcLine {
  gross: number
  discount: number
  taxable: number
  cgstRate: number
  igstRate: number
  cgst: number
  sgst: number
  igst: number
  total: number
  /** Paise, for exact summing. */
  totalPaise: bigint
}

export function calcLine(l: CalcLineInput, treatment: PoTaxTreatment): CalcLine {
  const q = toScaled(l.quantity, 3) ?? 0n
  const p = toScaled(l.unit_price, 4) ?? 0n
  const gross = roundDiv(q * p, 100000n)
  const pct = toScaled(l.discount_percent, 2) ?? 0n
  let discount = pct > 0n ? roundDiv(gross * pct, 10000n) : (toScaled(l.discount_amount, 2) ?? 0n)
  if (discount > gross) discount = gross
  if (discount < 0n) discount = 0n
  const taxable = gross - discount
  const rate = toScaled(l.gst_rate, 2)
  let cgst = 0n
  let igst = 0n
  if (rate !== null && treatment === 'INTRA_STATE') cgst = roundDiv(taxable * rate, 20000n)
  if (rate !== null && treatment === 'INTER_STATE') igst = roundDiv(taxable * rate, 10000n)
  const totalPaise = taxable + 2n * cgst + igst
  const rateNum = rate === null ? 0 : Number(rate) / 100
  return {
    gross: paiseToNumber(gross), discount: paiseToNumber(discount), taxable: paiseToNumber(taxable),
    cgstRate: treatment === 'INTRA_STATE' && rate !== null ? rateNum / 2 : 0, igstRate: treatment === 'INTER_STATE' && rate !== null ? rateNum : 0,
    cgst: paiseToNumber(cgst), sgst: paiseToNumber(cgst), igst: paiseToNumber(igst), total: paiseToNumber(totalPaise), totalPaise,
  }
}

export interface CalcTotals {
  gross: number
  discount: number
  taxable: number
  otherCharges: number
  cgst: number
  sgst: number
  igst: number
  roundOff: number
  grand: number
}

export function calcTotals(lines: CalcLineInput[], treatment: PoTaxTreatment, roundOffEnabled = false): { lines: CalcLine[]; totals: CalcTotals } {
  const calc = lines.map((l) => calcLine(l, treatment))
  const sum = (f: (c: CalcLine, i: number) => number) => calc.reduce((s, c, i) => s + (toScaled(f(c, i).toFixed(2), 2) ?? 0n), 0n)
  const total = calc.reduce((s, c) => s + c.totalPaise, 0n)
  const grand = roundOffEnabled ? roundDiv(total, 100n) * 100n : total
  return {
    lines: calc,
    totals: {
      gross: paiseToNumber(sum((c) => c.gross)),
      discount: paiseToNumber(sum((c) => c.discount)),
      taxable: paiseToNumber(sum((c) => c.taxable)),
      otherCharges: paiseToNumber(sum((c, i) => (lines[i].line_type === 'CHARGE' ? c.taxable : 0))),
      cgst: paiseToNumber(sum((c) => c.cgst)),
      sgst: paiseToNumber(sum((c) => c.sgst)),
      igst: paiseToNumber(sum((c) => c.igst)),
      roundOff: paiseToNumber(grand - total),
      grand: paiseToNumber(grand),
    },
  }
}

/**
 * Tax treatment the database will apply (private.po_refresh_snapshots):
 * overseas supplier -> IMPORT; no supplier GSTIN -> NO_GST; no company GSTIN ->
 * UNRESOLVED; same GSTIN state -> INTRA_STATE; otherwise INTER_STATE.
 */
export function taxTreatmentFor(supplier: { gstin: string | null; country: string } | null, companyGstin: string | null | undefined): PoTaxTreatment {
  if (!supplier) return 'UNRESOLVED'
  if (supplier.country.trim().toLowerCase() !== 'india') return 'IMPORT'
  if (!supplier.gstin) return 'NO_GST'
  if (!companyGstin) return 'UNRESOLVED'
  return supplier.gstin.slice(0, 2) === companyGstin.slice(0, 2) ? 'INTRA_STATE' : 'INTER_STATE'
}
