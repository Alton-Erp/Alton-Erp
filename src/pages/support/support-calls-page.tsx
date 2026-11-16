import { PageHeader } from '@/components/common/page-header'
import { FilterTabs } from '@/components/common/filter-tabs'
import { useUrlParam } from '@/features/drilldown/use-drill'
import { CallAnalyticsView } from '@/features/support/call-analytics'
import { CallLog } from '@/features/support/call-log'
import { SoftphoneWidget } from '@/features/support/phone-components'
import { InboxView } from '@/features/support/inbox-view'
import { PresenceControl } from '@/features/support/support-components'
import { useSupportPermissions } from '@/features/support/use-support-permissions'

/** /support/calls — phone conversations and the call log (Acefone calls with their status, durations and recordings). */
export default function SupportCallsPage() {
  const perms = useSupportPermissions()
  const [tab, setTab] = useUrlParam('tab', 'log')
  const t = tab === 'conversations' ? 'conversations' : tab === 'analytics' ? 'analytics' : 'log'
  return (
    <>
      <PageHeader actions={<div className="flex flex-wrap items-center gap-2"><SoftphoneWidget /><PresenceControl /></div>} />
      <FilterTabs<'log' | 'conversations' | 'analytics'> label="Calls view" value={t} onChange={setTab} className="mb-4"
        options={[{ value: 'log', label: 'Call log' }, { value: 'conversations', label: 'Phone conversations' }, ...(perms.reports ? [{ value: 'analytics' as const, label: 'Analytics' }] : [])]} />
      {t === 'log' ? <CallLog /> : t === 'analytics' && perms.reports ? <CallAnalyticsView /> : t === 'analytics' ? <p className="text-sm text-muted-foreground">Call analytics need support report access.</p> : <InboxView channel="PHONE" />}
    </>
  )
}
