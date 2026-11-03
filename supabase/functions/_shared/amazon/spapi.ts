// Selling Partner API client (LWA access token in x-amz-access-token; AWS
// request signing is no longer required by SP-API). Only read operations are
// implemented: the ERP never writes to the seller account.
//
// Endpoints follow the SP-API reference (Sellers v1, Reports 2021-06-30,
// FBA Inventory v1, Finances v0). Verify against Amazon's current docs when the
// application is registered; every response is validated before use.

import { AmazonApiError, downloadText, fetchWithRetry, paginate, readJson, type FetchFn, type RetryOptions } from './http.ts'

export const SPAPI_HOSTS: Record<string, string> = {
  NA: 'https://sellingpartnerapi-na.amazon.com',
  EU: 'https://sellingpartnerapi-eu.amazon.com', // includes Amazon.in (A21TJRUUN4KGV)
  FE: 'https://sellingpartnerapi-fe.amazon.com',
}
export const SPAPI_SANDBOX_HOSTS: Record<string, string> = {
  NA: 'https://sandbox.sellingpartnerapi-na.amazon.com',
  EU: 'https://sandbox.sellingpartnerapi-eu.amazon.com',
  FE: 'https://sandbox.sellingpartnerapi-fe.amazon.com',
}

export interface SpApiConfig {
  host: string
  accessToken: () => Promise<string>
  fetchFn: FetchFn
  retry?: RetryOptions
  secrets?: string[]
}

export class SpApiClient {
  cfg: SpApiConfig
  constructor(cfg: SpApiConfig) {
    this.cfg = cfg
  }

  async request<T>(method: string, path: string, operation: string, query?: Record<string, string | undefined>, body?: unknown): Promise<T> {
    const qs = query ? new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined) as [string, string][]).toString() : ''
    const res = await fetchWithRetry(this.cfg.fetchFn, `${this.cfg.host}${path}${qs ? `?${qs}` : ''}`, {
      method,
      headers: { 'x-amz-access-token': await this.cfg.accessToken(), 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'AltonERP/1.0 (Language=TypeScript)' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }, this.cfg.retry)
    return readJson<T>(res, operation, this.cfg.secrets)
  }

  /** Connection test: the marketplaces the seller participates in. */
  async marketplaceParticipations() {
    const r = await this.request<{ payload?: { marketplace: { id: string; name: string; countryCode: string }; participation: { isParticipating: boolean } }[] }>(
      'GET', '/sellers/v1/marketplaceParticipations', 'Sellers: marketplace participations')
    return (r.payload ?? []).map((p) => ({ id: p.marketplace.id, name: p.marketplace.name, country: p.marketplace.countryCode, participating: p.participation.isParticipating }))
  }

  async createReport(reportType: string, marketplaceIds: string[], start?: string, end?: string, options?: Record<string, string>) {
    const r = await this.request<{ reportId: string }>('POST', '/reports/2021-06-30/reports', `Reports: create ${reportType}`, undefined,
      { reportType, marketplaceIds, dataStartTime: start, dataEndTime: end, reportOptions: options })
    if (!r.reportId) throw new AmazonApiError('Reports: no report id returned', null, 'INVALID_RESPONSE', false)
    return r.reportId
  }

  async getReport(reportId: string) {
    return this.request<{ processingStatus: 'IN_QUEUE' | 'IN_PROGRESS' | 'DONE' | 'CANCELLED' | 'FATAL'; reportDocumentId?: string }>(
      'GET', `/reports/2021-06-30/reports/${encodeURIComponent(reportId)}`, 'Reports: status')
  }

  async downloadReportDocument(documentId: string): Promise<string> {
    const d = await this.request<{ url: string; compressionAlgorithm?: string }>('GET', `/reports/2021-06-30/documents/${encodeURIComponent(documentId)}`, 'Reports: document')
    return downloadText(this.cfg.fetchFn, d.url, d.compressionAlgorithm === 'GZIP', this.cfg.retry)
  }

  async inventorySummaries(marketplaceId: string, maxPages = 20) {
    return paginate(async (token) => {
      const r = await this.request<{ payload?: { inventorySummaries?: FbaSummary[] }; pagination?: { nextToken?: string } }>('GET', '/fba/inventory/v1/summaries',
        'FBA inventory: summaries', { details: 'true', granularityType: 'Marketplace', granularityId: marketplaceId, marketplaceIds: marketplaceId, nextToken: token ?? undefined })
      return { items: r.payload?.inventorySummaries ?? [], next: r.pagination?.nextToken ?? null }
    }, maxPages)
  }

  async financialEvents(postedAfter: string, postedBefore: string, maxPages = 30) {
    return paginate(async (token) => {
      const r = await this.request<{ payload?: { FinancialEvents?: FinancialEvents; NextToken?: string } }>('GET', '/finances/v0/financialEvents', 'Finances: financial events',
        token ? { NextToken: token } : { PostedAfter: postedAfter, PostedBefore: postedBefore, MaxResultsPerPage: '100' })
      return { items: [r.payload?.FinancialEvents ?? {}], next: r.payload?.NextToken ?? null }
    }, maxPages)
  }
}

