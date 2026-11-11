import { useMemo } from 'react'

import { bomCost, type BomCost, type EditorLine } from '@/features/production/bom-tools-model'
import { useAsync } from '@/hooks/use-async'
import { fetchComponentInfo, type ComponentInfo } from '@/services/bom-tools'

/** Product Master Cost and available stock of the components on the lines (reloaded when the components change). */
export function useComponentInfo(lines: EditorLine[]) {
  const ids = useMemo(() => [...new Set(lines.map((l) => l.product?.product_id).filter((x): x is string => Boolean(x)))].sort(), [lines])
  const key = ids.join(',')
  const info = useAsync(() => fetchComponentInfo(key ? key.split(',') : []).catch(() => new Map<string, ComponentInfo>()), [key])
  return info.data ?? new Map<string, ComponentInfo>()
}

/** Material cost of the lines with the components' Product Master Cost. */
export function linesCost(lines: EditorLine[], output: string | number, info: Map<string, ComponentInfo>): BomCost {
  const filled = lines.filter((l) => l.product)
  return bomCost(filled.map((l) => ({ quantity: l.quantity, wastage: l.wastage || 0, unitCost: info.get(l.product!.product_id)?.unit_cost ?? null })), output)
}

