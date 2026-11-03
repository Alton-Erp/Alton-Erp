import { useSearchParams } from 'react-router-dom'

/** The consignment a page works on, kept in ?f= so links and reloads keep it. */
export function useFulfilmentSelection() {
  const [params, setParams] = useSearchParams()
  const fulfilmentId = params.get('f') ?? ''
  const select = (id: string) => setParams((prev) => {
    const next = new URLSearchParams(prev)
    if (id) next.set('f', id)
    else next.delete('f')
    return next
  }, { replace: true })
  return { fulfilmentId, select }
}
