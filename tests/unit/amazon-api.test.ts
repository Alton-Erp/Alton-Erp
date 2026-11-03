import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { AdsClient, reportRows, reportSpecs, targetRows } from '../../supabase/functions/_shared/amazon/ads.ts'
import { AmazonApiError, fetchWithRetry, paginate, redact, retryDelay, downloadText } from '../../supabase/functions/_shared/amazon/http.ts'
import { clearTokenCache, getAccessToken } from '../../supabase/functions/_shared/amazon/lwa.ts'
import { feeRows, inventoryRows, listingRows, localDate, salesTrafficRows, SpApiClient } from '../../supabase/functions/_shared/amazon/spapi.ts'

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
const noSleep = async () => {}

describe('amazon http: retry, backoff, rate limits', () => {
  it('retries 429 and 5xx, then succeeds; honours Retry-After', async () => {
    const statuses = [429, 503, 200]
    const delays: number[] = []
    const res = await fetchWithRetry(async () => json(statuses.shift()!, { ok: true }, { 'retry-after': '2' }), 'u', {}, { sleep: async (ms) => { delays.push(ms) }, random: () => 0 })
    assert.equal(res.status, 200)
    assert.deepEqual(delays, [2000, 2000])
  })
  it('does not retry 400/401/403 (validation and authorisation errors)', async () => {
    let calls = 0
    const res = await fetchWithRetry(async () => { calls++; return json(403, {}) }, 'u', {}, { sleep: noSleep })
    assert.equal(res.status, 403)
    assert.equal(calls, 1)
  })
  it('exponential backoff with a rate-limit floor, capped', () => {
    assert.equal(retryDelay(1, null, { baseDelayMs: 500, random: () => 0 }), 500)
    assert.equal(retryDelay(3, null, { baseDelayMs: 500, random: () => 0 }), 2000)
    assert.equal(retryDelay(1, new Response(null, { headers: { 'x-amzn-ratelimit-limit': '0.5' } }), { baseDelayMs: 100, random: () => 0 }), 2000)
    assert.equal(retryDelay(20, null, { baseDelayMs: 500, maxDelayMs: 30000, random: () => 0 }), 30000)
  })
  it('gives up after max attempts on network errors with a retryable error', async () => {
    await assert.rejects(fetchWithRetry(async () => { throw new Error('ECONNRESET') }, 'u', {}, { sleep: noSleep, maxAttempts: 3 }),
      (e: unknown) => e instanceof AmazonApiError && e.code === 'NETWORK' && e.retryable)
  })
  it('paginates until no next token, and stops at the page limit', async () => {
    const pages: Record<string, { items: number[]; next: string | null }> = { start: { items: [1, 2], next: 'a' }, a: { items: [3], next: 'b' }, b: { items: [4], next: null } }
    const r = await paginate(async (t) => pages[t ?? 'start'])
    assert.deepEqual(r.items, [1, 2, 3, 4])
    assert.equal(r.complete, true)
    const limited = await paginate(async (t) => pages[t ?? 'start'], 2)
    assert.equal(limited.complete, false)
    assert.equal(limited.next, 'b')
  })
  it('redacts tokens and secrets from messages', () => {
    const out = redact('failed refresh_token=Atzr|IwEBIabc123 Authorization: Bearer Atza|IwEBIxyz client_secret=amzn1.oa2-cs.v1.secretvalue my-client-secret', ['my-client-secret'])
    assert.ok(!/Atzr\|IwEBI|Atza\|IwEBI|amzn1\.oa2-cs|my-client-secret/.test(out), out)
    assert.match(out, /refresh_token=\[redacted\]/)
  })
  it('downloads and decompresses gzip documents', async () => {
    const gz = await new Response(new Blob(['hello report']).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer()
    assert.equal(await downloadText(async () => new Response(gz), 'u', true), 'hello report')
  })
})

describe('amazon login with amazon', () => {
  it('exchanges the refresh token once and caches until near expiry', async () => {
    clearTokenCache()
    let calls = 0
    let t = 0
    const f = async (_u: string, init?: RequestInit) => {
      calls++
      assert.match(String(init?.body), /grant_type=refresh_token/)
      return json(200, { access_token: `tok${calls}`, expires_in: 3600 })
    }
    const creds = { clientId: 'cid', clientSecret: 'sec-123456', refreshToken: 'Atzr|refresh-abcdef' }
    assert.equal(await getAccessToken(creds, f, { now: () => t }), 'tok1')
    t = 1000 * 3000
    assert.equal(await getAccessToken(creds, f, { now: () => t }), 'tok1')
    t = 1000 * 3600
    assert.equal(await getAccessToken(creds, f, { now: () => t }), 'tok2')
  })
  it('a revoked refresh token is a clear, non-retryable error without secrets', async () => {
    clearTokenCache()
    const creds = { clientId: 'cid', clientSecret: 'sec-123456', refreshToken: 'Atzr|revoked-abcdef' }
    await assert.rejects(getAccessToken(creds, async () => json(400, { error: 'invalid_grant', error_description: 'The request has an invalid grant parameter : refresh_token Atzr|revoked-abcdef' }), { sleep: noSleep }),
      (e: unknown) => e instanceof AmazonApiError && e.code === 'AUTH_REVOKED' && !e.retryable && !e.message.includes('Atzr|revoked'))
  })
})

describe('amazon SP-API normalisers and client', () => {
  it('sales & traffic report (one day) -> SKU rows', () => {
    const rows = salesTrafficRows(JSON.stringify({ salesAndTrafficByAsin: [
      { childAsin: 'B0C0000001', sku: 'BASIN-1', salesByAsin: { unitsOrdered: 3, orderedProductSales: { amount: 7497, currencyCode: 'INR' }, totalOrderItems: 3 }, trafficByAsin: { browserSessions: 40, mobileAppSessions: 60, pageViews: 150 } },
      { childAsin: 'B0C0000002' }] }), '2026-10-03', 'A21TJRUUN4KGV')
    assert.deepEqual(rows, [{ marketplace_id: 'A21TJRUUN4KGV', seller_sku: 'BASIN-1', asin: 'B0C0000001', metric_date: '2026-10-03', ordered_sales: 7497, units_ordered: 3, total_order_items: 3, sessions: 100, page_views: 150 }])
  })
  it('listings report (TSV) -> listing rows; DEFAULT channel is merchant fulfilled', () => {
    const rows = listingRows('item-name\tseller-sku\tprice\tasin1\tfulfillment-channel\tstatus\nBasin\tBASIN-1\t2499\tB0C0000001\tAMAZON_IN\tActive\nSeat\tSEAT-1\t999\tB0C0000002\tDEFAULT\tInactive\n', 'A21TJRUUN4KGV')
    assert.equal(rows[0].fulfillment_channel, 'AMAZON_IN')
    assert.equal(rows[1].fulfillment_channel, 'MFN')
    assert.equal(rows[0].item_price, 2499)
  })
  it('FBA inventory summaries -> snapshot rows', () => {
    const rows = inventoryRows([{ sellerSku: 'BASIN-1', asin: 'B0C0000001', inventoryDetails: { fulfillableQuantity: 40, inboundShippedQuantity: 5, inboundReceivingQuantity: 2, reservedQuantity: { totalReservedQuantity: 3 } } }], 'A21TJRUUN4KGV', '2026-10-13T10:00:00Z')
    assert.equal(rows[0].fulfillable_qty, 40)
    assert.equal(rows[0].inbound_qty, 7)
  })
  it('financial events -> fees per SKU and India date; GST on fees excluded; refunds and promotions captured', () => {
    assert.equal(localDate('2026-10-02T20:00:00Z', 330), '2026-10-03')
    const rows = feeRows([{
      ShipmentEventList: [{ PostedDate: '2026-10-02T20:00:00Z', ShipmentItemList: [{ SellerSKU: 'BASIN-1', ItemFeeList: [
        { FeeType: 'Commission', FeeAmount: { CurrencyAmount: -299.88 } }, { FeeType: 'FBAPerUnitFulfillmentFee', FeeAmount: { CurrencyAmount: -120 } },
        { FeeType: 'FixedClosingFee', FeeAmount: { CurrencyAmount: -25 } }, { FeeType: 'TaxOnCommission', FeeAmount: { CurrencyAmount: -53.98 } }],
        PromotionList: [{ PromotionAmount: { CurrencyAmount: -100 } }] }] }],
      RefundEventList: [{ PostedDate: '2026-10-03T05:00:00Z', ShipmentItemAdjustmentList: [{ SellerSKU: 'BASIN-1', QuantityShipped: 1,
        ItemChargeAdjustmentList: [{ ChargeType: 'Principal', ChargeAmount: { CurrencyAmount: -2499 } }], ItemFeeAdjustmentList: [{ FeeType: 'Commission', FeeAmount: { CurrencyAmount: 299.88 } }] }] }],
    }], 'A21TJRUUN4KGV')
    assert.equal(rows.length, 1)
    assert.deepEqual(rows[0], { marketplace_id: 'A21TJRUUN4KGV', seller_sku: 'BASIN-1', metric_date: '2026-10-03', referral_fees: 0, fulfilment_fees: 120, other_fees: 25,
      refund_amount: 2499, refunded_units: 1, promotion_discounts: 100 })
  })
  it('client sends the LWA token and paginates FBA inventory', async () => {
    const seen: string[] = []
    const client = new SpApiClient({ host: 'https://sp', accessToken: async () => 'AT', fetchFn: async (u, init) => {
      seen.push(u)
      assert.equal(((init?.headers ?? {}) as Record<string, string>)['x-amz-access-token'], 'AT')
      return u.includes('nextToken=n1') ? json(200, { payload: { inventorySummaries: [{ sellerSku: 'B' }] } }) : json(200, { payload: { inventorySummaries: [{ sellerSku: 'A' }] }, pagination: { nextToken: 'n1' } })
    }, retry: { sleep: noSleep } })
    const r = await client.inventorySummaries('A21TJRUUN4KGV')
    assert.deepEqual(r.items.map((x) => x.sellerSku), ['A', 'B'])
    assert.equal(seen.length, 2)
  })
  it('API permission errors surface as typed errors with the Amazon error code', async () => {
    const client = new SpApiClient({ host: 'https://sp', accessToken: async () => 'AT', fetchFn: async () => json(403, { errors: [{ code: 'Unauthorized', message: 'Access to requested resource is denied.' }] }), retry: { sleep: noSleep } })
    await assert.rejects(client.marketplaceParticipations(), (e: unknown) => e instanceof AmazonApiError && e.status === 403 && e.code === 'Unauthorized' && !e.retryable)
  })
})

describe('amazon Ads API normalisers and writes', () => {
  it('report specs follow the attribution window; rows normalise with the same window', () => {
    assert.ok(reportSpecs(14)[0].columns.includes('sales14d'))
    const rows = reportRows('SEARCH_TERM_DAILY', [{ date: '2026-10-03', campaignId: 1, adGroupId: 2, keywordId: 3, keyword: 'basin', matchType: 'exact', searchTerm: 'wash basin',
      impressions: 100, clicks: 4, cost: 40.5, sales7d: 2499, purchases7d: 1, unitsSoldClicks7d: 1 }], 'P1', 7)
    assert.deepEqual(rows[0], { profile_id: 'P1', campaign_id: '1', ad_group_id: '2', target_id: '3', targeting: 'basin', match_type: 'EXACT', search_term: 'wash basin', metric_date: '2026-10-03',
      impressions: 100, clicks: 4, spend: 40.5, sales: 2499, orders: 1, units: 1 })
  })
  it('targets: keywords, product targets and negatives', () => {
    const rows = targetRows([{ keywordId: 'k1', campaignId: 'c', adGroupId: 'g', keywordText: 'basin', matchType: 'EXACT', state: 'ENABLED', bid: 12 }],
      [{ targetId: 't1', campaignId: 'c', expressionType: 'AUTO', expression: [{ type: 'QUERY_HIGH_REL_MATCHES' }], state: 'ENABLED', bid: 8 }],
      [{ keywordId: 'n1', campaignId: 'c', adGroupId: 'g', keywordText: 'cheap', matchType: 'NEGATIVE_EXACT', state: 'ENABLED' }], 'P1')
    assert.deepEqual(rows.map((r) => r.target_type), ['KEYWORD', 'AUTO', 'NEGATIVE_KEYWORD'])
  })
  it('a write succeeds only when Amazon lists the item under success; errors are reported', async () => {
    const mk = (body: unknown) => new AdsClient({ host: 'https://ads', clientId: 'cid', profileId: 'P1', accessToken: async () => 'AT', fetchFn: async (_u, init) => {
      const h = init?.headers as Record<string, string>
      assert.equal(h['Amazon-Advertising-API-Scope'], 'P1')
      assert.equal(h['Content-Type'], 'application/vnd.spCampaign.v3+json')
      return json(207, body, { 'x-amzn-requestid': 'req-1' })
    }, retry: { sleep: noSleep } })
    const ok = await mk({ campaigns: { success: [{ campaignId: 'c1', index: 0 }], error: [] } }).updateCampaign('c1', { budget: 900 })
    assert.equal(ok.ok, true)
    assert.equal(ok.requestId, 'req-1')
    const bad = await mk({ campaigns: { success: [], error: [{ index: 0, errors: [{ errorType: 'budgetTooHigh', errorValue: { message: 'over limit' } }] }] } }).updateCampaign('c1', { budget: 9e9 })
    assert.equal(bad.ok, false)
    assert.match(bad.error ?? '', /budgetTooHigh/)
  })
})
