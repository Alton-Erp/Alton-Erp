// Email attachments of every format (no migration): what the Gmail sync records for each MIME part is shown in the
// thread with its original name, type and size; embedded (inline) images are returned like any other file; blocked,
// too-large and failed parts are listed, one failure never hides the rest; Retry re-fetches failed parts only; the
// private bucket's policies decide who may read a file; paths cannot leave the email's folder.
//
//   npm run test:db:email-attachment-formats
//
// Local PGlite database only. The Edge Function's part (download + upload) is played by the service role.

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p) => readFile(p, 'utf8')
const migDir = path.join(root, 'supabase', 'migrations')
const db = new PGlite()
await db.exec(await read(path.join(root, 'supabase', 'tests', 'local_supabase_shim.sql')))
for (const f of (await readdir(migDir)).filter((x) => x.endsWith('.sql')).sort()) await db.exec(await read(path.join(migDir, f)))
let suite = await read(path.join(root, 'supabase', 'tests', 'stage7_e2e_verification.sql'))
suite = suite.slice(0, suite.lastIndexOf('\ndo $$'))
await db.exec(suite)
await db.exec('commit')

let failed = 0
let passed = 0
const ok = (name, cond, detail = '') => {
  if (cond) passed++
  else failed++
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 900)}`}`)
}
const val = async (sql, params) => { await db.exec('reset role'); return Object.values((await db.query(sql, params)).rows[0] ?? {})[0] }
async function request(user, sql, params) {
  await db.exec('reset role')
  await db.exec('begin')
  try {
    if (user) await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: await val(`select rls_test.id($1)`, [user]), role: 'authenticated' })])
    else await db.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`)
    await db.exec(`set local role ${user ? 'authenticated' : 'service_role'}`)
    const r = await db.query(sql, params)
    await db.exec('commit')
    return { value: Object.values(r.rows[0] ?? {})[0] }
  } catch (e) {
    try { await db.exec('rollback') } catch { /* ended */ }
    return { error: e.message }
  }
}
const as = (user) => async (sql, params) => { const r = await request(user, sql, params); if (r.error) throw new Error(`${user ?? 'service'}: ${sql.slice(0, 90)}… → ${r.error}`); return r.value }
const op = as('op')
const svc = as(null)
const refused = async (user, sql, params, pattern) => { const r = await request(user, sql, params); return Boolean(r.error) && (!pattern || pattern.test(r.error)) }

await db.exec(`reset role; insert into public.roles (code, name, is_system) values ('AF_AGENT_TEST', 'Mail agent (test)', false);
  insert into public.role_permissions (role_id, permission_id) select r.id, p.id from public.roles r, public.permissions p
  where r.code = 'AF_AGENT_TEST' and p.code in ('support.view', 'support.reply')`)
for (const [key, uuid, role] of [['af_agent', 'e7e5d300-0000-4000-8000-0000000000a1', 'AF_AGENT_TEST'], ['af_none', 'e7e5d300-0000-4000-8000-0000000000a2', 'INVENTORY_MANAGER']]) {
  await db.exec(`reset role;
    insert into rls_test.ids (key, id) values ('${key}', '${uuid}');
    insert into auth.users (id, email) values (rls_test.id('${key}'), '${key}@e7.example.invalid');
    update public.profiles set company_id = rls_test.id('company_a'), is_active = true, full_name = '${key}' where id = rls_test.id('${key}');
    insert into public.user_roles (user_id, company_id, role_id) select rls_test.id('${key}'), rls_test.id('company_a'), id from public.roles where code = '${role}'`)
}

const A = await val(`select rls_test.id('company_a')::text`)
const OP = await val(`select rls_test.id('op')::text`)
const saved = await op(`select public.support_email_config_save('{"mailbox_address":"support@alton.example","display_name":"Alton Support"}'::jsonb)`)
const ACCOUNT = saved.config.channel_account_id
await op(`select public.support_gmail_oauth_begin($1)`, ['1'.padStart(64, '0')])
await svc(`select public.support_gmail_connect($1, '${OP}'::uuid, 'support@alton.example', 'q83vEjRWeJAbzd7wEjRWeJCrze8SNFZ4kKvN7xI0VniQ', 'AAAAAAAAAAAAAAAA', 1,
  array['https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/gmail.send'], '100')`, [ACCOUNT])

// One email with a file of every common format, as parseGmailMessage records the parts (names, types, sizes kept).
const FORMATS = [
  ['photo.jpg', 'image/jpeg'], ['scan.png', 'image/png'], ['anim.gif', 'image/gif'], ['pic.webp', 'image/webp'], ['old.bmp', 'image/bmp'], ['logo.svg', 'image/svg+xml'],
  ['fax.tiff', 'image/tiff'], ['fav.ico', 'image/x-icon'], ['iphone.HEIC', 'image/heic'],
  ['invoice.pdf', 'application/pdf'], ['letter.doc', 'application/msword'], ['report.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['old.xls', 'application/vnd.ms-excel'], ['stock.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'], ['rates.csv', 'text/csv'],
  ['deck.ppt', 'application/vnd.ms-powerpoint'], ['deck.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'], ['notes.txt', 'text/plain'],
  ['memo.rtf', 'application/rtf'], ['a.odt', 'application/vnd.oasis.opendocument.text'], ['a.ods', 'application/vnd.oasis.opendocument.spreadsheet'],
  ['a.odp', 'application/vnd.oasis.opendocument.presentation'], ['photos.zip', 'application/zip'], ['photos.rar', 'application/vnd.rar'], ['photos.7z', 'application/x-7z-compressed'],
  ['logs.tar', 'application/x-tar'], ['logs.gz', 'application/gzip'], ['voice.mp3', 'audio/mpeg'], ['voice.wav', 'audio/wav'], ['voice.m4a', 'audio/mp4'], ['voice.aac', 'audio/aac'],
  ['voice.ogg', 'audio/ogg'], ['voice.flac', 'audio/flac'], ['clip.mp4', 'video/mp4'], ['clip.mov', 'video/quicktime'], ['clip.avi', 'video/x-msvideo'], ['clip.mkv', 'video/x-matroska'],
  ['clip.webm', 'video/webm'], ['feed.xml', 'application/xml'], ['data.json', 'application/json'], ['page.html', 'text/html'], ['fwd.eml', 'message/rfc822'],
  ['outlook.msg', 'application/vnd.ms-outlook'], ['card.vcf', 'text/vcard'], ['invite.ics', 'text/calendar'],
  ['drawing.dwg', 'application/acad'], ['attachment.bin', 'application/x-unknown-thing'], ['notes', ''],
]
const parts = FORMATS.map(([n, t], i) => ({ part_id: String(i + 1), attachment_id: `ANGjdJ${i + 1}xx`, filename: n, mime_type: t, size: 1000 + i, content_id: null, inline: false }))
parts.push({ part_id: '0.1', attachment_id: 'ANGjdJcidxx', filename: 'image.png', mime_type: 'image/png', size: 300, content_id: 'logo1', inline: true })
parts.push({ part_id: '90', attachment_id: 'ANGjdJ90xx', filename: 'setup.exe', mime_type: 'application/octet-stream', size: 10, content_id: null, inline: false,
  state: 'BLOCKED', reason: '.exe files are not stored (executable or script).' })
parts.push({ part_id: '91', attachment_id: 'ANGjdJ91xx', filename: 'site visit.mp4', mime_type: 'video/mp4', size: 40 * 1048576, content_id: null, inline: false,
  state: 'TOO_LARGE', reason: 'Larger than the 10 MB limit.' })
parts.push({ part_id: '92', attachment_id: 'ANGjdJ92xx', filename: 'flaky.pdf', mime_type: 'application/pdf', size: 5000, content_id: null, inline: false })
const e = await svc(`select public.support_gmail_ingest($1, $2::jsonb)`, [ACCOUNT, JSON.stringify({ gmail_message_id: 'ffff000001', gmail_thread_id: 'thrf000001',
  label_ids: ['INBOX', 'UNREAD'], rfc_message_id: '<ffff000001@customer.example>', from: { email: 'ravi@customer.example', name: 'Ravi' }, to: [{ email: 'support@alton.example' }],
  subject: 'All the files', body_text: 'See attached.', internal_date: String(Date.parse('2026-11-20T09:00:00Z')), mime: {}, attachments: parts })])
const C = e.conversation_id

console.log('\nRecorded by the sync')
const recorded = await val(`select attachment_parts from public.support_email_messages where id = $1`, [e.email_id])
ok('every part is recorded with its name and type (unknown types and nameless fallbacks included)', recorded.length === parts.length
  && parts.every((p) => recorded.some((r) => r.part_id === p.part_id && r.filename === p.filename && r.mime_type === p.mime_type)))
ok('pending for download, blocked and too large ones kept with the reason', recorded.filter((r) => r.state === 'PENDING').length === parts.length - 2
  && recorded.find((r) => r.part_id === '90').state === 'BLOCKED' && recorded.find((r) => r.part_id === '91').state === 'TOO_LARGE')

// The attachment stage: each part downloaded and uploaded as is; one fails.
const pathOf = (p) => `${A}/email/${e.email_id}/${p.part_id}-${(p.filename || 'attachment').replace(/[^A-Za-z0-9._ -]/g, '_')}`
for (const p of parts.filter((x) => !x.state && x.part_id !== '92')) {
  await svc(`select public.support_gmail_attachment_result($1, $2, true, $3, $4, $5, $6)`, [e.email_id, p.part_id, pathOf(p), p.filename, p.mime_type || 'application/octet-stream', p.size])
}
await svc(`select public.support_gmail_attachment_failed($1, '92', 'Gmail API error 500: backend error')`, [e.email_id])
ok('a file path outside the email folder is refused', await refused(null, `select public.support_gmail_attachment_result($1, '1', true, $2, 'x', 'text/plain', 1)`,
  [e.email_id, `${A}/email/${e.email_id}/../../other/x`], /Invalid attachment path/))
ok('… and so is another company\'s folder', await refused(null, `select public.support_gmail_attachment_result($1, '1', true, $2, 'x', 'text/plain', 1)`,
  [e.email_id, `00000000-0000-4000-8000-000000000000/email/${e.email_id}/1-x`], /Invalid attachment path/))

console.log('\nShown in the thread')
const thread = await op(`select public.support_email_thread($1)`, [C])
const m = thread.find((x) => x.id === e.email_id)
const byName = Object.fromEntries(m.attachments.map((a) => [a.file_name, a]))
ok(`all ${FORMATS.length + 1} stored files listed, whatever the format`, m.attachments.length === FORMATS.length + 1, m.attachments.map((a) => a.file_name))
ok('original names, content types and sizes kept', FORMATS.every(([n, t], i) => byName[n] && byName[n].content_type === (t || 'application/octet-stream')
  && Number(byName[n].size_bytes) === 1000 + i && byName[n].storage_path === pathOf(parts[i])), FORMATS.filter(([n]) => !byName[n]))
ok('the embedded image (Content-ID) is returned, marked inline, with a readable path', byName['image.png']?.inline === true && Boolean(byName['image.png'].storage_path))
ok('ordinary files are not marked inline', FORMATS.every(([n]) => byName[n].inline === false))
const skipped = Object.fromEntries(m.skipped_attachments.map((a) => [a.filename, a.state]))
ok('blocked, too large and failed parts are listed (never silently dropped); the rest still show', skipped['setup.exe'] === 'BLOCKED' && skipped['site visit.mp4'] === 'TOO_LARGE'
  && skipped['flaky.pdf'] === 'FAILED' && m.attachments.length === FORMATS.length + 1, m.skipped_attachments)

console.log('\nRetry (historical files)')
const rows0 = Number(await val(`select count(*) from public.support_attachments where email_part_id is not null`))
const hist0 = await val(`select last_history_id from public.support_email_config where channel_account_id = $1`, [ACCOUNT])
await svc(`select public.support_gmail_sync_retry($1)`, [ACCOUNT]) // Support Settings → Email → Retry (through google-gmail-sync)
const after = await val(`select attachment_parts from public.support_email_messages where id = $1`, [e.email_id])
ok('Retry puts the failed part back in line (same Gmail message and part); stored files untouched', after.find((r) => r.part_id === '92').state === 'FAILED'
  && after.find((r) => r.part_id === '92').attempts === undefined && after.filter((r) => r.state === 'STORED').length === FORMATS.length + 1)
ok('… the mailbox checkpoint is not reset', (await val(`select last_history_id from public.support_email_config where channel_account_id = $1`, [ACCOUNT])) === hist0)
await svc(`select public.support_gmail_attachment_result($1, '92', true, $2, 'flaky.pdf', 'application/pdf', 5000)`, [e.email_id, pathOf(parts.at(-1))])
await svc(`select public.support_gmail_attachment_result($1, '92', true, $2, 'flaky.pdf', 'application/pdf', 5000)`, [e.email_id, pathOf(parts.at(-1))])
const m2 = (await op(`select public.support_email_thread($1)`, [C])).find((x) => x.id === e.email_id)
ok('once fetched it appears; storing twice keeps one row', m2.attachments.filter((a) => a.file_name === 'flaky.pdf').length === 1
  && Number(await val(`select count(*) from public.support_attachments where email_part_id is not null`)) === rows0 + 1)

console.log('\nAccess')
const P = pathOf(parts[0])
const bucket = await val(`select jsonb_build_object('public', public, 'limit', file_size_limit, 'types', allowed_mime_types) from storage.buckets where id = 'support-attachments'`)
ok('the private bucket is unchanged: not public, 25 MB, no type allow-list', bucket.public === false && Number(bucket.limit) === 26214400 && bucket.types === null, bucket)
ok('a file is readable by the company\'s agents', (await as('af_agent')(`select private.support_object_readable($1)`, [P])) === true)
ok('… not by a user without support.view', (await as('af_none')(`select private.support_object_readable($1)`, [P])) === false)
ok('… not by another company', (await as('b_op')(`select private.support_object_readable($1)`, [P])) === false)
ok('… nor by anyone for a path that is not a stored attachment', (await op(`select private.support_object_readable($1)`, [`${A}/email/${e.email_id}/../x`])) === false)
ok('the thread is refused without support.view', await refused('af_none', `select public.support_email_thread($1)`, [C], /support\.view/))
await db.exec(`reset role; update public.support_attachments set is_sensitive = true where file_name = 'invoice.pdf'`)
const agentInv = (await as('af_agent')(`select public.support_email_thread($1)`, [C])).find((x) => x.id === e.email_id).attachments.find((a) => a.file_name === 'invoice.pdf')
ok('a sensitive file: name shown, no path, restricted, for users without Manage tickets', agentInv.restricted === true && agentInv.storage_path === null
  && (await as('af_agent')(`select private.support_object_readable($1)`, [pathOf(parts[9])])) === false)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
