import { Loader2 } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { formatQty } from '@/features/inventory/inventory-model'
import { useRequestKey } from '@/hooks/use-request-key'
import { describeDataError } from '@/lib/errors'
import { allocateOrder, type SoAllocateResult, type SoStrategy } from '@/services/sales'

const STRATEGIES: Record<SoStrategy, string> = {
  IN_HOUSE_FIRST: 'In-house stock first',
  OUTSOURCED_FIRST: 'Outsourced stock first',
  EARLIEST_BATCH: 'Earliest expiry / oldest lot first',
}

/**
 * Reserves eligible stock (storage locations, active unexpired lots of known
 * source, the order's warehouse if set) for the unreserved remaining quantity.
 * The server picks the lots under row locks; nothing here is trusted.
 */
export function AllocateDialog({ orderId, orderNumber, lineId, lineLabel, onClose, onDone }: {
  orderId: string
  orderNumber: string
  lineId?: string | null
  lineLabel?: string
  onClose: () => void
  onDone: (message: string) => void
}) {
  const [strategy, setStrategy] = useState<SoStrategy>('IN_HOUSE_FIRST')
  const [partial, setPartial] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<SoAllocateResult | null>(null)
  const { key, renew } = useRequestKey()

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && (result ? onDone(summary(result)) : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Allocate stock to {orderNumber}{lineLabel ? ` · ${lineLabel}` : ''}</DialogTitle>
          <DialogDescription>Reserves stock that no other order holds. Expired, rejected, quarantined, outside-processor and unverified-source stock is never allocated.</DialogDescription>
        </DialogHeader>
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
        {result ? (
          <div className="space-y-2 text-sm">
            <p className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-green-800">{summary(result)}</p>
            <ul className="space-y-0.5 text-xs">{result.reservations.map((r) => <li key={r.reservation_number}>{r.reservation_number}: line {r.line_no} {r.sku} · {formatQty(r.quantity)} at {r.warehouse_code}/{r.location_code}{r.batch_number ? ` · ${r.batch_number}` : ''}</li>)}</ul>
            {result.shortages.length > 0 && <ul className="space-y-0.5 text-xs text-shortage">{result.shortages.map((s) => <li key={s.line_no}>Line {s.line_no} {s.sku}: short by {formatQty(s.short, s.unit)} — left as backorder</li>)}</ul>}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1"><Label htmlFor="al-strategy">Strategy</Label>
              <Select value={strategy} onValueChange={(v) => setStrategy(v as SoStrategy)}><SelectTrigger id="al-strategy"><SelectValue /></SelectTrigger>
                <SelectContent>{Object.entries(STRATEGIES).map(([k, l]) => <SelectItem key={k} value={k}>{l}</SelectItem>)}</SelectContent></Select></div>
            <label className="flex items-center gap-2 text-sm"><Checkbox checked={partial} onCheckedChange={(v) => setPartial(v === true)} /> Reserve what is available and leave the rest as a backorder</label>
          </div>
        )}
        <DialogFooter>
          {result ? <Button onClick={() => onDone(summary(result))}>Done</Button> : (
            <>
              <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
              <Button disabled={busy} onClick={async () => {
                setBusy(true); setError(null)
                try { const r = await allocateOrder(orderId, strategy, lineId ?? null, partial, key); renew(); setResult(r) } catch (e) { setError(describeDataError(e)) } finally { setBusy(false) }
              }}>{busy && <Loader2 className="animate-spin" />} Reserve stock</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function summary(r: SoAllocateResult) {
  return `${r.reservations.length} reservation(s) created${r.shortages.length ? `; ${r.shortages.length} line(s) still short` : ''}. Order is ${r.status.replace(/_/g, ' ').toLowerCase()}.`
}
