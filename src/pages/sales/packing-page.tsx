import { AlertTriangle, CheckCircle2, Loader2, PackageCheck, RotateCcw } from 'lucide-react'
import { useState, type ReactNode } from 'react'

import { usePermissions } from '@/auth/use-permissions'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { FilterTabs } from '@/components/common/filter-tabs'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { formatQty } from '@/features/inventory/inventory-model'
import { ActionDialog, type ActionRequest } from '@/features/production/action-dialog'
import { FulfilmentQueue } from '@/features/sales/fulfilment-queue'
import { FulfilmentStatusBadge } from '@/features/sales/sales-badges'
import { parseQty } from '@/features/sales/sales-model'
import { useFulfilmentSelection } from '@/features/sales/use-fulfilment-selection'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import { fetchFulfilment, fetchFulfilmentLines, fetchFulfilments, fulfilmentAction, recordPack } from '@/services/sales'
import type { FulfilmentStatus } from '@/types/database-sales'

type Tab = 'TO_PACK' | 'PACKED'
const TAB_STATUSES: Record<Tab, FulfilmentStatus[]> = { TO_PACK: ['PICKED', 'PACKING'], PACKED: ['PACKED', 'READY_FOR_DISPATCH'] }

const Alert = ({ tone, children }: { tone: 'error' | 'success'; children: ReactNode }) => (
  <p role={tone === 'error' ? 'alert' : 'status'} className={tone === 'error' ? 'rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800' : 'rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800'}>{children}</p>
)

