import { useState } from 'react'

import { PageHeader } from '@/components/common/page-header'
import { Card, CardContent } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { INVOICE_STATUS_LABELS, NOTE_STATUS_LABELS } from '@/features/billing/billing-model'
import { REPORTS } from '@/features/billing/billing-report-defs'
import { BillingReportView } from '@/features/billing/billing-report-view'
import { usePeriodFilter } from '@/features/billing/period-filter'
import type { BillingReportKey } from '@/services/billing'

export default function BillingReportsPage() {
  const p = usePeriodFilter()
  const [report, setReport] = useState<BillingReportKey>('INVOICES')
  const [status, setStatus] = useState('all')
  const def = REPORTS[report]
  return (
    <>
      <PageHeader />
      <Card className="mb-4">
        <CardContent className="flex flex-wrap items-end gap-3 p-4">
          <div className="space-y-1"><Label htmlFor="br-report">Report</Label>
            <Select value={report} onValueChange={(v) => { setReport(v as BillingReportKey); setStatus('all') }}>
              <SelectTrigger id="br-report" className="w-72"><SelectValue /></SelectTrigger>
              <SelectContent>{(Object.keys(REPORTS) as BillingReportKey[]).map((k) => <SelectItem key={k} value={k}>{REPORTS[k].title}</SelectItem>)}</SelectContent>
            </Select></div>
          {p.controls}
          {def.statuses && (
            <div className="space-y-1"><Label htmlFor="br-status">Status</Label>
              <Select value={status} onValueChange={setStatus}><SelectTrigger id="br-status" className="w-40"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="all">All</SelectItem>{def.statuses.map((s) => <SelectItem key={s} value={s}>{INVOICE_STATUS_LABELS[s] ?? NOTE_STATUS_LABELS[s] ?? s}</SelectItem>)}</SelectContent></Select></div>
          )}
          <p className="basis-full text-xs text-muted-foreground">All figures are read from issued documents and recorded receipts in the database. Drafts and discarded drafts are never included. Receipts are as entered by users and are not bank-verified.</p>
        </CardContent>
      </Card>
      {!p.valid ? <p className="text-sm text-shortage">Choose a valid date range.</p>
        : <BillingReportView report={report} from={p.from} to={p.to} customerId={p.customerId} status={status === 'all' ? null : status} />}
    </>
  )
}
