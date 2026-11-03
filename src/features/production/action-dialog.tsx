import { Loader2 } from 'lucide-react'
import { useState, type ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useRequestKey } from '@/hooks/use-request-key'
import { describeDataError } from '@/lib/errors'

export interface ActionRequest {
  title: string
  description: ReactNode
  confirmLabel: string
  /** 'required' needs at least `minLength` characters. */
  note: 'none' | 'optional' | 'required'
  noteLabel?: string
  minLength?: number
  destructive?: boolean
  run: (note: string | null, key: string) => Promise<string>
}

/**
 * Confirmation dialog for workflow actions (approve, hold, cancel, complete,
 * reverse...). Shows the server's error verbatim and only reports success
 * after the RPC returned. The request id is kept on retry.
 */
export function ActionDialog({ request, onClose, onDone }: { request: ActionRequest | null; onClose: () => void; onDone: (message: string) => void }) {
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { key, renew } = useRequestKey()

  const close = () => {
    if (busy) return
    setNote('')
    setError(null)
    onClose()
  }

  if (!request) return null
  const min = request.minLength ?? 3
  return (
    <Dialog open onOpenChange={(o) => !o && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{request.title}</DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-2 text-sm text-muted-foreground">{request.description}</div>
          </DialogDescription>
        </DialogHeader>
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
        {request.note !== 'none' && (
          <div className="space-y-1.5">
            <Label htmlFor="action-note">{request.noteLabel ?? (request.note === 'required' ? 'Reason (required)' : 'Note (optional)')}</Label>
            <Textarea id="action-note" value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={1000} />
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={busy}>Cancel</Button>
          <Button
            variant={request.destructive ? 'destructive' : 'default'}
            disabled={busy}
            onClick={async () => {
              if (request.note === 'required' && note.trim().length < min) {
                setError(`Enter at least ${min} characters.`)
                return
              }
              setBusy(true)
              setError(null)
              try {
                const message = await request.run(note.trim() || null, key)
                renew()
                setNote('')
                setBusy(false)
                onDone(message)
              } catch (e) {
                setError(describeDataError(e))
                setBusy(false)
              }
            }}
          >
            {busy && <Loader2 className="animate-spin" />}
            {request.confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
