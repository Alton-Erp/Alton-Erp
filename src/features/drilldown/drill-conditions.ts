/**
 * Filter conditions shared by a dashboard figure and the list of records behind it.
 *
 * One definition, three uses:
 *  - applyConditions(): the Supabase (PostgREST) query of the drill-down list, so the server
 *    filters, counts and pages exactly these records (RLS applies as for every list);
 *  - matchesConditions(): rows returned by an existing RPC (statuses the database computes);
 *  - conditionsToSql(): the database check (tests/db/drilldown-consistency-check.mjs), which
 *    compares the dashboard figure with the count of these same conditions.
 *
 * Pure module: no app imports, so the Node test can load it directly.
 */

export type Scalar = string | number | boolean
export type SimpleOp = 'eq' | 'neq' | 'in' | 'not_in' | 'gt' | 'gte' | 'lt' | 'lte' | 'is_null' | 'not_null' | 'is_true' | 'is_false'

export interface SimpleCondition {
  col: string
  op: SimpleOp
  value?: Scalar | Scalar[]
}
/** A timestamp column whose calendar day (in the company time zone) lies between two dates. */
export interface DayCondition {
  col: string
  op: 'day_between'
  from: string
  to: string
  tz: string
}
/** A condition on a column of a related product (the row's product id column). */
export interface ProductCondition {
  product: { fk: string; col: string; op: SimpleOp; value?: Scalar | Scalar[] }
}
/** At least one element of a JSON array field (rows of an RPC) has field > value. */
export interface AnyCondition {
  col: string
  op: 'any_gt'
  field: string
  value: number
}
export interface OrCondition { or: Condition[] }
export interface AndCondition { and: Condition[] }
export type Condition = SimpleCondition | DayCondition | ProductCondition | AnyCondition | OrCondition | AndCondition

// ---------------------------------------------------------------------------
// Builders (readable registry entries)
// ---------------------------------------------------------------------------
export const eq = (col: string, value: Scalar): SimpleCondition => ({ col, op: 'eq', value })
export const neq = (col: string, value: Scalar): SimpleCondition => ({ col, op: 'neq', value })
export const isIn = (col: string, value: Scalar[]): SimpleCondition => ({ col, op: 'in', value })
export const notIn = (col: string, value: Scalar[]): SimpleCondition => ({ col, op: 'not_in', value })
export const gt = (col: string, value: Scalar): SimpleCondition => ({ col, op: 'gt', value })
export const gte = (col: string, value: Scalar): SimpleCondition => ({ col, op: 'gte', value })
export const lt = (col: string, value: Scalar): SimpleCondition => ({ col, op: 'lt', value })
export const lte = (col: string, value: Scalar): SimpleCondition => ({ col, op: 'lte', value })
export const isNull = (col: string): SimpleCondition => ({ col, op: 'is_null' })
export const notNull = (col: string): SimpleCondition => ({ col, op: 'not_null' })
export const isTrue = (col: string): SimpleCondition => ({ col, op: 'is_true' })
export const isFalse = (col: string): SimpleCondition => ({ col, op: 'is_false' })
export const between = (col: string, from: string, to: string): Condition[] => [gte(col, from), lte(col, to)]
export const dayBetween = (col: string, from: string, to: string, tz: string): DayCondition => ({ col, op: 'day_between', from, to, tz })
export const productIs = (fk: string, col: string, op: SimpleOp, value?: Scalar | Scalar[]): ProductCondition => ({ product: { fk, col, op, value } })
export const anyGt = (col: string, field: string, value: number): AnyCondition => ({ col, op: 'any_gt', field, value })
export const or = (...conds: Condition[]): OrCondition => ({ or: conds })
export const and = (...conds: Condition[]): AndCondition => ({ and: conds })

