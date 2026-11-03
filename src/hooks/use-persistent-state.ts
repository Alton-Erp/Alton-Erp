import { useEffect, useState } from 'react'

/** useState backed by localStorage; falls back to memory if storage is unavailable. */
export function usePersistentState<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = window.localStorage.getItem(key)
      return stored === null ? initial : (JSON.parse(stored) as T)
    } catch {
      return initial
    }
  })

  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(value))
    } catch {
      // Storage may be blocked (private mode); the in-memory value still works.
    }
  }, [key, value])

  return [value, setValue] as const
}
