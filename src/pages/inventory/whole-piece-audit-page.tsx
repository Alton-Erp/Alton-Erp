import { Download, RefreshCw, Ruler } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { ErrorState } from '@/components/common/error-state'
import { FilterTabs } from '@/components/common/filter-tabs'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { formatQty } from '@/features/inventory/inventory-model'
import { downloadSheets } from '@/features/products/spreadsheet'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDateTime, toIsoDate } from '@/lib/format'
import { cn } from '@/lib/utils'
import { fetchWholeUnitAudit, type WholeUnitClassification, type WholeUnitFinding } from '@/services/inventory'

type View = 'ACTION' | 'BOM' | 'HISTORY' | 'ALL'

const CLASS_LABELS: Record<WholeUnitClassification, string> = {
  INVALID_PHYSICAL: 'Fractional physical quantity',
  INVALID_PLAN: 'Fractional plan / order quantity',
  NEEDS_CORRECTION: 'BOM needs correction',
  THEORETICAL_RATIO: 'Valid BOM ratio (planning rounds up)',
  REVERSED_HISTORY: 'History (reversed)',
  ADJUSTMENT_HISTORY: 'History (adjustment / count)',
}

const CATEGORY_LABELS: Record<string, string> = {
  STOCK_BALANCE: 'Stock balance',
  RESERVATION: 'Open reservation',
  LEDGER_ENTRY: 'Ledger entry',
  BOM_LINE: 'BOM component',
  BOM_OUTPUT: 'BOM output',
  PRODUCTION_ORDER: 'Production order',
  PRODUCTION_MATERIAL: 'Production material plan',
  PRODUCTION_ISSUE: 'Material issue',
  PRODUCTION_OUTPUT: 'Production output',
  OUTSOURCING_ORDER: 'Outsourcing order',
  OUTSOURCING_MATERIAL: 'Outsourcing material',
  OUTSOURCING_RECEIPT: 'Outsourcing receipt',
  OUTSOURCING_MOVEMENT: 'Outsourcing dispatch / return',
  PURCHASE_ORDER_LINE: 'Purchase order line',
  GOODS_RECEIPT_LINE: 'Goods receipt line',
}

/** Records someone has to act on (the rest is history or a valid ratio). */
const needsAction = (f: WholeUnitFinding) =>
  f.category === 'STOCK_BALANCE' || f.category === 'RESERVATION' || f.classification === 'INVALID_PLAN' || f.classification === 'NEEDS_CORRECTION'

const inView = (f: WholeUnitFinding, view: View) =>
  view === 'ALL' ? true
    : view === 'ACTION' ? needsAction(f)
      : view === 'BOM' ? f.category.startsWith('BOM_')
        : !needsAction(f) && !f.category.startsWith('BOM_')

/**
 * Read-only list of fractional quantities of items counted in whole pieces.
 * Nothing here changes data: fractional stock is corrected through an approved
 * stock adjustment (physical count), which keeps the full audit trail.
 */
