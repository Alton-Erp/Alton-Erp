import {
  Archive, ArchiveRestore, Bookmark, ChevronDown, ChevronLeft, ChevronRight, Clock, FolderInput, Inbox, Mail, MailOpen, OctagonAlert, Paperclip, RefreshCw, ShieldCheck,
  Star, Tag, Trash2, Undo2,
} from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'

import { StatusBadge } from '@/components/common/status-badge'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { AttachmentChip, AttachmentPreview } from '@/features/support/mail/attachment-preview'
import { mailListDate, pageLabel, snoozeChoices, type MailFolder } from '@/features/support/mail/mail-model'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { fetchListAttachments, type MailAttachment, type MailboxAction, type MailboxPage, type MailThreadRow, type RowAttachments } from '@/services/email'
import type { TagRef } from '@/services/support'

export type Act = (ids: string[], action: MailboxAction, p?: { until?: string; label?: string }) => Promise<void>

export function MailIcon({ label, onClick, disabled, children, testId, className }: {
  label: string; onClick?: () => void; disabled?: boolean; children: ReactNode; testId?: string; className?: string
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" aria-label={label} disabled={disabled} data-testid={testId} onClick={(e) => { e.stopPropagation(); onClick?.() }}
          className={cn('inline-flex size-9 shrink-0 items-center justify-center rounded-full text-[#444746] hover:bg-[#1F1F1F]/[0.08] disabled:opacity-40 [&_svg]:size-[18px]', className)}>{children}</button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

/** Snooze menu: Gmail-like choices plus a date and time of your own. */
export function SnoozeMenu({ onPick, trigger }: { onPick: (until: string) => void; trigger: ReactNode }) {
  const [custom, setCustom] = useState('')
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64" onClick={(e) => e.stopPropagation()}>
        <DropdownMenuLabel>Snooze until…</DropdownMenuLabel>
        {snoozeChoices().map((c) => (
          <DropdownMenuItem key={c.key} onSelect={() => onPick(c.at.toISOString())}>
            {c.label}<span className="ml-auto text-xs text-muted-foreground">{formatDateTime(c.at)}</span></DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <div className="flex items-center gap-1 px-2 py-1.5" onKeyDown={(e) => e.stopPropagation()}>
          <input type="datetime-local" aria-label="Pick date and time" value={custom} onChange={(e) => setCustom(e.target.value)} className="min-w-0 flex-1 rounded border px-1 py-0.5 text-xs" />
          <button type="button" disabled={!custom} className="rounded px-2 py-0.5 text-xs font-medium text-[#0B57D0] disabled:opacity-40" onClick={() => onPick(new Date(custom).toISOString())}>Save</button>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function LabelMenu({ labels, onPick, trigger }: { labels: TagRef[]; onPick: (label: string, add: boolean) => void; trigger: ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel>Label as</DropdownMenuLabel>
        {labels.map((l) => <DropdownMenuItem key={`add-${l.id}`} onSelect={() => onPick(l.id, true)}><Tag />{l.name}</DropdownMenuItem>)}
        {labels.length > 0 && <><DropdownMenuSeparator /><DropdownMenuLabel>Remove label</DropdownMenuLabel></>}
        {labels.map((l) => <DropdownMenuItem key={`rm-${l.id}`} onSelect={() => onPick(l.id, false)}>{l.name}</DropdownMenuItem>)}
        {!labels.length && <p className="px-2 py-1.5 text-xs text-muted-foreground">No labels yet: an administrator adds them in Support Settings → Tags.</p>}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Bulk actions for the selected threads (what is offered depends on the folder). */
export function ThreadActions({ ids, folder, rows, labels, act, canEdit, afterMove }: {
  ids: string[]; folder: MailFolder; rows: MailThreadRow[]; labels: TagRef[]; act: Act; canEdit: boolean; afterMove?: () => void
}) {
  if (!ids.length || !canEdit) return null
  const sel = rows.filter((r) => ids.includes(r.id))
  const anyUnread = sel.some((r) => r.unread_count > 0)
  const move = (a: MailboxAction) => void act(ids, a).then(() => afterMove?.())
  return (
    <div className="flex items-center" data-testid="mail-bulk-actions">
      {folder === 'SPAM' ? <MailIcon label="Not spam" onClick={() => move('INBOX')} testId="mail-not-spam"><ShieldCheck /></MailIcon>
        : folder === 'TRASH' ? <MailIcon label="Move to Inbox" onClick={() => move('INBOX')} testId="mail-restore"><Undo2 /></MailIcon>
        : sel.every((r) => r.folder === 'ARCHIVE') ? <MailIcon label="Move to Inbox" onClick={() => move('INBOX')}><ArchiveRestore /></MailIcon>
        : <MailIcon label="Archive" onClick={() => move('ARCHIVE')} testId="mail-archive"><Archive /></MailIcon>}
      {folder !== 'SPAM' && <MailIcon label="Report spam" onClick={() => move('SPAM')} testId="mail-spam"><OctagonAlert /></MailIcon>}
      {folder !== 'TRASH' && <MailIcon label="Delete (move to Trash; history is kept)" onClick={() => move('TRASH')} testId="mail-delete"><Trash2 /></MailIcon>}
      <span className="mx-1 h-5 w-px bg-[#C4C7C5]" aria-hidden />
      {anyUnread ? <MailIcon label="Mark as read" onClick={() => void act(ids, 'MARK_READ')} testId="mail-mark-read"><MailOpen /></MailIcon>
        : <MailIcon label="Mark as unread" onClick={() => void act(ids, 'MARK_UNREAD')} testId="mail-mark-unread"><Mail /></MailIcon>}
      <SnoozeMenu onPick={(until) => void act(ids, 'SNOOZE', { until }).then(() => afterMove?.())}
        trigger={<button type="button" aria-label="Snooze" title="Snooze" className="inline-flex size-9 items-center justify-center rounded-full text-[#444746] hover:bg-[#1F1F1F]/[0.08]" data-testid="mail-snooze"><Clock className="size-[18px]" /></button>} />
      <DropdownMenu>
        <DropdownMenuTrigger asChild><button type="button" aria-label="Move to" title="Move to" className="inline-flex size-9 items-center justify-center rounded-full text-[#444746] hover:bg-[#1F1F1F]/[0.08]"><FolderInput className="size-[18px]" /></button></DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuLabel>Move to</DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => move('INBOX')}><Inbox />Inbox</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => move('ARCHIVE')}><Archive />Archive</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => move('SPAM')}><OctagonAlert />Spam</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => move('TRASH')}><Trash2 />Trash</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <LabelMenu labels={labels} onPick={(label, add) => void act(ids, add ? 'LABEL_ADD' : 'LABEL_REMOVE', { label })}
        trigger={<button type="button" aria-label="Labels" title="Labels" className="inline-flex size-9 items-center justify-center rounded-full text-[#444746] hover:bg-[#1F1F1F]/[0.08]" data-testid="mail-label"><Tag className="size-[18px]" /></button>} />
    </div>
  )
}

const CHIPS = 3

function Row({ r, folder, checked, onCheck, onOpen, act, canEdit, timezone, atts, onPreview }: {
  r: MailThreadRow; folder: MailFolder; checked: boolean; onCheck: () => void; onOpen: () => void; act: Act; canEdit: boolean; timezone?: string
  atts?: RowAttachments; onPreview: (items: MailAttachment[], index: number) => void
}) {
  const unread = r.unread_count > 0
  const who = folder === 'SENT' || !r.from_address
    ? `To: ${r.to.map((t) => t.name || t.email).join(', ') || '—'}`
    : r.senders.length > 1 ? r.senders.slice(-3).map((s) => s.split(/[\s@]/)[0]).join(', ') : r.from_name || r.from_address || 'Unknown sender'
  return (
    <li className={cn('group relative flex cursor-pointer items-start gap-1 border-b border-[#F1F3F4] pr-3 pl-2 text-sm transition-shadow hover:z-[1] hover:shadow-[inset_1px_0_0_#dadce0,inset_-1px_0_0_#dadce0,0_1px_2px_0_rgba(60,64,67,.3),0_1px_3px_1px_rgba(60,64,67,.15)]',
      checked ? 'bg-[#C2DBFF]' : unread ? 'bg-white' : 'bg-[#F2F6FC]')}
      onClick={onOpen} data-testid={`mail-row-${r.id}`} data-unread={unread}>
      <input type="checkbox" aria-label={`Select ${r.subject ?? 'email'}`} checked={checked} onClick={(e) => e.stopPropagation()} onChange={onCheck}
        className="mx-2 mt-3 size-4 shrink-0 cursor-pointer accent-[#0B57D0]" data-testid="mail-row-check" />
      <MailIcon label={r.starred ? 'Starred' : 'Not starred'} disabled={!canEdit} onClick={() => void act([r.id], r.starred ? 'UNSTAR' : 'STAR')} testId="mail-star" className="mt-1 size-8">
        <Star className={r.starred ? 'fill-[#F4B400] text-[#F4B400]' : ''} /></MailIcon>
      <MailIcon label={r.important ? 'Important (click to remove)' : 'Mark as important'} disabled={!canEdit} onClick={() => void act([r.id], r.important ? 'NOT_IMPORTANT' : 'IMPORTANT')}
        testId="mail-important" className="mt-1 hidden size-8 sm:inline-flex"><Bookmark className={r.important ? 'fill-[#F4B400] text-[#F4B400]' : ''} /></MailIcon>
      <div className="flex min-w-0 flex-1 flex-col py-2 sm:flex-row sm:items-start sm:gap-3 sm:py-0">
        <span className={cn('w-full shrink-0 truncate sm:h-10 sm:w-48 sm:leading-10', unread ? 'font-bold text-[#1F1F1F]' : 'text-[#5F6368] sm:text-[#1F1F1F]')}>
          {who}{r.message_count > 1 && <span className="ml-1 text-xs font-normal text-[#5F6368]">{r.message_count}</span>}
          {r.last_direction === 'OUTBOUND' && r.last_send_state && r.last_send_state !== 'SENT' && <span className="ml-1 text-xs font-normal text-[#B3261E]">{r.last_send_state === 'FAILED' ? 'Failed' : 'Sending'}</span>}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-1.5 truncate sm:leading-10">
          {r.labels.map((l) => <span key={l.id} className="shrink-0"><StatusBadge label={l.name} tone={l.color as never} /></span>)}
          {folder !== 'INBOX' && r.folder === 'INBOX' && folder !== 'SENT' && <span className="shrink-0 rounded bg-[#DDE3EA] px-1.5 text-[11px] text-[#444746]">Inbox</span>}
          {r.ticket_number && <span className="shrink-0 rounded bg-[#E8F0FE] px-1.5 text-[11px] text-[#0B57D0]">{r.ticket_number}</span>}
          <span className={cn('max-w-[70%] shrink-0 truncate', unread ? 'font-bold text-[#1F1F1F]' : 'text-[#1F1F1F]')}>{r.subject || '(no subject)'}</span>
          <span className="truncate text-[#5F6368]"> – {r.snippet}</span>
        </span>
        {atts && atts.items.length > 0 && (
          <span className="flex flex-wrap items-center gap-2 pt-1 pb-2 sm:pt-0" data-testid="mail-row-attachments">
            {atts.items.slice(0, CHIPS).map((a, i) => <AttachmentChip key={a.id} a={a} onOpen={() => onPreview(atts.items, i)} />)}
            {atts.count > CHIPS && (
              <button type="button" data-testid="mail-row-attachments-more" aria-label={`${atts.count - CHIPS} more attachments`} title={`${atts.count - CHIPS} more attachment${atts.count - CHIPS > 1 ? 's' : ''}`}
                onClick={(e) => { e.stopPropagation(); if (atts.items.length > CHIPS) onPreview(atts.items, CHIPS); else onOpen() }}
                className="inline-flex h-8 items-center rounded-full border border-[#DADCE0] bg-white px-2.5 text-xs font-medium text-[#3C4043] hover:bg-[#F1F3F4]">+{atts.count - CHIPS}</button>
            )}
          </span>
        )}
        </span>
      </div>
      {r.has_attachment && <Paperclip className="mt-3 size-4 shrink-0 text-[#5F6368]" aria-label="Has attachment" data-testid="mail-has-attachment" />}
      <span className={cn('w-20 shrink-0 text-right text-xs leading-10', canEdit && 'group-hover:hidden group-focus-within:hidden', unread ? 'font-bold text-[#1F1F1F]' : 'text-[#5F6368]')}>
        {r.snoozed_until && folder === 'SNOOZED' ? <span className="text-[#B06000]">{mailListDate(r.snoozed_until, undefined, timezone)}</span> : mailListDate(r.sort_at ?? r.last_at, undefined, timezone)}</span>
      {canEdit && (
        <span className="mt-0.5 hidden shrink-0 items-center group-focus-within:flex group-hover:flex" data-testid="mail-quick-actions">
          {r.folder === 'ARCHIVE' || folder === 'TRASH' || folder === 'SPAM'
            ? <MailIcon label="Move to Inbox" onClick={() => void act([r.id], 'INBOX')}><Inbox /></MailIcon>
            : <MailIcon label="Archive" onClick={() => void act([r.id], 'ARCHIVE')} testId="mail-row-archive"><Archive /></MailIcon>}
          {folder !== 'TRASH' && <MailIcon label="Delete" onClick={() => void act([r.id], 'TRASH')} testId="mail-row-delete"><Trash2 /></MailIcon>}
          {unread ? <MailIcon label="Mark as read" onClick={() => void act([r.id], 'MARK_READ')}><MailOpen /></MailIcon>
            : <MailIcon label="Mark as unread" onClick={() => void act([r.id], 'MARK_UNREAD')} testId="mail-row-unread"><Mail /></MailIcon>}
          <SnoozeMenu onPick={(until) => void act([r.id], 'SNOOZE', { until })}
            trigger={<button type="button" aria-label="Snooze" title="Snooze" onClick={(e) => e.stopPropagation()} className="inline-flex size-9 items-center justify-center rounded-full text-[#444746] hover:bg-[#1F1F1F]/[0.08]"><Clock className="size-[18px]" /></button>} />
        </span>
      )}
    </li>
  )
}

/** Toolbar (select all, refresh, bulk actions, paging) and the thread rows. */
export function MailList({ page, loading, error, folder, selected, setSelected, onOpen, act, canEdit, limit, offset, setOffset, onRefresh, timezone, emptyText }: {
  page: MailboxPage | undefined; loading: boolean; error: Error | null; folder: MailFolder; selected: Set<string>; setSelected: (s: Set<string>) => void
  onOpen: (id: string) => void; act: Act; canEdit: boolean; limit: number; offset: number; setOffset: (n: number) => void; onRefresh: () => void
  timezone?: string; emptyText: string
}) {
  const rows = useMemo(() => page?.rows ?? [], [page])
  const all = rows.length > 0 && rows.every((r) => selected.has(r.id))
  const some = rows.some((r) => selected.has(r.id))
  const pick = (f: (r: MailThreadRow) => boolean) => setSelected(new Set(rows.filter(f).map((r) => r.id)))
  // Attachment chips: one request per page of rows (only those with files); kept while the list refreshes.
  const attIds = useMemo(() => rows.filter((r) => r.has_attachment).map((r) => r.id), [rows])
  const attKey = attIds.join(',')
  const atts = useAsync(() => fetchListAttachments(attIds).catch(() => ({} as Record<string, RowAttachments>)), [attKey])
  const [preview, setPreview] = useState<{ items: MailAttachment[]; index: number } | null>(null)
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-1 px-2" role="toolbar" aria-label="Email actions">
        <span className="inline-flex items-center rounded hover:bg-[#1F1F1F]/[0.08]">
          <input type="checkbox" aria-label={all ? 'Select none' : 'Select all on this page'} checked={all} ref={(el) => { if (el) el.indeterminate = some && !all }}
            onChange={() => (all ? setSelected(new Set()) : pick(() => true))} className="m-2 size-4 cursor-pointer accent-[#0B57D0]" data-testid="mail-select-all" />
          <DropdownMenu>
            <DropdownMenuTrigger asChild><button type="button" aria-label="Select" className="pr-1 text-[#444746]"><ChevronDown className="size-4" /></button></DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onSelect={() => pick(() => true)}>All</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setSelected(new Set())}>None</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => pick((r) => r.unread_count === 0)}>Read</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => pick((r) => r.unread_count > 0)}>Unread</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => pick((r) => r.starred)}>Starred</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => pick((r) => !r.starred)}>Unstarred</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
        {selected.size ? (
          <>
            <ThreadActions ids={[...selected]} folder={folder} rows={rows} labels={page?.labels ?? []} act={act} canEdit={canEdit} afterMove={() => setSelected(new Set())} />
            <span className="ml-1 text-sm text-[#444746]" data-testid="mail-selected-count">{selected.size} selected</span>
          </>
        ) : <MailIcon label="Refresh" onClick={onRefresh} testId="mail-refresh"><RefreshCw className={loading ? 'animate-spin' : ''} /></MailIcon>}
        <span className="ml-auto flex items-center text-xs text-[#5F6368]">
          <span data-testid="mail-page-label">{pageLabel(offset, rows.length, page?.total ?? 0)}</span>
          <MailIcon label="Newer" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}><ChevronLeft /></MailIcon>
          <MailIcon label="Older" disabled={!page || offset + rows.length >= page.total} onClick={() => setOffset(offset + limit)} testId="mail-older"><ChevronRight /></MailIcon>
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading && !page ? (
          <div aria-busy="true" aria-label="Loading emails">{Array.from({ length: 10 }, (_, i) => <div key={i} className="flex items-center gap-3 border-b border-[#F1F3F4] px-4 py-3"><Skeleton className="size-4" /><Skeleton className="h-4 w-40" /><Skeleton className="h-4 flex-1" /></div>)}</div>
        ) : error && !page ? (
          <div className="p-8 text-center text-sm" role="alert"><p className="text-red-700">{describeDataError(error)}</p>
            <button type="button" onClick={onRefresh} className="mt-3 rounded-full bg-[#0B57D0] px-4 py-1.5 font-medium text-white">Try again</button></div>
        ) : !rows.length ? (
          <p className="p-10 text-center text-sm text-[#5F6368]" data-testid="mail-empty">{emptyText}</p>
        ) : (
          <ul data-testid="mail-list">{rows.map((r) => (
            <Row key={r.id} r={r} folder={folder} checked={selected.has(r.id)} timezone={timezone} canEdit={canEdit} act={act} onOpen={() => onOpen(r.id)}
              atts={atts.data?.[r.id]} onPreview={(items, index) => setPreview({ items, index })}
              onCheck={() => { const n = new Set(selected); if (n.has(r.id)) n.delete(r.id); else n.add(r.id); setSelected(n) }} />
          ))}</ul>
        )}
        {error && page && <p className="px-4 py-2 text-center text-xs text-[#B3261E]">Could not refresh: {describeDataError(error)}</p>}
      </div>
      <AttachmentPreview items={preview?.items ?? []} index={preview?.index ?? null} onIndex={(index) => setPreview((p) => (p ? { ...p, index } : p))} onClose={() => setPreview(null)} />
    </div>
  )
}
