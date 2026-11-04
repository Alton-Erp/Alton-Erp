import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import {
  confirmationPhrase, DEPARTMENTS, departmentLabel, executeBlocker, groupByOperation, OPERATION_ORDER, tableLabel, type CategorySummary, type PreviewResult,
} from '../../src/features/admin/department-data-model.ts'

const preview = (over: Partial<PreviewResult> = {}): PreviewResult => ({
  department: 'PURCHASE', operation: 'DELETE', categories: ['purchase.unposted_orders'], plan_hash: 'h', tables: { purchase_orders: 1 }, total: 1,
  by_category: [], blocked: [], blocked_total: 0, affected_departments: ['PURCHASE'], confirmation_phrase: 'DELETE PURCHASE',
  requires_backup: true, requires_password: true, backup: null, ...over,
})

describe('department data management: screen rules', () => {
  it('seven departments, in the approved order, with the codes the database uses', () => {
    assert.deepEqual(DEPARTMENTS.map((d) => d.key), ['PRODUCTS', 'INVENTORY', 'PURCHASE', 'PRODUCTION', 'SALES', 'BILLING', 'LEDGER'])
    assert.equal(departmentLabel('BILLING'), 'Billing & Invoice')
    assert.equal(confirmationPhrase('DELETE', 'SALES'), 'DELETE SALES')
  })
  it('the execute button stays disabled until preview, phrase, backup and password are all there', () => {
    const base = { phrase: 'DELETE PURCHASE', backupId: 'b1', password: 'x', currentUserId: 'u1' }
    assert.equal(executeBlocker({ ...base, preview: null }), 'Preview first.')
    assert.equal(executeBlocker({ ...base, preview: preview({ total: 0 }) }), 'Nothing is eligible.')
    assert.match(executeBlocker({ ...base, phrase: 'delete purchase', preview: preview() })!, /Type DELETE PURCHASE/)
    assert.match(executeBlocker({ ...base, backupId: null, preview: preview() })!, /backup/)
    assert.match(executeBlocker({ ...base, preview: preview({ backup: { id: 'b1', recorded_by: 'someone else' } as never }) })!, /yourself/)
    assert.match(executeBlocker({ ...base, password: '', preview: preview() })!, /password/)
    assert.equal(executeBlocker({ ...base, preview: preview() }), null)
  })
  it('archive and reset need only the phrase', () => {
    const p = preview({ operation: 'RESET', confirmation_phrase: 'RESET PURCHASE', requires_backup: false, requires_password: false })
    assert.equal(executeBlocker({ preview: p, phrase: 'RESET PURCHASE', backupId: null, password: '', currentUserId: 'u1' }), null)
  })
  it('categories are grouped archive → reset → delete', () => {
    const c = (code: string, operation: CategorySummary['operation']): CategorySummary => ({ code, operation, label: code, description: '', records: 1, rows: 1, blocked: 0 })
    assert.deepEqual(groupByOperation([c('d', 'DELETE'), c('a', 'ARCHIVE'), c('r', 'RESET')]).map((g) => g.operation), OPERATION_ORDER)
    assert.deepEqual(groupByOperation([c('d', 'DELETE')]).map((g) => g.operation), ['DELETE'])
    assert.equal(tableLabel('purchase_order_lines'), 'Purchase order lines')
  })
})

describe('department data management: migration rules (static review)', () => {
  const sql = readFileSync(new URL('../../supabase/migrations/20261119090000_department_data_management.sql', import.meta.url), 'utf8')
  const plan = sql.slice(sql.indexOf('create or replace function private.dept_plan('), sql.indexOf('-- 5. Checks shared by the public functions'))
  it('posted, issued and ledger tables are never planned for change', () => {
    for (const t of ['inventory_transactions', 'inventory_balances', 'inventory_batches', 'goods_receipts', 'goods_receipt_lines', 'production_material_consumption',
      'production_output_receipts', 'outsourcing_receipts', 'outsourcing_material_movements', 'fulfilments', 'fulfilment_lines', 'customer_returns',
      'customer_payments', 'invoice_payment_allocations', 'supplier_payments', 'audit_logs', 'erp_reset_runs', 'approval_decisions']) {
      assert.ok(!new RegExp(`insert into pg_temp\\.dept_plan select [^;]*'${t}'`).test(plan), `${t} is planned`)
      assert.ok(!plan.includes(`'${t}', id::text from`) && !plan.includes(`, '${t}' t,`), `${t} is planned`)
    }
  })
  it('only unissued invoices and notes, and draft or cancelled documents, are candidates', () => {
    assert.match(plan, /from public\.sales_invoices where company_id = p_company and status in \('DRAFT', 'DISCARDED'\) and invoice_number is null and proforma_number is null/)
    assert.match(plan, /from public\.invoice_adjustment_notes where company_id = p_company and status in \('DRAFT', 'DISCARDED'\) and note_number is null/)
    assert.match(plan, /from public\.purchase_orders where company_id = p_company and status in \('DRAFT', 'CANCELLED'\)/)
    assert.match(plan, /from public\.production_orders where company_id = p_company and status in \('DRAFT', 'CANCELLED'\)/)
    assert.match(plan, /from public\.sales_orders where company_id = p_company and order_status in \('DRAFT', 'CANCELLED'\)/)
  })
  it('masters must be inactive before they can be deleted', () => {
    assert.match(plan, /from public\.products where company_id = p_company and status = 'INACTIVE';/)
    assert.match(plan, /from public\.product_categories where company_id = p_company and not is_active/)
    assert.match(plan, /from public\.warehouses where company_id = p_company and status = 'INACTIVE' and not is_default/)
  })
  it('every statement is limited to the caller\'s company; no cascade, no RLS change', () => {
    assert.ok(!/on delete cascade/i.test(sql.replace(/references private\.dept_purge_sessions \(id\) on delete cascade/, '')), 'a cascade outside the session table')
    assert.ok(!/disable row level security|no force row level security|alter policy|drop policy/i.test(sql))
    assert.match(sql, /delete from public\.%I t where t\.company_id = \$1 and/)
    assert.match(sql, /select company_id into v_company from public\.profiles where id = v_actor/)
  })
  it('permanent delete requires phrase, own recent backup and a recent password sign-in, checked in the database', () => {
    assert.match(sql, /p_confirmation is distinct from p_operation \|\| ' ' \|\| p_department/)
    assert.match(sql, /erp_force_reset_valid_backup\(v_company, p_backup_id\)/)
    assert.match(sql, /\(v_backup ->> 'recorded_by'\)::uuid is distinct from v_actor/)
    assert.match(sql, /not private\.dept_recent_password\(5\)/)
    assert.match(sql, /\(v_plan ->> 'plan_hash'\) is distinct from p_plan_hash/)
  })
})
