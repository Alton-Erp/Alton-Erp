import { Download, FileSpreadsheet, GitCompareArrows, Layers, Loader2, Network, Plus, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'

import { PermissionGate } from '@/auth/permission-gate'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { FilterTabs } from '@/components/common/filter-tabs'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { formatQty } from '@/features/inventory/inventory-model'
import {
  BOM_COST_TOOLTIPS, bomCostDifference, bomCostExportRows, bomCostMissingNote, bomCostText, bomMasterCost, bomUnitCost, costSortValue, signedCostText,
} from '@/features/production/bom-cost-columns'
import { BOM_IMPORT_FIELDS } from '@/features/production/bom-import'
import { bomExportRows } from '@/features/production/bom-planning-model'
import { BomStatusBadge } from '@/features/production/production-badges'
import { BOM_SOURCE_LABELS, PRODUCT_TYPE_LABELS, type BomSource, type ProductType } from '@/features/products/product-model'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDate, formatDateTime, formatNumber, toIsoDate } from '@/lib/format'
import { fetchBomCosts, recalculateCosts } from '@/services/product-cost'
import { fetchBomItemsFor, fetchBoms } from '@/services/production'
import { fetchSupplierOptions } from '@/services/suppliers'
import type { BomListRow, BomStatus } from '@/types/database-production'
import { useUrlEnum } from '@/hooks/use-url-state'

type Filter = 'ACTIVE' | BomStatus | 'ALL'

const days = (v: number | null | undefined) => (v == null ? '—' : `${formatNumber(Number(v))} d`)

