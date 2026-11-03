import { useAsync } from '@/hooks/use-async'
import { EVENT_LABELS } from '@/features/production/production-model'
import { formatDateTime } from '@/lib/format'
import { fetchDisplayNames } from '@/services/products'
import type { OrderEventRow } from '@/types/database-production'

const STATUS = (s: string | null) => (s ? s.replace(/_/g, ' ').toLowerCase() : '')

/** Order history (append-only events) with who did what and when. */
export function EventTimeline({ events, loading, labels = EVENT_LABELS }: { events: OrderEventRow[]; loading: boolean; labels?: Record<string, string> }) {
  const ids = events.map((e) => e.actor_user_id)
  const names = useAsync(() => fetchDisplayNames(ids), [ids.join(',')])
  if (loading && events.length === 0) return <p className="text-sm text-muted-foreground">Loading history…</p>
  if (events.length === 0) return <p className="text-sm text-muted-foreground">No history yet.</p>
  return (
    <ol className="space-y-3 border-l pl-4">
      {[...events].reverse().map((e) => {
        const details = (e.details ?? {}) as Record<string, unknown>
        const numbers = (details.transaction_numbers ?? details.reversal_numbers) as string[] | undefined
        return (
          <li key={e.id} className="relative text-sm">
            <span aria-hidden className="absolute top-1.5 -left-[21px] size-2.5 rounded-full border-2 border-background bg-gray-400" />
            <p>
              <span className="font-medium">{labels[e.event_type] ?? e.event_type.replace(/_/g, ' ').toLowerCase()}</span>
              {e.from_status !== e.to_status && e.to_status && <span className="text-muted-foreground"> · {STATUS(e.from_status) || 'new'} → {STATUS(e.to_status)}</span>}
            </p>
            <p className="text-xs text-muted-foreground">
              {formatDateTime(e.created_at)} · {(e.actor_user_id && names.data?.get(e.actor_user_id)) || 'User'}
              {typeof details.receipt_number === 'string' && ` · ${details.receipt_number}`}
              {typeof details.fulfilment_number === 'string' && ` · ${details.fulfilment_number}`}
              {typeof details.return_number === 'string' && ` · ${details.return_number}`}
              {numbers && numbers.length > 0 && ` · ${numbers.join(', ')}`}
            </p>
            {e.note && <p className="mt-0.5 text-xs">{e.note}</p>}
          </li>
        )
      })}
    </ol>
  )
}
