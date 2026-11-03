import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  clearLocalDrafts,
  decideRestore,
  localDraftKey,
  readLocal,
  retryDelay,
  serializeDraft,
  writeLocal,
  type LocalDraft,
  type ServerDraft,
} from '../../src/features/drafts/draft-model.ts'

class MemoryStorage {
  private m = new Map<string, string>()
  get length() { return this.m.size }
  key(i: number) { return [...this.m.keys()][i] ?? null }
  getItem(k: string) { return this.m.get(k) ?? null }
  setItem(k: string, v: string) { this.m.set(k, v) }
  removeItem(k: string) { this.m.delete(k) }
}

const server = (over: Partial<ServerDraft> = {}): ServerDraft => ({ id: 'd1', version: 3, status: 'draft', data: { h: { ref: 'SERVER' } }, base_version: null, last_saved_at: '2026-11-03T10:00:00Z', ...over })
const local = (over: Partial<LocalDraft> = {}): LocalDraft => ({ data: { h: { ref: 'LOCAL' } }, serverVersion: 3, baseVersion: null, savedAt: '2026-11-03T10:01:00Z', dirty: true, ...over })

describe('serializeDraft', () => {
  it('keeps line items, nested arrays, dropdown values, dates and numbers exactly', () => {
    const v = { h: { supplier_id: 'abc', po_date: '2026-11-03', terms: 'NET_30' }, lines: [{ product: { id: 'p1', sku: 'X' }, qty: '10', tags: [1, null] }], step: 2 }
    assert.deepEqual(JSON.parse(serializeDraft(v)), v)
  })
  it('drops passwords, tokens and other secrets at any depth, and files', () => {
    const file = new Blob(['x'])
    const text = serializeDraft({ name: 'A', password: 'p', nested: [{ access_token: 't', otp: '1', note: 'ok' }], apiKey: 'k', image: file, fn: () => 1 })
    assert.deepEqual(JSON.parse(text), { name: 'A', nested: [{ note: 'ok' }] })
  })
  it('is stable for comparisons (same values, same text)', () => {
    assert.equal(serializeDraft({ a: 1, b: [1, 2] }), serializeDraft({ a: 1, b: [1, 2] }))
  })
})

describe('decideRestore', () => {
  it('nothing saved: nothing restored', () => {
    assert.deepEqual(decideRestore(null, null, null), { action: 'none', serverVersion: 0, clearLocal: false })
  })
  it('server draft is restored (reopen, refresh, other browser, after signing in again)', () => {
    const d = decideRestore(server(), null, null)
    assert.equal(d.action, 'restore')
    assert.deepEqual(d.action === 'restore' && d.data, { h: { ref: 'SERVER' } })
    assert.equal(d.action === 'restore' && d.needsSave, false)
  })
  it('unsaved changes in this browser made on the same server version are newer: restored and saved', () => {
    const d = decideRestore(server(), local(), null)
    assert.equal(d.action === 'restore' && d.source, 'local')
    assert.equal(d.action === 'restore' && d.needsSave, true)
  })
  it('changes made before the first server save (offline) are restored', () => {
    const d = decideRestore(null, local({ serverVersion: 0 }), null)
    assert.equal(d.action === 'restore' && d.source, 'local')
  })
  it('another window saved since this browser\'s copy: conflict, nothing overwritten', () => {
    const d = decideRestore(server({ version: 5 }), local({ serverVersion: 3 }), null)
    assert.equal(d.action, 'conflict')
    assert.deepEqual(d.action === 'conflict' && [d.local, d.remote], [{ h: { ref: 'LOCAL' } }, { h: { ref: 'SERVER' } }])
  })
  it('the save reached the server but the page closed first: same values, no conflict', () => {
    const d = decideRestore(server({ version: 5, data: { h: { ref: 'SAME' } } }), local({ serverVersion: 3, data: { h: { ref: 'SAME' } } }), null)
    assert.equal(d.action === 'restore' && d.source, 'server')
  })
  it('submitted in another window: the old copy is not brought back', () => {
    assert.deepEqual(decideRestore(server({ version: 4, status: 'submitted', data: null }), local(), null), { action: 'none', serverVersion: 4, clearLocal: true })
  })
  it('a clean browser copy is ignored when the server has nothing open', () => {
    assert.equal(decideRestore(server({ status: 'discarded', data: null }), local({ dirty: false }), null).action, 'none')
  })
  it('edit form: a draft started on an older version of the record is not applied automatically', () => {
    const d = decideRestore(server({ base_version: '2026-11-01T00:00:00Z' }), null, '2026-11-03T00:00:00Z')
    assert.equal(d.action, 'stale')
    assert.equal(decideRestore(server({ base_version: '2026-11-03T00:00:00Z' }), null, '2026-11-03T00:00:00Z').action, 'restore')
  })
})

describe('browser copy', () => {
  it('per user, company, form, record and scope', () => {
    const a = localDraftKey({ userId: 'u1', companyId: 'c1', formKey: 'purchase.order' })
    assert.notEqual(a, localDraftKey({ userId: 'u2', companyId: 'c1', formKey: 'purchase.order' }))
    assert.notEqual(a, localDraftKey({ userId: 'u1', companyId: 'c2', formKey: 'purchase.order' }))
    assert.notEqual(a, localDraftKey({ userId: 'u1', companyId: 'c1', formKey: 'purchase.order', recordId: 'r1' }))
    assert.notEqual(a, localDraftKey({ userId: 'u1', companyId: 'c1', formKey: 'purchase.order', scope: 'copy:x' }))
  })
  it('write / read; unreadable values and missing storage never throw', () => {
    const s = new MemoryStorage()
    writeLocal(s, 'k', local())
    assert.deepEqual(readLocal(s, 'k'), local())
    s.setItem('bad', '{oops')
    assert.equal(readLocal(s, 'bad'), null)
    assert.equal(readLocal(null, 'k'), null)
    writeLocal(null, 'k', local())
  })
  it('sign-out removes this user\'s synced copies, keeps unsynced ones, never touches other users', () => {
    const s = new MemoryStorage()
    const k = (u: string, f: string) => localDraftKey({ userId: u, companyId: 'c', formKey: f })
    writeLocal(s, k('u1', 'a'), local({ dirty: false }))
    writeLocal(s, k('u1', 'b'), local({ dirty: true }))
    writeLocal(s, k('u2', 'a'), local({ dirty: false }))
    s.setItem('other-app', 'x')
    assert.equal(clearLocalDrafts(s, 'u1'), 1)
    assert.equal(readLocal(s, k('u1', 'a')), null)
    assert.ok(readLocal(s, k('u1', 'b')))
    assert.ok(readLocal(s, k('u2', 'a')))
    assert.equal(s.getItem('other-app'), 'x')
    assert.equal(clearLocalDrafts(s, 'u1', true), 1)
  })
  it('failed saves are retried with growing delays', () => {
    assert.deepEqual([0, 1, 2, 3, 9].map(retryDelay), [5000, 15000, 30000, 60000, 60000])
  })
})
