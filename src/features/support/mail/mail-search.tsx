import { Menu, Search, SlidersHorizontal, X } from 'lucide-react'
import { useState } from 'react'

import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { formatMailSearch, parseMailSearch, toIsoDate, type MailSearch } from '@/features/support/mail/mail-model'

/**
 * Search bar: free text plus Gmail-style operators (from:, to:, subject:, has:attachment, is:unread / is:read,
 * after:, before:), and an advanced-search panel that writes the same operators.
 */
export function MailSearchBar({ value, onSearch, onMenu }: { value: string; onSearch: (text: string) => void; onMenu: () => void }) {
  const [text, setText] = useState(value)
  const [open, setOpen] = useState(false)
  const [seen, setSeen] = useState(value)
  // A new search from outside (folder change, chip removed) replaces what is typed.
  if (value !== seen) { setSeen(value); setText(value) }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <form role="search" className="flex h-12 min-w-0 flex-1 items-center gap-1 rounded-full bg-[#E9EEF6] px-1 focus-within:bg-white focus-within:shadow-[0_1px_1px_0_rgba(65,69,73,.3),0_1px_3px_1px_rgba(65,69,73,.15)]"
          onSubmit={(e) => { e.preventDefault(); onSearch(text.trim()) }}>
          <button type="button" aria-label="Main menu" onClick={onMenu} className="inline-flex size-10 items-center justify-center rounded-full text-[#444746] hover:bg-black/5 lg:hidden"><Menu className="size-5" /></button>
          <button type="submit" aria-label="Search mail" className="hidden size-10 items-center justify-center rounded-full text-[#444746] hover:bg-black/5 lg:inline-flex"><Search className="size-5" /></button>
          <input aria-label="Search mail" value={text} onChange={(e) => setText(e.target.value)} placeholder="Search mail" data-testid="mail-search"
            className="min-w-0 flex-1 bg-transparent text-base text-[#1F1F1F] outline-none placeholder:text-[#444746]" />
          {text && <button type="button" aria-label="Clear search" onClick={() => { setText(''); onSearch('') }} className="inline-flex size-10 items-center justify-center rounded-full text-[#444746] hover:bg-black/5"><X className="size-5" /></button>}
          <button type="button" aria-label="Show search options" title="Show search options" onClick={() => setOpen((o) => !o)} data-testid="mail-advanced-toggle"
            className="inline-flex size-10 items-center justify-center rounded-full text-[#444746] hover:bg-black/5"><SlidersHorizontal className="size-5" /></button>
        </form>
      </PopoverAnchor>
      <PopoverContent align="start" sideOffset={4} className="w-[min(720px,calc(100vw-2rem))] p-0">
        <AdvancedSearch key={open ? 'open' : 'closed'} initial={parseMailSearch(text)} onSearch={(s) => { const q = formatMailSearch(s); setText(q); onSearch(q); setOpen(false) }} />
      </PopoverContent>
    </Popover>
  )
}

function AdvancedSearch({ initial, onSearch }: { initial: MailSearch; onSearch: (s: MailSearch) => void }) {
  const [s, setS] = useState({ from: initial.from ?? '', to: initial.to ?? '', subject: initial.subject ?? '', words: [initial.words, initial.q].filter(Boolean).join(' '),
    after: initial.after ?? '', before: initial.before ?? '', att: Boolean(initial.has_attachment), status: initial.unread === true ? 'unread' : initial.unread === false ? 'read' : '' })
  const [error, setError] = useState<string | null>(null)
  const row = (label: string, id: keyof typeof s, type = 'text') => (
    <label className="flex items-end gap-3 text-sm" htmlFor={`adv-${id}`}>
      <span className="w-28 shrink-0 pb-1.5 text-[#444746]">{label}</span>
      <input id={`adv-${id}`} type={type} value={s[id] as string} onChange={(e) => setS((x) => ({ ...x, [id]: e.target.value }))}
        className="min-w-0 flex-1 border-b border-[#C4C7C5] bg-transparent py-1.5 outline-none focus:border-[#0B57D0]" />
    </label>
  )
  const submit = () => {
    if ((s.after && !toIsoDate(s.after)) || (s.before && !toIsoDate(s.before))) { setError('Dates must be valid.'); return }
    if (s.after && s.before && s.after > s.before) { setError('The "from" date is after the "to" date.'); return }
    onSearch({ from: s.from.trim() || undefined, to: s.to.trim() || undefined, subject: s.subject.trim() || undefined, words: s.words.trim() || undefined,
      after: s.after || undefined, before: s.before || undefined, has_attachment: s.att || undefined, unread: s.status === 'unread' ? true : s.status === 'read' ? false : undefined })
  }
  return (
    <form className="space-y-3 p-5" onSubmit={(e) => { e.preventDefault(); submit() }} data-testid="mail-advanced" aria-label="Advanced search">
      {row('From', 'from')}
      {row('To', 'to')}
      {row('Subject', 'subject')}
      {row('Has the words', 'words')}
      <div className="flex flex-wrap items-end gap-3 text-sm">
        <span className="w-28 shrink-0 pb-1.5 text-[#444746]">Date within</span>
        <input type="date" aria-label="From date" value={s.after} onChange={(e) => setS((x) => ({ ...x, after: e.target.value }))} className="border-b border-[#C4C7C5] py-1 outline-none" data-testid="adv-after" />
        <span className="pb-1.5 text-[#444746]">to</span>
        <input type="date" aria-label="To date" value={s.before} onChange={(e) => setS((x) => ({ ...x, before: e.target.value }))} className="border-b border-[#C4C7C5] py-1 outline-none" data-testid="adv-before" />
      </div>
      <div className="flex flex-wrap items-center gap-5 text-sm">
        <span className="w-28 shrink-0 text-[#444746]">Status</span>
        <select aria-label="Read status" value={s.status} onChange={(e) => setS((x) => ({ ...x, status: e.target.value }))} className="rounded border border-[#C4C7C5] px-2 py-1">
          <option value="">Read and unread</option><option value="unread">Unread only</option><option value="read">Read only</option></select>
        <label className="inline-flex items-center gap-2"><input type="checkbox" checked={s.att} onChange={(e) => setS((x) => ({ ...x, att: e.target.checked }))} data-testid="adv-attachment" />Has attachment</label>
      </div>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={() => setS({ from: '', to: '', subject: '', words: '', after: '', before: '', att: false, status: '' })} className="rounded-full px-4 py-2 text-sm text-[#0B57D0] hover:bg-[#E8F0FE]">Clear filter</button>
        <button type="submit" className="rounded-full bg-[#0B57D0] px-6 py-2 text-sm font-medium text-white hover:bg-[#0A4CB8]" data-testid="adv-search">Search</button>
      </div>
    </form>
  )
}