const isSimple = (c: Condition): c is SimpleCondition => 'col' in c && 'op' in c && c.op !== 'day_between' && c.op !== 'any_gt'
const isDay = (c: Condition): c is DayCondition => 'op' in c && c.op === 'day_between'
const isAny = (c: Condition): c is AnyCondition => 'op' in c && c.op === 'any_gt'
const isProduct = (c: Condition): c is ProductCondition => 'product' in c
const isOr = (c: Condition): c is OrCondition => 'or' in c
const isAnd = (c: Condition): c is AndCondition => 'and' in c

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
export const isIsoDate = (s: unknown): s is string => typeof s === 'string' && DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** UTC offset of a time zone at noon of the given date, as "+05:30". */
export function tzOffset(date: string, tz: string): string {
  try {
    const at = new Date(`${date}T12:00:00Z`)
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(at).reduce<Record<string, string>>((m, p) => ({ ...m, [p.type]: p.value }), {})
    const local = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute))
    const minutes = Math.round((local - at.getTime()) / 60000)
    const sign = minutes < 0 ? '-' : '+'
    const abs = Math.abs(minutes)
    return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`
  } catch {
    return '+00:00'
  }
}

/** Start of a calendar day in a time zone, as an ISO timestamp with offset. */
export const dayStart = (date: string, tz: string) => `${date}T00:00:00${tzOffset(date, tz)}`

/** Today's date in a time zone. */
export function todayIn(tz: string, now = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
  } catch {
    return now.toISOString().slice(0, 10)
  }
}

// ---------------------------------------------------------------------------
// PostgREST (Supabase query builder)
// ---------------------------------------------------------------------------
/** The subset of the supabase-js filter builder used here. */
export interface FilterBuilder<B> {
  eq(col: string, v: unknown): B
  neq(col: string, v: unknown): B
  in(col: string, v: unknown[]): B
  gt(col: string, v: unknown): B
  gte(col: string, v: unknown): B
  lt(col: string, v: unknown): B
  lte(col: string, v: unknown): B
  is(col: string, v: null | boolean): B
  not(col: string, op: string, v: unknown): B
  or(filter: string): B
}

const pgValue = (v: Scalar) => {
  const s = String(v)
  // Values with PostgREST reserved characters are quoted.
  return /[,.():"\s]/.test(s) ? `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : s
}
const pgList = (v: Scalar[]) => `(${v.map(pgValue).join(',')})`

/** One condition as a PostgREST logic-tree term (used inside or(...)). */
function orTerm(c: Condition, prefix = ''): string {
  if (isOr(c)) return `or(${c.or.map((x) => orTerm(x, prefix)).join(',')})`
  if (isAnd(c)) return `and(${c.and.map((x) => orTerm(x, prefix)).join(',')})`
  if (isDay(c)) return `and(${prefix}${c.col}.gte.${pgValue(dayStart(c.from, c.tz))},${prefix}${c.col}.lt.${pgValue(dayStart(addDays(c.to, 1), c.tz))})`
  if (isProduct(c)) return orTerm({ col: c.product.col, op: c.product.op, value: c.product.value } as SimpleCondition, `product.`)
  if (isAny(c)) throw new Error('any_gt is only available for rows of an RPC')
  const s = c as SimpleCondition
  const col = `${prefix}${s.col}`
  switch (s.op) {
    case 'eq': return `${col}.eq.${pgValue(s.value as Scalar)}`
    case 'neq': return `${col}.neq.${pgValue(s.value as Scalar)}`
    case 'in': return `${col}.in.${pgList(s.value as Scalar[])}`
    case 'not_in': return `${col}.not.in.${pgList(s.value as Scalar[])}`
    case 'gt': case 'gte': case 'lt': case 'lte': return `${col}.${s.op}.${pgValue(s.value as Scalar)}`
    case 'is_null': return `${col}.is.null`
    case 'not_null': return `${col}.not.is.null`
    case 'is_true': return `${col}.is.true`
    case 'is_false': return `${col}.is.false`
  }
}

function applySimple<B extends FilterBuilder<B>>(q: B, col: string, op: SimpleOp, value: SimpleCondition['value']): B {
  switch (op) {
    case 'eq': return q.eq(col, value)
    case 'neq': return q.neq(col, value)
    case 'in': return q.in(col, value as Scalar[])
    case 'not_in': return q.not(col, 'in', pgList(value as Scalar[]))
    case 'gt': return q.gt(col, value)
    case 'gte': return q.gte(col, value)
    case 'lt': return q.lt(col, value)
    case 'lte': return q.lte(col, value)
    case 'is_null': return q.is(col, null)
    case 'not_null': return q.not(col, 'is', null)
    case 'is_true': return q.is(col, true)
    case 'is_false': return q.is(col, false)
  }
}

