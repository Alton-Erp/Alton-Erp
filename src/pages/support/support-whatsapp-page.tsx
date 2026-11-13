import { MessageSquarePlus } from 'lucide-react'
import { useState } from 'react'

import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { useUrlParam } from '@/features/drilldown/use-drill'
import { PresenceControl } from '@/features/support/support-components'
import { InboxView } from '@/features/support/inbox-view'
import { WA_SETUP_META } from '@/features/support/support-model'
import { WaTemplateDialog } from '@/features/support/whatsapp-components'
import { useAsync } from '@/hooks/use-async'
import { fetchWaStatus } from '@/services/whatsapp'

/** /support/whatsapp — WhatsApp (Meta Cloud API) conversations; new conversations start with an approved template. */
export default function SupportWhatsAppPage() {
  const status = useAsync(() => fetchWaStatus().catch(() => null), [])
  const [, setSelected] = useUrlParam('c', '')
  const [open, setOpen] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const s = status.data
  const meta = WA_SETUP_META[s?.setup_state ?? 'NOT_CONFIGURED']
  return (
    <>
      <PageHeader actions={<div className="flex items-center gap-2">
        {s && <span title={meta.hint} data-testid="wa-setup-state"><StatusBadge label={s.enabled ? 'WhatsApp on' : `WhatsApp: ${meta.label}`} tone={s.enabled ? 'success' : meta.tone} /></span>}
        {s?.can_send && <Button size="sm" onClick={() => setOpen(true)} data-testid="wa-start"><MessageSquarePlus /> Start conversation</Button>}
        <PresenceControl />
      </div>} />
      <InboxView key={refresh} channel="WHATSAPP" />
      {open && <WaTemplateDialog onClose={() => setOpen(false)} onSent={(r) => { setOpen(false); setRefresh((n) => n + 1); setSelected(r.conversation_id) }} />}
    </>
  )
}
