import { File, Trash2, X } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import { useAuth } from '@/auth/use-auth'
import { ComposeWindow, type MailComposeTarget } from '@/features/support/mail/compose-window'
import { MailList, type Act } from '@/features/support/mail/mail-list'
import { formatMailSearch, hasFilters, isMailFolder, mailListDate, MAIL_FOLDERS, parseMailSearch, type MailFolder, type MailSearch } from '@/features/support/mail/mail-model'
import { MailRail, MailSidebar } from '@/features/support/mail/mail-nav'
import { MailSearchBar } from '@/features/support/mail/mail-search'
import { MailThread } from '@/features/support/mail/mail-thread'
import { PresenceControl } from '@/features/support/support-components'
import { useSupportPermissions } from '@/features/support/use-support-permissions'
import { usePolled } from '@/features/support/wa-web/use-polled'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { cn } from '@/lib/utils'
import {
  closeEmailDraft, fetchComposeContext, fetchEmailDrafts, fetchMailbox, mailboxAction, mirrorMailboxRead, type EmailDraftRow, type MailboxFolder,
} from '@/services/email'

const LIMIT = 50
const EMPTY: Record<string, string> = {
  INBOX: 'Your inbox is empty. Emails to the support mailbox appear here once Gmail is connected.', STARRED: 'No starred emails. Stars let you mark threads to come back to.',
  SNOOZED: 'Nothing snoozed. Snoozed emails return to the Inbox at the time you choose.', SENT: 'No sent emails yet.', IMPORTANT: 'No emails marked as important.',
  ALL: 'No emails.', SPAM: 'No spam here.', TRASH: 'Trash is empty. Deleted threads are kept here; support history is never erased.', LABEL: 'No emails with this label.',
}
const CHIP: Record<keyof MailSearch, (s: MailSearch) => string> = {
  q: (s) => `“${s.q}”`, from: (s) => `From: ${s.from}`, to: (s) => `To: ${s.to}`, subject: (s) => `Subject: ${s.subject}`, words: (s) => `Words: ${s.words}`,
  after: (s) => `After ${s.after}`, before: (s) => `Before ${s.before}`, has_attachment: () => 'Has attachment', unread: (s) => (s.unread ? 'Unread' : 'Read'),
}

function DraftList({ drafts, loading, onOpen, onDiscard, timezone }: { drafts: EmailDraftRow[] | undefined; loading: boolean; onOpen: (d: EmailDraftRow) => void; onDiscard: (d: EmailDraftRow) => void; timezone?: string }) {
  if (loading && !drafts) return <p className="p-10 text-center text-sm text-[#5F6368]">Loading drafts…</p>
  const list = (drafts ?? []).filter((d) => d.data)
  if (!list.length) return <p className="p-10 text-center text-sm text-[#5F6368]" data-testid="mail-empty">You have no saved drafts. Drafts are private to you and saved while you type.</p>
  return (
    <ul className="min-h-0 flex-1 overflow-y-auto" data-testid="mail-drafts">
      {list.map((d) => (
        <li key={d.scope} className="group flex cursor-pointer items-center gap-3 border-b border-[#F1F3F4] bg-white px-4 py-2.5 text-sm hover:shadow" onClick={() => onOpen(d)} data-testid={`mail-draft-${d.scope}`}>
          <File className="size-4 shrink-0 text-[#5F6368]" />
          <span className="w-44 shrink-0 truncate"><span className="text-[#D93025]">Draft</span>{d.data!.to ? <span className="text-[#5F6368]"> · {d.data!.to}</span> : ''}</span>
          <span className="min-w-0 flex-1 truncate"><span className="text-[#1F1F1F]">{d.data!.subject || '(no subject)'}</span>
            <span className="text-[#5F6368]"> – {d.data!.body.replace(/\s+/g, ' ').slice(0, 140)}</span></span>
          <span className="w-20 shrink-0 text-right text-xs text-[#5F6368] group-hover:hidden">{mailListDate(d.last_saved_at, undefined, timezone)}</span>
          <button type="button" aria-label="Discard draft" title="Discard draft" onClick={(e) => { e.stopPropagation(); onDiscard(d) }}
            className="hidden size-8 items-center justify-center rounded-full text-[#444746] hover:bg-black/5 group-hover:inline-flex"><Trash2 className="size-4" /></button>
        </li>
      ))}
    </ul>
  )
}

/**
 * /support/emails — the shared support mailbox as an email client: rail, folders and labels, search with filters,
 * thread list with bulk actions, reading view with the support details, floating compose. Receiving and sending are
 * the existing Gmail Edge Functions; folders, stars, snoozes and labels are kept in the ERP (migration 20261222090000).
 */
