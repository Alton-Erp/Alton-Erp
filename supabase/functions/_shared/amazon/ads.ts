// Amazon Ads API client (a SEPARATE application and refresh token from SP-API).
// Reads: profiles, Sponsored Products campaigns / ad groups / keywords /
// targets (v3 list endpoints) and v3 asynchronous reports. Writes (only via an
// approved change request): campaign budget / state, keyword or target bid,
// negative keyword. Every write returns success only when Amazon's response
// lists the item under "success".

import { AmazonApiError, downloadText, fetchWithRetry, paginate, readJson, type FetchFn, type RetryOptions } from './http.ts'

export const ADS_HOSTS: Record<string, string> = {
  NA: 'https://advertising-api.amazon.com',
  EU: 'https://advertising-api-eu.amazon.com', // includes Amazon.in
  FE: 'https://advertising-api-fe.amazon.com',
}

export interface AdsConfig {
  host: string
  clientId: string
  accessToken: () => Promise<string>
  profileId?: string | null
  fetchFn: FetchFn
  retry?: RetryOptions
  secrets?: string[]
}

const MEDIA = {
  campaign: 'application/vnd.spCampaign.v3+json',
  adGroup: 'application/vnd.spAdGroup.v3+json',
  keyword: 'application/vnd.spKeyword.v3+json',
  target: 'application/vnd.spTargetingClause.v3+json',
  negativeKeyword: 'application/vnd.spNegativeKeyword.v3+json',
  report: 'application/vnd.createasyncreportrequest.v3+json',
}

export class AdsClient {
  cfg: AdsConfig
  constructor(cfg: AdsConfig) {
    this.cfg = cfg
  }