/** Applies the conditions to a Supabase query (AND of all top-level conditions). */
export function applyConditions<B extends FilterBuilder<B>>(query: B, conds: readonly Condition[]): B {
  let q = query
  for (const c of conds) {
    if (isOr(c)) q = q.or(c.or.map((x) => orTerm(x)).join(','))
    else if (isAnd(c)) q = applyConditions(q, c.and)
    else if (isDay(c)) q = q.gte(c.col, dayStart(c.from, c.tz)).lt(c.col, dayStart(addDays(c.to, 1), c.tz))
    else if (isProduct(c)) q = applySimple(q, `product.${c.product.col}`, c.product.op, c.product.value)
    else if (isAny(c)) throw new Error('any_gt is only available for rows of an RPC')
    else q = applySimple(q, c.col, c.op, c.value)
  }
  return q
}

/** Product columns the conditions need (for an inner join "product:products!fk!inner(cols)"). */
export function productJoin(conds: readonly Condition[]): { fk: string; cols: string[] } | null {
  let fk: string | null = null
  const cols = new Set<string>()
  const walk = (c: Condition) => {
    if (isOr(c)) c.or.forEach(walk)
    else if (isAnd(c)) c.and.forEach(walk)
    else if (isProduct(c)) { fk = c.product.fk; cols.add(c.product.col) }
  }
  conds.forEach(walk)
  return fk ? { fk, cols: [...cols] } : null
}

// ---------------------------------------------------------------------------
// Rows already in the browser (results of an RPC)
// ---------------------------------------------------------------------------
const num = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v))
const same = (a: unknown, b: Scalar) => (typeof b === 'number' ? num(a) === b : typeof b === 'boolean' ? a === b : String(a) === String(b))

function cmp(a: unknown, b: Scalar): number | null {
  if (a === null || a === undefined) return null
  if (typeof b === 'number') return Number(a) - b
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0
}

function matchSimple(v: unknown, op: SimpleOp, value: SimpleCondition['value']): boolean {
  switch (op) {
    case 'eq': return v !== null && v !== undefined && same(v, value as Scalar)
    case 'neq': return v !== null && v !== undefined && !same(v, value as Scalar) // SQL: NULL <> x is not true
    case 'in': return v !== null && v !== undefined && (value as Scalar[]).some((x) => same(v, x))
    case 'not_in': return v !== null && v !== undefined && !(value as Scalar[]).some((x) => same(v, x))
    case 'gt': { const d = cmp(v, value as Scalar); return d !== null && d > 0 }
    case 'gte': { const d = cmp(v, value as Scalar); return d !== null && d >= 0 }
    case 'lt': { const d = cmp(v, value as Scalar); return d !== null && d < 0 }
    case 'lte': { const d = cmp(v, value as Scalar); return d !== null && d <= 0 }
    case 'is_null': return v === null || v === undefined
    case 'not_null': return v !== null && v !== undefined
    case 'is_true': return v === true
    case 'is_false': return v === false
  }
}

export function matchesConditions(row: Record<string, unknown>, conds: readonly Condition[]): boolean {
  return conds.every((c) => {
    if (isOr(c)) return c.or.some((x) => matchesConditions(row, [x]))
    if (isAnd(c)) return matchesConditions(row, c.and)
    if (isDay(c)) {
      const v = row[c.col]
      if (typeof v !== 'string') return false
      const day = v.length === 10 ? v : todayIn(c.tz, new Date(v))
      return day >= c.from && day <= c.to
    }
    if (isAny(c)) {
      const arr = row[c.col]
      return Array.isArray(arr) && arr.some((e) => Number((e as Record<string, unknown>)?.[c.field] ?? 0) > c.value)
    }
    if (isProduct(c)) throw new Error('Product conditions need the database')
    return matchSimple(row[c.col], c.op, c.value)
  })
}

// ---------------------------------------------------------------------------
// SQL (database consistency check only; values are quoted literals)
// ---------------------------------------------------------------------------
const lit = (v: Scalar) => (typeof v === 'number' || typeof v === 'boolean' ? String(v) : `'${String(v).replace(/'/g, "''")}'`)

/**
 * The conditions as a SQL boolean expression.
 *  view rows:  conditionsToSql(conds, { alias: 'v' })            → v.col
 *  RPC rows:   conditionsToSql(conds, { alias: 'r', json: true }) → r ->> 'col' (jsonb rows)
 */
