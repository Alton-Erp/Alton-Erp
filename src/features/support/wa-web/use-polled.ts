import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Loads data and reloads it every `intervalMs` while the tab is visible (and when it becomes visible again).
 * WhatsApp tables have no client grants (everything goes through permission-checked functions), so Supabase
 * Realtime cannot stream them; polling is the update mechanism. A failed poll keeps the last good data and
 * reports the error, so the screen never blanks out. Data loaded for other `deps` is never shown.
 */
export function usePolled<T>(loader: () => Promise<T>, deps: readonly unknown[], intervalMs: number) {
  const key = JSON.stringify(deps)
  const [state, setState] = useState<{ key: string; data?: T; error: Error | null }>({ key: '', error: null })
  const ref = useRef(loader)
  const again = useRef<(() => void) | null>(null)
  useEffect(() => { ref.current = loader })
  useEffect(() => {
    let live = true
    let sent = 0
    let shown = 0
    const go = () => {
      const n = ++sent
      ref.current().then(
        (data) => { if (live && n > shown) { shown = n; setState({ key, data, error: null }) } },
        (e: unknown) => {
          if (live && n > shown) setState((s) => ({ key, data: s.key === key ? s.data : undefined, error: e instanceof Error ? e : new Error(String(e)) }))
        },
      )
    }
    again.current = go
    go()
    const tick = () => { if (document.visibilityState === 'visible') go() }
    const t = window.setInterval(tick, intervalMs)
    document.addEventListener('visibilitychange', tick)
    return () => { live = false; window.clearInterval(t); document.removeEventListener('visibilitychange', tick) }
  }, [key, intervalMs])
  const reload = useCallback(() => again.current?.(), [])
  const mine = state.key === key
  const data = mine ? state.data : undefined
  const error = mine ? state.error : null
  return { data, error, loading: data === undefined && !error, reload }
}
