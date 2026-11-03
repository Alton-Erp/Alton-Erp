/**
 * Indian-system amount in words (crore / lakh / thousand), e.g.
 * 6430.10 -> "Rupees Six Thousand Four Hundred Thirty and Ten Paise Only".
 * Display text only: the amount itself always comes from the database. The
 * value is converted to integer paise first, so no floating-point arithmetic
 * reaches the words.
 */
const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen',
  'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen']
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']

function belowHundred(n: number): string {
  if (n < 20) return ONES[n]
  return `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`
}

function belowThousand(n: number): string {
  const h = Math.floor(n / 100)
  const r = n % 100
  return [h ? `${ONES[h]} Hundred` : '', r ? belowHundred(r) : ''].filter(Boolean).join(' ')
}

/** Words for a whole number in the Indian system (supports up to 99,99,99,99,99,999). */
export function integerToIndianWords(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Expected a non-negative whole number')
  if (value === 0) return 'Zero'
  const parts: string[] = []
  let n = value
  const crore = Math.floor(n / 10_000_000)
  n %= 10_000_000
  const lakh = Math.floor(n / 100_000)
  n %= 100_000
  const thousand = Math.floor(n / 1000)
  n %= 1000
  if (crore) parts.push(`${integerToIndianWords(crore)} Crore`)
  if (lakh) parts.push(`${belowHundred(lakh)} Lakh`)
  if (thousand) parts.push(`${belowHundred(thousand)} Thousand`)
  if (n) parts.push(belowThousand(n))
  return parts.join(' ')
}

/** Accepts the numeric value (or decimal string) of an amount with at most 2 decimals. */
export function amountInWords(amount: number | string, currencyWord = 'Rupees', subunitWord = 'Paise'): string {
  const text = typeof amount === 'number' ? amount.toFixed(2) : amount.trim()
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(text)
  if (!m) throw new Error(`Invalid amount: ${amount}`)
  const whole = Number(m[2])
  const paise = Number((m[3] ?? '').padEnd(2, '0') || '0')
  const sign = m[1] && (whole > 0 || paise > 0) ? 'Minus ' : ''
  const main = `${currencyWord} ${integerToIndianWords(whole)}`
  return `${sign}${main}${paise ? ` and ${belowHundred(paise)} ${subunitWord}` : ''} Only`
}
