import { ArrowLeft } from 'lucide-react'
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import { usePermissions } from '@/auth/use-permissions'
import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { SOURCE_LABELS, SOURCE_TYPE_LABELS, formatAmount, lineTotals, sourceLink, type SourceType } from '@/features/accounting/accounting-model'
import { AccountingNotice, Field, VoucherStatusBadge } from '@/features/accounting/accounting-ui'
import { ActionDialog, type ActionRequest } from '@/features/production/action-dialog'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDate, formatDateTime } from '@/lib/format'
import { discardVoucher, fetchVoucher, postVoucher, reverseVoucher } from '@/services/accounting'

export default function VoucherDetailPage() {
  const { voucherId = '' } = useParams()
  const { has } = usePermissions()
  const v = useAsync(() => fetchVoucher(voucherId), [voucherId])
  const [action, setAction] = useState<ActionRequest | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const crumbs = [{ label: 'Accounts' }, { label: 'Voucher Register', to: '/accounts/vouchers' }, { label: v.data?.voucher_number ?? 'Voucher' }]
  if (v.loading) return <><PageHeader title="Voucher" breadcrumbs={crumbs} /><LoadingState /></>
  if (v.error) return <><PageHeader title="Voucher" breadcrumbs={crumbs} /><ErrorState message={describeDataError(v.error)} onRetry={v.reload} /></>
  const x = v.data!
  const totals = lineTotals(x.lines)
  const link = sourceLink(x.source_type, x.source_id)
  const done = (m: string) => { setAction(null); setMessage(m); v.reload() }
  const manualDraft = x.status === 'DRAFT' && x.source === 'MANUAL'

  return (
    <>
      <PageHeader title={x.voucher_number ?? `Draft ${x.voucher_type_name}`} description={`${x.voucher_type_name} · ${formatDate(x.voucher_date)} · ${SOURCE_LABELS[x.source]}`}
        breadcrumbs={crumbs} actions={<>
          <Button variant="outline" asChild><Link to="/accounts/vouchers"><ArrowLeft /> Register</Link></Button>
          {manualDraft && x.voucher_type === 'JV' && has('vouchers.create') && <Button variant="outline" asChild><Link to={`/accounts/journals/${x.id}/edit`}>Edit draft</Link></Button>}
          {manualDraft && has('vouchers.post') && <Button disabled={!totals.balanced || (x.issues ?? []).length > 0} onClick={() => setAction({
            title: `Post this ${x.voucher_type_name.toLowerCase()}`,
            description: <>Posting assigns the voucher number and puts {formatAmount(totals.debit)} into the books. A posted voucher can never be edited — only reversed.</>,
            confirmLabel: 'Post voucher', note: 'none',
            run: async () => { const p = await postVoucher(x.id, x.row_version); return `Voucher ${p.voucher_number} posted.` },
          })}>Post</Button>}
          {manualDraft && has('vouchers.create') && <Button variant="outline" className="text-shortage" onClick={() => setAction({
            title: 'Discard this draft', description: 'The draft stays in the register as discarded and never reaches the books.', confirmLabel: 'Discard draft',
            note: 'required', minLength: 3, destructive: true, run: async (n) => { await discardVoucher(x.id, n!); return 'Draft discarded.' },
          })}>Discard</Button>}
          {x.status === 'POSTED' && x.source === 'MANUAL' && has('vouchers.reverse') && <Button variant="outline" className="text-shortage" onClick={() => setAction({
            title: `Reverse ${x.voucher_number}`,
            description: <>A linked reversal voucher with the opposite entries is posted today (REV series). The original stays in the books marked reversed. A reason is required.</>,
            confirmLabel: 'Reverse voucher', note: 'required', minLength: 5, destructive: true,
            run: async (n) => { const r = await reverseVoucher(x.id, n!, null); return `Reversed by ${r.reversal.voucher_number}.` },
          })}>Reverse</Button>}
        </>} />
      <AccountingNotice />
      {message && <p role="status" className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-800">{message}</p>}
      {(x.issues ?? []).length > 0 && (
        <div role="alert" className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900">
          <p className="font-medium">This draft cannot be posted yet:</p>
          <ul className="list-disc pl-5">{x.issues!.map((i, k) => <li key={k}>{i.message}</li>)}</ul>
        </div>
      )}
      <Card className="mb-4">
        <CardContent className="p-4">
          <dl className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
            <Field label="Status"><VoucherStatusBadge status={x.status} /></Field>
            <Field label="Voucher date">{formatDate(x.voucher_date)}</Field>
            <Field label="Financial year">{x.financial_year}</Field>
            <Field label="Reference">{x.reference_number ?? '—'}</Field>
            <Field label="Source document">{x.source_type ? (link ? <Link className="text-primary hover:underline" to={link}>{SOURCE_TYPE_LABELS[x.source_type as SourceType] ?? x.source_type} {x.source_number}</Link>
              : `${SOURCE_TYPE_LABELS[x.source_type as SourceType] ?? x.source_type.replace(/_/g, ' ').toLowerCase()} ${x.source_number ?? ''}`) : '—'}</Field>
            <Field label="Created">{formatDateTime(x.created_at)} · {x.created_by_name ?? 'System'}</Field>
            {x.posted_at && <Field label="Posted">{formatDateTime(x.posted_at)} · {x.posted_by_name ?? 'System'}</Field>}
            {x.reversal_of_voucher_id && <Field label="Reverses"><Link className="text-primary hover:underline" to={`/accounts/vouchers/${x.reversal_of_voucher_id}`}>{x.reversal_of_number}</Link></Field>}
            {x.reversed_by_voucher_id && <Field label="Reversed by"><Link className="text-primary hover:underline" to={`/accounts/vouchers/${x.reversed_by_voucher_id}`}>{x.reversed_by_number}</Link></Field>}
            {x.reversal_reason && <Field label="Reversal reason">{x.reversal_reason}</Field>}
            {x.discard_reason && <Field label="Discard reason">{x.discard_reason}</Field>}
          </dl>
          {x.narration && <p className="mt-3 text-sm">{x.narration}</p>}
        </CardContent>
      </Card>
      <Card className="mb-4">
        <CardHeader><div><CardTitle>Lines</CardTitle><CardDescription>{totals.balanced ? 'Balanced' : `Unbalanced: difference ${formatAmount(Math.abs(totals.difference))}`}</CardDescription></div></CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader><TableRow><TableHead className="w-12">#</TableHead><TableHead>Ledger account</TableHead><TableHead>Party</TableHead><TableHead>Narration</TableHead>
              <TableHead className="text-right">Debit</TableHead><TableHead className="text-right">Credit</TableHead></TableRow></TableHeader>
            <TableBody>{x.lines.map((l) => (
              <TableRow key={l.id}><TableCell>{l.line_no}</TableCell>
                <TableCell><Link className="text-primary hover:underline" to={`/accounts/general-ledger?account=${l.account_id}`}>{l.account_code} {l.account_name}</Link>
                  {(l.allocations ?? []).length > 0 && <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground" data-testid="line-allocations">{l.allocations!.map((x) => (
                    <li key={x.cost_centre_id}>Cost centre {x.cost_centre_code} {x.cost_centre_name}: {formatAmount(x.amount)}</li>))}</ul>}</TableCell>
                <TableCell>{l.party_name ?? '—'}</TableCell><TableCell className="text-sm">{l.narration ?? ''}</TableCell>
                <TableCell className="text-right tabular-nums">{formatAmount(l.debit, true)}</TableCell><TableCell className="text-right tabular-nums">{formatAmount(l.credit, true)}</TableCell></TableRow>
            ))}</TableBody>
            <TableBody><TableRow className="border-t-2 bg-muted/40"><TableCell colSpan={4} className="font-medium">Total</TableCell>
              <TableCell className="text-right font-medium tabular-nums">{formatAmount(totals.debit)}</TableCell><TableCell className="text-right font-medium tabular-nums">{formatAmount(totals.credit)}</TableCell></TableRow></TableBody>
          </Table>
        </CardContent>
      </Card>
      {(x.audit ?? []).length > 0 && (
        <Card>
          <CardHeader><div><CardTitle>Audit history</CardTitle></div></CardHeader>
          <CardContent><ul className="space-y-1 text-sm">{x.audit!.map((a, i) => (
            <li key={i}><span className="text-muted-foreground">{formatDateTime(a.at)}</span> · {a.action.replace('accounting.voucher.', '').replace(/_/g, ' ')} · {a.by ?? 'System'}</li>
          ))}</ul></CardContent>
        </Card>
      )}
      <ActionDialog request={action} onClose={() => setAction(null)} onDone={done} />
    </>
  )
}
