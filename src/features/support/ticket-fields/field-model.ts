/**
 * Support ticket fields (migration 20261226090000): types, the value rules the database applies (same messages,
 * checked here first so the form can point at the field), the formula language and the field-builder layout.
 * Pure: no React, no network.
 */

export const FIELD_TYPES = ['PICKLIST', 'TEXT', 'NUMBER', 'LOOKUP', 'FORMULA', 'DATE', 'CURRENCY', 'EMAIL', 'PHONE', 'URL', 'CHECKBOX', 'USER'] as const
export type FieldType = (typeof FIELD_TYPES)[number]

export const FIELD_TYPE_META: Record<FieldType, { label: string; hint: string }> = {
  PICKLIST: { label: 'Picklist', hint: 'One option from a list' },
  TEXT: { label: 'Text', hint: 'Single line of text' },
  NUMBER: { label: 'Numerical', hint: 'Whole number or decimal' },
  LOOKUP: { label: 'Lookup', hint: 'Link to an ERP record' },
  FORMULA: { label: 'Formula', hint: 'Calculated from number fields' },
  DATE: { label: 'Date', hint: 'Date picker' },
  CURRENCY: { label: 'Currency', hint: 'Amount in a currency' },
  EMAIL: { label: 'Email', hint: 'Email address' },
  PHONE: { label: 'Phone', hint: 'Phone number' },
  URL: { label: 'URL', hint: 'Web address' },
  CHECKBOX: { label: 'Checkbox', hint: 'Ticked or not' },
  USER: { label: 'User', hint: 'Employee or support agent' },
}

export const LOOKUP_TARGETS = ['PRODUCT', 'SUPPORT_CUSTOMER', 'ERP_CUSTOMER', 'SALES_ORDER', 'INVOICE', 'SUPPORT_TICKET'] as const
export type LookupTarget = (typeof LOOKUP_TARGETS)[number]
export const LOOKUP_LABELS: Record<LookupTarget, string> = {
  PRODUCT: 'Product (Product Master)', SUPPORT_CUSTOMER: 'Support customer', ERP_CUSTOMER: 'ERP customer', SALES_ORDER: 'Sales order', INVOICE: 'Invoice', SUPPORT_TICKET: 'Support ticket',
}

export const MAX_CUSTOM_FIELDS = 25

export interface PicklistOption { id?: string; label: string }
export interface FieldConfig {
  options?: PicklistOption[]
  min_length?: number; max_length?: number
  number_kind?: 'INTEGER' | 'DECIMAL'; decimals?: number; min?: number; max?: number
  currency?: string
  target?: LookupTarget
  expression?: string; result_kind?: 'NUMBER' | 'CURRENCY'
  scope?: 'EMPLOYEES' | 'AGENTS'
}

export type Visibility = 'ALL_AGENTS' | 'TICKET_MANAGERS'
export interface FieldDefinition {
  id: string; field_key: string; field_label: string; field_type: FieldType; field_config: FieldConfig
  is_required: boolean; is_active: boolean; default_value: unknown; help_text: string | null; placeholder: string | null
  visibility: Visibility; created_at: string; updated_at: string; value_count?: number
}

export const STANDARD_KEYS = ['subject', 'customer', 'products', 'customer_phone', 'customer_email', 'priority', 'assigned_agent', 'category', 'subcategory', 'department', 'description'] as const
export type StandardKey = (typeof STANDARD_KEYS)[number]
export interface StandardField { standard_key: StandardKey; label: string; field_type: string; locked: boolean; required: boolean; required_editable: boolean }

export type FieldModule = 'TICKET' | 'CUSTOMER'
/** Wording of each field module in the builder. */
export const MODULE_META: Record<FieldModule, { form: string; record: string; plural: string }> = {
  TICKET: { form: 'New Ticket form', record: 'ticket', plural: 'tickets' },
  CUSTOMER: { form: 'customer form', record: 'customer', plural: 'customers' },
}
/** Customer system fields (set automatically). */
export const CUSTOMER_SYSTEM_FIELDS = [
  { key: 'customer_code', label: 'Customer Code' }, { key: 'customer_id', label: 'Customer ID' }, { key: 'company_id', label: 'Company ID' }, { key: 'created_at', label: 'Created At' },
] as const

