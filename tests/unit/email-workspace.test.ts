// Email workspace: formatted emails built safely on the server (markup → escaped HTML, multipart/alternative),
// the editor → markup conversion, Gmail-style search operators, list dates, snooze times, print escaping, and the
// wiring that keeps sending / receiving on the existing Gmail Edge Functions. Database side: tests/db/email-mailbox-check.mjs.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { inlineToHtml, markdownToHtml, markdownToText, safeHref } from '../../supabase/functions/_shared/google/markdown.ts'
import { buildMime } from '../../supabase/functions/_shared/google/mime.ts'
import {
  editorHtml, editorToMarkup, formatMailSearch, forwardBlock, forwardSubject, initiallyExpanded, mailListDate, pageLabel, parseMailSearch, printHtml, snoozeChoices, toIsoDate,
  type EditorNode,
} from '../../src/features/support/mail/mail-model.ts'
import type { ThreadEmail } from '../../src/services/email.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const src = (p: string) => readFileSync(path.join(root, p), 'utf8')
const dir = 'src/features/support/mail'
const all = readdirSync(path.join(root, dir)).map((f) => src(`${dir}/${f}`)).join('\n') + src('src/pages/support/support-emails-page.tsx')

// Minimal DOM nodes for the editor serializer.
const T = (text: string): EditorNode => ({ nodeType: 3, nodeName: '#text', textContent: text, childNodes: [] })
const E = (name: string, kids: EditorNode[] = [], attrs: Record<string, string> = {}, style: EditorNode['style'] = {}): EditorNode =>
  ({ nodeType: 1, nodeName: name, textContent: null, childNodes: kids, getAttribute: (n) => attrs[n] ?? null, style })
const doc = (...kids: EditorNode[]) => E('DIV', kids)

describe('formatted email (server side)', () => {
  it('1. every character of text is escaped: no HTML from the editor reaches the email', () => {
    const html = markdownToHtml('<script>alert(1)</script> **<img src=x onerror=alert(1)>**')
    assert.doesNotMatch(html, /<script|<img/)
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; <strong>&lt;img src=x onerror=alert\(1\)&gt;<\/strong>/)
  })
  it('2. links only to http(s) and mailto; javascript: and data: stay text', () => {
    assert.equal(safeHref('javascript:alert(1)'), null)
    assert.equal(safeHref('data:text/html,x'), null)
    assert.match(inlineToHtml('[site](https://alton.example/a?b=1&c="2")'), /^<a href="https:\/\/alton\.example\/a\?b=1&amp;c=%222%22" target="_blank" rel="noopener noreferrer">site<\/a>$/)
    assert.equal(inlineToHtml('[x](javascript:alert(1))'), '[x](javascript:alert(1))')
    assert.match(inlineToHtml('[mail us](mailto:support@alton.example)'), /href="mailto:support@alton\.example"/)
  })
  it('3. bold, italic, underline, escapes and unclosed markers', () => {
    assert.equal(inlineToHtml('**b** *i* ++u++'), '<strong>b</strong> <em>i</em> <u>u</u>')
    assert.equal(inlineToHtml('2 \\* 3 = 6'), '2 * 3 = 6')
    assert.equal(inlineToHtml('a **b'), 'a **b')
    assert.equal(inlineToHtml('**bold *both***'), '<strong>bold <em>both</em></strong>')
  })
  it('4. paragraphs, line breaks, bulleted and numbered lists; escaped "- " stays text', () => {
    const h = markdownToHtml('Hello\nRavi\n\n- one\n- two\n\n1. first\n2. second\n\\- not a list')
    assert.match(h, /<p[^>]*>Hello<br>Ravi<\/p><ul[^>]*><li>one<\/li><li>two<\/li><\/ul><ol[^>]*><li>first<\/li><li>second<\/li><\/ol><p[^>]*>- not a list<\/p>/)
  })
  it('5. the plain-text part has no markers: links as "text (url)"', () => {
    assert.equal(markdownToText('**Dispatched** *today*: [track](https://t.example/1) ++now++ \\*'), 'Dispatched today: track (https://t.example/1) now *')
  })
  it('6. MIME: formatted emails are multipart/alternative (text first, then HTML); plain emails unchanged', () => {
    const base = { from: { email: 'support@alton.example', name: 'Alton' }, to: [{ email: 'r@c.example', name: null }], cc: [], bcc: [], subject: 'Hi', body: 'Plain',
      messageId: '<a@alton.example>', inReplyTo: null, references: null, date: new Date('2026-11-20T00:00:00Z'), attachments: [] }
    const plain = buildMime(base, 'b1')
    assert.doesNotMatch(plain, /multipart\/alternative|text\/html/)
    assert.match(plain, /^Content-Type: text\/plain; charset=UTF-8$/m)
    const rich = buildMime({ ...base, html: '<p>Plain</p>' }, 'b1')
    assert.match(rich, /Content-Type: multipart\/alternative; boundary="b1_alt"[\s\S]*--b1_alt\r\nContent-Type: text\/plain[\s\S]*--b1_alt\r\nContent-Type: text\/html; charset=UTF-8[\s\S]*--b1_alt--/)
    const withFile = buildMime({ ...base, html: '<p>x</p>', attachments: [{ fileName: 'a.pdf', contentType: 'application/pdf', bytes: new Uint8Array([1]) }] }, 'b2')
    assert.match(withFile, /multipart\/mixed; boundary="b2"[\s\S]*--b2\r\nContent-Type: multipart\/alternative; boundary="b2_alt"[\s\S]*--b2_alt--[\s\S]*--b2\r\nContent-Type: application\/pdf/)
  })
  it('7. google-gmail-send builds HTML only for format "markdown", from the stored text (never from the request)', () => {
    const h = src('supabase/functions/google-gmail-send/handler.ts')
    assert.match(h, /const formatted = body\.format === 'markdown'/)
    assert.match(h, /html: formatted \? markdownToHtml\(e\.body \?\? ''\) : null/)
    assert.doesNotMatch(h, /body\.html|body\.body_html/)
  })
})

