// Live updates of the Support Centre (no React; unit-tested in tests/unit/support-live.test.ts).
import type { LiveSummary } from '@/services/support'

/** Fallback / reconciliation poll while the tab is visible (Realtime makes changes arrive sooner). */
export const POLL_MS = 3000
/** Reconnect delays for an interrupted Realtime subscription. */
export const RECONNECT_MS = [2000, 5000, 10000, 30000, 60000]

/** "99+" above 99; null hides the badge. */
export function badgeText(n: number | null | undefined): string | null {
  if (!n || n <= 0 || !Number.isFinite(n)) return null
  return n > 99 ? '99+' : String(Math.floor(n))
}

/** Sidebar entries with a badge, and which count they show. */
export const BADGE_FOR: Record<string, keyof Pick<LiveSummary, 'whatsapp_unread' | 'email_unread' | 'missed_calls'>> = {
  'support-whatsapp': 'whatsapp_unread',
  'support-emails': 'email_unread',
  'support-calls': 'missed_calls',
}
export const BADGE_LABEL: Record<string, string> = {
  'support-whatsapp': 'unread WhatsApp conversations', 'support-emails': 'unread emails', 'support-calls': 'missed calls to handle',
}

/** Same counts and stamps: no state change, so a poll that finds nothing new re-renders nothing. */
export function sameSummary(a: LiveSummary | null, b: LiveSummary | null): boolean {
  if (!a || !b) return a === b
  return a.whatsapp_unread === b.whatsapp_unread && a.email_unread === b.email_unread && a.missed_calls === b.missed_calls
    && a.stamps.whatsapp === b.stamps.whatsapp && a.stamps.email === b.stamps.email && a.stamps.calls === b.stamps.calls
}
