// One party form everywhere: Ledger → Add party, Purchase Orders → Add New Supplier, Sales Orders → Add New Customer
// (and invoices / imports) use the same fields, validation and save function. Static checks (no browser).
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { EMPTY_PARTY, validateParty } from '../../src/features/ledger/ledger-model.ts'

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')
const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
  const p = path.join(dir, f)
  return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) ? [p] : []
})
const all = files(src).map((p) => ({ p: path.relative(src, p).replace(/\\/g, '/'), s: readFileSync(p, 'utf8') }))
const form = readFileSync(path.join(src, 'features', 'ledger', 'party-form.tsx'), 'utf8')

describe('Unified party form', () => {
  it('the add-party dialog is the complete Ledger form (no reduced field set)', () => {
    const dialog = form.slice(form.indexOf('export function PartyFormDialog'))
    const fields = dialog.split('\n').find((l) => l.includes('<PartyFields')) ?? ''
    assert.ok(fields.includes('allowedTypes={allowedTypes}') && !/\bcompact\b/.test(fields), fields)
    assert.match(form, /export const QuickAddPartyDialog = PartyFormDialog/)
    // Same validation, recommendations, duplicate check and save as the Ledger page.
    for (const x of ['validateParty(values)', 'validation.warnings', 'DuplicatePanel', 'saveParty(null, validation.payload, confirm, key)']) assert.ok(dialog.includes(x), x)
  })
  it('the order screens offer only the party types that give them the role they need', () => {
    assert.match(form, /role === 'CUSTOMER' \? \['CUSTOMER', 'BOTH'\] : \['SUPPLIER', 'BOTH'\]/)
  })
  it('no screen creates parties with another form or another save call', () => {
    for (const f of all) {
      if (f.p === 'services/ledger.ts') continue
      assert.doesNotMatch(f.s, /rpc\('party_save'|\.rpc\("party_save"/, `${f.p} saves parties itself`)
      if (f.p !== 'features/ledger/party-form.tsx') assert.doesNotMatch(f.s, /<PartyFields[^>]*\bcompact\b/, `${f.p} uses a reduced party form`)
    }
    const users = all.filter((f) => /QuickAddPartyDialog|PartyFormDialog/.test(f.s) && f.p !== 'features/ledger/party-form.tsx').map((f) => f.p).sort()
    assert.ok(users.includes('pages/purchasing/po-form-page.tsx') && users.includes('pages/sales/sales-order-entry-page.tsx') && users.includes('features/sales/order-dialogs.tsx'), users.join())
  })
  it('the actions are labelled Add New Supplier / Add New Customer', () => {
    const po = all.find((f) => f.p === 'pages/purchasing/po-form-page.tsx')!.s
    const so = all.find((f) => f.p === 'pages/sales/sales-order-entry-page.tsx')!.s
    assert.match(po, /Add New Supplier/)
    assert.match(so, /Add New Customer/)
    assert.doesNotMatch(po + so, /> New (supplier|customer)</)
  })
  it('GSTIN fills state and PAN for every entry point (shared validation)', () => {
    const v = validateParty({ ...EMPTY_PARTY, party_type: 'SUPPLIER', party_name: 'Shree Clay Works', gstin: '27aabcm1234a1z5' })
    assert.equal(v.payload?.gstin, '27AABCM1234A1Z5')
    assert.equal(v.payload?.state_code, '27')
    assert.equal(v.payload?.pan, 'AABCM1234A')
    assert.ok(validateParty({ ...EMPTY_PARTY, party_type: 'CUSTOMER', party_name: 'X', gstin: '27BAD' }).errors.gstin)
  })
})
