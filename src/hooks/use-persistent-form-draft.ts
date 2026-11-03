import { useCallback, useEffect, useRef, useState } from 'react'

import { useAuth } from '@/auth/use-auth'
import { browserStorage, registerDraftFlush } from '@/features/drafts/draft-flush'
import {
  DEBOUNCE_MS,
  decideRestore,
  localDraftKey,
  parseDraft,
  readLocal,
  removeLocal,
  retryDelay,
  serializeDraft,
  writeLocal,
  type DraftFormKey,
  type DraftStatus,
} from '@/features/drafts/draft-model'
import { describeDataError } from '@/lib/errors'
import { supabase } from '@/lib/supabase'
import { closeFormDraft, fetchFormDraft, saveFormDraft, type DraftRef } from '@/services/form-drafts'

export type DraftNotice<T> =
  | { kind: 'restored' }
  | { kind: 'available'; data: T }
  | { kind: 'stale'; data: T }
  | { kind: 'conflict'; data: T }
  | { kind: 'closed-elsewhere' }
  | { kind: 'discarded'; data: T }

export interface PersistentFormDraftOptions<T> {
  /** Registered form (see private.erp_form_draft_registry). */
  formKey: DraftFormKey
  /** The record being edited; null/undefined for a new record. */
  recordId?: string | null
  /** Separates variants of a new form (e.g. "copy:<id>", "mode:so"). */
  scope?: string
  /** The form's current values (any JSON-serialisable shape). */
  value: T
  /** Puts saved values back into the form. */
  onRestore: (data: T) => void
  /** Version of the record being edited (updated_at): an older draft is not applied over a newer record. */
  baseVersion?: string | null
  /** False until the form shows its initial values, or when it is read-only. */
  enabled?: boolean
}

export interface PersistentFormDraft<T> {
  status: DraftStatus
  notice: DraftNotice<T> | null
  error: string | null
  lastSavedAt: string | null
  /** A draft exists on the server or in this browser. */
  hasDraft: boolean
  saveNow: () => Promise<void>
  retry: () => void
  /** Drops the saved draft and puts the form back to how it opened (or keeps what is on screen). */
  discard: (opts?: { keepValues?: boolean }) => Promise<void>
  restoreDraft: () => void
  dismissNotice: () => void
  resolveConflict: (keep: 'mine' | 'theirs') => void
  /** Call only after the form's own save succeeded: closes the draft. */
  markSubmitted: () => Promise<void>
}

/**
 * Auto-saves a form's working values and restores them when the form is opened
 * again (after switching module, refreshing, closing the browser or signing in
 * again). Values are kept in this browser at once and saved to Supabase after
 * 1.5 s without typing, when the page is hidden, and when the form closes.
 * Drafts never change ERP records; the form's own Save does that.
 */
