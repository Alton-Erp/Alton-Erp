// WhatsApp Web-style support screen: delivery ticks only from Meta's statuses, date separators, chat items
// (notes never in the chat), search, composer keys and emoji insertion, retry safety, and the wiring that keeps
// the existing send / receive paths and secrets untouched. Database side: tests/db/whatsapp-web-inbox-check.mjs.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { EMOJI_CATEGORIES, searchEmoji } from '../../src/features/support/wa-web/emoji-data.ts'
import {
  buildChatItems, canRetry, composerKey, composerProblem, copyText, dayLabel, formatWaNumber, highlight, initials, insertAt, listTime, mediaKind,
  reactionEmoji, searchMessages, visibleBody, waTick, waTickLabel, WA_FILTERS,
} from '../../src/features/support/wa-web/wa-web-model.ts'
import type { TimelineItem } from '../../src/services/support.ts'
import type { WaMessage } from '../../src/services/whatsapp.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const src = (p: string) => readFileSync(path.join(root, p), 'utf8')
const dir = 'src/features/support/wa-web'
const all = readdirSync(path.join(root, dir)).map((f) => src(`${dir}/${f}`)).join('\n') + src('src/pages/support/support-whatsapp-page.tsx')
const MIG = src('supabase/migrations/20261221090000_whatsapp_web_inbox.sql')

const msg = (p: Partial<WaMessage>): WaMessage => ({
  id: 'm1', message_id: 's1', direction: 'INBOUND', type: 'text', body: 'Hello', at: '2026-11-20T06:00:00Z', status: 'RECEIVED', status_at: null, error_code: null,
  error_title: null, error_detail: null, media_state: 'NONE', media_error: null, media_filename: null, media_mime: null, location: null, context_wa_message_id: null,
  wa_message_id: 'wamid.1', template_name: null, author: null, attachment: null, ...p,
})
const NOW = new Date('2026-11-20T10:00:00Z')
const TZ = 'Asia/Kolkata'

describe('delivery ticks', () => {
  it('1. inbound messages carry no tick', () => assert.equal(waTick({ direction: 'INBOUND', status: 'RECEIVED' }), 'NONE'))
  it('2. a message only inserted (PENDING) shows the clock, never a tick', () => assert.equal(waTick({ direction: 'OUTBOUND', status: 'PENDING' }), 'CLOCK'))
  it('3. accepted by Meta but no "sent" webhook yet: still the clock, labelled as waiting', () => {
    assert.equal(waTick({ direction: 'OUTBOUND', status: 'PENDING' }), 'CLOCK')
    assert.match(waTickLabel({ direction: 'OUTBOUND', status: 'PENDING', wa_message_id: 'wamid.X' }), /Accepted by Meta, waiting/)
    assert.equal(waTickLabel({ direction: 'OUTBOUND', status: 'PENDING', wa_message_id: null }), 'Sending')
  })
  it('4. sent → single grey, delivered → double grey, read → double blue, failed → error', () => {
    assert.deepEqual(['SENT', 'DELIVERED', 'READ', 'FAILED'].map((s) => waTick({ direction: 'OUTBOUND', status: s })), ['SENT', 'DELIVERED', 'READ', 'FAILED'])
    const ui = src(`${dir}/wa-ui.tsx`)
    assert.match(ui, /READ: <CheckCheck className="size-4 text-\[#53BDEB\]"/)
    assert.match(ui, /DELIVERED: <CheckCheck className="size-4 text-\[#667781\]"/)
    assert.match(ui, /SENT: <Check className="size-4 text-\[#667781\]"/)
  })
  it('5. unknown statuses fall back to the clock (never to a delivered or read tick)', () => assert.equal(waTick({ direction: 'OUTBOUND', status: 'WHATEVER' }), 'CLOCK'))
  it('6. the tick element keeps data-testid=wa-status / data-status for existing checks', () => assert.match(src(`${dir}/wa-ui.tsx`), /data-testid="wa-status" data-status=\{status\}/))
})

describe('retry is safe', () => {
  const failed = msg({ direction: 'OUTBOUND', status: 'FAILED', type: 'text' })
  it('7. only a message Meta reported FAILED, text, inside the window, once', () => {
    assert.equal(canRetry(failed, { windowOpen: true, canSend: true, retried: false }), true)
    assert.equal(canRetry(failed, { windowOpen: true, canSend: true, retried: true }), false)
    assert.equal(canRetry(failed, { windowOpen: false, canSend: true, retried: false }), false)
    assert.equal(canRetry({ ...failed, status: 'PENDING' }, { windowOpen: true, canSend: true, retried: false }), false, 'a pending (maybe delivered later) message is never resent')
    assert.equal(canRetry({ ...failed, type: 'image' }, { windowOpen: true, canSend: true, retried: false }), false)
  })
  it('8. a retry is a new message with a new idempotency key through the existing send function', () => {
    assert.match(src(`${dir}/chat-workspace.tsx`), /sendWaText\(\{ idempotency_key: crypto\.randomUUID\(\), conversation_id: id, text: m\.body \}\)/)
  })
})

