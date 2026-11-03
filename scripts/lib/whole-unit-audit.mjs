// Builds supabase/audit/whole_piece_quantity_audit.sql from the audit query in
// the whole-piece migration, so the standalone script (run BEFORE deploying)
// and the in-app audit can never drift apart.

export const MIGRATION = 'supabase/migrations/20261029090000_whole_piece_quantities.sql'
export const AUDIT_SCRIPT = 'supabase/audit/whole_piece_quantity_audit.sql'

const HEADER = `-- =============================================================================
-- WHOLE-PIECE QUANTITY AUDIT (READ ONLY)
--
-- Lists every fractional quantity of a whole-piece item (PCS, NOS, SET, PAIR
-- and aliases) in BOMs, stock balances, the stock ledger, open reservations,
-- production orders and outsourcing orders, for every company.
--
-- It only SELECTs. It does not change, round, delete or reverse anything and
-- can be run on production before or after the whole-piece migration
-- (Supabase Dashboard > SQL Editor > paste > Run; export the result as CSV).
--
-- classification:
--   NEEDS_CORRECTION   BOM quantity that cannot be submitted / approved as is
--   THEORETICAL_RATIO  valid BOM ratio (e.g. 2 per 70 units); planning rounds up
--   INVALID_PLAN       fractional planned / ordered quantity on a document
--   INVALID_PHYSICAL   fractional physical stock, movement or posted quantity
--   REVERSED_HISTORY   fractional posting that has already been reversed
--   ADJUSTMENT_HISTORY fractional approved adjustment / count posting (history)
--
-- Records that need action: STOCK_BALANCE, RESERVATION, INVALID_PLAN rows on
-- open documents, and NEEDS_CORRECTION BOMs. Ledger rows show where each
-- fraction came from; they are history and are never edited.
--
-- Purchase order lines and goods receipts are included in the in-app audit
-- (Inventory > Whole-piece audit) once the purchase order migrations exist.
--
-- GENERATED from ${MIGRATION}
-- by scripts/generate-whole-unit-audit.mjs. Do not edit by hand.
-- =============================================================================
`

export function extractCoreQuery(migrationSql) {
  const begin = migrationSql.indexOf('-- AUDIT-QUERY-BEGIN')
  const end = migrationSql.indexOf('-- AUDIT-QUERY-CORE-END')
  if (begin < 0 || end < 0 || end < begin) throw new Error('Audit query markers not found in the migration.')
  return migrationSql.slice(migrationSql.indexOf('\n', begin) + 1, end).replace(/\s+$/, '')
}

export function unitCodes(migrationSql) {
  const m = /create or replace function private\.whole_unit_codes\(\)[\s\S]*?select array\[([^\]]*)\]/.exec(migrationSql)
  if (!m) throw new Error('private.whole_unit_codes() not found in the migration.')
  return m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''))
}

export function buildAuditScript(migrationSql) {
  const codes = unitCodes(migrationSql)
  const literal = `array[${codes.map((c) => `'${c}'`).join(', ')}]::text[]`
  const query = extractCoreQuery(migrationSql)
    .split('private.whole_unit_codes()').join(literal)
    .split('p_company').join('null::uuid')
  return `${HEADER}
select c.company_code, f.category, f.classification, f.reference, f.sku, f.unit, f.field, f.value, f.detail, f.record_id, f.link
from (
${query}
) f (company_id, category, classification, reference, record_id, link, sku, unit, field, value, detail)
join public.companies c on c.id = f.company_id
order by c.company_code, f.category, f.reference, f.field;
`
}
