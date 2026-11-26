import type { LucideIcon } from 'lucide-react'
import {
  Activity,
  ArrowLeftRight,
  BookText,
  CalendarDays,
  FileSpreadsheet,
  FolderTree,
  Landmark,
  ListOrdered,
  NotebookPen,
  Scale,
  Ban,
  BellRing,
  BookUser,
  BookOpen,
  Boxes,
  Building2,
  ChartBar,
  Contact,
  Headset,
  Inbox,
  Mail,
  MessageCircle,
  PhoneCall,
  Settings,
  Ticket,
  Workflow,
  CalendarRange,
  ChartColumn,
  ClipboardCheck,
  ClipboardList,
  Factory,
  FileBarChart,
  CreditCard,
  FileText,
  GitCompareArrows,
  FileMinus,
  FilePlus,
  FilePlus2,
  FileStack,
  HandCoins,
  Hourglass,
  LayoutDashboard,
  ListTodo,
  Lock,
  Network,
  Package,
  PackageCheck,
  PackageMinus,
  Percent,
  Receipt,
  ScrollText,
  Settings2,
  ShoppingCart,
  SlidersHorizontal,
  Table2,
  UserCog,
  Users,
  Wallet,
  Warehouse,
} from 'lucide-react'

import type { PermissionCode } from '@/auth/permissions'

/**
 * Alton Manufacturing ERP V2 navigation: the nine approved sections plus the Support Centre
 * (added at the owner's request, migration 20261210090000).
 * Every entry opens a working page backed by the V2 database functions.
 */
export type NavKey =
  // 1. Management Dashboard
  | 'dashboard'
  // 2. Product Master & BOM
  | 'products-dashboard'
  | 'products'
  | 'production-boms'
  // 3. Inventory Management
  | 'inventory'
  | 'inventory-register'
  | 'inventory-movements'
  | 'inventory-reservations'
  | 'inventory-warehouses'
  | 'inventory-alerts'
  | 'inventory-adjustments'
  // 4. Purchase & GRN
  | 'purchase-dashboard'
  | 'purchase-orders'
  | 'goods-receipts'
  | 'grn-dashboard'
  // Supplier invoices (Alton Accounts Phase 3, migration 20261231090300)
  | 'purchase-invoices'
  | 'purchase-invoice-matching'
  | 'purchase-invoice-reports'
  // 5. Production & Outsourcing
  | 'production'
  | 'production-orders'
  | 'production-planning'
  | 'production-consumption'
  | 'production-receipts'
  | 'production-reports'
  // 6. Sales & Orders
  | 'sales-dashboard'
  | 'sales-orders'
  | 'sales-backorders'
  | 'sales-cancellation'
  // 7. Billing & Invoicing
  | 'billing-dashboard'
  | 'billing-invoices'
  | 'billing-create'
  | 'billing-register'
  | 'billing-payments'
  | 'billing-allocations'
  | 'billing-receivables'
  | 'billing-ageing'
  | 'billing-credit-notes'
  | 'billing-debit-notes'
  | 'billing-statements'
  | 'billing-tax'
  | 'billing-reports'
  | 'billing-settings'
  // 8. Ledger
  | 'ledger-dashboard'
  | 'ledger'
  | 'ledger-customers'
  | 'ledger-suppliers'
  // 8b. Accounts (Alton Accounts, migration 20261231090000)
  | 'accounts-dashboard'
  | 'accounts-chart'
  | 'accounts-ledgers'
  | 'accounts-journal-new'
  | 'accounts-journals'
  | 'accounts-vouchers'
  | 'accounts-trial-balance'
  | 'accounts-general-ledger'
  | 'accounts-day-book'
  | 'accounts-opening'
  | 'accounts-cost-centres'
  | 'accounts-budgets'
  | 'accounts-cost-centre-reports'
  | 'accounts-posting-monitor'
  | 'accounts-settings'
  // Bank & cash (migration 20261231090400)
  | 'accounts-bank-accounts'
  | 'accounts-cash-accounts'
  | 'accounts-bank-book'
  | 'accounts-cash-book'
  | 'accounts-transfers'
  | 'accounts-payment-accounts'
  | 'accounts-bank-reconciliation'
  | 'accounts-bank-reports'
  | 'accounts-gstr2b'
  | 'accounts-gst-returns'
  // 10. Support Centre
  | 'support-overview'
  | 'support-inbox'
  | 'support-tickets'
  | 'support-customers'
  | 'support-calls'
  | 'support-whatsapp'
  | 'support-emails'
  | 'support-knowledge-base'
  | 'support-automation'
  | 'support-reports'
  | 'support-settings'
  // 9. Reports & Settings
  | 'reports'
  | 'admin-erp-settings'
  | 'users'
  | 'admin-bulk'
  | 'audit-logs'

export interface NavItem {
  key: NavKey
  title: string
  path: string
  icon: LucideIcon
  /** Subtitle shown in the page header and used by global search. */
  description: string
  group: NavGroupId
  keywords?: string[]
  /** Kept as a route (links, global search, permissions) but not listed in the sidebar. */
  hideInSidebar?: boolean
}

