import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { usePermissions } from '@/auth/use-permissions'
import { POLL_MS, RECONNECT_MS, sameSummary } from '@/features/support/live/live-model'
import { LiveContext } from '@/features/support/live/use-support-live'
import { requireSupabase } from '@/lib/supabase'
import { fetchLiveSummary, type LiveSummary } from '@/services/support'

/**
 * One live-update loop for the whole app (mounted once in the app shell, so navigating between pages never starts
 * a second one). Supabase Realtime (conversations, WhatsApp messages, call signals; RLS-filtered) triggers an
 * immediate read of the small summary (counts + change stamps); a 3-second poll while the tab is visible
 * reconciles anything missed. Requests never overlap; hidden tabs do not poll and refresh on return.
 * The sync of the Gmail mailbox itself runs on the server (scheduled job); nothing here drives it.
 */
export function SupportLiveProvider({ children }: { children: ReactNode }) {
  const { has } = usePermissions()
  const enabled = has('support.view')
  const [summary, setSummary] = useState<LiveSummary | null>(null)
  const [realtime, setRealtime] = useState(false)
  const inFlight = useRef(false)
  const again = useRef(false)
  const alive = useRef(true)
  // A change that arrives while a request is running is read right after it (never two requests at once).
  const self = useRef<() => void>(() => {})
  const load = useCallback(() => {
    if (!enabled) return
    if (inFlight.current) { again.current = true; return }
    inFlight.current = true
    fetchLiveSummary().then((s) => { if (alive.current) setSummary((prev) => (sameSummary(prev, s) ? prev : s)) }, () => {}).finally(() => {
      inFlight.current = false
      if (again.current && alive.current) { again.current = false; self.current() }
    })
  }, [enabled])
  useEffect(() => { self.current = load }, [load])

  // Fallback / reconciliation polling, paused while the tab is hidden; immediate refresh when it is shown again.
  useEffect(() => {
    alive.current = true
    if (!enabled) return
    load()
    const t = window.setInterval(() => { if (document.visibilityState === 'visible') load() }, POLL_MS)
    const onVisible = () => { if (document.visibilityState === 'visible') load() }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => {
      alive.current = false
      window.clearInterval(t)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [enabled, load])

  // Realtime with reconnect: a dropped channel is replaced after a growing delay.
  useEffect(() => {
    if (!enabled) return
    let stop = false
    let attempt = 0
    let retry: number | null = null
    let debounce: number | null = null
    let channel: ReturnType<ReturnType<typeof requireSupabase>['channel']> | null = null
    const poke = () => {
      if (debounce) window.clearTimeout(debounce)
      debounce = window.setTimeout(load, 250)
    }
    const connect = () => {
      if (stop) return
      try {
        const sb = requireSupabase()
        channel = sb.channel(`support-live-${Date.now()}`)
          .on('postgres_changes', { event: '*', schema: 'public', table: 'support_conversations' }, poke)
          .on('postgres_changes', { event: '*', schema: 'public', table: 'support_whatsapp_messages' }, poke)
          .on('postgres_changes', { event: '*', schema: 'public', table: 'support_call_signals' }, poke)
          .subscribe((status) => {
            if (stop) return
            if (status === 'SUBSCRIBED') { attempt = 0; setRealtime(true); load() }
            if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
              setRealtime(false)
              const old = channel
              channel = null
              if (old) void sb.removeChannel(old).catch(() => {})
              if (retry === null) retry = window.setTimeout(() => { retry = null; connect() }, RECONNECT_MS[Math.min(attempt++, RECONNECT_MS.length - 1)])
            }
          })
      } catch {
        setRealtime(false)
      }
    }
    connect()
    return () => {
      stop = true
      if (retry !== null) window.clearTimeout(retry)
      if (debounce) window.clearTimeout(debounce)
      if (channel) void requireSupabase().removeChannel(channel).catch(() => {})
      setRealtime(false)
    }
  }, [enabled, load])

  const value = useMemo(() => ({ summary: enabled ? summary : null, realtime, refresh: load }), [enabled, summary, realtime, load])
  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>
}