export default function SupportEmailsPage() {
  const { access } = useAuth()
  const tz = access?.company?.timezone ?? undefined
  const perms = useSupportPermissions()
  // Folder, label, search, page and open thread live in the URL. Changed together in one update: React Router does not
  // queue several search-parameter updates made in the same click (the last one would win).
  const [params, setParams] = useSearchParams()
  const folderParam = params.get('folder') ?? 'inbox'
  const label = params.get('label') ?? ''
  const q = params.get('q') ?? ''
  const pageParam = params.get('page') ?? '0'
  const selectedId = params.get('c') ?? ''
  const setUrl = useCallback((patch: Partial<Record<'folder' | 'label' | 'q' | 'page' | 'c', string>>) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      for (const [k, v] of Object.entries(patch)) {
        if (!v || (k === 'folder' && v === 'inbox') || (k === 'page' && v === '0')) next.delete(k)
        else next.set(k, v)
      }
      return next
    }, { replace: true })
  }, [setParams])
  const setQ = (v: string) => setUrl({ q: v, page: '0' })
  const setPageParam = (v: string) => setUrl({ page: v })
  const setSelectedId = (v: string) => setUrl({ c: v })
  const up = folderParam.toUpperCase()
  const folder: MailFolder = isMailFolder(up) ? (up === 'LABEL' && !label ? 'INBOX' : up) : 'INBOX'
  const offset = Math.max(0, Number(pageParam) || 0) * LIMIT
  const search = useMemo(() => parseMailSearch(q), [q])
  const listKey = `${folder}|${label}|${q}|${offset}`
  const list = usePolled(() => (folder === 'DRAFTS' ? Promise.resolve(null) : fetchMailbox({ folder: folder as MailboxFolder, label: label || null, ...search, limit: LIMIT, offset })),
    [folder, label, q, offset], 30_000)
  const [draftsTick, setDraftsTick] = useState(0)
  const drafts = usePolled(() => (perms.reply ? fetchEmailDrafts() : Promise.resolve([])), [draftsTick, perms.reply], 60_000)
  const compose = useAsync(() => fetchComposeContext().catch(() => null), [])
  const [sel, setSel] = useState<{ key: string; ids: Set<string> }>({ key: '', ids: new Set() })
  const selected = sel.key === listKey ? sel.ids : new Set<string>()
  const [composeTarget, setComposeTarget] = useState<MailComposeTarget | null>(null)
  const [navOpen, setNavOpen] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(() => typeof window !== 'undefined' && window.matchMedia?.('(min-width: 1280px)').matches === true)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const page = list.data ?? undefined
  const legacy = Boolean(page?.legacy)

  const go = (f: MailFolder, l = '') => { setUrl({ folder: f.toLowerCase(), label: l, page: '0', c: '' }); setNavOpen(false) }
  const act: Act = async (ids, action, p) => {
    setNotice(null)
    try {
      await mailboxAction(ids, action, p)
      // Gmail's own UNREAD label follows only when the administrator enabled "mirror read" (gmail.modify), as before.
      if (action === 'MARK_READ' && compose.data?.mailbox_modify) ids.forEach((id) => void mirrorMailboxRead(id).catch(() => {}))
      const moved: Partial<Record<string, string>> = { ARCHIVE: 'Archived.', TRASH: 'Moved to Trash.', SPAM: 'Reported as spam (in the ERP).', INBOX: 'Moved to Inbox.', SNOOZE: 'Snoozed.' }
      if (moved[action]) setNotice({ ok: true, text: `${ids.length > 1 ? `${ids.length} conversations: ` : ''}${moved[action]}` })
    } catch (e) {
      setNotice({ ok: false, text: describeDataError(e) })
    } finally {
      list.reload()
    }
  }
  const row = page?.rows.find((r) => r.id === selectedId) ?? null
  const folderLabel = folder === 'LABEL' ? page?.labels.find((l) => l.id === label)?.name ?? 'Label' : MAIL_FOLDERS.find((f) => f.key === folder)?.label
  const removeFilter = (k: keyof MailSearch) => { const s = { ...search }; delete s[k]; setQ(formatMailSearch(s)) }

  const sidebar = (
    <MailSidebar folder={folder} label={label || null} counts={page?.counts ?? {}} labels={page?.labels ?? []} drafts={(drafts.data ?? []).filter((d) => d.data).length}
      onFolder={(f) => go(f)} onLabel={(id) => go('LABEL', id)} onCompose={() => { setNavOpen(false); setComposeTarget({ mode: 'NEW' }) }} canCompose={perms.reply} legacy={legacy} />
  )
  return (
    <div className="-mx-4 -my-6 flex h-[calc(100dvh-3.5rem)] min-h-[520px] overflow-hidden bg-[#F6F8FC] text-[#1F1F1F] sm:-mx-6 lg:-mx-8 lg:-my-8" data-testid="mail-workspace">
      <MailRail />
      <aside className="hidden w-64 shrink-0 lg:block">{sidebar}</aside>
      {navOpen && (
        <>
          <div className="fixed inset-0 z-40 bg-black/30 lg:hidden" onClick={() => setNavOpen(false)} aria-hidden />
          <aside className="fixed inset-y-0 left-0 z-50 w-72 bg-[#F6F8FC] pt-2 shadow-xl lg:hidden" data-testid="mail-nav-drawer">{sidebar}</aside>
        </>
      )}
      <main className="flex min-w-0 flex-1 flex-col pr-2 pb-2 pl-2 lg:pl-0 lg:pr-4">
        <div className="flex h-16 shrink-0 items-center gap-3">
          <MailSearchBar value={q} onSearch={(t) => setUrl({ q: t, page: '0', c: '' })} onMenu={() => setNavOpen(true)} />
          <span className="hidden sm:block"><PresenceControl compact /></span>
        </div>
        {(hasFilters(search) || legacy || notice) && (
          <div className="flex shrink-0 flex-wrap items-center gap-2 pb-2">
            {(Object.keys(search) as (keyof MailSearch)[]).filter((k) => search[k] !== undefined).map((k) => (
              <span key={k} className="inline-flex items-center gap-1 rounded-lg border border-[#C4C7C5] bg-white px-2.5 py-1 text-xs text-[#444746]" data-testid={`mail-chip-${k}`}>{CHIP[k](search)}
                <button type="button" aria-label={`Remove filter ${CHIP[k](search)}`} onClick={() => removeFilter(k)}><X className="size-3" /></button></span>
            ))}
            {hasFilters(search) && <button type="button" onClick={() => setQ('')} className="text-xs text-[#0B57D0] hover:underline">Clear search</button>}
            {legacy && <span className="rounded-lg bg-[#FEF7E0] px-2.5 py-1 text-xs text-[#7A4B00]" data-testid="mail-legacy">Folders, stars, snooze and labels need migration 20261222090000; the inbox is shown meanwhile.</span>}
            {notice && <span role={notice.ok ? 'status' : 'alert'} data-testid="mail-notice" className={cn('inline-flex items-center gap-2 rounded-lg px-2.5 py-1 text-xs', notice.ok ? 'bg-[#E6F4EA] text-[#0D652D]' : 'bg-[#FCE8E6] text-[#A50E0E]')}>
              {notice.text}<button type="button" aria-label="Dismiss" onClick={() => setNotice(null)}><X className="size-3" /></button></span>}
          </div>
        )}
        <div className={cn('flex min-h-0 flex-1 overflow-hidden rounded-2xl bg-white', selectedId && 'max-md:fixed max-md:inset-0 max-md:z-40 max-md:rounded-none')}>
          {selectedId ? (
            <MailThread key={selectedId} id={selectedId} legacy={legacy} row={row} folder={folder} act={act} labels={page?.labels ?? []} timezone={tz}
              onBack={() => setSelectedId('')} onChanged={list.reload} detailsOpen={detailsOpen} setDetailsOpen={setDetailsOpen}
              onReply={(mode, e, customerId) => setComposeTarget({ mode, replyTo: e, conversationId: selectedId, customerId })} />
          ) : folder === 'DRAFTS' ? (
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              <h1 className="sr-only">Drafts</h1>
              <DraftList drafts={drafts.data} loading={drafts.loading} timezone={tz}
                onOpen={(d) => setComposeTarget({ mode: d.data!.mode, draft: { scope: d.scope, version: d.version, data: d.data! }, conversationId: d.data!.conversation_id ?? null })}
                onDiscard={(d) => void closeEmailDraft(d.scope, 'discarded').then(() => setDraftsTick((n) => n + 1), (e) => setNotice({ ok: false, text: describeDataError(e) }))} />
            </div>
          ) : (
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              <h1 className="sr-only">{folderLabel}</h1>
              <MailList page={page} loading={list.loading} error={list.error} folder={folder} selected={selected} setSelected={(ids) => setSel({ key: listKey, ids })}
                onOpen={setSelectedId} act={act} canEdit={perms.reply && !legacy} limit={LIMIT} offset={offset} setOffset={(n) => setPageParam(String(Math.floor(n / LIMIT)))}
                onRefresh={list.reload} timezone={tz} emptyText={hasFilters(search) ? 'No emails match your search.' : EMPTY[folder] ?? 'No emails.'} />
            </div>
          )}
        </div>
      </main>
      {composeTarget && (
        <ComposeWindow key={composeTarget.draft?.scope ?? `${composeTarget.mode}-${composeTarget.replyTo?.id ?? 'new'}`} target={composeTarget} timezone={tz}
          onClose={() => setComposeTarget(null)} onDraftSaved={() => setDraftsTick((n) => n + 1)}
          onSent={(r) => { list.reload(); setDraftsTick((n) => n + 1); if (composeTarget.mode === 'NEW' && !composeTarget.draft) setSelectedId(r.conversation_id) }} />
      )}
    </div>
  )
}
