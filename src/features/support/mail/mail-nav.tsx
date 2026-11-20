import { AlertOctagon, CalendarDays, Clock, File, Inbox, Mail, MailCheck, MessageCircle, Pencil, Send, Star, Tag, Trash2, Bookmark, Users } from 'lucide-react'
import type { ComponentType } from 'react'
import { Link } from 'react-router-dom'

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { MAIL_FOLDERS, type MailFolder } from '@/features/support/mail/mail-model'
import { cn } from '@/lib/utils'
import type { TagRef } from '@/services/support'

const ICON: Record<string, ComponentType<{ className?: string }>> = {
  INBOX: Inbox, STARRED: Star, SNOOZED: Clock, SENT: Send, DRAFTS: File, IMPORTANT: Bookmark, ALL: MailCheck, SPAM: AlertOctagon, TRASH: Trash2,
}
const TAG_DOT: Record<string, string> = { neutral: '#80868B', info: '#1A73E8', success: '#188038', warning: '#E37400', danger: '#D93025', outsourced: '#9334E6' }

/** Compact application rail: Mail, Chat (WhatsApp), Contacts (support customers). Calendar: no calendar module in the ERP. */
export function MailRail() {
  const items = [
    { label: 'Mail', icon: Mail, to: '/support/emails', active: true },
    { label: 'Chat', icon: MessageCircle, to: '/support/whatsapp' },
    { label: 'Contacts', icon: Users, to: '/support/customers' },
  ]
  return (
    <nav aria-label="Apps" className="hidden w-[68px] shrink-0 flex-col items-center gap-3 pt-3 md:flex" data-testid="mail-rail">
      {items.map((i) => (
        <Link key={i.label} to={i.to} aria-current={i.active ? 'page' : undefined} className="group flex flex-col items-center gap-1 text-[11px] font-medium text-[#444746]">
          <span className={cn('flex h-8 w-14 items-center justify-center rounded-full transition-colors group-hover:bg-[#1F1F1F]/[0.08]', i.active && 'bg-[#D3E3FD] text-[#041E49]')}><i.icon className="size-5" /></span>{i.label}
        </Link>
      ))}
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="flex cursor-not-allowed flex-col items-center gap-1 text-[11px] font-medium text-[#444746] opacity-50" aria-disabled="true" data-testid="mail-rail-calendar">
            <span className="flex h-8 w-14 items-center justify-center rounded-full"><CalendarDays className="size-5" /></span>Calendar</span>
        </TooltipTrigger>
        <TooltipContent>The ERP has no calendar module yet.</TooltipContent>
      </Tooltip>
    </nav>
  )
}

/** Compose button, folders with counts, and labels (the support tags). */
export function MailSidebar({ folder, label, counts, labels, drafts, onFolder, onLabel, onCompose, canCompose, legacy }: {
  folder: MailFolder; label: string | null; counts: Record<string, number>; labels: (TagRef & { unread: number })[]; drafts: number
  onFolder: (f: MailFolder) => void; onLabel: (id: string) => void; onCompose: () => void; canCompose: boolean; legacy: boolean
}) {
  return (
    <nav aria-label="Mail folders" className="flex h-full flex-col overflow-y-auto pr-2 pb-4" data-testid="mail-sidebar">
      <div className="px-2 pt-2 pb-4">
        <button type="button" onClick={onCompose} disabled={!canCompose} data-testid="new-email" title={canCompose ? 'Compose' : 'Your role cannot send email'}
          className="inline-flex h-14 items-center gap-3 rounded-2xl bg-[#C2E7FF] pr-6 pl-4 text-sm font-medium text-[#001D35] shadow-sm transition-shadow hover:shadow-md disabled:opacity-50">
          <Pencil className="size-5" />Compose</button>
      </div>
      <ul>
        {MAIL_FOLDERS.map((f) => {
          const Icon = ICON[f.key]
          const n = f.key === 'DRAFTS' ? drafts : counts[f.key] ?? 0
          const active = folder === f.key
          const off = legacy && !['INBOX', 'ALL', 'DRAFTS'].includes(f.key)
          return (
            <li key={f.key}>
              <button type="button" onClick={() => onFolder(f.key)} aria-current={active ? 'page' : undefined} disabled={off} data-testid={`mail-folder-${f.key}`}
                title={off ? 'Needs migration 20261222090000' : undefined}
                className={cn('flex h-8 w-full items-center gap-4 rounded-r-full pr-3 pl-6 text-sm text-[#1F1F1F] hover:bg-[#1F1F1F]/[0.06] disabled:opacity-40',
                  active && 'bg-[#D3E3FD] font-bold text-[#041E49] hover:bg-[#D3E3FD]', n > 0 && f.count === 'unread' && 'font-bold')}>
                <Icon className="size-[18px] shrink-0" />
                <span className="flex-1 text-left">{f.label}</span>
                {f.count && n > 0 && <span className="text-xs" data-testid={`mail-count-${f.key}`}>{n.toLocaleString('en-IN')}</span>}
              </button>
            </li>
          )
        })}
      </ul>
      <div className="mt-4 flex items-center justify-between pr-2 pl-6"><h2 className="text-base text-[#1F1F1F]">Labels</h2></div>
      <ul className="mt-1" data-testid="mail-labels">
        {labels.map((l) => (
          <li key={l.id}>
            <button type="button" onClick={() => onLabel(l.id)} aria-current={folder === 'LABEL' && label === l.id ? 'page' : undefined}
              className={cn('flex h-8 w-full items-center gap-4 rounded-r-full pr-3 pl-6 text-sm text-[#1F1F1F] hover:bg-[#1F1F1F]/[0.06]',
                folder === 'LABEL' && label === l.id && 'bg-[#D3E3FD] font-bold text-[#041E49]', l.unread > 0 && 'font-bold')}>
              <Tag className="size-[18px] shrink-0" style={{ color: TAG_DOT[l.color] ?? TAG_DOT.neutral }} />
              <span className="flex-1 truncate text-left">{l.name}</span>
              {l.unread > 0 && <span className="text-xs">{l.unread}</span>}
            </button>
          </li>
        ))}
        {!labels.length && <li className="pl-6 text-xs text-[#5F6368]">{legacy ? 'Labels need migration 20261222090000.' : 'Labels are the support tags (Support Settings → Tags).'}</li>}
      </ul>
    </nav>
  )
}
