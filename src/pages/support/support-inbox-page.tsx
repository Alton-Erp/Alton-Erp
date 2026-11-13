import { PageHeader } from '@/components/common/page-header'
import { PresenceControl } from '@/features/support/support-components'
import { InboxView } from '@/features/support/inbox-view'

/** /support/inbox — phone, WhatsApp and email conversations in one place. */
export default function SupportInboxPage() {
  return (
    <>
      <PageHeader actions={<PresenceControl />} />
      <InboxView />
    </>
  )
}