// ---------------------------------------------------------------------------
// Normalisers (pure; unit tested)
// ---------------------------------------------------------------------------
interface Money { amount?: number; Amount?: number; CurrencyAmount?: number; currencyCode?: string }
const amt = (m?: Money | null) => Number(m?.amount ?? m?.Amount ?? m?.CurrencyAmount ?? 0) || 0

/** GET_SALES_AND_TRAFFIC_REPORT (asinGranularity SKU) for ONE day -> SKU_SALES rows. */
export function salesTrafficRows(reportJson: string, date: string, marketplaceId: string) {
  const r = JSON.parse(reportJson) as { salesAndTrafficByAsin?: { childAsin?: string; sku?: string; salesByAsin?: { unitsOrdered?: number; orderedProductSales?: Money; totalOrderItems?: number };
    trafficByAsin?: { sessions?: number; browserSessions?: number; mobileAppSessions?: number; pageViews?: number; browserPageViews?: number; mobileAppPageViews?: number } }[] }
  return (r.salesAndTrafficByAsin ?? []).filter((x) => x.sku).map((x) => ({
    marketplace_id: marketplaceId, seller_sku: x.sku!, asin: x.childAsin ?? null, metric_date: date,
    ordered_sales: amt(x.salesByAsin?.orderedProductSales), units_ordered: x.salesByAsin?.unitsOrdered ?? 0, total_order_items: x.salesByAsin?.totalOrderItems ?? 0,
    sessions: x.trafficByAsin?.sessions ?? ((x.trafficByAsin?.browserSessions ?? 0) + (x.trafficByAsin?.mobileAppSessions ?? 0)),
    page_views: x.trafficByAsin?.pageViews ?? ((x.trafficByAsin?.browserPageViews ?? 0) + (x.trafficByAsin?.mobileAppPageViews ?? 0)),
  }))
}

/** GET_MERCHANT_LISTINGS_ALL_DATA (tab-separated) -> LISTINGS rows. */
export function listingRows(tsv: string, marketplaceId: string) {
  const lines = tsv.replace(/\r/g, '').split('\n').filter((l) => l.trim())
  if (!lines.length) return []
  const head = lines[0].split('\t').map((h) => h.trim().toLowerCase())
  const col = (name: string) => head.indexOf(name)
  const [sku, asin, title, price, channel, status] = ['seller-sku', 'asin1', 'item-name', 'price', 'fulfillment-channel', 'status'].map(col)
  if (sku < 0) throw new AmazonApiError('Listings report: seller-sku column not found', null, 'INVALID_REPORT', false)
  return lines.slice(1).map((l) => l.split('\t')).filter((c) => c[sku]?.trim()).map((c) => ({
    marketplace_id: marketplaceId, seller_sku: c[sku].trim(), asin: asin >= 0 && /^[A-Z0-9]{10}$/.test(c[asin]?.trim() ?? '') ? c[asin].trim() : null,
    title: title >= 0 ? c[title]?.trim() || null : null, item_price: price >= 0 && c[price] ? Number(c[price]) || null : null,
    fulfillment_channel: channel >= 0 ? (c[channel]?.trim() === 'DEFAULT' ? 'MFN' : c[channel]?.trim() || null) : null,
    listing_status: status >= 0 ? c[status]?.trim() || null : null,
  }))
}

export interface FbaSummary {
  sellerSku?: string; asin?: string; totalQuantity?: number
  inventoryDetails?: { fulfillableQuantity?: number; inboundShippedQuantity?: number; inboundReceivingQuantity?: number; inboundWorkingQuantity?: number
    reservedQuantity?: { totalReservedQuantity?: number }; unfulfillableQuantity?: { totalUnfulfillableQuantity?: number } }
}
export function inventoryRows(items: FbaSummary[], marketplaceId: string, snapshotAt: string) {
  return items.filter((s) => s.sellerSku).map((s) => ({
    marketplace_id: marketplaceId, seller_sku: s.sellerSku!, asin: s.asin ?? null, snapshot_at: snapshotAt,
    fulfillable_qty: s.inventoryDetails?.fulfillableQuantity ?? 0,
    inbound_qty: (s.inventoryDetails?.inboundShippedQuantity ?? 0) + (s.inventoryDetails?.inboundReceivingQuantity ?? 0) + (s.inventoryDetails?.inboundWorkingQuantity ?? 0),
    reserved_qty: s.inventoryDetails?.reservedQuantity?.totalReservedQuantity ?? null, unfulfillable_qty: s.inventoryDetails?.unfulfillableQuantity?.totalUnfulfillableQuantity ?? null,
  }))
}

