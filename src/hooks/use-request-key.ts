import { useCallback, useState } from 'react'

/**
 * Idempotency key for one user action. The same key is reused if the user
 * retries after an error (so a request that actually succeeded is not posted
 * twice); call `renew()` after a confirmed success to start a new action.
 */
export function useRequestKey() {
  const [key, setKey] = useState(() => crypto.randomUUID())
  const renew = useCallback(() => setKey(crypto.randomUUID()), [])
  return { key, renew }
}
