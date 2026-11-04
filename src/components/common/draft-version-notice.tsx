import { History, Loader2, RefreshCw } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { fetchDraftVersionCheck, refreshDraftVersions, type DraftKind } from '@/services/draft-versions'

const value = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : String(v))

/**
 * Shown on a draft that was made with older product / component / BOM versions
 * than the current ones. The draft keeps its versions (nothing changes silently);
 * the user may keep them or refresh to the latest.
 *
 * `onRefresh` replaces the server refresh (production orders: the choice is applied when the order is saved).
 */
export function DraftVersionNotice({ kind, id, enabled = true, onRefresh, onRefreshed, refreshed = false, onUndo }: {
  kind: DraftKind
  id: string | null | undefined
  enabled?: boolean
  onRefresh?: () => void
  onRefreshed?: () => void
  /** Controlled mode: the refresh was chosen and will be applied on save. */
  refreshed?: boolean
  onUndo?: () => void
}) {
  const [reload, setReload] = useState(0)
  const check = useAsync(() => (enabled && id ? fetchDraftVersionCheck(kind, id) : Promise.resolve(null)), [kind, id, enabled, reload])
  const [kept, setKept] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const items = check.data?.items ?? []
  if (!check.data?.stale || kept) return null

  if (refreshed) {
    return (
      <div role="status" data-testid="draft-version-notice" data-choice="latest" className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2.5 text-sm text-blue-900">
        <RefreshCw aria-hidden className="size-4" />
        <span className="flex-1">The latest versions will be used when you save. The previous plan is kept in the revision history.</span>
        {onUndo && <Button type="button" size="sm" variant="outline" onClick={onUndo}>Keep the current versions instead</Button>}
      </div>
    )
  }

  const refresh = async () => {
    if (onRefresh) return onRefresh()
    setBusy(true)
    setError(null)
    try {
      await refreshDraftVersions(kind, id!)
      setReload((n) => n + 1)
      onRefreshed?.()
    } catch (e) {
      setError(describeDataError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div role="status" data-testid="draft-version-notice" className="mb-4 space-y-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
      <p className="flex items-center gap-2 font-medium"><History aria-hidden className="size-4" /> Newer versions are available</p>
      <p>This draft keeps the versions it was made with; nothing changes unless you choose to refresh it.</p>
      <ul className="space-y-0.5">
        {items.map((i, n) => (
          <li key={`${i.product_id}-${i.field}-${n}`}>
            <span className="font-medium">{i.sku ?? '—'}</span> · {i.field}: {value(i.draft_value)} → {value(i.current_value)}
            {!i.refreshable && <span className="text-xs"> (a commercial term: change it on the line if needed)</span>}
          </li>
        ))}
      </ul>
      {error && <p role="alert" className="text-red-800">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" onClick={() => setKept(true)}>Keep the draft&apos;s versions</Button>
        {items.some((i) => i.refreshable) && (
          <Button type="button" size="sm" onClick={() => void refresh()} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : <RefreshCw />} Refresh to the latest versions
          </Button>
        )}
      </div>
    </div>
  )
}
