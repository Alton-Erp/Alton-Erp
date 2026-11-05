/**
 * A Product Master search term as a quoted PostgREST value. Any character can be searched (SKUs may
 * contain spaces and symbols); LIKE wildcards in the term are matched literally; quotes and
 * backslashes are escaped, so the term can never change the filter itself.
 */
export function productSearchPattern(value: string): string | null {
  const term = value.trim().slice(0, 80)
  if (!term) return null
  const literal = term.replace(/[\\%_]/g, (c) => `\\${c}`)
  return `"%${literal.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}%"`
}
