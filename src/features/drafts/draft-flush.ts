/**
 * Open forms register a flush function so pending drafts can be saved before the
 * user signs out (the sign-out then clears the browser copies the server holds).
 */
const flushers = new Map<symbol, () => Promise<void>>()

export function registerDraftFlush(fn: () => Promise<void>): () => void {
  const id = Symbol('draft')
  flushers.set(id, fn)
  return () => void flushers.delete(id)
}

/** Saves every open form's pending changes; gives up after `timeoutMs`. */
export async function flushAllDrafts(timeoutMs = 3000): Promise<void> {
  const all = Promise.allSettled([...flushers.values()].map((f) => f()))
  await Promise.race([all, new Promise((r) => setTimeout(r, timeoutMs))])
}

export function browserStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null
  } catch {
    return null
  }
}
