// Calendar dates in the company's chosen format (ERP Settings → Company).
// No imports, so unit tests can load it directly.

export type DatePattern = 'DD-MM-YYYY' | 'DD/MM/YYYY' | 'DD MMM YYYY' | 'YYYY-MM-DD'
export const DATE_PATTERNS: DatePattern[] = ['DD MMM YYYY', 'DD-MM-YYYY', 'DD/MM/YYYY', 'YYYY-MM-DD']

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const pad = (n: number) => String(n).padStart(2, '0')

export function formatDatePattern(date: Date, pattern: DatePattern): string {
  const d = pad(date.getDate())
  const m = date.getMonth()
  const y = date.getFullYear()
  switch (pattern) {
    case 'DD-MM-YYYY': return `${d}-${pad(m + 1)}-${y}`
    case 'DD/MM/YYYY': return `${d}/${pad(m + 1)}/${y}`
    case 'YYYY-MM-DD': return `${y}-${pad(m + 1)}-${d}`
    default: return `${d} ${MONTHS[m]} ${y}`
  }
}