describe('dates', () => {
  it('9. separators: TODAY, YESTERDAY, 19 NOVEMBER 2026', () => {
    assert.equal(dayLabel('2026-11-20T04:00:00Z', NOW, TZ), 'TODAY')
    assert.equal(dayLabel('2026-11-19T04:00:00Z', NOW, TZ), 'YESTERDAY')
    assert.equal(dayLabel('2026-11-12T04:00:00Z', NOW, TZ), '12 NOVEMBER 2026')
  })
  it('10. the company timezone decides the day (19:00 UTC on the 19th is the 20th in India)', () => assert.equal(dayLabel('2026-11-19T19:00:00Z', NOW, TZ), 'TODAY'))
  it('11. list times: time today, Yesterday, weekday this week, date before', () => {
    assert.match(listTime('2026-11-20T04:00:00Z', NOW, TZ), /^9:30 am$/)
    assert.equal(listTime('2026-11-19T04:00:00Z', NOW, TZ), 'Yesterday')
    assert.equal(listTime('2026-11-17T04:00:00Z', NOW, TZ), 'Tuesday')
    assert.equal(listTime('2026-10-01T04:00:00Z', NOW, TZ), '01/10/2026')
  })
})

describe('chat items', () => {
  const tl: TimelineItem[] = [
    { type: 'message', id: 's1', at: '2026-11-20T06:00:00Z', direction: 'INBOUND', source: 'CHANNEL', body: 'Hello' },
    { type: 'note', id: 'n1', at: '2026-11-20T06:01:00Z', body: 'Customer is upset' },
    { type: 'event', id: 'e1', at: '2026-11-20T06:02:00Z', event_type: 'CREATED' },
    { type: 'message', id: 'x1', at: '2026-11-19T06:00:00Z', direction: 'OUTBOUND', source: 'MANUAL', body: 'Called him' },
  ]
  const items = buildChatItems([msg({})], tl, NOW, TZ)
  it('12. internal notes are never chat items (they cannot be sent to the customer from the chat)', () => assert.ok(!items.some((i) => 'item' in i && i.item.type === 'note')))
  it('13. WhatsApp messages are not repeated from the timeline; logged messages and ticket events are kept', () => {
    assert.deepEqual(items.map((i) => i.kind), ['day', 'logged', 'day', 'message', 'event'])
    assert.deepEqual(items.filter((i) => i.kind === 'day').map((i) => (i as { label: string }).label), ['YESTERDAY', 'TODAY'])
  })
  it('14. stable order: time, WhatsApp before ERP entries at the same instant, then id', () => {
    const same = buildChatItems([msg({ id: 'b', message_id: 'sb' }), msg({ id: 'a', message_id: 'sa' })], [{ type: 'event', id: 'e', at: '2026-11-20T06:00:00Z', event_type: 'ASSIGNED' }], NOW, TZ)
    assert.deepEqual(same.map((i) => i.key), ['d-2026-11-20', 'm-a', 'm-b', 'e-e'])
  })
})

describe('message content', () => {
  it('15. reactions are shown as reactions, not as "[Reaction]" text', () => {
    assert.equal(reactionEmoji(msg({ type: 'reaction', body: '[Reaction] 👍' })), '👍')
    assert.equal(reactionEmoji(msg({ type: 'reaction', body: '[Reaction] ' })), '')
    assert.equal(reactionEmoji(msg({})), null)
  })
  it('16. media placeholders are not shown as text; document captions are', () => {
    assert.equal(visibleBody(msg({ type: 'image', body: '[Image]' })), '')
    assert.equal(visibleBody(msg({ type: 'document', body: '[Document] invoice.pdf — for March', media_filename: 'invoice.pdf' })), 'for March')
    assert.equal(mediaKind(msg({ type: 'text', attachment: { id: 'a', file_name: 'x.pdf', content_type: 'application/pdf', size_bytes: 1, storage_path: 'p', restricted: false } })), 'document')
    assert.equal(mediaKind(msg({ type: 'audio' })), 'audio')
  })
  it('17. search in the conversation is case- and accent-insensitive and highlights matches', () => {
    assert.deepEqual(searchMessages([msg({ id: 'a', body: 'The basin arrived CRACKED' }), msg({ id: 'b', body: 'Café' })], 'cracked'), ['a'])
    assert.deepEqual(searchMessages([msg({ id: 'b', body: 'Café' })], 'cafe'), ['b'])
    assert.deepEqual(highlight('A crack, cracked', 'crack').filter((p) => p.hit).length, 2)
  })
  it('18. names, initials and numbers', () => {
    assert.equal(initials('Ravi Kumar'), 'RK')
    assert.equal(initials('+91 98765'), '#')
    assert.equal(formatWaNumber('919876543210'), '+91 98765 43210')
    assert.equal(copyText([msg({ body: 'one' })], 'Ravi'), 'one')
  })
})

