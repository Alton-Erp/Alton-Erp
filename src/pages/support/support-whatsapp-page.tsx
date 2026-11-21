import { Lock } from 'lucide-react'
import { useEffect, useState } from 'react'

import { useReloadOnChange, useSupportLive } from '@/features/support/live/use-support-live'
import { LogConversationDialog } from '@/features/support/support-dialogs'
import { useSupportPermissions } from '@/features/support/use-support-permissions'
import { WaTemplateDialog } from '@/features/support/whatsapp-components'
import { ChatWorkspace } from '@/features/support/wa-web/chat-workspace'
import { ConversationList } from '@/features/support/wa-web/conversation-list'
import { usePolled } from '@/features/support/wa-web/use-polled'
import { WA_FILTERS, WA_MORE_FILTERS } from '@/features/support/wa-web/wa-web-model'
import { useUrlParam } from '@/features/drilldown/use-drill'
import { useAsync } from '@/hooks/use-async'
import { cn } from '@/lib/utils'
import { fetchWaInbox, fetchWaStatus, type WaInboxView } from '@/services/whatsapp'

const PAGE = 30
const VIEWS = [...WA_FILTERS.map((f) => f.value), ...WA_MORE_FILTERS.map((f) => f.value)].filter((v) => v !== 'GROUPS') as WaInboxView[]

/**
 * /support/whatsapp — WhatsApp Web-style support screen: conversations | chat | contact & ticket drawer.
 * Desktop: three panels; tablet: list + chat with the drawer over the chat; phone: list, then the chat full screen.
 * Uses the existing support and WhatsApp functions; new conversations start with an approved template.
 */
export default function SupportWhatsAppPage() {
  const perms = useSupportPermissions()
  const status = useAsync(() => fetchWaStatus().catch(() => null), [])
  const [viewParam, setView] = useUrlParam('view', 'ALL')
  const [selected, setSelected] = useUrlParam('c', '')
  const view = (VIEWS.includes(viewParam as WaInboxView) ? viewParam : 'ALL') as WaInboxView
  const [search, setSearch] = useState('')
  const [term, setTerm] = useState('')
  const [limit, setLimit] = useState(PAGE)
  const [startOpen, setStartOpen] = useState(false)
  const [logOpen, setLogOpen] = useState(false)
  const [infoOpen, setInfoOpen] = useState(() => typeof window !== 'undefined' && window.matchMedia?.('(min-width: 1280px)').matches === true)
  useEffect(() => { const t = setTimeout(() => { setTerm(search); setLimit(PAGE) }, 300); return () => clearTimeout(t) }, [search])
  const list = usePolled(() => fetchWaInbox(view, { search: term, limit, offset: 0 }), [view, term, limit], 30_000)
  // New messages and read changes: reloaded in place when the WhatsApp change stamp moves (Realtime / 3 s check).
  const live = useSupportLive()
  useReloadOnChange(live.summary?.stamps.whatsapp, list.reload)
  const s = status.data

  return (
    <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden border-[#E9EDEF] bg-[#F0F2F5] text-[#111B21]" data-testid="wa-web">
      <div className={cn('flex min-h-0 w-full shrink-0 flex-col border-r border-[#E9EDEF] md:w-[340px] lg:w-[380px]', selected && 'hidden md:flex')}>
        <ConversationList page={list.data} loading={list.loading} error={list.error} view={view} setView={(v) => { if (v !== 'GROUPS') { setView(v); setLimit(PAGE) } }}
          search={search} setSearch={setSearch} selected={selected} onOpen={setSelected} onChanged={list.reload} onMore={() => setLimit((n) => Math.min(n + PAGE, 200))}
          status={s ?? null} canStart={Boolean(s?.can_send)} onStart={() => setStartOpen(true)} onLog={perms.reply ? () => setLogOpen(true) : null} />
      </div>
      {selected ? (
        <div className="flex min-h-0 min-w-0 flex-1 max-md:fixed max-md:inset-0 max-md:z-40 max-md:bg-[#EFEAE2]">
          <ChatWorkspace key={selected} id={selected} infoOpen={infoOpen} setInfoOpen={setInfoOpen} onBack={() => setSelected('')} onChanged={list.reload} />
        </div>
      ) : (
        <div className="hidden flex-1 flex-col items-center justify-center gap-4 border-b-[6px] border-[#25D366] px-8 text-center md:flex" data-testid="wa-empty">
          <h2 className="text-3xl font-light text-[#41525D]">Alton Support on WhatsApp</h2>
          <p className="max-w-md text-sm text-[#667781]">Select a conversation to reply, create or link a ticket, and see the customer’s ERP history. Customers start conversations; you can start one with an approved template.</p>
          <p className="flex items-center gap-1.5 text-xs text-[#8696A0]"><Lock className="size-3.5" />Access tokens stay on the server; internal notes are never sent to customers.</p>
        </div>
      )}
      {startOpen && <WaTemplateDialog onClose={() => setStartOpen(false)} onSent={(r) => { setStartOpen(false); list.reload(); setSelected(r.conversation_id) }} />}
      <LogConversationDialog open={logOpen} onOpenChange={setLogOpen} defaultChannel="WHATSAPP" onCreated={(r) => { list.reload(); setSelected(r.id) }} />
    </div>
  )
}
