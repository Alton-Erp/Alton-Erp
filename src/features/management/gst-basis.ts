// GST-exclusive reporting basis of the dashboards (migration 20261209090000): shared wording, no data access.

/** Balances whose payments cannot be split into taxable value and GST (left out of GST-exclusive totals). */
export interface ReviewFlag { count: number; balance: number }

/** Wording shared by every dashboard. */
export const EXCL_GST_NOTE = 'All monetary values are in INR, excluding GST. Stock and outstanding balances are as of the current date and time.'
export const EXCL_GST_MISSING = 'GST-exclusive figures are not available until database update 20261209090000 is applied; amounts are not shown rather than mixing in GST.'

/** "2 part-paid invoice(s) (₹1,360.00 incl. GST) need review" — or null when nothing is flagged. */
export function reviewText(flag: ReviewFlag | undefined | null, what: string, money: (v: number) => string): string | null {
  if (!flag || !flag.count) return null
  return `${flag.count} ${what} (${money(flag.balance)} incl. GST) not included: payments are not split into taxable value and GST — review`
}