describe('editor → markup', () => {
  it('8. plain text stays exactly as typed (no escapes, no format flag)', () => {
    const r = editorToMarkup(doc(E('DIV', [T('Price 2*3 [approx] ravi_k@x.example')]), E('DIV', [T('- typed dash')])))
    assert.deepEqual(r, { text: 'Price 2*3 [approx] ravi_k@x.example\n- typed dash', formatted: false })
  })
  it('9. bold, italic, underline (tags or inline styles) and links', () => {
    const r = editorToMarkup(doc(E('DIV', [E('B', [T('Dispatched')]), T(' '), E('SPAN', [T('today')], {}, { fontStyle: 'italic' }), T(' '), E('U', [T('now')]), T(' '),
      E('A', [T('track')], { href: 'https://t.example/1' })])))
    assert.deepEqual(r, { text: '**Dispatched** *today* ++now++ [track](https://t.example/1)', formatted: true })
  })
  it('10. lists from the editor are lists; typed "- " lines are escaped once formatting is used; literal * escaped', () => {
    const r = editorToMarkup(doc(E('DIV', [E('B', [T('Items')])]), E('UL', [E('LI', [T('Basin')]), E('LI', [T('Tap')])]), E('OL', [E('LI', [T('Pay')])]), E('DIV', [T('- typed 2*3')])))
    assert.equal(r.formatted, true)
    assert.equal(r.text, '**Items**\n- Basin\n- Tap\n1. Pay\n\\- typed 2\\*3')
    assert.match(markdownToHtml(r.text), /<ul[^>]*><li>Basin<\/li><li>Tap<\/li><\/ul><ol[^>]*><li>Pay<\/li><\/ol><p[^>]*>- typed 2\*3<\/p>/)
  })
  it('11. unsafe links are dropped (text kept)', () => {
    assert.deepEqual(editorToMarkup(doc(E('DIV', [E('A', [T('click')], { href: 'javascript:alert(1)' })]))), { text: 'click', formatted: false })
  })
  it('12. drafts are restored through the escaping converter (never raw HTML)', () => {
    assert.equal(editorHtml('<b>x</b>', false), '<div>&lt;b&gt;x&lt;/b&gt;</div>')
    assert.doesNotMatch(editorHtml('**<img src=x onerror=1>**', true), /<img/)
  })
})

describe('search', () => {
  it('13. Gmail-style operators', () => {
    assert.deepEqual(parseMailSearch('from:ravi to:"Meera Shah" subject:invoice has:attachment is:unread after:2026/11/01 before:20/11/2026 cracked basin'),
      { from: 'ravi', to: 'Meera Shah', subject: 'invoice', has_attachment: true, unread: true, after: '2026-11-01', before: '2026-11-20', q: 'cracked basin' })
    assert.deepEqual(parseMailSearch('is:read'), { unread: false })
    assert.deepEqual(parseMailSearch('url:http://x before:31/02/2026'), { q: 'url:http://x before:31/02/2026' })
  })
  it('14. the advanced panel writes the same operators back', () => {
    const s = { from: 'ravi', to: 'Meera Shah', has_attachment: true, after: '2026-11-01', words: 'cracked' }
    assert.equal(formatMailSearch(s), 'from:ravi to:"Meera Shah" has:attachment after:2026-11-01 cracked')
    assert.deepEqual(parseMailSearch(formatMailSearch(s)), { from: 'ravi', to: 'Meera Shah', has_attachment: true, after: '2026-11-01', q: 'cracked' })
  })
  it('15. dates: ISO, slashes, day-first; impossible dates refused', () => {
    assert.equal(toIsoDate('2026/1/5'), '2026-01-05')
    assert.equal(toIsoDate('05-01-2026'), '2026-01-05')
    assert.equal(toIsoDate('2026-02-30'), null)
  })
})

