import { useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'

import { useAsync } from '@/hooks/use-async'
import { fetchPos } from '@/services/customer-po'

/**
 * Selects the PO a page works on (kept in ?po= so links and reloads keep it).
 * Lists current revisions that are not cancelled.
 */
export function usePoSelection(refreshKey = 0) {
  const [params, setParams] = useSearchParams()
  const pos = useAsync(() => fetchPos({ status: null, currentOnly: true }), [refreshKey])
  const options = useMemo(() => (pos.data ?? []).filter((p) => p.status !== 'CANCELLED'), [pos.data])
  const poId = params.get('po') ?? ''
  const selected = options.find((p) => p.id === poId) ?? null
  const select = (id: string) => setParams((prev) => {
    const next = new URLSearchParams(prev)
    next.set('po', id)
    return next
  }, { replace: true })
  return { poId, selected, options, loading: pos.loading, error: pos.error, select, reload: pos.reload }
}

