// Pure helpers for the ERP reset (no imports, unit-tested).

/** Typed text the user must enter; checked again by the Edge Function and the database. */
export const RESET_CONFIRMATION = 'RESET ERP'

export interface ResetTableCount {
  table: string
  label: string
  category?: string
  rows: number
}

/** Whether a completed reset was confirmed by both the in-transaction and the post-commit check. */
export const isVerifiedSuccess = (
  r: { status?: string; post_check?: { ok?: boolean } | null; verification?: Record<string, unknown> } | null | undefined,
): boolean => !!r && r.status === 'COMPLETED' && r.post_check?.ok === true && r.verification?.allowlist_empty === true

/** Groups the tables to delete by category with their totals (largest first). */
export function groupDeletion(rows: ResetTableCount[]): { category: string; total: number; tables: ResetTableCount[] }[] {
  const map = new Map<string, ResetTableCount[]>()
  for (const r of rows) {
    const key = r.category ?? 'Other'
    map.set(key, [...(map.get(key) ?? []), r])
  }
  return [...map.entries()]
    .map(([category, tables]) => ({
      category,
      total: tables.reduce((s, t) => s + t.rows, 0),
      tables: [...tables].sort((a, b) => b.rows - a.rows || a.label.localeCompare(b.label)),
    }))
    .sort((a, b) => b.total - a.total || a.category.localeCompare(b.category))
}
