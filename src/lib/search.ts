/**
 * ERP search — one matching rule for every search box (Product Master, BOM, Inventory, Production, Outsourcing).
 *
 * Rule: the text is normalised (trimmed, runs of spaces collapsed, case ignored, at most 8 distinct words of 60 characters).
 * EVERY word must occur as a substring — at the start, in the middle or at the end — of at least one searchable field of the record
 * (or of a related record). So "mic", "eram", "basin white", "white basin" and "ALTON   basin" all find
 * "ALTON Premium Ceramic Wash Basin White". An empty search matches everything. The same rule runs in the database
 * (private.search_patterns / private.search_match, migration 20261231090900) so client and server agree.
 *
 * Server-side filters are built as one PostgREST `or=` logic tree: the whole phrase in any field, or (for several words) every word in
 * some field. LIKE wildcards and PostgREST syntax characters typed by the user are matched literally and can never alter the filter.
 */

export const SEARCH_MAX_WORDS = 8
export const SEARCH_MAX_WORD_LENGTH = 60
export const SEARCH_MAX_LENGTH = 200
/** Debounce used by search boxes (milliseconds). */
export const SEARCH_DEBOUNCE_MS = 300

/** Trimmed text with runs of whitespace collapsed to one space (case kept: ILIKE ignores it). */
export function normalizeSearch(input: string | null | undefined): string {
  return (input ?? '').slice(0, SEARCH_MAX_LENGTH).replace(/\s+/g, ' ').trim()
}

/** Distinct words in typed order (lower case), at most 8 of 60 characters each. */
export function searchWords(input: string | null | undefined): string[] {
  const seen = new Set<string>()
  for (const w of normalizeSearch(input).toLowerCase().split(' ')) {
    const word = w.slice(0, SEARCH_MAX_WORD_LENGTH)
    if (word && !seen.has(word)) seen.add(word)
    if (seen.size >= SEARCH_MAX_WORDS) break
  }
  return [...seen]
}

/** True when every word of the search occurs in at least one of the values (the client-side form of the rule). */
export function matchesSearch(values: readonly (string | number | null | undefined)[], input: string | readonly string[]): boolean {
  const words = typeof input === 'string' ? searchWords(input) : input
  if (words.length === 0) return true
  const hay = values.filter((v) => v !== null && v !== undefined && v !== '').map((v) => String(v).toLowerCase())
  return words.every((w) => hay.some((h) => h.includes(w)))
}

/**
 * A word or phrase as a quoted PostgREST ILIKE value ("%…%"): LIKE wildcards (\ % _) are escaped so they match literally, and quotes /
 * backslashes are escaped for PostgREST, so commas, dots, parentheses and quotes in SKUs are safe.
 */
export function ilikeValue(term: string): string {
  const literal = term.replace(/[\\%_]/g, (c) => `\\${c}`)
  return `"%${literal.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}%"`
}

/** Extra conditions for one word (e.g. `category_id.in.(…)` for categories whose name matches it). */
export type WordConditions = (word: string) => string[]

/**
 * The PostgREST `or` logic for a search over `fields` (pass the result to `query.or(...)`), or null for an empty search.
 *  - one word:     (f1.ilike."%w%", f2.ilike."%w%", …, extra(w)…)
 *  - several words: (f1.ilike."%phrase%", …, and(or(f1.ilike."%w1%", …, extra(w1)…), or(f1.ilike."%w2%", …)))
 * The phrase alternative keeps free-format values (SKUs with spaces) matching exactly as typed.
 */
export function searchFilter(input: string | null | undefined, fields: readonly string[], extra?: WordConditions): string | null {
  const phrase = normalizeSearch(input)
  const words = searchWords(phrase)
  if (words.length === 0 || fields.length === 0) return null
  // ILIKE ignores case; a single word is sent as typed (extra conditions get the lower-case word).
  const wordGroup = (w: string, typed = w) => [...fields.map((f) => `${f}.ilike.${ilikeValue(typed)}`), ...(extra ? extra(w) : [])]
  if (words.length === 1) return wordGroup(words[0], phrase.slice(0, SEARCH_MAX_WORD_LENGTH)).join(',')
  const phraseTerms = fields.map((f) => `${f}.ilike.${ilikeValue(phrase)}`)
  return [...phraseTerms, `and(${words.map((w) => `or(${wordGroup(w).join(',')})`).join(',')})`].join(',')
}

/** `col.in.(…)` for a list of ids (empty → a condition that matches nothing, so the word still needs another field). */
export const inCondition = (column: string, ids: readonly string[]): string[] => (ids.length ? [`${column}.in.(${ids.join(',')})`] : [])
