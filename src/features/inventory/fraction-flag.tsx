import { isFractionalForUnit } from '@/features/inventory/whole-units'

/**
 * Marks a stored quantity of an item counted in whole pieces that is not a
 * whole number (posted before the whole-piece rule). The value itself is shown
 * unchanged next to it; it is never rounded or hidden.
 */
export function FractionFlag({ values, unit }: { values: (number | string | null | undefined)[]; unit: string | null | undefined }) {
  if (!values.some((v) => isFractionalForUnit(v, unit))) return null
  return (
    <span
      className="ml-1 rounded bg-amber-100 px-1 text-[10px] font-semibold uppercase text-amber-900"
      title={`Not a whole number of ${unit}. Reconcile it with a stock adjustment (see Inventory > Whole-piece audit).`}
    >
      fraction
    </span>
  )
}
