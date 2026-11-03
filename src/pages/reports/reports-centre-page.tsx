import { ArrowRight, FileBarChart } from 'lucide-react'
import { Link } from 'react-router-dom'

import { PageHeader } from '@/components/common/page-header'
import { Card, CardContent } from '@/components/ui/card'
import { REPORTS } from '@/features/management/report-defs'

const GROUPS = ['Products & stock', 'Purchase', 'Production', 'Sales', 'Invoicing & payments'] as const

/** /reports — the reporting centre (Stage 7): 20 reports, each with filters, search, Excel and PDF. */
export default function ReportsCentrePage() {
  return (
    <>
      <PageHeader title="Reports" description="Twenty reports from posted records. Each has date, product and customer / supplier filters where they apply, search, Excel export and a print / PDF view." />
      <div className="space-y-6">
        {GROUPS.map((g) => (
          <section key={g} aria-label={g}>
            <h2 className="mb-2 text-sm font-semibold">{g}</h2>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {REPORTS.filter((r) => r.group === g).map((r) => (
                <Link key={r.key} to={`/reports/view/${r.key.toLowerCase()}`} className="group rounded-xl border bg-card p-4 transition-colors hover:border-primary/50 hover:bg-primary/5">
                  <p className="flex items-center gap-2 font-medium"><FileBarChart className="size-4 text-primary" /> {r.title} <ArrowRight className="ml-auto size-4 opacity-0 transition-opacity group-hover:opacity-100" /></p>
                  <p className="mt-1 text-sm text-muted-foreground">{r.description}</p>
                </Link>
              ))}
            </div>
          </section>
        ))}
        <Card><CardContent className="flex flex-wrap items-center gap-x-4 gap-y-2 p-4 text-sm">
          <span className="text-muted-foreground">More detailed reports in the modules:</span>
          {[['Production reports', '/production/reports'], ['Billing reports', '/billing/reports'],
            ['Customer statements', '/billing/statements'], ['Receivables ageing', '/billing/ageing'], ['GST summary', '/billing/tax-summary']].map(([l, to]) => (
            <Link key={to} to={to} className="text-primary hover:underline">{l}</Link>
          ))}
        </CardContent></Card>
      </div>
    </>
  )
}
