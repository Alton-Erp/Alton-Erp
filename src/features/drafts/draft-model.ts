/**
 * Persistent form drafts (migration 20261117090000_form_drafts.sql).
 * Pure helpers used by usePersistentFormDraft: serialisation (no secrets, no
 * files), the browser copy, and the decision of what to restore when a form opens.
 */

export type DraftFormKey =
  | 'product.form'
  | 'bom.editor'
  | 'production.order'
  | 'purchase.order'
  | 'purchase.receipt'
  | 'sales.order'
  | 'billing.invoice'
  | 'billing.payment'
  | 'ledger.party'
  | 'inventory.opening'
  | 'users.invite'

export type DraftRowStatus = 'draft' | 'submitted' | 'discarded'

/** A draft as returned by erp_form_draft_get / _save (data only while status = draft). */
export interface ServerDraft {
  id: string
  version: number
  status: DraftRowStatus
  data: unknown
  base_version: string | null
  last_saved_at: string
}

/** The browser copy, written on every change so nothing is lost before the server save. */
export interface LocalDraft {
  data: unknown
  /** Server version this copy was based on (0 = no server draft yet). */
  serverVersion: number
  baseVersion: string | null
  savedAt: string
  /** True while the copy has changes the server has not confirmed. */
  dirty: boolean
}

/** Keys that never go into a draft (the server refuses them too). */
export const SECRET_KEY = /(password|passwd|passcode|secret|token|otp|cvv|card_?number|api_?key|private_?key)/i

/**
 * JSON-safe copy of form values: secrets, files, functions and undefined are left
 * out; dates become ISO strings. Returns the JSON text (stable for comparisons).
 */
export function serializeDraft(value: unknown): string {
  return JSON.stringify(value, (key, v: unknown) => {
    if (key && SECRET_KEY.test(key)) return undefined
    if (typeof v === 'function' || typeof v === 'symbol') return undefined
    if (typeof Blob !== 'undefined' && v instanceof Blob) return undefined
    return v
  }) ?? 'null'
}

export const parseDraft = <T>(text: string): T => JSON.parse(text) as T

export function localDraftKey(p: { userId: string; companyId: string; formKey: string; recordId?: string | null; scope?: string | null }): string {
  return `alton:draft:v1:${p.userId}:${p.companyId}:${p.formKey}:${p.recordId ?? ''}:${p.scope ?? ''}`
}

export const LOCAL_PREFIX = 'alton:draft:v1:'

interface StorageLike {
  getItem(k: string): string | null
  setItem(k: string, v: string): void
  removeItem(k: string): void
  readonly length: number
  key(i: number): string | null
}

export function readLocal(storage: StorageLike | null, key: string): LocalDraft | null {
  try {
    const raw = storage?.getItem(key)
    if (!raw) return null
    const v = JSON.parse(raw) as LocalDraft
    return v && typeof v === 'object' && 'data' in v && typeof v.serverVersion === 'number' ? v : null
  } catch {
    return null
  }
}

export function writeLocal(storage: StorageLike | null, key: string, draft: LocalDraft): void {
  try {
    storage?.setItem(key, JSON.stringify(draft))
  } catch {
    // Storage full or blocked: the server copy still works.
  }
}

export function removeLocal(storage: StorageLike | null, key: string): void {
  try {
    storage?.removeItem(key)
  } catch {
    // ignore
  }
}

/**
 * On sign-out: removes this user's browser copies that the server already holds.
 * Copies with unsaved changes stay (they are re-sent on the next sign-in) unless `all`.
 */
export function clearLocalDrafts(storage: StorageLike | null, userId: string, all = false): number {
  let removed = 0
  try {
    if (!storage) return 0
    const keys: string[] = []
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i)
      if (k?.startsWith(`${LOCAL_PREFIX}${userId}:`)) keys.push(k)
    }
    for (const k of keys) {
      if (all || !readLocal(storage, k)?.dirty) {
        storage.removeItem(k)
        removed++
      }
    }
  } catch {
    // ignore
  }
  return removed
}

export type RestoreDecision =
  | { action: 'none'; serverVersion: number; clearLocal: boolean }
  | { action: 'restore'; source: 'server' | 'local'; data: unknown; serverVersion: number; serverData: unknown; needsSave: boolean }
  | { action: 'stale'; data: unknown; serverVersion: number; serverData: unknown }
  | { action: 'conflict'; local: unknown; remote: unknown; serverVersion: number }

/**
 * What to show when a form opens.
 * - The server draft is restored; a browser copy with unsaved changes made on top of
 *   the same server version wins (it is newer) and is saved.
 * - A browser copy made on an older version than the server's (another tab or device
 *   saved since) is a conflict: the user chooses.
 * - For edit forms, a draft started from an older version of the record is not
 *   applied automatically (the record changed since): the user may restore it.
 */
export function decideRestore(remote: ServerDraft | null, local: LocalDraft | null, baseVersion: string | null | undefined): RestoreDecision {
  const serverVersion = remote?.version ?? 0
  const remoteOpen = remote !== null && remote.status === 'draft' && remote.data !== null && remote.data !== undefined
  const serverData = remoteOpen ? remote.data : null
  let candidate: { source: 'server' | 'local'; data: unknown; base: string | null; needsSave: boolean } | null = null

  if (local?.dirty) {
    if (local.serverVersion === serverVersion) {
      candidate = { source: 'local', data: local.data, base: local.baseVersion, needsSave: true }
    } else if (remoteOpen && serializeDraft(local.data) === serializeDraft(remote.data)) {
      // The save reached the server but the page closed before the copy was marked saved.
      candidate = { source: 'server', data: remote.data, base: remote.base_version, needsSave: false }
    } else if (remoteOpen) {
      return { action: 'conflict', local: local.data, remote: remote.data, serverVersion }
    } else {
      // Submitted or discarded in another window after these changes: not resurrected.
      return { action: 'none', serverVersion, clearLocal: true }
    }
  } else if (remoteOpen) {
    candidate = { source: 'server', data: remote.data, base: remote.base_version, needsSave: false }
  }

  if (!candidate) return { action: 'none', serverVersion, clearLocal: local !== null }
  if (baseVersion && candidate.base && candidate.base !== baseVersion) {
    return { action: 'stale', data: candidate.data, serverVersion, serverData }
  }
  return { action: 'restore', source: candidate.source, data: candidate.data, serverVersion, serverData, needsSave: candidate.needsSave }
}

export type DraftStatus = 'disabled' | 'loading' | 'idle' | 'pending' | 'saving' | 'saved' | 'error' | 'conflict'

export const DRAFT_STATUS_TEXT: Record<DraftStatus, string> = {
  disabled: '',
  loading: 'Checking for a saved draft…',
  idle: 'Changes are saved automatically',
  pending: 'Unsaved changes…',
  saving: 'Saving…',
  saved: 'All changes saved',
  error: 'Unable to save',
  conflict: 'Changed in another window',
}

export const RESTORED_MESSAGE = 'An unsaved draft was found. Your previous entries have been restored.'

/** Retry delays after a failed save (ms): 5 s, 15 s, 30 s, then every 60 s. */
export const retryDelay = (attempt: number) => [5000, 15000, 30000][attempt] ?? 60000

export const DEBOUNCE_MS = 1500
