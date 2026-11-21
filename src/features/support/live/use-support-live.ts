import { createContext, useContext, useEffect, useRef } from 'react'

import type { LiveSummary } from '@/services/support'

export interface LiveValue {
  summary: LiveSummary | null
  /** Realtime subscription is connected (polling continues as reconciliation). */
  realtime: boolean
  /** Ask for fresh counts now (after reading a conversation, marking mail read, handling a call). */
  refresh: () => void
}
export const LiveContext = createContext<LiveValue>({ summary: null, realtime: false, refresh: () => {} })

/** Badge counts and change stamps of the Support Centre (SupportLiveProvider in the app shell). */
export const useSupportLive = () => useContext(LiveContext)

/**
 * Reloads a screen's data (in place: lists, selection, scroll position and drafts stay) when its change stamp
 * moves. The first value only records the stamp.
 */
export function useReloadOnChange(stamp: string | null | undefined, reload: () => void) {
  const seen = useRef<string | null | undefined>(undefined)
  const fn = useRef(reload)
  useEffect(() => { fn.current = reload })
  useEffect(() => {
    if (stamp === undefined || stamp === null) return
    if (seen.current !== undefined && seen.current !== stamp) fn.current()
    seen.current = stamp
  }, [stamp])
}
