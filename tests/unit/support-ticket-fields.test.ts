// Support ticket field builder and Product Master links (migration 20261226090000): value rules, the formula
// language (parsed, never executed), layout helpers and the wiring of the builder, New Ticket form and ticket page.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  FIELD_TYPES, checkDefinition, checkFieldValue, displayValue, evaluateFormula, formulaInputsOf, formulaRefs, moveItem, parseFormula, previewKey, sameLayout, toInput,
  type FieldDefinition, type FieldType,
} from '../../src/features/support/ticket-fields/field-model.ts'
import { productDetail, quantityError } from '../../src/features/support/ticket-fields/product-model.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const src = (p: string) => readFileSync(path.join(root, p), 'utf8')
const def = (field_type: FieldType, field_config: FieldDefinition['field_config'] = {}, field_label = 'Field') => ({ field_type, field_config, field_label })

describe('field values', () => {
  it('twelve field types', () => {
    assert.deepEqual([...FIELD_TYPES].sort(), ['CHECKBOX', 'CURRENCY', 'DATE', 'EMAIL', 'FORMULA', 'LOOKUP', 'NUMBER', 'PHONE', 'PICKLIST', 'TEXT', 'URL', 'USER'])
  })
  it('empty input is no value; text limits', () => {
    assert.deepEqual(checkFieldValue(def('TEXT'), '  '), { value: null })
    assert.equal(checkFieldValue(def('TEXT', { min_length: 3, max_length: 5 }, 'Ref'), 'ab').error, 'Ref needs at least 3 characters.')
    assert.equal(checkFieldValue(def('TEXT', { min_length: 3, max_length: 5 }, 'Ref'), 'abcdef').error, 'Ref can have at most 5 characters.')
    assert.equal(checkFieldValue(def('TEXT'), ' x ').value, 'x')
  })
  it('numbers: integer, decimals, min / max', () => {
    const int = def('NUMBER', { number_kind: 'INTEGER', decimals: 0, min: 1, max: 10 }, 'Units')
    assert.equal(checkFieldValue(int, '2.5').error, 'Units must be a whole number.')
    assert.equal(checkFieldValue(int, '0').error, 'Units must be at least 1.')
    assert.equal(checkFieldValue(int, '11').error, 'Units must be at most 10.')
    assert.equal(checkFieldValue(int, 'x').error, 'Units must be a number.')
    assert.equal(checkFieldValue(int, '3').error, undefined)
    assert.equal(checkFieldValue(def('NUMBER', { decimals: 2 }), '1.234').error, 'Field can have at most 2 decimals.')
    assert.equal(checkFieldValue(def('NUMBER', { decimals: 2 }), '1.230').error, undefined)
  })
  it('currency: amount with the field currency (INR by default)', () => {
    assert.deepEqual(checkFieldValue(def('CURRENCY', {}), '1500.50').value, { amount: '1500.50', currency: 'INR' })
    assert.match(checkFieldValue(def('CURRENCY', {}), '1.555').error ?? '', /at most 2 decimals/)
  })
  it('date, email, phone and URL formats', () => {
    assert.equal(checkFieldValue(def('DATE'), '2026-02-30').error, 'Field must be a date (YYYY-MM-DD).')
    assert.equal(checkFieldValue(def('DATE'), '2024-02-29').error, undefined)
    assert.equal(checkFieldValue(def('EMAIL'), 'A@B.Example').value, 'a@b.example')
    assert.ok(checkFieldValue(def('EMAIL'), 'a@b').error)
    assert.ok(checkFieldValue(def('PHONE'), '12ab').error)
    assert.equal(checkFieldValue(def('PHONE'), '+91 (22) 4000-1234').error, undefined)
    assert.ok(checkFieldValue(def('URL'), 'javascript:alert(1)').error)
    assert.ok(checkFieldValue(def('URL'), 'ftp://a.example').error)
    assert.equal(checkFieldValue(def('URL'), 'https://a.example/x?y=1').error, undefined)
  })
  it('picklist, user and lookup send the id; formula values are never entered; checkbox is a boolean', () => {
    const pick = def('PICKLIST', { options: [{ id: 'opt_a', label: 'A' }] })
    assert.equal(checkFieldValue(pick, { id: 'opt_a', label: 'A' }).value, 'opt_a')
    assert.ok(checkFieldValue(pick, 'opt_zz').error)
    assert.equal(checkFieldValue(def('USER'), { id: 'u1', label: 'Ravi' }).value, 'u1')
    assert.match(checkFieldValue(def('FORMULA', {}, 'Total'), '5').error ?? '', /calculated/)
    assert.equal(checkFieldValue(def('CHECKBOX'), false).value, false)
  })
  it('stored values back to inputs and to text (removed picklist options stay readable)', () => {
    const pick = def('PICKLIST', { options: [{ id: 'opt_a', label: 'Damaged' }] })
    assert.deepEqual(toInput(pick, { id: 'opt_a', label: 'Old label' }), { id: 'opt_a', label: 'Damaged' })
    assert.equal(displayValue(pick, { id: 'opt_gone', label: 'Wrong item' }), 'Wrong item (removed option)')
    assert.equal(toInput(def('CURRENCY'), { amount: 12.5, currency: 'INR' }), '12.5')
    assert.equal(displayValue(def('CHECKBOX'), true), 'Yes')
    assert.equal(displayValue(def('TEXT'), null), '—')
    assert.match(displayValue(def('CURRENCY'), { amount: 1500.5, currency: 'INR' }), /1,500\.50/)
    assert.equal(displayValue(def('DATE'), '2026-10-02'), '02 Oct 2026')
  })
})

