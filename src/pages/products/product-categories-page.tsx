import { FolderTree, Loader2, Pencil, Plus, Power, PowerOff } from 'lucide-react'
import { useState } from 'react'

import { PermissionGate } from '@/auth/permission-gate'
import { useAuth } from '@/auth/use-auth'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { FilterTabs } from '@/components/common/filter-tabs'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { CATEGORY_CODE_RE } from '@/features/products/product-model'
import { useAsync } from '@/hooks/use-async'
import { describeDataError, describeProductError } from '@/lib/errors'
import { formatNumber } from '@/lib/format'
import { createCategory, listCategoriesWithCounts, updateCategory, type CategoryWithCounts } from '@/services/products'

type StatusFilter = 'all' | 'active' | 'inactive'

export default function ProductCategoriesPage() {
  const { access } = useAuth()
  const companyId = access?.company?.id ?? ''
  const { data, loading, error, reload } = useAsync(listCategoriesWithCounts, [])
  const [status, setStatus] = useState<StatusFilter>('all')
  const [editing, setEditing] = useState<CategoryWithCounts | 'new' | null>(null)
  const [toggling, setToggling] = useState<CategoryWithCounts | null>(null)
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)

  const categories = (data ?? []).filter((c) => status === 'all' || (status === 'active' ? c.is_active : !c.is_active))

  const toggle = async (c: CategoryWithCounts) => {
    setNotice(null)
    try {
      await updateCategory(c.id, { is_active: !c.is_active })
      setNotice({ tone: 'success', text: `${c.name} ${c.is_active ? 'deactivated' : 'activated'}.` })
      reload()
    } catch (err) {
      setNotice({ tone: 'error', text: describeDataError(err) })
    }
  }

  const columns: DataTableColumn<CategoryWithCounts>[] = [
    {
      id: 'name',
      header: 'Category',
      cell: (c) => (
        <div>
          <p className="font-medium">{c.name}</p>
          {c.description && <p className="max-w-md truncate text-xs text-muted-foreground">{c.description}</p>}
        </div>
      ),
      searchValue: (c) => `${c.name} ${c.description ?? ''}`,
    },
    { id: 'code', header: 'Code', cell: (c) => <code className="text-xs">{c.code}</code>, searchValue: (c) => c.code },
    {
      id: 'products',
      header: 'Products',
      align: 'right',
      cell: (c) => (
        <span className="tabular-nums">
          {formatNumber(c.active_products)} active
          <span className="text-muted-foreground"> / {formatNumber(c.total_products)}</span>
        </span>
      ),
    },
    { id: 'status', header: 'Status', cell: (c) => (c.is_active ? <StatusBadge label="Active" tone="success" /> : <StatusBadge label="Inactive" />) },
    {
      id: 'actions',
      header: 'Actions',
      align: 'right',
      cell: (c) => {
        const blocked = c.is_active && c.active_products > 0
        return (
          <PermissionGate permission="product_categories.manage" fallback={<span className="text-xs text-muted-foreground">View only</span>}>
            <div className="flex justify-end gap-1.5">
              <Button variant="outline" size="sm" onClick={() => setEditing(c)}>
                <Pencil />
                Edit
              </Button>
              <span title={blocked ? 'Reassign or deactivate its active products first' : undefined}>
                <Button variant="outline" size="sm" disabled={blocked} onClick={() => setToggling(c)}>
                  {c.is_active ? <PowerOff /> : <Power />}
                  {c.is_active ? 'Deactivate' : 'Activate'}
                </Button>
              </span>
            </div>
          </PermissionGate>
        )
      },
    },
  ]

  return (
    <>
      <PageHeader
        title="Product Categories"
        description="Organise products into categories. Categories are never deleted; deactivate ones you no longer use."
        breadcrumbs={[{ label: 'Master Data' }, { label: 'Product Master', to: '/products' }, { label: 'Categories' }]}
        actions={
          <PermissionGate permission="product_categories.manage">
            <Button onClick={() => setEditing('new')}>
              <Plus />
              New Category
            </Button>
          </PermissionGate>
        }
      />

      {notice && (
        <div
          role={notice.tone === 'error' ? 'alert' : 'status'}
          className={
            notice.tone === 'error'
              ? 'mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800'
              : 'mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-800'
          }
        >
          {notice.text}
        </div>
      )}

      <DataTable
        title="Categories"
        description="The suggested categories created at setup can be renamed, deactivated or supplemented."
        columns={columns}
        data={categories}
        getRowId={(c) => c.id}
        searchPlaceholder="Search categories…"
        loading={loading}
        error={error ? new Error(describeDataError(error)) : null}
        onRetry={reload}
        pageSize={25}
        toolbar={
          <FilterTabs<StatusFilter>
            label="Category status"
            value={status}
            onChange={setStatus}
            options={[
              { value: 'all', label: 'All', count: data?.length },
              { value: 'active', label: 'Active', count: data?.filter((c) => c.is_active).length },
              { value: 'inactive', label: 'Inactive', count: data?.filter((c) => !c.is_active).length },
            ]}
          />
        }
        emptyState={{
          icon: FolderTree,
          title: (data ?? []).length === 0 ? 'No categories yet' : 'No categories match',
          description: 'Create categories to group products for filtering, reporting and imports.',
        }}
      />

      {editing && (
        <CategoryDialog
          category={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSave={async (values) => {
            if (editing === 'new') await createCategory(companyId, values)
            else await updateCategory(editing.id, { name: values.name, description: values.description })
            setNotice({ tone: 'success', text: `Category "${values.name}" saved.` })
            setEditing(null)
            reload()
          }}
        />
      )}

      <ConfirmDialog
        open={toggling !== null}
        onOpenChange={(open) => !open && setToggling(null)}
        title={toggling?.is_active ? 'Deactivate category?' : 'Activate category?'}
        description={
          toggling?.is_active
            ? `"${toggling.name}" can no longer be assigned to products. Products that already use it keep their category.`
            : `"${toggling?.name}" can be assigned to products again.`
        }
        confirmLabel={toggling?.is_active ? 'Deactivate' : 'Activate'}
        destructive={toggling?.is_active}
        onConfirm={() => toggling && void toggle(toggling)}
      />
    </>
  )
}

