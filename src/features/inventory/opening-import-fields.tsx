// Excel opening stock import: "Fields to Modify in Existing Opening Stock" and the existing-vs-Excel comparison
// of a matched row (migration 20261206090000).
import { Info } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { formatCost } from '@/features/products/product-list-format'
import { formatNumber } from '@/lib/format'

import { IMPORT_FIELD_OPTIONS, type OpeningImportFieldSelection, type OpeningRowResult } from './opening-import'

export function OpeningImportFieldsCard({ fields, onChange, costColumn, disabled }: {
  fields: OpeningImportFieldSelection
  onChange: (f: OpeningImportFieldSelection) => void
  /** Header of the Excel unit cost column, if the file has one. */
  costColumn: string | null
  disabled?: boolean
}) {
  const count = IMPORT_FIELD_OPTIONS.filter((o) => fields[o.key]).length
  const setAll = (v: boolean) => onChange({ quantity: v, unit_cost: v, remarks: v })
  return (
    <Card data-testid="oi-fields">
      <CardHeader>
        <div>
          <CardTitle>Fields to Modify in Existing Opening Stock</CardTitle>
          <CardDescription>
            For rows whose product, location and batch already have opening stock. Product, Location and Batch identify the record and are never changed.
          </CardDescription>
        </div>
        <div className="flex items-center gap-2">
          <span data-testid="oi-fields-count" className="text-sm text-muted-foreground">{count} of {IMPORT_FIELD_OPTIONS.length} selected</span>
          <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => setAll(true)}>Select All</Button>
          <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => setAll(false)}>Deselect All</Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 md:grid-cols-2">
          {IMPORT_FIELD_OPTIONS.map((o) => (
            <label key={o.key} htmlFor={`oi-field-${o.key}`} className="flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5">
              <Checkbox id={`oi-field-${o.key}`} className="mt-0.5" checked={fields[o.key]} disabled={disabled}
                onCheckedChange={(v) => onChange({ ...fields, [o.key]: v === true })} />
              <span>
                <span className="text-sm font-medium">{o.label}</span>
                <span className="block text-xs text-muted-foreground">
                  {o.hint}
                  {o.key === 'unit_cost' && (costColumn ? ` Read from column "${costColumn}".` : ' The file has no unit cost column.')}
                </span>
              </span>
            </label>
          ))}
          <div className="flex items-start gap-2.5 rounded-lg border border-dashed px-3 py-2.5 text-muted-foreground">
            <Checkbox id="oi-field-expiry" className="mt-0.5" checked={false} disabled aria-describedby="oi-field-expiry-hint" />
            <span>
              <span className="text-sm font-medium">Expiry Date</span>
              <span id="oi-field-expiry-hint" className="block text-xs">Not supported: the dates of an existing batch are fixed. Use a new batch number for stock with other dates.</span>
            </span>
          </div>
        </div>
        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          Unselected fields keep their stored values. Blank Excel cells never erase existing data, and the quantity is always added, never replaced.
        </p>
      </CardContent>
    </Card>
  )
}

const qty = (v: number, unit: string) => `${formatNumber(v)} ${unit}`

/** Field | Existing Value | Excel Value | Import Action for one matched row. */
export function MatchComparison({ row, fields, location }: { row: OpeningRowResult; fields: OpeningImportFieldSelection; location: string }) {
  const m = row.match
  const p = row.payload
  if (!m || !p) return null
  const add = row.action === 'add'
  const lines: [string, string, string, string][] = [
    ['Product', row.sku, row.sku, 'Keep'],
    ['Location', location, location, 'Keep'],
    ['Batch', p.batch_number ?? '—', p.batch_number ?? '—', 'Keep'],
    ['Quantity', qty(m.existing, m.unit), qty(p.quantity, m.unit), add ? `Add → ${qty(m.newQuantity, m.unit)}` : 'Not selected: keep'],
    ['Unit Cost', m.lotCost === null ? 'Pending cost' : formatCost(m.lotCost), row.excelCost === undefined ? '—' : formatCost(row.excelCost),
      !fields.unit_cost ? 'Not selected: keep' : row.excelCost === undefined ? 'Blank: keep'
        : m.lotCost === null ? `Apply ${formatCost(row.excelCost)} to the added quantity (cost override)` : 'Same cost: keep'],
    ['Remarks', '—', p.notes ?? '—', !fields.remarks ? 'Not selected' : p.notes ? 'Recorded on the addition' : 'Blank: nothing recorded'],
  ]
  return (
    <table data-testid="oi-compare" className="w-full min-w-[30rem] text-xs">
      <thead>
        <tr className="text-left text-muted-foreground"><th className="py-0.5 pr-3 font-medium">Field</th><th className="pr-3 font-medium">Existing Value</th><th className="pr-3 font-medium">Excel Value</th><th className="font-medium">Import Action</th></tr>
      </thead>
      <tbody>
        {lines.map(([f, e, x, a]) => (
          <tr key={f} data-field={f}><td className="py-0.5 pr-3 font-medium">{f}</td><td className="pr-3">{e}</td><td className="pr-3">{x}</td><td className={a.startsWith('Add') ? 'font-semibold text-available' : ''}>{a}</td></tr>
        ))}
      </tbody>
    </table>
  )
}
