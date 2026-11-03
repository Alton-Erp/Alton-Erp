// Simultaneous-request checks against a STAGING Supabase project (Phases 11-12).
// Sends parallel requests through the public API (RLS applies, as in the app),
// signed in as the TEST accounts of company STG-A created by
// supabase/staging/seed_staging_test_data.sql, and checks that:
//   1. a request repeated with the same key posts once;
//   2. parallel stock issues never exceed available stock;
//   3. parallel reservations never exceed available stock;
//   4. a consignment dispatched by several requests at once is dispatched once;
//   5. parallel invoice drafts for one dispatch create one draft, and parallel
//      issue requests assign one invoice number;
//   6. a payment retried in parallel with the same key is recorded once;
//   7. two receipts racing to settle the same balance never over-allocate it.
//
// It WRITES clearly marked test records (product STG-CONC-1, customer STG-CUST-1)
// in test company STG-A only. It refuses to run for any other company.
//
//   CONFIRM_STAGING=yes node --env-file=.env.staging scripts/concurrency-check.mjs
//
// Environment (names only): VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY,
//   STAGING_EMAIL_PREFIX, STAGING_EMAIL_DOMAIN, STAGING_TEST_PASSWORD, CONFIRM_STAGING=yes
// Statuses: PASS / FAIL / BLOCKED / NOT RUN / MANUAL REVIEW REQUIRED (only PASS passes).
// Exit code: 0 all PASS, 1 any FAIL, 2 configuration missing / refused, 3 some BLOCKED.

import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

import { connectionFromEnv, createReport, errorText, missingEnv, preflight, stop } from './lib/staging.mjs'

const { url, key } = connectionFromEnv()
await preflight(url, key)
const missing = missingEnv(['STAGING_EMAIL_PREFIX', 'STAGING_EMAIL_DOMAIN', 'STAGING_TEST_PASSWORD'])
if (missing.length) stop(`Missing required environment variables: ${missing.join(', ')}.`)
if (process.env.CONFIRM_STAGING !== 'yes') stop('Set CONFIRM_STAGING=yes to confirm this is the STAGING project (this script writes test records).')

const report = createReport('Concurrency check')
const RUN = `${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}-${randomUUID().slice(0, 4)}`
const email = (tag) => `${process.env.STAGING_EMAIL_PREFIX}+${tag}@${process.env.STAGING_EMAIL_DOMAIN}`

async function signIn(tag) {
  const c = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  const r = await c.auth.signInWithPassword({ email: email(tag), password: process.env.STAGING_TEST_PASSWORD })
  if (r.error) stop(`The ${tag} test account could not sign in (${r.error.code ?? 'error'}). Run the staging seed and check STAGING_TEST_PASSWORD.`)
  const access = await c.rpc('get_my_access')
  const code = access.data?.company?.company_code ?? ''
  if (!code.startsWith('STG-')) stop(`The ${tag} account belongs to company "${code || 'none'}", not a STG- test company. Refusing to write data.`)
  return c
}
const inv = await signIn('stg-inventory')
const sales = await signIn('stg-sales')
const acc = await signIn('stg-accounts')
const rpc = (c, fn, args) => c.rpc(fn, args).then((r) => r, (e) => ({ error: e }))
const parallel = (n, make) => Promise.all(Array.from({ length: n }, (_, i) => make(i)))
const ok = (rs) => rs.filter((r) => !r.error)
const firstError = (rs) => errorText(rs.find((r) => r.error) ?? {})

const { data: product } = await inv.from('products').select('id').eq('sku', 'STG-CONC-1').maybeSingle()
const { data: wh } = await inv.from('warehouses').select('id').eq('warehouse_code', 'STG-W1').maybeSingle()
const { data: loc } = wh ? await inv.from('inventory_locations').select('id').eq('warehouse_id', wh.id).eq('location_code', 'GENERAL').maybeSingle() : { data: null }
const { data: customer } = await sales.from('customers').select('id').eq('customer_code', 'STG-CUST-1').maybeSingle()
if (!product || !wh || !loc || !customer) stop('Test records STG-CONC-1 / STG-W1 / STG-CUST-1 were not found. Run supabase/staging/seed_staging_test_data.sql first.')

const stock = async () => {
  const { data, error } = await inv.from('inventory_stock_detail').select('on_hand, reserved').eq('product_id', product.id).eq('location_id', loc.id)
  if (error) throw error
  return (data ?? []).reduce((s, r) => ({ onHand: s.onHand + Number(r.on_hand), free: s.free + Number(r.on_hand) - Number(r.reserved) }), { onHand: 0, free: 0 })
}
const receipt = (qty, k = randomUUID()) => rpc(inv, 'inventory_post_receipt', { p_product_id: product.id, p_location_id: loc.id, p_quantity: qty, p_source_type: 'IN_HOUSE',
  p_reason: `Concurrency check ${RUN} (TEST)`, p_idempotency_key: k })

