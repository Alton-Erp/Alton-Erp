-- =============================================================================
-- ALTON ERP V2 — Step 0: single-operator mode
--
-- V2 is run by one person, so nothing waits for a second approver:
--   1. Segregation of duties is OFF unless a company switches it on
--      (company_settings 'inventory.segregation_of_duties' = true).
--   2. One-step actions run the existing submit + approve functions in one
--      transaction. The original functions are unchanged, so every validation,
--      permission check, stock posting and audit entry still happens exactly as
--      before. If any step fails, nothing is saved.
--
-- One-step actions (all SECURITY INVOKER: they add no privileges of their own):
--   purchase_order_open         DRAFT -> open (APPROVED), ready for goods receipt
--   production_bom_activate     DRAFT / REJECTED -> APPROVED (active BOM)
--   production_order_release    DRAFT -> APPROVED, ready to reserve / start
--   outsourcing_order_release   DRAFT -> APPROVED
--   inventory_post_adjustment   create + post a stock adjustment
--   inventory_post_opening_stock submit + post opening stock
--   inventory_post_count        submit + post a physical count's variances
--
-- Approval workflows (Phase 10) still apply only if someone configures one.
-- =============================================================================

-- 1. Segregation of duties defaults to OFF -------------------------------------
create or replace function private.inventory_policy(p_company uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'segregation_of_duties', coalesce((
      select case when jsonb_typeof(setting_value) = 'boolean' then (setting_value)::text::boolean end
      from public.company_settings where company_id = p_company and setting_key = 'inventory.segregation_of_duties'), false),
    'expiry_warning_days', coalesce((
      select case when jsonb_typeof(setting_value) = 'number' then greatest(0, least(365, (setting_value)::text::numeric::int)) end
      from public.company_settings where company_id = p_company and setting_key = 'inventory.expiry_warning_days'), 30)
  );
$$;

revoke all on function private.inventory_policy(uuid) from public, anon, authenticated;

-- 2. One-step actions ------------------------------------------------------------

-- Purchase order: open it for receiving in one step.
create or replace function public.purchase_order_open(p_po_id uuid, p_expected_updated_at timestamptz default null)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_status text;
begin
  select status into v_status from public.purchase_orders where id = p_po_id;
  if not found then
    raise exception 'Purchase order not found in your company.' using errcode = 'P0001';
  end if;
  if v_status = 'DRAFT' then
    perform public.purchase_order_action(p_po_id, 'SUBMIT', null, p_expected_updated_at);
  elsif v_status <> 'PENDING_APPROVAL' then
    raise exception 'This purchase order is already open (status %).', lower(replace(v_status, '_', ' ')) using errcode = 'P0001';
  end if;
  return public.purchase_order_action(p_po_id, 'APPROVE');
end;
$$;

-- BOM: make a draft BOM the active version in one step.
create or replace function public.production_bom_activate(p_bom_id uuid, p_note text default null)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_status text;
begin
  select status into v_status from public.boms where id = p_bom_id;
  if not found then
    raise exception 'BOM not found in your company.' using errcode = 'P0001';
  end if;
  if v_status in ('DRAFT', 'REJECTED') then
    perform public.production_bom_action(p_bom_id, 'SUBMIT', p_note);
  elsif v_status <> 'PENDING_APPROVAL' then
    raise exception 'This BOM is already %.', lower(replace(v_status, '_', ' ')) using errcode = 'P0001';
  end if;
  return public.production_bom_action(p_bom_id, 'APPROVE', p_note);
end;
$$;

-- Production order: release a draft in one step.
create or replace function public.production_order_release(p_order_id uuid, p_note text default null)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_status text;
begin
  select status into v_status from public.production_orders where id = p_order_id;
  if not found then
    raise exception 'Production order not found in your company.' using errcode = 'P0001';
  end if;
  if v_status = 'DRAFT' then
    perform public.production_order_action(p_order_id, 'SUBMIT', p_note);
  elsif v_status <> 'PENDING_APPROVAL' then
    raise exception 'This production order is already released (status %).', lower(replace(v_status, '_', ' ')) using errcode = 'P0001';
  end if;
  return public.production_order_action(p_order_id, 'APPROVE', p_note);
end;
$$;

-- Outsourcing order: release a draft in one step.
create or replace function public.outsourcing_order_release(p_order_id uuid, p_note text default null)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_status text;
begin
  select status into v_status from public.outsourcing_orders where id = p_order_id;
  if not found then
    raise exception 'Outsourcing order not found in your company.' using errcode = 'P0001';
  end if;
  if v_status = 'DRAFT' then
    perform public.outsourcing_order_action(p_order_id, 'SUBMIT', p_note);
  elsif v_status <> 'PENDING_APPROVAL' then
    raise exception 'This outsourcing order is already released (status %).', lower(replace(v_status, '_', ' ')) using errcode = 'P0001';
  end if;
  return public.outsourcing_order_action(p_order_id, 'APPROVE', p_note);
end;
$$;

