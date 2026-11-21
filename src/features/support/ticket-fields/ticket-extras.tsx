import { Archive, Loader2, Package, Pencil, Save, SlidersHorizontal } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Field } from '@/features/support/support-components'
import { CustomFieldInput } from '@/features/support/ticket-fields/custom-field-input'
import { checkFieldValue, displayValue, formulaInputsOf, toInput, type InputValue } from '@/features/support/ticket-fields/field-model'
import { productDetail, quantityError, type PickedProduct } from '@/features/support/ticket-fields/product-model'
import { ProductMasterPicker } from '@/features/support/ticket-fields/product-picker'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { saveTicketCustomFields, saveTicketProducts, fetchTicketExtras, type TicketExtras } from '@/services/ticket-fields'

/**
 * Custom field values (in the configured order) and Product Master products of one ticket, each with an Edit
 * button for users allowed to change them. Nothing is shown before the database update 20261226090000.
 */
export function TicketExtrasCards({ ticketId, refreshKey, onChanged }: { ticketId: string; refreshKey: unknown; onChanged: (notice: string) => void }) {
  const q = useAsync(() => fetchTicketExtras(ticketId), [ticketId, refreshKey])
  if (!q.data) return q.error ? <Card><CardContent className="py-4 text-sm text-red-700">{describeDataError(q.error)}</CardContent></Card> : null
  const done = (notice: string) => { q.reload(); onChanged(notice) }
  return (
    <>
      {q.data.fields.length > 0 && <CustomFieldsCard key={`f-${JSON.stringify(q.data.fields.map((f) => f.value))}`} ticketId={ticketId} x={q.data} onSaved={done} />}
      {q.data.products !== null && <ProductsCard key={`p-${JSON.stringify(q.data.products)}`} ticketId={ticketId} x={q.data} onSaved={done} />}
    </>
  )
}