interface ShipmentItem {
  SellerSKU?: string; QuantityShipped?: number
  ItemChargeList?: { ChargeType?: string; ChargeAmount?: Money }[]; ItemChargeAdjustmentList?: { ChargeType?: string; ChargeAmount?: Money }[]
  ItemFeeList?: { FeeType?: string; FeeAmount?: Money }[]; ItemFeeAdjustmentList?: { FeeType?: string; FeeAmount?: Money }[]
  PromotionList?: { PromotionAmount?: Money }[]; PromotionAdjustmentList?: { PromotionAmount?: Money }[]
}
export interface FinancialEvents {
  ShipmentEventList?: { PostedDate?: string; ShipmentItemList?: ShipmentItem[] }[]
  RefundEventList?: { PostedDate?: string; ShipmentItemAdjustmentList?: ShipmentItem[] }[]
}

/** Local calendar date of an ISO timestamp for a fixed UTC offset (India = +330 minutes). */
export const localDate = (iso: string, offsetMinutes: number) => new Date(Date.parse(iso) + offsetMinutes * 60000).toISOString().slice(0, 10)

/**
 * Finances v0 events -> SKU_FEES rows per SKU and posted date. Fees are stored
 * as positive costs: referral = Commission, fulfilment = FBA per-unit fees,
 * other = remaining fee types. Fee lines that are GST on fees (type contains
 * "Tax") are excluded (input credit). Refund events give refund_amount
 * (principal) and refunded_units; refunded commission reduces referral fees.
 */
export function feeRows(events: FinancialEvents[], marketplaceId: string, offsetMinutes = 330) {
  const acc = new Map<string, { marketplace_id: string; seller_sku: string; metric_date: string; referral_fees: number; fulfilment_fees: number; other_fees: number;
    refund_amount: number; refunded_units: number; promotion_discounts: number }>()
  const get = (sku: string, date: string) => {
    const k = `${sku}|${date}`
    if (!acc.has(k)) acc.set(k, { marketplace_id: marketplaceId, seller_sku: sku, metric_date: date, referral_fees: 0, fulfilment_fees: 0, other_fees: 0, refund_amount: 0, refunded_units: 0, promotion_discounts: 0 })
    return acc.get(k)!
  }
  const addFee = (row: ReturnType<typeof get>, type: string, amount: number) => {
    if (/tax/i.test(type)) return
    const cost = -amount // fees are negative amounts in settlements
    if (type === 'Commission' || type === 'RefundCommission') row.referral_fees += cost
    else if (/^FBA/i.test(type) || /Fulfil+ment/i.test(type)) row.fulfilment_fees += cost
    else row.other_fees += cost
  }
  for (const ev of events) {
    for (const s of ev.ShipmentEventList ?? []) {
      if (!s.PostedDate) continue
      for (const it of s.ShipmentItemList ?? []) {
        if (!it.SellerSKU) continue
        const row = get(it.SellerSKU, localDate(s.PostedDate, offsetMinutes))
        for (const f of it.ItemFeeList ?? []) addFee(row, f.FeeType ?? '', amt(f.FeeAmount))
        for (const p of it.PromotionList ?? []) row.promotion_discounts += Math.abs(amt(p.PromotionAmount))
      }
    }
    for (const r of ev.RefundEventList ?? []) {
      if (!r.PostedDate) continue
      for (const it of r.ShipmentItemAdjustmentList ?? []) {
        if (!it.SellerSKU) continue
        const row = get(it.SellerSKU, localDate(r.PostedDate, offsetMinutes))
        for (const c of it.ItemChargeAdjustmentList ?? []) if (c.ChargeType === 'Principal') row.refund_amount += Math.abs(amt(c.ChargeAmount))
        row.refunded_units += Math.abs(it.QuantityShipped ?? 0)
        for (const f of it.ItemFeeAdjustmentList ?? []) addFee(row, f.FeeType ?? '', amt(f.FeeAmount))
        for (const p of it.PromotionAdjustmentList ?? []) row.promotion_discounts -= Math.abs(amt(p.PromotionAmount))
      }
    }
  }
  const r2 = (v: number) => Math.max(0, Math.round(v * 100) / 100)
  return [...acc.values()].map((v) => ({ ...v, referral_fees: r2(v.referral_fees), fulfilment_fees: r2(v.fulfilment_fees), other_fees: r2(v.other_fees),
    refund_amount: r2(v.refund_amount), promotion_discounts: r2(v.promotion_discounts) }))
}
