import { useCallback, useEffect, useState } from 'react'

interface AsyncState<T> {
  data: T | undefined
  loading: boolean
  error: Error | null
}

/**
 * Runs an async loader whenever `deps` change and exposes loading/error state
 * plus a `reload` function. Stale responses from earlier runs are ignored.
 */
export function useAsync<T>(loader: () => Promise<T>, deps: readonly unknown[]) {
  const [state, setState] = useState<AsyncState<T>>({ data: undefined, loading: true, error: null })
  const [attempt, setAttempt] = useState(0)

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const load = useCallback(loader, deps)

  useEffect(() => {
    let cancelled = false
    setState((prev) => ({ ...prev, loading: true, error: null }))
    load().then(
      (data) => {
        if (!cancelled) setState({ data, loading: false, error: null })
      },
      (error: unknown) => {
        if (!cancelled) {
          setState({
            data: undefined,
            loading: false,
            error: error instanceof Error ? error : new Error(String(error)),
          })
        }
      },
    )
    return () => {
      cancelled = true
    }
  }, [load, attempt])

  const reload = useCallback(() => setAttempt((n) => n + 1), [])

  return { ...state, reload }
}
