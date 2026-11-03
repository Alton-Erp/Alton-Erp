import { CheckCircle2, Loader2, Printer, QrCode, ScanLine, Trash2, XCircle } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

import { usePermissions } from '@/auth/use-permissions'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { EmptyState } from '@/components/common/empty-state'
import { FilterTabs } from '@/components/common/filter-tabs'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { isCode128B, scanPayload, type ScanKind } from '@/features/admin/barcode'
import { Code128Svg, QrSvg } from '@/features/admin/barcode-svg'
import { ScanInput } from '@/features/admin/scan-input'
import { LocationSelect, LotSelect } from '@/features/inventory/pickers'
import { useStorage } from '@/features/inventory/use-storage'
import { useAsync } from '@/hooks/use-async'
import { useDebouncedValue } from '@/hooks/use-debounced-value'
import { describeDataError } from '@/lib/errors'
import { assignBarcode, fetchLabelProducts, lookupCode, type ScanMatch } from '@/services/admin'
import { fetchCountLines, fetchCounts, postIssue, postReceipt, postTransfer } from '@/services/inventory'
import { fetchFulfilmentLines } from '@/services/sales'
import type { StockDetailRow } from '@/types/database-inventory'

type Tab = 'lookup' | 'station' | 'labels' | 'assign'
type Mode = 'RECEIPT' | 'ISSUE' | 'TRANSFER' | 'BATCH' | 'COUNT' | 'PICK' | 'PACK' | 'DISPATCH'
const KIND_LETTER: Record<ScanMatch['kind'], ScanKind> = { PRODUCT: 'P', BATCH: 'B', LOCATION: 'L', WAREHOUSE: 'W', DISPATCH: 'F' }
const KIND_LABEL: Record<ScanMatch['kind'], string> = { PRODUCT: 'Product', BATCH: 'Batch / lot', LOCATION: 'Location', WAREHOUSE: 'Warehouse', DISPATCH: 'Consignment' }
const MODE_LABEL: Record<Mode, string> = {
  RECEIPT: 'Goods receipt', ISSUE: 'Stock issue', TRANSFER: 'Transfer', BATCH: 'Batch identification', COUNT: 'Count verification',
  PICK: 'Picking check', PACK: 'Packing check', DISPATCH: 'Dispatch verification',
}

interface LabelItem { kind: ScanKind; id: string; title: string; subtitle: string; code: string | null }
interface StationLine {
  key: string; productId: string; sku: string; name: string; unit: string; quantity: string; batchNumber: string; lot: StockDetailRow | null
  fixedBatchId: string | null; status: 'pending' | 'posting' | 'posted' | 'failed'; result: string | null
}

function MatchCard({ m, onLabel }: { m: ScanMatch; onLabel?: (m: ScanMatch) => void }) {
  return (
    <li className="space-y-1 px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge label={KIND_LABEL[m.kind]} tone="info" />
        <Link className="font-medium text-primary hover:underline" to={m.link}>{m.label}</Link>
        <span className="text-muted-foreground">{m.detail}</span>
        <span className="ml-auto text-xs text-muted-foreground">matched on {m.matched_on.toLowerCase().replace(/_/g, ' ')}</span>
      </div>
      {(m.on_hand !== undefined && m.on_hand !== null) && <p>On hand {m.on_hand} {m.unit ?? ''}{m.available !== undefined && m.available !== null ? ` · available ${m.available}` : ''}{m.expiry_date ? ` · expires ${m.expiry_date}` : ''}{m.status ? ` · ${m.status.toLowerCase()}` : ''}</p>}
      {m.locations && m.locations.length > 0 && (
        <ul className="text-xs text-muted-foreground">{m.locations.map((l) => <li key={l.location_id}>{l.warehouse} / {l.location}: {l.on_hand}{l.reserved ? ` (reserved ${l.reserved})` : ''}</li>)}</ul>
      )}
      {onLabel && <Button size="sm" variant="ghost" onClick={() => onLabel(m)}><QrCode /> Add to labels</Button>}
    </li>
  )
}

