import { MailPlus } from 'lucide-react'
import { useState } from 'react'

import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { useUrlParam } from '@/features/drilldown/use-drill'
import { EmailComposeDialog } from '@/features/support/email-components'
import { PresenceControl } from '@/features/support/support-components'
import { InboxView } from '@/features/support/inbox-view'
import { useSupportPermissions } from '@/features/support/use-support-permissions'

/** /support/emails — the shared support mailbox (Gmail): email conversations, the channel status and New email. */
export default function SupportEmailsPage() {
  const perms = useSupportPermissions()
  const [, setSelected] = useUrlParam('c', '')
  const [open, setOpen] = useState(false)
  const [refresh, setRefresh] = useState(0)
  return (
    <>
      <PageHeader actions={<div className="flex items-center gap-2">
        {perms.reply && <Button size="sm" onClick={() => setOpen(true)} data-testid="new-email"><MailPlus /> New email</Button>}
        <PresenceControl />
      </div>} />
      <InboxView key={refresh} channel="EMAIL" />
      {open && <EmailComposeDialog target={{ mode: 'NEW' }} onClose={() => setOpen(false)}
        onSent={(r) => { setRefresh((n) => n + 1); setSelected(r.conversation_id) }} />}
    </>
  )
}
