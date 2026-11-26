import { Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'

import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  COST_CENTRE_POLICY_LABELS, allocationError, buildCostCentreTree, flattenCostCentreTree, formatAmount, newAllocation, toPaise,
  type AllocationForm, type CostCentre, type CostCentrePolicy, type JournalLineForm,
} from '@/features/accounting/accounting-model'
import { SearchSelect } from '@/features/accounting/accounting-ui'
import { useAsync } from '@/hooks/use-async'
import { fetchCostCentres } from '@/services/accounting'

/** Cost centre picker (hierarchy shown by indentation). `activeOnly` hides inactive centres. */
export function CostCentreSelect({ id, value, onChange, centres, activeOnly = true, allowClear = false, placeholder = 'Select a cost centre', className }: {
  id?: string; value: string; onChange: (id: string) => void; centres?: CostCentre[]; activeOnly?: boolean; allowClear?: boolean; placeholder?: string; className?: string
}) {
  const loaded = useAsync(() => (centres ? Promise.resolve(centres) : fetchCostCentres()), [centres])
  const list = flattenCostCentreTree(buildCostCentreTree(loaded.data ?? [])).filter((n) => !activeOnly || n.centre.is_active)
  return (
    <SearchSelect id={id} value={value} loading={loaded.loading} allowClear={allowClear} placeholder={placeholder} className={className}
      options={list.map((n) => ({ value: n.centre.id, label: `${'  '.repeat(n.depth)}${n.centre.cost_centre_code} — ${n.centre.cost_centre_name}`,
        hint: n.centre.is_active ? undefined : 'inactive' }))}
      onChange={onChange} />
  )
}

export function PolicyBadge({ policy }: { policy?: CostCentrePolicy }) {
  if (!policy) return null
  return <StatusBadge label={`Cost centre: ${COST_CENTRE_POLICY_LABELS[policy].toLowerCase()}`} tone={policy === 'REQUIRED' ? 'warning' : 'neutral'} />
}

/** Edits the cost-centre split of one journal line. The split must equal the line amount exactly (checked again by the database). */
export function AllocationDialog({ line, lineNo, policy, centres, onClose, onSave }: {
  line: JournalLineForm; lineNo: number; policy?: CostCentrePolicy; centres: CostCentre[]; onClose: () => void; onSave: (allocations: AllocationForm[]) => void
}) {
  const [rows, setRows] = useState<AllocationForm[]>(line.allocations.length ? line.allocations : [newAllocation()])
  const amount = line.debit.trim() || line.credit.trim() || '0'
  const used = rows.filter((r) => r.cost_centre_id || r.amount.trim())
  const total = used.reduce((t, r) => t + toPaise(r.amount), 0)
  const remaining = toPaise(amount) - total
  const error = used.length ? allocationError({ ...line, allocations: rows }) : null
  const set = (key: string, patch: Partial<AllocationForm>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)))
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Cost centres — line {lineNo}</DialogTitle>
          <DialogDescription>Split the {line.debit.trim() ? 'debit' : 'credit'} of {formatAmount(amount)} over one or more cost centres. The split must equal the line
            amount exactly.{policy ? ` This account's rule: ${COST_CENTRE_POLICY_LABELS[policy].toLowerCase()}.` : ''}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2" data-testid="allocation-rows">
          {rows.map((r, i) => (
            <div key={r.key} className="flex items-center gap-2">
              <CostCentreSelect id={`alloc-cc-${i}`} value={r.cost_centre_id} centres={centres} onChange={(v) => set(r.key, { cost_centre_id: v })} className="flex-1" />
              <Input className="w-36 text-right tabular-nums" inputMode="decimal" aria-label={`Allocation ${i + 1} amount`} value={r.amount} onChange={(e) => set(r.key, { amount: e.target.value })} />
              <Button variant="ghost" size="icon" aria-label={`Remove allocation ${i + 1}`} onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}><Trash2 /></Button>
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setRows((rs) => [...rs, newAllocation()])}><Plus /> Add cost centre</Button>
            {remaining > 0 && rows.length > 0 && <Button variant="outline" size="sm" onClick={() => {
              const last = rows[rows.length - 1]
              set(last.key, { amount: ((toPaise(last.amount) + remaining) / 100).toFixed(2) })
            }}>Put the remaining {formatAmount(remaining / 100)} on the last row</Button>}
          </div>
          <p className={`text-sm ${remaining === 0 ? 'text-green-700' : 'text-amber-700'}`} data-testid="allocation-remaining">
            Allocated {formatAmount(total / 100)} of {formatAmount(amount)} · remaining {formatAmount(remaining / 100)}</p>
          {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onSave([])}>Remove all</Button>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => onSave(used)} disabled={Boolean(error) && used.length > 0}>Apply split</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
