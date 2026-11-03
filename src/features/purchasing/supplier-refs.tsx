import { Loader2, Pencil } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { describeDataError } from '@/lib/errors'
import { setSupplierDocumentRefs } from '@/services/purchasing'

/**
 * Shows the supplier's invoice and challan numbers of an order or a goods
 * receipt, with an Edit button to add or correct them later.
 */
export function SupplierRefs({
  target,
  documentLabel,
  invoice,
  challan,
  canEdit,
  onSaved,
}: {
  target: { poId: string } | { receiptId: string }
  /** "PO-000012" / "GRN-000034": the Alton number the references belong to. */
  documentLabel: string
  invoice: string | null | undefined
  challan: string | null | undefined
  canEdit: boolean
  onSaved: (message: string) => void
}) {
  const [editing, setEditing] = useState(false)
  return (
    <div className="flex items-start justify-between gap-2">
      <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
        <div><dt className="text-xs text-muted-foreground">Supplier invoice no.</dt><dd className="font-medium">{invoice || <span className="font-normal text-muted-foreground">Not entered</span>}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Supplier challan no.</dt><dd className="font-medium">{challan || <span className="font-normal text-muted-foreground">Not entered</span>}</dd></div>
      </dl>
      {canEdit && (
        <Button size="sm" variant="outline" aria-label={`${invoice || challan ? 'Edit' : 'Add'} supplier references of ${documentLabel}`} onClick={() => setEditing(true)}>
          <Pencil /> {invoice || challan ? 'Edit' : 'Add'}
        </Button>
      )}
      {editing && (
        <RefsDialog target={target} documentLabel={documentLabel} invoice={invoice ?? ''} challan={challan ?? ''}
          onClose={() => setEditing(false)} onSaved={(m) => { setEditing(false); onSaved(m) }} />
      )}
    </div>
  )
}

function RefsDialog({ target, documentLabel, invoice, challan, onClose, onSaved }: {
  target: { poId: string } | { receiptId: string }
  documentLabel: string
  invoice: string
  challan: string
  onClose: () => void
  onSaved: (message: string) => void
}) {
  const [inv, setInv] = useState(invoice)
  const [dc, setDc] = useState(challan)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await setSupplierDocumentRefs(target, { supplier_invoice_number: inv.trim() || null, supplier_challan_number: dc.trim() || null })
      onSaved(r.changed ? `Supplier references of ${documentLabel} saved.` : 'No changes to save.')
    } catch (e) {
      setError(describeDataError(e))
      setBusy(false)
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Supplier references — {documentLabel}</DialogTitle>
          <DialogDescription>The supplier's own invoice and challan numbers. {documentLabel} stays the Alton document number. Leave a field blank to clear it.</DialogDescription>
        </DialogHeader>
        <form noValidate className="space-y-3" onSubmit={(e) => { e.preventDefault(); void save() }}>
          {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
          <div className="space-y-1.5"><Label htmlFor="ref-invoice">Supplier invoice no.</Label><Input id="ref-invoice" autoFocus maxLength={100} autoComplete="off" value={inv} onChange={(e) => setInv(e.target.value)} /></div>
          <div className="space-y-1.5"><Label htmlFor="ref-challan">Supplier challan no.</Label><Input id="ref-challan" maxLength={100} autoComplete="off" value={dc} onChange={(e) => setDc(e.target.value)} /></div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button type="submit" disabled={busy}>{busy && <Loader2 className="animate-spin" />} Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
