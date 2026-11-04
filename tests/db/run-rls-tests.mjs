// Runs the Supabase migrations and the SQL verification suites against PGlite
// (real PostgreSQL compiled to WebAssembly) with a minimal Supabase shim.
//
//   npm run test:db
//
// This proves the SQL, policies, grants, triggers and stock functions behave as
// intended under the real `anon` / `authenticated` roles. It does not exercise
// Supabase Auth or the HTTP Data API; see docs/SUPABASE_SETUP.md for verifying
// a live project. PGlite is single-connection, so true parallel-session
// concurrency is not exercised here (see scripts/verify-supabase.mjs).

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const migrationsDir = path.join(root, 'supabase', 'migrations')
const read = (p) => readFile(p, 'utf8')

const SUITES = [
  { file: 'rls_verification.sql', tag: 'RLS_VERIFICATION_RESULT', label: 'RLS / RBAC / Product Master', companies: ['TESTA', 'TESTB'] },
  { file: 'inventory_verification.sql', tag: 'INVENTORY_VERIFICATION_RESULT', label: 'Inventory (Phase 4)', companies: ['INVA', 'INVB'] },
  { file: 'production_verification.sql', tag: 'PRODUCTION_VERIFICATION_RESULT', label: 'Manufacturing & Outsourcing (Phase 5)', companies: ['PRDA', 'PRDB'] },
  { file: 'customer_po_verification.sql', tag: 'CUSTOMER_PO_VERIFICATION_RESULT', label: 'Customer PO & Fulfilment (Phase 6)', companies: ['POA', 'POB'] },
  { file: 'sales_fulfilment_verification.sql', tag: 'SALES_FULFILMENT_VERIFICATION_RESULT', label: 'Sales Orders & Fulfilment (Phase 7)', companies: ['SOA', 'SOB'] },
  { file: 'billing_verification.sql', tag: 'BILLING_VERIFICATION_RESULT', label: 'Billing & Receivables (Phase 8)', companies: ['BLA', 'BLB'] },
  { file: 'analytics_verification.sql', tag: 'ANALYTICS_VERIFICATION_RESULT', label: 'Executive Analytics (Phase 9)', companies: ['ANA', 'ANB'] },
  { file: 'admin_productivity_verification.sql', tag: 'ADMIN_VERIFICATION_RESULT', label: 'Administration & Productivity (Phase 10)', companies: ['ADA', 'ADB'] },
  { file: 'production_readiness_verification.sql', tag: 'READINESS_VERIFICATION_RESULT', label: 'Production readiness: security, E2E, ledger, isolation (Phase 11)', companies: ['RDA', 'RDB'] },
  { file: 'amazon_verification.sql', tag: 'AMAZON_VERIFICATION_RESULT', label: 'Amazon Sales & Profit Intelligence', companies: ['AMA', 'AMB'] },
  { file: 'suppliers_verification.sql', tag: 'SUPPLIER_VERIFICATION_RESULT', label: 'Supplier master', companies: ['SPA', 'SPB'] },
  { file: 'purchase_orders_verification.sql', tag: 'PURCHASE_ORDER_VERIFICATION_RESULT', label: 'Supplier purchase orders & goods receipts', companies: ['SPOA', 'SPOB'] },
  { file: 'purchase_order_import_verification.sql', tag: 'PO_IMPORT_VERIFICATION_RESULT', label: 'Supplier PO Excel import', companies: ['SPIA', 'SPIB'] },
  { file: 'whole_piece_verification.sql', tag: 'WHOLE_PIECE_VERIFICATION_RESULT', label: 'Whole-piece (PCS) quantities', companies: ['WPA', 'WPB'] },
  { file: 'erp_reset_verification.sql', tag: 'ERP_RESET_VERIFICATION_RESULT', label: 'ERP data reset', companies: ['ERA', 'ERB', 'ERC'] },
  { file: 'erp_force_reset_verification.sql', tag: 'ERP_FORCE_RESET_VERIFICATION_RESULT', label: 'ERP force reset (demo purge)', companies: ['FRA', 'FRB', 'FRC'] },
  { file: 'single_operator_verification.sql', tag: 'SINGLE_OPERATOR_VERIFICATION_RESULT', label: 'V2 single-operator mode', companies: ['SOPA', 'SOPB'] },
  { file: 'product_master_v2_verification.sql', tag: 'PRODUCT_V2_VERIFICATION_RESULT', label: 'V2 Stage 1: Product Master & BOM', companies: ['PMVA', 'PMVB'] },
  { file: 'ledger_verification.sql', tag: 'LEDGER_VERIFICATION_RESULT', label: 'V2 Stage 2: Unified Ledger', companies: ['LGA', 'LGB'] },
  { file: 'purchasing_v2_verification.sql', tag: 'PURCHASING_V2_VERIFICATION_RESULT', label: 'V2 Stage 3: Purchase Orders & GRN', companies: ['PGA', 'PGB'] },
  { file: 'production_v2_verification.sql', tag: 'PRODUCTION_V2_VERIFICATION_RESULT', label: 'V2 Stage 4: Production', companies: ['PDA', 'PDB'] },
  { file: 'sales_v2_verification.sql', tag: 'SALES_V2_VERIFICATION_RESULT', label: 'V2 Stage 5: Sales Orders', companies: ['SVA', 'SVB'] },
  { file: 'invoicing_v2_verification.sql', tag: 'INVOICING_V2_VERIFICATION_RESULT', label: 'V2 Stage 6: Invoicing', companies: ['IVA', 'IVB'] },
  { file: 'stage7_e2e_verification.sql', tag: 'STAGE7_E2E_VERIFICATION_RESULT', label: 'V2 Stage 7: end-to-end workflow, dashboards, reports, reconciliation', companies: ['E7A', 'E7B'] },
  { file: 'stock_reliability_verification.sql', tag: 'STOCK_RELIABILITY_VERIFICATION_RESULT', label: 'V2: Stock register, stock accuracy & duplicate-safe production', companies: ['SRA', 'SRB'] },
  { file: 'product_purchase_v2_verification.sql', tag: 'PRODUCT_PURCHASE_V2_VERIFICATION_RESULT', label: 'V2: Product Master, BOM & Purchase enhancements', companies: ['PPVA', 'PPVB'] },
  { file: 'invoice_dispatch_policy_verification.sql', tag: 'INVOICE_DISPATCH_POLICY_RESULT', label: 'V2: Dispatch before invoice posting', companies: ['DPA', 'DPB'] },
  { file: 'bom_planning_ean_verification.sql', tag: 'BOM_PLANNING_EAN_RESULT', label: 'V2: BOM planning fields & Product Master EAN', companies: ['BPA', 'BPB'] },
  { file: 'partial_invoicing_verification.sql', tag: 'PARTIAL_INVOICING_RESULT', label: 'V2: Partial invoicing, pending-invoice tracking & release', companies: ['PIA', 'PIB'] },
  { file: 'user_invitations_verification.sql', tag: 'USER_INVITATIONS_RESULT', label: 'V2: User invitations & functional roles', companies: ['INVA', 'INVB'] },
  { file: 'form_drafts_verification.sql', tag: 'FORM_DRAFTS_RESULT', label: 'V2: Persistent form drafts (auto-save)', companies: ['DFA', 'DFB'] },
  { file: 'master_versioning_verification.sql', tag: 'MASTER_VERSIONING_RESULT', label: 'V2: Immutable product, component and BOM versions', companies: ['MVA', 'MVB'] },
  { file: 'force_reset_direct_verification.sql', tag: 'FORCE_RESET_DIRECT_RESULT', label: 'V2: Force Reset / Delete Everything (direct)', companies: ['DRA', 'DRB'] },
]

