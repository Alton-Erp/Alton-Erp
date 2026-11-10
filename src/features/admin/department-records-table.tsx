import { CheckCircle2, ShieldAlert } from 'lucide-react'

import { Checkbox } from '@/components/ui/checkbox'
import {
  deletedWith, departmentLabel, recordType, statusLabel, type BlockedRecord, type PreviewRecord,
} from '@/features/admin/department-data-model'

/**
 * Every record of a preview, one row each: eligible records can be ticked (all are by default),
 * blocked records show every reason and the related documents and cannot be selected.
 */
export function DepartmentRecordsTable({ records, blocked, selected, onToggle, onToggleAll, disabled, truncated }: {
  records: PreviewRecord[]
  blocked: BlockedRecord[]
  selected: (key: string) => boolean
  onToggle: (key: string, on: boolean) => void
  onToggleAll: (on: boolean) => void
  disabled?: boolean
  /** More records exist than the list shows. */
  truncated?: boolean
}) {
  const ticked = records.filter((r) => selected(r.key)).length
  const all = records.length > 0 && ticked === records.length
  return (
    <div className="space-y-1" data-testid="dept-records">
      <p className="text-sm font-medium">
        Records <span className="font-normal text-muted-foreground">— {records.length} eligible · {blocked.length} blocked{records.length ? ` · ${ticked} selected` : ''}</span>
      </p>
      <div className="max-h-96 overflow-auto rounded-lg border">
        <table className="w-full min-w-[760px] text-sm" aria-label="Records">
          <thead className="sticky top-0 bg-muted/80 text-xs text-muted-foreground backdrop-blur">
            <tr>
              <th className="w-9 px-2 py-1.5 text-left">
                {records.length > 0 && (
                  <Checkbox aria-label="Select all eligible records" checked={all ? true : ticked > 0 ? 'indeterminate' : false}
                    onCheckedChange={(v) => onToggleAll(v === true)} disabled={disabled} />
                )}
              </th>
              <th className="px-2 py-1.5 text-left">Document</th>
              <th className="px-2 py-1.5 text-left">Type</th>
              <th className="px-2 py-1.5 text-left">Status</th>
              <th className="px-2 py-1.5 text-left">Result</th>
              <th className="px-2 py-1.5 text-left">Reason</th>
              <th className="px-2 py-1.5 text-left">Related</th>
            </tr>
          </thead>
          <tbody>
            {records.map((r) => (
              <tr key={`e:${r.table}:${r.key}`} className="border-t align-top" data-testid="dept-record" data-key={r.key} data-state="eligible">
                <td className="px-2 py-1.5">
                  <Checkbox aria-label={`Select ${r.record}`} checked={selected(r.key)} onCheckedChange={(v) => onToggle(r.key, v === true)} disabled={disabled} />
                </td>
                <td className="px-2 py-1.5 font-medium whitespace-nowrap">{r.record}</td>
                <td className="px-2 py-1.5 whitespace-nowrap">{recordType(r)}</td>
                <td className="px-2 py-1.5 whitespace-nowrap">{statusLabel(r.status, r.revision)}</td>
                <td className="px-2 py-1.5 whitespace-nowrap text-green-800"><CheckCircle2 className="mr-1 inline size-3.5" aria-hidden />Eligible</td>
                <td className="min-w-56 px-2 py-1.5 text-xs text-muted-foreground">Deleted with it: {deletedWith(r)}</td>
                <td className="px-2 py-1.5 text-muted-foreground">—</td>
              </tr>
            ))}
            {blocked.map((b) => (
              <tr key={`b:${b.table}:${b.key}`} className="border-t bg-amber-50/60 align-top dark:bg-amber-950/20" data-testid="dept-record" data-key={b.key} data-state="blocked">
                <td className="px-2 py-1.5" />
                <td className="px-2 py-1.5 font-medium whitespace-nowrap">{b.record}</td>
                <td className="px-2 py-1.5 whitespace-nowrap">{recordType(b)}</td>
                <td className="px-2 py-1.5 whitespace-nowrap">{statusLabel(b.status, b.revision)}</td>
                <td className="px-2 py-1.5 whitespace-nowrap text-amber-800 dark:text-amber-300"><ShieldAlert className="mr-1 inline size-3.5" aria-hidden />Blocked</td>
                <td className="min-w-56 px-2 py-1.5 text-xs">
                  <ul className="space-y-0.5">{b.reasons.map((x) => <li key={x}>{x}</li>)}</ul>
                </td>
                <td className="px-2 py-1.5 text-xs">
                  {b.references && b.references.length > 0
                    ? <ul className="space-y-0.5">{b.references.map((x) => <li key={`${x.table}:${x.record}`} className="whitespace-nowrap">{x.record} <span className="text-muted-foreground">({departmentLabel(x.department)})</span></li>)}</ul>
                    : '—'}
                </td>
              </tr>
            ))}
            {records.length === 0 && blocked.length === 0 && (
              <tr><td colSpan={7} className="px-2 py-3 text-center text-muted-foreground">No records.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {truncated && <p className="text-xs text-muted-foreground">Only the first records are listed. Leave all of them selected to include the rest.</p>}
    </div>
  )
}
