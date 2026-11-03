import type { CellValue } from '@/features/products/spreadsheet'
import { toIsoDate } from '@/lib/format'

export interface ExportColumn<T> {
  header: string
  /** Strings are written as text cells, so SKUs and PO numbers keep leading zeros. */
  value: (row: T) => CellValue | undefined
}

export async function exportRows<T>(title: string, fileStem: string, columns: ExportColumn<T>[], rows: T[], format: 'xlsx' | 'csv') {
  const { downloadSheets } = await import('@/features/products/spreadsheet')
  const data: CellValue[][] = [columns.map((c) => c.header), ...rows.map((r) => columns.map((c) => c.value(r) ?? null))]
  await downloadSheets([{ name: title.slice(0, 31), rows: data }], `${fileStem}-${toIsoDate(new Date())}`, format)
}