  private async call(method: string, path: string, operation: string, body?: unknown, media = 'application/json'): Promise<{ json: unknown; requestId: string | null }> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await this.cfg.accessToken()}`, 'Amazon-Advertising-API-ClientId': this.cfg.clientId, 'Content-Type': media, Accept: media,
    }
    if (this.cfg.profileId) headers['Amazon-Advertising-API-Scope'] = this.cfg.profileId
    const res = await fetchWithRetry(this.cfg.fetchFn, `${this.cfg.host}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }, this.cfg.retry)
    const requestId = res.headers.get('x-amzn-requestid')
    return { json: await readJson(res, operation, this.cfg.secrets), requestId }
  }

  async profiles() {
    const { json } = await this.call('GET', '/v2/profiles', 'Ads: profiles')
    return (json as { profileId: number | string; countryCode: string; currencyCode: string; accountInfo?: { id?: string; name?: string; type?: string; marketplaceStringId?: string } }[])
      .map((p) => ({ profileId: String(p.profileId), countryCode: p.countryCode, currency: p.currencyCode, accountId: p.accountInfo?.id ?? null, accountName: p.accountInfo?.name ?? null,
        accountType: p.accountInfo?.type ?? null, marketplaceId: p.accountInfo?.marketplaceStringId ?? null }))
  }

  private list<T>(path: string, key: string, media: string, operation: string, maxPages = 30) {
    return paginate<T>(async (token) => {
      const { json } = await this.call('POST', path, operation, { maxResults: 100, nextToken: token ?? undefined, stateFilter: { include: ['ENABLED', 'PAUSED'] } }, media)
      const j = json as Record<string, unknown>
      return { items: (j[key] as T[]) ?? [], next: (j.nextToken as string) ?? null }
    }, maxPages)
  }
  campaigns() { return this.list<AdsCampaign>('/sp/campaigns/list', 'campaigns', MEDIA.campaign, 'Ads: campaigns') }
  adGroups() { return this.list<AdsAdGroup>('/sp/adGroups/list', 'adGroups', MEDIA.adGroup, 'Ads: ad groups') }
  keywords() { return this.list<AdsKeyword>('/sp/keywords/list', 'keywords', MEDIA.keyword, 'Ads: keywords') }
  targets() { return this.list<AdsTarget>('/sp/targets/list', 'targetingClauses', MEDIA.target, 'Ads: targets') }
  negativeKeywords() { return this.list<AdsKeyword>('/sp/negativeKeywords/list', 'negativeKeywords', MEDIA.negativeKeyword, 'Ads: negative keywords') }

  async createReport(spec: ReportSpec, startDate: string, endDate: string) {
    const { json } = await this.call('POST', '/reporting/reports', `Ads: create ${spec.reportTypeId} report`, {
      name: `ERP ${spec.reportTypeId} ${startDate}..${endDate}`, startDate, endDate,
      configuration: { adProduct: 'SPONSORED_PRODUCTS', groupBy: spec.groupBy, columns: spec.columns, reportTypeId: spec.reportTypeId, timeUnit: 'DAILY', format: 'GZIP_JSON' },
    }, MEDIA.report)
    const id = (json as { reportId?: string }).reportId
    if (!id) throw new AmazonApiError('Ads: no report id returned', null, 'INVALID_RESPONSE', false)
    return id
  }
  async getReport(reportId: string) {
    const { json } = await this.call('GET', `/reporting/reports/${encodeURIComponent(reportId)}`, 'Ads: report status')
    return json as { status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED'; url?: string; failureReason?: string }
  }
  async downloadReport(url: string) {
    return JSON.parse(await downloadText(this.cfg.fetchFn, url, true, this.cfg.retry)) as Record<string, unknown>[]
  }

  // ---- writes (approved change requests only) --------------------------------
  private multiStatus(json: unknown, key: string, operation: string) {
    const j = (json as Record<string, { success?: unknown[]; error?: { errors?: { errorType?: string; errorValue?: unknown }[] }[] }>)[key]
    if (j?.success?.length) return { ok: true, error: null as string | null, response: j }
    const err = j?.error?.[0]?.errors?.[0]
    return { ok: false, error: `${operation} rejected by Amazon: ${err?.errorType ?? 'unknown error'} ${err ? JSON.stringify(err.errorValue ?? '').slice(0, 300) : ''}`.trim(), response: j ?? json }
  }
  async updateCampaign(campaignId: string, change: { budget?: number; state?: 'ENABLED' | 'PAUSED' }) {
    const item: Record<string, unknown> = { campaignId }
    if (change.budget !== undefined) item.budget = { budget: change.budget, budgetType: 'DAILY' }
    if (change.state) item.state = change.state
    const { json, requestId } = await this.call('PUT', '/sp/campaigns', 'Ads: update campaign', { campaigns: [item] }, MEDIA.campaign)
    return { ...this.multiStatus(json, 'campaigns', 'Campaign update'), requestId }
  }
  async updateBid(kind: 'KEYWORD' | 'TARGET', id: string, change: { bid?: number; state?: 'ENABLED' | 'PAUSED' }) {
    const [path, key, media, idKey] = kind === 'KEYWORD' ? ['/sp/keywords', 'keywords', MEDIA.keyword, 'keywordId'] : ['/sp/targets', 'targetingClauses', MEDIA.target, 'targetId']
    const { json, requestId } = await this.call('PUT', path, `Ads: update ${kind.toLowerCase()}`, { [key]: [{ [idKey]: id, ...change }] }, media)
    return { ...this.multiStatus(json, key, `${kind === 'KEYWORD' ? 'Keyword' : 'Target'} update`), requestId }
  }
  async createNegativeKeyword(campaignId: string, adGroupId: string, keywordText: string, matchType: 'NEGATIVE_EXACT' | 'NEGATIVE_PHRASE') {
    const { json, requestId } = await this.call('POST', '/sp/negativeKeywords', 'Ads: create negative keyword',
      { negativeKeywords: [{ campaignId, adGroupId, keywordText, matchType, state: 'ENABLED' }] }, MEDIA.negativeKeyword)
    return { ...this.multiStatus(json, 'negativeKeywords', 'Negative keyword'), requestId }
  }
}

export interface AdsCampaign { campaignId: string; name: string; targetingType?: string; state: string; budget?: { budget?: number; budgetType?: string }; portfolioId?: string; startDate?: string; endDate?: string }
export interface AdsAdGroup { adGroupId: string; campaignId: string; name: string; state: string; defaultBid?: number }
export interface AdsKeyword { keywordId: string; campaignId: string; adGroupId?: string; keywordText: string; matchType: string; state: string; bid?: number }
export interface AdsTarget { targetId: string; campaignId: string; adGroupId?: string; expression?: { type: string; value?: string }[]; expressionType?: string; state: string; bid?: number }

export interface ReportSpec { reportTypeId: 'spCampaigns' | 'spAdvertisedProduct' | 'spSearchTerm'; groupBy: string[]; columns: string[]; kind: 'CAMPAIGN_DAILY' | 'AD_PRODUCT_DAILY' | 'SEARCH_TERM_DAILY' }

/** Report definitions; the attribution window (1/7/14/30 days) selects the sales / purchases / units columns. */
export function reportSpecs(window: number): ReportSpec[] {
  const w = [1, 7, 14, 30].includes(window) ? window : 7
  const m = [`sales${w}d`, `purchases${w}d`, `unitsSoldClicks${w}d`]
  return [
    { reportTypeId: 'spCampaigns', kind: 'CAMPAIGN_DAILY', groupBy: ['campaign'], columns: ['date', 'campaignId', 'campaignName', 'campaignStatus', 'campaignBudgetAmount', 'impressions', 'clicks', 'cost', ...m] },
    { reportTypeId: 'spAdvertisedProduct', kind: 'AD_PRODUCT_DAILY', groupBy: ['advertiser'], columns: ['date', 'campaignId', 'adGroupId', 'advertisedSku', 'advertisedAsin', 'impressions', 'clicks', 'cost', ...m] },
    { reportTypeId: 'spSearchTerm', kind: 'SEARCH_TERM_DAILY', groupBy: ['searchTerm'], columns: ['date', 'campaignId', 'adGroupId', 'keywordId', 'keyword', 'matchType', 'targeting', 'searchTerm', 'impressions', 'clicks', 'cost', ...m] },
  ]
}

