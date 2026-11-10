// Product Master list cells: COST (the product Cost), HSN and GST, exactly as stored.

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 })

const blank = (v: unknown) => v === null || v === undefined || v === ''

/** Cost in rupees with two decimals; "—" when not entered. No other field is used instead. */
export const formatCost = (v: number | string | null | undefined): string => (blank(v) || !Number.isFinite(Number(v)) ? '—' : inr.format(Number(v)))

/** MRP in rupees with two decimals; "—" when not entered. Only the MRP field is used (never a price or cost). */
export const formatMrp = (v: number | string | null | undefined): string => formatCost(v)

/** The HSN code exactly as stored (leading zeros kept); null when missing. */
export const hsnText = (v: string | null | undefined): string | null => (blank(v) ? null : String(v))

/** The GST rate as a percentage (0% is a rate, not missing); null when missing. Never calculated or assumed. */
export const gstText = (v: number | string | null | undefined): string | null => (blank(v) || !Number.isFinite(Number(v)) ? null : `${Number(v)}%`)
