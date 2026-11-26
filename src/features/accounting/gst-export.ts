// Downloads of GST working files (Excel / CSV). Building is pure (gst-reports-model); this only writes the file. Exporting never changes data.
import { buildCsv, buildWorkbook, type WorkingDoc } from '@/features/accounting/gst-reports-model'

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

const safeStem = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'gst-report'

export async function downloadGstWorkbook(doc: WorkingDoc, fileStem: string): Promise<void> {
  const XLSX = await import('xlsx')
  const wb = buildWorkbook(XLSX as unknown as Parameters<typeof buildWorkbook>[0], doc)
  const data = XLSX.write(wb as Parameters<typeof XLSX.write>[0], { bookType: 'xlsx', type: 'array' }) as ArrayBuffer
  download(new Blob([data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `${safeStem(fileStem)}.xlsx`)
}

export function downloadGstCsv(doc: WorkingDoc, fileStem: string, tableIndex = 0): void {
  download(new Blob([buildCsv(doc, tableIndex)], { type: 'text/csv;charset=utf-8' }), `${safeStem(fileStem)}.csv`)
}