export type NavGroupId = 'overview' | 'products' | 'inventory' | 'purchase' | 'production' | 'sales' | 'billing' | 'ledger' | 'accounts' | 'support' | 'reports'

export const NAV_GROUPS: { id: NavGroupId; label: string }[] = [
  { id: 'overview', label: 'Management Dashboard' },
  { id: 'products', label: 'Product Master & BOM' },
  { id: 'inventory', label: 'Inventory Management' },
  { id: 'purchase', label: 'Purchase & GRN' },
  { id: 'production', label: 'Production & Outsourcing' },
  { id: 'sales', label: 'Sales & Orders' },
  { id: 'billing', label: 'Billing & Invoicing' },
  { id: 'ledger', label: 'Ledger' },
  { id: 'accounts', label: 'Accounts' },
  { id: 'support', label: 'Support Centre' },
  { id: 'reports', label: 'Reports & Settings' },
]

export const NAV_ITEMS: NavItem[] = [
  // 1. Management Dashboard
  {
    key: 'dashboard',
    title: 'Management Dashboard',
    path: '/',
    icon: LayoutDashboard,
    group: 'overview',
    description: 'Stock, purchasing, production, sales, invoicing and money owed for the selected period.',
    keywords: ['home', 'overview', 'kpi', 'dashboard', 'management'],
  },

  // 2. Product Master & BOM
  {
    key: 'products-dashboard',
    title: 'Product Dashboard',
    path: '/products/dashboard',
    icon: LayoutDashboard,
    group: 'products',
    description: 'Products by type, products without a BOM, recent and low-stock products.',
    keywords: ['product', 'dashboard', 'bom'],
  },
  {
    key: 'products',
    title: 'Product Master',
    path: '/products',
    icon: Package,
    group: 'products',
    description: 'Finished goods, raw materials, components and packaging: SKUs, categories, units, HSN, GST and prices.',
    keywords: ['sku', 'catalogue', 'item', 'category', 'import'],
  },
  {
    key: 'production-boms',
    title: 'Bill of Materials (BOM)',
    path: '/production/boms',
    icon: Network,
    group: 'products',
    description: 'Raw materials, components and packaging needed per unit of a finished product, with versions.',
    keywords: ['bom', 'recipe', 'components', 'materials'],
  },

  // 3. Inventory Management
  {
    key: 'inventory',
    title: 'Inventory Overview',
    path: '/inventory',
    icon: Boxes,
    group: 'inventory',
    description: 'Current stock position, movements and inventory health.',
    keywords: ['stock', 'inventory', 'kpi', 'dashboard'],
  },
  {
    key: 'inventory-register',
    title: 'Stock Register',
    path: '/inventory/stock',
    icon: Table2,
    group: 'inventory',
    description: 'On-hand, reserved and available stock by product, source, warehouse, location and batch.',
    keywords: ['stock', 'on hand', 'available', 'barcode', 'manufactured', 'outsourced'],
  },
  {
    key: 'inventory-movements',
    title: 'Stock Movements',
    path: '/inventory/movements',
    icon: ArrowLeftRight,
    group: 'inventory',
    description: 'The stock ledger: receipts, issues, transfers, adjustments and reversals.',
    keywords: ['ledger', 'receipt', 'issue', 'transfer', 'grn'],
  },
  {
    key: 'inventory-reservations',
    title: 'Stock Reservations',
    path: '/inventory/reservations',
    icon: Lock,
    group: 'inventory',
    description: 'Stock reserved for sales and production orders but not yet issued.',
    keywords: ['reserve', 'allocation'],
  },
  {
    key: 'inventory-warehouses',
    title: 'Warehouses & Locations',
    path: '/inventory/warehouses',
    icon: Warehouse,
    group: 'inventory',
    description: 'Warehouses, zones, racks, shelves and bins.',
    keywords: ['warehouse', 'bin', 'rack', 'location'],
  },
  {
    key: 'inventory-alerts',
    title: 'Low Stock Alerts',
    path: '/inventory/alerts',
    icon: BellRing,
    group: 'inventory',
    description: 'Low, out-of-stock and expiring inventory.',
    keywords: ['alert', 'low stock', 'expiry', 'reorder'],
  },
  {
    key: 'inventory-adjustments',
    title: 'Stock Adjustments',
    path: '/inventory/adjustments',
    icon: SlidersHorizontal,
    group: 'inventory',
    description: 'Physical stock reconciliation: count, difference, reason, approval and posting.',
    keywords: ['adjustment', 'physical count', 'reconciliation', 'damage', 'loss', 'found', 'write-off'],
  },

  // 4. Purchase Orders & GRN
  {
    key: 'purchase-dashboard',
    title: 'Purchase Dashboard',
    path: '/purchase-orders/dashboard',
    icon: LayoutDashboard,
    group: 'purchase',
    description: 'Open, partially and fully received POs, pending value, overdue deliveries and top suppliers.',
    keywords: ['purchase', 'po', 'dashboard'],
  },
  {
    key: 'purchase-orders',
    title: 'Purchase Orders',
    path: '/purchase-orders',
    icon: ClipboardList,
    group: 'purchase',
    description: 'Raise and follow up purchase orders placed with suppliers.',
    keywords: ['po', 'purchase', 'buying', 'vendor', 'supplier'],
  },
  {
    key: 'goods-receipts',
    title: 'Goods Received (GRN)',
    path: '/goods-receipts',
    icon: PackageCheck,
    group: 'purchase',
    description: 'Goods received against purchase orders or without one; corrections and reversals.',
    keywords: ['grn', 'goods receipt', 'inward', 'challan', 'unlinked', 'receive'],
  },
  {
    key: 'grn-dashboard',
    title: 'GRN Dashboard',
    path: '/goods-receipts/dashboard',
    icon: LayoutDashboard,
    group: 'purchase',
    description: 'GRNs today and this month, pending receipts, rejected goods and unlinked GRNs.',
    keywords: ['grn', 'goods received', 'dashboard', 'pending'],
  },
  {
    key: 'purchase-invoices',
    title: 'Supplier Invoices',
    path: '/purchases/invoices',
    icon: FileText,
    group: 'purchase',
    description: 'Supplier (purchase) invoices: matched to goods receipts or direct, approval, posting, GST verification and payments.',
    keywords: ['supplier invoice', 'purchase invoice', 'bill', 'vendor bill', 'payable', 'itc'],
  },
  {
    key: 'purchase-invoice-matching',
    title: 'GRN Matching',
    path: '/purchases/invoices/matching',
    icon: GitCompareArrows,
    group: 'purchase',
    description: 'Goods receipt lines still to invoice per supplier: ordered, accepted, invoiced and remaining quantities.',
    keywords: ['matching', 'three way match', 'grn invoice', 'uninvoiced'],
  },
  {
    key: 'purchase-invoice-reports',
    title: 'Supplier Invoice Reports',
    path: '/purchases/invoices/reconciliation',
    icon: ChartColumn,
    group: 'purchase',
    description: 'Purchase register, GRN vs invoice, supplier outstanding, AP ageing, GST pending, ITC summary, price variance and cost-centre expense.',
    keywords: ['purchase register', 'ap ageing', 'outstanding', 'itc', 'gst pending', 'price variance', 'reconciliation'],
  },

  // 5. Production & Outsourcing
  {
    key: 'production',
    title: 'Production Dashboard',
    path: '/production',
    icon: Factory,
    group: 'production',
    description: 'Production orders, output, material consumption, shortages and recent activity.',
    keywords: ['production', 'factory', 'manufacturing', 'kpi', 'dashboard', 'new production', 'import production'],
  },
  {
    key: 'production-orders',
    title: 'Production Orders',
    path: '/production/orders',
    icon: ClipboardCheck,
    group: 'production',
    description: 'In-house production orders from draft through material issue, output and completion.',
    keywords: ['work order', 'production order', 'job'],
  },
  {
    key: 'production-planning',
    title: 'Production Planning',
    path: '/production/planning',
    icon: CalendarRange,
    group: 'production',
    description: 'Check material requirements and shortages before anything is reserved or issued.',
    keywords: ['plan', 'mrp', 'requirement', 'shortage'],
  },
  {
    key: 'production-consumption',
    title: 'Material Consumption',
    path: '/production/consumption',
    icon: PackageMinus,
    group: 'production',
    description: 'Raw materials issued to production orders, with lot, location and ledger reference.',
    keywords: ['issue', 'consumption', 'raw material'],
  },
  {
    key: 'production-receipts',
    title: 'Finished Goods Receipts',
    path: '/production/receipts',
    icon: PackageCheck,
    group: 'production',
    description: 'Good, rejected and scrap output recorded against production orders.',
    keywords: ['output', 'finished goods', 'fg receipt', 'rejection', 'scrap'],
  },
  {
    key: 'production-reports',
    title: 'Production Reports',
    path: '/production/reports',
    icon: FileBarChart,
    group: 'production',
    description: 'Production, consumption, outsourcing, traceability and cost reports.',
    keywords: ['report', 'traceability', 'variance', 'cost'],
  },

  // 6. Sales Orders & Fulfilment
  {
    key: 'sales-dashboard',
    title: 'Sales Dashboard',
    path: '/sales/dashboard',
    icon: LayoutDashboard,
    group: 'sales',
    description: 'Sales orders, value, reserved stock, production required, shortages and fulfilment.',
    keywords: ['sales', 'dashboard', 'orders', 'reservation', 'shortage', 'production required'],
  },
  {
    key: 'sales-orders',
    title: 'Sales Orders',
    path: '/sales/orders',
    icon: ShoppingCart,
    group: 'sales',
    description: 'Sales orders with automatic stock reservation and their fulfilment status.',
    keywords: ['so', 'sales order', 'import'],
  },
  {
    key: 'sales-backorders',
    title: 'Partial Fulfilment',
    path: '/sales/backorders',
    icon: ListTodo,
    group: 'sales',
    description: 'Outstanding and backordered quantities per order line, with reasons and expected dates.',
    keywords: ['backorder', 'partial', 'remaining', 'shortage'],
  },
  {
    key: 'sales-cancellation',
    title: 'Order Cancellation',
    path: '/sales/cancellation',
    icon: Ban,
    group: 'sales',
    description: 'Review what cancelling an order affects, then cancel it and release its reservations.',
    keywords: ['cancel', 'release'],
  },

  // 7. Billing & Invoicing
  {
    key: 'billing-dashboard',
    title: 'Invoice Dashboard',
    path: '/billing/dashboard',
    icon: LayoutDashboard,
    group: 'billing',
    description: 'Invoices, value, GST, received, outstanding and overdue, with the monthly trend and the GST summary.',
    keywords: ['invoice', 'dashboard', 'gst', 'outstanding', 'overdue', 'payments'],
  },
  {
    key: 'billing-invoices',
    title: 'Sales Invoices',
    path: '/billing/invoices',
    icon: Receipt,
    group: 'billing',
    description: 'Draft, proforma and issued invoices with their payment state.',
    keywords: ['invoice', 'gst', 'bill', 'draft'],
  },
  {
    key: 'billing-create',
    title: 'Create Invoice',
    path: '/billing/invoices/new',
    icon: FilePlus,
    group: 'billing',
    description: 'Create an invoice manually, from a sales order (full or partial) or from dispatches; proforma invoices too.',
    keywords: ['new invoice', 'manual invoice', 'sales order', 'proforma', 'dispatch', 'billing'],
  },
  {
    key: 'billing-register',
    title: 'Invoice Register',
    path: '/billing/register',
    icon: Table2,
    group: 'billing',
    description: 'All issued and cancelled invoices by financial year, customer and status.',
    keywords: ['register', 'invoice list', 'financial year', 'import'],
  },
  {
    key: 'billing-payments',
    title: 'Customer Payments',
    path: '/billing/payments',
    icon: Wallet,
    group: 'billing',
    description: 'Record receipts, see allocations and reverse receipts with a reason.',
    keywords: ['receipt', 'payment', 'collection', 'upi', 'cheque'],
  },
  {
    key: 'billing-allocations',
    title: 'Payment Allocation',
    path: '/billing/allocations',
    icon: ArrowLeftRight,
    group: 'billing',
    description: 'Allocate unallocated receipts to a customer’s open invoices.',
    keywords: ['allocate', 'unallocated', 'on account', 'advance'],
  },
  {
    key: 'billing-receivables',
    title: 'Outstanding Receivables',
    path: '/billing/receivables',
    icon: HandCoins,
    group: 'billing',
    description: 'Open invoice balances as of a reporting date.',
    keywords: ['outstanding', 'receivable', 'balance due'],
  },
  {
    key: 'billing-ageing',
    title: 'Receivables Ageing',
    path: '/billing/ageing',
    icon: Hourglass,
    group: 'billing',
    description: 'Outstanding balances by customer and days overdue.',
    keywords: ['ageing', 'aging', 'overdue', 'buckets'],
  },
  {
    key: 'billing-credit-notes',
    title: 'Credit Notes',
    path: '/billing/credit-notes',
    icon: FileMinus,
    group: 'billing',
    description: 'Credits against issued invoices for returns, quality issues and agreed corrections.',
    keywords: ['credit note', 'cn', 'return'],
  },
  {
    key: 'billing-debit-notes',
    title: 'Debit Notes',
    path: '/billing/debit-notes',
    icon: FilePlus2,
    group: 'billing',
    description: 'Additional amounts charged against issued invoices.',
    keywords: ['debit note', 'dn', 'additional charge'],
  },
  {
    key: 'billing-statements',
    title: 'Customer Statements',
    path: '/billing/statements',
    icon: ScrollText,
    group: 'billing',
    description: 'Printable statement of account with running balance.',
    keywords: ['statement', 'ledger', 'account'],
  },
  {
    key: 'billing-tax',
    title: 'GST Summary',
    path: '/billing/tax-summary',
    icon: Percent,
    group: 'billing',
    description: 'GST rate, CGST/SGST/IGST and HSN summaries (management reports, not GST returns).',
    keywords: ['gst', 'hsn', 'cgst', 'igst', 'tax'],
  },
  {
    key: 'billing-reports',
    title: 'Billing Reports',
    path: '/billing/reports',
    icon: FileBarChart,
    group: 'billing',
    description: 'Invoices, collections, outstanding, notes, unallocated receipts and cancellations.',
    keywords: ['report', 'collections', 'export'],
  },
  {
    key: 'billing-settings',
    title: 'Invoice Settings',
    path: '/billing/settings',
    icon: Settings2,
    group: 'billing',
    description: 'Numbering, financial year, tax policy, payment terms, bank details and footer.',
    keywords: ['numbering', 'prefix', 'financial year', 'bank'],
  },

  // 8. Ledger
  {
    key: 'ledger-dashboard',
    title: 'Ledger Dashboard',
    path: '/ledger/dashboard',
    icon: LayoutDashboard,
    group: 'ledger',
    description: 'Customers, suppliers, receivables, payables and top parties.',
    keywords: ['ledger', 'dashboard', 'receivable', 'payable'],
  },
  {
    key: 'ledger',
    title: 'Customer & Supplier Ledger',
    path: '/ledger',
    icon: BookUser,
    group: 'ledger',
    description: 'Customers and suppliers in one place: details, outstanding balances and transaction history.',
    keywords: ['party', 'ledger', 'customer', 'supplier', 'vendor', 'receivable', 'payable', 'outstanding', 'gstin'],
  },
  {
    key: 'ledger-customers',
    title: 'Customer Ledger',
    path: '/ledger/customers',
    icon: Users,
    group: 'ledger',
    description: 'Customers (including parties that are also suppliers) with receivables and overdue amounts. Open a customer for its transactions and running balance.',
    keywords: ['customer', 'receivable', 'debtor', 'outstanding', 'statement'],
  },
  {
    key: 'ledger-suppliers',
    title: 'Supplier Ledger',
    path: '/ledger/suppliers',
    icon: Building2,
    group: 'ledger',
    description: 'Suppliers (including parties that are also customers) with payables from goods received less payments. Open a supplier to record a payment.',
    keywords: ['supplier', 'vendor', 'payable', 'creditor', 'payment'],
  },

  // 8b. Accounts: double-entry books from posted vouchers (separate from the operational billing analytics)
  {
    key: 'accounts-dashboard',
    title: 'Accounting Dashboard',
    path: '/accounts',
    icon: Landmark,
    group: 'accounts',
    description: 'Accounting results from posted vouchers: postings this financial year, drafts, items needing attention and whether the books balance.',
    keywords: ['accounts', 'accounting', 'books', 'finance', 'gl'],
  },
  {
    key: 'accounts-chart',
    title: 'Chart of Accounts',
    path: '/accounts/chart',
    icon: FolderTree,
    group: 'accounts',
    description: 'Account groups and ledger accounts as a hierarchy, with posted balances.',
    keywords: ['chart of accounts', 'coa', 'account group', 'ledger'],
  },
  {
    key: 'accounts-ledgers',
    title: 'Ledger Accounts',
    path: '/accounts/ledgers',
    icon: BookText,
    group: 'accounts',
    description: 'Every ledger account with its classification, posting rules and balance. Add bank, cash and expense accounts here.',
    keywords: ['ledger account', 'bank account', 'cash', 'expense head'],
  },
  {
    key: 'accounts-journal-new',
    title: 'Journal Entry',
    path: '/accounts/journals/new',
    icon: NotebookPen,
    group: 'accounts',
    description: 'Manual journal voucher: several debit and credit lines, save as draft, validate, then post (posting needs confirmation).',
    keywords: ['journal', 'jv', 'journal entry', 'manual entry', 'adjustment'],
  },
  {
    key: 'accounts-journals',
    title: 'Journal Register',
    path: '/accounts/journals',
    icon: ScrollText,
    group: 'accounts',
    description: 'Manual journal vouchers by date, number, account, status and creator: open, edit drafts and reverse posted journals.',
    keywords: ['journal register', 'journals', 'jv'],
  },
  {
    key: 'accounts-vouchers',
    title: 'Voucher Register',
    path: '/accounts/vouchers',
    icon: ListOrdered,
    group: 'accounts',
    description: 'All accounting vouchers (posted, reversed, draft and discarded) with filters by date, type, source, account and status.',
    keywords: ['voucher', 'journal', 'register', 'reversal'],
  },
  {
    key: 'accounts-trial-balance',
    title: 'Trial Balance',
    path: '/accounts/trial-balance',
    icon: Scale,
    group: 'accounts',
    description: 'Opening, period and closing debit / credit of every account from posted vouchers.',
    keywords: ['trial balance', 'tb', 'debit', 'credit'],
  },
  {
    key: 'accounts-general-ledger',
    title: 'General Ledger',
    path: '/accounts/general-ledger',
    icon: BookOpen,
    group: 'accounts',
    description: 'Posted entries of one ledger account (or one customer / supplier on a control account) with a running balance.',
    keywords: ['general ledger', 'gl', 'account statement', 'running balance'],
  },
  {
    key: 'accounts-day-book',
    title: 'Day Book',
    path: '/accounts/day-book',
    icon: CalendarDays,
    group: 'accounts',
    description: 'Every posted voucher of a day or period with its lines.',
    keywords: ['day book', 'daybook', 'journal'],
  },
  {
    key: 'accounts-cost-centres',
    title: 'Cost Centres',
    path: '/accounts/cost-centres',
    icon: Network,
    group: 'accounts',
    description: 'Cost centre master: codes, types, hierarchy, effective dates and active / inactive status.',
    keywords: ['cost centre', 'department', 'branch', 'project', 'profit centre'],
  },
  {
    key: 'accounts-budgets',
    title: 'Cost Centre Budgets',
    path: '/accounts/cost-centres/budgets',
    icon: Wallet,
    group: 'accounts',
    description: 'Annual and monthly budgets per cost centre and account: import, versions, approval and history.',
    keywords: ['budget', 'cost centre budget', 'plan'],
  },
  {
    key: 'accounts-cost-centre-reports',
    title: 'Cost Centre Reports',
    path: '/accounts/cost-centres/reports',
    icon: ChartColumn,
    group: 'accounts',
    description: 'Cost centre summary, ledger, profitability and budget versus actual from posted vouchers.',
    keywords: ['cost centre report', 'department expenses', 'budget vs actual', 'profitability'],
  },
  {
    key: 'accounts-opening',
    title: 'Opening Balances',
    path: '/accounts/opening-balances',
    icon: FileSpreadsheet,
    group: 'accounts',
    description: 'Ledger, party, cash, bank, capital and other balances as at the books start date: import, reconcile with the ERP, approve and post.',
    keywords: ['opening balance', 'opening', 'books start'],
  },
  {
    key: 'accounts-posting-monitor',
    title: 'Posting Monitor',
    path: '/accounts/posting-monitor',
    icon: Activity,
    group: 'accounts',
    description: 'Automatic posting of invoices, notes, receipts, supplier payments and goods receipts: run, retry, dismiss and missing account mappings.',
    keywords: ['posting', 'automatic', 'failed', 'mapping', 'integration'],
  },
  {
    key: 'accounts-settings',
    title: 'Accounting Settings',
    path: '/accounts/settings',
    icon: Settings2,
    group: 'accounts',
    description: 'Books start date, financial year, date rules, accounting periods, posting account mappings and cost centres.',
    keywords: ['accounting settings', 'period', 'close period', 'posting rules', 'cost centre'],
  },
  {
    key: 'accounts-bank-accounts',
    title: 'Bank Accounts',
    path: '/accounts/bank-accounts',
    icon: Landmark,
    group: 'accounts',
    description: 'Company bank accounts linked to their bank ledgers; masked account numbers.',
    keywords: ['bank account', 'ifsc', 'current account', 'overdraft'],
  },
  {
    key: 'accounts-cash-accounts',
    title: 'Cash Accounts',
    path: '/accounts/cash-accounts',
    icon: Wallet,
    group: 'accounts',
    description: 'Main, petty and factory cash accounts with custodians and the negative-balance policy.',
    keywords: ['cash', 'petty cash', 'cash in hand'],
  },
  {
    key: 'accounts-bank-book',
    title: 'Bank Book',
    path: '/accounts/bank-book',
    icon: BookOpen,
    group: 'accounts',
    description: 'Posted bank receipts, payments and transfers with running balance and reconciliation status.',
    keywords: ['bank book', 'bank statement', 'passbook'],
  },
  {
    key: 'accounts-cash-book',
    title: 'Cash Book',
    path: '/accounts/cash-book',
    icon: BookText,
    group: 'accounts',
    description: 'Cash receipts and payments with running balance and daily opening / closing.',
    keywords: ['cash book', 'daily cash'],
  },
  {
    key: 'accounts-transfers',
    title: 'Bank & Cash Transfers',
    path: '/accounts/transfers',
    icon: ArrowLeftRight,
    group: 'accounts',
    description: 'Bank to bank, bank to cash and cash to bank transfers (contra vouchers).',
    keywords: ['transfer', 'contra', 'fund transfer', 'cash deposit', 'withdrawal'],
  },
  {
    key: 'accounts-payment-accounts',
    title: 'Payment Accounts',
    path: '/accounts/payment-accounts',
    icon: CreditCard,
    group: 'accounts',
    description: 'The verified bank / cash account of each receipt and supplier payment before posting.',
    keywords: ['payment account', 'receipt account', 'unmapped payment'],
  },
  {
    key: 'accounts-bank-reconciliation',
    title: 'Bank Reconciliation',
    path: '/accounts/bank-reconciliation',
    icon: Scale,
    group: 'accounts',
    description: 'Statement import, matching, bank charges and interest, and the bank reconciliation statement.',
    keywords: ['bank reconciliation', 'brs', 'statement', 'matching'],
  },
  {
    key: 'accounts-bank-reports',
    title: 'Bank & Cash Reports',
    path: '/accounts/bank-reconciliation/reports',
    icon: FileBarChart,
    group: 'accounts',
    description: 'Account summary, outstanding cheques, deposits in transit, unmatched statement lines, charges, transfers and cash position.',
    keywords: ['outstanding cheques', 'deposits in transit', 'cash position', 'bank charges'],
  },
  {
    key: 'accounts-gstr2b',
    title: 'GSTR-2B Matching',
    path: '/accounts/gst/gstr-2b',
    icon: FileSpreadsheet,
    group: 'accounts',
    description: 'Import the GSTR-2B file downloaded from the GST portal, match it with supplier invoices (maker-checker) and review the exceptions.',
    keywords: ['gstr-2b', 'gstr2b', 'itc', 'input tax credit', 'gst matching', 'supplier invoices'],
  },
  {
    key: 'accounts-gst-returns',
    title: 'GST Returns',
    path: '/accounts/gst/returns',
    icon: FileBarChart,
    group: 'accounts',
    description: 'GSTR-1 and GSTR-3B working data, sales / purchase / RCM registers, liability, payments, ledger reconciliation and exceptions. Returns are filed by you on the GST portal.',
    keywords: ['gstr-1', 'gstr-3b', 'gst return', 'hsn summary', 'gst liability', 'gst register', 'rcm'],
  },

  // 10. Support Centre
  {
    key: 'support-overview',
    title: 'Support Overview',
    path: '/support/overview',
    icon: Headset,
    group: 'support',
    description: 'Tickets, calls, WhatsApp and email at a glance: open work, SLA, response times and satisfaction.',
    keywords: ['support', 'helpdesk', 'customer service', 'sla', 'csat'],
  },
  {
    key: 'support-inbox',
    title: 'Unified Inbox',
    path: '/support/inbox',
    icon: Inbox,
    group: 'support',
    description: 'Phone, WhatsApp and email conversations in one place, with assignment, status, tags and notes.',
    keywords: ['inbox', 'conversation', 'reply', 'assign'],
    hideInSidebar: true,
  },
  {
    key: 'support-tickets',
    title: 'Support Tickets',
    path: '/support/tickets',
    icon: Ticket,
    group: 'support',
    description: 'Support tickets with SLA, assignment, merging, reopening and export.',
    keywords: ['ticket', 'complaint', 'case', 'sla'],
  },
  {
    key: 'support-customers',
    title: 'Support Customers',
    path: '/support/customers',
    icon: Contact,
    group: 'support',
    description: 'Customer profiles with their tickets, calls, emails, WhatsApp conversations and ERP history.',
    keywords: ['customer', 'contact', 'profile'],
  },
  {
    key: 'support-calls',
    title: 'Calls',
    path: '/support/calls',
    icon: PhoneCall,
    group: 'support',
    description: 'Phone conversations: incoming, outgoing and missed calls.',
    keywords: ['call', 'phone', 'missed call', 'telephony'],
  },
  {
    key: 'support-whatsapp',
    title: 'WhatsApp',
    path: '/support/whatsapp',
    icon: MessageCircle,
    group: 'support',
    description: 'WhatsApp conversations and the WhatsApp channel status.',
    keywords: ['whatsapp', 'chat', 'message'],
  },
  {
    key: 'support-emails',
    title: 'Emails',
    path: '/support/emails',
    icon: Mail,
    group: 'support',
    description: 'Email conversations and the support mailbox status.',
    keywords: ['email', 'mail', 'inbox'],
  },
  {
    key: 'support-knowledge-base',
    title: 'Knowledge Base',
    path: '/support/knowledge-base',
    icon: BookOpen,
    group: 'support',
    description: 'Answers and procedures for support agents.',
    keywords: ['knowledge', 'faq', 'article', 'help'],
  },
  {
    key: 'support-automation',
    title: 'Support Automation',
    path: '/support/automation',
    icon: Workflow,
    group: 'support',
    description: 'Rules that set priority, department, agent or tags when tickets and conversations are created.',
    keywords: ['automation', 'rule', 'routing'],
    hideInSidebar: true,
  },
  {
    key: 'support-reports',
    title: 'Support Reports',
    path: '/support/reports',
    icon: ChartBar,
    group: 'support',
    description: 'Ticket volume, SLA compliance, agent performance, calls and satisfaction, with Excel export.',
    keywords: ['report', 'sla', 'agent performance', 'csat'],
  },
  {
    key: 'support-settings',
    title: 'Support Settings',
    path: '/support/settings',
    icon: Settings,
    group: 'support',
    description: 'Agents, SLA policies, tags and channel integrations.',
    keywords: ['settings', 'agents', 'sla', 'tags', 'integrations', 'whatsapp', 'email'],
  },

  // 9. Reports & Settings
  {
    key: 'reports',
    title: 'Reports Centre',
    path: '/reports',
    icon: ChartColumn,
    group: 'reports',
    description: 'Twenty reports across products, stock, purchase, production, sales and invoicing, with Excel export.',
    keywords: ['analytics', 'export', 'report'],
  },
  {
    key: 'admin-erp-settings',
    title: 'ERP Settings',
    path: '/admin/erp-settings',
    icon: SlidersHorizontal,
    group: 'reports',
    description: 'Company, numbering, products, stock, purchase, production, sales, invoices, imports and backups.',
    keywords: ['settings', 'configuration', 'preferences', 'company', 'gstin', 'logo'],
  },
  {
    key: 'users',
    title: 'Users & Roles',
    path: '/users',
    icon: UserCog,
    group: 'reports',
    description: 'Sign-in accounts, roles and access permissions.',
    keywords: ['roles', 'permissions', 'staff', 'login'],
  },
  {
    key: 'admin-bulk',
    title: 'Import History',
    path: '/admin/bulk-operations',
    icon: FileStack,
    group: 'reports',
    description: 'Every Excel import run with its rows, rejected rows and error reports.',
    keywords: ['import', 'bulk', 'errors', 'excel'],
  },
  {
    key: 'audit-logs',
    title: 'Audit Log',
    path: '/audit-logs',
    icon: ScrollText,
    group: 'reports',
    description: 'A record of every change made in the ERP.',
    keywords: ['history', 'activity', 'audit'],
  },
]

