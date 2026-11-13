import { PageHeader } from '@/components/common/page-header'
import { FilterTabs } from '@/components/common/filter-tabs'
import { useUrlParam } from '@/features/drilldown/use-drill'
import { CallLog } from '@/features/support/call-log'
import { InboxView } from '@/features/support/inbox-view'
import { PresenceControl } from '@/features/support/support-components'

/** /support/calls — phone conversations and the call log (Acefone calls with their status, durations and recordings). */
export default function SupportCallsPage() {
  const [tab, setTab] = useUrlParam('tab', 'log')
  const t = tab === 'conversations' ? 'conversations' : 'log'
  return (
    <>
      <PageHeader actions={<PresenceControl />} />
      <FilterTabs<'log' | 'conversations'> label="Calls view" value={t} onChange={setTab} className="mb-4"
        options={[{ value: 'log', label: 'Call log' }, { value: 'conversations', label: 'Phone conversations' }]} />
      {t === 'log' ? <CallLog /> : <InboxView channel="PHONE" />}
    </>
  )
}
