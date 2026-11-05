import { useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'

/**
 * A list filter (status tab, view, page …) kept in the address, so the browser Back button returns to
 * the same filtered list after opening a record. Unknown values in the address fall back to the default.
 * The default is not written to the address (clean links).
 */
export function useUrlEnum<T extends string>(name: string, allowed: readonly T[], fallback: T, resetKeys: readonly string[] = []): [T, (v: T) => void] {
  const [params, setParams] = useSearchParams()
  const raw = params.get(name)
  const value = raw !== null && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback
  const set = useCallback((v: T) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      if (v === fallback) next.delete(name)
      else next.set(name, v)
      // e.g. the page number: one address update (two in the same moment would overwrite each other).
      for (const k of resetKeys) next.delete(k)
      return next
    }, { replace: true })
  }, [name, fallback, setParams, resetKeys])
  return [value, set]
}

/** A free-text or id filter kept in the address ('' / fallback removes it). */
export function useUrlString(name: string, fallback = ''): [string, (v: string) => void] {
  const [params, setParams] = useSearchParams()
  const value = params.get(name) ?? fallback
  const set = useCallback((v: string) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      if (v === fallback || v === '') next.delete(name)
      else next.set(name, v)
      return next
    }, { replace: true })
  }, [name, fallback, setParams])
  return [value, set]
}

/** A page number kept in the address (0-based in code, ?page=N shown from 1). */
export function useUrlPage(name = 'page'): [number, (v: number) => void] {
  const [params, setParams] = useSearchParams()
  const n = Number(params.get(name))
  const value = Number.isInteger(n) && n >= 1 ? n - 1 : 0
  const set = useCallback((v: number) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      if (v <= 0) next.delete(name)
      else next.set(name, String(v + 1))
      return next
    }, { replace: true })
  }, [name, setParams])
  return [value, set]
}
