import { BellOff, ChevronDown, Heart, MessageSquarePlus, MoreVertical, Pin, Search, Settings, Ticket, UserRound, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'

import { useAuth } from '@/auth/use-auth'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { PresenceControl } from '@/features/support/support-components'
import { WA_SETUP_META } from '@/features/support/support-model'
import { useSupportPermissions } from '@/features/support/use-support-permissions'
import { IconButton, WaAvatar, WaTicks } from '@/features/support/wa-web/wa-ui'
import { formatWaNumber, listTime, WA_FILTERS, WA_MORE_FILTERS } from '@/features/support/wa-web/wa-web-model'
import { describeDataError } from '@/lib/errors'
import { cn } from '@/lib/utils'
import { assignConversation, markConversationRead } from '@/services/support'
import { setConversationPref, type WaInboxPage, type WaInboxRow, type WaInboxView, type WaSetupState } from '@/services/whatsapp'

function RowSkeleton() {
  return (
    <div className="flex items-center gap-3 px-3 py-3" aria-hidden>
      <Skeleton className="size-[49px] rounded-full" />
      <div className="flex-1 space-y-2"><Skeleton className="h-4 w-2/3" /><Skeleton className="h-3 w-5/6" /></div>
    </div>
  )
}

function Row({ r, active, onOpen, onChanged, onError, me }: {
  r: WaInboxRow; active: boolean; onOpen: () => void; onChanged: () => void; onError: (text: string) => void; me: string | null
}) {
  const { access } = useAuth()
  const perms = useSupportPermissions()
  const [menu, setMenu] = useState(false)
  const name = r.customer_name ?? r.profile_name ?? formatWaNumber(r.phone) ?? 'Unknown contact'
  const number = formatWaNumber(r.wa_id ?? r.phone)
  const pref = (p: { pinned?: boolean; muted?: boolean; favorite?: boolean }) => setConversationPref(r.id, p).then(onChanged, (e) => onError(describeDataError(e)))
  const run = (fn: () => Promise<unknown>) => fn().then(onChanged, (e) => onError(describeDataError(e)))
  const tz = access?.company?.timezone ?? undefined
  return (
    <li className="group relative" onContextMenu={(e) => { e.preventDefault(); setMenu(true) }}>
      <button type="button" onClick={onOpen} aria-current={active ? 'true' : undefined} data-testid={`conversation-${r.id}`} data-wa-row
        className={cn('flex w-full items-center gap-3 px-3 text-left outline-none hover:bg-[#F5F6F6] focus-visible:bg-[#F5F6F6]', active && 'bg-[#F0F2F5] hover:bg-[#F0F2F5]')}>
        <WaAvatar name={name} seed={r.id} />
        <span className="flex min-w-0 flex-1 flex-col border-b border-[#E9EDEF] py-3 pr-1 group-last:border-b-0">
          <span className="flex items-baseline justify-between gap-2">
            <span className="truncate text-[17px] leading-[21px] text-[#111B21]">{name}</span>
            <time className={cn('shrink-0 text-xs', r.unread_count > 0 && !r.muted ? 'font-medium text-[#1FA855]' : 'text-[#667781]')}>{listTime(r.last_activity_at, undefined, tz)}</time>
          </span>
          <span className="mt-0.5 flex items-center gap-1 text-sm text-[#667781] transition-[padding] group-focus-within:pr-7 group-hover:pr-7">
            {r.last_message?.direction === 'OUTBOUND' && <WaTicks direction="OUTBOUND" status={r.last_message.status} className="shrink-0" />}
            <span className="min-w-0 flex-1 truncate">{r.last_message_preview ?? ''}</span>
            {r.muted && <BellOff className="size-4 shrink-0" aria-label="Muted" />}
            {r.pinned && <Pin className="size-4 shrink-0 rotate-45" aria-label="Pinned" />}
            {r.favorite && <Heart className="size-3.5 shrink-0 fill-current" aria-label="Favourite" />}
            {r.unread_count > 0 && <span className={cn('ml-0.5 min-w-5 shrink-0 rounded-full px-1.5 text-center text-xs font-medium leading-5 text-white', r.muted ? 'bg-[#8696A0]' : 'bg-[#25D366]')}
              aria-label={`${r.unread_count} unread`}>{r.unread_count}</span>}
          </span>
          <span className="mt-0.5 flex items-center gap-2 truncate text-xs text-[#667781]">
            {number && number !== name && <span className="truncate">{number}</span>}
            <span className="inline-flex items-center gap-0.5 truncate" title="Assigned agent"><UserRound className="size-3" />{r.assigned_agent ?? 'Unassigned'}</span>
            {r.ticket_number && <span className="inline-flex items-center gap-0.5"><Ticket className="size-3" />{r.ticket_number}</span>}
          </span>
        </span>
      </button>
      <DropdownMenu open={menu} onOpenChange={setMenu}>
        <DropdownMenuTrigger asChild>
          <button type="button" aria-label={`Options for ${name}`} className="absolute right-2 top-9 rounded-full bg-[#F5F6F6] p-0.5 text-[#8696A0] opacity-0 focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100">
            <ChevronDown className="size-5" /></button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem onSelect={() => void pref({ pinned: !r.pinned })}>{r.pinned ? 'Unpin chat' : 'Pin chat'}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void pref({ muted: !r.muted })} title="Muted chats show a grey unread count. ERP notifications are not affected.">{r.muted ? 'Unmute' : 'Mute'}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void pref({ favorite: !r.favorite })}>{r.favorite ? 'Remove from favourites' : 'Add to favourites'}</DropdownMenuItem>
          {r.unread_count > 0 && <DropdownMenuItem onSelect={() => void run(() => markConversationRead(r.id))}>Mark as read</DropdownMenuItem>}
          {perms.assign && me && r.assigned_agent_id !== me && <DropdownMenuItem onSelect={() => void run(() => assignConversation(r.id, me))}>Assign to me</DropdownMenuItem>}
          {r.ticket_id && <><DropdownMenuSeparator /><DropdownMenuItem asChild><Link to={`/support/tickets/${r.ticket_id}`}>Open ticket {r.ticket_number}</Link></DropdownMenuItem></>}
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  )
}

