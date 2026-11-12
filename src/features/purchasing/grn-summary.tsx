import { money } from '@/features/billing/billing-model'
import { formatQty } from '@/features/inventory/inventory-model'
import type { GrnTotals } from '@/features/purchasing/grn-price'

/**
 * Live totals of a goods receipt before posting: accepted quantity per unit (goods only; units are never
 * added together), taxable value, CGST, SGST, IGST, total GST and the amount including GST.
 */
export function GrnSummary({ totals, note }: { totals: GrnTotals; note?: string }) {
  const rows: [string, string, string][] = [
    ['Total taxable value', money(totals.taxable), 'taxable'],
    ['Total CGST', money(totals.cgst), 'cgst'],
    ['Total SGST', money(totals.sgst), 'sgst'],
    ['Total IGST', money(totals.igst), 'igst'],
    ['Total GST', money(totals.gst), 'gst'],
  ]
  return (
    <section aria-label="GRN totals" data-testid="grn-summary" className="rounded-lg border bg-surface-muted/40 p-3">
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <div>
          <p className="text-xs font-medium text-muted-foreground">Total accepted quantity</p>
          <p className="mt-1 text-base font-semibold tabular-nums" data-testid="grn-summary-qty">
            {totals.quantities.length === 0 ? '—' : totals.quantities.map((q) => formatQty(q.quantity, q.unit)).join(' · ')}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">Goods only, per unit of measurement (different units are not added together).</p>
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
          {rows.map(([label, value, key]) => (
            <div key={key} className="contents"><dt className="text-muted-foreground">{label}</dt><dd className="text-right tabular-nums" data-testid={`grn-summary-${key}`}>{value}</dd></div>
          ))}
          <dt className="border-t pt-1 font-semibold">Grand total incl. GST</dt>
          <dd className="border-t pt-1 text-right text-base font-semibold tabular-nums" data-testid="grn-summary-total">{money(totals.total)}</dd>
        </dl>
      </div>
      {(totals.unvalued > 0 || note) && (
        <p className="mt-2 text-xs text-amber-900">
          {totals.unvalued > 0 ? `${totals.unvalued} line(s) without a unit cost are not included in the amounts. ` : ''}{note ?? ''}
        </p>
      )}
    </section>
  )
}