-- Stock adjustment: record and post in one step. A retry with the same
-- idempotency key returns the posted adjustment and never posts twice.
create or replace function public.inventory_post_adjustment(
  p_adjustment_type     text,
  p_product_id          uuid,
  p_location_id         uuid,
  p_reason_code         text,
  p_batch_id            uuid default null,
  p_batch_number        text default null,
  p_source_type         text default null,
  p_counted_quantity    numeric default null,
  p_correction_quantity numeric default null,
  p_target_source_type  text default null,
  p_unit_cost           numeric default null,
  p_notes               text default null,
  p_reference           text default null,
  p_effective_date      date default null,
  p_idempotency_key     uuid default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_created jsonb;
  v_id      uuid;
  v_status  text;
  v_posted  jsonb;
begin
  v_created := public.inventory_create_adjustment(p_adjustment_type, p_product_id, p_location_id, p_reason_code,
    p_batch_id, p_batch_number, p_source_type, p_counted_quantity, p_correction_quantity, p_target_source_type,
    p_unit_cost, p_notes, p_reference, p_effective_date, true, p_idempotency_key);
  v_id := (v_created ->> 'adjustment_id')::uuid;
  select status into v_status from public.inventory_adjustments where id = v_id;
  if v_status = 'PENDING_APPROVAL' then
    v_posted := public.inventory_review_adjustment(v_id, 'APPROVE', p_notes, gen_random_uuid());
  end if;
  select status into v_status from public.inventory_adjustments where id = v_id;
  return v_created || coalesce(v_posted, '{}'::jsonb) || jsonb_build_object('adjustment_id', v_id, 'status', v_status);
end;
$$;

-- Opening stock: submit and post in one step. Invalid lines are returned as
-- errors and nothing is staged, exactly as inventory_submit_opening_stock does.
create or replace function public.inventory_post_opening_stock(
  p_lines           jsonb,
  p_source          text default 'MANUAL',
  p_file_name       text default null,
  p_notes           text default null,
  p_idempotency_key uuid default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_submitted jsonb;
  v_id        uuid;
  v_status    text;
  v_posted    jsonb;
begin
  v_submitted := public.inventory_submit_opening_stock(p_lines, p_source, p_file_name, p_notes, p_idempotency_key);
  if not coalesce((v_submitted ->> 'ok')::boolean, false) then
    return v_submitted;
  end if;
  v_id := (v_submitted ->> 'opening_batch_id')::uuid;
  select status into v_status from public.inventory_opening_batches where id = v_id;
  if v_status = 'PENDING_APPROVAL' then
    v_posted := public.inventory_review_opening_stock(v_id, 'APPROVE', p_notes, gen_random_uuid());
  end if;
  select status into v_status from public.inventory_opening_batches where id = v_id;
  return v_submitted || coalesce(v_posted, '{}'::jsonb) || jsonb_build_object('opening_batch_id', v_id, 'status', v_status);
end;
$$;

-- Physical count: submit and post the variances in one step.
create or replace function public.inventory_post_count(p_count_id uuid, p_note text default null)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_status text;
begin
  select status into v_status from public.inventory_counts where id = p_count_id;
  if not found then
    raise exception 'Stock count not found in your company.' using errcode = 'P0001';
  end if;
  if v_status = 'OPEN' then
    perform public.inventory_submit_count(p_count_id);
  elsif v_status <> 'SUBMITTED' then
    raise exception 'This stock count is already %.', lower(replace(v_status, '_', ' ')) using errcode = 'P0001';
  end if;
  return public.inventory_review_count(p_count_id, 'APPROVE', p_note, gen_random_uuid());
end;
$$;

-- Grants: signed-in users only; each inner function still checks permissions.
revoke all on function public.purchase_order_open(uuid, timestamptz) from public, anon;
revoke all on function public.production_bom_activate(uuid, text) from public, anon;
revoke all on function public.production_order_release(uuid, text) from public, anon;
revoke all on function public.outsourcing_order_release(uuid, text) from public, anon;
revoke all on function public.inventory_post_adjustment(text, uuid, uuid, text, uuid, text, text, numeric, numeric, text, numeric, text, text, date, uuid) from public, anon;
revoke all on function public.inventory_post_opening_stock(jsonb, text, text, text, uuid) from public, anon;
revoke all on function public.inventory_post_count(uuid, text) from public, anon;

grant execute on function public.purchase_order_open(uuid, timestamptz) to authenticated;
grant execute on function public.production_bom_activate(uuid, text) to authenticated;
grant execute on function public.production_order_release(uuid, text) to authenticated;
grant execute on function public.outsourcing_order_release(uuid, text) to authenticated;
grant execute on function public.inventory_post_adjustment(text, uuid, uuid, text, uuid, text, text, numeric, numeric, text, numeric, text, text, date, uuid) to authenticated;
grant execute on function public.inventory_post_opening_stock(jsonb, text, text, text, uuid) to authenticated;
grant execute on function public.inventory_post_count(uuid, text) to authenticated;
