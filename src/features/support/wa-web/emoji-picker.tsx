import { Clock3, Search } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'

import { EMOJI_CATEGORIES, searchEmoji } from '@/features/support/wa-web/emoji-data'
import { pushRecentEmoji, recentEmoji } from '@/features/support/wa-web/wa-web-model'
import { cn } from '@/lib/utils'

/** Emoji picker: recently used, seven categories, search; arrow keys move between emoji, Enter picks. */
export function EmojiPicker({ onPick }: { onPick: (emoji: string) => void }) {
  const [recent, setRecent] = useState<string[]>(() => recentEmoji())
  const [term, setTerm] = useState('')
  const [tab, setTab] = useState(() => (recentEmoji().length ? 'recent' : EMOJI_CATEGORIES[0].key))
  const grid = useRef<HTMLDivElement>(null)
  const items = useMemo<[string, string][]>(() => {
    if (term.trim()) return searchEmoji(term)
    if (tab === 'recent') return recent.map((e) => [e, 'recently used'])
    return EMOJI_CATEGORIES.find((c) => c.key === tab)?.items ?? []
  }, [term, tab, recent])
  const pick = (e: string) => { setRecent((r) => pushRecentEmoji(r, e)); onPick(e) }
  const move = (ev: React.KeyboardEvent<HTMLDivElement>) => {
    const buttons = [...(grid.current?.querySelectorAll<HTMLButtonElement>('button[data-emoji]') ?? [])]
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 8, ArrowUp: -8 }[ev.key]
    if (step === undefined || i < 0) return
    ev.preventDefault()
    buttons[Math.max(0, Math.min(buttons.length - 1, i + step))]?.focus()
  }
  const tabs = [{ key: 'recent', label: 'Recently used', icon: null }, ...EMOJI_CATEGORIES.map((c) => ({ key: c.key, label: c.label, icon: c.icon }))]
  const current = term.trim() ? `Results for “${term.trim()}”` : tabs.find((t) => t.key === tab)?.label
  return (
    <div className="w-[min(352px,calc(100vw-2rem))] text-[#111B21]" data-testid="wa-emoji-picker">
      <div role="tablist" aria-label="Emoji categories" className="flex items-center justify-between border-b border-[#E9EDEF] px-1">
        {tabs.map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={!term && tab === t.key} title={t.label} aria-label={t.label}
            onClick={() => { setTab(t.key); setTerm('') }}
            className={cn('flex h-10 flex-1 items-center justify-center border-b-[3px] text-lg', !term && tab === t.key ? 'border-[#008069]' : 'border-transparent opacity-60 hover:opacity-100')}>
            {t.icon ?? <Clock3 className="size-[18px] text-[#54656F]" />}
          </button>
        ))}
      </div>
      <div className="p-2">
        <label className="flex items-center gap-2 rounded-lg bg-[#F0F2F5] px-3 py-1.5">
          <Search className="size-4 text-[#54656F]" aria-hidden />
          <input aria-label="Search emoji" className="w-full bg-transparent text-sm outline-none placeholder:text-[#667781]" placeholder="Search emoji" value={term}
            onChange={(e) => setTerm(e.target.value)} data-testid="wa-emoji-search" />
        </label>
      </div>
      <p className="px-3 pb-1 text-xs font-medium text-[#667781]">{current}</p>
      <div ref={grid} role="grid" aria-label={current} onKeyDown={move} className="grid h-60 grid-cols-8 content-start gap-0.5 overflow-y-auto px-2 pb-2">
        {items.map(([e, name]) => (
          <button key={e} type="button" data-emoji={e} title={name} aria-label={name} onClick={() => pick(e)}
            className="flex aspect-square items-center justify-center rounded-md text-2xl leading-none hover:bg-[#F0F2F5] focus-visible:bg-[#F0F2F5] focus-visible:outline-2 focus-visible:outline-[#008069]">{e}</button>
        ))}
        {!items.length && <p className="col-span-8 py-8 text-center text-sm text-[#667781]">{term.trim() ? 'No emoji found.' : 'Emoji you use appear here.'}</p>}
      </div>
    </div>
  )
}