const num = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0) || 0)

/** Normalises downloaded v3 report rows into ingest rows. */
export function reportRows(kind: ReportSpec['kind'], rows: Record<string, unknown>[], profileId: string, window: number) {
  const w = [1, 7, 14, 30].includes(window) ? window : 7
  const metrics = (r: Record<string, unknown>) => ({ impressions: num(r.impressions), clicks: num(r.clicks), spend: num(r.cost), sales: num(r[`sales${w}d`]),
    orders: num(r[`purchases${w}d`]), units: num(r[`unitsSoldClicks${w}d`]) })
  if (kind === 'CAMPAIGN_DAILY') return rows.filter((r) => r.campaignId && r.date).map((r) => ({ profile_id: profileId, campaign_id: String(r.campaignId), metric_date: String(r.date),
    budget: r.campaignBudgetAmount === undefined ? null : num(r.campaignBudgetAmount), ...metrics(r) }))
  if (kind === 'AD_PRODUCT_DAILY') return rows.filter((r) => r.campaignId && r.adGroupId && r.advertisedSku && r.date).map((r) => ({ profile_id: profileId, campaign_id: String(r.campaignId),
    ad_group_id: String(r.adGroupId), seller_sku: String(r.advertisedSku), asin: r.advertisedAsin ? String(r.advertisedAsin) : null, metric_date: String(r.date), ...metrics(r) }))
  return rows.filter((r) => r.campaignId && r.adGroupId && r.searchTerm && r.date).map((r) => ({ profile_id: profileId, campaign_id: String(r.campaignId), ad_group_id: String(r.adGroupId),
    target_id: r.keywordId ? String(r.keywordId) : null, targeting: String(r.keyword ?? r.targeting ?? '(unknown)'), match_type: r.matchType ? String(r.matchType).toUpperCase() : null,
    search_term: String(r.searchTerm), metric_date: String(r.date), ...metrics(r) }))
}

/** Entity snapshots -> ingest rows. */
export function campaignRows(items: AdsCampaign[], profileId: string) {
  return items.map((c) => ({ profile_id: profileId, campaign_id: String(c.campaignId), name: c.name, ad_product: 'SPONSORED_PRODUCTS', targeting_type: c.targetingType ?? null,
    state: c.state, daily_budget: c.budget?.budgetType === 'DAILY' || !c.budget?.budgetType ? c.budget?.budget ?? null : null, portfolio_id: c.portfolioId ?? null,
    start_date: c.startDate ?? null, end_date: c.endDate ?? null }))
}
export function adGroupRows(items: AdsAdGroup[], profileId: string) {
  return items.map((g) => ({ profile_id: profileId, campaign_id: String(g.campaignId), ad_group_id: String(g.adGroupId), name: g.name, state: g.state, default_bid: g.defaultBid ?? null }))
}
export function targetRows(keywords: AdsKeyword[], targets: AdsTarget[], negatives: AdsKeyword[], profileId: string) {
  return [
    ...keywords.map((k) => ({ profile_id: profileId, campaign_id: String(k.campaignId), ad_group_id: k.adGroupId ? String(k.adGroupId) : null, target_id: String(k.keywordId),
      target_type: 'KEYWORD', expression: k.keywordText, match_type: k.matchType, state: k.state, bid: k.bid ?? null })),
    ...targets.map((t) => ({ profile_id: profileId, campaign_id: String(t.campaignId), ad_group_id: t.adGroupId ? String(t.adGroupId) : null, target_id: String(t.targetId),
      target_type: t.expressionType === 'AUTO' ? 'AUTO' : 'PRODUCT', expression: (t.expression ?? []).map((e) => (e.value ? `${e.type}=${e.value}` : e.type)).join(' ') || '(target)',
      match_type: 'TARGETING_EXPRESSION', state: t.state, bid: t.bid ?? null })),
    ...negatives.map((k) => ({ profile_id: profileId, campaign_id: String(k.campaignId), ad_group_id: k.adGroupId ? String(k.adGroupId) : null, target_id: String(k.keywordId),
      target_type: 'NEGATIVE_KEYWORD', expression: k.keywordText, match_type: k.matchType, state: k.state, bid: null })),
  ]
}
