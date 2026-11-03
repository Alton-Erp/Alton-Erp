// Count sheet export/re-import. Pure TypeScript (unit-tested in tests/unit).
// Re-importing only records counted quantities on the count; it never changes
// stock. Stock changes only when the count is approved.

export const COUNT_SHEET_HEADERS = ['Line ID', 'SKU', 'Product', 'Warehouse', 'Location', 'Batch', 'Source', 'Unit', 'System Qty', 'Counted Qty', 'Notes'] as const

export interface CountSheetLine {
  id: string
  sku: string
  system_quantity: number
  counted_quantity: number | null
  notes: string | null
}

export interface CountSheetUpdate {
  line_id: string
  counted_quantity: number | null
  notes: string | null
}

export interface CountSheetResult {
  updates: CountSheetUpdate[]
  unchanged: number
  errors: { row: number; message: string }[]
}

const norm = (h: string) => h.trim().toLowerCase().replace(/[^a-z]/g, '')

/**
 * rows: all sheet rows including the header (index 0 = spreadsheet row 1).
 * Blank "Counted Qty" leaves a line uncounted (clears an existing count only
 * when `clearBlanks` is true).
 */
export function parseCountSheet(rows: string[][], lines: CountSheetLine[], clearBlanks = false): CountSheetResult {
  const headerIndex = rows.findIndex((r) => r.some((c) => norm(c) === 'lineid'))
  if (headerIndex < 0) return { updates: [], unchanged: 0, errors: [{ row: 1, message: 'Header row with a "Line ID" column was not found. Use a sheet exported from this count.' }] }
  const header = rows[headerIndex].map(norm)
  const col = (name: string) => header.indexOf(norm(name))
  const idCol = col('Line ID')
  const qtyCol = col('Counted Qty')
  const notesCol = col('Notes')
  const skuCol = col('SKU')
  if (qtyCol < 0) return { updates: [], unchanged: 0, errors: [{ row: headerIndex + 1, message: 'The "Counted Qty" column is missing.' }] }

  const byId = new Map(lines.map((l) => [l.id, l]))
  const seen = new Set<string>()
  const updates: CountSheetUpdate[] = []
  const errors: CountSheetResult['errors'] = []
  let unchanged = 0

  rows.slice(headerIndex + 1).forEach((row, i) => {
    const rowNumber = headerIndex + i + 2
    if (row.every((c) => String(c ?? '').trim() === '')) return
    const id = String(row[idCol] ?? '').trim()
    const line = byId.get(id)
    if (!line) return errors.push({ row: rowNumber, message: `Line ID "${id || '(blank)'}" does not belong to this count.` })
    if (seen.has(id)) return errors.push({ row: rowNumber, message: 'Duplicate line in the sheet.' })
    seen.add(id)
    if (skuCol >= 0 && String(row[skuCol] ?? '').trim() && String(row[skuCol]).trim().toLowerCase() !== line.sku.toLowerCase()) {
      return errors.push({ row: rowNumber, message: `SKU "${row[skuCol]}" does not match line SKU ${line.sku}.` })
    }
    const raw = String(row[qtyCol] ?? '').trim().replace(/,/g, '')
    let qty: number | null = null
    if (raw === '') {
      if (!clearBlanks) {
        unchanged++
        return
      }
    } else {
      if (!/^\d+(\.\d{1,3})?$/.test(raw)) return errors.push({ row: rowNumber, message: `Counted Qty "${raw}" must be a number ≥ 0 with up to 3 decimals.` })
      qty = Number(raw)
    }
    const notes = notesCol >= 0 ? String(row[notesCol] ?? '').trim() || null : line.notes
    if (qty === line.counted_quantity && notes === line.notes) {
      unchanged++
      return
    }
    updates.push({ line_id: id, counted_quantity: qty, notes })
  })

  return { updates, unchanged, errors }
}
