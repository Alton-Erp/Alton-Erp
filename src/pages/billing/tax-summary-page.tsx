import { Info } from 'lucide-react'

import { PageHeader } from '@/components/common/page-header'
import { Card, CardContent } from '@/components/ui/card'
import { BillingReportView } from '@/features/billing/billing-report-view'
import { usePeriodFilter } from '@/features/billing/period-filter'

export default function TaxSummaryPage() {
  const p = usePeriodFilter()
  return (
    <>
      <PageHeader />
      <p role="note" className="mb-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900">
        <Info className="mt-0.5 size-4 shrink-0" />
        Management summaries of tax recorded on issued invoices and notes in this system. They are not GST returns, have not been filed with any tax portal, and must be reviewed by your accountant or tax adviser before use in any filing.
      </p>
      <Card className="mb-4"><CardContent className="flex flex-wrap items-end gap-3 p-4">{p.controls}</CardContent></Card>
      {!p.valid ? <p className="text-sm text-shortage">Choose a valid date range.</p> : (
        <div className="space-y-6">
          <BillingReportView report="TAX_COMPONENTS" from={p.from} to={p.to} customerId={p.customerId} status={null} compact />
          <BillingReportView report="BY_GST_RATE" from={p.from} to={p.to} customerId={p.customerId} status={null} compact />
          <BillingReportView report="HSN_SUMMARY" from={p.from} to={p.to} customerId={p.customerId} status={null} compact />
        </div>
      )}
    </>
  )
}