// 1. Same key, 8 simultaneous requests
{
  const before = (await stock()).onHand
  const k = randomUUID()
  await parallel(8, () => receipt(5, k))
  const after = (await stock()).onHand
  report.check('1. same request key sent 8 times at once posts one receipt', after - before === 5, `on hand ${before} -> ${after} (expected +5)`)
}

// 2. Parallel issues beyond available
{
  const { free } = await stock()
  const rs = await parallel(free + 10, () => rpc(inv, 'inventory_post_issue', { p_product_id: product.id, p_location_id: loc.id, p_quantity: 1, p_source_type: 'IN_HOUSE',
    p_reason: `Concurrency check ${RUN} (TEST)`, p_idempotency_key: randomUUID() }))
  const after = await stock()
  report.check('2. parallel issues never exceed available stock', ok(rs).length === free && after.free === 0 && after.onHand >= 0,
    `${rs.length} requests, ${ok(rs).length} succeeded, ${free} were available, ${after.free} left`)
}

// 3. Parallel reservations beyond available
{
  await receipt(10)
  const { free } = await stock()
  const rs = await parallel(free + 10, (i) => rpc(inv, 'inventory_create_reservation', { p_product_id: product.id, p_location_id: loc.id, p_quantity: 1,
    p_reference_type: 'MANUAL', p_reference_number: `CONC-${RUN}-${i}`, p_source_type: 'IN_HOUSE', p_idempotency_key: randomUUID() }))
  const after = await stock()
  report.check('3. parallel reservations never exceed available stock', ok(rs).length === free && after.free === 0, `${rs.length} requests, ${ok(rs).length} succeeded, ${free} were available`)
  for (const r of ok(rs)) if (r.data?.reservation_id) await rpc(inv, 'inventory_release_reservation', { p_reservation_id: r.data.reservation_id, p_action: 'RELEASE', p_note: 'Concurrency check cleanup (TEST)' })
}

// 4. Order -> consignment -> simultaneous dispatch
let fulfilmentId = null
{
  await receipt(3)
  const so = await rpc(sales, 'sales_order_create_manual', { p_header: { customer_id: customer.id, warehouse_id: wh.id, customer_po_number: `TEST-${RUN}` },
    p_lines: [{ product_id: product.id, quantity: 3, unit_price: 100 }], p_confirm: true, p_idempotency_key: randomUUID() })
  const soId = so.data?.sales_order_id
  const alloc = soId ? await rpc(sales, 'sales_order_allocate', { p_so_id: soId, p_strategy: 'IN_HOUSE_FIRST', p_allow_partial: true, p_idempotency_key: randomUUID() }) : so
  const ful = soId && !alloc.error ? await rpc(inv, 'fulfilment_create', { p_so_id: soId, p_warehouse_id: wh.id, p_idempotency_key: randomUUID() }) : alloc
  fulfilmentId = ful.data?.fulfilment_id ?? null
  if (!fulfilmentId) report.blocked('4. simultaneous dispatch', `could not prepare the order: ${errorText(ful) || errorText(so)}`)
  else {
    const { data: lines } = await inv.from('fulfilment_line_list').select('id, quantity_to_pick').eq('fulfilment_id', fulfilmentId)
    const pick = await rpc(inv, 'fulfilment_pick', { p_fulfilment_id: fulfilmentId, p_lines: lines.map((l) => ({ line_id: l.id, quantity_picked: l.quantity_to_pick })), p_complete: true })
    const pack = await rpc(inv, 'fulfilment_pack', { p_fulfilment_id: fulfilmentId, p_lines: lines.map((l) => ({ line_id: l.id, quantity_packed: l.quantity_to_pick })), p_complete: true })
    const ready = await rpc(inv, 'fulfilment_action', { p_fulfilment_id: fulfilmentId, p_action: 'READY' })
    if (pick.error || pack.error || ready.error) report.blocked('4. simultaneous dispatch', `pick/pack/ready failed: ${errorText(pick) || errorText(pack) || errorText(ready)}`)
    else {
      const before = (await stock()).onHand
      const rs = await parallel(6, () => rpc(inv, 'fulfilment_dispatch', { p_fulfilment_id: fulfilmentId, p_details: { vehicle_number: 'TEST-0000' }, p_idempotency_key: randomUUID() }))
      const after = (await stock()).onHand
      const { data: done } = await inv.from('fulfilment_line_list').select('quantity_dispatched, issue_transaction_id').eq('fulfilment_id', fulfilmentId)
      const dispatched = (done ?? []).reduce((s, l) => s + Number(l.quantity_dispatched), 0)
      const ok4 = ok(rs).length === 1 && before - after === 3 && dispatched === 3 && (done ?? []).every((l) => l.issue_transaction_id)
      report.check('4. a consignment dispatched by 6 simultaneous requests is dispatched and deducted once', ok4,
        `${ok(rs).length} of 6 succeeded, stock ${before} -> ${after}, dispatched ${dispatched}${ok(rs).length ? '' : `; ${firstError(rs)}`}`)
    }
  }
}