export function conditionsToSql(conds: readonly Condition[], opts: { alias: string; json?: boolean }): string {
  const col = (c: string, v?: Scalar | Scalar[]) => {
    if (!opts.json) return `${opts.alias}.${c}`
    const sample = Array.isArray(v) ? v[0] : v
    const text = `(${opts.alias} ->> '${c}')`
    return typeof sample === 'number' ? `${text}::numeric` : typeof sample === 'boolean' ? `${text}::boolean` : text
  }
  const simple = (expr: string, op: SimpleOp, value: SimpleCondition['value']) => {
    switch (op) {
      case 'eq': return `${expr} = ${lit(value as Scalar)}`
      case 'neq': return `${expr} <> ${lit(value as Scalar)}`
      case 'in': return `${expr} in (${(value as Scalar[]).map(lit).join(', ')})`
      case 'not_in': return `${expr} not in (${(value as Scalar[]).map(lit).join(', ')})`
      case 'gt': return `${expr} > ${lit(value as Scalar)}`
      case 'gte': return `${expr} >= ${lit(value as Scalar)}`
      case 'lt': return `${expr} < ${lit(value as Scalar)}`
      case 'lte': return `${expr} <= ${lit(value as Scalar)}`
      case 'is_null': return `${expr} is null`
      case 'not_null': return `${expr} is not null`
      case 'is_true': return `${expr} is true`
      case 'is_false': return `${expr} is false`
    }
  }
  const one = (c: Condition): string => {
    if (isOr(c)) return `(${c.or.map(one).join(' or ')})`
    if (isAnd(c)) return `(${c.and.map(one).join(' and ')})`
    if (isDay(c)) {
      const e = opts.json ? `((${opts.alias} ->> '${c.col}')::timestamptz at time zone ${lit(c.tz)})::date` : `(${opts.alias}.${c.col} at time zone ${lit(c.tz)})::date`
      return `${e} between ${lit(c.from)}::date and ${lit(c.to)}::date`
    }
    if (isAny(c)) {
      return `exists (select 1 from jsonb_array_elements(coalesce(${opts.alias} -> '${c.col}', '[]'::jsonb)) e where coalesce((e ->> '${c.field}')::numeric, 0) > ${c.value})`
    }
    if (isProduct(c)) {
      return `exists (select 1 from public.products j where j.id = ${opts.alias}.${c.product.fk} and ${simple(`j.${c.product.col}`, c.product.op, c.product.value)})`
    }
    const s = c as SimpleCondition
    // Dates compared as dates on JSON rows.
    const expr = opts.json && typeof s.value === 'string' && isIsoDate(s.value) ? `(${opts.alias} ->> '${s.col}')::date` : col(s.col, s.value)
    return simple(expr, s.op, s.value)
  }
  return conds.length ? conds.map(one).join(' and ') : 'true'
}

/** Short, human-readable form of the conditions (shown on the drill-down page). */
export function describeConditions(conds: readonly Condition[]): string[] {
  const text = (c: Condition): string => {
    if (isOr(c)) return c.or.map(text).join(' or ')
    if (isAnd(c)) return c.and.map(text).join(' and ')
    if (isDay(c)) return `${c.col.replace(/_/g, ' ')} ${c.from === c.to ? c.from : `${c.from} – ${c.to}`}`
    if (isAny(c)) return `${c.col} with ${c.field} > ${c.value}`
    if (isProduct(c)) return `product ${simpleText(c.product.col, c.product.op, c.product.value)}`
    return simpleText(c.col, c.op, c.value)
  }
  return conds.map(text)
}

function simpleText(col: string, op: SimpleOp, value: SimpleCondition['value']) {
  const name = col.replace(/_/g, ' ')
  // Status codes read as words (PARTIALLY_RECEIVED → Partially received).
  const word = (x: Scalar) => (typeof x === 'string' && /^[A-Z][A-Z_]+$/.test(x) ? x.charAt(0) + x.slice(1).toLowerCase().replace(/_/g, ' ') : String(x))
  const v = Array.isArray(value) ? value.map(word).join(', ') : value === undefined ? '' : word(value)
  switch (op) {
    case 'eq': return `${name} = ${v}`
    case 'neq': return `${name} ≠ ${v}`
    case 'in': return `${name} in ${v}`
    case 'not_in': return `${name} not in ${v}`
    case 'gt': return `${name} > ${v}`
    case 'gte': return `${name} ≥ ${v}`
    case 'lt': return `${name} < ${v}`
    case 'lte': return `${name} ≤ ${v}`
    case 'is_null': return `${name} empty`
    case 'not_null': return `${name} set`
    case 'is_true': return `${name}`
    case 'is_false': return `not ${name}`
  }
}

/** Every simple condition is satisfiable in the browser (no product join, no day ranges on dates). */
export const conditionsNeedProductJoin = (conds: readonly Condition[]) => productJoin(conds) !== null
export { isSimple }
