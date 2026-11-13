import { FilePen, Lock, Mail, MessageCircle, Paperclip, PhoneCall, PhoneIncoming, PhoneMissed, PhoneOutgoing, StickyNote, UserRoundCheck, type LucideIcon } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'

import { useAuth } from '@/auth/use-auth'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  CALL_STATUS_LABELS, CHANNEL_LABELS, CONVERSATION_STATUS_META, PRESENCES, PRESENCE_META, PRIORITY_META, SLA_META, TICKET_EVENT_LABELS, TICKET_STATUS_META,
  formatDuration, integrationMeta, type Channel, type ConversationStatus, type Presence, type Priority, type TicketChannel, type TicketStatus,
} from '@/features/support/support-model'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { attachmentUrl, fetchAgents, setPresence, type Agent, type ChannelHealth, type TimelineItem } from '@/services/support'

const CHANNEL_ICONS: Record<TicketChannel, LucideIcon> = { PHONE: PhoneCall, WHATSAPP: MessageCircle, EMAIL: Mail, MANUAL: FilePen }

export function ChannelIcon({ channel, className }: { channel: TicketChannel; className?: string }) {
  const Icon = CHANNEL_ICONS[channel] ?? FilePen
  return <Icon aria-label={CHANNEL_LABELS[channel]} role="img" className={cn('size-4 shrink-0 text-muted-foreground', className)} />
}

export function ChannelLabel({ channel }: { channel: TicketChannel }) {
  return <span className="inline-flex items-center gap-1.5 text-sm"><ChannelIcon channel={channel} />{CHANNEL_LABELS[channel] ?? channel}</span>
}

export const PriorityBadge = ({ priority }: { priority: Priority }) => <StatusBadge label={PRIORITY_META[priority]?.label ?? priority} tone={PRIORITY_META[priority]?.tone} />
export const TicketStatusBadge = ({ status }: { status: TicketStatus }) => <StatusBadge label={TICKET_STATUS_META[status]?.label ?? status} tone={TICKET_STATUS_META[status]?.tone} />
export const ConversationStatusBadge = ({ status }: { status: ConversationStatus }) =>
  <StatusBadge label={CONVERSATION_STATUS_META[status]?.label ?? status} tone={CONVERSATION_STATUS_META[status]?.tone} />
export function SlaBadge({ status }: { status: string }) {
  const m = SLA_META[status] ?? SLA_META.NO_SLA
  return <span title={m.hint}><StatusBadge label={m.label} tone={m.tone} /></span>
}

/** Channel health exactly as the server reports it; never derived in the app. */
export function IntegrationBadge({ status, testId }: { status: string | null | undefined; testId?: string }) {
  const m = integrationMeta(status)
  return <span title={m.hint} data-testid={testId} data-status={status ?? 'NOT_CONNECTED'}><StatusBadge label={m.label} tone={m.tone} /></span>
}

export function ChannelStatusStrip({ channels, only }: { channels: ChannelHealth[] | undefined; only?: Channel }) {
  const list = (channels ?? []).filter((c) => !only || c.channel === only)
  if (!list.length) return null
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border bg-card px-4 py-2.5 text-sm" data-testid="channel-status">
      <span className="text-xs font-medium text-muted-foreground">Channels</span>
      {list.map((c) => (
        <span key={c.channel} className="inline-flex items-center gap-2"><ChannelIcon channel={c.channel} />{CHANNEL_LABELS[c.channel]}
          <IntegrationBadge status={c.status} testId={`channel-${c.channel}`} /></span>
      ))}
    </div>
  )
}

