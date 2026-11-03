import type { DataTableColumn } from '@/components/common/data-table'

/**
 * Header-only columns for tables whose records arrive in a later phase.
 * Replace with real typed columns when the module's data service exists.
 */
export function layoutColumns(
  headers: (string | { header: string; align?: 'left' | 'right' | 'center' })[],
): DataTableColumn<never>[] {
  return headers.map((h, i) => {
    const def = typeof h === 'string' ? { header: h } : h
    return { id: `col-${i}`, header: def.header, align: def.align, cell: () => null }
  })
}
