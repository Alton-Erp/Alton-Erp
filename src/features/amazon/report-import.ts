/**
 * Parses Amazon report downloads (CSV / Excel) into rows for amazon_import_rows.
 * Recognised (by their column headers):
 *  - Business Report "Detail Page Sales and Traffic By Child Item"   -> SKU_SALES (one chosen date)
 *  - Sponsored Products campaign report, daily                      -> CAMPAIGNS + CAMPAIGN_DAILY
 *  - Sponsored Products advertised product report, daily            -> AD_PRODUCT_DAILY
 *  - Sponsored Products search term report, daily                    -> SEARCH_TERM_DAILY
 *  - FBA inventory report (Manage FBA Inventory)                     -> INVENTORY
 *  - The ERP templates (column names = field names)                  -> any kind
 * Nothing is invented: rows without the required values are rejected with
 * their row number. Advertising reports must have a daily date per row.
 */
import { parseSheetDate } from '../inventory/inventory-model.ts'

export type ImportKind = 'LISTINGS' | 'SKU_SALES' | 'SKU_FEES' | 'INVENTORY' | 'CAMPAIGNS' | 'CAMPAIGN_DAILY' | 'AD_PRODUCT_DAILY' | 'SEARCH_TERM_DAILY'
export type ReportType = 'BUSINESS_REPORT' | 'SP_CAMPAIGN' | 'SP_ADVERTISED_PRODUCT' | 'SP_SEARCH_TERM' | 'FBA_INVENTORY' | `TEMPLATE_${ImportKind}`

export interface ParsedReport {
  type: ReportType
  label: string
  headerRow: number
  batches: { kind: ImportKind; rows: Record<string, string | number | null>[] }[]
  errors: { row: number; message: string }[]
  dateFrom: string | null
  dateTo: string | null
  needsDate: boolean
}

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, '')
const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }

/** Dates: YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY, "Oct 3, 2026", "3 Oct 2026". */
export function parseReportDate(value: string): string | null {
  const v = value.trim()
  if (!v) return null
  const iso = parseSheetDate(v.slice(0, 10))
  if (iso) return iso
  let m = /^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(v)
  let d: number, mo: number, y: number
  if (m) [mo, d, y] = [MONTHS[m[1].toLowerCase()], Number(m[2]), Number(m[3])]
  else {
    m = /^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?,?\s+(\d{4})$/.exec(v)
    if (!m) return null
    ;[d, mo, y] = [Number(m[1]), MONTHS[m[2].toLowerCase()], Number(m[3])]
  }
  if (!mo) return null
  const date = new Date(Date.UTC(y, mo - 1, d))
  if (date.getUTCDate() !== d) return null
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/** Numbers such as "Rs 1,234.50", "1,234", "12.5%", "-" (empty) -> 1234.5 / 1234 / 12.5 / null. */
export function parseNumber(value: string | undefined): number | null {
  if (value === undefined) return null
  const v = value.replace(/[₹$€£,%\s]|INR|Rs\.?/gi, '').trim()
  if (v === '' || v === '-' || v === '--') return null
  if (!/^-?\d+(\.\d+)?$/.test(v)) return null
  return Number(v)
}

type Field = { field: string; aliases: string[]; type: 'text' | 'number' | 'date' }
const F = (field: string, type: Field['type'], ...aliases: string[]): Field => ({ field, type, aliases: [field, ...aliases].map(norm) })

const DEFS: { type: ReportType; label: string; kind: ImportKind; required: string[]; fields: Field[]; daily?: boolean; needsDate?: boolean }[] = [
  { type: 'BUSINESS_REPORT', label: 'Business Report - Sales and Traffic by Child Item', kind: 'SKU_SALES', required: ['seller_sku', 'units_ordered', 'ordered_sales'], needsDate: true,
    fields: [F('seller_sku', 'text', 'SKU'), F('asin', 'text', '(Child) ASIN', 'Child ASIN'), F('sessions', 'number', 'Sessions - Total', 'Sessions'),
      F('page_views', 'number', 'Page Views - Total', 'Page Views'), F('units_ordered', 'number', 'Units Ordered'), F('ordered_sales', 'number', 'Ordered Product Sales'),
      F('total_order_items', 'number', 'Total Order Items')] },
  { type: 'SP_SEARCH_TERM', label: 'Sponsored Products - search term report (daily)', kind: 'SEARCH_TERM_DAILY', required: ['metric_date', 'campaign', 'search_term', 'targeting'], daily: true,
    fields: [F('metric_date', 'date', 'Date', 'Start Date'), F('end_date', 'date', 'End Date'), F('campaign', 'text', 'Campaign Name'), F('campaign_id', 'text', 'Campaign Id'),
      F('ad_group', 'text', 'Ad Group Name'), F('ad_group_id', 'text', 'Ad Group Id'), F('targeting', 'text', 'Targeting', 'Keyword'), F('match_type', 'text', 'Match Type'),
      F('search_term', 'text', 'Customer Search Term', 'Search Term'), F('impressions', 'number', 'Impressions'), F('clicks', 'number', 'Clicks'), F('spend', 'number', 'Spend', 'Cost'),
      F('sales', 'number', '7 Day Total Sales', '7 Day Total Sales ', 'Sales'), F('orders', 'number', '7 Day Total Orders (#)', '7 Day Total Orders', 'Orders'),
      F('units', 'number', '7 Day Total Units (#)', '7 Day Total Units', 'Units')] },
  { type: 'SP_ADVERTISED_PRODUCT', label: 'Sponsored Products - advertised product report (daily)', kind: 'AD_PRODUCT_DAILY', required: ['metric_date', 'campaign', 'seller_sku'], daily: true,
    fields: [F('metric_date', 'date', 'Date', 'Start Date'), F('end_date', 'date', 'End Date'), F('campaign', 'text', 'Campaign Name'), F('campaign_id', 'text', 'Campaign Id'),
      F('ad_group', 'text', 'Ad Group Name'), F('ad_group_id', 'text', 'Ad Group Id'), F('seller_sku', 'text', 'Advertised SKU'), F('asin', 'text', 'Advertised ASIN'),
      F('impressions', 'number', 'Impressions'), F('clicks', 'number', 'Clicks'), F('spend', 'number', 'Spend', 'Cost'), F('sales', 'number', '7 Day Total Sales', 'Sales'),
      F('orders', 'number', '7 Day Total Orders (#)', '7 Day Total Orders', 'Orders'), F('units', 'number', '7 Day Total Units (#)', '7 Day Total Units', 'Units')] },
  { type: 'SP_CAMPAIGN', label: 'Sponsored Products - campaign report (daily)', kind: 'CAMPAIGN_DAILY', required: ['metric_date', 'campaign'], daily: true,
    fields: [F('metric_date', 'date', 'Date', 'Start Date'), F('end_date', 'date', 'End Date'), F('campaign', 'text', 'Campaign Name'), F('campaign_id', 'text', 'Campaign Id'),
      F('state', 'text', 'Status', 'Campaign Status', 'State'), F('budget', 'number', 'Budget', 'Daily Budget'), F('impressions', 'number', 'Impressions'), F('clicks', 'number', 'Clicks'),
      F('spend', 'number', 'Spend', 'Cost'), F('sales', 'number', '7 Day Total Sales', 'Sales'), F('orders', 'number', '7 Day Total Orders (#)', '7 Day Total Orders', 'Orders'),
      F('units', 'number', '7 Day Total Units (#)', '7 Day Total Units', 'Units'), F('targeting_type', 'text', 'Targeting Type')] },
  { type: 'FBA_INVENTORY', label: 'FBA inventory report', kind: 'INVENTORY', required: ['seller_sku', 'fulfillable_qty'],
    fields: [F('seller_sku', 'text', 'sku', 'Merchant SKU'), F('asin', 'text', 'asin'), F('fulfillable_qty', 'number', 'afn-fulfillable-quantity', 'Available', 'Fulfillable'),
      F('inbound_qty', 'number', 'afn-inbound-shipped-quantity', 'Inbound'), F('reserved_qty', 'number', 'afn-reserved-quantity', 'Reserved'),
      F('unfulfillable_qty', 'number', 'afn-unsellable-quantity', 'Unfulfillable')] },
  { type: 'TEMPLATE_SKU_FEES', label: 'ERP template - fees and refunds per SKU and day', kind: 'SKU_FEES', required: ['seller_sku', 'metric_date'],
    fields: [F('seller_sku', 'text'), F('metric_date', 'date'), F('referral_fees', 'number'), F('fulfilment_fees', 'number'), F('other_fees', 'number'), F('refund_amount', 'number'),
      F('refunded_units', 'number'), F('promotion_discounts', 'number')] },
  { type: 'TEMPLATE_LISTINGS', label: 'ERP template - listings', kind: 'LISTINGS', required: ['seller_sku', 'asin'],
    fields: [F('seller_sku', 'text'), F('asin', 'text'), F('title', 'text', 'item-name'), F('item_price', 'number', 'price'), F('fulfillment_channel', 'text', 'fulfillment-channel'),
      F('listing_status', 'text', 'status')] },
]

/** Finds the header row (within the first 10 rows) and the report type it matches best. */
export function detectReport(rows: string[][]): { def: (typeof DEFS)[number]; headerRow: number; index: Map<string, number> } | null {
  let best: { def: (typeof DEFS)[number]; headerRow: number; index: Map<string, number>; score: number } | null = null
  for (let r = 0; r < Math.min(rows.length, 10); r++) {
    const headers = rows[r].map((h) => norm(h ?? ''))
    for (const def of DEFS) {
      const index = new Map<string, number>()
      for (const f of def.fields) {
        const i = headers.findIndex((h) => f.aliases.includes(h))
        if (i >= 0) index.set(f.field, i)
      }
      if (!def.required.every((f) => index.has(f))) continue
      const score = index.size / def.fields.length + def.required.length / 10
      if (!best || score > best.score) best = { def, headerRow: r, index, score }
    }
  }
  return best && { def: best.def, headerRow: best.headerRow, index: best.index }
}

const slug = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')

/**
 * @param rows   sheet rows (strings)
 * @param reportDate  the single date a Business Report covers (required for BUSINESS_REPORT)
 */
export function parseAmazonReport(rows: string[][], reportDate?: string | null): ParsedReport | { error: string } {
  const found = detectReport(rows)
  if (!found) return { error: 'The columns do not match a supported Amazon report. Supported: Business Report (by child item), Sponsored Products campaign / advertised product / search term reports with a daily Date column, the FBA inventory report, and the ERP templates.' }
  const { def, headerRow, index } = found
  const errors: ParsedReport['errors'] = []
  const out: Record<string, string | number | null>[] = []
  const campaigns = new Map<string, Record<string, string | number | null>>()
  const cell = (r: string[], f: string) => (index.has(f) ? (r[index.get(f)!] ?? '').trim() : '')
  if (def.needsDate && !reportDate) return { error: 'Business Reports have no date column: choose the single day the report covers (download one report per day).' }
  let dateFrom = null as string | null
  let dateTo = null as string | null
  for (let i = headerRow + 1; i < rows.length; i++) {
    const r = rows[i]
    if (!r || r.every((c) => !c || !String(c).trim())) continue
    const line = i + 1
    const rec: Record<string, string | number | null> = {}
    let problem: string | null = null
    for (const f of def.fields) {
      if (!index.has(f.field)) continue
      const raw = cell(r, f.field)
      if (f.type === 'number') {
        const v = parseNumber(raw)
        if (raw && v === null && raw !== '-') problem = `"${raw}" in ${f.field} is not a number`
        rec[f.field] = v
      } else if (f.type === 'date') {
        const v = raw ? parseReportDate(raw) : null
        if (raw && !v) problem = `"${raw}" in ${f.field} is not a date (use YYYY-MM-DD or DD/MM/YYYY)`
        rec[f.field] = v
      } else rec[f.field] = raw || null
    }
    if (/^total/i.test(String(rec.campaign ?? rec.seller_sku ?? ''))) continue
    if (def.needsDate) rec.metric_date = reportDate!
    for (const req of def.required) if (!problem && (rec[req] === null || rec[req] === undefined || rec[req] === '')) problem = `${req} is empty`
    if (!problem && def.daily && rec.end_date && rec.end_date !== rec.metric_date) problem = 'the report is not daily (start and end date differ): download it with a daily time unit'
    if (problem) {
      if (errors.length < 200) errors.push({ row: line, message: problem })
      continue
    }
    delete rec.end_date
    if (def.daily) {
      // Console downloads may lack ids: a stable id is derived from the name (marked CSV).
      const campaignId = (rec.campaign_id as string) || `CSV:${slug(String(rec.campaign))}`
      rec.campaign_id = campaignId
      rec.profile_id = 'CSV'
      if (!campaigns.has(campaignId)) campaigns.set(campaignId, { profile_id: 'CSV', campaign_id: campaignId, name: String(rec.campaign), targeting_type: (rec.targeting_type as string) ?? null,
        state: (rec.state as string) ?? null, daily_budget: (rec.budget as number) ?? null })
      if ('ad_group' in rec || 'ad_group_id' in rec) rec.ad_group_id = (rec.ad_group_id as string) || `CSV:${slug(String(rec.ad_group ?? 'default'))}`
      delete rec.campaign
      delete rec.ad_group
      delete rec.state
      delete rec.targeting_type
      if (def.kind === 'SEARCH_TERM_DAILY' && rec.match_type) rec.match_type = String(rec.match_type).toUpperCase()
    }
    const d = rec.metric_date as string | null
    if (d) {
      dateFrom = !dateFrom || d < dateFrom ? d : dateFrom
      dateTo = !dateTo || d > dateTo ? d : dateTo
    }
    out.push(rec)
  }
  const batches: ParsedReport['batches'] = []
  if (campaigns.size) batches.push({ kind: 'CAMPAIGNS', rows: [...campaigns.values()] })
  batches.push({ kind: def.kind, rows: out })
  return { type: def.type, label: def.label, headerRow: headerRow + 1, batches, errors, dateFrom, dateTo, needsDate: Boolean(def.needsDate) }
}