export default function WholePieceAuditPage() {
  const [refresh, setRefresh] = useState(0)
  const audit = useAsync(fetchWholeUnitAudit, [refresh])
  const [view, setView] = useState<View>('ACTION')
  const findings = useMemo(() => audit.data?.findings ?? [], [audit.data])
  const rows = useMemo(() => findings.filter((f) => inView(f, view)), [findings, view])
  const count = (v: View) => findings.filter((f) => inView(f, v)).length
  const balances = findings.filter((f) => f.category === 'STOCK_BALANCE').length

  const columns: DataTableColumn<WholeUnitFinding>[] = [
    { id: 'category', header: 'Record', cell: (f) => <span><span className="font-medium">{CATEGORY_LABELS[f.category] ?? f.category}</span><span className="block text-xs text-muted-foreground">{f.reference}</span></span>, searchValue: (f) => `${f.category} ${f.reference}`, sortValue: (f) => f.category },
    { id: 'sku', header: 'Item', cell: (f) => f.sku, searchValue: (f) => f.sku, sortValue: (f) => f.sku },
    { id: 'value', header: 'Quantity', align: 'right', cell: (f) => <span className="tabular-nums">{formatQty(f.value, f.unit)}<span className="block text-xs text-muted-foreground">{f.field.replace(/_/g, ' ')}</span></span>, sortValue: (f) => Number(f.value) },
    {
      id: 'class',
      header: 'Classification',
      cell: (f) => (
        <span className={cn('text-xs font-medium', needsAction(f) ? 'text-shortage' : 'text-muted-foreground')}>{CLASS_LABELS[f.classification] ?? f.classification}</span>
      ),
      sortValue: (f) => f.classification,
    },
    { id: 'detail', header: 'Details', cell: (f) => <span className="text-xs">{f.detail}</span>, searchValue: (f) => f.detail },
    { id: 'open', header: '', cell: (f) => <Link className="text-xs underline" to={f.link}>Open</Link> },
  ]

  const exportCsv = () =>
    downloadSheets(
      [{
        name: 'Whole-piece audit',
        rows: [
          ['Category', 'Classification', 'Reference', 'SKU', 'Unit', 'Field', 'Quantity', 'Details'],
          ...findings.map((f) => [f.category, f.classification, f.reference, f.sku, f.unit, f.field, Number(f.value), f.detail]),
        ],
      }],
      `whole-piece-audit-${toIsoDate(new Date())}`,
      'csv',
    )

  return (
    <>
      <PageHeader
        title="Whole-piece quantity audit"
        description="Items counted in pieces (PCS, NOS, SET, PAIR) can only be stocked, planned and moved in whole numbers. This report lists records from before that rule. It is read only and changes nothing."
        breadcrumbs={[{ label: 'Inventory', to: '/inventory' }, { label: 'Whole-piece audit' }]}
        actions={
          <>
            <Button variant="outline" onClick={() => setRefresh((n) => n + 1)} disabled={audit.loading}><RefreshCw /> Run again</Button>
            <Button variant="outline" onClick={() => void exportCsv()} disabled={!findings.length}><Download /> Download CSV</Button>
          </>
        }
      />

      {audit.loading && !audit.data ? (
        <LoadingState variant="cards" rows={2} />
      ) : audit.error ? (
        <Card><ErrorState message={describeDataError(audit.error)} onRetry={audit.reload} /></Card>
      ) : (
        <>
          <Card className="mb-6">
            <CardHeader>
              <div>
                <CardTitle>{audit.data?.total ? `${count('ACTION')} record${count('ACTION') === 1 ? '' : 's'} to act on` : 'No fractional quantities found'}</CardTitle>
                <CardDescription>
                  Checked {audit.data ? formatDateTime(audit.data.generated_at) : ''}. Stock balances are shown exactly as recorded; they are never rounded or hidden.
                </CardDescription>
              </div>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <p><span className="font-medium">Fractional stock balance:</span> count the item and correct the balance with a stock adjustment (reason "Count variance") to the whole number counted. A second authorised user approves it; the before and after quantities and the posting stay in the audit trail.</p>
              <p><span className="font-medium">Order planned with a fraction:</span> cancel the order and create it again. The new plan is calculated in whole pieces.</p>
              <p><span className="font-medium">BOM that needs correction:</span> create a new version with whole pieces per batch (for 1 part per 2 units, use component 1 and output 2).</p>
              <p className="text-muted-foreground">Ledger entries are listed as the source of each fraction. They are history and are never edited. An exact reversal of a wrong posting is also allowed.</p>
              {balances > 0 && <p className="font-medium text-shortage">{balances} stock balance{balances === 1 ? '' : 's'} with a fraction.</p>}
              {audit.data?.truncated && <p className="text-shortage">Only the first 2000 records are shown.</p>}
            </CardContent>
          </Card>

          <DataTable
            title="Findings"
            columns={columns}
            data={rows}
            getRowId={(f) => `${f.category}|${f.record_id}|${f.reference}|${f.field}`}
            searchable
            searchPlaceholder="Search SKU, document or detail…"
            toolbar={
              <FilterTabs<View>
                label="Show"
                value={view}
                onChange={setView}
                options={[
                  { value: 'ACTION', label: 'Needs action', count: count('ACTION') },
                  { value: 'BOM', label: 'BOMs', count: count('BOM') },
                  { value: 'HISTORY', label: 'History', count: count('HISTORY') },
                  { value: 'ALL', label: 'All', count: findings.length },
                ]}
              />
            }
            emptyState={{ icon: Ruler, title: 'Nothing here', description: 'No records in this view.' }}
          />
        </>
      )}
    </>
  )
}