/** System fields: shown in the builder, never on the form, never editable. */
export const SYSTEM_FIELDS = [
  { key: 'ticket_number', label: 'Ticket Number' }, { key: 'ticket_id', label: 'Ticket ID' }, { key: 'company_id', label: 'Company ID' }, { key: 'created_at', label: 'Created At' },
] as const

/** A field of the New Ticket form, as support_ticket_form returns it. */
export type FormField =
  | { kind: 'STANDARD'; standard_key: StandardKey; label: string; field_type: string; locked: boolean; required: boolean }
  | (FieldDefinition & { kind: 'CUSTOM'; required: boolean })

// ---------------------------------------------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------------------------------------------
export interface CurrencyValue { amount: number; currency: string }
export interface RefValue { id: string; label?: string; name?: string; target?: string }

/** What a form input holds for each type (strings while typing; the server stores typed JSON). */
export type InputValue = string | boolean | { id: string; label: string } | null

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
const URL_RE = /^https?:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:[0-9]{1,5})?([/?#]\S*)?$/i
const PHONE_RE = /^\+?[0-9 ()-]{6,24}$/

const isoDateOk = (s: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

/**
 * The value to send for one field, or an error message (the database runs the same rules). Empty input → null.
 */
export function checkFieldValue(d: Pick<FieldDefinition, 'field_label' | 'field_type' | 'field_config'>, input: InputValue): { value: unknown; error?: string } {
  const c = d.field_config ?? {}
  const L = d.field_label
  if (input === null || input === undefined) return { value: null }
  if (d.field_type === 'CHECKBOX') return { value: input === true || input === 'true' }
  if (typeof input === 'object') {
    if (d.field_type === 'PICKLIST' || d.field_type === 'USER' || d.field_type === 'LOOKUP') return { value: input.id }
    return { value: null, error: `${L}: enter a single value.` }
  }
  const s = String(input).trim()
  if (!s) return { value: null }
  switch (d.field_type) {
    case 'FORMULA': return { value: null, error: `${L} is calculated and cannot be entered.` }
    case 'TEXT': {
      const min = c.min_length ?? 0
      const max = c.max_length ?? 255
      if (s.length < min) return { value: s, error: `${L} needs at least ${min} characters.` }
      if (s.length > max) return { value: s, error: `${L} can have at most ${max} characters.` }
      return { value: s }
    }
    case 'NUMBER': {
      if (!/^-?\d{1,15}(\.\d+)?$/.test(s)) return { value: s, error: `${L} must be a number.` }
      const n = Number(s)
      if (c.number_kind === 'INTEGER' && !Number.isInteger(n)) return { value: s, error: `${L} must be a whole number.` }
      const decimals = c.decimals ?? 2
      if ((s.split('.')[1] ?? '').replace(/0+$/, '').length > decimals) return { value: s, error: `${L} can have at most ${decimals} decimals.` }
      if (c.min !== undefined && c.min !== null && n < c.min) return { value: s, error: `${L} must be at least ${c.min}.` }
      if (c.max !== undefined && c.max !== null && n > c.max) return { value: s, error: `${L} must be at most ${c.max}.` }
      return { value: s }
    }
    case 'CURRENCY': {
      if (!/^-?\d{1,13}(\.\d{1,2})?$/.test(s)) return { value: s, error: `${L} must be an amount with at most 2 decimals.` }
      const n = Number(s)
      if (c.min !== undefined && c.min !== null && n < c.min) return { value: s, error: `${L} must be at least ${c.min}.` }
      if (c.max !== undefined && c.max !== null && n > c.max) return { value: s, error: `${L} must be at most ${c.max}.` }
      return { value: { amount: s, currency: c.currency ?? 'INR' } }
    }
    case 'DATE': return isoDateOk(s) ? { value: s } : { value: s, error: `${L} must be a date (YYYY-MM-DD).` }
    case 'EMAIL': return s.length <= 320 && EMAIL_RE.test(s) ? { value: s.toLowerCase() } : { value: s, error: `${L} must be an email address such as name@example.com.` }
    case 'PHONE': {
      const digits = s.replace(/\D/g, '').length
      return PHONE_RE.test(s) && digits >= 6 && digits <= 15 ? { value: s } : { value: s, error: `${L} must be a phone number (6 to 15 digits, optionally starting with +).` }
    }
    case 'URL': return s.length <= 2048 && URL_RE.test(s) ? { value: s } : { value: s, error: `${L} must be a web address starting with http:// or https://.` }
    case 'PICKLIST': return (c.options ?? []).some((o) => o.id === s) ? { value: s } : { value: s, error: `Choose one of the options of ${L}.` }
    default: return { value: s }
  }
}

/** The form input for a stored value (ticket edit) or a default value (new ticket). */
export function toInput(d: Pick<FieldDefinition, 'field_type' | 'field_config'>, stored: unknown): InputValue {
  if (stored === null || stored === undefined) return d.field_type === 'CHECKBOX' ? false : null
  switch (d.field_type) {
    case 'CHECKBOX': return stored === true
    case 'CURRENCY': return typeof stored === 'object' ? String((stored as CurrencyValue).amount) : String(stored)
    case 'PICKLIST': {
      const id = typeof stored === 'object' ? (stored as RefValue).id : String(stored)
      const o = (d.field_config.options ?? []).find((x) => x.id === id)
      return { id, label: o?.label ?? (stored as RefValue).label ?? id }
    }
    case 'USER': return { id: (stored as RefValue).id, label: (stored as RefValue).name ?? (stored as RefValue).label ?? '' }
    case 'LOOKUP': return { id: (stored as RefValue).id, label: (stored as RefValue).label ?? '' }
    default: return String(stored)
  }
}

const money = (amount: number, currency: string) => {
  try {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 }).format(amount)
  } catch {
    return `${currency} ${amount.toFixed(2)}`
  }
}

/** A stored value as text for the ticket page. */
export function displayValue(d: Pick<FieldDefinition, 'field_type' | 'field_config'>, stored: unknown, inputs: Record<string, unknown> = {}): string {
  if (d.field_type === 'FORMULA') {
    const r = evaluateFormula(d.field_config.expression ?? '', inputs)
    if (r === null) return '—'
    const dec = d.field_config.decimals ?? 2
    return d.field_config.result_kind === 'CURRENCY' ? money(r, d.field_config.currency ?? 'INR') : r.toLocaleString('en-IN', { maximumFractionDigits: dec })
  }
  if (stored === null || stored === undefined) return d.field_type === 'CHECKBOX' ? 'No' : '—'
  switch (d.field_type) {
    case 'CHECKBOX': return stored === true ? 'Yes' : 'No'
    case 'CURRENCY': { const v = stored as CurrencyValue; return money(Number(v.amount), v.currency ?? 'INR') }
    case 'PICKLIST': {
      const v = stored as RefValue
      const current = (d.field_config.options ?? []).find((o) => o.id === v.id)
      return current ? current.label : `${v.label ?? v.id} (removed option)`
    }
    case 'USER': return (stored as RefValue).name ?? '—'
    case 'LOOKUP': return (stored as RefValue).label ?? '—'
    case 'DATE': {
      const [y, m, day] = String(stored).split('-').map(Number)
      return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' })
    }
    default: return String(stored)
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Formulas: numbers, {field_key}, + - * / ( ) , ROUND(x[, digits]) MIN(a, b, …) MAX(a, b, …) ABS(x).
// Parsed into a tree and evaluated here; nothing is passed to eval / Function / SQL.
// ---------------------------------------------------------------------------------------------------------------
type Node = { t: 'num'; v: number } | { t: 'ref'; k: string } | { t: 'neg'; a: Node } | { t: 'bin'; op: string; a: Node; b: Node } | { t: 'fn'; f: string; args: Node[] }
type Tok = { k: 'num' | 'ref' | 'id' | 'op'; v: string }

const FUNCS = ['ROUND', 'MIN', 'MAX', 'ABS']

function tokenize(src: string): Tok[] {
  const out: Tok[] = []
  const re = /\s*(?:(\{[a-z][a-z0-9_]*\})|(\d+(?:\.\d+)?)|([A-Za-z_]+)|([-+*/(),])|(\S))/gy
  let m: RegExpExecArray | null
  while (re.lastIndex < src.length && (m = re.exec(src))) {
    if (m[5]) throw new Error(`The formula contains "${m[5]}", which is not allowed. Use numbers, {field_key}, + - * / ( ) and ROUND, MIN, MAX, ABS.`)
    if (m[1]) out.push({ k: 'ref', v: m[1].slice(1, -1) })
    else if (m[2]) out.push({ k: 'num', v: m[2] })
    else if (m[3]) out.push({ k: 'id', v: m[3] })
    else if (m[4]) out.push({ k: 'op', v: m[4] })
    if (src.slice(re.lastIndex).trim() === '') break
  }
  return out
}

/** Parse a formula; throws an Error with a readable message when it is not valid. */
export function parseFormula(src: string): Node {
  if (!src.trim()) throw new Error('Enter the formula.')
  if (src.length > 500) throw new Error('A formula can be at most 500 characters.')
  const toks = tokenize(src)
  let i = 0
  const peek = () => toks[i]
  const take = (v?: string) => {
    const t = toks[i]
    if (!t || (v !== undefined && t.v !== v)) throw new Error(v === ')' ? 'The formula has a "(" that is never closed.' : 'The formula ends too early.')
    i++
    return t
  }
  const expr = (): Node => {
    let a = term()
    while (peek()?.k === 'op' && (peek().v === '+' || peek().v === '-')) { const op = take().v; a = { t: 'bin', op, a, b: term() } }
    return a
  }
  const term = (): Node => {
    let a = unary()
    while (peek()?.k === 'op' && (peek().v === '*' || peek().v === '/')) { const op = take().v; a = { t: 'bin', op, a, b: unary() } }
    return a
  }
  const unary = (): Node => {
    if (peek()?.k === 'op' && (peek().v === '-' || peek().v === '+')) { const op = take().v; const a = unary(); return op === '-' ? { t: 'neg', a } : a }
    return primary()
  }
  const primary = (): Node => {
    const t = peek()
    if (!t) throw new Error('The formula ends with an operator.')
    if (t.k === 'num') { i++; return { t: 'num', v: Number(t.v) } }
    if (t.k === 'ref') { i++; return { t: 'ref', k: t.v } }
    if (t.k === 'id') {
      const f = t.v.toUpperCase()
      if (!FUNCS.includes(f)) throw new Error(`Unknown function "${t.v}". Only ROUND, MIN, MAX and ABS are allowed (fields are written as {field_key}).`)
      i++
      if (peek()?.v !== '(') throw new Error(`Write ${f} with brackets, for example ${f}(…).`)
      take('(')
      const args = [expr()]
      while (peek()?.v === ',') { take(','); args.push(expr()) }
      take(')')
      if (f === 'ABS' && args.length !== 1) throw new Error('ABS takes one value.')
      if (f === 'ROUND' && args.length > 2) throw new Error('ROUND takes a value and optionally the number of decimals.')
      if ((f === 'MIN' || f === 'MAX') && args.length < 2) throw new Error(`${f} needs at least two values.`)
      return { t: 'fn', f, args }
    }
    if (t.v === '(') { take('('); const a = expr(); take(')'); return a }
    if (t.v === ')') throw new Error('The formula has a ")" without a matching "(".')
    if (t.v === ',') throw new Error('A comma can only separate the values of a function.')
    throw new Error(`The formula has an operator "${t.v}" without a value before it.`)
  }
  const root = expr()
  if (i < toks.length) {
    const t = toks[i]
    if (t.v === ')') throw new Error('The formula has a ")" without a matching "(".')
    if (t.v === ',') throw new Error('A comma can only separate the values of a function.')
    throw new Error(`The formula is missing an operator before ${t.k === 'ref' ? `{${t.v}}` : t.v}.`)
  }
  return root
}

export function formulaRefs(src: string): string[] {
  const out: string[] = []
  const walk = (n: Node) => {
    if (n.t === 'ref') { if (!out.includes(n.k)) out.push(n.k) } else if (n.t === 'neg') walk(n.a)
    else if (n.t === 'bin') { walk(n.a); walk(n.b) } else if (n.t === 'fn') n.args.forEach(walk)
  }
  walk(parseFormula(src))
  return out
}

const numberOf = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null
  if (typeof v === 'object' && v !== null && 'amount' in v) return numberOf((v as CurrencyValue).amount)
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

/** The result, or null when an input is missing, the formula is invalid or it divides by zero. */
export function evaluateFormula(src: string, inputs: Record<string, unknown>): number | null {
  let root: Node
  try { root = parseFormula(src) } catch { return null }
  const ev = (n: Node): number | null => {
    switch (n.t) {
      case 'num': return n.v
      case 'ref': return numberOf(inputs[n.k])
      case 'neg': { const a = ev(n.a); return a === null ? null : -a }
      case 'bin': {
        const a = ev(n.a)
        const b = ev(n.b)
        if (a === null || b === null) return null
        if (n.op === '+') return a + b
        if (n.op === '-') return a - b
        if (n.op === '*') return a * b
        return b === 0 ? null : a / b
      }
      case 'fn': {
        const xs = n.args.map(ev)
        if (xs.some((x) => x === null)) return null
        const v = xs as number[]
        if (n.f === 'ABS') return Math.abs(v[0])
        if (n.f === 'MIN') return Math.min(...v)
        if (n.f === 'MAX') return Math.max(...v)
        const digits = Math.max(0, Math.min(6, Math.trunc(v[1] ?? 0)))
        const f = 10 ** digits
        return Math.sign(v[0]) * Math.round(Math.abs(v[0]) * f) / f
      }
    }
  }
  const r = ev(root)
  return r === null || !Number.isFinite(r) ? null : r
}

// ---------------------------------------------------------------------------------------------------------------
// Field builder
// ---------------------------------------------------------------------------------------------------------------
export interface LayoutItem { standard_key?: StandardKey; field_definition_id?: string; is_required?: boolean | null }
export const itemKey = (x: LayoutItem) => x.standard_key ?? x.field_definition_id ?? ''

/** Move the item at `from` to position `to` (both in the list's current indices). */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= list.length) return list
  const out = list.slice()
  const [x] = out.splice(from, 1)
  out.splice(Math.max(0, Math.min(to, out.length)), 0, x)
  return out
}

export const sameLayout = (a: LayoutItem[], b: LayoutItem[]) =>
  a.length === b.length && a.every((x, i) => itemKey(x) === itemKey(b[i]) && (x.is_required ?? null) === (b[i].is_required ?? null))

/** The generated internal key for a new label (the database adds _2, _3 … when it is taken). */
export function previewKey(label: string): string {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 34)
  return `cf_${base || 'field'}`
}