function CustomFieldsCard({ ticketId, x, onSaved }: { ticketId: string; x: TicketExtras; onSaved: (notice: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [values, setValues] = useState<Record<string, InputValue>>(() => Object.fromEntries(x.fields.map((f) => [f.field_key, toInput(f, f.value)])))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const editable = x.fields.filter((f) => f.is_active && f.field_type !== 'FORMULA')
  const liveInputs = editing ? { ...x.formula_inputs, ...formulaInputsOf(x.fields, values) } : x.formula_inputs

  const save = async () => {
    const errs: Record<string, string> = {}
    const changed: Record<string, unknown> = {}
    for (const f of editable) {
      const r = checkFieldValue(f, values[f.field_key] ?? null)
      if (r.error) { errs[f.field_key] = r.error; continue }
      if (f.required && (r.value === null || r.value === '')) { errs[f.field_key] = 'Required.'; continue }
      const before = checkFieldValue(f, toInput(f, f.value)).value
      if (JSON.stringify(before) !== JSON.stringify(r.value)) changed[f.field_key] = r.value
    }
    setErrors(errs)
    if (Object.keys(errs).length) return
    if (!Object.keys(changed).length) { setEditing(false); return }
    setBusy(true); setError(null)
    try {
      const r = await saveTicketCustomFields(ticketId, changed)
      onSaved(r.changed.length ? `${r.changed.length} field${r.changed.length === 1 ? '' : 's'} updated.` : 'Nothing changed.')
    } catch (e) {
      setError(describeDataError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card data-testid="ticket-custom-fields">
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div><CardTitle className="flex items-center gap-2"><SlidersHorizontal className="size-4" />Additional details</CardTitle><CardDescription>Custom ticket fields, in the form’s order.</CardDescription></div>
        {x.can.edit_fields && !editing && editable.length > 0 && <Button size="sm" variant="outline" onClick={() => setEditing(true)} data-testid="edit-custom-fields"><Pencil /> Edit</Button>}
      </CardHeader>
      <CardContent>
        {!editing ? (
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            {x.fields.map((f) => (
              <div key={f.field_key} className="min-w-0" data-testid={`cf-value-${f.field_key}`}>
                <dt className="text-xs text-muted-foreground">{f.field_label}{!f.is_active && ' (no longer in use)'}{f.is_active && !f.in_form && ' (not on the form)'}</dt>
                <dd className="break-words">{f.field_type === 'URL' && f.value ? <a className="text-primary hover:underline" href={String(f.value)} target="_blank" rel="noopener noreferrer nofollow">{String(f.value)}</a>
                  : displayValue(f, f.value, liveInputs)}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); void save() }} noValidate>
            {x.fields.map((f) => (f.is_active ? (
              <Field key={f.field_key} label={f.required ? `${f.field_label} *` : f.field_label} htmlFor={`te-cf-${f.field_key}`} error={errors[f.field_key]} hint={f.help_text ?? undefined}>
                <CustomFieldInput def={f} id={`te-cf-${f.field_key}`} value={values[f.field_key] ?? null} invalid={Boolean(errors[f.field_key])} formulaInputs={liveInputs}
                  onChange={(v) => setValues((s) => ({ ...s, [f.field_key]: v }))} />
              </Field>
            ) : (
              <div key={f.field_key} className="text-sm"><p className="text-xs text-muted-foreground">{f.field_label} (no longer in use — read only)</p><p>{displayValue(f, f.value)}</p></div>
            )))}
            {error && <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 sm:col-span-2">{error}</p>}
            <div className="flex justify-end gap-2 sm:col-span-2">
              <Button type="button" size="sm" variant="outline" onClick={() => { setEditing(false); setErrors({}); setError(null); setValues(Object.fromEntries(x.fields.map((f) => [f.field_key, toInput(f, f.value)]))) }}>Cancel</Button>
              <Button type="submit" size="sm" disabled={busy} data-testid="save-custom-fields">{busy ? <Loader2 className="animate-spin" /> : <Save />} Save</Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  )
}

function ProductsCard({ ticketId, x, onSaved }: { ticketId: string; x: TicketExtras; onSaved: (notice: string) => void }) {
  const products = x.products ?? []
  const initial = (): PickedProduct[] => products.map((p) => ({ product_id: p.product_id, sku: p.sku, product_name: p.product_name, quantity: String(p.quantity), archived: p.archived, detail: productDetail(p) }))
  const [editing, setEditing] = useState(false)
  const [items, setItems] = useState<PickedProduct[]>(initial)
  const [includeArchived, setIncludeArchived] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const save = async () => {
    if (items.some((p) => quantityError(p.quantity))) { setError('Check the product quantities.'); return }
    setBusy(true); setError(null)
    try {
      const existing = new Set(products.map((p) => p.product_id))
      const r = await saveTicketProducts(ticketId, items.map((p) => ({ product_id: p.product_id, quantity: p.quantity.trim() })), items.some((p) => p.archived && !existing.has(p.product_id)))
      const parts = [r.added.length && `${r.added.length} added`, r.removed.length && `${r.removed.length} removed`, r.changed.length && `${r.changed.length} changed`].filter(Boolean)
      onSaved(parts.length ? `Products: ${parts.join(', ')}.` : 'Products unchanged.')
    } catch (e) {
      setError(describeDataError(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card className="gap-0 overflow-hidden p-0" data-testid="ticket-products">
      <CardHeader className="flex flex-row items-start justify-between gap-2 border-b px-4 py-3">
        <div><CardTitle className="flex items-center gap-2"><Package className="size-4" />Products</CardTitle><CardDescription>From the Product Master; the name and SKU at the time are kept.</CardDescription></div>
        {x.can.manage_products && !editing && <Button size="sm" variant="outline" onClick={() => setEditing(true)} data-testid="edit-ticket-products"><Pencil /> Edit</Button>}
      </CardHeader>
      {editing ? (
        <CardContent className="space-y-3 p-4">
          <ProductMasterPicker id="te-products" value={items} onChange={setItems} canIncludeArchived={x.can.archived_products} includeArchived={includeArchived} onIncludeArchived={setIncludeArchived} />
          {error && <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="outline" onClick={() => { setEditing(false); setItems(initial()); setError(null) }}>Cancel</Button>
            <Button size="sm" disabled={busy} onClick={() => void save()} data-testid="save-ticket-products">{busy ? <Loader2 className="animate-spin" /> : <Save />} Save products</Button>
          </div>
        </CardContent>
      ) : products.length === 0 ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">No product is linked to this ticket.</p>
      ) : (
        <Table>
          <TableHeader><TableRow className="hover:bg-transparent"><TableHead>SKU</TableHead><TableHead>Product</TableHead><TableHead className="text-right">Qty</TableHead></TableRow></TableHeader>
          <TableBody>{products.map((p) => (
            <TableRow key={p.id} data-testid={`ticket-product-${p.sku_snapshot}`}>
              <TableCell className="font-mono text-xs">{p.sku}{p.sku !== p.sku_snapshot && <span className="block text-muted-foreground">was {p.sku_snapshot}</span>}</TableCell>
              <TableCell><span className="font-medium">{p.product_name}</span>
                {p.archived && <span className="ml-1.5 inline-flex items-center gap-0.5 text-xs text-amber-700"><Archive className="size-3" />archived</span>}
                {p.product_name !== p.product_name_snapshot && <span className="block text-xs text-muted-foreground">On the ticket as “{p.product_name_snapshot}”</span>}
                {productDetail(p) && <span className="block text-xs text-muted-foreground">{productDetail(p)}</span>}</TableCell>
              <TableCell className="text-right tabular-nums">{Number(p.quantity).toLocaleString('en-IN', { maximumFractionDigits: 3 })}{p.base_unit ? ` ${p.base_unit}` : ''}</TableCell>
            </TableRow>
          ))}</TableBody>
        </Table>
      )}
    </Card>
  )
}