function LookupPanel({ onLabel }: { onLabel: (m: ScanMatch) => void }) {
  const [result, setResult] = useState<{ code: string; matches: ScanMatch[] } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scan = (code: string) => {
    setBusy(true); setError(null)
    lookupCode(code).then((r) => setResult({ code, matches: r.matches }), (e) => setError(describeDataError(e))).finally(() => setBusy(false))
  }
  return (
    <Card>
      <CardHeader><div><CardTitle>Scan & look up</CardTitle><CardDescription>Finds products (barcode or SKU), batches, locations, warehouses and consignments you are allowed to see. Looking up never changes anything.</CardDescription></div></CardHeader>
      <CardContent className="space-y-4">
        <ScanInput onScan={scan} disabled={busy} />
        {busy && <p className="text-sm text-muted-foreground"><Loader2 className="inline size-4 animate-spin" /> Looking up…</p>}
        {error && <p role="alert" className="text-sm text-red-800">{error}</p>}
        {result && (result.matches.length === 0
          ? <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">No record matches “{result.code}”, or you do not have access to it.</p>
          : <>{result.matches.length > 1 && <p className="text-sm text-amber-800">This code matches {result.matches.length} records — check which one you mean.</p>}
            <ul className="divide-y rounded-lg border">{result.matches.map((m) => <MatchCard key={`${m.kind}-${m.id}`} m={m} onLabel={onLabel} />)}</ul></>)}
      </CardContent>
    </Card>
  )
}

