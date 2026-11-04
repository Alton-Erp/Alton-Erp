/**
 * Product / component and BOM version history (migration 20261118090000_master_versioning.sql).
 * Pure helpers for the comparison screens.
 */

export interface ProductVersion {
  id: string
  version_no: number
  effective_from: string
  effective_to: string | null
  is_current: boolean
  is_legacy: boolean
  source: 'LEGACY_BASELINE' | 'CREATED' | 'UPDATED'
  change_reason: string | null
  changes: Record<string, { from: unknown; to: unknown }> | null
  created_by: string | null
  created_at: string
  values: Record<string, unknown>
}

export interface ProductHistory {
  product: { id: string; sku: string; product_name: string; product_type: string }
  versions: ProductVersion[]
}

export interface BomVersionItem {
  component_product_id: string
  line_no: number
  sku: string
  product_name: string
  component_version: string
  quantity: number
  unit: string
  wastage_percentage: number
  notes: string | null
  /** Component standard cost in the version the BOM line uses (approved) or holds (draft). */
  standard_cost?: number | null
  /** Standard cost of the line per output unit (quantity incl. wastage × cost ÷ output quantity). */
  line_cost?: number | null
}

export interface BomVersion {
  id: string
  bom_code: string
  version: number
  status: string
  lifecycle: 'DRAFT' | 'PENDING_APPROVAL' | 'REJECTED' | 'ACTIVE' | 'SCHEDULED' | 'SUPERSEDED' | 'ARCHIVED'
  effective_from: string
  effective_to: string | null
  output_quantity: number
  output_unit: string
  notes: string | null
  change_reason: string | null
  process_instructions: string | null
  created_by: string | null
  created_at: string
  approved_by: string | null
  approved_at: string | null
  /** Last change (saved, approved or archived). */
  modified_at?: string | null
  /** Version that replaced this one. */
  superseded_by?: number | null
  items: BomVersionItem[]
}

export interface BomHistory {
  product: { id: string; sku: string; product_name: string }
  versions: BomVersion[]
}

/** Product attributes shown in comparisons, in this order; anything else follows alphabetically. */
export const PRODUCT_FIELD_LABELS: Record<string, string> = {
  sku: 'SKU', product_name: 'Name', description: 'Description', product_type: 'Product type', category_id: 'Category', base_unit: 'Unit (UOM)',
  hsn_code: 'HSN / SAC', gst_rate: 'GST rate %', standard_cost: 'Standard cost', standard_manufacturing_cost: 'Standard manufacturing cost',
  selling_price: 'Selling price', minimum_selling_price: 'Minimum selling price', mrp: 'MRP', status: 'Status', brand: 'Brand', model_number: 'Model number',
  barcode: 'Barcode', ean: 'EAN', default_source_type: 'Source', track_batches: 'Batch tracking', track_expiry: 'Expiry tracking',
  inventory_tracked: 'Stock tracked', is_manufacturable: 'Manufacturable', length_cm: 'Length (cm)', width_cm: 'Width (cm)', height_cm: 'Height (cm)',
  lead_time_days: 'Lead time (days)', reorder_level_days: 'Reorder level (days)', minimum_cover_days: 'Minimum stock days', reorder_level: 'Reorder level',
  minimum_level: 'Minimum level', preferred_supplier_id: 'Preferred supplier', supplier_model_number: 'Supplier model no.',
  supplier_product_name: 'Supplier product name', group_head: 'Group head', production_notes: 'Production notes', remarks: 'Remarks',
}

export const fieldLabel = (key: string) => PRODUCT_FIELD_LABELS[key] ?? key.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())

