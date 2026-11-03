import { requireSupabase } from '@/lib/supabase'

/**
 * Stage 7 (migration 20261108090000_management_v2.sql): management overview,
 * module dashboards, ERP settings, global search, activity centre,
 * reconciliation and the reporting centre. All figures come from the database.
 */
async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await (requireSupabase().rpc as unknown as (f: string, a: Record<string, unknown>) => Promise<{ data: T; error: unknown }>)(fn, args)
  if (error) throw error
  return data
}

export type UnitQty = { unit: string; quantity: number }
export type Section<T> = ({ available: true } & T) | { available: false; reason: string }
export const sectionOk = <T,>(s: Section<T> | null | undefined): s is { available: true } & T => Boolean(s && s.available)

export interface AlertItem { label: string; detail: string; link: string }
export interface ManagementAlert { code: string; title: string; severity: 'CRITICAL' | 'WARNING' | 'INFO'; count: number; link: string; items: AlertItem[] }

export interface InventorySection {
  by_type: { product_type: string; unit: string; on_hand: number; reserved: number; available: number | null; value: number | null; uncosted_lots: number }[]
  finished_goods: UnitQty[]
  raw_materials: UnitQty[]
  components: UnitQty[]
  outsourced_components: UnitQty[]
  physical: UnitQty[]
  reserved: UnitQty[]
  available_stock: UnitQty[]
  rejected: UnitQty[]
  incoming: UnitQty[]
  low_stock_items: number
  out_of_stock_items: number
  production_shortages: number
  total_value: number | null
  uncosted_lots: number
  lots: number
  by_warehouse: { warehouse_code: string; warehouse_name: string; unit: string; on_hand: number; reserved: number; available: number }[]
  low_stock: { product_id: string; sku: string; product_name: string; unit: string; available: number; reorder_level: number | null; status: string }[]
  movement: { day: string; unit: string; in: number | null; out: number | null }[]
}

export interface PurchaseSection {
  total: number
  open: number
  overdue: number
  period_value: number
  period_orders: number
  outstanding_receipt_value: number
  created: number
  partially_received: number
  completed: number
  received_value: number
  receipts: number
  by_supplier: { supplier: string; value: number; orders: number }[]
  monthly: { month: string; ordered: number; received: number }[]
}

export interface ProductionSection {
  total_orders: number
  orders: number
  orders_completed: number
  open_orders: number
  planned: UnitQty[]
  actual: UnitQty[]
  finished_goods: UnitQty[]
  raw_materials: UnitQty[]
  components: UnitQty[]
  rejected: UnitQty[]
  wastage: UnitQty[]
  pending: UnitQty[]
  shortages: { component_product_id: string; sku: string; product_name: string; unit: string; shortage: number; orders: number }[]
  daily: { day: string; unit: string; good: number; rejected: number }[]
  monthly: { month: string; unit: string; good: number }[]
  by_product: { product_id: string; sku: string; product_name: string; unit: string; good: number; rejected: number; scrap: number; planned: number | null; yield_percent: number | null; plan_percent: number | null }[]
}

export interface SalesSection {
  total_orders: number
  total_value: number
  pending: number
  partially_fulfilled: number
  fully_fulfilled: number
  cancelled: number
  awaiting_dispatch: number
  finished_goods_reserved: UnitQty[]
  orders_requiring_production: number
  orders_with_shortages: number
  dispatches: number
  dispatched: UnitQty[]
  daily: { day: string; value: number; orders: number }[]
  monthly: { month: string; value: number; orders: number }[]
  by_product: { sku: string; product_name: string; unit: string; ordered: number; value: number | null }[]
  by_customer: { customer: string; value: number; orders: number }[]
}

export interface InvoicingSection {
  total_invoices: number
  total_value: number
  taxable_value: number
  gst_collected: number
  amount_received: number
  outstanding: number
  overdue_amount: number
  partially_paid: number
  fully_paid: number
  overdue: { id: string; invoice_number: string; customer_name: string; due_date: string; balance_due: number; days_overdue: number }[]
  monthly: { month: string; invoiced: number; received: number; gst: number }[]
  gst_summary: { gst_rate: number | null; taxable: number; cgst: number; sgst: number; igst: number; tax: number }[]
  customer_outstanding: { party_id: string; customer: string; outstanding: number; overdue: number; receivable: number }[]
}

export interface ManagementOverview {
  from: string
  to: string
  today: string
  currency: string
  generated_at: string
  kpis: {
    sales_invoiced: number
    sales_order_value: number
    purchase_received: number
    purchase_ordered: number
    production: UnitQty[]
    inventory_value: number | null
    finished_goods_value: number | null
    raw_material_value: number | null
    uncosted_lots: number | null
    invoices: number
    receipts: number
    receipt_count: number
    customer_outstanding: number
    receivables: number
    customer_advances: number
    supplier_outstanding: number
    payables: number
  }
  inventory: Section<InventorySection>
  purchase: Section<PurchaseSection>
  production: Section<ProductionSection>
  sales: Section<SalesSection>
  invoicing: Section<InvoicingSection>
  alerts: ManagementAlert[]
}