function ScanStation() {
  const { has } = usePermissions()
  const storage = useStorage()
  const [mode, setMode] = useState<Mode>('RECEIPT')
  const [locationId, setLocationId] = useState('')
  const [toLocationId, setToLocationId] = useState('')
  const [sourceType, setSourceType] = useState<'IN_HOUSE' | 'OUTSOURCED'>('IN_HOUSE')
  const [reference, setReference] = useState('')
  const [reason, setReason] = useState('')
  const [lines, setLines] = useState<StationLine[]>([])
  const [notice, setNotice] = useState<{ tone: 'ok' | 'warn' | 'err'; text: string } | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [posting, setPosting] = useState(false)
  const [lastMatch, setLastMatch] = useState<ScanMatch[] | null>(null)
  // verification modes
  const [countId, setCountId] = useState('')
  const [fulfilment, setFulfilment] = useState<{ id: string; label: string } | null>(null)
  const [tally, setTally] = useState<Record<string, number>>({})
  const counts = useAsync(() => (mode === 'COUNT' ? fetchCounts() : Promise.resolve([])), [mode])
  const countLines = useAsync(() => (mode === 'COUNT' && countId ? fetchCountLines(countId) : Promise.resolve([])), [mode, countId])
  const fLines = useAsync(() => (fulfilment && ['PICK', 'PACK', 'DISPATCH'].includes(mode) ? fetchFulfilmentLines({ fulfilmentId: fulfilment.id }) : Promise.resolve([])), [mode, fulfilment?.id])

  const posts = mode === 'RECEIPT' || mode === 'ISSUE' || mode === 'TRANSFER'
  const canPost = mode === 'TRANSFER' ? has('inventory_transfer.create') : has('inventory.create')
  const locations = storage.activeLocations
  const reset = (m: Mode) => { setMode(m); setLines([]); setTally({}); setNotice(null); setLastMatch(null); setFulfilment(null); setCountId('') }

  const addLine = (m: ScanMatch) => {
    const productId = m.kind === 'BATCH' ? m.product_id! : m.id
    const batchId = m.kind === 'BATCH' ? m.id : null
    setLines((ls) => {
      const same = ls.find((l) => l.status !== 'posted' && l.productId === productId && l.fixedBatchId === batchId)
      if (same) return ls.map((l) => (l === same ? { ...l, quantity: String((Number(l.quantity) || 0) + 1) } : l))
      return [...ls, { key: crypto.randomUUID(), productId, sku: m.kind === 'BATCH' ? m.detail.split(' — ')[0] : m.label,
        name: m.kind === 'BATCH' ? `${m.detail} · batch ${m.label}` : `${m.label} — ${m.detail}`, unit: m.unit ?? '', quantity: '1',
        batchNumber: '', lot: null, fixedBatchId: batchId, status: 'pending', result: null }]
    })
  }

  const scan = async (code: string) => {
    setNotice(null)
    let r
    try { r = await lookupCode(code) } catch (e) { return setNotice({ tone: 'err', text: describeDataError(e) }) }
    const ms = r.matches
    setLastMatch(ms)
    if (!ms.length) return setNotice({ tone: 'err', text: `“${code}” was not recognised (or you cannot access it). Nothing was added.` })
    if (['PICK', 'PACK', 'DISPATCH'].includes(mode) && !fulfilment) {
      const f = ms.find((m) => m.kind === 'DISPATCH')
      if (f) { setFulfilment({ id: f.id, label: f.label }); setTally({}); return setNotice({ tone: 'ok', text: `Consignment ${f.label} loaded. Now scan the items.` }) }
      return setNotice({ tone: 'warn', text: 'Scan the consignment (dispatch) number or its QR label first.' })
    }
    if (posts && ms.length === 1 && ms[0].kind === 'LOCATION') {
      if (mode === 'TRANSFER' && locationId) { setToLocationId(ms[0].id); return setNotice({ tone: 'ok', text: `Destination set to ${ms[0].label}.` }) }
      setLocationId(ms[0].id); return setNotice({ tone: 'ok', text: `${mode === 'TRANSFER' ? 'Source' : 'Location'} set to ${ms[0].label}.` })
    }
    const items = ms.filter((m) => m.kind === 'PRODUCT' || m.kind === 'BATCH')
    if (mode === 'BATCH') return
    if (!items.length) return setNotice({ tone: 'warn', text: `“${code}” is not a product or batch.` })
    if (items.length > 1) return setNotice({ tone: 'warn', text: `“${code}” matches ${items.length} records. Scan a more specific code (e.g. the batch QR label).` })
    const m = items[0]
    if (posts) {
      if (mode === 'RECEIPT' && m.kind === 'BATCH') return setNotice({ tone: 'warn', text: 'For a receipt scan the product; type the new batch number on the line.' })
      addLine(m)
      return setNotice({ tone: 'ok', text: `Added ${m.label}. Nothing is posted until you review and confirm.` })
    }
    const pid = m.kind === 'BATCH' ? m.product_id! : m.id
    setTally((t) => ({ ...t, [pid]: (t[pid] ?? 0) + 1 }))
    setNotice({ tone: 'ok', text: `Counted ${m.label}.` })
  }

  const ready = posts && lines.some((l) => l.status !== 'posted')
  const validate = (): string | null => {
    if (!locationId) return mode === 'TRANSFER' ? 'Choose the source location.' : 'Choose the location.'
    if (mode === 'TRANSFER' && (!toLocationId || toLocationId === locationId)) return 'Choose a different destination location.'
    if (mode === 'ISSUE' && reason.trim().length < 3) return 'Enter the reason for the issue.'
    for (const l of lines.filter((x) => x.status !== 'posted')) {
      if (!(Number(l.quantity) > 0)) return `Enter a quantity above zero for ${l.sku}.`
      if (mode !== 'RECEIPT' && !l.fixedBatchId && !l.lot) return `Choose the lot for ${l.sku}.`
    }
    return null
  }

  const postAll = async () => {
    setConfirming(false); setPosting(true)
    const todo = lines.filter((l) => l.status !== 'posted')
    let ok = 0, failed = 0
    for (const l of todo) {
      setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, status: 'posting' } : x)))
      try {
        const batchId = l.fixedBatchId ?? l.lot?.batch_id ?? null
        let res: string
        if (mode === 'RECEIPT') {
          const r = await postReceipt({ productId: l.productId, locationId, quantity: Number(l.quantity), sourceType, batchNumber: l.batchNumber.trim() || null, manufacturingDate: null,
            expiryDate: null, unitCost: null, transactionType: 'RECEIPT', referenceType: reference ? 'SCAN' : null, referenceNumber: reference.trim() || null, reason: reason.trim() || null, notes: 'Posted from scan station' }, l.key)
          res = r.duplicate ? `Already posted earlier (${r.transaction_number})` : `Posted ${r.transaction_number}`
        } else if (mode === 'ISSUE') {
          const r = await postIssue({ productId: l.productId, locationId, quantity: Number(l.quantity), batchId, sourceType: null, transactionType: 'ISSUE', referenceType: reference ? 'SCAN' : null,
            referenceNumber: reference.trim() || null, reason: reason.trim(), notes: 'Posted from scan station' }, l.key)
          res = `Posted ${r.transaction_number}`
        } else {
          const r = await postTransfer({ productId: l.productId, fromLocationId: locationId, toLocationId, quantity: Number(l.quantity), batchId, referenceNumber: reference.trim() || null,
            reason: reason.trim() || null, notes: 'Posted from scan station' }, l.key)
          res = `Posted ${r.out_transaction_number} → ${r.in_transaction_number}`
        }
        ok++
        setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, status: 'posted', result: res } : x)))
      } catch (e) {
        failed++
        // the line keeps its key, so retrying cannot post it twice
        setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, status: 'failed', result: describeDataError(e) } : x)))
      }
    }
    setPosting(false)
    setNotice(failed ? { tone: 'err', text: `${ok} line(s) posted, ${failed} failed. Correct the failed lines and post again — posted lines are not repeated.` } : { tone: 'ok', text: `${ok} line(s) posted.` })
  }

  // verification comparisons
  const expected = useMemo(() => {
    const map = new Map<string, { sku: string; name: string; expected: number }>()
    if (mode === 'COUNT') for (const l of countLines.data ?? []) {
      const e = map.get(l.product_id) ?? { sku: l.sku, name: l.product_name, expected: 0 }
      e.expected += Number(l.counted_quantity ?? 0); map.set(l.product_id, e)
    }
    else for (const l of fLines.data ?? []) {
      const e = map.get(l.product_id) ?? { sku: l.sku, name: l.product_name, expected: 0 }
      e.expected += Number(mode === 'PICK' ? l.quantity_to_pick : mode === 'PACK' ? l.quantity_picked : l.quantity_packed)
      map.set(l.product_id, e)
    }
    return map
  }, [mode, countLines.data, fLines.data])
  const unexpected = Object.keys(tally).filter((id) => !expected.has(id))

  return (
    <Card>
      <CardHeader><div><CardTitle>Scan station</CardTitle><CardDescription>Scanning only builds a list or checks quantities. Stock is posted only after you review the lines and confirm, using the same inventory functions as the Stock Movements page.</CardDescription></div></CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1"><Label htmlFor="st-mode">Mode</Label>
            <Select value={mode} onValueChange={(v) => reset(v as Mode)}><SelectTrigger id="st-mode" className="w-56"><SelectValue /></SelectTrigger>
              <SelectContent>{(Object.keys(MODE_LABEL) as Mode[]).map((m) => <SelectItem key={m} value={m}>{MODE_LABEL[m]}</SelectItem>)}</SelectContent></Select></div>
          {posts && <>
            <div className="min-w-64 space-y-1"><Label htmlFor="st-loc">{mode === 'TRANSFER' ? 'From location' : 'Location'}</Label><LocationSelect id="st-loc" value={locationId} onChange={setLocationId} options={locations} /></div>
            {mode === 'TRANSFER' && <div className="min-w-64 space-y-1"><Label htmlFor="st-to">To location</Label><LocationSelect id="st-to" value={toLocationId} onChange={setToLocationId} options={locations} exclude={locationId} /></div>}
            {mode === 'RECEIPT' && <div className="space-y-1"><Label htmlFor="st-src">Source</Label>
              <Select value={sourceType} onValueChange={(v) => setSourceType(v as 'IN_HOUSE' | 'OUTSOURCED')}><SelectTrigger id="st-src" className="w-40"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="IN_HOUSE">In-house</SelectItem><SelectItem value="OUTSOURCED">Outsourced</SelectItem></SelectContent></Select></div>}
            <div className="space-y-1"><Label htmlFor="st-ref">Reference</Label><Input id="st-ref" className="w-44" maxLength={80} value={reference} onChange={(e) => setReference(e.target.value)} /></div>
            <div className="space-y-1"><Label htmlFor="st-reason">Reason{mode === 'ISSUE' ? ' (required)' : ''}</Label><Input id="st-reason" className="w-56" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} /></div>
          </>}
          {mode === 'COUNT' && <div className="space-y-1"><Label htmlFor="st-count">Stock count</Label>
            <Select value={countId} onValueChange={(v) => { setCountId(v); setTally({}) }}><SelectTrigger id="st-count" className="w-64"><SelectValue placeholder="Choose a count" /></SelectTrigger>
              <SelectContent>{(counts.data ?? []).filter((c) => c.status === 'OPEN' || c.status === 'SUBMITTED').map((c) => <SelectItem key={c.id} value={c.id}>{c.count_number} ({c.status.toLowerCase()})</SelectItem>)}</SelectContent></Select></div>}
          {['PICK', 'PACK', 'DISPATCH'].includes(mode) && fulfilment && <p className="text-sm">Consignment <span className="font-medium">{fulfilment.label}</span> <Button size="sm" variant="ghost" onClick={() => { setFulfilment(null); setTally({}) }}>Change</Button></p>}
        </div>
        {posts && !canPost && <p className="text-sm text-amber-800">You can build and review the list, but posting needs the {mode === 'TRANSFER' ? 'transfer' : 'stock movement'} permission.</p>}
        <ScanInput id="station-scan" label={['PICK', 'PACK', 'DISPATCH'].includes(mode) && !fulfilment ? 'Scan the consignment number' : 'Scan an item (or a location to set it)'} onScan={(c) => void scan(c)} disabled={posting} />
        {notice && <p role={notice.tone === 'err' ? 'alert' : 'status'} className={`rounded-lg border px-3 py-2 text-sm ${notice.tone === 'ok' ? 'border-green-200 bg-green-50 text-green-800' : notice.tone === 'warn' ? 'border-amber-200 bg-amber-50 text-amber-900' : 'border-red-200 bg-red-50 text-red-800'}`}>{notice.text}</p>}

        {mode === 'BATCH' && lastMatch && (lastMatch.length ? <ul className="divide-y rounded-lg border">{lastMatch.map((m) => <MatchCard key={`${m.kind}-${m.id}`} m={m} />)}</ul> : null)}

        {posts && (lines.length === 0 ? <p className="text-sm text-muted-foreground">No lines yet. Scan items to add them; scanning the same item again adds one to its quantity.</p> : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-surface-muted/50 text-left text-xs text-muted-foreground"><tr><th className="px-3 py-2">Item</th><th className="px-3 py-2">Quantity</th><th className="px-3 py-2">{mode === 'RECEIPT' ? 'Batch number' : 'Lot'}</th><th className="px-3 py-2">Result</th><th /></tr></thead>
              <tbody className="divide-y">{lines.map((l) => {
                const locked = l.status === 'posted' || l.status === 'posting' || posting
                const set = (c: Partial<StationLine>) => setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, ...c } : x)))
                return (
                  <tr key={l.key} className={l.status === 'posted' ? 'bg-green-50/60' : l.status === 'failed' ? 'bg-red-50/60' : ''}>
                    <td className="px-3 py-2">{l.name}</td>
                    <td className="px-3 py-2"><Input aria-label={`Quantity for ${l.sku}`} className="w-24" inputMode="decimal" disabled={locked} value={l.quantity} onChange={(e) => set({ quantity: e.target.value })} /> <span className="text-xs text-muted-foreground">{l.unit}</span></td>
                    <td className="min-w-56 px-3 py-2">{mode === 'RECEIPT' ? <Input aria-label={`Batch number for ${l.sku}`} className="w-40" maxLength={60} disabled={locked} value={l.batchNumber} onChange={(e) => set({ batchNumber: e.target.value })} />
                      : l.fixedBatchId ? <span className="text-xs">Scanned lot</span> : <LotSelect productId={l.productId} locationId={locationId || null} value={l.lot} onChange={(lot) => set({ lot })} />}</td>
                    <td className="px-3 py-2 text-xs">{l.status === 'posting' ? <Loader2 className="size-4 animate-spin" /> : l.status === 'posted' ? <span className="text-green-800"><CheckCircle2 className="inline size-3" /> {l.result}</span>
                      : l.status === 'failed' ? <span className="text-red-800"><XCircle className="inline size-3" /> {l.result}</span> : 'Not posted'}</td>
                    <td className="px-3 py-2">{!locked && <Button size="icon-sm" variant="ghost" aria-label={`Remove ${l.sku}`} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}><Trash2 /></Button>}</td>
                  </tr>)
              })}</tbody>
            </table>
          </div>))}
        {posts && <div className="flex flex-wrap gap-2">
          <Button disabled={!ready || posting || !canPost} onClick={() => { const v = validate(); if (v) setNotice({ tone: 'err', text: v }); else setConfirming(true) }}>{posting && <Loader2 className="animate-spin" />} Review & post</Button>
          {lines.some((l) => l.status === 'posted') && !posting && <Button variant="outline" onClick={() => setLines((ls) => ls.filter((l) => l.status !== 'posted'))}>Clear posted lines</Button>}
        </div>}

        {!posts && mode !== 'BATCH' && (mode === 'COUNT' ? countId : fulfilment) && (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-surface-muted/50 text-left text-xs text-muted-foreground"><tr><th className="px-3 py-2">Product</th><th className="px-3 py-2 text-right">{mode === 'COUNT' ? 'Recorded count' : mode === 'PICK' ? 'To pick' : mode === 'PACK' ? 'Picked' : 'Packed'}</th><th className="px-3 py-2 text-right">Scanned</th><th className="px-3 py-2">Check</th></tr></thead>
              <tbody className="divide-y">
                {[...expected.entries()].map(([id, e]) => {
                  const s = tally[id] ?? 0
                  return <tr key={id}><td className="px-3 py-2">{e.sku} — {e.name}</td><td className="px-3 py-2 text-right">{e.expected}</td><td className="px-3 py-2 text-right">{s}</td>
                    <td className="px-3 py-2"><StatusBadge label={s === e.expected ? 'Matches' : s < e.expected ? `Short ${e.expected - s}` : `Over ${s - e.expected}`} tone={s === e.expected ? 'success' : 'danger'} /></td></tr>
                })}
                {unexpected.map((id) => <tr key={id}><td className="px-3 py-2" colSpan={2}>Unexpected item scanned</td><td className="px-3 py-2 text-right">{tally[id]}</td><td className="px-3 py-2"><StatusBadge label="Not on this list" tone="danger" /></td></tr>)}
              </tbody>
            </table>
            <p className="border-t px-3 py-2 text-xs text-muted-foreground">Verification only — nothing is recorded. Record {mode === 'COUNT' ? 'counts on the count sheet' : 'picking, packing and dispatch on the consignment'}{mode === 'COUNT' ? <> (<Link className="text-primary hover:underline" to={`/inventory/counts/${countId}`}>open count sheet</Link>)</> : ''}.
              {Object.keys(tally).length > 0 && <Button size="sm" variant="ghost" onClick={() => setTally({})}>Reset scans</Button>}</p>
          </div>
        )}
      </CardContent>
      <ConfirmDialog open={confirming} onOpenChange={setConfirming} title={`Post ${lines.filter((l) => l.status !== 'posted').length} line(s) as ${MODE_LABEL[mode].toLowerCase()}?`} confirmLabel="Post stock"
        description={`${mode === 'TRANSFER' ? `From ${storage.locationLabel(locationId)} to ${storage.locationLabel(toLocationId)}` : storage.locationLabel(locationId)}. ${lines.filter((l) => l.status !== 'posted').map((l) => `${l.sku} × ${l.quantity}`).join(', ')}. Each line is posted separately and recorded in the stock ledger.`}
        onConfirm={() => void postAll()} />
    </Card>
  )
}

