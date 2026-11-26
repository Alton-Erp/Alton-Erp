import { Check, ChevronsUpDown, Download, Landmark, Loader2, Search } from 'lucide-react'
import { useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'

import { PermissionGate } from '@/auth/permission-gate'
import { usePermissions } from '@/auth/use-permissions'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  EVENT_STATUS_META, VOUCHER_STATUS_META, type Account, type AccountingStatus, type EventStatus, type Party, type VoucherStatus,
} from '@/features/accounting/accounting-model'
import type { AccountingStatusState } from '@/features/accounting/use-accounting-status'
import type { CellValue } from '@/features/products/spreadsheet'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { cn } from '@/lib/utils'
import { fetchAccountingParties, fetchAccounts } from '@/services/accounting'

/** Shown on every Accounts page: these are accounting results, not the operational billing analytics. */
export function AccountingNotice({ children }: { children?: ReactNode }) {
  return (
    <p className="mb-4 flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2.5 text-sm text-blue-900" data-testid="accounting-notice">
      <Landmark className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>Accounting figures from <strong>posted vouchers</strong> only (drafts and discarded vouchers never count). They are separate from the operational
        billing and receivables analytics.{children ? <> {children}</> : null}</span>
    </p>
  )
}

export const VoucherStatusBadge = ({ status }: { status: VoucherStatus }) => <StatusBadge label={VOUCHER_STATUS_META[status].label} tone={VOUCHER_STATUS_META[status].tone} />
export const EventStatusBadge = ({ status }: { status: EventStatus }) => <StatusBadge label={EVENT_STATUS_META[status].label} tone={EVENT_STATUS_META[status].tone} />

/** Renders the page (which brings its own header) once accounting is set up; otherwise the header and a set-up prompt. */
export function SetupGate({ status, children }: { status: AccountingStatusState; children: (s: AccountingStatus) => ReactNode }) {
  const { has } = usePermissions()
  if (status.loading) return <><PageHeader /><LoadingState label="Loading accounting…" /></>
  if (status.error) return <><PageHeader /><ErrorState title="Accounting could not be loaded" message={describeDataError(status.error)} onRetry={status.reload} /></>
  const s = status.data!
  if (!s.initialized) {
    return (
      <>
        <PageHeader />
        <EmptyState icon={Landmark} title="Accounting is not set up yet"
          description="Set the books start date and financial year first. That creates the chart of accounts, voucher types, posting rules and accounting periods."
          action={has('accounting_settings.manage') ? <Button asChild><Link to="/accounts/settings">Open Accounting Settings</Link></Button> : undefined} />
      </>
    )
  }
  return <>{children(s)}</>
}

export interface SearchOption { value: string; label: string; hint?: string; disabled?: boolean }

