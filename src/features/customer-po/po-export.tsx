import { Download, Loader2 } from 'lucide-react'
import { useState } from 'react'

import { usePermissions } from '@/auth/use-permissions'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { exportRows, type ExportColumn } from '@/features/customer-po/export-utils'

/** Export menu (only for users with customer_po_reports.export). Exports exactly the rows passed (current filters). */
export function ExportMenu<T>({ title, fileStem, columns, rows, label = 'Export' }: { title: string; fileStem: string; columns: ExportColumn<T>[]; rows: T[]; label?: string }) {
  const { has } = usePermissions()
  const [busy, setBusy] = useState(false)
  if (!has('customer_po_reports.export')) return null
  const run = async (format: 'xlsx' | 'csv') => {
    setBusy(true)
    try {
      await exportRows(title, fileStem, columns, rows, format)
    } finally {
      setBusy(false)
    }
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" disabled={busy || rows.length === 0}>{busy ? <Loader2 className="animate-spin" /> : <Download />} {label}</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => void run('xlsx')}>Excel (.xlsx)</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void run('csv')}>CSV</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
