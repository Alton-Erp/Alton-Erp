import { useState } from 'react'

import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { recentFinancialYears } from '@/features/billing/billing-model'
import { CustomerSelect } from '@/features/billing/billing-pickers'
import { useAsync } from '@/hooks/use-async'
import { fetchBillingSettings } from '@/services/billing'

/** Financial-year (or custom date range) and customer filter shared by billing reports. */
export function usePeriodFilter() {
  const settings = useAsync(fetchBillingSettings, [])
  const years = recentFinancialYears(6, settings.data?.fy_start_month ?? 4)
  const [fy, setFy] = useState('0')
  const [custom, setCustom] = useState({ from: years[0].from, to: years[0].to })
  const [customer, setCustomer] = useState('all')
  const year = fy === 'custom' ? null : years[Number(fy)]
  const from = year?.from ?? custom.from
  const to = year?.to ?? custom.to

  const controls = (
    <>
      <div className="space-y-1"><Label htmlFor="pf-fy">Period</Label>
        <Select value={fy} onValueChange={(v) => { if (v === 'custom') setCustom({ from, to }); setFy(v) }}>
          <SelectTrigger id="pf-fy" className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>{years.map((y, i) => <SelectItem key={y.label} value={String(i)}>FY {y.label}{i === 0 ? ' (current)' : ''}</SelectItem>)}<SelectItem value="custom">Custom dates</SelectItem></SelectContent>
        </Select></div>
      {fy === 'custom' && <>
        <div className="space-y-1"><Label htmlFor="pf-from">From</Label><Input id="pf-from" type="date" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} /></div>
        <div className="space-y-1"><Label htmlFor="pf-to">To</Label><Input id="pf-to" type="date" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} /></div>
      </>}
      <div className="space-y-1"><Label htmlFor="pf-cust">Customer</Label><CustomerSelect id="pf-cust" value={customer} onChange={setCustomer} allowAll /></div>
    </>
  )
  return { from, to, customerId: customer === 'all' ? null : customer, valid: Boolean(from && to && from <= to), controls }
}