function LabelsPanel({ queue, setQueue }: { queue: LabelItem[]; setQueue: (f: (q: LabelItem[]) => LabelItem[]) => void }) {
  const [term, setTerm] = useState('')
  const [onlyBarcode, setOnlyBarcode] = useState(false)
  const [copies, setCopies] = useState(1)
  const search = useDebouncedValue(term, 300)
  const products = useAsync(() => fetchLabelProducts(search, onlyBarcode), [search, onlyBarcode])
  const origin = window.location.origin
  const inQueue = new Set(queue.map((q) => `${q.kind}-${q.id}`))
  const add = (items: LabelItem[]) => setQueue((q) => [...q, ...items.filter((i) => !q.some((x) => x.kind === i.kind && x.id === i.id))])
  const printable = queue.flatMap((q) => Array.from({ length: copies }, (_, i) => ({ ...q, n: i })))
  return (
    <div className="grid gap-6 xl:grid-cols-5">
      <Card className="print-hidden xl:col-span-2">
        <CardHeader><div><CardTitle>Choose labels</CardTitle><CardDescription>Each label has the product barcode (Code 128) and a QR code holding only an internal link; opening it requires signing in.</CardDescription></div></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex-1 space-y-1"><Label htmlFor="lb-search">Search products</Label><Input id="lb-search" value={term} onChange={(e) => setTerm(e.target.value)} placeholder="SKU, name or barcode" /></div>
            <label className="flex items-center gap-2 pb-2 text-sm"><Checkbox checked={onlyBarcode} onCheckedChange={(v) => setOnlyBarcode(v === true)} /> With barcode only</label>
          </div>
          <div className="max-h-96 overflow-y-auto rounded-lg border">
            {products.loading && !products.data ? <p className="p-3 text-sm text-muted-foreground">Loading…</p> : !products.data?.length ? <p className="p-3 text-sm text-muted-foreground">No products found.</p>
              : products.data.map((p) => (
                <label key={p.id} className="flex items-center gap-2 border-b px-3 py-2 text-sm last:border-0">
                  <Checkbox checked={inQueue.has(`P-${p.id}`)} onCheckedChange={(v) => v === true ? add([{ kind: 'P', id: p.id, title: p.sku, subtitle: p.product_name, code: p.barcode }]) : setQueue((q) => q.filter((x) => !(x.kind === 'P' && x.id === p.id)))} />
                  <span className="font-medium">{p.sku}</span><span className="truncate text-muted-foreground">{p.product_name}</span><span className="ml-auto font-mono text-xs">{p.barcode ?? 'no barcode'}</span>
                </label>))}
          </div>
          {products.data && products.data.length > 0 && <Button size="sm" variant="outline" onClick={() => add(products.data!.map((p) => ({ kind: 'P' as ScanKind, id: p.id, title: p.sku, subtitle: p.product_name, code: p.barcode })))}>Add all {products.data.length} shown</Button>}
        </CardContent>
      </Card>
      <Card className="xl:col-span-3">
        <CardHeader className="print-hidden flex flex-row flex-wrap items-end justify-between gap-3">
          <div><CardTitle>Labels ({queue.length})</CardTitle><CardDescription>Printed 3 per row on A4. Use “Add to labels” in Scan & look up for batches, locations or consignments.</CardDescription></div>
          <div className="flex items-end gap-2">
            <div className="space-y-1"><Label htmlFor="lb-copies">Copies each</Label><Input id="lb-copies" className="w-20" inputMode="numeric" value={copies} onChange={(e) => setCopies(Math.max(1, Math.min(50, Number(e.target.value) || 1)))} /></div>
            <Button variant="outline" disabled={!queue.length} onClick={() => setQueue(() => [])}>Clear</Button>
            <Button disabled={!queue.length} onClick={() => window.print()}><Printer /> Print {printable.length}</Button>
          </div>
        </CardHeader>
        <CardContent>
          {!queue.length ? <EmptyState icon={QrCode} title="No labels selected" description="Select products on the left." /> : (
            <div className="print-area grid grid-cols-1 gap-3 sm:grid-cols-2 2xl:grid-cols-3 print:grid-cols-3">
              {printable.map((l) => {
                const code = l.code ?? (isCode128B(l.title) ? l.title : null)
                let qr: string | null = null
                try { qr = scanPayload(origin, l.kind, l.id) } catch { qr = null }
                return (
                  <div key={`${l.kind}-${l.id}-${l.n}`} className="print-avoid-break flex items-center gap-2 rounded-md border p-2">
                    {qr && <QrSvg value={qr} size={72} />}
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-semibold break-all">{l.title}</p>
                      <p className="line-clamp-2 text-[10px] text-muted-foreground">{l.subtitle}</p>
                      {code && <Code128Svg value={code} height={30} moduleWidth={1} className="mt-1 max-w-full" />}
                      {!l.code && l.kind === 'P' && <p className="text-[9px] text-amber-700 print-hidden">No barcode — SKU encoded</p>}
                    </div>
                    <Button size="icon-sm" variant="ghost" className="print-hidden" aria-label={`Remove ${l.title}`} onClick={() => setQueue((q) => q.filter((x) => !(x.kind === l.kind && x.id === l.id)))}><Trash2 /></Button>
                  </div>)
              })}
            </div>)}
        </CardContent>
      </Card>
    </div>
  )
}