/** Searchable single-select (type to filter, ↑/↓, Enter, Esc). */
export function SearchSelect({ id, value, options, onChange, placeholder = 'Select…', loading = false, allowClear = false, className }: {
  id?: string
  value: string
  options: SearchOption[]
  onChange: (value: string) => void
  placeholder?: string
  loading?: boolean
  allowClear?: boolean
  className?: string
}) {
  const listId = useId()
  const [open, setOpen] = useState(false)
  const [term, setTerm] = useState('')
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLUListElement>(null)
  const selected = options.find((o) => o.value === value) ?? null
  const filtered = useMemo(() => {
    const t = term.trim().toLowerCase()
    const list = options.filter((o) => !t || o.label.toLowerCase().includes(t) || (o.hint ?? '').toLowerCase().includes(t)).slice(0, 200)
    return allowClear && !t ? [{ value: '', label: 'None' }, ...list] : list
  }, [options, term, allowClear])
  const choose = (o: SearchOption) => { if (o.disabled) return; onChange(o.value); setOpen(false); setTerm('') }
  const move = (delta: number) => {
    const next = Math.max(0, Math.min(filtered.length - 1, active + delta))
    setActive(next)
    listRef.current?.querySelectorAll('[role="option"]')[next]?.scrollIntoView({ block: 'nearest' })
  }
  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); setTerm(''); setActive(0) }}>
      <PopoverTrigger asChild>
        <button id={id} type="button" role="combobox" aria-expanded={open} aria-controls={listId}
          className={cn('flex h-9 w-full min-w-0 items-center justify-between gap-2 rounded-md border border-input bg-background px-3 text-left text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50', className)}>
          <span className={cn('truncate', !selected && 'text-muted-foreground')}>{loading ? 'Loading…' : selected ? selected.label : placeholder}</span>
          <ChevronsUpDown className="size-4 shrink-0 opacity-50" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(28rem,90vw)] p-0" align="start">
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="size-4 opacity-50" aria-hidden />
          <input autoFocus value={term} placeholder="Search…" aria-label="Search" className="h-9 w-full bg-transparent text-sm outline-none"
            onChange={(e) => { setTerm(e.target.value); setActive(0) }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); move(1) } else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1) } else if (e.key === 'Enter') {
                e.preventDefault(); if (filtered[active]) choose(filtered[active])
              }
            }} />
        </div>
        <ul id={listId} ref={listRef} role="listbox" className="max-h-72 overflow-y-auto py-1">
          {filtered.length === 0 && <li className="px-3 py-2 text-sm text-muted-foreground">No matches.</li>}
          {filtered.map((o, i) => (
            <li key={o.value || 'none'} role="option" aria-selected={o.value === value} aria-disabled={o.disabled}
              className={cn('flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm', i === active && 'bg-accent', o.disabled && 'cursor-not-allowed opacity-50')}
              onMouseEnter={() => setActive(i)} onMouseDown={(e) => { e.preventDefault(); choose(o) }}>
              <Check className={cn('size-4 shrink-0', o.value === value ? 'opacity-100' : 'opacity-0')} aria-hidden />
              <span className="min-w-0 flex-1 truncate">{o.label}</span>
              {o.hint && <span className="shrink-0 text-xs text-muted-foreground">{o.hint}</span>}
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}

/** Ledger account picker. `postableOnly` hides inactive / non-postable accounts; `manualOnly` hides control accounts. */
export function AccountSelect({ id, value, onChange, postableOnly = true, manualOnly = false, allowClear = false, placeholder = 'Select a ledger account', className, accounts }: {
  id?: string; value: string; onChange: (accountId: string, account: Account | null) => void; postableOnly?: boolean; manualOnly?: boolean
  allowClear?: boolean; placeholder?: string; className?: string; accounts?: Account[]
}) {
  const loaded = useAsync(() => (accounts ? Promise.resolve(accounts) : fetchAccounts(null, !postableOnly)), [accounts, postableOnly])
  const list = (loaded.data ?? []).filter((a) => (!postableOnly || (a.is_active && a.is_postable)) && (!manualOnly || a.allow_manual_posting))
  return (
    <SearchSelect id={id} value={value} loading={loaded.loading} allowClear={allowClear} placeholder={placeholder} className={className}
      options={list.map((a) => ({ value: a.id, label: `${a.account_code} — ${a.account_name}`, hint: a.group_name }))}
      onChange={(v) => onChange(v, list.find((a) => a.id === v) ?? null)} />
  )
}

export function PartySelect({ id, value, onChange, type = null, className }: {
  id?: string; value: string; onChange: (partyId: string, party: Party | null) => void; type?: 'CUSTOMER' | 'SUPPLIER' | null; className?: string
}) {
  const parties = useAsync(() => fetchAccountingParties(null, type), [type])
  const list = parties.data ?? []
  return (
    <SearchSelect id={id} value={value} loading={parties.loading} placeholder={type === 'SUPPLIER' ? 'Select a supplier' : type === 'CUSTOMER' ? 'Select a customer' : 'Select a customer / supplier'}
      className={className} options={list.map((p) => ({ value: p.id, label: `${p.party_name}`, hint: p.party_code }))}
      onChange={(v) => onChange(v, list.find((p) => p.id === v) ?? null)} />
  )
}

export interface ExportColumn<T> { header: string; value: (row: T) => CellValue }

/** Excel / CSV export of an accounting report already loaded from the database (accounting_reports.read). */
export function AccountingExport<T>({ title, fileStem, columns, rows, extraRows }: {
  title: string; fileStem: string; columns: ExportColumn<T>[]; rows: T[]; extraRows?: CellValue[][]
}) {
  const [busy, setBusy] = useState(false)
  const run = async (format: 'xlsx' | 'csv') => {
    setBusy(true)
    try {
      const { downloadSheets } = await import('@/features/products/spreadsheet')
      await downloadSheets([{ name: title.slice(0, 31), rows: [columns.map((c) => c.header), ...rows.map((r) => columns.map((c) => c.value(r))), ...(extraRows ?? [])] }], fileStem, format)
    } finally { setBusy(false) }
  }
  return (
    <PermissionGate permission="accounting_reports.read">
      <DropdownMenu>
        <DropdownMenuTrigger asChild><Button variant="outline" disabled={busy || !rows.length}>{busy ? <Loader2 className="animate-spin" /> : <Download />} Export</Button></DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => void run('xlsx')}>Excel (.xlsx)</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void run('csv')}>CSV</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </PermissionGate>
  )
}

/** Small "label: value" block for detail headers. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div><dt className="text-xs text-muted-foreground">{label}</dt><dd className="text-sm">{children}</dd></div>
}