export default function PackingPage() {
  const { has } = usePermissions()
  const { fulfilmentId, select } = useFulfilmentSelection()
  const [tab, setTab] = useState<Tab>('TO_PACK')
  const [refresh, setRefresh] = useState(0)
  const queue = useAsync(() => fetchFulfilments({ statuses: TAB_STATUSES[tab] }), [tab, refresh])
  const ful = useAsync(() => (fulfilmentId ? fetchFulfilment(fulfilmentId) : Promise.resolve(null)), [fulfilmentId, refresh])
  const lines = useAsync(() => (fulfilmentId ? fetchFulfilmentLines({ fulfilmentId }) : Promise.resolve([])), [fulfilmentId, refresh])
  const [packedEdits, setPacked] = useState<Record<string, string>>({})
  const [damagedEdits, setDamaged] = useState<Record<string, string>>({})
  const [exceptionEdits, setExceptions] = useState<Record<string, string>>({})
  const [notesEdit, setNotes] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<'COMPLETE' | 'READY' | null>(null)
  const [action, setAction] = useState<ActionRequest | null>(null)
  const f = ful.data
  const editable = Boolean(f && ['PICKED', 'PACKING'].includes(f.fulfilment_status) && has('fulfilment.pack'))

  // Unsaved edits on top of the recorded values. Picked quantities are offered as
  // packed by default only while nothing has been recorded for the line.
  const ls = lines.data ?? []
  const packed: Record<string, string> = { ...Object.fromEntries(ls.map((l) => [l.id, String(Number(l.quantity_packed) + Number(l.quantity_damaged) === 0 ? Number(l.quantity_picked) : Number(l.quantity_packed))])), ...packedEdits }
  const damaged: Record<string, string> = { ...Object.fromEntries(ls.map((l) => [l.id, String(Number(l.quantity_damaged))])), ...damagedEdits }
  const exceptions: Record<string, string> = { ...Object.fromEntries(ls.map((l) => [l.id, l.pack_exception ?? ''])), ...exceptionEdits }
  const notes = notesEdit ?? f?.packing_notes ?? ''
  const clearEdits = () => { setPacked({}); setDamaged({}); setExceptions({}); setNotes(null) }

  const save = async (complete: boolean) => {
    if (!f) return
    const payload = (lines.data ?? []).map((l) => ({ line_id: l.id, quantity_packed: parseQty(packed[l.id] ?? '0'), quantity_damaged: parseQty(damaged[l.id] ?? '0'), exception: (exceptions[l.id] ?? '').trim() || null }))
    if (payload.some((p) => p.quantity_packed === null || p.quantity_damaged === null)) { setError('Enter packed and damaged quantities as numbers (up to 3 decimals).'); return }
    const over = (lines.data ?? []).find((l, i) => (payload[i].quantity_packed ?? 0) + (payload[i].quantity_damaged ?? 0) > Number(l.quantity_picked))
    if (over) { setError(`Line ${over.line_no}: packed plus damaged cannot exceed the ${formatQty(over.quantity_picked)} picked.`); return }
    setBusy(true); setError(null)
    try {
      const r = await recordPack(f.id, payload as { line_id: string; quantity_packed: number; quantity_damaged: number; exception: string | null }[], notes.trim() || null, complete)
      setMessage(complete ? `${f.fulfilment_number} packed (${formatQty(r.packed)}). Mark it ready for dispatch once verified.` : 'Packing saved.')
      clearEdits()
      setRefresh((n) => n + 1)
    } catch (e) { setError(describeDataError(e)) } finally { setBusy(false) }
  }

  const ready = async () => {
    if (!f) return
    setBusy(true); setError(null)
    try { await fulfilmentAction(f.id, 'READY', null); setMessage(`${f.fulfilment_number} is ready for dispatch.`); setRefresh((n) => n + 1) } catch (e) { setError(describeDataError(e)) } finally { setBusy(false) }
  }

  return (
    <>
      <PageHeader />
      {message && <div className="mb-4"><Alert tone="success">{message}</Alert></div>}
      <div className="mb-6">
        <FulfilmentQueue title="Consignments" rows={queue.data ?? []} loading={queue.loading} error={queue.error} onRetry={queue.reload} selectedId={fulfilmentId}
          onSelect={(id) => { setMessage(null); setError(null); clearEdits(); select(id) }} extra={['packed']}
          toolbar={<FilterTabs<Tab> label="Packing stage" value={tab} onChange={setTab} options={[{ value: 'TO_PACK', label: 'To pack' }, { value: 'PACKED', label: 'Packed / ready' }]} />}
          emptyTitle={tab === 'TO_PACK' ? 'Nothing to pack' : 'Nothing packed'} emptyDescription="Consignments appear here after picking is completed." />
      </div>
      {f && (
        <Card>
          <CardHeader>
            <div>
              <CardTitle className="flex flex-wrap items-center gap-2">{f.fulfilment_number} · {f.sales_order_number} <FulfilmentStatusBadge status={f.fulfilment_status} /></CardTitle>
              <CardDescription>{f.customer_name_snapshot} · from {f.warehouse_code}{f.picked_at ? ` · picked ${formatDateTime(f.picked_at)}` : ''}{f.reopen_reason ? ` · reopened: ${f.reopen_reason}` : ''}. Verify each picked item; damaged or missing items are recorded and are not dispatched.</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {error && <Alert tone="error">{error}</Alert>}
            <div className="overflow-x-auto">
              <table className="w-full min-w-[960px] text-sm">
                <thead className="text-xs text-muted-foreground"><tr>
                  <th className="pb-2 text-left">Line</th><th className="pb-2 text-left">SKU / description</th><th className="pb-2 text-left">Batch / location</th><th className="pb-2 text-right">Picked</th>
                  <th className="pb-2 text-right">Packed</th><th className="pb-2 text-right">Damaged / missing</th><th className="pb-2 text-right">Outstanding</th><th className="pb-2 text-left">Exception / note</th>
                </tr></thead>
                <tbody>{(lines.data ?? []).map((l) => {
                  const p = parseQty(packed[l.id] ?? '0') ?? 0
                  const d = parseQty(damaged[l.id] ?? '0') ?? 0
                  const outstanding = Number(l.quantity_picked) - p - d
                  return (
                    <tr key={l.id} className="border-t align-top">
                      <td className="py-2">{l.line_no}</td>
                      <td className="py-2"><span className="font-medium">{l.sku}</span><span className="block text-xs text-muted-foreground">{l.product_name}</span>
                        {l.pick_exception && <span className="block text-xs text-amber-800">Pick: {l.pick_exception}</span>}
                        {l.stock_problem && <span className="inline-flex items-center gap-1 text-xs font-medium text-shortage"><AlertTriangle className="size-3" /> {l.stock_problem}</span>}</td>
                      <td className="py-2 text-xs">{l.batch_number ?? 'no batch'} · {l.warehouse_code}/{l.location_code}</td>
                      <td className="py-2 text-right">{formatQty(l.quantity_picked, l.unit)}</td>
                      <td className="py-2 text-right">{editable ? <Input aria-label={`Packed quantity line ${l.line_no}`} className="ml-auto h-8 w-24 text-right" inputMode="decimal" value={packed[l.id] ?? ''} onChange={(e) => setPacked((x) => ({ ...x, [l.id]: e.target.value }))} /> : formatQty(l.quantity_packed)}</td>
                      <td className="py-2 text-right">{editable ? <Input aria-label={`Damaged quantity line ${l.line_no}`} className="ml-auto h-8 w-24 text-right" inputMode="decimal" value={damaged[l.id] ?? ''} onChange={(e) => setDamaged((x) => ({ ...x, [l.id]: e.target.value }))} /> : formatQty(l.quantity_damaged)}</td>
                      <td className={outstanding !== 0 ? 'py-2 text-right text-amber-800' : 'py-2 text-right'}>{formatQty(outstanding)}</td>
                      <td className="py-2">{editable ? <Input aria-label={`Packing exception line ${l.line_no}`} className="h-8 w-56" maxLength={500} placeholder={d > 0 || outstanding > 0 ? 'Describe the damage / mismatch (required)' : 'Optional'}
                        value={exceptions[l.id] ?? ''} onChange={(e) => setExceptions((x) => ({ ...x, [l.id]: e.target.value }))} /> : <span className="text-xs">{l.pack_exception ?? ''}</span>}</td>
                    </tr>
                  )
                })}</tbody>
              </table>
            </div>
            <div className="space-y-1"><Label htmlFor="pk-notes">Packaging notes</Label>
              <Textarea id="pk-notes" rows={2} maxLength={1000} disabled={!editable} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Cartons, pallets, seals, special handling…" />
              <p className="text-xs text-muted-foreground">Packaging materials are not deducted automatically. If they are stock items, issue them explicitly in Stock Movements.</p></div>
            <div className="flex flex-wrap gap-2 border-t pt-4">
              {editable && <Button variant="outline" disabled={busy} onClick={() => void save(false)}>{busy && <Loader2 className="animate-spin" />} Save</Button>}
              {editable && <Button disabled={busy} onClick={() => setConfirm('COMPLETE')}><CheckCircle2 /> Complete packing</Button>}
              {f.fulfilment_status === 'PACKED' && has('fulfilment.pack') && <Button disabled={busy} onClick={() => setConfirm('READY')}><PackageCheck /> Mark ready for dispatch</Button>}
              {['PACKED', 'READY_FOR_DISPATCH'].includes(f.fulfilment_status) && has('fulfilment.pack') && (
                <Button variant="outline" onClick={() => setAction({ title: `Reopen packing of ${f.fulfilment_number}`, description: 'The consignment returns to packing so quantities can be corrected. Nothing has been dispatched.',
                  confirmLabel: 'Reopen packing', note: 'required', run: async (note) => { await fulfilmentAction(f.id, 'REOPEN_PACKING', note); return 'Packing reopened.' } })}><RotateCcw /> Reopen packing</Button>
              )}
              {['PICKED', 'PACKING', 'PACKED', 'READY_FOR_DISPATCH'].includes(f.fulfilment_status) && has('fulfilment.pick') && (
                <Button variant="outline" onClick={() => setAction({ title: `Reopen picking of ${f.fulfilment_number}`, description: 'Packed quantities are cleared and the consignment returns to picking.',
                  confirmLabel: 'Reopen picking', note: 'required', run: async (note) => { await fulfilmentAction(f.id, 'REOPEN_PICKING', note); return 'Picking reopened; continue on Warehouse Picking.' } })}>Reopen picking</Button>
              )}
            </div>
          </CardContent>
        </Card>
      )}
      <ConfirmDialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}
        title={confirm === 'READY' ? 'Release for dispatch?' : 'Complete packing?'} confirmLabel={confirm === 'READY' ? 'Mark ready' : 'Complete packing'}
        description={confirm === 'READY' ? 'The reservations and lots are re-checked. Only the packed quantity will be dispatched.' : 'Every picked item must be packed or recorded as damaged/missing (with a note).'}
        onConfirm={() => { const c = confirm; setConfirm(null); if (c === 'READY') void ready(); else void save(true) }} />
      <ActionDialog request={action} onClose={() => setAction(null)} onDone={(m) => { setAction(null); setMessage(m); clearEdits(); setRefresh((n) => n + 1) }} />
    </>
  )
}