export default function BomsPage() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const productFilter = searchParams.get('product')
  // Kept in the address, so Back from a record returns to the same tab.
  const [filter, setFilter] = useUrlEnum<Filter>('status', ['ACTIVE', 'DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'ARCHIVED', 'ALL'], productFilter ? 'ALL' : 'ACTIVE')
  const [typeFilter, setTypeFilter] = useState('all')
  const [groupFilter, setGroupFilter] = useState('all')
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  const boms = useAsync(() => fetchBoms(filter === 'ALL' ? null : filter), [filter])
  const all = boms.data ?? []
  // Cost columns (migration 20261208090000); an empty map before it: the columns then show dashes.
  const [costRefresh, setCostRefresh] = useState(0)
  const costs = useAsync(() => fetchBomCosts((boms.data ?? []).map((b) => b.id)), [boms.data, costRefresh])
  const costOf = (b: BomListRow) => costs.data?.get(b.id)
  const [recalc, setRecalc] = useState<'confirm' | 'running' | null>(null)
  const [costNotice, setCostNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)
  const runRecalc = async () => {
    setRecalc('running')
    setCostNotice(null)
    try {
      const r = await recalculateCosts(null)
      setCostNotice({ tone: 'success', text: `Costs recalculated for ${r.products} product(s); ${r.changed} Product Master Cost change(s) recorded in the cost history.` })
      setCostRefresh((n) => n + 1)
    } catch (e) {
      setCostNotice({ tone: 'error', text: describeDataError(e) })
    } finally {
      setRecalc(null)
    }
  }
  const rows = all
    .filter((b) => !productFilter || b.finished_product_id === productFilter)
    .filter((b) => typeFilter === 'all' || b.product_type === typeFilter)
    .filter((b) => groupFilter === 'all' || (groupFilter === 'none' ? !b.group_head : b.group_head === groupFilter))
  const filteredProduct = productFilter ? all.find((b) => b.finished_product_id === productFilter) : null
  const [today] = useState(() => toIsoDate(new Date()))
  const types = [...new Set(all.map((b) => b.product_type))].sort()
  const groups = [...new Set(all.map((b) => b.group_head).filter((g): g is string => !!g))].sort((a, b) => a.localeCompare(b))

  const effective = (b: BomListRow) => b.status === 'APPROVED' && b.effective_from <= today && (!b.effective_to || b.effective_to >= today)

  const exportExcel = async () => {
    setExporting(true)
    setExportError(null)
    try {
      const [items, suppliers, { downloadSheets }] = await Promise.all([
        fetchBomItemsFor(rows.map((b) => b.id)),
        fetchSupplierOptions(true).catch(() => []),
        import('@/features/products/spreadsheet'),
      ])
      const supplierCode = new Map(suppliers.map((s) => [s.id, s.supplier_code]))
      const sheet = bomExportRows(BOM_IMPORT_FIELDS.map((f) => f.label), rows, items, {
        typeLabel: (t) => PRODUCT_TYPE_LABELS[t as ProductType] ?? t,
        sourceLabel: (s) => BOM_SOURCE_LABELS[s as BomSource] ?? s,
        supplierCode: (id) => supplierCode.get(id) ?? '',
      })
      // Second sheet: the same cost values as the list (one row per BOM; blank = no approved cost).
      const costSheet = bomCostExportRows(rows, costs.data ?? new Map(), (iso) => formatDateTime(iso))
      await downloadSheets([{ name: 'BOM', rows: sheet }, { name: 'BOM Costs', rows: costSheet }], `boms-${toIsoDate(new Date())}`, 'xlsx')
    } catch (e) {
      setExportError(describeDataError(e))
    } finally {
      setExporting(false)
    }
  }

  const columns: DataTableColumn<BomListRow>[] = [
    { id: 'code', header: 'BOM', cell: (b) => <span className="font-medium">{b.bom_code} <span className="text-muted-foreground">v{b.version}</span></span>, searchValue: (b) => b.bom_code, sortValue: (b) => `${b.bom_code}-${String(b.version).padStart(4, '0')}` },
    { id: 'product', header: 'Finished product', cell: (b) => <span>{b.sku} — {b.product_name}</span>, searchValue: (b) => `${b.sku} ${b.product_name} ${b.group_head ?? ''}`, sortValue: (b) => b.sku },
    { id: 'type', header: 'Product type', cell: (b) => PRODUCT_TYPE_LABELS[b.product_type as ProductType] ?? b.product_type, sortValue: (b) => b.product_type },
    { id: 'bomcost', header: 'BOM Cost / Unit', align: 'right', headerTitle: BOM_COST_TOOLTIPS.unit,
      cell: (b) => {
        const v = bomUnitCost(costOf(b))
        return v === null
          ? <span className="text-muted-foreground" title={bomCostMissingNote(costOf(b))} data-testid={`bom-cost-${b.id}`}>—</span>
          : <span className="tabular-nums" data-testid={`bom-cost-${b.id}`}>{bomCostText(v)}</span>
      },
      sortValue: (b) => costSortValue(bomUnitCost(costOf(b))) },
    { id: 'mastercost', header: 'Product Master Cost', align: 'right', headerTitle: BOM_COST_TOOLTIPS.master,
      cell: (b) => <span className="tabular-nums">{bomCostText(bomMasterCost(costOf(b)))}</span>,
      sortValue: (b) => costSortValue(bomMasterCost(costOf(b))) },
    { id: 'costdiff', header: 'Cost Difference', align: 'right', headerTitle: BOM_COST_TOOLTIPS.difference,
      cell: (b) => {
        const d = bomCostDifference(costOf(b))
        return <span className={d === null ? 'text-muted-foreground' : d > 0 ? 'tabular-nums text-red-700' : d < 0 ? 'tabular-nums text-green-700' : 'tabular-nums'}>{signedCostText(d)}</span>
      },
      sortValue: (b) => costSortValue(bomCostDifference(costOf(b))) },
    { id: 'costupdated', header: 'Cost Updated', headerTitle: BOM_COST_TOOLTIPS.updated,
      cell: (b) => {
        const c = costOf(b)
        return bomUnitCost(c) !== null && c?.cost_calculated_at ? <span className="text-xs">{formatDateTime(c.cost_calculated_at)}</span> : <span className="text-muted-foreground">—</span>
      },
      sortValue: (b) => (bomUnitCost(costOf(b)) !== null ? costOf(b)?.cost_calculated_at ?? '' : '') },
    { id: 'group', header: 'Group head', cell: (b) => b.group_head ?? <span className="text-muted-foreground">—</span>, sortValue: (b) => b.group_head ?? '' },
    { id: 'tax', header: 'Tax %', align: 'right', cell: (b) => (b.tax_rate == null ? '—' : `${Number(b.tax_rate)}%`), sortValue: (b) => (b.tax_rate == null ? -1 : Number(b.tax_rate)) },
    { id: 'lead', header: 'Lead time', align: 'right', cell: (b) => days(b.lead_time_days), sortValue: (b) => (b.lead_time_days == null ? -1 : Number(b.lead_time_days)) },
    { id: 'minstock', header: 'Min. stock days', align: 'right', cell: (b) => days(b.minimum_cover_days), sortValue: (b) => (b.minimum_cover_days == null ? -1 : Number(b.minimum_cover_days)) },
    { id: 'output', header: 'Output', align: 'right', cell: (b) => formatQty(b.output_quantity, b.output_unit) },
    { id: 'items', header: 'Components', align: 'right', cell: (b) => b.item_count },
    { id: 'effective', header: 'Effective', cell: (b) => (
      <span className="text-xs">{formatDate(b.effective_from)} → {b.effective_to ? formatDate(b.effective_to) : 'open'}{effective(b) && <span className="ml-1 font-medium text-green-700">(current)</span>}</span>
    ), sortValue: (b) => b.effective_from },
    { id: 'status', header: 'Status', cell: (b) => <BomStatusBadge status={b.status} />, sortValue: (b) => b.status },
  ]

  return (
    <>
      <PageHeader
        actions={
          <>
            <Button variant="outline" disabled={exporting || rows.length === 0} onClick={() => void exportExcel()}>
              {exporting ? <Loader2 className="animate-spin" /> : <Download />} Export to Excel
            </Button>
            <Button variant="outline" asChild><Link to="/production/boms/compare"><GitCompareArrows /> Compare BOMs</Link></Button>
            <PermissionGate permission="products.update">
              <Button type="button" variant="outline" disabled={recalc !== null} onClick={() => setRecalc('confirm')}>
                {recalc === 'running' ? <Loader2 className="animate-spin" /> : <RefreshCw />} Recalculate costs
              </Button>
            </PermissionGate>
            <PermissionGate permission="production_bom.create">
              <Button variant="outline" asChild><Link to="/production/boms/import"><FileSpreadsheet /> Import from Excel</Link></Button>
              <Button variant="outline" asChild><Link to="/production/boms/generate"><Layers /> Generate multiple</Link></Button>
              <Button asChild><Link to="/production/boms/new"><Plus /> Create New BOM</Link></Button>
            </PermissionGate>
          </>
        }
      />
      {costNotice && (
        <p role={costNotice.tone === 'error' ? 'alert' : 'status'} data-testid="bom-cost-notice"
          className={costNotice.tone === 'error' ? 'mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800' : 'mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-800'}>
          {costNotice.text}
        </p>
      )}
      {costs.error && <p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800">Costs could not be loaded: {describeDataError(costs.error)}</p>}
      <ConfirmDialog
        open={recalc === 'confirm'}
        onOpenChange={(o) => { if (!o && recalc === 'confirm') setRecalc(null) }}
        title="Recalculate BOM and Product Master costs?"
        description="Every approved BOM is costed again from the current component costs, and each product's Product Master Cost follows its sourcing method (Manufacture: approved BOM; Purchase-IN: latest valid GRN; Outsourced-IMP: its default source). Products without a valid new cost keep their cost. Changes are recorded in the cost history; stock lots and posted transactions are not changed."
        confirmLabel="Recalculate"
        onConfirm={() => void runRecalc()}
      />
      {exportError && <p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800">Export failed: {exportError}</p>}
      {productFilter && (
        <p className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border bg-surface-muted/50 px-4 py-2.5 text-sm">
          Showing BOM versions of {filteredProduct ? `${filteredProduct.sku} — ${filteredProduct.product_name}` : 'one product'}.
          <button type="button" className="font-medium text-primary hover:underline" onClick={() => setSearchParams({})}>Show all BOMs</button>
        </p>
      )}
      <DataTable
        title="Bills of materials"
        description="One BOM code per product; every change is a new version. Only the active, currently effective version is used for new orders. Planning fields come from the finished product. Costs in INR; hover a cost heading for how it is calculated."
        columns={columns}
        data={rows}
        getRowId={(b) => b.id}
        loading={boms.loading}
        error={boms.error ? new Error(describeDataError(boms.error)) : null}
        onRetry={boms.reload}
        onRowClick={(b) => navigate(`/production/boms/${b.id}`)}
        searchPlaceholder="Search BOM code, SKU, product or group head…"
        pageSize={20}
        toolbar={
          <>
            <FilterTabs<Filter>
              label="BOM status"
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'ACTIVE', label: 'Not archived' },
                { value: 'PENDING_APPROVAL', label: 'Pending approval' },
                { value: 'APPROVED', label: 'Approved' },
                { value: 'DRAFT', label: 'Draft' },
                { value: 'ARCHIVED', label: 'Archived' },
                { value: 'ALL', label: 'All' },
              ]}
            />
            <Select value={typeFilter} onValueChange={setTypeFilter}>
              <SelectTrigger className="w-44" aria-label="Product type filter"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All product types</SelectItem>
                {types.map((t) => <SelectItem key={t} value={t}>{PRODUCT_TYPE_LABELS[t as ProductType] ?? t}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={groupFilter} onValueChange={setGroupFilter}>
              <SelectTrigger className="w-44" aria-label="Group head filter"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All group heads</SelectItem>
                <SelectItem value="none">No group head</SelectItem>
                {groups.map((g) => <SelectItem key={g} value={g}>{g}</SelectItem>)}
              </SelectContent>
            </Select>
          </>
        }
        emptyState={{
          icon: Network,
          title: 'No bills of materials yet',
          description: 'Define the raw materials, components and packaging needed for one unit of each manufactured product. Creating a BOM never moves stock.',
        }}
      />
    </>
  )
}
