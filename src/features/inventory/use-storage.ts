import { useMemo } from 'react'

import { useAsync } from '@/hooks/use-async'
import { fetchStorage } from '@/services/inventory'
import type { LocationRow, WarehouseRow } from '@/types/database-inventory'

export interface LocationOption {
  id: string
  warehouseId: string
  label: string
  active: boolean
  isDefault: boolean
  usage: LocationRow['stock_usage']
}

/** Warehouses and locations of the company with helper lookups. */
export function useStorage(refreshKey = 0) {
  const state = useAsync(fetchStorage, [refreshKey])
  const derived = useMemo(() => {
    const warehouses = state.data?.warehouses ?? []
    const locations = state.data?.locations ?? []
    const wh = new Map<string, WarehouseRow>(warehouses.map((w) => [w.id, w]))
    const loc = new Map<string, LocationRow>(locations.map((l) => [l.id, l]))
    const usageNote = (l: LocationRow) => (l.stock_usage === 'REJECTED' ? ' (rejected goods)' : l.stock_usage === 'EXTERNAL_PROCESSING' ? ` (at ${l.external_holder})` : l.stock_usage === 'QUARANTINE' ? ' (quarantine)' : '')
    const label = (l: LocationRow) => `${wh.get(l.warehouse_id)?.warehouse_code ?? '?'} / ${l.location_code} — ${l.location_name}${usageNote(l)}`
    const options: LocationOption[] = locations
      .map((l) => ({
        id: l.id,
        warehouseId: l.warehouse_id,
        label: label(l),
        active: l.status === 'ACTIVE' && wh.get(l.warehouse_id)?.status === 'ACTIVE',
        isDefault: l.is_default && Boolean(wh.get(l.warehouse_id)?.is_default),
        usage: l.stock_usage ?? 'STORAGE',
      }))
      .sort((a, b) => a.label.localeCompare(b.label))
    return {
      warehouses,
      locations,
      warehouseById: wh,
      locationById: loc,
      locationLabel: (id: string | null | undefined) => (id && loc.get(id) ? label(loc.get(id)!) : '—'),
      activeLocations: options.filter((o) => o.active),
      allLocations: options,
      defaultLocationId: options.find((o) => o.isDefault && o.active)?.id ?? null,
    }
  }, [state.data])
  return { ...state, ...derived }
}