describe('composer', () => {
  it('19. Enter sends, Shift+Enter is a new line, IME composition never sends', () => {
    assert.equal(composerKey({ key: 'Enter', shiftKey: false }), 'send')
    assert.equal(composerKey({ key: 'Enter', shiftKey: true }), null)
    assert.equal(composerKey({ key: 'Enter', shiftKey: false, isComposing: true }), null)
    assert.equal(composerKey({ key: 'a', shiftKey: false }), null)
  })
  it('20. emoji are inserted at the caret or over the selection', () => {
    assert.deepEqual(insertAt('Hello world', 5, 5, ' 👍'), { text: 'Hello 👍 world', caret: 8 })
    assert.deepEqual(insertAt('Hello world', 6, 11, '🙏'), { text: 'Hello 🙏', caret: 8 })
    assert.deepEqual(insertAt('Hi', null, null, '😀'), { text: 'Hi😀', caret: 4 })
  })
  it('21. validation: empty text, 4,096-character text and 1,024-character caption limits', () => {
    assert.equal(composerProblem('  ', false), 'Enter the message.')
    assert.equal(composerProblem('', true), null)
    assert.equal(composerProblem('x'.repeat(4097), false), 'At most 4,096 characters.')
    assert.match(composerProblem('x'.repeat(1025), true) ?? '', /at most 1,024/)
  })
  it('22. one request per click: the composer guards in-flight sends and uses a fresh key per message', () => {
    const c = src(`${dir}/chat-composer.tsx`)
    assert.match(c, /if \(inFlight\.current\) return/)
    assert.match(c, /setKey\(crypto\.randomUUID\(\)\)/)
  })
  it('23. emoji picker: seven categories plus recently used, unique emoji, search', () => {
    assert.equal(EMOJI_CATEGORIES.length, 7)
    assert.deepEqual(EMOJI_CATEGORIES.map((c) => c.key), ['smileys', 'animals', 'food', 'activities', 'travel', 'objects', 'symbols'])
    const emoji = EMOJI_CATEGORIES.flatMap((c) => c.items.map((i) => i[0]))
    assert.equal(new Set(emoji).size, emoji.length)
    assert.ok(searchEmoji('thumbs').some(([e]) => e === '👍'))
    assert.match(src(`${dir}/emoji-picker.tsx`), /key: 'recent', label: 'Recently used'/)
  })
})

describe('wiring and safety', () => {
  it('24. no secrets in the screen; Meta is never called from the browser', () => {
    assert.doesNotMatch(all, /WHATSAPP_ACCESS_TOKEN|APP_SECRET|access_token|graph\.facebook\.com/)
  })
  it('25. sending only through the existing Edge Functions (whatsapp-send-message / -template)', () => {
    assert.doesNotMatch(all, /functions\.invoke|support_whatsapp_send_prepare|support_message_add/)
    assert.match(src(`${dir}/chat-composer.tsx`), /sendWaMedia\(|sendWaText\(/)
  })
  it('26. internal notes are saved with support_note_add (never a WhatsApp message) and labelled as such', () => {
    const info = src(`${dir}/info-panel.tsx`)
    assert.match(info, /addNote\('CONVERSATION', ctx\.d\.conversation\.id/)
    assert.match(info, /never sent to the customer on WhatsApp/)
  })
  it('27. unsupported actions are disabled with a reason, not faked', () => {
    const b = src(`${dir}/message-bubble.tsx`)
    for (const k of ['react', 'forward', 'delete']) assert.match(b, new RegExp(`disabled title=\\{NOT_SUPPORTED\\.${k}\\}`))
    assert.match(src(`${dir}/conversation-list.tsx`), /disabled=\{groups\}/)
  })
  it('28. filters: All, Unread, Favourites, Groups, Assigned to me (Groups disabled)', () => {
    assert.deepEqual(WA_FILTERS.map((f) => f.label), ['All', 'Unread', 'Favourites', 'Groups', 'Assigned to me'])
  })
  it('29. the migration is additive: receiving, sending and status processing are not redefined', () => {
    assert.doesNotMatch(MIG, /function private\.support_whatsapp_(process|apply_status)|function public\.support_whatsapp_(ingest|send_prepare|send_result|thread)\b/)
    assert.doesNotMatch(MIG, /\bupdate public\.support_whatsapp_(messages|statuses)|delete from public\.support_whatsapp/)
    assert.match(MIG, /revoke all on table public\.support_conversation_prefs from anon, authenticated/)
  })
  it('30. the list falls back to the unified inbox before the migration (no guessed unread / favourites)', () => {
    const s = src('src/services/whatsapp.ts')
    assert.match(s, /if \(view === 'UNREAD' \|\| view === 'FAVORITES'\) return \{ total: 0/)
    assert.match(s, /fetchInbox\(view, \{ channel: 'WHATSAPP'/)
  })
})
