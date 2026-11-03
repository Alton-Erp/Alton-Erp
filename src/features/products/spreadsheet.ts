// SheetJS wrapper. The library is loaded on demand (dynamic import) so it is
// not part of the main bundle. Uses SheetJS 0.20.3 from the official CDN
// (the npm-registry 0.18.x line has unpatched vulnerabilities).

export interface ParsedWorkbook {
  sheetNames: string[]
  /**
   * Rows of a sheet as trimmed strings (formatted cell text). Index i is
   * spreadsheet row i + 1: blank rows and rows above the data are kept so row
   * numbers in errors match what the user sees in Excel.
   */
  rows: (sheetName: string) => string[][]
}


export async function parseWorkbook(data: ArrayBuffer): Promise<ParsedWorkbook> {
  const XLSX = await import('xlsx')
  // cellFormula/cellHTML off: formulas are not evaluated, only cached values read.
  const workbook = XLSX.read(data, { type: 'array', cellFormula: false, cellHTML: false, cellDates: true })
  return {
    sheetNames: workbook.SheetNames,
    rows: (sheetName) => {
      const sheet = workbook.Sheets[sheetName]
      if (!sheet || !sheet['!ref']) return []
      // Render real date cells as ISO (yyyy-mm-dd) instead of their locale
      // display format (e.g. US "12/5/26"), which would be ambiguous.
      const pad = (n: number) => String(n).padStart(2, '0')
      for (const address of Object.keys(sheet)) {
        if (address.startsWith('!')) continue
        const cell = sheet[address] as { t?: string; v?: unknown; z?: unknown; w?: string }
        if (cell.t === 'd' && cell.v instanceof Date) {
          cell.w = `${cell.v.getFullYear()}-${pad(cell.v.getMonth() + 1)}-${pad(cell.v.getDate())}`
        } else if (cell.t === 'n' && typeof cell.z === 'string' && typeof cell.v === 'number' && XLSX.SSF.is_date(cell.z)) {
          const d = XLSX.SSF.parse_date_code(cell.v)
          if (d) cell.w = `${d.y}-${pad(d.m)}-${pad(d.d)}`
        }
      }
      // Read from A1 so array index == spreadsheet row - 1, keeping blank rows.
      const used = XLSX.utils.decode_range(sheet['!ref'])
      const raw = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
        header: 1,
        raw: false,
        defval: '',
        blankrows: true,
        range: { s: { r: 0, c: 0 }, e: used.e },
      })
      return raw.map((row) => row.map((value) => (value === null || value === undefined ? '' : String(value).trim())))
    },
  }
}

export type CellValue = string | number | null

/** Prevents spreadsheet formula injection when a CSV is opened in Excel. */
function csvSafe(value: CellValue): string {
  if (value === null) return ''
  let text = String(value)
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function toCsv(rows: CellValue[][]): string {
  return rows.map((row) => row.map(csvSafe).join(',')).join('\r\n')
}

function download(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export async function downloadSheets(
  sheets: { name: string; rows: CellValue[][] }[],
  fileName: string,
  format: 'xlsx' | 'csv',
): Promise<void> {
  if (format === 'csv') {
    // UTF-8 BOM so Excel shows ₹ and non-ASCII names correctly.
    download(new Blob(['﻿' + toCsv(sheets[0]?.rows ?? [])], { type: 'text/csv;charset=utf-8' }), `${fileName}.csv`)
    return
  }
  const XLSX = await import('xlsx')
  const workbook = XLSX.utils.book_new()
  for (const sheet of sheets) {
    // Strings are written as text cells, never as formulas.
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(sheet.rows), sheet.name.slice(0, 31))
  }
  const data = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer
  download(new Blob([data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `${fileName}.xlsx`)
}