// 5. Simultaneous invoice drafts and issue
let invoiceId = null
if (!fulfilmentId) report.blocked('5. simultaneous invoicing', 'needs the dispatched consignment from check 4')
else {
  const { data: lines } = await acc.from('fulfilment_line_list').select('id').eq('fulfilment_id', fulfilmentId)
  const drafts = await parallel(6, () => rpc(acc, 'sales_invoice_create_draft', { p_lines: lines.map((l) => ({ fulfilment_line_id: l.id })), p_header: {}, p_idempotency_key: randomUUID() }))
  report.check('5a. 6 simultaneous drafts for one dispatch create exactly one invoice draft', ok(drafts).length === 1, `${ok(drafts).length} succeeded${ok(drafts).length ? '' : `; ${firstError(drafts)}`}`)
  invoiceId = ok(drafts)[0]?.data?.invoice_id ?? null
  if (invoiceId) {
    const issues = await parallel(4, () => rpc(acc, 'sales_invoice_issue', { p_invoice_id: invoiceId, p_idempotency_key: randomUUID() }))
    const { data: row } = await acc.from('sales_invoice_list').select('invoice_number, status, grand_total').eq('id', invoiceId).maybeSingle()
    if (!ok(issues).length && /approval|validation problems/i.test(firstError(issues))) {
      report.blocked('5b. simultaneous issue', `the invoice could not be issued on staging: ${firstError(issues)} (check Invoice Settings / company GST details)`)
      invoiceId = null
    } else {
      const { count } = await acc.from('sales_invoices').select('id', { count: 'exact', head: true }).eq('invoice_number', row?.invoice_number ?? '-')
      report.check('5b. 4 simultaneous issue requests assign exactly one invoice number', ok(issues).length === 1 && row?.status === 'ISSUED' && count === 1,
        `${ok(issues).length} succeeded, status ${row?.status}, number ${row?.invoice_number}, total ${row?.grand_total}`)
    }
  }
}

// 6-7. Payment retries and an allocation race
if (!invoiceId) {
  report.blocked('6. payment retried in parallel', 'needs the issued invoice from check 5')
  report.blocked('7. allocation race', 'needs the issued invoice from check 5')
} else {
  const ref = `UTR-TEST-${RUN}`
  const k = randomUUID()
  await parallel(8, () => rpc(acc, 'customer_payment_record', { p_payment: { customer_id: customer.id, amount: 100, payment_method: 'BANK_TRANSFER', transaction_reference: ref },
    p_allocations: [{ invoice_id: invoiceId, amount: 100 }], p_idempotency_key: k }))
  const { data: pays } = await acc.from('customer_payment_list').select('id, allocated_amount').eq('transaction_reference', ref)
  report.check('6. a payment retried 8 times at once (same key) is recorded and allocated once', (pays ?? []).length === 1 && Number(pays[0].allocated_amount) === 100, `${(pays ?? []).length} receipt(s)`)

  const { data: before } = await acc.from('sales_invoice_list').select('balance_due').eq('id', invoiceId).maybeSingle()
  const due = Number(before?.balance_due ?? 0)
  const receipts = await parallel(2, (i) => rpc(acc, 'customer_payment_record', { p_payment: { customer_id: customer.id, amount: due, payment_method: 'CHEQUE', transaction_reference: `CHQ-TEST-${RUN}-${i}` },
    p_idempotency_key: randomUUID() }))
  const ids = ok(receipts).map((r) => r.data?.payment_id)
  if (ids.length !== 2 || due <= 0) report.blocked('7. allocation race', `could not record two test receipts: ${firstError(receipts) || `balance ${due}`}`)
  else {
    const allocs = await parallel(2, (i) => rpc(acc, 'customer_payment_allocate', { p_payment_id: ids[i], p_allocations: [{ invoice_id: invoiceId, amount: due }], p_idempotency_key: randomUUID() }))
    const { data: after } = await acc.from('sales_invoice_list').select('balance_due, payment_status').eq('id', invoiceId).maybeSingle()
    report.check('7. two receipts racing to settle the same balance: one succeeds, the balance never goes below zero', ok(allocs).length === 1 && Number(after?.balance_due) === 0,
      `${ok(allocs).length} of 2 allocations succeeded, balance ${due} -> ${after?.balance_due} (${after?.payment_status})`)
  }
}

for (const c of [inv, sales, acc]) await c.auth.signOut()
console.log(`\nTest records of this run are marked ${RUN} and stay in test company STG-A.`)
process.exit(report.finish())
