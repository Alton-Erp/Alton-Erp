import { Loader2 } from 'lucide-react'

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { WaTicks } from '@/features/support/wa-web/wa-ui'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import { fetchWaMessageInfo, type WaMessage } from '@/services/whatsapp'

const RECEIPT_LABEL: Record<string, string> = { SENT: 'Sent', DELIVERED: 'Delivered', READ: 'Read', PLAYED: 'Played', FAILED: 'Failed' }

/** Message info: the times Meta reported. Nothing is inferred: a receipt Meta did not send is shown as "not reported". */
export function MessageInfoDialog({ m, timezone, onClose }: { m: WaMessage; timezone?: string; onClose: () => void }) {
  const info = useAsync(() => fetchWaMessageInfo(m.id), [m.id])
  const receipts = info.data?.receipts ?? []
  const at = (s: string) => receipts.find((r) => r.status === s)?.at ?? null
  const rows: [string, string | null][] = m.direction === 'INBOUND' ? [['Received', m.at]] : [
    ['Created in the ERP', m.at],
    ['Sent', at('SENT')],
    ['Delivered', at('DELIVERED')],
    ['Read', at('READ') ?? at('PLAYED')],
  ]
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-md" data-testid="wa-message-info">
        <DialogHeader>
          <DialogTitle>Message info</DialogTitle>
          <DialogDescription>{m.direction === 'INBOUND' ? 'Received from the customer through WhatsApp.' : 'Times come from Meta’s status webhooks only; a step Meta has not reported is not shown as done.'}</DialogDescription>
        </DialogHeader>
        <div className="rounded-lg bg-[#EFEAE2] p-3">
          <div className={`${m.direction === 'INBOUND' ? 'mr-auto bg-white' : 'ml-auto bg-[#D9FDD3]'} max-w-[90%] rounded-lg px-2 py-1.5 text-sm whitespace-pre-wrap shadow-sm`}>{m.body}
            <span className="float-right ml-2 mt-1 flex items-center gap-1 text-[11px] text-[#667781]"><WaTicks direction={m.direction} status={m.status} waMessageId={m.wa_message_id} errorTitle={m.error_title} /></span>
            <span className="clear-both block" /></div>
        </div>
        {info.loading ? <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Loading receipts…</p>
          : info.error ? <p role="alert" className="text-sm text-red-700">{describeDataError(info.error)}</p> : (
          <dl className="divide-y text-sm">
            {rows.map(([label, value]) => (
              <div key={label} className="flex justify-between gap-4 py-2"><dt className="text-muted-foreground">{label}</dt>
                <dd data-testid={`wa-info-${label.toLowerCase().split(' ')[0]}`}>{value ? formatDateTime(value, timezone) : <span className="text-muted-foreground">Not reported</span>}</dd></div>
            ))}
            {m.direction === 'OUTBOUND' && (
              <div className="flex justify-between gap-4 py-2"><dt className="text-muted-foreground">Accepted by Meta</dt><dd>{m.wa_message_id ? 'Yes' : 'Not yet'}</dd></div>
            )}
            {m.status === 'FAILED' && (
              <div className="py-2 text-red-700"><dt className="font-medium">Failed</dt>
                <dd>{m.error_title ?? 'Failed'}{m.error_code ? ` (${m.error_code})` : ''}{m.error_detail ? `: ${m.error_detail}` : ''}{at('FAILED') ? ` · ${formatDateTime(at('FAILED')!, timezone)}` : ''}</dd></div>
            )}
            {info.data === null && <div className="py-2 text-xs text-muted-foreground">Receipt times need migration 20261221090000; the current status is shown.</div>}
            {receipts.length > 0 && <div className="py-2 text-xs text-muted-foreground">Reported by Meta: {receipts.map((r) => RECEIPT_LABEL[r.status] ?? r.status).join(', ')}.</div>}
          </dl>
        )}
      </DialogContent>
    </Dialog>
  )
}
