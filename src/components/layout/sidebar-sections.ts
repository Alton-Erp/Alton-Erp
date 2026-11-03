import type { NavGroupId } from '@/config/navigation'

/** Sections that are always shown open and have no toggle (Dashboard stays one click away). */
export const ALWAYS_OPEN_GROUPS: readonly NavGroupId[] = ['overview']

/** localStorage key for the sections the user has opened. */
export const EXPANDED_SECTIONS_KEY = 'alton-erp:sidebar-sections'

/** The nav path that best matches the URL (longest prefix), so nested pages highlight one entry. */
export function activeNavPath(pathname: string, paths: readonly string[]): string | null {
  const matches = paths.filter((p) => (p === '/' ? pathname === '/' : pathname === p || pathname.startsWith(`${p}/`)))
  return matches.sort((a, b) => b.length - a.length)[0] ?? null
}

/** Keeps only known section ids from a stored value (it may be missing, old or hand-edited). */
export function sanitizeExpanded(value: unknown, known: readonly string[]): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((v): v is string => typeof v === 'string' && known.includes(v)))]
}

/** Opens or closes one section; the others keep their state. */
export function toggleSection(expanded: readonly string[], id: string): string[] {
  return expanded.includes(id) ? expanded.filter((g) => g !== id) : [...expanded, id]
}

/** Opens the section that holds the current page, leaving the others as they are. */
export function ensureSectionOpen(expanded: readonly string[], id: string | null): readonly string[] {
  return !id || expanded.includes(id) ? expanded : [...expanded, id]
}
