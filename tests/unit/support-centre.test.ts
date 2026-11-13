// Support Centre (migration 20261210090000): presentation model, validation and wiring.
// The rules (permissions, SLA, matching, channel health) run in the database: tests/db/support-centre-check.mjs.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { NAV_ITEMS, NAV_PERMISSIONS } from '../../src/config/navigation.ts'
import { PERMISSIONS } from '../../src/auth/permissions.ts'
import {
  INTEGRATION_META, SLA_META, TICKET_EXPORT_HEADERS, formatDuration, formatMinutes, integrationMeta, isEmail, normalizePhone, replyBlockedReason, splitList, ticketExportRows,
  validateCustomer, validateLog, validateTicket,
} from '../../src/features/support/support-model.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (...p: string[]) => readFileSync(path.join(root, ...p), 'utf8')
const migration = read('supabase', 'migrations', '20261210090000_support_centre.sql')

describe('Support Centre navigation and permissions', () => {
  it('a Support Centre section with the eleven requested pages', () => {
    const items = NAV_ITEMS.filter((i) => i.group === 'support')
    assert.deepEqual(items.map((i) => i.path), ['/support/overview', '/support/inbox', '/support/tickets', '/support/customers', '/support/calls', '/support/whatsapp',
      '/support/emails', '/support/knowledge-base', '/support/automation', '/support/reports', '/support/settings'])
    for (const i of items) assert.ok(NAV_PERMISSIONS[i.key]?.startsWith('support.'), i.key)
    assert.equal(NAV_PERMISSIONS['support-reports'], 'support.view_reports')
  })
  it('every page and sub-page has a component and a permission', () => {
    const routes = read('src', 'routes.ts')
    for (const p of ['/support/tickets/:ticketId', '/support/customers/:customerId', '/support/workspace']) assert.match(routes, new RegExp(`path: '${p}', permission: 'support\\.view'`))
    for (const f of ['overview', 'inbox', 'tickets', 'customers', 'calls', 'whatsapp', 'emails', 'knowledge-base', 'automation', 'reports', 'settings', 'ticket-detail', 'customer-profile', 'workspace']) {
      assert.ok(readdirSync(path.join(root, 'src', 'pages', 'support')).includes(`support-${f}-page.tsx`), f)
    }
  })
  it('the seven support permissions match the migration', () => {
    const codes = ['support.view', 'support.manage_tickets', 'support.assign', 'support.reply', 'support.manage_integrations', 'support.view_reports', 'support.manage_settings']
    for (const c of codes) {
      assert.ok((PERMISSIONS as readonly string[]).includes(c), c)
      const [resource, action] = c.split('.')
      assert.match(migration, new RegExp(`\\('${resource}', '${action}',`), c)
    }
  })
})

describe('Phone and email matching (same rules as the database)', () => {
  it('+91, 0 and spaces are ignored; short numbers are not phone numbers', () => {
    for (const v of ['+91 98765 43210', '09876543210', '9876543210', '91-98765-43210']) assert.equal(normalizePhone(v), '9876543210', v)
    assert.equal(normalizePhone('12'), null)
    assert.equal(normalizePhone(''), null)
    assert.equal(normalizePhone('+44 20 7946 0958'), '442079460958')
  })
  it('the database function uses the same rules', () => {
    assert.match(migration, /when length\(d\) = 12 and d like '91%' then right\(d, 10\)/)
    assert.match(migration, /when length\(d\) = 11 and d like '0%' then right\(d, 10\)/)
  })
  it('email check and list splitting', () => {
    assert.ok(isEmail('a@b.co') && !isEmail('nope') && !isEmail('a b@c.de'))
    assert.deepEqual(splitList('a@x.in, b@x.in;\na@x.in'), ['a@x.in', 'b@x.in'])
  })
})

describe('Form validation', () => {
  it('customer: name and at least one valid contact', () => {
    const base = { display_name: '', company_name: '', phones: '', emails: '', address: '', notes: '' }
    const e = validateCustomer(base)
    assert.ok(e.display_name && e.contact)
    assert.ok(validateCustomer({ ...base, display_name: 'X', phones: '12' }).phones)
    assert.ok(validateCustomer({ ...base, display_name: 'X', emails: 'bad' }).emails)
    assert.deepEqual(validateCustomer({ ...base, display_name: 'Ravi', phones: '+91 98765 43210' }), {})
  })
  it('ticket: subject and a customer, phone or email (not needed from a conversation)', () => {
    const t = { subject: 'ab', customer_id: '', customer_phone: '', customer_email: '', priority: 'NORMAL' as const, category: '', subcategory: '', department: '', description: '' }
    const e = validateTicket(t)
    assert.ok(e.subject && e.customer)
    assert.deepEqual(validateTicket({ ...t, subject: 'Cracked basin', conversation_id: 'c1' }), {})
    assert.ok(validateTicket({ ...t, subject: 'Cracked basin', customer_email: 'x' }).customer_email)
  })
  it('logged call needs a result; logged message needs text', () => {
    assert.ok(validateLog({ channel: 'PHONE', direction: 'INBOUND', body: '', call_status: '', duration: '', subject: '' }, null).call_status)
    assert.ok(validateLog({ channel: 'PHONE', direction: 'INBOUND', body: '', call_status: 'MISSED', duration: '1.5', subject: '' }, null).duration)
    assert.ok(validateLog({ channel: 'WHATSAPP', direction: 'INBOUND', body: ' ', call_status: '', duration: '', subject: '' }, null).body)
    assert.ok(validateLog({ channel: 'EMAIL', direction: 'INBOUND', body: 'hi', call_status: '', duration: '', subject: '' },
      { customer_id: '', contact_phone: '', contact_email: '', contact_name: '' }).contact)
  })
})

