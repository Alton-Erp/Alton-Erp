import { Download, Loader2 } from 'lucide-react'
import { useState } from 'react'

import { PermissionGate } from '@/auth/permission-gate'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import type { CellValue } from '@/features/products/spreadsheet'

export interface ExportCol<T> { header: string; value: (row: T) => CellValue }

/** Excel / CSV export of rows already loaded from the database (needs billing_reports.export). */
export function BillingExport<T>({ title, fileStem, columns, rows, load }: {
  title: string
  fileStem: string
  columns: ExportCol<T>[]
  rows?: T[]
  /** Loads the full result set (e.g. all pages) at export time. */
  load?: () => Promise<T[]>
}) {
  const [busy, setBusy] = useState(false)
  const run = async (format: 'xlsx' | 'csv') => {
    setBusy(true)
    try {
      const data = load ? await load() : (rows ?? [])
      const { downloadSheets } = await import('@/features/products/spreadsheet')
      await downloadSheets([{ name: title.slice(0, 31), rows: [columns.map((c) => c.header), ...data.map((r) => columns.map((c) => c.value(r)))] }], fileStem, format)
    } finally { setBusy(false) }
  }
  return (
    <PermissionGate permission="billing_reports.export">
      <DropdownMenu>
        <DropdownMenuTrigger asChild><Button variant="outline" disabled={busy || (!load && !(rows ?? []).length)}>{busy ? <Loader2 className="animate-spin" /> : <Download />} Export</Button></DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => void run('xlsx')}>Excel (.xlsx)</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void run('csv')}>CSV</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </PermissionGate>
  )
}
