import { ArrowDownToLine, ArrowLeftRight, ArrowUpFromLine, Download, FileSpreadsheet, Loader2, RotateCcw, Search, SearchX, X } from 'lucide-react'
import { useMemo, useState } from 'react'

import { PermissionGate } from '@/auth/permission-gate'
import { usePermissions } from '@/auth/use-permissions'
import { DateRangeFilter } from '@/components/common/date-range-filter'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { PaginationBar } from '@/components/common/pagination-bar'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { StockSourceBadge, TransactionTypeBadge } from '@/features/inventory/inventory-badges'
import { STOCK_SOURCE_LABELS, TRANSACTION_TYPE_LABELS, formatQty, type StockSourceCode } from '@/features/inventory/inventory-model'
import { IssueDialog, ReceiptDialog, TransferDialog } from '@/features/inventory/stock-dialogs'
import { useStorage } from '@/features/inventory/use-storage'
import { useAsync } from '@/hooks/use-async'
import { useDebouncedValue } from '@/hooks/use-debounced-value'
import { useRequestKey } from '@/hooks/use-request-key'
import { EXTENDED_DATE_RANGE_PRESETS, getPresetRange } from '@/lib/date-range'
import { describeDataError } from '@/lib/errors'
import { formatCurrency, formatDateTime, formatNumber, toIsoDate } from '@/lib/format'
import { fetchResourceAudit } from '@/services/audit-logs'
import {
  fetchAllMovements,
  fetchMovementUsers,
  fetchMovements,
  fetchRelatedTransactions,
  reverseTransaction,
  type MovementFilters,
} from '@/services/inventory'
import { fetchDisplayNames } from '@/services/products'
import type { TransactionListRow } from '@/types/database-inventory'
import type { DateRangeValue } from '@/types'

function fromTo(t: TransactionListRow) {
  const here = `${t.warehouse_code} / ${t.location_code}`
  const other = t.counterpart_location_code ? `${t.counterpart_warehouse_code} / ${t.counterpart_location_code}` : null
  if (t.transaction_type === 'TRANSFER_OUT') return { from: here, to: other }
  if (t.transaction_type === 'TRANSFER_IN') return { from: other, to: here }
  return t.direction > 0 ? { from: null, to: here } : { from: here, to: null }
}