describe('list and thread', () => {
  const NOW = new Date('2026-11-20T10:00:00Z')
  it('16. list dates: time today, day and month this year, full date before', () => {
    assert.equal(mailListDate('2026-11-20T04:00:00Z', NOW, 'Asia/Kolkata'), '9:30 am')
    assert.equal(mailListDate('2026-11-12T04:00:00Z', NOW, 'Asia/Kolkata'), '12 Nov')
    assert.equal(mailListDate('2025-11-12T04:00:00Z', NOW, 'Asia/Kolkata'), '12/11/2025')
  })
  it('17. page label and total', () => {
    assert.equal(pageLabel(0, 50, 312), '1–50 of 312')
    assert.equal(pageLabel(300, 12, 312), '301–312 of 312')
    assert.equal(pageLabel(0, 0, 0), '0 of 0')
  })
  it('18. snooze choices are in the future, in order', () => {
    const now = new Date('2026-11-20T10:15:00')
    const c = snoozeChoices(now)
    assert.deepEqual(c.map((x) => x.key), ['later', 'tomorrow', 'weekend', 'week'])
    assert.ok(c.every((x) => x.at > now))
    assert.equal(c[1].at.getHours(), 8)
    assert.equal(c[2].at.getDay(), 6)
    assert.equal(c[3].at.getDay(), 1)
  })
  it('19. thread: the last and the unread messages start expanded', () => {
    assert.deepEqual([...initiallyExpanded([{ id: 'a', unread: false }, { id: 'b', unread: true }, { id: 'c', unread: false }, { id: 'd', unread: false }])], ['b', 'd'])
  })
  it('20. forward: subject and quoted header block', () => {
    assert.equal(forwardSubject('Cracked basin'), 'Fwd: Cracked basin')
    assert.equal(forwardSubject('Fwd: Cracked basin'), 'Fwd: Cracked basin')
    const e = { from_name: 'Ravi', from_address: 'ravi@c.example', subject: 'Cracked basin', to: [{ email: 'support@alton.example', name: null }], cc: [], body_text: 'It is cracked.' } as unknown as ThreadEmail
    assert.match(forwardBlock(e, '12 Nov 2026'), /---------- Forwarded message ---------\nFrom: Ravi <ravi@c\.example>\nDate: 12 Nov 2026\nSubject: Cracked basin\nTo: support@alton\.example\n\nIt is cracked\./)
  })
  it('21. print view escapes everything (never the email\'s own HTML)', () => {
    const h = printHtml('<b>S</b>', [{ from: 'a', to: 'b', date: 'd', body: '<script>x</script>' }])
    assert.doesNotMatch(h, /<script>|<b>S/)
  })
})

describe('wiring and safety', () => {
  it('22. no OAuth tokens or provider secrets in the email screens; Google is never called from the browser', () => {
    assert.doesNotMatch(all, /refresh_token|access_token|client_secret|googleapis\.com|gmail\.googleapis/)
  })
  it('23. sending and receiving stay on the existing services (sendEmail → google-gmail-send); no new Edge Function', () => {
    assert.match(src(`${dir}/compose-window.tsx`), /await sendEmail\(\{ idempotency_key: key/)
    assert.doesNotMatch(all, /functions\.invoke/)
    assert.deepEqual(readdirSync(path.join(root, 'supabase/functions')).filter((f) => f.startsWith('google-')).sort(),
      ['google-gmail-send', 'google-gmail-sync', 'google-gmail-watch-renew', 'google-gmail-webhook', 'google-oauth-callback', 'google-oauth-start'])
  })
  it('24. one request per click: in-flight guard and one idempotency key per email', () => {
    const c = src(`${dir}/compose-window.tsx`)
    assert.match(c, /if \(inFlight\.current \|\| result\) return/)
    assert.match(c, /const tryAgain = \(\) => \{ setKey\(crypto\.randomUUID\(\)\)/)
  })
  it('25. the editor never sends HTML: paste is plain text, the value is markup', () => {
    const e = src(`${dir}/rich-editor.tsx`)
    assert.match(e, /e\.clipboardData\.getData\('text\/plain'\)/)
    assert.doesNotMatch(src(`${dir}/compose-window.tsx`), /innerHTML|body_html/)
  })
  it('26. delete is "move to Trash": no delete-forever action exists', () => {
    assert.doesNotMatch(all, /DELETE_FOREVER|deleteForever/)
    assert.match(src(`${dir}/mail-list.tsx`), /Delete \(move to Trash; history is kept\)/)
  })
  it('27. the migration is additive: ingest, send and stored emails untouched', () => {
    const m = src('supabase/migrations/20261222090000_email_mailbox.sql')
    assert.doesNotMatch(m, /function public\.support_gmail_|function public\.support_email_thread\(|update public\.support_email_messages|delete from public\.support_email_messages/)
    assert.match(m, /revoke all on table public\.support_email_thread_state from anon, authenticated/)
    assert.match(m, /\('support\.email',\s+'Support Centre',\s+'Email draft',\s+array\['support\.reply'\]\)/)
  })
})
