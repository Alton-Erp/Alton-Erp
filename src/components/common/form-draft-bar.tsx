import { AlertTriangle, Check, CloudOff, History, Loader2, RotateCcw, Save, Trash2, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { DRAFT_STATUS_TEXT, RESTORED_MESSAGE } from '@/features/drafts/draft-model'
import type { PersistentFormDraft } from '@/hooks/use-persistent-form-draft'
import { cn } from '@/lib/utils'

const time = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '')

/**
 * Auto-save status for a form, shown under the page heading:
 * Saving… / All changes saved / Unable to save — Retry / Draft restored,
 * with Save Draft, Discard Draft and Restore Draft, and conflict recovery.
 */
export function FormDraftBar<T>({ draft, showSave = true, className }: {
  draft: PersistentFormDraft<T>
  /** Hide "Save Draft" on forms whose own button already saves an ERP draft record. */
  showSave?: boolean
  className?: string
}) {
  const { status, notice } = draft
  if (status === 'disabled') return null

  return (
    <div className={cn('mb-4 space-y-2', className)} data-testid="form-draft-bar">
      {notice && <Notice draft={draft} />}
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <p role="status" aria-live="polite" data-draft-status={status}
          className={cn('flex items-center gap-1.5', status === 'error' ? 'text-red-700' : 'text-muted-foreground')}>
          {status === 'saving' || status === 'loading' ? <Loader2 aria-hidden className="size-3.5 animate-spin" />
            : status === 'saved' ? <Check aria-hidden className="size-3.5 text-available" />
              : status === 'error' ? <CloudOff aria-hidden className="size-3.5" />
                : status === 'conflict' ? <AlertTriangle aria-hidden className="size-3.5 text-amber-700" />
                  : <History aria-hidden className="size-3.5" />}
          {status === 'saved' && notice?.kind === 'restored' ? 'Draft restored' : DRAFT_STATUS_TEXT[status]}
          {status === 'saved' && draft.lastSavedAt && <span className="text-xs">· {time(draft.lastSavedAt)}</span>}
          {status === 'error' && (
            <>
              <span className="sr-only">{draft.error}</span>
              <span aria-hidden> — </span>
              <button type="button" className="font-medium underline" onClick={draft.retry}>Retry</button>
              <span className="text-xs text-muted-foreground">(your entries are kept in this browser)</span>
            </>
          )}
        </p>
        <div className="flex flex-wrap gap-1.5">
          {showSave && (
            <Button type="button" variant="ghost" size="sm" disabled={status === 'saving' || status === 'loading' || status === 'conflict'} onClick={() => void draft.saveNow()}>
              <Save /> Save Draft
            </Button>
          )}
          {draft.hasDraft && status !== 'loading' && (
            <Button type="button" variant="ghost" size="sm" onClick={() => void draft.discard()}>
              <Trash2 /> Discard Draft
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

function Notice<T>({ draft }: { draft: PersistentFormDraft<T> }) {
  const n = draft.notice
  if (!n) return null
  const tone = n.kind === 'conflict' || n.kind === 'closed-elsewhere' || n.kind === 'stale'
    ? 'border-amber-200 bg-amber-50 text-amber-900' : 'border-blue-200 bg-blue-50 text-blue-900'
  const text = {
    restored: RESTORED_MESSAGE,
    available: 'A saved draft of this form is available. Your current entries were kept.',
    stale: 'A saved draft was found, but this record has changed since the draft was started. The current record is shown; restore the draft only if you are sure.',
    conflict: 'This draft was changed in another window or on another device. Nothing was overwritten — choose which version to keep.',
    'closed-elsewhere': 'This form was already submitted or discarded in another window. Nothing was overwritten.',
    discarded: 'Draft discarded.',
  }[n.kind]
  return (
    <div role={n.kind === 'conflict' ? 'alert' : 'status'} data-draft-notice={n.kind}
      className={cn('flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border px-4 py-2.5 text-sm', tone)}>
      <span className="min-w-0 flex-1">{text}</span>
      <span className="flex flex-wrap gap-1.5">
        {(n.kind === 'available' || n.kind === 'stale' || n.kind === 'discarded') && (
          <Button type="button" size="sm" variant="outline" onClick={draft.restoreDraft}><RotateCcw /> Restore Draft</Button>
        )}
        {n.kind === 'conflict' && (
          <>
            <Button type="button" size="sm" variant="outline" onClick={() => draft.resolveConflict('mine')}>Keep this window's version</Button>
            <Button type="button" size="sm" variant="outline" onClick={() => draft.resolveConflict('theirs')}>Load the other version</Button>
          </>
        )}
        {n.kind === 'closed-elsewhere' && (
          <>
            <Button type="button" size="sm" variant="outline" onClick={() => draft.resolveConflict('mine')}>Keep editing as a new draft</Button>
            <Button type="button" size="sm" variant="outline" onClick={() => draft.resolveConflict('theirs')}>Start over</Button>
          </>
        )}
        {(n.kind === 'stale' || n.kind === 'available') && (
          <Button type="button" size="sm" variant="ghost" onClick={() => void draft.discard({ keepValues: true })}><Trash2 /> Discard Draft</Button>
        )}
        {(n.kind === 'restored' || n.kind === 'discarded') && (
          <Button type="button" size="icon-sm" variant="ghost" aria-label="Dismiss" onClick={draft.dismissNotice}><X /></Button>
        )}
      </span>
    </div>
  )
}
