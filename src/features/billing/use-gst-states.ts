import { useMemo } from 'react'

import { useAsync } from '@/hooks/use-async'
import { fetchGstStates } from '@/services/billing'

/** GST state / UT codes from the database (single source of truth). */
export function useGstStates() {
  const states = useAsync(fetchGstStates, [])
  const byCode = useMemo(() => new Map((states.data ?? []).map((s) => [s.code, s.name])), [states.data])
  const label = (code: string | null | undefined) => (code ? `${code} — ${byCode.get(code) ?? 'unknown'}` : '—')
  return { states: states.data ?? [], loading: states.loading, label }
}
