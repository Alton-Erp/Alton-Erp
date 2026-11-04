import { AlertTriangle, Boxes, Factory, Package, PackagePlus, Truck, Warehouse } from 'lucide-react'
import { Link } from 'react-router-dom'

import { KpiCard } from '@/components/common/kpi-card'
import { Button } from '@/components/ui/button'
import { ListCard, ModuleDashboard } from '@/features/management/module-dashboard-shell'
import { useDrill } from '@/features/drilldown/use-drill'
import { formatDate, formatNumber } from '@/lib/format'

interface Data {
  total: number
  active: number
  finished_goods: number
  raw_materials: number
  components: number
  outsourced: number
  other: number
  without_bom: number
  without_bom_list: { id: string; sku: string; product_name: string }[]
  added_in_period: number
  recent: { id: string; sku: string; product_name: string; product_type: string; created_at: string }[]
  low_stock: { product_id: string; sku: string; product_name: string; unit: string; available: number; reorder_level: number | null; status: string }[]
  low_stock_count: number
}

/** /products/dashboard */
export default function ProductsDashboardPage() {
  const { href } = useDrill('products')
  return (
    <ModuleDashboard<Data> module="PRODUCTS" title="Product Master Dashboard" description="Products by type, missing BOMs, new products and low stock."
      actions={<Button asChild><Link to="/products/new"><PackagePlus /> Add product</Link></Button>}>
      {(d, p) => (
        <div className="space-y-6">
          <section aria-label="Product figures" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard to={href('products.total', p)} label="Total Products" value={formatNumber(d.total)} hint={`${d.active} active`} icon={Package} />
            <KpiCard to={href('products.finished_goods', p)} label="Finished Goods" value={formatNumber(d.finished_goods)} icon={Factory} accent="manufacturing" />
            <KpiCard to={href('products.raw_materials', p)} label="Raw Materials" value={formatNumber(d.raw_materials)} icon={Warehouse} />
            <KpiCard to={href('products.components', p)} label="Components" value={formatNumber(d.components)} hint="Components and subassemblies" icon={Boxes} />
            <KpiCard to={href('products.outsourced', p)} label="Outsourced Parts" value={formatNumber(d.outsourced)} hint="Outsourced components and bought-in items" icon={Truck} accent="outsourced" />
            <KpiCard to={href('products.without_bom', p)} label="Products Without BOM" value={formatNumber(d.without_bom)} hint="Made in-house, no approved BOM" icon={AlertTriangle} accent={d.without_bom ? 'shortage' : 'neutral'} />
            <KpiCard to={href('products.added', p)} label="Recently Added" value={formatNumber(d.added_in_period)} hint="In the selected period" icon={PackagePlus} />
            <KpiCard to={href('products.low_stock', p)} label="Low Stock Products" value={formatNumber(d.low_stock_count)} icon={AlertTriangle} accent={d.low_stock_count ? 'shortage' : 'neutral'} />
          </section>
          <div className="grid gap-6 xl:grid-cols-3">
            <ListCard title="Products without a BOM" description="Add a BOM to make them" empty={d.without_bom_list.length === 0} viewAll={href('products.without_bom', p)}>
              <ul className="divide-y text-sm">{d.without_bom_list.map((p) => (
                <li key={p.id} className="flex justify-between gap-2 py-1.5"><Link className="truncate text-primary hover:underline" to={`/products/${p.id}`}>{p.sku} — {p.product_name}</Link>
                  <Link className="shrink-0 text-xs text-primary hover:underline" to="/production/boms/new">Add BOM</Link></li>
              ))}</ul>
            </ListCard>
            <ListCard title="Recently added" empty={d.recent.length === 0} viewAll={href('products.added', p)}>
              <ul className="divide-y text-sm">{d.recent.map((p) => (
                <li key={p.id} className="flex justify-between gap-2 py-1.5"><Link className="truncate text-primary hover:underline" to={`/products/${p.id}`}>{p.sku} — {p.product_name}</Link>
                  <span className="shrink-0 text-xs text-muted-foreground">{formatDate(p.created_at)}</span></li>
              ))}</ul>
            </ListCard>
            <ListCard title="Low stock" empty={d.low_stock.length === 0} viewAll={href('products.low_stock', p)}>
              <ul className="divide-y text-sm">{d.low_stock.map((p) => (
                <li key={p.product_id} className="flex justify-between gap-2 py-1.5"><Link className="truncate text-primary hover:underline" to={`/inventory/stock/${p.product_id}`}>{p.sku} — {p.product_name}</Link>
                  <span className="shrink-0 tabular-nums">{Number(p.available)} {p.unit}</span></li>
              ))}</ul>
            </ListCard>
          </div>
        </div>
      )}
    </ModuleDashboard>
  )
}
