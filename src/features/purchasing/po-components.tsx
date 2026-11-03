import { Loader2, Search, X } from 'lucide-react'
import { useEffect, useId, useState } from 'react'

import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { PO_STATUS_LABELS, PO_STATUS_TONES } from '@/features/purchasing/po-model'
import { useDebouncedValue } from '@/hooks/use-debounced-value'
import { describeDataError } from '@/lib/errors'
import { searchPoProducts, type PoProductOption, type PoWorkflowAction } from '@/services/purchasing'
import type { PoStatus } from '@/types/database-purchasing'

export function PoStatusBadge({ status }: { status: PoStatus }) {
  return <StatusBadge label={PO_STATUS_LABELS[status]} tone={PO_STATUS_TONES[status]} />
}

/** Product Master search for a PO line (active products only). */
export function PoProductPicker({ id, value, onChange, disabled, invalid }: {
  id: string
  value: { sku: string | null; product_name: string | null } | null
  onChange: (p: PoProductOption | null) => void
  disabled?: boolean
  invalid?: boolean
}) {
  const listId = useId()
  const [text, setText] = useState('')
  const [open, setOpen] = useState(false)
  const [results, setResults] = useState<PoProductOption[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const term = useDebouncedValue(text, 250)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void Promise.resolve()
      .then(() => { if (!cancelled) setLoading(true); return searchPoProducts(term) })
      .then((r) => { if (!cancelled) { setResults(r); setError(null) } })
      .catch((e) => { if (!cancelled) { setResults([]); setError(describeDataError(e)) } })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [term, open])

  if (value?.sku) {
    return (
      <div className="flex h-9 items-center justify-between gap-2 rounded-md border bg-surface-muted/50 px-3 text-sm">
        <span className="min-w-0 truncate"><span className="font-medium">{value.sku}</span> — {value.product_name}</span>
        {!disabled && (
          <button type="button" aria-label={`Change product ${value.sku}`} className="rounded p-0.5 text-muted-foreground hover:text-foreground" onClick={() => onChange(null)}>
            <X className="size-3.5" />
          </button>
        )}
      </div>
    )
  }
  return (
    <div className="relative">
      <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        id={id}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-invalid={invalid || undefined}
        autoComplete="off"
        className="pl-8"
        placeholder="Search SKU or name…"
        value={text}
        disabled={disabled}
        onChange={(e) => { setText(e.target.value); setOpen(true) }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false) }}
      />
      {open && (
        <div id={listId} role="listbox" className="absolute z-30 mt-1 max-h-64 w-full min-w-64 overflow-y-auto rounded-md border bg-background p-1 shadow-md">
          {loading ? <p className="flex items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Searching…</p>
            : error ? <p className="px-2 py-1.5 text-sm text-red-700">{error}</p>
            : results.length === 0 ? <p className="px-2 py-1.5 text-sm text-muted-foreground">No active products match.</p>
            : results.map((p) => (
              <button key={p.id} type="button" role="option" aria-selected={false}
                className="flex w-full flex-col items-start rounded px-2 py-1.5 text-left text-sm hover:bg-accent focus:bg-accent focus:outline-none"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => { onChange(p); setText(''); setOpen(false) }}>
                <span><span className="font-medium">{p.sku}</span> — {p.product_name}</span>
                <span className="text-xs text-muted-foreground">{p.base_unit} · GST {p.gst_rate === null ? 'not set' : `${Number(p.gst_rate)}%`}{p.hsn_code ? ` · HSN ${p.hsn_code}` : ''}</span>
              </button>
            ))}
        </div>
      )}
    </div>
  )
}

const ACTION_COPY: Record<PoWorkflowAction, { title: string; description: string; confirm: string; reason?: 'required' | 'optional'; destructive?: boolean; min?: number }> = {
  SUBMIT: { title: 'Submit for approval?', description: 'The order is checked (supplier, warehouse, prices, GST) and sent for approval. It cannot be edited while it waits.', confirm: 'Submit' },
  WITHDRAW: { title: 'Withdraw from approval?', description: 'The order goes back to draft so it can be edited.', confirm: 'Withdraw' },
  APPROVE: { title: 'Approve purchase order?', description: 'Once approved, the order can be sent to the supplier and goods can be received against it. Changes then need an amendment.', confirm: 'Approve' },
  REJECT: { title: 'Reject purchase order?', description: 'The order goes back to draft with your reason so the requester can correct it.', confirm: 'Reject', reason: 'required', destructive: true, min: 3 },
  SEND: { title: 'Mark as sent to supplier?', description: 'Records that the approved order was sent to the supplier (the ERP does not e-mail it). Optionally note how it was sent.', confirm: 'Mark as sent', reason: 'optional' },
  AMEND: { title: 'Amend approved order?', description: 'Creates a new revision as a draft. The current version is kept in the amendment history, and the order must be approved again. Lines with received goods keep their product and cannot go below the received quantity.', confirm: 'Start amendment', reason: 'required', min: 5 },
  CANCEL: { title: 'Cancel purchase order?', description: 'Cancelled orders cannot be reopened. Orders with received goods cannot be cancelled (short-close them instead).', confirm: 'Cancel order', reason: 'required', destructive: true, min: 5 },
  CLOSE: { title: 'Short-close purchase order?', description: 'Closes the order with quantities still pending: nothing more can be received against it.', confirm: 'Close order', reason: 'required', destructive: true, min: 5 },
}

/** Confirmation (and reason) for a workflow action. */
export function PoActionDialog({ action, poNumber, onClose, onConfirm }: {
  action: PoWorkflowAction
  poNumber: string
  onClose: () => void
  onConfirm: (note: string | null) => Promise<void>
}) {
  const copy = ACTION_COPY[action]
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{poNumber}: {copy.description}</DialogDescription>
        </DialogHeader>
        <form noValidate onSubmit={async (e) => {
          e.preventDefault()
          setError(null)
          if (copy.reason === 'required' && note.trim().length < (copy.min ?? 3)) {
            setError(`Enter the reason (at least ${copy.min ?? 3} characters).`)
            return
          }
          setBusy(true)
          try {
            await onConfirm(note.trim() || null)
          } catch (err) {
            setError(describeDataError(err))
            setBusy(false)
          }
        }}>
          {copy.reason && (
            <div className="space-y-1">
              <Label htmlFor="po-action-note">{copy.reason === 'required' ? 'Reason' : 'Note (optional)'}</Label>
              <Textarea id="po-action-note" rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)}
                aria-invalid={Boolean(error) || undefined} aria-describedby={error ? 'po-action-error' : undefined} />
            </div>
          )}
          {error && <p id="po-action-error" role="alert" className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
          <DialogFooter className="mt-4">
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>Back</Button>
            <Button type="submit" variant={copy.destructive ? 'destructive' : 'default'} disabled={busy}>
              {busy && <Loader2 className="animate-spin" />} {copy.confirm}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
