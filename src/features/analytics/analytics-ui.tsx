import { AlertTriangle, Download, Info, Loader2, Lock, Printer, RefreshCw, X, type LucideIcon } from 'lucide-react'
import { useState, type ReactNode } from 'react'

import { PageHeader } from '@/components/common/page-header'
import { CompanyLogo } from '@/components/layout/company-logo'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { buildExportSheets, reportMetaRows, type ActiveFilter, type ExportSection } from '@/features/analytics/analytics-format'
import type { FilterOption } from '@/features/analytics/analytics-options'
import { describePeriod, financialYears, formatIso, isIsoDate, PERIOD_PRESETS, type PeriodPreset } from '@/features/analytics/analytics-period'
import type { AnalyticsFilters } from '@/features/analytics/use-analytics'
import { formatDateTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { AnalyticsContext } from '@/services/analytics'

// ---------------------------------------------------------------------------
// Header: company, title, period, last successful refresh, refresh/print/export
// ---------------------------------------------------------------------------
export function AnalyticsHeader({ ctx, filters, lastSuccessAt, loading, onRefresh, exportButton, extraNote }: {
  ctx: AnalyticsContext | null
  filters: AnalyticsFilters
  lastSuccessAt: string | null
  loading: boolean
  onRefresh: () => void
  exportButton?: ReactNode
  extraNote?: ReactNode
}) {
  return (
    <div className="print-hidden">
      <PageHeader actions={<>
        <span className="text-xs text-muted-foreground" aria-live="polite">
          {lastSuccessAt ? <>Last refreshed {formatDateTime(lastSuccessAt)}</> : loading ? 'Loading…' : 'Not loaded'}
        </span>
        <Button variant="outline" size="sm" onClick={onRefresh} disabled={loading}><RefreshCw className={loading ? 'animate-spin' : undefined} /> Refresh</Button>
        <Button variant="outline" size="sm" onClick={() => window.print()}><Printer /> Print</Button>
        {exportButton}
      </>} />
      <div className="-mt-3 mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
        <span className="inline-flex items-center gap-2"><CompanyLogo className="scale-75 origin-left" /><span className="sr-only">{ctx?.company.legal_name}</span></span>
        <span>Reporting period: <span className="font-medium text-foreground">{describePeriod(filters)}</span>{filters.fy ? ` (FY ${filters.fy})` : ''}</span>
        {extraNote}
      </div>
    </div>
  )
}

/** Shown only when printing: the report context on paper. */
export function PrintHeader({ title, ctx, filters, active, generatedAt }: { title: string; ctx: AnalyticsContext | null; filters: AnalyticsFilters; active: ActiveFilter[]; generatedAt: string | null }) {
  return (
    <div className="mb-4 hidden border-b pb-3 text-sm print:block">
      <p className="text-lg font-semibold">{ctx?.company.legal_name ?? ''} — {title}</p>
      <p>Reporting period: {describePeriod(filters)}{filters.asOf ? ` · balances as of ${formatIso(filters.asOf)}` : ''}</p>
      <p>Filters: {active.length ? active.map((f) => `${f.label}: ${f.value}`).join('; ') : 'none'}</p>
      <p>Generated: {generatedAt ? formatDateTime(generatedAt) : '—'}</p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export function PeriodControls({ ctx, filters, update, showAsOf = false }: {
  ctx: AnalyticsContext | null
  filters: AnalyticsFilters
  update: (c: Partial<AnalyticsFilters>) => void
  showAsOf?: boolean
}) {
  const today = ctx?.today ?? filters.to
  const years = financialYears(today, ctx?.fy_start_month ?? 4, 6)
  const [draft, setDraft] = useState<{ from: string; to: string } | null>(null)
  const custom = filters.preset === 'custom'
  return (
    <>
      <div className="space-y-1">
        <Label htmlFor="af-period">Period</Label>
        <Select value={filters.preset} onValueChange={(v) => {
          if (v === 'custom') { setDraft({ from: filters.from, to: filters.to }); update({ preset: 'custom', from: filters.from, to: filters.to }) }
          else update({ preset: v as PeriodPreset })
        }}>
          <SelectTrigger id="af-period" className="w-48"><SelectValue /></SelectTrigger>
          <SelectContent>{PERIOD_PRESETS.map((p) => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="af-fy">Financial year</Label>
        <Select value={filters.fy ?? 'none'} onValueChange={(v) => {
          const y = years.find((x) => x.label === v)
          if (y) update({ preset: 'custom', from: y.from, to: y.to, fy: y.label })
          else update({ fy: null })
        }}>
          <SelectTrigger id="af-fy" className="w-36"><SelectValue placeholder="—" /></SelectTrigger>
          <SelectContent><SelectItem value="none">Not selected</SelectItem>{years.map((y) => <SelectItem key={y.label} value={y.label}>FY {y.label}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      {custom && (
        <>
          <div className="space-y-1"><Label htmlFor="af-from">From</Label>
            <Input id="af-from" type="date" max={today} value={draft?.from ?? filters.from} onChange={(e) => setDraft({ from: e.target.value, to: draft?.to ?? filters.to })}
              onBlur={() => draft && isIsoDate(draft.from) && draft.from <= (draft.to ?? filters.to) && update({ preset: 'custom', from: draft.from, to: draft.to, fy: null })} /></div>
          <div className="space-y-1"><Label htmlFor="af-to">To</Label>
            <Input id="af-to" type="date" max={today} value={draft?.to ?? filters.to} onChange={(e) => setDraft({ from: draft?.from ?? filters.from, to: e.target.value })}
              onBlur={() => draft && isIsoDate(draft.to) && (draft.from ?? filters.from) <= draft.to && update({ preset: 'custom', from: draft.from, to: draft.to, fy: null })} /></div>
        </>
      )}
      {showAsOf && (
        <div className="space-y-1"><Label htmlFor="af-asof">Balances as of</Label>
          <Input id="af-asof" type="date" value={filters.asOf ?? ''} onChange={(e) => update({ asOf: isIsoDate(e.target.value) ? e.target.value : null })} /></div>
      )}
    </>
  )
}

export function SelectFilter({ id, label, value, onChange, options, allLabel = 'All', width = 'w-44' }: {
  id: string
  label: string
  value: string | null
  onChange: (v: string | null) => void
  options: FilterOption[]
  allLabel?: string
  width?: string
}) {
  return (
    <div className="space-y-1"><Label htmlFor={id}>{label}</Label>
      <Select value={value ?? 'all'} onValueChange={(v) => onChange(v === 'all' ? null : v)}>
        <SelectTrigger id={id} className={width}><SelectValue /></SelectTrigger>
        <SelectContent className="max-h-72"><SelectItem value="all">{allLabel}</SelectItem>{options.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
      </Select>
    </div>
  )
}

export function FilterBar({ children, active, onClear, appliesTo }: { children: ReactNode; active: ActiveFilter[]; onClear: () => void; appliesTo?: string }) {
  return (
    <Card className="print-hidden mb-6">
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-end gap-3">{children}</div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted-foreground">Active filters:</span>
          {active.length === 0 ? <span className="text-muted-foreground">none</span> : active.map((f) => (
            <span key={f.label} className="rounded-full border bg-surface-muted px-2 py-0.5">{f.label}: <span className="font-medium">{f.value}</span></span>
          ))}
          {active.length > 0 && <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={onClear}><X className="size-3" /> Clear filters</Button>}
          {appliesTo && <span className="basis-full text-muted-foreground">{appliesTo}</span>}
        </div>
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------
export function StaleBanner({ error, failedAt, lastSuccessAt, onRetry }: { error: string | null; failedAt: string | null; lastSuccessAt: string | null; onRetry: () => void }) {
  if (!error) return null
  return (
    <div role="alert" className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800">
      <AlertTriangle className="size-4" />
      <span>Refresh failed{failedAt ? ` at ${formatDateTime(failedAt)}` : ''}: {error}.</span>
      <span>{lastSuccessAt ? `The figures below are from the last successful refresh (${formatDateTime(lastSuccessAt)}) and may be out of date.` : 'No data could be loaded.'}</span>
      <Button size="sm" variant="outline" className="ml-auto" onClick={onRetry}>Retry</Button>
    </div>
  )
}

export function UnavailableCard({ title, reason, className }: { title: string; reason: string; className?: string }) {
  return (
    <Card className={cn('gap-2 border-dashed p-5', className)}>
      <p className="flex items-center gap-2 text-sm font-medium text-muted-foreground"><Lock className="size-4" /> {title}</p>
      <p className="text-sm text-muted-foreground">{reason}</p>
    </Card>
  )
}

export type MetricAccent = 'blue' | 'purple' | 'green' | 'orange' | 'red' | 'neutral'
const ACCENT: Record<MetricAccent, string> = {
  blue: 'bg-blue-50 text-manufacturing', purple: 'bg-violet-50 text-outsourced', green: 'bg-green-50 text-available',
  orange: 'bg-amber-50 text-amber-600', red: 'bg-red-50 text-shortage', neutral: 'bg-gray-100 text-gray-600',
}

/**
 * KPI card. `value` null = not available (reason shown), a real zero is shown
 * as 0. `kind` labels whether the figure is for the period or a current state.
 */
export function MetricCard({ label, value, hint, definition, icon: Icon, accent = 'neutral', kind, onDrill, unavailableReason }: {
  label: string
  value: string | null
  hint?: ReactNode
  definition?: string
  icon: LucideIcon
  accent?: MetricAccent
  kind?: 'period' | 'current' | 'as-of'
  onDrill?: () => void
  unavailableReason?: string
}) {
  const body = (
    <>
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-medium text-muted-foreground">{label}</p>
        <span className={cn('flex size-9 shrink-0 items-center justify-center rounded-lg', ACCENT[accent])}><Icon aria-hidden className="size-[18px]" /></span>
      </div>
      <p className="text-2xl font-semibold tracking-tight text-foreground tabular-nums">{value ?? <span className="text-base font-medium text-muted-foreground">Unavailable</span>}</p>
      <div className="-mt-1 space-y-0.5 text-xs text-muted-foreground">
        {value === null && unavailableReason && <p>{unavailableReason}</p>}
        {hint && <p>{hint}</p>}
        <p className="flex items-center gap-1.5">
          {kind && <span className="rounded bg-surface-muted px-1.5 py-px text-[10px] font-medium tracking-wide uppercase">{kind === 'period' ? 'Period' : kind === 'current' ? 'Current' : 'As of date'}</span>}
          {definition && <span title={definition} className="inline-flex cursor-help items-center gap-1"><Info className="size-3" /><span className="sr-only">Definition: </span><span className="line-clamp-1">{definition}</span></span>}
        </p>
      </div>
    </>
  )
  if (onDrill && value !== null) {
    return (
      <Card className="gap-3 p-5 transition-colors hover:border-primary/50">
        <button type="button" onClick={onDrill} className="space-y-3 text-left" aria-label={`${label}: show records`}>{body}</button>
      </Card>
    )
  }
  return <Card className="gap-3 p-5">{body}</Card>
}

export function SectionHeading({ id, title, description, children }: { id: string; title: string; description?: string; children?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
      <div><h2 id={id} className="text-base font-semibold">{title}</h2>{description && <p className="text-sm text-muted-foreground">{description}</p>}</div>
      {children}
    </div>
  )
}

/** Small table used throughout analytics (already-aggregated rows). */
export function MiniTable({ headers, rows, empty = 'No records.', align }: { headers: string[]; rows: ReactNode[][]; empty?: string; align?: ('left' | 'right')[] }) {
  if (!rows.length) return <p className="py-6 text-center text-sm text-muted-foreground">{empty}</p>
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-xs text-muted-foreground"><tr>{headers.map((h, i) => <th key={h} className={cn('pb-2 font-medium', (align?.[i] ?? (i === 0 ? 'left' : 'right')) === 'left' ? 'text-left' : 'text-right')}>{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => (
          <tr key={i} className="border-t">{r.map((c, j) => <td key={j} className={cn('py-1.5', (align?.[j] ?? (j === 0 ? 'left' : 'right')) === 'left' ? 'text-left' : 'text-right tabular-nums')}>{c}</td>)}</tr>
        ))}</tbody>
      </table>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
export function AnalyticsExport({ allowed, title, fileStem, ctx, filters, active, generatedAt, notes, sections }: {
  allowed: boolean
  title: string
  fileStem: string
  ctx: AnalyticsContext | null
  filters: AnalyticsFilters
  active: ActiveFilter[]
  generatedAt: string | null
  notes?: string[]
  /** Built from the same data that is on screen, so exported totals match. */
  sections: () => ExportSection[]
}) {
  const [busy, setBusy] = useState(false)
  if (!allowed) return null
  const run = async (format: 'xlsx' | 'csv') => {
    setBusy(true)
    try {
      const meta = reportMetaRows({ title, company: ctx?.company.legal_name ?? '', generatedAt: generatedAt ? formatDateTime(generatedAt) : '', period: describePeriod(filters),
        asOf: filters.asOf ? formatIso(filters.asOf) : null, filters: active, notes })
      const { downloadSheets } = await import('@/features/products/spreadsheet')
      await downloadSheets(buildExportSheets(meta, sections(), format), `${fileStem}-${filters.from}-${filters.to}`, format)
    } finally { setBusy(false) }
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Button variant="outline" size="sm" disabled={busy || !generatedAt}>{busy ? <Loader2 className="animate-spin" /> : <Download />} Export</Button></DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => void run('xlsx')}>Excel (.xlsx)</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void run('csv')}>CSV</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