export function formatVersionValue(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—'
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  if (typeof v === 'number') return String(v)
  if (typeof v === 'string') return v.replace(/_/g, ' ')
  return JSON.stringify(v)
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

export interface FieldDiff {
  key: string
  label: string
  a: unknown
  b: unknown
  changed: boolean
}

/** Every attribute of two product versions side by side; changed ones flagged. */
export function compareProductVersions(a: Record<string, unknown>, b: Record<string, unknown>): FieldDiff[] {
  const order = Object.keys(PRODUCT_FIELD_LABELS)
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .sort((x, y) => {
      const ix = order.indexOf(x)
      const iy = order.indexOf(y)
      if (ix >= 0 && iy >= 0) return ix - iy
      if (ix >= 0) return -1
      if (iy >= 0) return 1
      return x.localeCompare(y)
    })
  return keys.map((key) => ({ key, label: fieldLabel(key), a: a[key], b: b[key], changed: !same(a[key], b[key]) }))
}

export type ComponentChange = 'ADDED' | 'REMOVED' | 'CHANGED' | 'UNCHANGED'

export interface ComponentDiff {
  component_product_id: string
  sku: string
  product_name: string
  change: ComponentChange
  a: BomVersionItem | null
  b: BomVersionItem | null
  /** Which properties differ (quantity, unit, wastage, component version, cost, notes). */
  fields: string[]
}

/** Components of two BOM versions: added, removed, changed (quantity, UOM, wastage, component version) or unchanged. */
export function compareBomVersions(a: BomVersion, b: BomVersion): { header: FieldDiff[]; components: ComponentDiff[] } {
  const header: FieldDiff[] = ([
    ['effective_from', 'Effective from'], ['effective_to', 'Effective to'], ['output_quantity', 'Output quantity'], ['output_unit', 'Output unit'],
    ['lifecycle', 'Status'], ['change_reason', 'Reason for change'], ['process_instructions', 'Process instructions'], ['notes', 'Notes'],
    ['approved_by', 'Approved by'], ['approved_at', 'Approved at'],
  ] as const).map(([key, label]) => ({ key, label, a: a[key], b: b[key], changed: !same(a[key], b[key]) }))
  const ids = [...new Set([...a.items, ...b.items].map((i) => i.component_product_id))]
  const components = ids.map((id): ComponentDiff => {
    const ia = a.items.find((i) => i.component_product_id === id) ?? null
    const ib = b.items.find((i) => i.component_product_id === id) ?? null
    const ref = ib ?? ia!
    if (!ia || !ib) return { component_product_id: id, sku: ref.sku, product_name: ref.product_name, change: ia ? 'REMOVED' : 'ADDED', a: ia, b: ib, fields: [] }
    const fields = ([['quantity', 'quantity'], ['unit', 'unit'], ['wastage_percentage', 'wastage'], ['component_version', 'component version'], ['line_cost', 'cost'], ['notes', 'notes']] as const)
      .filter(([k]) => (k === 'quantity' || k === 'wastage_percentage' || k === 'line_cost' ? Number(ia[k] ?? 0) !== Number(ib[k] ?? 0) : !same(ia[k], ib[k])))
      .map(([, label]) => label)
    return { component_product_id: id, sku: ref.sku, product_name: ref.product_name, change: fields.length ? 'CHANGED' : 'UNCHANGED', a: ia, b: ib, fields }
  })
  const rank: Record<ComponentChange, number> = { ADDED: 0, REMOVED: 1, CHANGED: 2, UNCHANGED: 3 }
  components.sort((x, y) => rank[x.change] - rank[y.change] || x.sku.localeCompare(y.sku))
  return { header, components }
}

export const LIFECYCLE_LABELS: Record<BomVersion['lifecycle'], string> = {
  DRAFT: 'Draft', PENDING_APPROVAL: 'Pending approval', REJECTED: 'Rejected', ACTIVE: 'Active', SCHEDULED: 'Scheduled', SUPERSEDED: 'Superseded', ARCHIVED: 'Archived',
}

export const versionLabel = (v: Pick<ProductVersion, 'version_no' | 'is_legacy'>) => `v${v.version_no}${v.is_legacy ? ' (legacy baseline)' : ''}`

/** Standard cost of one output unit of a BOM version (null when a component has no standard cost). */
export function bomUnitCost(v: BomVersion): number | null {
  if (v.items.some((i) => i.line_cost === null || i.line_cost === undefined)) return null
  return Math.round(v.items.reduce((s, i) => s + Number(i.line_cost), 0) * 100) / 100
}

export const CHANGE_LABELS: Record<ComponentChange, string> = { ADDED: 'Added', REMOVED: 'Removed', CHANGED: 'Modified', UNCHANGED: 'Unchanged' }
