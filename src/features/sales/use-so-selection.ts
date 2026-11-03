import { useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'

import { useAsync } from '@/hooks/use-async'
import { fetchOrderOptions } from '@/services/sales'
import type { SalesOrderStatus } from '@/types/database-sales'

/**
 * Selects the sales order a page works on (kept in ?so= so links and reloads
 * keep it). `statuses` limits the selector (null = every order).
 */
export function useSoSelection(statuses: SalesOrderStatus[] | null, refreshKey = 0) {
  const [params, setParams] = useSearchParams()
  const key = statuses?.join(',') ?? ''
  const orders = useAsync(() => fetchOrderOptions(statuses), [key, refreshKey])
  const soId = params.get('so') ?? ''
  const options = useMemo(() => orders.data ?? [], [orders.data])
  const selected = options.find((o) => o.id === soId) ?? null
  const select = (id: string) => setParams((prev) => {
    const next = new URLSearchParams(prev)
    next.set('so', id)
    return next
  }, { replace: true })
  return { soId, selected, options, loading: orders.loading, error: orders.error, select, reload: orders.reload }
}