export function usePersistentFormDraft<T>(opts: PersistentFormDraftOptions<T>): PersistentFormDraft<T> {
  const { user, access, status: authStatus } = useAuth()
  const userId = user?.id ?? ''
  const companyId = access?.company?.id ?? ''
  const enabled = (opts.enabled ?? true) && Boolean(supabase) && authStatus === 'authorized' && Boolean(userId && companyId)
  const ref: DraftRef = { formKey: opts.formKey, recordId: opts.recordId ?? null, scope: opts.scope ?? '' }
  // A new version of the record (saved in place) starts a fresh draft session.
  const identity = `${userId}|${companyId}|${ref.formKey}|${ref.recordId ?? ''}|${ref.scope}|${opts.baseVersion ?? ''}`
  const storageKey = localDraftKey({ userId, companyId, formKey: ref.formKey, recordId: ref.recordId, scope: ref.scope })
  const serialized = serializeDraft(opts.value)

  const [status, setStatus] = useState<DraftStatus>(enabled ? 'loading' : 'disabled')
  const [notice, setNotice] = useState<DraftNotice<T> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null)
  const [hasDraft, setHasDraft] = useState(false)

  const optsRef = useRef(opts)
  const refRef = useRef(ref)
  const keyRef = useRef(storageKey)
  const latest = useRef(serialized)
  const pristine = useRef<string | null>(null)
  const lastSaved = useRef<string | null>(null)
  const serverVersion = useRef(0)
  const serverOpen = useRef(false)
  const ready = useRef(false)
  const closed = useRef(false)
  const blocked = useRef(false)
  const inFlight = useRef<Promise<void> | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const attempts = useRef(0)
  const mounted = useRef(true)
  const saveRef = useRef<() => Promise<void>>(async () => {})
  // Version reported by a conflict; adopted only when the user keeps their version.
  const conflictVersion = useRef(0)
  const noticeRef = useRef<DraftNotice<T> | null>(null)

  useEffect(() => {
    optsRef.current = opts
    refRef.current = ref
    keyRef.current = storageKey
    latest.current = serialized
    noticeRef.current = notice
  })

  const safe = useCallback(<A,>(fn: (a: A) => void) => (a: A) => { if (mounted.current) fn(a) }, [])
  const clearTimers = () => {
    if (timer.current) clearTimeout(timer.current)
    if (retryTimer.current) clearTimeout(retryTimer.current)
    timer.current = null
    retryTimer.current = null
  }
  const keepLocal = (text: string, dirty: boolean) =>
    writeLocal(browserStorage(), keyRef.current, { data: parseDraft(text), serverVersion: serverVersion.current, baseVersion: optsRef.current.baseVersion ?? null,
      savedAt: new Date().toISOString(), dirty })

  // ---- save -----------------------------------------------------------------
  const save = useCallback(async (): Promise<void> => {
    if (!ready.current || closed.current || blocked.current) return
    if (inFlight.current) {
      await inFlight.current
      if (latest.current !== lastSaved.current) return saveRef.current()
      return
    }
    const text = latest.current
    if (text === lastSaved.current) return
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    const run = (async () => {
      safe(setStatus)('saving')
      try {
        const res = await saveFormDraft(refRef.current, parseDraft(text), optsRef.current.baseVersion ?? null, serverVersion.current)
        if (closed.current) return
        if (res.status === 'SAVED') {
          serverVersion.current = res.draft.version
          serverOpen.current = true
          lastSaved.current = text
          attempts.current = 0
          keepLocal(latest.current, latest.current !== text)
          safe(setLastSavedAt)(res.draft.last_saved_at)
          safe(setHasDraft)(true)
          safe(setError)(null)
          safe(setStatus)(latest.current === text ? 'saved' : 'pending')
        } else {
          blocked.current = true
          conflictVersion.current = res.draft.version
          safe(setStatus)('conflict')
          safe(setNotice)(res.draft.status === 'draft' ? { kind: 'conflict', data: res.draft.data as T } : { kind: 'closed-elsewhere' })
        }
      } catch (e) {
        safe(setStatus)('error')
        safe(setError)(describeDataError(e))
        // The browser copy keeps the changes; try again later.
        if (mounted.current && !closed.current) {
          retryTimer.current = setTimeout(() => void saveRef.current(), retryDelay(attempts.current++))
        }
      }
    })()
    inFlight.current = run
    try {
      await run
    } finally {
      inFlight.current = null
    }
    if (!closed.current && !blocked.current && mounted.current && latest.current !== lastSaved.current && attempts.current === 0) {
      timer.current = setTimeout(() => void saveRef.current(), DEBOUNCE_MS)
    }
  }, [safe])
  useEffect(() => { saveRef.current = save }, [save])

  // ---- load and restore when the form opens -----------------------------------
  useEffect(() => {
    mounted.current = true
    if (!enabled) {
      void Promise.resolve().then(() => setStatus('disabled'))
      return
    }
    let cancelled = false
    ready.current = false
    closed.current = false
    blocked.current = false
    pristine.current = latest.current
    lastSaved.current = null
    serverVersion.current = 0
    serverOpen.current = false
    void Promise.resolve().then(() => { if (!cancelled) setStatus('loading') })
    fetchFormDraft(refRef.current).then(
      (remote) => {
        if (cancelled) return
        const local = readLocal(browserStorage(), keyRef.current)
        const d = decideRestore(remote, local, optsRef.current.baseVersion)
        serverVersion.current = d.serverVersion
        const touched = latest.current !== pristine.current
        if (d.action === 'none') {
          if (d.clearLocal) removeLocal(browserStorage(), keyRef.current)
          setStatus('idle')
        } else if (d.action === 'conflict') {
          serverOpen.current = true
          conflictVersion.current = d.serverVersion
          serverVersion.current = local?.serverVersion ?? 0
          lastSaved.current = serializeDraft(d.remote)
          optsRef.current.onRestore(d.local as T)
          blocked.current = true
          setHasDraft(true)
          setNotice({ kind: 'conflict', data: d.remote as T })
          setStatus('conflict')
        } else {
          serverOpen.current = d.serverData !== null
          lastSaved.current = d.serverData === null ? null : serializeDraft(d.serverData)
          setHasDraft(true)
          if (remote?.last_saved_at) setLastSavedAt(remote.last_saved_at)
          if (d.action === 'stale') {
            setNotice({ kind: 'stale', data: d.data as T })
            setStatus('idle')
          } else if (touched) {
            // The user started typing before the draft arrived: never overwrite it.
            setNotice({ kind: 'available', data: d.data as T })
            setStatus('pending')
          } else {
            optsRef.current.onRestore(d.data as T)
            setNotice({ kind: 'restored' })
            setStatus(d.needsSave ? 'pending' : 'saved')
          }
        }
        ready.current = true
      },
      (e: unknown) => {
        if (cancelled) return
        // Server unreachable: fall back to this browser's copy.
        const local = readLocal(browserStorage(), keyRef.current)
        if (local && latest.current === pristine.current) {
          serverVersion.current = local.serverVersion
          optsRef.current.onRestore(local.data as T)
          setNotice({ kind: 'restored' })
          setHasDraft(true)
        }
        setError(describeDataError(e))
        setStatus('error')
        ready.current = true
      },
    )
    return () => {
      cancelled = true
    }
  }, [enabled, identity])

  // ---- every change: browser copy now, server after a pause ---------------------
  useEffect(() => {
    if (!ready.current || closed.current) return
    if (blocked.current) {
      // Waiting for the user to resolve a conflict: keep the changes in this browser only.
      if (serialized !== pristine.current) keepLocal(serialized, true)
      return
    }
    if (serialized === lastSaved.current) {
      if (timer.current) clearTimeout(timer.current)
      if (lastSaved.current !== null) keepLocal(serialized, false)
      void Promise.resolve().then(() => setStatus((s) => (s === 'pending' ? 'saved' : s)))
      return
    }
    if (serialized === pristine.current && !serverOpen.current) {
      // Back to the original values and nothing on the server: nothing to keep.
      if (timer.current) clearTimeout(timer.current)
      removeLocal(browserStorage(), keyRef.current)
      void Promise.resolve().then(() => setStatus((s) => (s === 'error' ? s : 'idle')))
      return
    }
    keepLocal(serialized, true)
    void Promise.resolve().then(() => { setHasDraft(true); setStatus((s) => (s === 'error' ? s : 'pending')) })
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => void saveRef.current(), DEBOUNCE_MS)
  }, [serialized])

  // ---- save when the page is hidden, the form closes, or the user signs out -------
  useEffect(() => {
    if (!enabled) return
    const flush = () => {
      if (ready.current && !closed.current && latest.current !== lastSaved.current) return saveRef.current()
      return Promise.resolve()
    }
    const onHide = () => { if (document.visibilityState === 'hidden') void flush() }
    document.addEventListener('visibilitychange', onHide)
    window.addEventListener('pagehide', onHide)
    const unregister = registerDraftFlush(flush)
    return () => {
      document.removeEventListener('visibilitychange', onHide)
      window.removeEventListener('pagehide', onHide)
      unregister()
      mounted.current = false
      clearTimers()
      // Leaving the form (another module, tab or page): send what is pending.
      void flush()
    }
  }, [enabled, identity])

  // ---- actions ---------------------------------------------------------------
  const saveNow = useCallback(async () => {
    attempts.current = 0
    if (retryTimer.current) clearTimeout(retryTimer.current)
    if (latest.current === lastSaved.current && !blocked.current) {
      setStatus('saved')
      return
    }
    await saveRef.current()
  }, [])

  const discard = useCallback(async (o?: { keepValues?: boolean }) => {
    const current = latest.current
    clearTimers()
    removeLocal(browserStorage(), keyRef.current)
    if (serverOpen.current) {
      try {
        const r = await closeFormDraft(refRef.current, 'discarded')
        if (typeof r.version === 'number' && r.version > 0) serverVersion.current = r.version
      } catch (e) {
        setError(describeDataError(e))
      }
    }
    serverOpen.current = false
    blocked.current = false
    lastSaved.current = null
    setHasDraft(false)
    if (o?.keepValues) {
      // The saved draft is dropped; what is on screen stays (and is saved as a new draft if it was changed).
      setNotice(null)
      if (latest.current !== pristine.current) void Promise.resolve().then(() => saveRef.current())
    } else {
      if (pristine.current !== null) optsRef.current.onRestore(parseDraft<T>(pristine.current))
      setNotice({ kind: 'discarded', data: parseDraft<T>(current) })
    }
    setStatus('idle')
  }, [])

  const restoreDraft = useCallback(() => {
    const n = noticeRef.current
    if (!n || !('data' in n) || n.kind === 'conflict') return
    // Saved again so the draft records the record version it now applies to.
    lastSaved.current = null
    optsRef.current.onRestore(n.data)
    setHasDraft(true)
    setNotice({ kind: 'restored' })
  }, [])

  const resolveConflict = useCallback((keep: 'mine' | 'theirs') => {
    const n = noticeRef.current
    blocked.current = false
    serverVersion.current = conflictVersion.current
    if (keep === 'theirs' && n?.kind === 'conflict') {
      lastSaved.current = serializeDraft(n.data)
      optsRef.current.onRestore(n.data)
      keepLocal(lastSaved.current, false)
      setStatus('saved')
    } else if (keep === 'theirs') {
      // Submitted or discarded elsewhere: start again from the original values.
      lastSaved.current = null
      serverOpen.current = false
      removeLocal(browserStorage(), keyRef.current)
      if (pristine.current !== null) optsRef.current.onRestore(parseDraft<T>(pristine.current))
      setHasDraft(false)
      setStatus('idle')
    } else {
      // Keep this window's values: saved over the other version.
      lastSaved.current = null
      void Promise.resolve().then(() => saveRef.current())
    }
    setNotice(null)
  }, [])

  const markSubmitted = useCallback(async () => {
    closed.current = true
    clearTimers()
    removeLocal(browserStorage(), keyRef.current)
    setHasDraft(false)
    if (inFlight.current) await inFlight.current.catch(() => {})
    for (let i = 0; i < 3; i++) {
      try {
        await closeFormDraft(refRef.current, 'submitted')
        return
      } catch {
        await new Promise((r) => setTimeout(r, 1000 * (i + 1)))
      }
    }
  }, [])

  const retry = useCallback(() => void saveNow(), [saveNow])
  const dismissNotice = useCallback(() => setNotice(null), [])

  return { status, notice, error, lastSavedAt, hasDraft, saveNow, retry, discard, restoreDraft, dismissNotice, resolveConflict, markSubmitted }
}
