import { Columns3, List, Loader2, Plus, Settings2, Star, Search, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'

import { EmptyState } from '@/components/common/empty-state'
import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { PaginationBar } from '@/components/common/pagination-bar'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { CustomerPicker } from '@/features/support/customer-picker'
import { ManageStagesDialog } from '@/features/support/pipeline/manage-stages-dialog'
import { OutcomeIcon, PipelineBoard } from '@/features/support/pipeline/pipeline-board'
import { PipelineDialog } from '@/features/support/pipeline/pipeline-dialog'
import { SCOPES, SORTS, moveCard, needsReopenReason } from '@/features/support/pipeline/pipeline-model'
import { PriorityBadge, SlaBadge } from '@/features/support/support-components'
import { ReasonDialog } from '@/features/support/support-dialogs'
import { PRIORITIES, PRIORITY_META } from '@/features/support/support-model'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import { fetchAgents } from '@/services/support'
import { fetchBoard, fetchPipelineList, moveTicketStage, type BoardFilters, type BoardStage, type PipelineCard, type PipelinesInfo } from '@/services/pipelines'

const ALL = 'all'
const PAGE_SIZE = 50
const FILTER_KEYS = ['scope', 'q', 'priority', 'agent', 'customer', 'category', 'product', 'from', 'to']

/**
 * A text filter typed here and written to the URL after a pause. The URL stays the source: when it changes
 * (Clear filters, Back) the box follows it, and nothing is written back from an older snapshot of the URL.
 */
function useUrlText(urlValue: string, commit: (v: string) => void, ms: number): [string, (v: string) => void] {
  const [text, setText] = useState(urlValue)
  const [seen, setSeen] = useState(urlValue)
  if (urlValue !== seen) { setSeen(urlValue); setText(urlValue) }
  const commitRef = useRef(commit)
  useEffect(() => { commitRef.current = commit })
  useEffect(() => {
    if (text.trim() === seen) return
    const t = setTimeout(() => commitRef.current(text.trim()), ms)
    return () => clearTimeout(t)
  }, [text, seen, ms])
  return [text, setText]
}

/**
 * Support Tickets as a Customer Support pipeline: Kanban board or list for one pipeline, with filters kept in the URL
 * (so Back from a ticket returns to the same view). Moves call the server, which applies the ticket status rules.
 */
export function PipelineView({ info, reloadInfo, onPipelineChange }: { info: PipelinesInfo; reloadInfo: () => void; onPipelineChange: (id: string) => void }) {
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const get = (k: string) => params.get(k) ?? ''
  const setParam = (k: string, v: string, extra: Record<string, string> = {}) => setParams((prev) => {
    const n = new URLSearchParams(prev)
    for (const [key, value] of Object.entries({ [k]: v, ...extra })) { if (!value || value === ALL) n.delete(key); else n.set(key, value) }
    n.delete('page')
    return n
  }, { replace: true })
  const pipelines = info.pipelines.filter((p) => p.is_active || p.id === get('pipeline'))
  const pipeline = info.pipelines.find((p) => p.id === get('pipeline')) ?? info.pipelines.find((p) => p.is_default) ?? info.pipelines[0]
  useEffect(() => { onPipelineChange(pipeline.id) }, [pipeline.id, onPipelineChange])
  const layout = get('layout') === 'list' ? 'list' : 'board'
  const page = Math.max(0, Number(get('page') || 0))
  const [search, setSearch] = useUrlText(get('q'), (v) => setParam('q', v), 300)
  const [category, setCategory] = useUrlText(get('category'), (v) => setParam('category', v), 400)
  const [product, setProduct] = useUrlText(get('product'), (v) => setParam('product', v), 400)
  const agents = useAsync(() => fetchAgents().catch(() => []), [])

  const filters: BoardFilters = {
    pipeline_id: pipeline.id, scope: get('scope') || 'ALL', search: get('q') || undefined, priority: get('priority') || undefined, agent_id: get('agent') || undefined,
    customer_id: get('customer') || undefined, category: get('category') || undefined, product: get('product') || undefined, from: get('from') || undefined, to: get('to') || undefined,
    sort: get('sort') || 'created_desc',
  }
  const key = JSON.stringify(filters)
  const board = useAsync(() => (layout === 'board' ? fetchBoard(filters) : Promise.resolve(null)), [key, layout]) // eslint-disable-line react-hooks/exhaustive-deps
  const list = useAsync(() => (layout === 'list' ? fetchPipelineList({ ...filters, limit: PAGE_SIZE, offset: page * PAGE_SIZE }) : Promise.resolve(null)), [key, layout, page]) // eslint-disable-line react-hooks/exhaustive-deps

  // Optimistic moves, tied to the board data they were made on (a reload shows the server's truth).
  const [moves, setMoves] = useState<{ base: unknown; map: Record<string, string> }>({ base: null, map: {} })
  const [saving, setSaving] = useState<Set<string>>(new Set())
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reopen, setReopen] = useState<{ card: PipelineCard; to: BoardStage } | null>(null)
  const [manage, setManage] = useState(false)
  const [pipelineDialog, setPipelineDialog] = useState<'new' | 'edit' | null>(null)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const stages = useMemo(() => {
    if (!board.data) return null
    let s = board.data.stages
    if (moves.base === board.data) for (const [card, to] of Object.entries(moves.map)) s = moveCard(s, card, to)
    return s
  }, [board.data, moves])

  const doMove = (card: PipelineCard, to: BoardStage, note: string | null) => {
    if (saving.has(card.id)) return Promise.resolve()
    const from = board.data?.stages.find((s) => s.cards.some((c) => c.id === card.id))
    setError(null); setNotice(null)
    setMoves((m) => ({ base: board.data, map: { ...(m.base === board.data ? m.map : {}), [card.id]: to.id } }))
    setSaving((s) => new Set(s).add(card.id))
    return moveTicketStage(card.id, to.id, from?.id ?? card.stage_id, note).then(
      () => { setNotice(`${card.ticket_number} moved to ${to.stage_name}.`); board.reload() },
      (e) => {
        // Restore the card where it was and show why.
        setMoves((m) => { const map = { ...m.map }; delete map[card.id]; return { ...m, map } })
        setError(`${card.ticket_number} was not moved: ${describeDataError(e)}`)
        board.reload()
        throw e
      },
    ).finally(() => setSaving((s) => { const n = new Set(s); n.delete(card.id); return n }))
  }
  const onMove = (card: PipelineCard, to: BoardStage) => {
    if (saving.has(card.id) || card.stage_id === to.id) return
    if (needsReopenReason(card, to)) { setReopen({ card, to }); return }
    void doMove(card, to, null).catch(() => {})
  }

  const filterSelect = (k: string, label: string, options: readonly (readonly [string, string])[], width = 'w-40', fallback = ALL) => (
    <Select value={get(k) || fallback} onValueChange={(v) => setParam(k, v === fallback && fallback !== ALL ? '' : v)}>
      <SelectTrigger aria-label={label} className={`h-9 ${width}`}><SelectValue /></SelectTrigger>
      <SelectContent>{fallback === ALL && <SelectItem value={ALL}>{`All ${label.toLowerCase()}`}</SelectItem>}{options.map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
    </Select>
  )
  const active = FILTER_KEYS.filter((k) => params.get(k))
  const data = layout === 'board' ? board : list

  return (
    <div className="space-y-3" data-testid="pipeline-view">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={pipeline.id} onValueChange={(v) => setParams((prev) => { const n = new URLSearchParams(prev); n.set('pipeline', v); n.delete('page'); return n }, { replace: true })}>
          <SelectTrigger aria-label="Pipeline" className="h-9 w-56 font-medium" data-testid="pipeline-select"><SelectValue /></SelectTrigger>
          <SelectContent>{pipelines.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}{p.is_default ? ' (default)' : ''}{p.is_active ? '' : ' (inactive)'}</SelectItem>)}</SelectContent>
        </Select>
        {(info.can.manage_stages || info.can.create || info.can.update) && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button variant="outline" size="sm" className="h-9" data-testid="pipeline-menu"><Settings2 /> Pipeline</Button></DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {info.can.manage_stages && <DropdownMenuItem onSelect={() => setManage(true)} data-testid="manage-stages">Manage Stages</DropdownMenuItem>}
              {info.can.update && <DropdownMenuItem onSelect={() => setPipelineDialog('edit')}>Edit pipeline</DropdownMenuItem>}
              {(info.can.manage_stages || info.can.update) && info.can.create && <DropdownMenuSeparator />}
              {info.can.create && <DropdownMenuItem onSelect={() => setPipelineDialog('new')}><Plus className="size-4" />New pipeline</DropdownMenuItem>}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {filterSelect('scope', 'View', SCOPES, 'w-44', 'ALL')}
        <div className="ml-auto inline-flex rounded-md border p-0.5" role="group" aria-label="Layout">
          <Button size="sm" variant={layout === 'board' ? 'secondary' : 'ghost'} className="h-8" onClick={() => setParam('layout', '')} aria-pressed={layout === 'board'} data-testid="layout-board"><Columns3 /> Kanban</Button>
          <Button size="sm" variant={layout === 'list' ? 'secondary' : 'ghost'} className="h-8" onClick={() => setParam('layout', 'list')} aria-pressed={layout === 'list'} data-testid="layout-list"><List /> List</Button>
        </div>
      </div>
      {/* Phones: filters folded behind a button so the board stays in view. */}
      <Button variant="outline" size="sm" className="sm:hidden" onClick={() => setFiltersOpen((o) => !o)} aria-expanded={filtersOpen} data-testid="filters-toggle">
        <Search /> Filters{active.length ? ` (${active.length})` : ''}</Button>
      <Card className={`${filtersOpen ? 'flex' : 'hidden'} flex-row flex-wrap items-center gap-2 p-3 sm:flex`}>
        <div className="relative min-w-56 flex-1">
          <Search aria-hidden className="absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
          <Input aria-label="Search tickets" className="pl-8" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Ticket number, subject, customer, phone or email" data-testid="pipeline-search" />
        </div>
        {filterSelect('priority', 'Priorities', PRIORITIES.map((p) => [p, PRIORITY_META[p].label] as const))}
        {filterSelect('agent', 'Agents', (agents.data ?? []).map((a) => [a.id, a.display_name] as const))}
        <div className="w-60"><CustomerPicker value={get('customer') ? { id: get('customer'), label: get('customer_label') || 'Customer' } : null}
          onChange={(c) => setParam('customer', c?.id ?? '', { customer_label: c?.label ?? '' })} /></div>
        <Input aria-label="Category" className="h-9 w-36" value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Category" />
        <Input aria-label="Product or SKU" className="h-9 w-40" value={product} onChange={(e) => setProduct(e.target.value)} placeholder="Product / SKU" data-testid="pipeline-product" />
        <label className="flex items-center gap-1 text-xs text-muted-foreground">From<Input type="date" aria-label="Created from" className="h-9 w-36" value={get('from')} onChange={(e) => setParam('from', e.target.value)} /></label>
        <label className="flex items-center gap-1 text-xs text-muted-foreground">To<Input type="date" aria-label="Created to" className="h-9 w-36" value={get('to')} onChange={(e) => setParam('to', e.target.value)} /></label>
        {filterSelect('sort', 'Sort', SORTS, 'w-48', 'created_desc')}
        {active.length > 0 && <Button variant="ghost" size="sm" onClick={() => { setParams((prev) => { const n = new URLSearchParams(); for (const k of ['view', 'pipeline', 'layout', 'sort']) { const v = prev.get(k); if (v) n.set(k, v) } return n }, { replace: true }) }}><X /> Clear filters</Button>}
      </Card>
      {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800" data-testid="move-error">{error}</p>}
      {notice && <p role="status" className="rounded-lg border border-green-200 bg-green-50 px-4 py-2 text-sm text-green-800" data-testid="move-notice">{notice}</p>}
      {data.loading && !data.data ? <Card><LoadingState rows={6} /></Card>
        : data.error ? <Card><ErrorState message={describeDataError(data.error)} onRetry={data.reload} /></Card>
        : layout === 'board' && stages ? (
          <>
            {board.loading && <p className="flex items-center gap-1 text-xs text-muted-foreground"><Loader2 className="size-3 animate-spin" />Refreshing…</p>}
            <PipelineBoard stages={stages} canMove={info.can.move} saving={saving} onMove={onMove} />
          </>
        ) : layout === 'list' && list.data ? (
          <Card className="gap-0 overflow-hidden p-0">
            {list.data.rows.length === 0 ? <EmptyState icon={Star} title={active.length ? 'No ticket matches these filters' : 'No tickets in this pipeline yet'} description="Change or clear the filters." /> : (
              <div className="overflow-x-auto">
                <Table data-testid="pipeline-list">
                  <TableHeader><TableRow className="hover:bg-transparent"><TableHead>Ticket</TableHead><TableHead>Subject</TableHead><TableHead>Customer</TableHead><TableHead>Stage</TableHead>
                    <TableHead>Priority</TableHead><TableHead>SLA</TableHead><TableHead>Agent</TableHead><TableHead>Created</TableHead><TableHead>Updated</TableHead></TableRow></TableHeader>
                  <TableBody>{list.data.rows.map((t) => {
                    const st = pipeline.stages.find((s) => s.id === t.stage_id)
                    return (
                      <TableRow key={t.id} className="cursor-pointer" onClick={() => navigate(`/support/tickets/${t.id}`)}>
                        <TableCell className="font-medium whitespace-nowrap">{t.ticket_number}</TableCell>
                        <TableCell className="max-w-72 truncate">{t.subject}{t.products?.length ? <span className="block truncate text-xs text-muted-foreground">{t.products.map((p) => p.sku).join(', ')}</span> : null}</TableCell>
                        <TableCell className="max-w-48 truncate">{t.customer_name ?? t.customer_phone ?? t.customer_email ?? '—'}</TableCell>
                        <TableCell className="whitespace-nowrap"><span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full" style={{ background: st?.color }} />{st?.stage_name ?? '—'}<OutcomeIcon outcome={t.outcome_type} /></span></TableCell>
                        <TableCell><PriorityBadge priority={t.priority} /></TableCell>
                        <TableCell><SlaBadge status={t.sla_status} /></TableCell>
                        <TableCell className="whitespace-nowrap">{t.assigned_agent ?? <span className="text-muted-foreground">Unassigned</span>}</TableCell>
                        <TableCell className="text-xs whitespace-nowrap">{formatDateTime(t.created_at)}</TableCell>
                        <TableCell className="text-xs whitespace-nowrap">{formatDateTime(t.updated_at)}</TableCell>
                      </TableRow>
                    )
                  })}</TableBody>
                </Table>
              </div>
            )}
            {list.data.total > 0 && <PaginationBar page={page} pageSize={PAGE_SIZE} total={list.data.total} disabled={list.loading}
              onPageChange={(p) => setParams((prev) => { const n = new URLSearchParams(prev); if (p) n.set('page', String(p)); else n.delete('page'); return n }, { replace: true })} />}
          </Card>
        ) : null}
      <ReasonDialog open={reopen !== null} onOpenChange={(o) => { if (!o) setReopen(null) }} title={reopen ? `Reopen ${reopen.card.ticket_number}` : 'Reopen'}
        description={reopen ? `Moving it to "${reopen.to.stage_name}" reopens the ticket. The reopen and its reason are recorded in its history.` : ''}
        confirmLabel="Reopen and move" onConfirm={async (reason) => { if (reopen) await doMove(reopen.card, reopen.to, reason) }} />
      {manage && <ManageStagesDialog pipeline={pipeline} onClose={(changed) => { setManage(false); if (changed) { reloadInfo(); board.reload(); list.reload() } }} />}
      {pipelineDialog && <PipelineDialog existing={pipelineDialog === 'edit' ? pipeline : null} canDelete={info.can.delete}
        onClose={() => setPipelineDialog(null)} onSaved={(id) => { setPipelineDialog(null); reloadInfo(); setParams((prev) => { const n = new URLSearchParams(prev); n.set('pipeline', id); return n }, { replace: true }) }} />}
    </div>
  )
}