describe('Honest channel status', () => {
  it('the five statuses, and an unknown status is shown as Not Connected (never Connected)', () => {
    assert.deepEqual(Object.values(INTEGRATION_META).map((m) => m.label), ['Not Connected', 'Setup Required', 'Connected', 'Error', 'Reauthorization Required'])
    assert.equal(integrationMeta(undefined).label, 'Not Connected')
    assert.equal(integrationMeta('SOMETHING_ELSE').label, 'Not Connected')
  })
  it('a reply is possible only through a connected channel; calls are always logged', () => {
    assert.equal(replyBlockedReason('WHATSAPP', 'CONNECTED'), null)
    for (const s of ['NOT_CONNECTED', 'SETUP_REQUIRED', 'ERROR', 'REAUTHORIZATION_REQUIRED', null]) assert.ok(replyBlockedReason('EMAIL', s), String(s))
    assert.match(replyBlockedReason('PHONE', 'CONNECTED') ?? '', /log the call/)
  })
  it('the app never sends a channel status; only the server-side check sets it', () => {
    const service = read('src', 'services', 'support.ts')
    assert.doesNotMatch(service.slice(service.indexOf('export const saveChannelAccount'), service.indexOf('export async function fetchIntegrationEvents')), /status/)
    assert.match(migration, /grant execute on function public\.support_record_integration_health\(uuid, text, text, jsonb\) to service_role/)
  })
})

describe('Formatting and export', () => {
  it('durations', () => {
    assert.equal(formatMinutes(45), '45 min')
    assert.equal(formatMinutes(200), '3 h 20 min')
    assert.equal(formatMinutes(3000), '2 d 2 h')
    assert.equal(formatMinutes(null), '—')
    assert.equal(formatDuration(125), '2:05')
  })
  it('SLA states have labels and explanations', () => {
    for (const k of ['NO_SLA', 'ON_TRACK', 'AT_RISK', 'OVERDUE', 'MET', 'BREACHED']) assert.ok(SLA_META[k]?.label && SLA_META[k].hint, k)
  })
  it('ticket export: one row per ticket in header order, labels instead of codes', () => {
    const rows = ticketExportRows([{ ticket_number: 'ALT-SUP-000001', subject: 'Cracked basin', customer_name: 'Anita', customer_phone: null, customer_email: 'a@x.in', channel: 'EMAIL',
      category: 'Damage', subcategory: null, priority: 'URGENT', status: 'WAITING_CUSTOMER', department: 'Quality', assigned_agent: 'Op', created_at: '2026-11-13T10:00:00Z',
      first_response_at: null, due_at: null, resolved_at: null, sla_status: 'AT_RISK', merged_into: null, related_reference: null, csat_rating: 4 }], () => 'D')
    assert.equal(rows[0].length, TICKET_EXPORT_HEADERS.length)
    assert.deepEqual([rows[0][0], rows[0][5], rows[0][8], rows[0][9], rows[0][16], rows[0][19]], ['ALT-SUP-000001', 'Email', 'Urgent', 'Waiting for Customer', 'At risk', 4])
  })
})

describe('Date filters', () => {
  it('Today, Yesterday, This Week, This Month and Custom Range; Yesterday is the whole previous day', () => {
    const src = read('src', 'lib', 'date-range.ts')
    const block = src.slice(src.indexOf('export const SUPPORT_DATE_RANGE_PRESETS'), src.indexOf('export const EXTENDED_DATE_RANGE_PRESETS'))
    assert.deepEqual([...block.matchAll(/label: '([^']+)'/g)].map((m) => m[1]), ['Today', 'Yesterday', 'This Week', 'This Month', 'Custom Range'])
    const yesterday = src.slice(src.indexOf("case 'yesterday':"), src.indexOf("case 'this_week':"))
    assert.ok(yesterday.includes('now.getDate() - 1') && yesterday.includes('from: startOfDay(y), to: endOfDay(y)'), yesterday)
    for (const page of ['support-overview-page.tsx', 'support-reports-page.tsx', 'support-workspace-page.tsx']) assert.match(read('src', 'pages', 'support', page), /presets=\{SUPPORT_DATE_RANGE_PRESETS\}/, page)
  })
})

describe('Database safety', () => {
  it('additive: no drop, truncate or delete of existing tables; RLS on every support table; no anon grants', () => {
    const sql = migration.replace(/--.*$/gm, '')
    assert.doesNotMatch(sql, /\bdrop table\b|\btruncate\b/i)
    assert.doesNotMatch(sql, /grant [^;]* to anon/i)
    const tables = [...sql.matchAll(/create table if not exists public\.(support_[a-z_]+)/g)].map((m) => m[1])
    assert.equal(tables.length, 16)
    for (const t of tables) assert.ok(sql.includes(`'${t}'`), `${t} in the RLS loop`)
  })
  it('the rollback removes only what the migration adds', () => {
    const down = read('supabase', 'rollback', '20261210090000_support_centre_down.sql')
    for (const m of down.matchAll(/drop table if exists public\.([a-z_]+)/g)) assert.ok(m[1].startsWith('support_'), m[1])
  })
})