/**
 * Permission required to see each page (null = any authorized user).
 * Used for sidebar visibility and route guards — the database enforces the
 * same permissions independently through RLS.
 */
export const NAV_PERMISSIONS: Record<NavKey, PermissionCode | null> = {
  dashboard: 'dashboard.read',
  'products-dashboard': 'products.read',
  products: 'products.read',
  'production-boms': 'production_bom.read',
  inventory: 'inventory.read',
  'inventory-register': 'inventory.read',
  'inventory-movements': 'inventory.read',
  'inventory-reservations': 'inventory.read',
  'inventory-warehouses': 'inventory.read',
  'inventory-alerts': 'inventory.read',
  'inventory-adjustments': 'inventory.read',
  'purchase-dashboard': 'purchases.read',
  'purchase-orders': 'purchases.read',
  'goods-receipts': 'purchases.read',
  'grn-dashboard': 'purchases.read',
  'purchase-invoices': 'purchase_invoices.read',
  'purchase-invoice-matching': 'purchase_invoices.read',
  'purchase-invoice-reports': 'purchase_invoices.read',
  production: 'manufacturing.read',
  'production-orders': 'manufacturing.read',
  'production-planning': 'production_plan.create',
  'production-consumption': 'manufacturing.read',
  'production-receipts': 'manufacturing.read',
  'production-reports': 'production_reports.read',
  'sales-dashboard': 'sales_orders.read',
  'sales-orders': 'sales_orders.read',
  'sales-backorders': 'sales_orders.read',
  'sales-cancellation': 'sales_orders.read',
  'billing-dashboard': 'invoices.read',
  'billing-invoices': 'invoices.read',
  'billing-create': 'invoices.create',
  'billing-register': 'invoices.read',
  'billing-payments': 'payments.read',
  'billing-allocations': 'payments.read',
  'billing-receivables': 'billing_reports.read',
  'billing-ageing': 'billing_reports.read',
  'billing-credit-notes': 'invoices.read',
  'billing-debit-notes': 'invoices.read',
  'billing-statements': 'billing_reports.read',
  'billing-tax': 'billing_reports.read',
  'billing-reports': 'billing_reports.read',
  'billing-settings': 'billing_settings.manage',
  'ledger-dashboard': 'ledger.read',
  ledger: 'ledger.read',
  'ledger-customers': 'ledger.read',
  'ledger-suppliers': 'ledger.read',
  'accounts-dashboard': 'accounting_reports.read',
  'accounts-chart': 'accounts.read',
  'accounts-ledgers': 'accounts.read',
  'accounts-journal-new': 'vouchers.create',
  'accounts-journals': 'vouchers.read',
  'accounts-vouchers': 'vouchers.read',
  'accounts-trial-balance': 'accounting_reports.read',
  'accounts-general-ledger': 'accounting_reports.read',
  'accounts-day-book': 'accounting_reports.read',
  'accounts-opening': 'accounting_opening.import',
  'accounts-cost-centres': 'accounts.read',
  'accounts-budgets': 'accounting_budgets.read',
  'accounts-cost-centre-reports': 'accounting_reports.read',
  'accounts-posting-monitor': 'accounting_posting.manage',
  'accounts-settings': 'accounting_settings.manage',
  'accounts-bank-accounts': 'bank_accounts.read',
  'accounts-cash-accounts': 'cash_accounts.read',
  'accounts-bank-book': 'bank_accounts.read',
  'accounts-cash-book': 'cash_accounts.read',
  'accounts-transfers': 'bank_accounts.read',
  'accounts-payment-accounts': 'bank_accounts.read',
  'accounts-bank-reconciliation': 'bank_reconciliation.read',
  'accounts-bank-reports': 'bank_reconciliation.read',
  'accounts-gstr2b': 'gst_reconciliation.read',
  'accounts-gst-returns': 'gst.read',
  'support-overview': 'support.view',
  'support-inbox': 'support.view',
  'support-tickets': 'support.view',
  'support-customers': 'support.view',
  'support-calls': 'support.view',
  'support-whatsapp': 'support.view',
  'support-emails': 'support.view',
  'support-knowledge-base': 'support.view',
  'support-automation': 'support.view',
  'support-reports': 'support.view_reports',
  'support-settings': 'support.view',
  reports: 'reports.read',
  'admin-erp-settings': 'settings.manage',
  users: 'users.manage',
  'admin-bulk': 'bulk_operations.read',
  'audit-logs': 'audit_logs.read',
}

export function findNavItemByPath(pathname: string): NavItem | undefined {
  return NAV_ITEMS.find((item) => item.path === pathname)
}

export function getNavItem(key: NavKey): NavItem {
  const item = NAV_ITEMS.find((i) => i.key === key)
  if (!item) throw new Error(`Unknown navigation key: ${key}`)
  return item
}

export function getNavGroupLabel(id: NavGroupId): string {
  return NAV_GROUPS.find((g) => g.id === id)?.label ?? ''
}
