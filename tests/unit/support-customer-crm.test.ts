// Support customer CRM (migration 20261228090000): customer form checks, matching input, timeline links, the one
// field system for tickets and customers, and the wiring of the profile page, New Ticket matching and settings.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { addressLine, checkCustomerValues, emptyCustomer, initials, lookupKeys, timelineHref } from '../../src/features/support/customers/customer-model.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const src = (p: string) => readFileSync(path.join(root, p), 'utf8')
const vals = (o: Partial<ReturnType<typeof emptyCustomer>>) => ({ ...emptyCustomer(), display_name: 'Meera', ...o })

describe('customer form checks', () => {
  it('name required; phones, emails, GSTIN and PIN validated', () => {
    assert.equal(checkCustomerValues(vals({ display_name: ' ' })).display_name, 'Enter the customer name.')
    assert.ok(checkCustomerValues(vals({ mobile: '12' })).mobile)
    assert.equal(checkCustomerValues(vals({ mobile: '+91 98200 11111', landline: '022 2345 6789' })).mobile, undefined)
    assert.ok(checkCustomerValues(vals({ alternate_email: 'a@b' })).alternate_email)
    assert.ok(checkCustomerValues(vals({ gstin: '27ABC' })).gstin)
    assert.equal(checkCustomerValues(vals({ gstin: '27aaacs1234f1z5' })).gstin, undefined)
    assert.ok(checkCustomerValues(vals({ pin_code: '12345' })).pin_code)
    assert.equal(checkCustomerValues(vals({ pin_code: 'SW1A 1AA', country: 'United Kingdom' })).pin_code, undefined)
  })
  it('new customers default to India', () => assert.equal(emptyCustomer().country, 'India'))
  it('initials and address line', () => {
    assert.equal(initials('meera shah builders'), 'MS')
    assert.equal(addressLine({ address: 'Plot 4', city: 'Pune', state: 'MH', pin_code: '411001', country: 'India' }), 'Plot 4 · Pune, MH · 411001 · India')
    assert.equal(addressLine({ address: null, city: null, state: null, pin_code: null, country: null }), null)
  })
})

describe('matching input', () => {
  it('looks up only usable phones / emails', () => {
    assert.equal(lookupKeys('12', 'x'), null)
    assert.deepEqual(lookupKeys(' 98200 11111 ', ''), { phone: '98200 11111', email: null })
    assert.deepEqual(lookupKeys('', ' a@b.co '), { phone: null, email: 'a@b.co' })
  })
})

describe('timeline links', () => {
  it('every event opens its real record', () => {
    assert.equal(timelineHref({ link_type: 'TICKET', link_id: 't1', channel: null }, 'c'), '/support/tickets/t1')
    assert.equal(timelineHref({ link_type: 'CALL', link_id: 'k1', channel: 'PHONE' }, 'c'), '/support/calls/k1')
    assert.equal(timelineHref({ link_type: 'CONVERSATION', link_id: 'v1', channel: 'EMAIL' }, 'c'), '/support/emails?c=v1')
    assert.equal(timelineHref({ link_type: 'CONVERSATION', link_id: 'v1', channel: 'WHATSAPP' }, 'c'), '/support/whatsapp?c=v1')
    assert.equal(timelineHref({ link_type: 'NOTE', link_id: 'n1', channel: null }, 'c'), '/support/customers/c?tab=notes')
  })
})

describe('migration rules', () => {
  const m = src('supabase/migrations/20261228090000_support_customer_crm.sql')
  it('one field system with a module discriminator; no second definitions table, no second customer table', () => {
    assert.match(m, /alter table public\.support_ticket_field_definitions add column if not exists module/)
    assert.doesNotMatch(m, /create table if not exists public\.support_customer_field_definitions|create table if not exists public\.support_customers /)
    assert.match(m, /unique \(company_id, module, field_key\)/)
  })
  it('customer saving reuses the existing save (numbering, duplicate check)', () => {
    assert.match(m, /r := public\.support_customer_save\(p_id, jsonb_build_object/)
  })
  it('tickets keep a single link to the customer (support_tickets.customer_id); no copied ticket history', () => {
    assert.doesNotMatch(m, /create table[^;]*support_customer_tickets/)
    assert.match(m, /t\.customer_id = c\.id/)
  })
  it('matching uses the GIN indexes on the normalised phones / emails', () => {
    assert.match(m, /c\.normalized_phones @> array\[v_ph\]/)
    assert.match(m, /c\.normalized_emails @> array\[v_em\]/)
  })
  it('the timeline never shows message bodies', () => {
    const tl = m.slice(m.indexOf('function public.support_customer_timeline'), m.indexOf('function public.support_customer_records'))
    assert.doesNotMatch(tl, /body_text|body_html|media_caption/)
  })
  it('ticket wrappers run as the caller; the generic functions check permissions', () => {
    assert.equal((m.match(/security invoker/g) ?? []).length, 3)
    assert.match(m, /private\.require_permission\(private\.support_field_permission\(p_module, 'view'\)\)/)
  })
})

describe('wiring', () => {
  it('Support Settings → Custom fields with Ticket Fields / Customer Fields', () => {
    const p = src('src/pages/support/support-settings-page.tsx')
    assert.match(p, /label: 'Custom fields'/)
    assert.match(p, /label: 'Ticket Fields'/)
    assert.match(p, /label: 'Customer Fields'/)
    assert.match(p, /module=\{current === 'customer' \? 'CUSTOMER' : 'TICKET'\}/)
  })
  it('ticket fields keep their own database functions (work before the customer update)', () => {
    assert.match(src('src/services/ticket-fields.ts'), /module === 'TICKET' \? rpc<FieldsAdmin>\('support_ticket_fields_admin'\)/)
  })
  it('New Ticket lists matching customers and never picks one by itself', () => {
    const f = src('src/features/support/ticket-fields/new-ticket-form.tsx')
    assert.match(f, /<CustomerMatchPanel/)
    const panel = src('src/features/support/customers/customer-match-panel.tsx')
    assert.match(panel, /choose the right one/)
    assert.doesNotMatch(panel, /useEffect\([^)]*onPick/)
  })
  it('the profile page falls back to the earlier page before the database update', () => {
    assert.match(src('src/pages/support/support-customer-profile-page.tsx'), /if \(!q\.data\) return <LegacyCustomerProfile customerId=\{customerId\} \/>/)
  })
})