describe('formulas', () => {
  it('numbers, fields, + - * / ( ), ROUND MIN MAX ABS; precedence', () => {
    assert.equal(evaluateFormula('1 + 2 * 3', {}), 7)
    assert.equal(evaluateFormula('(1 + 2) * 3', {}), 9)
    assert.equal(evaluateFormula('ROUND({a} / {b}, 2)', { a: 10, b: 3 }), 3.33)
    assert.equal(evaluateFormula('MAX({a}, 2, 7) - MIN(4, 2)', { a: 5 }), 5)
    assert.equal(evaluateFormula('ABS(-2) * -1', {}), -2)
    assert.equal(evaluateFormula('{a} * 2', { a: { amount: 4, currency: 'INR' } }), 8)
  })
  it('missing inputs and division by zero give no result (shown as —)', () => {
    assert.equal(evaluateFormula('{a} + 1', {}), null)
    assert.equal(evaluateFormula('1 / {a}', { a: 0 }), null)
    assert.equal(displayValue(def('FORMULA', { expression: '{a} + 1' }), null, {}), '—')
  })
  it('anything else is refused with a readable message', () => {
    for (const [e, m] of [['1 +', /ends/], ['foo(1)', /Unknown function/], ['1; drop table x', /not allowed/], ['(1', /never closed/], ['1 2', /missing an operator/],
      ['MIN(1)', /at least two/], ['ABS(1, 2)', /one value/], ['ROUND 1', /brackets/], ['window.alert(1)', /not allowed|Unknown function/], ['', /Enter the formula/]] as const) {
      assert.throws(() => parseFormula(e), m, e)
    }
  })
  it('references are listed once', () => {
    assert.deepEqual(formulaRefs('{a} + {b} * {a}'), ['a', 'b'])
  })
  it('the formula code never executes text (no eval / Function)', () => {
    const model = src('src/features/support/ticket-fields/field-model.ts')
    assert.doesNotMatch(model, /\beval\(|new Function\(|Function\(/)
  })
  it('formula inputs come from number and currency fields only', () => {
    assert.deepEqual(formulaInputsOf([{ field_key: 'a', field_type: 'NUMBER' }, { field_key: 't', field_type: 'TEXT' }, { field_key: 'c', field_type: 'CURRENCY' }],
      { a: '2', t: '5', c: 'x' }), { a: 2 })
  })
})

describe('field builder', () => {
  it('moving items; comparing layouts (order and required flags)', () => {
    assert.deepEqual(moveItem(['a', 'b', 'c'], 0, 2), ['b', 'c', 'a'])
    assert.deepEqual(moveItem(['a', 'b', 'c'], 2, 0), ['c', 'a', 'b'])
    assert.ok(sameLayout([{ standard_key: 'subject' }], [{ standard_key: 'subject', is_required: null }]))
    assert.ok(!sameLayout([{ standard_key: 'subject' }, { field_definition_id: 'x' }], [{ field_definition_id: 'x' }, { standard_key: 'subject' }]))
    assert.ok(!sameLayout([{ field_definition_id: 'x', is_required: true }], [{ field_definition_id: 'x' }]))
  })
  it('generated key preview matches the database rule', () => {
    assert.equal(previewKey('Complaint Type!'), 'cf_complaint_type')
    assert.equal(previewKey('!!!'), 'cf_field')
  })
  it('definition checks before saving', () => {
    assert.equal(checkDefinition({ field_label: '', field_type: 'TEXT', field_config: {}, is_required: false }), 'Enter the field label.')
    assert.match(checkDefinition({ field_label: 'P', field_type: 'PICKLIST', field_config: { options: [{ label: 'a' }, { label: 'A' }] }, is_required: false }) ?? '', /listed twice/)
    assert.match(checkDefinition({ field_label: 'C', field_type: 'CHECKBOX', field_config: {}, is_required: true }) ?? '', /cannot be required/)
    assert.match(checkDefinition({ field_label: 'F', field_type: 'FORMULA', field_config: { expression: '1 +' }, is_required: false }) ?? '', /ends/)
    assert.equal(checkDefinition({ field_label: 'L', field_type: 'LOOKUP', field_config: {}, is_required: false }), 'Choose what the lookup links to.')
  })
  it('product helpers', () => {
    assert.equal(quantityError('0'), 'Quantity must be more than 0 (at most 3 decimals).')
    assert.equal(quantityError('1.5'), null)
    assert.ok(quantityError('1.2345'))
    assert.equal(productDetail({ model_number: 'WHB-500', barcode: null, ean: '4006381333931' }), 'Code WHB-500 · EAN 4006381333931')
  })
})

describe('wiring', () => {
  it('Support → Settings → Ticket fields, only with support_ticket_fields.view; unsaved changes guarded', () => {
    const page = src('src/pages/support/support-settings-page.tsx')
    // Renamed "Custom fields" (Ticket Fields / Customer Fields) by 20261228090000.
    assert.match(page, /perms\.ticketFields \|\| perms\.customerFields \? \[\{ value: 'fields' as Tab, label: 'Custom fields' \}\]/)
    assert.match(page, /fieldsDirty\.current && next !== 'fields' && !window\.confirm/)
    const builder = src('src/features/support/ticket-fields/field-builder.tsx')
    assert.match(builder, /beforeunload/)
    assert.match(builder, /Add Custom Field/)
    assert.match(builder, /badgeCount\(admin\.active_custom\)/)
    assert.match(builder, /draggable=/)
  })
  it('New Ticket uses the configured form when the database has it, the earlier form otherwise', () => {
    const dialogs = src('src/features/support/support-dialogs.tsx')
    assert.match(dialogs, /fetchTicketForm\(\)\.catch\(\(\) => null\)/)
    assert.match(dialogs, /if \(!layout\.data\) return <TicketForm \{\.\.\.props\} \/>/)
    const form = src('src/features/support/ticket-fields/new-ticket-form.tsx')
    assert.match(form, /createTicketWithFields/)
    assert.match(form, /Every key is sent \(null when empty\)/)
    assert.match(form, /sm:grid-cols-2/)
  })
  it('ticket page shows custom fields and products with Edit', () => {
    assert.match(src('src/pages/support/support-ticket-detail-page.tsx'), /<TicketExtrasCards ticketId=\{t\.id\}/)
    const extras = src('src/features/support/ticket-fields/ticket-extras.tsx')
    assert.match(extras, /x\.can\.edit_fields/)
    assert.match(extras, /x\.can\.manage_products/)
  })
  it('product search is server-side with a short debounce; the real product id is saved', () => {
    const picker = src('src/features/support/ticket-fields/product-picker.tsx')
    assert.match(picker, /setTimeout\(\(\) => setDebounced\(term\.trim\(\)\), 250\)/)
    assert.match(picker, /searchTicketProducts\(debounced, includeArchived\)/)
    assert.match(src('src/services/ticket-fields.ts'), /support_ticket_product_search/)
  })
})

describe('migration', () => {
  const m = src('supabase/migrations/20261226090000_support_ticket_fields.sql')
  it('additive: no existing ticket data changed, no product table created', () => {
    assert.doesNotMatch(m, /drop table|delete from public\.support_tickets|update public\.support_tickets set (?!updated_by)/)
    assert.doesNotMatch(m, /create table if not exists public\.products/)
    assert.match(m, /references public\.products \(id, company_id\)/)
  })
  it('the 25-field limit and the stable key are enforced by a trigger', () => {
    assert.match(m, /at most 25 active custom ticket fields/)
    assert.match(m, /before insert or update on public\.support_ticket_field_definitions/)
  })
  it('the existing ticket creation is reused (numbering, SLA and automation unchanged)', () => {
    assert.match(m, /r := public\.support_ticket_create\(p - 'custom_fields' - 'products' - 'allow_archived_products'\)/)
    assert.doesNotMatch(m, /create or replace function public\.support_ticket_create\(/)
    assert.doesNotMatch(m, /function private\.support_(apply_sla|next_number)\(/)
  })
})