const db = new PGlite()

async function applyMigrations(label) {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort()
  for (const file of files) {
    try {
      await db.exec(await read(path.join(migrationsDir, file)))
    } catch (error) {
      console.error(`\n✗ ${label}: migration ${file} failed: ${error.message}`)
      process.exit(1)
    }
  }
  console.log(`✓ ${label}: applied ${files.length} migrations`)
}

await db.exec(await read(path.join(root, 'supabase', 'tests', 'local_supabase_shim.sql')))
await applyMigrations('fresh database')
await applyMigrations('re-apply (idempotency)')

// The standalone read-only audit script (run on production before deploying)
// is handed to the whole-piece suite, which compares it with the in-app audit.
await db.query(`select set_config('wp.audit_script', $1, false)`,
  [await read(path.join(root, 'supabase', 'audit', 'whole_piece_quantity_audit.sql'))])

const counts = await db.query(`
  select (select count(*) from public.roles)::int as roles,
         (select count(*) from public.permissions)::int as permissions,
         (select count(*) from public.role_permissions)::int as grants,
         (select count(*) from public.companies)::int as companies,
         (select count(*) from public.product_categories)::int as suggested_categories,
         (select count(*) from public.products)::int as products,
         (select count(*) from public.inventory_transactions)::int as stock_transactions`)
console.log('  seeded:', counts.rows[0])

let totalFailed = 0
// DB_SUITE=whole_piece npm run test:db runs only the matching suite(s).
const only = process.env.DB_SUITE
for (const suite of SUITES.filter((s) => !only || s.file.includes(only))) {
  let message = ''
  let detail = ''
  try {
    await db.exec(await read(path.join(root, 'supabase', 'tests', suite.file)))
  } catch (error) {
    message = error.message ?? String(error)
    detail = error.detail ?? ''
    // Where a script stopped early (outside its error-catching helpers).
    if (error.where) message += ` (at: ${error.where})`
    if (!error.where && error.position) message += ` (position ${error.position})`
  }
  await db.exec('rollback').catch(() => {})

  const match = new RegExp(`${suite.tag} passed=(\\d+) failed=(\\d+)`).exec(message)
  if (!match) {
    console.error(`\n✗ ${suite.label}: script did not complete: ${message}`)
    process.exit(1)
  }
  console.log(`\n${suite.label}`)
  for (const line of detail.split('\n').filter(Boolean)) {
    console.log(line.startsWith('PASS') ? `  ✓ ${line.slice(5)}` : `  ✗ ${line.slice(5)}`)
  }
  const [passed, failed] = [Number(match[1]), Number(match[2])]
  totalFailed += failed
  console.log(`${failed === 0 ? '✓' : '✗'} ${suite.label}: ${passed} passed, ${failed} failed`)

  const leftovers = await db.query(`select count(*)::int as n from public.companies where company_code = any($1)`, [suite.companies])
  if (leftovers.rows[0].n !== 0) {
    console.error(`✗ ${suite.label}: test fixtures were not rolled back`)
    process.exit(1)
  }
}

process.exit(totalFailed === 0 ? 0 : 1)
