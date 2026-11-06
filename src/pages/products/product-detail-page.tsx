import { Archive, ArchiveRestore, History, ImageOff, Info, Pencil, Power, PowerOff } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom'

import { PermissionGate } from '@/auth/permission-gate'
import { useAuth } from '@/auth/use-auth'
import { usePermissions } from '@/auth/use-permissions'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ProductSourceBadge, ProductStatusBadge } from '@/features/products/product-badges'
import { productGaps } from '@/features/products/product-completeness'
import { PurchaseCostHistoryTab } from '@/features/products/purchase-cost-history'
import { BOM_OUTPUT_TYPES, PRODUCT_TYPE_LABELS, SOURCE_TYPE_DESCRIPTIONS, UNITS } from '@/features/products/product-model'
import { useAsync } from '@/hooks/use-async'
import { cn } from '@/lib/utils'
import { describeDataError } from '@/lib/errors'
import { formatCurrency, formatDateTime, formatNumber } from '@/lib/format'
import { fetchResourceAudit } from '@/services/audit-logs'
import { fetchProductBomSummary } from '@/services/production'
import { fetchDisplayNames, getProduct, getProductImageUrl, listCategories, setProductArchived, setProductStatus } from '@/services/products'
import { fetchSupplierOptions } from '@/services/suppliers'
import type { ProductRow } from '@/types/database'

const ACTION_LABELS: Record<string, string> = {
  'product.created': 'Created',
  'product.updated': 'Edited',
  'product.activated': 'Activated',
  'product.deactivated': 'Deactivated',
  'product.archived': 'Archived',
  'product.unarchived': 'Restored from archive',
  'product.sku_changed': 'SKU changed',
  'products.purchase_cost_updated': 'Last purchase cost updated',
  'products.purchase_cost_recorded': 'Receipt cost recorded (not applied)',
  'products.purchase_cost_reversed': 'Receipt reversed: purchase cost recalculated',
  'products.purchase_cost_overridden': 'Last purchase cost overridden',
}

const TABS = [['overview', 'Overview'], ['purchase-cost', 'Purchase Cost History']] as const
type DetailTab = (typeof TABS)[number][0]

async function loadDetail(id: string, canReadBoms: boolean) {
  const [product, categories, boms, suppliers] = await Promise.all([
    getProduct(id),
    listCategories(),
    canReadBoms ? fetchProductBomSummary(id).catch(() => null) : Promise.resolve(null),
    fetchSupplierOptions(true).catch(() => []),
  ])
  const names = await fetchDisplayNames([product.created_by, product.updated_by, product.archived_by])
  const supplier = suppliers.find((s) => s.id === product.preferred_supplier_id) ?? null
  return { product, category: categories.find((c) => c.id === product.category_id) ?? null, names, boms, supplier }
}