function AssignPanel() {
  const [product, setProduct] = useState<ScanMatch | null>(null)
  const [code, setCode] = useState('')
  const [dupes, setDupes] = useState<ScanMatch[] | null>(null)
  const [checking, setChecking] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const pickProduct = (c: string) => {
    setError(null); setMessage(null)
    lookupCode(c).then((r) => {
      const ps = r.matches.filter((m) => m.kind === 'PRODUCT')
      if (ps.length === 1) { setProduct(ps[0]); setCode(''); setDupes(null) } else setError(ps.length ? 'Several products match — scan the SKU.' : 'No product matches that code.')
    }, (e) => setError(describeDataError(e)))
  }
  const check = (c: string) => {
    setCode(c); setChecking(true); setError(null)
    lookupCode(c).then((r) => setDupes(r.matches.filter((m) => m.kind === 'PRODUCT' && m.id !== product?.id && m.matched_on === 'BARCODE')), (e) => setError(describeDataError(e))).finally(() => setChecking(false))
  }
  const save = async () => {
    if (!product) return
    setConfirm(false); setBusy(true); setError(null)
    try {
      const r = await assignBarcode(product.id, code.trim() || null, product.barcode ?? null, Boolean(product.barcode))
      setMessage(r.changed ? `Barcode ${r.barcode ?? '(removed)'} saved for ${product.label}.` : 'No change — the product already has this barcode.')
      setProduct({ ...product, barcode: r.barcode }); setCode(''); setDupes(null)
    } catch (e) { setError(describeDataError(e)) } finally { setBusy(false) }
  }
  const valid = code.trim() === '' || /^[A-Za-z0-9-]{4,64}$/.test(code.trim())
  return (
    <Card>
      <CardHeader><div><CardTitle>Assign a barcode</CardTitle><CardDescription>Barcodes are unique within the company (enforced by the database). Replacing an existing barcode needs confirmation and is audited.</CardDescription></div></CardHeader>
      <CardContent className="space-y-4">
        {message && <p role="status" className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">{message}</p>}
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
        <ScanInput id="as-product" label="1. Scan or type the product SKU" onScan={pickProduct} autoFocus={!product} />
        {product && <>
          <p className="text-sm">Product: <span className="font-medium">{product.label} — {product.detail}</span> · current barcode <span className="font-mono">{product.barcode ?? 'none'}</span></p>
          <ScanInput id="as-code" label="2. Scan the new barcode (or type it)" onScan={check} />
          {code && <div className="space-y-2 text-sm">
            <p>New barcode: <span className="font-mono">{code}</span>{!valid && <span className="text-red-800"> — a barcode has 4–64 letters, digits or hyphens.</span>}</p>
            {checking ? <p className="text-muted-foreground">Checking for duplicates…</p> : dupes && (dupes.length ? <p className="text-red-800">Already used by {dupes.map((d) => d.label).join(', ')}. It cannot be assigned twice.</p> : <p className="text-green-800">Not used by another product.</p>)}
            <Button disabled={busy || checking || !valid || Boolean(dupes?.length) || code === product.barcode} onClick={() => setConfirm(true)}>{busy && <Loader2 className="animate-spin" />} Assign barcode</Button>
          </div>}
          {product.barcode && !code && <Button variant="outline" disabled={busy} onClick={() => { setCode(''); setConfirm(true) }}>Remove barcode</Button>}
        </>}
      </CardContent>
      <ConfirmDialog open={confirm} onOpenChange={setConfirm} title={code ? 'Assign this barcode?' : 'Remove the barcode?'} confirmLabel={code ? 'Assign' : 'Remove'}
        description={product?.barcode ? `${product.label} currently has barcode ${product.barcode}. It will be ${code ? `replaced with ${code}` : 'removed'}; printed labels with the old barcode will no longer match.` : `${product?.label} will get barcode ${code}.`}
        onConfirm={() => void save()} />
    </Card>
  )
}

export default function BarcodeToolsPage() {
  const { has } = usePermissions()
  const [tab, setTab] = useState<Tab>('lookup')
  const [queue, setQueue] = useState<LabelItem[]>([])
  const addLabel = (m: ScanMatch) => { setQueue((q) => (q.some((x) => x.id === m.id) ? q : [...q, { kind: KIND_LETTER[m.kind], id: m.id, title: m.label, subtitle: m.detail, code: m.kind === 'PRODUCT' ? m.barcode ?? null : null }])) }
  return (
    <>
      <PageHeader />
      <Card className="print-hidden mb-4"><CardContent className="flex flex-wrap items-center gap-3 p-4">
        <FilterTabs<Tab> label="Tool" value={tab} onChange={setTab} options={[
          { value: 'lookup', label: 'Scan & look up' }, { value: 'station', label: 'Scan station' }, { value: 'labels', label: `Labels${queue.length ? ` (${queue.length})` : ''}` },
          ...(has('products.update') ? [{ value: 'assign' as Tab, label: 'Assign barcode' }] : [])]} />
        <p className="flex items-center gap-1 text-xs text-muted-foreground"><ScanLine className="size-3.5" /> USB/Bluetooth scanners work everywhere as keyboard input. Camera scanning needs a browser with barcode detection (e.g. Chrome or Edge on Android, Chrome on macOS) over HTTPS.</p>
      </CardContent></Card>
      {tab === 'lookup' && <LookupPanel onLabel={(m) => { addLabel(m) }} />}
      {tab === 'station' && <ScanStation />}
      {tab === 'labels' && <LabelsPanel queue={queue} setQueue={setQueue} />}
      {tab === 'assign' && <AssignPanel />}
    </>
  )
}