export const fetchManagementOverview = (from: string, to: string) => rpc<ManagementOverview>('management_overview', { p_from: from, p_to: to })

export type ModuleKey = 'PRODUCTS' | 'LEDGER' | 'PURCHASE' | 'GRN'
export const fetchModuleDashboard = <T = Record<string, unknown>>(module: ModuleKey, from: string, to: string) =>
  rpc<T>('module_dashboard', { p_module: module, p_from: from, p_to: to })

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
export interface ErpSettingsValues {
  'general.date_format': 'DD-MM-YYYY' | 'DD/MM/YYYY' | 'DD MMM YYYY' | 'YYYY-MM-DD'
  'numbering.po_prefix': string
  'numbering.grn_prefix': string
  'numbering.production_prefix': string
  'numbering.sales_order_prefix': string
  'product.auto_sku': boolean
  'product.sku_prefixes': Record<string, string>
  'product.units': string[]
  'product.default_gst_rate': number
  'product.hsn_codes': { code: string; description?: string | null; gst_rate?: number | null }[]
  /** Group Head choices for products and BOMs (migration 20261114090000). */
  'product.group_heads': string[]
  'inventory.adjustment_reasons': string[]
  'purchase.default_payment_terms': 'IMMEDIATE' | 'DAYS_7' | 'DAYS_15' | 'DAYS_30' | 'DAYS_45'
  'purchase.default_delivery_terms': string | null
  'production.default_wastage_percent': number
  'production.consumption_prefill': 'STANDARD' | 'BLANK'
  'sales.default_payment_terms': string | null
  'sales.default_delivery_instructions': string | null
  'sales.default_warehouse_id': string | null
  'import.date_order': 'DMY' | 'MDY'
}

export interface CompanyProfile {
  id: string
  legal_name: string
  display_name: string
  company_code: string
  legal_address: string | null
  state: string | null
  country: string | null
  gstin: string | null
  state_code: string | null
  state_name: string | null
  pan: string | null
  cin: string | null
  phone: string | null
  email: string | null
  website: string | null
  currency_code: string
  timezone: string
  logo_data_url: string | null
  fy_start_month: number
  current_financial_year: string
}

export interface ErpSettings {
  company: CompanyProfile
  settings: ErpSettingsValues
  defaults: ErpSettingsValues
  counters: Partial<Record<'PO' | 'GRN' | 'PRD' | 'SO', number>>
  warehouses: { id: string; code: string; name: string; is_default: boolean }[]
}

export type ErpPreferences = ErpSettingsValues & { 'company.logo_data_url': string | null }

export const fetchErpSettings = () => rpc<ErpSettings>('erp_settings_get', {})
export const saveErpSettings = (company: Partial<Record<keyof CompanyProfile, unknown>>, settings: Partial<ErpSettingsValues>) =>
  rpc<ErpSettings>('erp_settings_save', { p_company: company, p_settings: settings })
export const fetchErpPreferences = () => rpc<ErpPreferences>('erp_preferences', {})

// ---------------------------------------------------------------------------
// Search, activity, reconciliation, reports
// ---------------------------------------------------------------------------
export interface SearchResult { module: string; id: string; reference: string; title: string; subtitle: string | null; link: string }
export const globalSearch = (term: string) => rpc<SearchResult[]>('global_search', { p_term: term, p_limit: 8 })

export interface ActivityRow { type: string; at: string; reference: string; description: string; link: string }
export interface ActivityFeed { total: number; rows: ActivityRow[]; by_type: Record<string, number> }
export const fetchActivity = (f: { from: string; to: string; type: string | null; search: string; limit: number; offset: number }) =>
  rpc<ActivityFeed>('activity_feed', { p_from: f.from, p_to: f.to, p_type: f.type, p_search: f.search || null, p_limit: f.limit, p_offset: f.offset })

export interface ReconciliationCheck { code: string; area: 'Inventory' | 'Finance'; title: string; rule: string; issues: number; samples: { reference: string; detail: string }[] }
export interface Reconciliation { generated_at: string; issues: number; checks: ReconciliationCheck[] }
export const fetchReconciliation = () => rpc<Reconciliation>('erp_reconciliation', {})

export interface ReportFilters { from?: string | null; to?: string | null; product_id?: string | null; customer_id?: string | null; supplier_id?: string | null; search?: string | null }
export interface ReportResult { report: string; from: string; to: string; generated_at: string; count: number; rows: Record<string, unknown>[] }
/** erp_report_v2 = erp_report plus the product / purchase reference fields and the reorder planning report. */
export const runReport = (report: string, filters: ReportFilters) => rpc<ReportResult>('erp_report_v2', { p_report: report, p_filters: filters })
