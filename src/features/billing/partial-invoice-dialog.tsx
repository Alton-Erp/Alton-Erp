import { AlertTriangle } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'

/**
 * Shown before posting an invoice that covers less than the remaining sales-order
 * quantity. Posting needs an explicit "Continue with Partial Invoice".
 */
export function PartialInvoiceDialog({ warnings, onContinue, onBack }: { warnings: string[] | null; onContinue: () => void; onBack: () => void }) {
  return (
    <Dialog open={Boolean(warnings)} onOpenChange={(o) => { if (!o) onBack() }}>
      <DialogContent data-testid="partial-invoice-warning">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><AlertTriangle className="size-5 text-amber-600" aria-hidden /> Partial Invoice Warning</DialogTitle>
          <DialogDescription>This invoice covers only part of the sales order. Super Admins are notified when it is posted.</DialogDescription>
        </DialogHeader>
        <ul className="space-y-2 text-sm">
          {(warnings ?? []).map((w) => <li key={w} className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900">{w}</li>)}
        </ul>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onBack}>Go Back</Button>
          <Button type="button" onClick={onContinue}>Continue with Partial Invoice</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