export function Field({ label, htmlFor, error, hint, children, className }: { label: string; htmlFor?: string; error?: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn('space-y-1', className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {error ? <p className="text-xs text-red-700" role="alert">{error}</p> : hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

export function AgentSelect({ agents, value, onChange, disabled, id, allowNone = true }: {
  agents: Agent[]; value: string | null; onChange: (v: string | null) => void; disabled?: boolean; id?: string; allowNone?: boolean
}) {
  return (
    <Select value={value ?? 'none'} onValueChange={(v) => onChange(v === 'none' ? null : v)} disabled={disabled}>
      <SelectTrigger id={id} aria-label="Assigned agent" className="w-full"><SelectValue /></SelectTrigger>
      <SelectContent>
        {allowNone && <SelectItem value="none">Unassigned</SelectItem>}
        {agents.filter((a) => a.is_active || a.id === value).map((a) => (
          <SelectItem key={a.id} value={a.id}>{a.display_name}{a.is_active ? ` · ${PRESENCE_META[a.presence].label}` : ' (inactive)'}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** Agent presence for the signed-in user (Available, Busy, Away, Offline) and a link to their workspace. */
export function PresenceControl({ compact = false }: { compact?: boolean }) {
  const { user } = useAuth()
  const [refresh, setRefresh] = useState(0)
  const agents = useAsync(fetchAgents, [refresh])
  const me = (agents.data ?? []).find((a) => a.user_id === user?.id) ?? null
  const [error, setError] = useState<string | null>(null)
  if (agents.loading && !agents.data) return null
  if (!me || !me.is_active) {
    return compact ? null : <span className="text-xs text-muted-foreground" data-testid="presence-none">Not set up as a support agent</span>
  }
  return (
    <div className="flex items-center gap-2" data-testid="presence-control">
      <Select value={me.presence} onValueChange={(v) => { setError(null); setPresence(v as Presence).then(() => setRefresh((n) => n + 1), (e) => setError(describeDataError(e))) }}>
        <SelectTrigger aria-label="My presence" className="h-9 w-36">
          <span className="inline-flex items-center gap-2"><span aria-hidden className={cn('size-2 rounded-full', PRESENCE_META[me.presence].dot)} /><SelectValue /></span>
        </SelectTrigger>
        <SelectContent>{PRESENCES.map((p) => <SelectItem key={p} value={p}>{PRESENCE_META[p].label}</SelectItem>)}</SelectContent>
      </Select>
      {!compact && <Button variant="outline" size="sm" asChild><Link to="/support/workspace"><UserRoundCheck /> My workspace</Link></Button>}
      {error && <span className="text-xs text-red-700" role="alert">{error}</span>}
    </div>
  )
}

function AttachmentLink({ item }: { item: TimelineItem }) {
  const [error, setError] = useState<string | null>(null)
  if (item.restricted || !item.storage_path) {
    return <span className="inline-flex items-center gap-1 text-muted-foreground"><Lock className="size-3.5" />{item.is_recording ? 'Call recording' : item.file_name} — restricted</span>
  }
  return (
    <>
      <button type="button" className="inline-flex items-center gap-1 text-primary hover:underline"
        onClick={() => { setError(null); attachmentUrl(item.storage_path!).then((u) => window.open(u, '_blank', 'noopener'), (e) => setError(describeDataError(e))) }}>
        <Paperclip className="size-3.5" />{item.file_name}{item.is_sensitive ? ' (sensitive)' : ''}
      </button>
      {error && <span className="ml-2 text-xs text-red-700">{error}</span>}
    </>
  )
}

/** Chronological conversation / ticket timeline: messages, calls, emails, attachments, internal notes and ticket events. */
export function Timeline({ items: all, timezone, hideIds }: { items: TimelineItem[]; timezone?: string; hideIds?: Set<string> }) {
  // hideIds: entries shown elsewhere (e.g. emails and their attachments in the email thread).
  const items = hideIds ? all.filter((e) => !hideIds.has(e.id)) : all
  if (!items.length) return <p className="py-6 text-center text-sm text-muted-foreground">Nothing has happened in this conversation yet.</p>
  return (
    <ol className="space-y-3" data-testid="timeline">
      {items.map((e) => {
        const when = <time className="text-[11px] text-muted-foreground">{formatDateTime(e.at, timezone)}</time>
        if (e.type === 'event') {
          return <li key={e.id} className="text-center text-xs text-muted-foreground" data-kind="event">{TICKET_EVENT_LABELS[e.event_type ?? ''] ?? e.event_type}
            {e.from || e.to ? ` · ${[e.from, e.to].filter(Boolean).join(' → ')}` : ''}{e.author ? ` · ${e.author}` : ''} · {formatDateTime(e.at, timezone)}</li>
        }
        if (e.type === 'note') {
          return <li key={e.id} className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm" data-kind="note">
            <p className="mb-1 flex items-center gap-1.5 text-xs font-medium text-amber-900"><StickyNote className="size-3.5" />Internal note · {e.author ?? 'Agent'} · {when}</p>
            <p className="whitespace-pre-wrap text-amber-950">{e.body}</p></li>
        }
        if (e.type === 'attachment') {
          return <li key={e.id} className="text-sm" data-kind="attachment"><AttachmentLink item={e} /> <span className="ml-2">{when}</span></li>
        }
        const inbound = e.direction === 'INBOUND'
        const CallIcon = e.call_status === 'MISSED' ? PhoneMissed : inbound ? PhoneIncoming : PhoneOutgoing
        return (
          <li key={e.id} className={cn('flex', inbound ? 'justify-start' : 'justify-end')} data-kind={e.type}>
            <div className={cn('max-w-[85%] rounded-lg border px-3 py-2 text-sm', inbound ? 'bg-card' : 'border-blue-200 bg-blue-50')}>
              <p className="mb-1 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{inbound ? 'Customer' : e.author ?? 'Agent'}</span>
                {when}
                {e.source === 'MANUAL' && <span className="rounded bg-muted px-1.5 py-0.5" title="Recorded by an agent; not received or sent through a connected channel">logged manually</span>}
                {e.delivery_status && <span className="rounded bg-muted px-1.5 py-0.5" title="Delivery status reported by the channel">{e.delivery_status.toLowerCase()}</span>}
              </p>
              {e.type === 'call' && (
                <p className="flex items-center gap-1.5 font-medium"><CallIcon className={cn('size-4', e.call_status === 'MISSED' && 'text-red-600')} />
                  {inbound ? 'Incoming' : 'Outgoing'} call · {CALL_STATUS_LABELS[e.call_status ?? ''] ?? e.call_status}{e.duration_seconds ? ` · ${formatDuration(e.duration_seconds)}` : ''}</p>
              )}
              {e.type === 'email' && e.email_subject && <p className="font-medium">{e.email_subject}</p>}
              {e.body && <p className="whitespace-pre-wrap">{e.body}</p>}
            </div>
          </li>
        )
      })}
    </ol>
  )
}

/** Small card of label / value pairs. */
export function InfoList({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="grid gap-x-4 gap-y-3 text-sm sm:grid-cols-2">
      {items.map(([k, v]) => (
        <div key={k} className="min-w-0"><dt className="text-xs font-medium text-muted-foreground">{k}</dt><dd className="mt-0.5 break-words">{v ?? '—'}</dd></div>
      ))}
    </dl>
  )
}
