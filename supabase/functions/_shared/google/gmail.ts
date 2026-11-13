// Gmail API client (https://gmail.googleapis.com/gmail/v1/users/me/...). Ids are validated before they go into
// a path; reads are retried twice on 429 / 5xx with backoff; sends are never retried automatically.

import { GOOGLE, fetchWithTimeout } from './google.ts'

const ID = /^[A-Za-z0-9_-]{6,64}$/
const ATTACHMENT_ID = /^[A-Za-z0-9_-]{6,2048}$/

export class GmailError extends Error {
  readonly status: number
  readonly reason: string | null
  constructor(status: number, message: string, reason: string | null = null) {
    super(message)
    this.status = status
    this.reason = reason
  }
}

export interface GmailPart {
  partId?: string; mimeType?: string; filename?: string
  headers?: { name: string; value: string }[]
  body?: { size?: number; data?: string; attachmentId?: string }
  parts?: GmailPart[]
}
export interface GmailMessage { id: string; threadId?: string; labelIds?: string[]; internalDate?: string; sizeEstimate?: number; payload?: GmailPart; historyId?: string }
export interface HistoryPage {
  history?: { id: string; messagesAdded?: { message: { id: string; threadId?: string; labelIds?: string[] } }[] }[]
  nextPageToken?: string
  historyId?: string
}

export class Gmail {
  private readonly fetcher: typeof fetch
  private readonly token: string
  private readonly sleep: (ms: number) => Promise<void>
  constructor(fetcher: typeof fetch, token: string, sleep: (ms: number) => Promise<void>) {
    this.fetcher = fetcher
    this.token = token
    this.sleep = sleep
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown, retry = method === 'GET'): Promise<T> {
    let last: GmailError | null = null
    for (let attempt = 0; attempt < (retry ? 3 : 1); attempt++) {
      if (attempt > 0) await this.sleep(1000 * 2 ** (attempt - 1))
      let res: Response
      try {
        res = await fetchWithTimeout(this.fetcher, `${GOOGLE.gmail}${path}`, {
          method,
          headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          body: body === undefined ? undefined : JSON.stringify(body),
        }, 25000)
      } catch {
        last = new GmailError(0, 'Gmail could not be reached (network error or timeout).')
        continue
      }
      if (res.ok) return (res.status === 204 ? {} : await res.json().catch(() => ({}))) as T
      const json = await res.json().catch(() => null) as { error?: { message?: string; status?: string; errors?: { reason?: string }[] } } | null
      last = new GmailError(res.status, json?.error?.message?.slice(0, 300) ?? `Gmail answered HTTP ${res.status}.`, json?.error?.errors?.[0]?.reason ?? json?.error?.status ?? null)
      if (res.status !== 429 && res.status < 500) break
    }
    throw last!
  }

  profile() {
    return this.call<{ emailAddress: string; historyId: string }>('GET', '/profile')
  }
  history(startHistoryId: string, pageToken?: string) {
    if (!/^[0-9]{1,20}$/.test(startHistoryId)) throw new GmailError(400, 'Invalid history id.')
    const q = new URLSearchParams({ startHistoryId, historyTypes: 'messageAdded', maxResults: '500' })
    if (pageToken) q.set('pageToken', pageToken)
    return this.call<HistoryPage>('GET', `/history?${q}`)
  }
  list(query: string, maxResults: number, pageToken?: string) {
    const q = new URLSearchParams({ q: query, maxResults: String(Math.min(500, Math.max(1, maxResults))) })
    if (pageToken) q.set('pageToken', pageToken)
    return this.call<{ messages?: { id: string; threadId: string }[]; nextPageToken?: string }>('GET', `/messages?${q}`)
  }
  get(id: string) {
    if (!ID.test(id)) throw new GmailError(400, 'Invalid message id.')
    return this.call<GmailMessage>('GET', `/messages/${id}?format=full`)
  }
  attachment(messageId: string, attachmentId: string) {
    if (!ID.test(messageId) || !ATTACHMENT_ID.test(attachmentId)) throw new GmailError(400, 'Invalid attachment id.')
    return this.call<{ size?: number; data?: string }>('GET', `/messages/${messageId}/attachments/${attachmentId}`)
  }
  /** One attempt only: a retried send could deliver the email twice. */
  send(raw: string, threadId: string | null) {
    if (threadId !== null && !ID.test(threadId)) throw new GmailError(400, 'Invalid thread id.')
    return this.call<{ id?: string; threadId?: string; labelIds?: string[] }>('POST', '/messages/send', threadId ? { raw, threadId } : { raw }, false)
  }
  watch(topicName: string) {
    return this.call<{ historyId?: string; expiration?: string }>('POST', '/watch', { topicName, labelIds: ['INBOX'], labelFilterBehavior: 'INCLUDE' }, false)
  }
  stop() {
    return this.call<unknown>('POST', '/stop', undefined, false)
  }
  removeUnread(ids: string[]) {
    const clean = ids.filter((x) => ID.test(x)).slice(0, 1000)
    return this.call<unknown>('POST', '/messages/batchModify', { ids: clean, removeLabelIds: ['UNREAD'] }, false)
  }
}
