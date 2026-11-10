import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import {
  confirmationPhrase, deletedWith, DEPARTMENTS, departmentLabel, executeBlocker, groupByOperation, nothingDeletableReason, OPERATION_ORDER, recordType,
  statusLabel, tableLabel, type CategorySummary, type PreviewResult,
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

describe('Purchase & GRN permanent delete: screen rules (20261126090000)', () => {
  const cat = (over: Partial<CategorySummary>): CategorySummary => ({ code: 'purchase.unposted_orders', operation: 'DELETE', label: 'x', description: '', records: 0, rows: 0, blocked: 0, ...over })
  it('explains a disabled permanent delete when every candidate is blocked, and only then', () => {
    assert.equal(nothingDeletableReason([cat({ blocked: 2 }), cat({ code: 'purchase.unposted_receipts' })]),
      'Nothing can be deleted permanently: 2 records are kept because other records depend on them.')
    assert.match(nothingDeletableReason([cat({ blocked: 1 })])!, /1 record is kept because other records depend on it/)
    assert.equal(nothingDeletableReason([cat({ blocked: 2, records: 1 })]), null)
    assert.equal(nothingDeletableReason([cat({})]), null)
    assert.equal(nothingDeletableReason([cat({ operation: 'ARCHIVE', blocked: 3 })]), null)
  })
  it('selection: nothing selected keeps the delete disabled', () => {
    const base = { phrase: 'DELETE PURCHASE', backupId: 'b1', password: 'x', currentUserId: 'u1', preview: preview() }
    assert.equal(executeBlocker({ ...base, selected: 0 }), 'Select at least one eligible record.')
    assert.equal(executeBlocker({ ...base, preview: null, selected: 0 }), 'Select at least one eligible record.')
    assert.equal(executeBlocker({ ...base, selected: 1 }), null)
    assert.equal(executeBlocker({ ...base }), null)
  })
  it('record list labels: type, status with revision, what goes with the record', () => {
    assert.equal(recordType({ type: 'PO', table: 'purchase_orders' }), 'PO')
    assert.equal(recordType({ table: 'inventory_alerts' }), 'Inventory alerts')
    assert.equal(statusLabel('CANCELLED'), 'Cancelled')
    assert.equal(statusLabel('DRAFT', 1), 'Draft (revision 1)')
    assert.equal(statusLabel(undefined), '—')
    assert.equal(deletedWith({ category: 'c', table: 'purchase_orders', key: 'k', record: 'PO-1', rows: 5,
      tables: { purchase_orders: 1, purchase_order_lines: 2, purchase_order_events: 1, erp_form_drafts: 1 } }),
    'Unposted form drafts: 1 · Purchase order history: 1 · Purchase order lines: 2')
    assert.equal(tableLabel('inventory_transactions'), 'Stock movements')
  })
})

describe('Purchase & GRN permanent delete: migration rules (static review)', () => {
  const sql = readFileSync(new URL('../../supabase/migrations/20261126090000_purchase_permanent_delete.sql', import.meta.url), 'utf8')
  const plan = sql.slice(sql.indexOf('create or replace function private.dept_plan(p_company uuid, p_department text, p_operation text, p_categories text[], p_keys text[])'),
    sql.indexOf('-- 4. Preview and execution with the selection'))
  it('GRNs, stock, cost history, payables and payments are never planned for deletion', () => {
    for (const t of ['goods_receipts', 'goods_receipt_lines', 'inventory_transactions', 'inventory_balances', 'product_purchase_cost_events', 'supplier_payments', 'documents',
      'approval_requests', 'audit_logs']) {
      assert.ok(!new RegExp(`insert into pg_temp\\.dept_plan select [^;]*'${t}'`).test(plan), `${t} is planned`)
    }
  })
  it('a draft or cancelled order is kept for a GRN, stock movement, cost history, earlier approval, attachment or pending approval', () => {
    for (const reason of ['Posted goods receipt', 'posted and later reversed', 'Stock movement posted for this order', 'Purchase cost history was recorded from this order',
      'amended back to draft', 'Has an attached file', 'Waiting for approval']) assert.ok(plan.includes(reason), reason)
    assert.match(plan, /o\.status = 'DRAFT'\s+and \(o\.revision > 0 or exists/)
  })
  it('GRN drafts: only unposted (draft or discarded) goods receipt forms', () => {
    assert.match(plan, /d\.form_key = 'purchase\.receipt' and d\.status in \('draft', 'discarded'\)/)
  })
  it('the selection is applied before every check; preview and execution use the same planner', () => {
    assert.ok(plan.indexOf('delete from pg_temp.dept_plan where not (root_key = any (p_keys))') < plan.indexOf('-- ---- Blocking (DELETE and RESET)'))
    assert.match(sql, /v_plan := private\.dept_plan\(v_company, p_department, p_operation, p_categories, p_keys\);[\s\S]*v_plan := private\.dept_plan\(v_company, p_department, p_operation, p_categories, p_keys\);/)
    assert.match(sql, /\(v_plan ->> 'plan_hash'\) is distinct from p_plan_hash/)
  })
  it('no table, policy, trigger or guard change; private functions closed to users', () => {
    assert.ok(!/alter table|create table|create policy|drop policy|create trigger|disable row level security/i.test(sql))
    assert.match(sql, /revoke all on function private\.dept_plan\(uuid, text, text, text\[\], text\[\]\), private\.dept_root_info\(text, text\),\s+private\.dept_preview\(text, text, text\[\], text\[\]\), private\.dept_execute\(text, text, text\[\], text, text, uuid, uuid, text\[\]\)\s+from public, anon, authenticated/)
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
