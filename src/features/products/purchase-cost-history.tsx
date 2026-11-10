import { Info, Loader2, PencilLine } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'

import { TrendLineChart } from '@/components/charts/trend-line-chart'
import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatCost } from '@/features/products/product-list-format'
import { ChangeBadge } from '@/features/products/purchase-cost-badge'
import {
  EMPTY_FILTER,
  EVENT_LABELS,
  ZERO_POLICY_LABELS,
  filterHistory,
  historySuppliers,
  signedMoney,
  trendPoints,
  type HistoryFilter,
} from '@/features/products/purchase-cost'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDate, formatDateTime, formatNumber } from '@/lib/format'
import { cn } from '@/lib/utils'
import { fetchPurchaseCostHistory, overridePurchaseCost } from '@/services/purchase-costs'

/** Product page tab: the cost types kept apart, the price trend and every purchase cost event (filterable). */
export function PurchaseCostHistoryTab({ productId, timezone }: { productId: string; timezone?: string }) {
  const [refresh, setRefresh] = useState(0)
  const q = useAsync(() => fetchPurchaseCostHistory(productId), [productId, refresh])
  const [filter, setFilter] = useState<HistoryFilter>(EMPTY_FILTER)
  const rows = useMemo(() => filterHistory(q.data?.events ?? [], filter), [q.data, filter])
  const suppliers = useMemo(() => historySuppliers(q.data?.events ?? []), [q.data])

  if (q.loading && !q.data) return <LoadingState label="Loading purchase cost history…" />
  if (q.error) return <Card><ErrorState message={describeDataError(q.error)} onRetry={q.reload} /></Card>
  if (!q.data) {
    return (
      <Card><CardContent className="py-6 text-sm text-muted-foreground" data-testid="purchase-cost-unavailable">
        Purchase cost history becomes available after database update 20261123090000 is applied.
      </CardContent></Card>
    )
  }
  const h = q.data
  const cur = h.current
  const points = trendPoints(h.events, (e) => formatDate(e.effective_date))
  const set = h.settings

  return (
    <div className="space-y-6" data-testid="purchase-cost-history">
      <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <CostTile label="Last Purchase Cost" testid="pc-current" strong
          value={cur?.cost == null ? '—' : formatCost(cur.cost)}
          sub={cur?.cost != null ? (
            <span className="flex flex-wrap items-center gap-2">
              <ChangeBadge type={cur.change_type} percent={cur.change_percent} difference={cur.difference} />
              <span>{cur.date ? formatDate(cur.date) : ''}{cur.supplier_name ? ` · ${cur.supplier_name}` : ''}</span>
            </span>
          ) : cur ? 'No valid receipt remains' : 'No purchases yet'} />
        <CostTile label="Average Inventory Cost" value={h.average_inventory_cost == null ? '—' : formatCost(h.average_inventory_cost)} sub="Stock on hand, weighted by lot (valuation)" />
        <CostTile label="Standard Manufacturing Cost" value={formatCost(h.product.standard_cost)} sub="Fallback Cost (fewer than two receipts); not changed by purchases" />
        <CostTile label="MRP" value={formatCost(h.product.mrp)} sub="Not changed by purchases" />
        <CostTile label="Selling Price" value={formatCost(h.product.selling_price)} sub="Not changed by purchases" />
      </div>

      <p className="flex flex-wrap items-start gap-x-2 text-xs text-muted-foreground">
        <Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />
        <span>
          {set.auto_update ? 'Updated automatically when a goods receipt is posted' : 'Automatic updates are disabled; receipts are recorded only'}, from the
          accepted unit cost after discount and excluding GST (several lines of one product in a receipt are weighted by accepted quantity).
          Changes of {formatNumber(set.alert_percent)}% or more are flagged. Zero-cost receipts: {ZERO_POLICY_LABELS[set.zero_policy].toLowerCase()}.
        </span>
        <Link to="/admin/erp-settings?tab=products" className="text-primary hover:underline">Settings</Link>
      </p>

      {h.can_override && <OverrideForm productId={productId} onDone={() => setRefresh((n) => n + 1)} />}

      {points.length > 0 && (
        <Card>
          <CardHeader><div><CardTitle>Purchase cost trend</CardTitle>
            <CardDescription>Last Purchase Cost each time it changed (excl. GST, per {h.product.base_unit})</CardDescription></div></CardHeader>
          <CardContent><div className="h-56" data-testid="pc-chart"><TrendLineChart data={points} seriesName="Last Purchase Cost" valueFormatter={(v) => formatCost(v)} fitToData /></div></CardContent>
        </Card>
      )}

      <Card className="overflow-hidden">
        <CardHeader><div><CardTitle>Price history</CardTitle>
          <CardDescription>Every posted receipt, reversal and override, newest first. History records cannot be edited or deleted.</CardDescription></div></CardHeader>
        <CardContent className="grid gap-3 border-b pb-4 sm:grid-cols-2 lg:grid-cols-5" data-testid="pc-filters">
          <div className="space-y-1"><Label htmlFor="pc-from">From</Label>
            <Input id="pc-from" type="date" value={filter.from} onChange={(e) => setFilter({ ...filter, from: e.target.value })} /></div>
          <div className="space-y-1"><Label htmlFor="pc-to">To</Label>
            <Input id="pc-to" type="date" value={filter.to} onChange={(e) => setFilter({ ...filter, to: e.target.value })} /></div>
          <div className="space-y-1"><Label htmlFor="pc-supplier">Supplier</Label>
            <Select value={filter.supplierId || 'all'} onValueChange={(v) => setFilter({ ...filter, supplierId: v === 'all' ? '' : v })}>
              <SelectTrigger id="pc-supplier"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="all">All suppliers</SelectItem>{suppliers.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
            </Select></div>
          <div className="space-y-1"><Label htmlFor="pc-change">Change</Label>
            <Select value={filter.change} onValueChange={(v) => setFilter({ ...filter, change: v as HistoryFilter['change'] })}>
              <SelectTrigger id="pc-change"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="all">Increases and decreases</SelectItem><SelectItem value="increase">Increases only</SelectItem><SelectItem value="decrease">Decreases only</SelectItem></SelectContent>
            </Select></div>
          <div className="flex items-end">
            <Button variant="ghost" size="sm" onClick={() => setFilter(EMPTY_FILTER)} disabled={JSON.stringify(filter) === JSON.stringify(EMPTY_FILTER)}>Clear filters</Button>
          </div>
        </CardContent>
        {rows.length === 0 ? (
          <CardContent className="pt-4"><p className="text-sm text-muted-foreground" data-testid="pc-empty">
            {h.events.length === 0 ? 'No purchases recorded for this product yet.' : 'No history matches these filters.'}</p></CardContent>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Date</TableHead>
                  <TableHead>Supplier</TableHead>
                  <TableHead>PO number</TableHead>
                  <TableHead>GRN number</TableHead>
                  <TableHead className="text-right">Previous cost</TableHead>
                  <TableHead className="text-right">New cost</TableHead>
                  <TableHead className="text-right">Difference</TableHead>
                  <TableHead className="text-right">% change</TableHead>
                  <TableHead className="text-right">Accepted qty</TableHead>
                  <TableHead>User</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((e) => (
                  <TableRow key={e.id} data-testid="pc-event" data-status={e.status} data-type={e.event_type} data-change={e.change_type}
                    className={cn(e.status !== 'APPLIED' && 'text-muted-foreground')}>
                    <TableCell className="whitespace-nowrap">{formatDate(e.effective_date)}</TableCell>
                    <TableCell>{e.supplier_name ?? '—'}</TableCell>
                    <TableCell className="whitespace-nowrap">{e.purchase_order_id ? <Link className="text-primary hover:underline" to={`/purchase-orders/${e.purchase_order_id}`}>{e.po_number}</Link> : '—'}</TableCell>
                    <TableCell className="whitespace-nowrap">{e.goods_receipt_id ? <Link className="text-primary hover:underline" to={`/goods-receipts/${e.goods_receipt_id}`}>{e.receipt_number}</Link> : '—'}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatCost(e.previous_cost)}</TableCell>
                    <TableCell className="text-right tabular-nums font-medium">{formatCost(e.new_cost)}</TableCell>
                    <TableCell className="text-right tabular-nums">{e.change_type === 'INITIAL_COST' || e.change_type === 'NO_COST' ? '—' : signedMoney(e.difference, formatCost)}</TableCell>
                    <TableCell className="text-right"><ChangeBadge type={e.change_type} percent={e.change_percent} />{e.significant && <span className="ml-1 text-[10px] text-amber-800">significant</span>}</TableCell>
                    <TableCell className="text-right tabular-nums">{e.received_quantity === null ? '—' : `${formatNumber(Math.abs(Number(e.received_quantity)))} ${e.unit ?? ''}`}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs">{e.created_by_name ?? 'System'}<br />{formatDateTime(e.created_at, timezone)}</TableCell>
                    <TableCell className="min-w-56 whitespace-normal text-xs">
                      <p className="font-medium text-foreground">{EVENT_LABELS[e.event_type]}{e.reversed ? ' · reversed' : ''} — {e.status === 'APPLIED' ? 'applied' : 'not applied'}</p>
                      <p>{e.not_applied_reason ?? e.reason}</p>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Card>
    </div>
  )
}

/** Exceptional manual override, for the permission chosen in ERP Settings. */
function OverrideForm({ productId, onDone }: { productId: string; onDone: () => void }) {
  const [open, setOpen] = useState(false)
  const [cost, setCost] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null)
  const valid = cost.trim() !== '' && Number(cost) >= 0 && Number.isFinite(Number(cost)) && reason.trim().length >= 5
  const save = async () => {
    setBusy(true); setMessage(null)
    try {
      await overridePurchaseCost(productId, Number(cost), reason.trim())
      setMessage({ tone: 'success', text: 'Last Purchase Cost overridden and recorded in the history and audit log.' })
      setOpen(false); setCost(''); setReason('')
      onDone()
    } catch (e) {
      setMessage({ tone: 'error', text: describeDataError(e) })
    } finally { setBusy(false) }
  }
  return (
    <div className="space-y-2">
      {message && <p role={message.tone === 'error' ? 'alert' : 'status'} className={cn('rounded-lg border px-4 py-2.5 text-sm',
        message.tone === 'error' ? 'border-red-200 bg-red-50 text-red-800' : 'border-green-200 bg-green-50 text-green-800')}>{message.text}</p>}
      {!open ? (
        <Button variant="outline" size="sm" onClick={() => setOpen(true)} data-testid="pc-override-open"><PencilLine /> Override Last Purchase Cost</Button>
      ) : (
        <Card data-testid="pc-override"><CardContent className="grid gap-3 py-4 sm:grid-cols-[10rem_1fr_auto] sm:items-end">
          <div className="space-y-1"><Label htmlFor="pc-ov-cost">New cost (₹)</Label><Input id="pc-ov-cost" inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="pc-ov-reason">Reason (recorded in the audit log)</Label><Input id="pc-ov-reason" maxLength={400} value={reason} onChange={(e) => setReason(e.target.value)} /></div>
          <div className="flex gap-2">
            <Button size="sm" disabled={!valid || busy} onClick={() => void save()}>{busy && <Loader2 className="animate-spin" />} Save override</Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          </div>
        </CardContent></Card>
      )}
    </div>
  )
}

function CostTile({ label, value, sub, strong, testid }: { label: string; value: string; sub?: ReactNode; strong?: boolean; testid?: string }) {
  return (
    <div className={cn('rounded-lg border bg-card p-3', strong && 'border-primary/40')} data-testid={testid}>
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className={cn('mt-1 tabular-nums', strong ? 'text-lg font-semibold' : 'font-medium')}>{value}</p>
      {sub && <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>}
    </div>
  )
}