/** Left panel: title and connection, search, filters, conversations (pinned first), context menu per conversation. */
export function ConversationList({ page, loading, error, view, setView, search, setSearch, selected, onOpen, onChanged, onMore, status, canStart, onStart, onLog }: {
  page: WaInboxPage | undefined; loading: boolean; error: Error | null; view: WaInboxView | 'GROUPS'; setView: (v: WaInboxView | 'GROUPS') => void
  search: string; setSearch: (s: string) => void; selected: string; onOpen: (id: string) => void; onChanged: () => void; onMore: () => void
  status: { setup_state: WaSetupState; enabled: boolean; display_phone_number?: string | null } | null; canStart: boolean; onStart: () => void; onLog: (() => void) | null
}) {
  const perms = useSupportPermissions()
  const [rowError, setRowError] = useState<string | null>(null)
  const list = useRef<HTMLUListElement>(null)
  useEffect(() => { if (!rowError) return; const t = setTimeout(() => setRowError(null), 6000); return () => clearTimeout(t) }, [rowError])
  const meta = WA_SETUP_META[status?.setup_state ?? 'NOT_CONFIGURED']
  const connected = Boolean(status?.enabled)
  // Up / down arrows move between conversations.
  const keys = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const rows = [...(list.current?.querySelectorAll<HTMLButtonElement>('button[data-wa-row]') ?? [])]
    const i = rows.indexOf(document.activeElement as HTMLButtonElement)
    if (i < 0) return
    e.preventDefault()
    rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus()
  }
  const more = WA_MORE_FILTERS.find((f) => f.value === view)
  return (
    <div className="flex h-full min-h-0 flex-col bg-white">
      <header className="flex h-[60px] shrink-0 items-center gap-1 px-4">
        <h1 className="flex-1 text-[22px] font-bold text-[#111B21]">WhatsApp</h1>
        <span title={connected ? `Connected${status?.display_phone_number ? ` · ${status.display_phone_number}` : ''}` : meta.hint} data-testid="wa-setup-state"
          className={cn('mr-1 inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs', connected ? 'bg-[#E7F8EE] text-[#0A5C36]' : 'bg-[#FFF4E0] text-[#7A4B00]')}>
          <span className={cn('size-2 rounded-full', connected ? 'bg-[#25D366]' : 'bg-[#F0B330]')} aria-hidden />{connected ? 'WhatsApp on' : `WhatsApp: ${meta.label}`}</span>
        {canStart && <IconButton label="New conversation" tooltip="New conversation (approved template)" onClick={onStart} data-testid="wa-start"><MessageSquarePlus /></IconButton>}
        <DropdownMenu>
          <DropdownMenuTrigger asChild><button type="button" aria-label="Menu" title="Menu" className="inline-flex size-10 items-center justify-center rounded-full text-[#54656F] hover:bg-black/5"><MoreVertical className="size-5" /></button></DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60">
            {onLog && <DropdownMenuItem onSelect={onLog}>Log a conversation</DropdownMenuItem>}
            <DropdownMenuItem asChild><Link to="/support/inbox">Unified inbox</Link></DropdownMenuItem>
            {perms.integrations && <DropdownMenuItem asChild><Link to="/support/settings?tab=whatsapp"><Settings />WhatsApp settings</Link></DropdownMenuItem>}
          </DropdownMenuContent>
        </DropdownMenu>
      </header>
      <div className="flex shrink-0 items-center justify-end px-3 pb-1"><PresenceControl compact /></div>
      <div className="shrink-0 px-3 pb-2">
        <label className="flex items-center gap-3 rounded-lg bg-[#F0F2F5] px-3 py-1.5">
          <Search className="size-4 text-[#54656F]" aria-hidden />
          <input aria-label="Search conversations" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, number, ticket or message"
            className="min-w-0 flex-1 bg-transparent text-sm text-[#111B21] outline-none placeholder:text-[#667781]" data-testid="wa-list-search" />
          {search && <button type="button" aria-label="Clear search" onClick={() => setSearch('')}><X className="size-4 text-[#54656F]" /></button>}
        </label>
      </div>
      <div role="tablist" aria-label="Conversation filter" className="flex shrink-0 flex-wrap gap-1.5 px-3 pb-2">
        {WA_FILTERS.map((f) => {
          const groups = f.value === 'GROUPS'
          const count = !groups && f.value !== 'ALL' ? page?.counts?.[f.value] : undefined
          return (
            <button key={f.value} type="button" role="tab" aria-selected={view === f.value} disabled={groups} data-testid={`wa-filter-${f.value}`}
              title={groups ? 'WhatsApp groups are not connected to the ERP (the Cloud API connector handles one-to-one chats only).' : undefined}
              onClick={() => setView(f.value)}
              className={cn('shrink-0 rounded-full px-2.5 py-1 text-[13px] transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                view === f.value ? 'bg-[#D9FDD3] text-[#008069]' : 'bg-[#F0F2F5] text-[#54656F] hover:bg-[#E9EDEF]')}>
              {f.label}{count ? ` ${count}` : ''}
            </button>
          )
        })}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className={cn('inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-[13px]', more ? 'bg-[#D9FDD3] text-[#008069]' : 'bg-[#F0F2F5] text-[#54656F] hover:bg-[#E9EDEF]')}>
              {more?.label ?? 'More'}<ChevronDown className="size-3.5" /></button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {WA_MORE_FILTERS.map((f) => <DropdownMenuItem key={f.value} onSelect={() => setView(f.value)}>{f.label}{page?.counts?.[f.value] ? ` (${page.counts[f.value]})` : ''}</DropdownMenuItem>)}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {page?.legacy && (view === 'UNREAD' || view === 'FAVORITES') && (
        <p className="mx-3 mb-2 rounded-md bg-[#FFF4E0] px-3 py-2 text-xs text-[#7A4B00]">Unread and Favourites need migration 20261221090000; nothing is guessed until it is applied.</p>
      )}
      {rowError && <p role="alert" className="mx-3 mb-2 rounded-md bg-[#FFE7EA] px-3 py-2 text-xs text-[#B1002A]">{rowError}</p>}
      <div className="min-h-0 flex-1 overflow-y-auto" onKeyDown={keys}>
        {loading && !page ? <>{Array.from({ length: 7 }, (_, i) => <RowSkeleton key={i} />)}</>
          : error && !page ? (
            <div className="p-6 text-center text-sm" role="alert"><p className="text-red-700">{describeDataError(error)}</p>
              <button type="button" onClick={onChanged} className="mt-3 rounded-full bg-[#008069] px-4 py-1.5 font-medium text-white">Try again</button></div>
          ) : !page?.rows.length ? (
            <div className="p-8 text-center text-sm text-[#667781]" data-testid="wa-list-empty">
              {search ? 'No conversation matches the search.' : view === 'UNREAD' ? 'No unread conversations.' : view === 'FAVORITES' ? 'No favourites yet: add one from a conversation’s menu.'
                : view === 'MINE' && !page?.me ? 'You are not set up as a support agent yet.' : 'WhatsApp conversations appear here when customers write to your number.'}
            </div>
          ) : (
            <ul ref={list} data-testid="inbox-list">
              {page.rows.map((r) => <Row key={r.id} r={r} active={selected === r.id} me={page.me} onOpen={() => onOpen(r.id)} onChanged={onChanged} onError={setRowError} />)}
              {page.total > page.rows.length && (
                <li className="p-3 text-center"><button type="button" onClick={onMore} className="text-sm font-medium text-[#008069] hover:underline">Show more ({page.total - page.rows.length} more)</button></li>
              )}
            </ul>
          )}
        {error && page && <p className="px-3 py-2 text-center text-xs text-[#B1002A]">Could not refresh the list; retrying automatically.</p>}
      </div>
    </div>
  )
}