export default function StockMovementsPage() {
  const { has } = usePermissions()
  const storage = useStorage()
  const users = useAsync(fetchMovementUsers, [])
  const [range, setRange] = useState<DateRangeValue>(() => getPresetRange('this_month'))
  const [search, setSearch] = useState('')
  const term = useDebouncedValue(search)
  const [reference, setReference] = useState('')
  const ref = useDebouncedValue(reference)
  const [type, setType] = useState('all')
  const [source, setSource] = useState('all')
  const [warehouseId, setWarehouseId] = useState('all')
  const [locationId, setLocationId] = useState('all')
  const [userId, setUserId] = useState('all')
  const [ascending, setAscending] = useState(false)
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(25)
  const [refresh, setRefresh] = useState(0)
  const [dialog, setDialog] = useState<null | 'receipt' | 'issue' | 'transfer'>(null)
  const [selected, setSelected] = useState<TransactionListRow | null>(null)
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)
  const [exporting, setExporting] = useState(false)

  const filters: MovementFilters = useMemo(
    () => ({
      from: range.from,
      to: range.to,
      search: term,
      productId: null,
      transactionType: type === 'all' ? null : type,
      source: source === 'all' ? null : source,
      warehouseId: warehouseId === 'all' ? null : warehouseId,
      locationId: locationId === 'all' ? null : locationId,
      batchId: null,
      userId: userId === 'all' ? null : userId,
      reference: ref,
    }),
    [range, term, type, source, warehouseId, locationId, userId, ref],
  )
  const key = JSON.stringify([filters, ascending, pageSize, refresh])
  const [lastKey, setLastKey] = useState(key)
  if (lastKey !== key) {
    setLastKey(key)
    setPage(0)
  }
  const list = useAsync(() => fetchMovements(filters, page, pageSize, ascending), [key, page])
  const names = useAsync(() => fetchDisplayNames((list.data?.rows ?? []).flatMap((t) => [t.created_by, t.approved_by])), [list.data])

  const posted = (message: string) => {
    setNotice({ tone: 'success', text: message })
    setRefresh((n) => n + 1)
  }

  const exportRows = async (format: 'xlsx' | 'csv') => {
    setExporting(true)
    try {
      const [{ downloadSheets }, rows] = await Promise.all([import('@/features/products/spreadsheet'), fetchAllMovements(filters)])
      const userNames = await fetchDisplayNames(rows.flatMap((t) => [t.created_by, t.approved_by]))
      await downloadSheets(
        [{
          name: 'Stock movements',
          rows: [
            ['Transaction', 'Date', 'Type', 'SKU', 'Product', 'Batch', 'Source', 'From', 'To', 'Qty In', 'Qty Out', 'Unit', 'Unit Cost', 'Reference', 'Reason', 'Performed By', 'Approved By', 'Reversed By'],
            ...rows.map((t) => {
              const ft = fromTo(t)
              return [t.transaction_number, formatDateTime(t.transaction_date), TRANSACTION_TYPE_LABELS[t.transaction_type], t.sku, t.product_name, t.batch_number,
                STOCK_SOURCE_LABELS[t.source_type as StockSourceCode], ft.from, ft.to, t.quantity_in === null ? null : Number(t.quantity_in),
                t.quantity_out === null ? null : Number(t.quantity_out), t.unit, t.unit_cost === null ? null : Number(t.unit_cost),
                t.reference_number, t.reason, t.created_by ? (userNames.get(t.created_by) ?? '') : '', t.approved_by ? (userNames.get(t.approved_by) ?? '') : '', t.reversed_by_number]
            }),
          ],
        }],
        `stock-movements-${toIsoDate(range.from)}-to-${toIsoDate(range.to)}`,
        format,
      )
      setNotice({ tone: 'success', text: `Exported ${formatNumber(rows.length)} movements.` })
    } catch (error) {
      setNotice({ tone: 'error', text: describeDataError(error) })
    } finally {
      setExporting(false)
    }
  }

  const rows = list.data?.rows ?? []
  const nameOf = (id: string | null) => (id ? (names.data?.get(id) ?? '…') : '—')

  return (
    <>
      <PageHeader
        actions={
          <>
            <PermissionGate permission="inventory.export">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" disabled={exporting || (list.data?.total ?? 0) === 0}>
                    {exporting ? <Loader2 className="animate-spin" /> : <Download />} Export
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => void exportRows('xlsx')}><FileSpreadsheet /> Excel (.xlsx)</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void exportRows('csv')}><FileSpreadsheet /> CSV</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </PermissionGate>
            {has('inventory_transfer.create') && (
              <Button variant="outline" onClick={() => setDialog('transfer')}><ArrowLeftRight /> Transfer</Button>
            )}
            {has('inventory.create') && (
              <>
                <Button variant="outline" onClick={() => setDialog('issue')}><ArrowUpFromLine /> Issue</Button>
                <Button onClick={() => setDialog('receipt')}><ArrowDownToLine /> Receive</Button>
              </>
            )}
          </>
        }
      />
      {notice && (
        <div role={notice.tone === 'error' ? 'alert' : 'status'}
          className={notice.tone === 'error' ? 'mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800' : 'mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-800'}>
          {notice.text}
        </div>
      )}

      <Card className="overflow-hidden">
        <div className="space-y-3 border-b px-5 py-4">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
            <div className="flex flex-col gap-2 sm:flex-row">
              <div className="relative w-full sm:w-72">
                <Search aria-hidden className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Transaction no., SKU, product, batch…" aria-label="Search movements" className="pl-9" />
              </div>
              <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Reference number" aria-label="Reference number" className="sm:w-44" />
            </div>
            <DateRangeFilter value={range} onChange={setRange} presets={EXTENDED_DATE_RANGE_PRESETS} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select value={type} onValueChange={setType}>
              <SelectTrigger className="w-44" aria-label="Movement type"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All movement types</SelectItem>
                {Object.entries(TRANSACTION_TYPE_LABELS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={source} onValueChange={setSource}>
              <SelectTrigger className="w-40" aria-label="Source"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All sources</SelectItem>
                {Object.entries(STOCK_SOURCE_LABELS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={warehouseId} onValueChange={(v) => { setWarehouseId(v); setLocationId('all') }}>
              <SelectTrigger className="w-44" aria-label="Warehouse"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All warehouses</SelectItem>
                {storage.warehouses.map((w) => <SelectItem key={w.id} value={w.id}>{w.warehouse_code}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={locationId} onValueChange={setLocationId}>
              <SelectTrigger className="w-52" aria-label="Location"><SelectValue /></SelectTrigger>
              <SelectContent className="max-h-72">
                <SelectItem value="all">All locations</SelectItem>
                {storage.allLocations.filter((l) => warehouseId === 'all' || l.warehouseId === warehouseId).map((l) => <SelectItem key={l.id} value={l.id}>{l.label}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={userId} onValueChange={setUserId}>
              <SelectTrigger className="w-44" aria-label="Performed by"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Any user</SelectItem>
                {(users.data ?? []).map((u) => <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>)}
              </SelectContent>
            </Select>
            <Button variant="ghost" size="sm" onClick={() => setAscending((a) => !a)}>{ascending ? 'Oldest first' : 'Newest first'}</Button>
            {(search || reference || type !== 'all' || source !== 'all' || warehouseId !== 'all' || locationId !== 'all' || userId !== 'all') && (
              <Button variant="ghost" size="sm" onClick={() => { setSearch(''); setReference(''); setType('all'); setSource('all'); setWarehouseId('all'); setLocationId('all'); setUserId('all') }}>
                <X /> Clear filters
              </Button>
            )}
          </div>
        </div>

        {list.loading && !list.data ? (
          <LoadingState variant="table" rows={6} />
        ) : list.error ? (
          <ErrorState message={describeDataError(list.error)} onRetry={list.reload} />
        ) : rows.length === 0 ? (
          <EmptyState icon={SearchX} title="No movements in this period" description="Ledger entries appear here once stock is received, issued, transferred or adjusted." />
        ) : (
          <div className={list.loading ? 'opacity-60' : undefined}>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Transaction</TableHead>
                  <TableHead>Date &amp; time</TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead>Movement</TableHead>
                  <TableHead className="text-right">In</TableHead>
                  <TableHead className="text-right">Out</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>From</TableHead>
                  <TableHead>To</TableHead>
                  <TableHead>Reference</TableHead>
                  <TableHead>Performed by</TableHead>
                  <TableHead>Approved by</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((t) => {
                  const ft = fromTo(t)
                  return (
                    <TableRow key={t.id} className="cursor-pointer" onClick={() => setSelected(t)}>
                      <TableCell className="font-medium text-primary">{t.transaction_number}</TableCell>
                      <TableCell className="text-muted-foreground">{formatDateTime(t.transaction_date)}</TableCell>
                      <TableCell className="min-w-44 whitespace-normal"><span className="font-medium">{t.sku}</span> <span className="text-muted-foreground">{t.product_name}</span>{t.batch_number && <span className="block text-xs text-muted-foreground">Batch {t.batch_number}</span>}</TableCell>
                      <TableCell><TransactionTypeBadge type={t.transaction_type} direction={t.direction} /></TableCell>
                      <TableCell className="text-right tabular-nums text-green-700">{t.quantity_in ? formatQty(t.quantity_in, t.unit) : ''}</TableCell>
                      <TableCell className="text-right tabular-nums">{t.quantity_out ? formatQty(t.quantity_out, t.unit) : ''}</TableCell>
                      <TableCell><StockSourceBadge source={t.source_type} /></TableCell>
                      <TableCell>{ft.from ?? '—'}</TableCell>
                      <TableCell>{ft.to ?? '—'}</TableCell>
                      <TableCell>{t.reference_number ?? '—'}</TableCell>
                      <TableCell>{nameOf(t.created_by)}</TableCell>
                      <TableCell>{nameOf(t.approved_by)}</TableCell>
                      <TableCell className="max-w-56 truncate" title={t.reason}>{t.reason}</TableCell>
                      <TableCell className="text-xs">
                        Posted
                        {t.reversed_by_number && <span className="block text-amber-800">Reversed by {t.reversed_by_number}</span>}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
            <PaginationBar page={page} pageSize={pageSize} total={list.data?.total ?? 0} onPageChange={setPage} onPageSizeChange={setPageSize} disabled={list.loading} />
          </div>
        )}
      </Card>

      <ReceiptDialog open={dialog === 'receipt'} onOpenChange={(o) => setDialog(o ? 'receipt' : null)} locations={storage.activeLocations} defaultLocationId={storage.defaultLocationId} onPosted={posted} />
      <IssueDialog open={dialog === 'issue'} onOpenChange={(o) => setDialog(o ? 'issue' : null)} locations={storage.activeLocations} onPosted={posted} />
      <TransferDialog open={dialog === 'transfer'} onOpenChange={(o) => setDialog(o ? 'transfer' : null)} locations={storage.activeLocations} onPosted={posted} />
      {selected && <TransactionDetail tx={selected} onClose={() => setSelected(null)} onReversed={(m) => { setSelected(null); posted(m) }} />}
    </>
  )
}

function TransactionDetail({ tx, onClose, onReversed }: { tx: TransactionListRow; onClose: () => void; onReversed: (message: string) => void }) {
  const { has } = usePermissions()
  const related = useAsync(() => fetchRelatedTransactions(tx), [tx.id])
  const audit = useAsync(() => (has('audit_logs.read') ? fetchResourceAudit('inventory_transaction', tx.id) : Promise.resolve([])), [tx.id])
  const names = useAsync(() => fetchDisplayNames([...(related.data ?? []).flatMap((t) => [t.created_by, t.approved_by]), ...(audit.data ?? []).map((a) => a.actor_user_id)]), [related.data, audit.data])
  const { key, renew } = useRequestKey()
  const [reversing, setReversing] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ft = fromTo(tx)
  const canReverse = has('inventory.approve_adjustment') && tx.transaction_type !== 'REVERSAL' && !tx.reversed_by_number
  const name = (id: string | null) => (id ? (names.data?.get(id) ?? '…') : '—')

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{tx.transaction_number}</DialogTitle>
          <DialogDescription>Posted ledger entry (read-only). Corrections are made with a reversal, never by editing.</DialogDescription>
        </DialogHeader>
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
          {[
            ['Type', <TransactionTypeBadge key="t" type={tx.transaction_type} direction={tx.direction} />],
            ['Effective date', formatDateTime(tx.transaction_date)],
            ['Recorded at', formatDateTime(tx.created_at)],
            ['Product', `${tx.sku} — ${tx.product_name}`],
            ['Quantity', `${tx.direction > 0 ? '+' : '−'}${formatQty(tx.quantity, tx.unit)}`],
            ['Source', <StockSourceBadge key="s" source={tx.source_type} />],
            ['Batch', tx.batch_number ?? '—'],
            ['From', ft.from ?? '—'],
            ['To', ft.to ?? '—'],
            ['Unit cost', tx.unit_cost === null ? 'Not recorded' : formatCurrency(Number(tx.unit_cost))],
            ['Reference', [tx.reference_type, tx.reference_number].filter(Boolean).join(' ') || '—'],
            ['Document', tx.document_type ?? '—'],
            ['Performed by', name(tx.created_by)],
            ['Approved by', name(tx.approved_by)],
            ['Status', tx.reversed_by_number ? `Posted · reversed by ${tx.reversed_by_number}` : tx.reversal_of_number ? `Reversal of ${tx.reversal_of_number}` : 'Posted'],
          ].map(([label, value]) => (
            <div key={label as string}>
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="mt-0.5">{value}</dd>
            </div>
          ))}
          <div className="sm:col-span-3">
            <dt className="text-xs text-muted-foreground">Reason</dt>
            <dd className="mt-0.5">{tx.reason}</dd>
          </div>
          {tx.notes && (
            <div className="sm:col-span-3">
              <dt className="text-xs text-muted-foreground">Notes</dt>
              <dd className="mt-0.5 whitespace-pre-line">{tx.notes}</dd>
            </div>
          )}
        </dl>
        {(related.data ?? []).length > 1 && (
          <div>
            <p className="mb-1 text-xs font-medium text-muted-foreground">Linked entries</p>
            <ul className="space-y-1 text-sm">
              {(related.data ?? []).filter((r) => r.id !== tx.id).map((r) => (
                <li key={r.id}>{r.transaction_number} · {TRANSACTION_TYPE_LABELS[r.transaction_type]} · {r.direction > 0 ? '+' : '−'}{formatQty(r.quantity, r.unit)} · {r.location_code} · {formatDateTime(r.transaction_date)}</li>
              ))}
            </ul>
          </div>
        )}
        {(audit.data ?? []).length > 0 && (
          <div>
            <p className="mb-1 text-xs font-medium text-muted-foreground">Audit trail</p>
            <ul className="space-y-1 text-sm">
              {(audit.data ?? []).map((a) => <li key={a.id}>{formatDateTime(a.event_timestamp)} · {a.action} · {name(a.actor_user_id)}</li>)}
            </ul>
          </div>
        )}
        {reversing && (
          <div className="space-y-1.5">
            <Label htmlFor="rev-reason">Reason for reversal</Label>
            <Textarea id="rev-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={400} />
            <p className="text-xs text-muted-foreground">
              A REVERSAL entry with the opposite quantity is posted now; this entry stays in the ledger.{tx.transfer_group_id && ' Both legs of the transfer are reversed.'}
            </p>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Close</Button>
          {canReverse && !reversing && (
            <Button variant="outline" onClick={() => setReversing(true)}><RotateCcw /> Reverse…</Button>
          )}
          {reversing && (
            <Button
              variant="destructive"
              disabled={busy || reason.trim().length < 3}
              onClick={async () => {
                setBusy(true)
                setError(null)
                try {
                  const result = await reverseTransaction(tx.id, reason.trim(), key)
                  renew()
                  onReversed(`Reversed ${tx.transaction_number}: ${result.reversal_numbers.join(', ')}.`)
                } catch (e) {
                  setError(describeDataError(e))
                } finally {
                  setBusy(false)
                }
              }}
            >
              {busy && <Loader2 className="animate-spin" />} Post reversal
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