function CategoryDialog({
  category,
  onClose,
  onSave,
}: {
  category: CategoryWithCounts | null
  onClose: () => void
  onSave: (values: { code: string; name: string; description: string | null }) => Promise<void>
}) {
  const [code, setCode] = useState(category?.code ?? '')
  const [name, setName] = useState(category?.name ?? '')
  const [description, setDescription] = useState(category?.description ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    setError(null)
    const trimmedName = name.trim()
    const normalizedCode = code.trim().toUpperCase()
    if (!trimmedName) return setError('Enter a category name.')
    if (!category && !CATEGORY_CODE_RE.test(normalizedCode)) {
      return setError('Code: 1–30 characters, letters A–Z, digits, _ or -, starting with a letter or digit.')
    }
    setSaving(true)
    try {
      await onSave({ code: normalizedCode, name: trimmedName, description: description.trim() || null })
    } catch (err) {
      setError(describeProductError(err))
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{category ? 'Edit category' : 'New category'}</DialogTitle>
          <DialogDescription>Names and codes must be unique within your company.</DialogDescription>
        </DialogHeader>
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
        <form
          id="category-form"
          className="space-y-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="cat-name">Name</Label>
            <Input id="cat-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} autoFocus />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cat-code">Code</Label>
            <Input
              id="cat-code"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              maxLength={30}
              disabled={Boolean(category)}
              className={category ? 'bg-surface-muted' : undefined}
            />
            <p className="text-xs text-muted-foreground">
              {category ? 'Codes cannot be changed after creation.' : 'Short identifier used in imports, e.g. WASH_BASINS.'}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cat-desc">Description</Label>
            <Textarea id="cat-desc" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} rows={3} />
          </div>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form="category-form" disabled={saving}>
            {saving && <Loader2 className="animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