/** Settings form checks before saving a definition (the database repeats them). */
export function checkDefinition(v: { field_label: string; field_type: FieldType; field_config: FieldConfig; is_required: boolean }): string | null {
  if (!v.field_label.trim()) return 'Enter the field label.'
  if (v.field_label.trim().length > 80) return 'The label can have at most 80 characters.'
  if (v.is_required && (v.field_type === 'CHECKBOX' || v.field_type === 'FORMULA')) return `${FIELD_TYPE_META[v.field_type].label} fields cannot be required.`
  const c = v.field_config
  if (v.field_type === 'PICKLIST') {
    const labels = (c.options ?? []).map((o) => o.label.trim()).filter(Boolean)
    if (!labels.length) return 'Add at least one option to the picklist.'
    const dup = labels.find((l, i) => labels.findIndex((x) => x.toLowerCase() === l.toLowerCase()) !== i)
    if (dup) return `The picklist option "${dup}" is listed twice.`
    if (labels.some((l) => l.length > 100)) return 'Each picklist option can have at most 100 characters.'
  }
  if (v.field_type === 'TEXT' && (c.min_length ?? 0) > (c.max_length ?? 255)) return 'The minimum length cannot be more than the maximum length.'
  if (v.field_type === 'TEXT' && ((c.max_length ?? 255) < 1 || (c.max_length ?? 255) > 2000)) return 'The maximum length is between 1 and 2000 characters.'
  if ((v.field_type === 'NUMBER' || v.field_type === 'CURRENCY') && c.min !== undefined && c.max !== undefined && c.min > c.max) return 'The minimum cannot be more than the maximum.'
  if (v.field_type === 'CURRENCY' && !/^[A-Z]{3}$/.test(c.currency ?? 'INR')) return 'The currency is a three-letter code such as INR.'
  if (v.field_type === 'LOOKUP' && !c.target) return 'Choose what the lookup links to.'
  if (v.field_type === 'FORMULA') {
    try { parseFormula(c.expression ?? '') } catch (e) { return (e as Error).message }
  }
  return null
}

/** Typed values of number and currency fields, as formula inputs (empty and invalid inputs are left out). */
export function formulaInputsOf(fields: Pick<FieldDefinition, 'field_key' | 'field_type'>[], values: Record<string, InputValue>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const f of fields) {
    if (f.field_type !== 'NUMBER' && f.field_type !== 'CURRENCY') continue
    const v = values[f.field_key]
    if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) out[f.field_key] = Number(v)
  }
  return out
}

export const badgeCount = (n: number, max = MAX_CUSTOM_FIELDS) => `${n} of ${max} custom fields used`
