import { Copy, LayoutTemplate, Plus } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { Link } from 'react-router-dom'

import { PermissionGate } from '@/auth/permission-gate'
import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { FilterTabs } from '@/components/common/filter-tabs'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { formatQty } from '@/features/inventory/inventory-model'
import { useAsync } from '@/hooks/use-async'
import { useUrlEnum } from '@/hooks/use-url-state'
import { describeDataError } from '@/lib/errors'
import { formatDate } from '@/lib/format'
import { fetchTemplates, isMissingRelation, type BomTemplateSummary } from '@/services/bom-tools'
import { listCategories } from '@/services/products'

type Filter = 'ACTIVE' | 'ARCHIVED' | 'ALL'

/** /production/bom-templates — reusable component lists for creating new finished products. */
export default function BomTemplatesPage() {
  const navigate = useNavigate()
  const [filter, setFilter] = useUrlEnum<Filter>('status', ['ACTIVE', 'ARCHIVED', 'ALL'], 'ACTIVE')
  const templates = useAsync(() => fetchTemplates(), [])
  const categories = useAsync(() => listCategories().catch(() => []), [])
  const categoryName = (id: string | null) => (id ? (categories.data ?? []).find((c) => c.id === id)?.name ?? '—' : '—')
  const all = templates.data ?? []
  const rows = all.filter((t) => filter === 'ALL' || t.status === filter)
  const missing = templates.error && isMissingRelation(templates.error)

  const columns: DataTableColumn<BomTemplateSummary>[] = [
    { id: 'name', header: 'Template', cell: (t) => <span className="font-medium">{t.template_name}</span>, searchValue: (t) => `${t.template_name} ${t.description ?? ''}`, sortValue: (t) => t.template_name },
    { id: 'category', header: 'Product category', cell: (t) => categoryName(t.category_id), sortValue: (t) => categoryName(t.category_id) },
    { id: 'items', header: 'Components', align: 'right', cell: (t) => t.component_count, sortValue: (t) => t.component_count },
    { id: 'output', header: 'Per output', align: 'right', cell: (t) => formatQty(t.output_quantity, t.output_unit) },
    { id: 'source', header: 'Taken from', cell: (t) => (t.source_bom_code ? `${t.source_bom_code} v${t.source_bom_version}` : '—'), searchValue: (t) => t.source_bom_code ?? '' },
    { id: 'updated', header: 'Updated', cell: (t) => formatDate(t.updated_at), sortValue: (t) => t.updated_at },
    { id: 'status', header: 'Status', cell: (t) => <StatusBadge label={t.status === 'ACTIVE' ? 'Active' : 'Archived'} tone={t.status === 'ACTIVE' ? 'success' : 'neutral'} />, sortValue: (t) => t.status },
    { id: 'use', header: '', cell: (t) => t.status === 'ACTIVE' && (
      <PermissionGate permission="production_bom.create">
        <Button variant="outline" size="sm" asChild onClick={(e) => e.stopPropagation()}><Link to={`/production/boms/similar?template=${t.id}`}><Copy /> Create product</Link></Button>
      </PermissionGate>
    ) },
  ]

  return (
    <>
      <PageHeader title="BOM templates" breadcrumbs={[{ label: 'Production & Outsourcing' }, { label: 'Bill of Materials (BOM)', to: '/production/boms' }, { label: 'Templates' }]}
        description="Reusable component lists (default quantities and wastage) for creating new finished products. Using a template never changes it or any BOM."
        actions={<PermissionGate permission="production_bom.create"><Button asChild><Link to="/production/bom-templates/new"><Plus /> New template</Link></Button></PermissionGate>} />
      {missing
        ? <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900">BOM templates are not available yet: the database update 20261203090000 has not been applied.</p>
        : (
          <DataTable
            title="Templates"
            columns={columns}
            data={rows}
            getRowId={(t) => t.id}
            loading={templates.loading}
            error={templates.error ? new Error(describeDataError(templates.error)) : null}
            onRetry={templates.reload}
            onRowClick={(t) => navigate(`/production/bom-templates/${t.id}`)}
            searchPlaceholder="Search template name or description…"
            pageSize={20}
            toolbar={<FilterTabs<Filter> label="Template status" value={filter} onChange={setFilter} options={[{ value: 'ACTIVE', label: 'Active' }, { value: 'ARCHIVED', label: 'Archived' }, { value: 'ALL', label: 'All' }]} />}
            emptyState={{ icon: LayoutTemplate, title: 'No BOM templates', description: 'Save a BOM as a template from its page, or create one here.' }}
          />
        )}
    </>
  )
}