export default function ProductDetailPage() {
  const { productId = '' } = useParams()
  const location = useLocation()
  const [params, setParams] = useSearchParams()
  const tab: DetailTab = params.get('tab') === 'purchase-cost' ? 'purchase-cost' : 'overview'
  const { access } = useAuth()
  const { has } = usePermissions()
  const timezone = access?.company?.timezone
  const [refresh, setRefresh] = useState(0)
  const { data, loading, error, reload } = useAsync(() => loadDetail(productId, has('production_bom.read')), [productId, refresh])
  const [confirm, setConfirm] = useState<'activate' | 'deactivate' | 'archive' | 'unarchive' | null>(null)
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(
    (location.state as { message?: string } | null)?.message ? { tone: 'success', text: (location.state as { message: string }).message } : null,
  )

  if (loading && !data) return <LoadingState label="Loading product…" />
  if (error || !data) {
    return (
      <>
        <PageHeader title="Product" breadcrumbs={[{ label: 'Master Data' }, { label: 'Product Master', to: '/products' }, { label: 'Product' }]} />
        <Card>
          <ErrorState message={describeDataError(error)} onRetry={reload} />
        </Card>
      </>
    )
  }

  const { product: p, category, names, boms, supplier } = data
  const archived = Boolean(p.archived_at)
  const activeBom = boms?.versions.find((v) => v.status === 'APPROVED') ?? null
  const draftBom = boms?.versions.find((v) => v.status === 'DRAFT' || v.status === 'REJECTED' || v.status === 'PENDING_APPROVAL') ?? null
  const gaps = archived ? [] : productGaps(p, boms ? Boolean(activeBom) : undefined)
  const canHaveBom = BOM_OUTPUT_TYPES.includes(p.product_type)
  const unitLabel = UNITS.find((u) => u.code === p.base_unit)?.label ?? p.base_unit
  const name = (id: string | null) => (id ? (names.get(id) ?? 'Another user') : 'System')
  const money = (v: number | null | undefined) => (v === null || v === undefined ? null : formatCurrency(Number(v)))

  const runAction = async (kind: NonNullable<typeof confirm>) => {
    setNotice(null)
    try {
      if (kind === 'activate') await setProductStatus(p.id, 'ACTIVE')
      if (kind === 'deactivate') await setProductStatus(p.id, 'INACTIVE')
      if (kind === 'archive') await setProductArchived(p.id, true)
      if (kind === 'unarchive') await setProductArchived(p.id, false)
      setNotice({ tone: 'success', text: 'Status updated.' })
      setRefresh((n) => n + 1)
    } catch (err) {
      setNotice({ tone: 'error', text: describeDataError(err) })
    }
  }

  return (
    <>
      <PageHeader
        title={p.product_name}
        description={`SKU ${p.sku}${category ? ` · ${category.name}` : ''}`}
        breadcrumbs={[{ label: 'Master Data' }, { label: 'Product Master', to: '/products' }, { label: p.sku }]}
        actions={
          <>
            <Button variant="outline" asChild><Link to={`/products/${p.id}/versions`}><History /> Revision history</Link></Button>
            {has('products.archive') && !archived && p.status === 'ACTIVE' && (
              <Button variant="outline" onClick={() => setConfirm('deactivate')}>
                <PowerOff />
                Deactivate
              </Button>
            )}
            {has('products.archive') && !archived && p.status === 'INACTIVE' && (
              <>
                <Button variant="outline" onClick={() => setConfirm('activate')}>
                  <Power />
                  Activate
                </Button>
                <Button variant="outline" onClick={() => setConfirm('archive')}>
                  <Archive />
                  Archive
                </Button>
              </>
            )}
            {has('products.archive') && archived && (
              <Button variant="outline" onClick={() => setConfirm('unarchive')}>
                <ArchiveRestore />
                Restore from archive
              </Button>
            )}
            <PermissionGate permission="products.update">
              {!archived && (
                <Button asChild>
                  <Link to={`/products/${p.id}/edit`}>
                    <Pencil />
                    Edit
                  </Link>
                </Button>
              )}
            </PermissionGate>
          </>
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

      {gaps.length > 0 && (
        <div role="status" className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <p className="font-medium">Missing information ({gaps.length}). The product can be used as it is; complete these when you can.</p>
          <ul className="mt-1 list-disc pl-5">{gaps.map((g) => <li key={g.key}>{g.message}</li>)}</ul>
          <div className="mt-2 flex flex-wrap gap-2">
            {has('products.update') && <Button size="sm" variant="outline" asChild><Link to={`/products/${p.id}/edit`}><Pencil /> Add missing details</Link></Button>}
            {gaps.some((g) => g.key === 'bom') && has('production_bom.create') && (
              <Button size="sm" variant="outline" asChild>
                <Link to={draftBom ? `/production/boms/${draftBom.id}` : `/production/boms/new?product=${p.id}`}>{draftBom ? `Continue draft BOM v${draftBom.version}` : 'Create BOM'}</Link>
              </Button>
            )}
          </div>
        </div>
      )}

      <div role="tablist" aria-label="Product sections" className="mb-4 flex flex-wrap gap-1 rounded-lg border bg-muted/40 p-1 text-sm">
        {TABS.map(([t, label]) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} data-testid={`product-tab-${t}`}
            onClick={() => setParams(t === 'overview' ? {} : { tab: t }, { replace: true })}
            className={cn('rounded-md px-3 py-1.5', tab === t ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground')}>{label}</button>
        ))}
      </div>

      {tab === 'purchase-cost' ? <PurchaseCostHistoryTab productId={p.id} timezone={timezone} /> : (
      <div className="grid gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <InfoCard title="Basic Information">
            <div className="flex gap-5 sm:col-span-2">
              <ProductImage path={p.product_image_path} />
              <dl className="grid flex-1 gap-4 sm:grid-cols-2">
                <Item label="SKU">{p.sku}</Item>
                <Item label="Status">
                  <ProductStatusBadge product={p} />
                </Item>
                <Item label="Category">{category ? `${category.name}${category.is_active ? '' : ' (inactive)'}` : null}</Item>
                <Item label="Manufacturer / Brand">{p.brand}</Item>
                <Item label="Model Number">{p.model_number}</Item>
                <Item label="Barcode">{p.barcode}</Item>
                <Item label="EAN">{p.ean}</Item>
                <Item label="Supplier Model No.">{p.supplier_model_number}</Item>
                <Item label="Supplier Product Name">{p.supplier_product_name}</Item>
              </dl>
            </div>
            <Item label="Description" full>
              {p.description && <span className="whitespace-pre-line">{p.description}</span>}
            </Item>
          </InfoCard>

          <InfoCard title="Classification">
            <Item label="Product Type">{PRODUCT_TYPE_LABELS[p.product_type]}</Item>
            <Item label="Unit of Measurement">{`${p.base_unit} — ${unitLabel}`}</Item>
            <Item label="Group Head">{p.group_head}</Item>
            <Item label="Default Source Type">
              <ProductSourceBadge source={p.default_source_type} />
              <span className="mt-1 block text-xs text-muted-foreground">{SOURCE_TYPE_DESCRIPTIONS[p.default_source_type]}</span>
            </Item>
            <Item label="Tracking">{[p.track_batches && 'Batches', p.track_expiry && 'Expiry'].filter(Boolean).join(', ') || 'None'}</Item>
            <Item label="Stock item">{p.inventory_tracked === false ? 'No: service / non-stock (invoiced without dispatch)' : 'Yes: dispatch before invoice posting'}</Item>
            <Item label="Dimensions (L × W × H)" full>{dimensionsText(p)}</Item>
            <p className="flex gap-2 text-xs text-muted-foreground sm:col-span-2">
              <Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              The default source describes the normal sourcing strategy. The actual source of each stock quantity is recorded on inventory receipts.
            </p>
          </InfoCard>

          <InfoCard title="Tax and Pricing">
            <Item label="HSN Code">{p.hsn_code}</Item>
            <Item label="GST Rate">{p.gst_rate === null ? null : `${Number(p.gst_rate)}%`}</Item>
            <Item label="MRP (incl. taxes)">{money(p.mrp)}</Item>
            <Item label="Selling Price (before GST)">{money(p.selling_price)}</Item>
            <Item label="Standard Purchase Cost">{money(p.standard_cost)}</Item>
            <Item label="Standard Manufacturing Cost">{money(p.standard_manufacturing_cost)}</Item>
            <Item label="Minimum Selling Price">{money(p.minimum_selling_price)}</Item>
          </InfoCard>

          <InfoCard title="Inventory Planning" description="Planned in days of stock cover (available stock ÷ average daily consumption). Stock balances come from the inventory module.">
            <Item label="Lead Time">{p.lead_time_days == null ? null : `${formatNumber(Number(p.lead_time_days))} days`}</Item>
            <Item label="Reorder Level">{p.reorder_level_days == null ? null : `${formatNumber(Number(p.reorder_level_days))} days of cover`}</Item>
            <Item label="Minimum Stock Days">{p.minimum_cover_days == null ? null : `${formatNumber(Number(p.minimum_cover_days))} days`}</Item>
            {(p.reorder_level != null || p.minimum_level != null) && (
              <Item label="Earlier quantity levels (not converted to days)" full>
                {[p.reorder_level != null && `reorder at ${formatNumber(Number(p.reorder_level))} ${p.base_unit}`,
                  p.minimum_level != null && `minimum ${formatNumber(Number(p.minimum_level))} ${p.base_unit}`].filter(Boolean).join(' · ')}
                <span className="mt-0.5 block text-xs text-muted-foreground">The reorder quantity still raises low-stock alerts until it is cleared on the edit page.</span>
              </Item>
            )}
            {has('inventory.read') && (
              <p className="text-xs sm:col-span-2"><Link className="text-primary hover:underline" to={`/inventory/alerts?tab=planning&q=${encodeURIComponent(p.sku)}`}>See days of cover and reorder recommendation</Link></p>
            )}
          </InfoCard>

          <InfoCard title="Manufacturing and Procurement">
            <Item label="Manufacturable">{p.is_manufacturable ? 'Yes' : 'No'}</Item>
            <Item label="Preferred Supplier">
              {supplier ? `${supplier.supplier_code} — ${supplier.display_name ?? supplier.legal_name}` : p.preferred_supplier_id ? 'Set (no supplier access)' : null}
            </Item>
            <Item label="Production Notes" full>
              {p.production_notes && <span className="whitespace-pre-line">{p.production_notes}</span>}
            </Item>
            <Item label="Remarks" full>
              {p.remarks && <span className="whitespace-pre-line">{p.remarks}</span>}
            </Item>
          </InfoCard>

          {boms && (canHaveBom || boms.versions.length > 0 || boms.usedIn.length > 0) && (
            <InfoCard title="Bill of Materials" description="Versions are kept for history; only the active version is used for new production.">
              <div className="space-y-3 sm:col-span-2">
                {canHaveBom && (
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    {activeBom
                      ? <span>Active: <Link className="font-medium text-primary hover:underline" to={`/production/boms/${activeBom.id}`}>{activeBom.bom_code} v{activeBom.version}</Link> · {activeBom.item_count} component(s) · <Link className="text-primary hover:underline" to={`/production/boms/${activeBom.id}/versions`}>BOM version history</Link></span>
                      : <span className="text-muted-foreground">No active BOM.</span>}
                    {has('production_bom.create') && !archived && (
                      draftBom
                        ? <Button size="sm" variant="outline" asChild><Link to={`/production/boms/${draftBom.id}`}>Continue draft v{draftBom.version}</Link></Button>
                        : activeBom
                          ? <Button size="sm" variant="outline" asChild><Link to={`/production/boms/${activeBom.id}`}><Pencil /> Edit components</Link></Button>
                          : <Button size="sm" variant="outline" asChild><Link to={`/production/boms/new?product=${p.id}`}>Create BOM</Link></Button>
                    )}
                  </div>
                )}
                {boms.versions.length > 0 && (
                  <ul className="flex flex-wrap gap-2 text-xs">
                    {boms.versions.map((v) => (
                      <li key={v.id}>
                        <Link to={`/production/boms/${v.id}`} className="rounded border px-2 py-1 hover:bg-muted">
                          v{v.version} · {v.status === 'APPROVED' ? 'active' : v.status.replace('_', ' ').toLowerCase()}
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
                {boms.usedIn.length > 0 && (
                  <div className="text-sm">
                    <p className="font-medium">Used in</p>
                    <ul className="mt-1 space-y-0.5">
                      {boms.usedIn.map((b) => (
                        <li key={b.id}>
                          <Link className="text-primary hover:underline" to={`/production/boms/${b.id}`}>{b.sku} — {b.product_name}</Link>
                          <span className="text-muted-foreground"> (v{b.version}, {formatNumber(b.quantity_required)} {b.unit} per {formatNumber(Number(b.output_quantity))} {b.output_unit})</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </InfoCard>
          )}
        </div>

        <div className="space-y-6">
          <InfoCard title="Record">
            <Item label="Created" full>{`${formatDateTime(p.created_at, timezone)} by ${name(p.created_by)}`}</Item>
            <Item label="Last updated" full>{`${formatDateTime(p.updated_at, timezone)} by ${name(p.updated_by)}`}</Item>
            {p.archived_at && <Item label="Archived" full>{`${formatDateTime(p.archived_at, timezone)} by ${name(p.archived_by)}`}</Item>}
          </InfoCard>
          <PermissionGate permission="audit_logs.read">
            <ActivityCard product={p} timezone={timezone} refresh={refresh} />
          </PermissionGate>
        </div>
      </div>
      )}

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={
          confirm === 'archive' ? 'Archive product?' : confirm === 'unarchive' ? 'Restore from archive?' : confirm === 'activate' ? 'Activate product?' : 'Deactivate product?'
        }
        description={
          confirm === 'archive'
            ? 'Archived products are hidden from the default list but never deleted, so historical references stay intact.'
            : confirm === 'deactivate'
              ? 'The product will no longer be offered for new transactions. History is kept.'
              : 'The change is recorded in the audit log.'
        }
        confirmLabel={confirm === 'unarchive' ? 'Restore' : confirm ? confirm[0].toUpperCase() + confirm.slice(1) : 'Confirm'}
        destructive={confirm === 'archive' || confirm === 'deactivate'}
        onConfirm={() => confirm && void runAction(confirm)}
      />
    </>
  )
}

function dimensionsText(p: ProductRow): string | null {
  const parts = [p.length_cm, p.width_cm, p.height_cm]
  if (parts.every((v) => v == null)) return null
  return `${parts.map((v) => (v == null ? '—' : formatNumber(Number(v)))).join(' × ')} cm`
}

function InfoCard({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>{title}</CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </div>
      </CardHeader>
      <CardContent>
        <dl className="grid gap-4 sm:grid-cols-2">{children}</dl>
      </CardContent>
    </Card>
  )
}

function Item({ label, full, children }: { label: string; full?: boolean; children: ReactNode }) {
  const empty = children === null || children === undefined || children === '' || children === false
  return (
    <div className={full ? 'sm:col-span-2' : undefined}>
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-sm text-foreground">{empty ? <span className="text-muted-foreground">Not set</span> : children}</dd>
    </div>
  )
}

function ProductImage({ path }: { path: string | null }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    if (path) void getProductImageUrl(path).then((u) => !cancelled && setUrl(u))
    return () => {
      cancelled = true
    }
  }, [path])
  return (
    <div className="flex size-28 shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-surface-muted">
      {path && url ? <img src={url} alt="Product" className="size-full object-cover" /> : <ImageOff aria-hidden className="size-6 text-muted-foreground" />}
    </div>
  )
}

function ActivityCard({ product, timezone, refresh }: { product: ProductRow; timezone?: string; refresh: number }) {
  const { data, loading, error } = useAsync(() => fetchResourceAudit('product', product.id), [product.id, refresh])
  const names = useAsync(() => fetchDisplayNames((data ?? []).map((e) => e.actor_user_id)), [data])
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Activity</CardTitle>
          <CardDescription>From the audit log</CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : error ? (
          <p className="text-sm text-shortage">{describeDataError(error)}</p>
        ) : (data ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">No recorded activity.</p>
        ) : (
          <ol className="space-y-3">
            {(data ?? []).map((e) => {
              const meta = e.metadata as { changed_fields?: string[]; from?: string; to?: string } | null
              return (
                <li key={e.id} className="text-sm">
                  <p className="font-medium">{ACTION_LABELS[e.action] ?? e.action}</p>
                  <p className="text-xs text-muted-foreground">
                    {formatDateTime(e.event_timestamp, timezone)} · {e.actor_user_id ? (names.data?.get(e.actor_user_id) ?? 'User') : 'System'}
                  </p>
                  {meta?.changed_fields && <p className="text-xs text-muted-foreground">Fields: {meta.changed_fields.join(', ').replace(/_/g, ' ')}</p>}
                  {meta?.from && <p className="text-xs text-muted-foreground">{`${meta.from} → ${meta.to}`}</p>}
                </li>
              )
            })}
          </ol>
        )}
      </CardContent>
    </Card>
  )
}
