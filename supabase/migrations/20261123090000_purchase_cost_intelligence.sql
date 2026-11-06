-- =============================================================================
-- Purchase Cost Intelligence: automatic Last Purchase Cost on GRN posting
--
-- Inspected before writing (actual fields and functions):
--   * products: standard_cost (Standard Purchase Cost, entered by the user and used
--     by production as a fallback material cost), standard_manufacturing_cost (the
--     Product Master COST column), mrp, selling_price. None of them is touched here.
--   * Receipts: public.purchase_receipt_post (PO receipts) and
--     public.goods_receipt_direct_post (direct receipts) insert goods_receipts
--     (status POSTED; there are no draft receipts) and goods_receipt_lines, whose
--     unit_cost is the accepted unit cost. Reversal: purchase_receipt_reverse /
--     goods_receipt_reverse set goods_receipts.status = REVERSED (lines stay
--     unchanged); goods_receipt_correct = reversal + new receipt, one transaction.
--   * Cost basis of goods_receipt_lines.unit_cost (existing rule, reused as is):
--       PO receipt:     round(order line taxable_value / ordered_quantity, 4), where
--                       taxable_value = round(quantity x unit_price, 2) - line discount
--                       (percentage or amount, capped at the line). GST (CGST, SGST,
--                       IGST) excluded; freight and other charges are separate CHARGE
--                       lines and are not spread over goods; header round-off excluded.
--       Direct receipt: the unit cost entered on the receipt (default: the product's
--                       Standard Purchase Cost), excluding GST.
--       Currency:       INR only (purchase_orders.currency_code check) - no conversion.
--       Unit:           goods lines always use the product's base unit - no conversion.
--     The same value is the cost of the received stock lot, so Last Purchase Cost and
--     inventory valuation (lot-level weighted average, private.lot_average_cost) never
--     disagree; valuation itself is not changed.
--
-- What it adds:
--   * public.product_purchase_cost_events   immutable history (append-only)
--   * public.product_last_purchase_costs    the current Last Purchase Cost per product
--     (kept off the products row: a products update would create a product version,
--     an audit entry and a new updated_at on every receipt)
--   * A DEFERRED constraint trigger on goods_receipt_lines: at the end of the posting
--     transaction (so after every line of the receipt exists) it records one event per
--     receipt and product with the quantity-weighted accepted unit cost, updates the
--     current cost, writes the audit log and the notifications. If anything fails, the
--     whole posting (receipt, stock, cost, history, audit) rolls back together.
--   * A trigger on goods_receipts POSTED -> REVERSED: reversal events and the Last
--     Purchase Cost recalculated from the latest remaining valid receipt.
--   * Settings (ERP Settings -> Products -> Purchase Cost Intelligence), validated on
--     every write path; erp_settings_save already audits every settings change.
--   * RPCs: product_purchase_costs, product_purchase_cost_history,
--     product_purchase_cost_override (exceptional manual override, permission set in
--     the settings).
--
-- Current cost = the latest valid event (eligible, not reversed) by receipt date, then
-- posting time: a receipt dated earlier than the current one is kept in the history but
-- never overwrites a later cost. Events of one company + product are serialised by an
-- advisory lock; one event per source (unique idempotency_key), so a repeated posting
-- creates nothing.
--
-- Rollback: supabase/rollback/20261123090000_purchase_cost_intelligence_down.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Tables
-- -----------------------------------------------------------------------------
create table if not exists public.product_purchase_cost_events (
  id                     uuid primary key default gen_random_uuid(),
  company_id             uuid not null references public.companies (id) on delete restrict,
  product_id             uuid not null,
  event_type             text not null check (event_type in ('GRN_RECEIPT', 'GRN_REVERSAL', 'MANUAL_OVERRIDE')),
  status                 text not null check (status in ('APPLIED', 'NOT_APPLIED')),
  not_applied_reason     text,
  eligible               boolean not null,
  previous_cost          numeric(16,4) check (previous_cost is null or previous_cost >= 0),
  new_cost               numeric(16,4) check (new_cost is null or new_cost >= 0),
  difference_amount      numeric(16,4) generated always as (new_cost - previous_cost) stored,
  difference_percentage  numeric(10,2) generated always as (
                           case when previous_cost > 0 and new_cost is not null then round((new_cost - previous_cost) / previous_cost * 100, 2) end) stored,
  change_type            text generated always as (
                           case when new_cost is null then 'NO_COST'
                                when previous_cost is null then 'INITIAL_COST'
                                when new_cost > previous_cost then 'INCREASE'
                                when new_cost < previous_cost then 'DECREASE'
                                else 'NO_CHANGE' end) stored,
  significant            boolean not null default false,
  received_quantity      numeric(16,3),
  rejected_quantity      numeric(16,3),
  unit                   text,
  currency               text not null default 'INR',
  cost_basis             jsonb not null default '{}'::jsonb,
  supplier_id            uuid,
  supplier_name          text,
  purchase_order_id      uuid,
  po_number              text,
  purchase_order_line_id uuid,
  goods_receipt_id       uuid,
  receipt_number         text,
  goods_receipt_line_ids uuid[],
  effective_date         date not null,
  posted_at              timestamptz not null,
  reversal_of_event_id   uuid references public.product_purchase_cost_events (id) on delete restrict,
  reason                 text not null check (length(reason) between 1 and 500),
  idempotency_key        text not null check (length(idempotency_key) between 1 and 200),
  created_by             uuid,
  created_at             timestamptz not null default clock_timestamp(),
  constraint product_purchase_cost_events_product_fk foreign key (product_id, company_id)
    references public.products (id, company_id) on delete restrict,
  constraint product_purchase_cost_events_idempotency_unique unique (company_id, idempotency_key)
);

comment on table public.product_purchase_cost_events is
  'Purchase cost history (migration 20261123090000): one immutable event per posted receipt and product, reversal or manual override.';

create index if not exists product_purchase_cost_events_product_idx
  on public.product_purchase_cost_events (company_id, product_id, effective_date desc, posted_at desc);
create index if not exists product_purchase_cost_events_receipt_idx
  on public.product_purchase_cost_events (goods_receipt_id) where goods_receipt_id is not null;
create index if not exists product_purchase_cost_events_reversal_idx
  on public.product_purchase_cost_events (reversal_of_event_id) where reversal_of_event_id is not null;
create index if not exists product_purchase_cost_events_supplier_idx
  on public.product_purchase_cost_events (company_id, product_id, supplier_id, effective_date desc) where supplier_id is not null;

create table if not exists public.product_last_purchase_costs (
  company_id            uuid not null references public.companies (id) on delete restrict,
  product_id            uuid not null,
  last_purchase_cost    numeric(16,4) check (last_purchase_cost is null or last_purchase_cost >= 0),
  last_purchase_date    date,
  previous_cost         numeric(16,4),
  difference_amount     numeric(16,4),
  difference_percentage numeric(10,2),
  change_type           text check (change_type in ('INCREASE', 'DECREASE', 'NO_CHANGE', 'INITIAL_COST', 'NO_COST')),
  supplier_id           uuid,
  supplier_name         text,
  source_event_id       uuid,
  last_event_id         uuid,
  updated_at            timestamptz not null default now(),
  primary key (company_id, product_id),
  constraint product_last_purchase_costs_product_fk foreign key (product_id, company_id)
    references public.products (id, company_id) on delete restrict
);

comment on table public.product_last_purchase_costs is
  'Last Purchase Cost per product (migration 20261123090000). Written only by the purchase cost functions; null cost = no valid receipt.';

alter table public.product_purchase_cost_events enable row level security;
alter table public.product_last_purchase_costs enable row level security;
revoke all on public.product_purchase_cost_events from public, anon, authenticated;
revoke all on public.product_last_purchase_costs from public, anon, authenticated;
grant select on public.product_purchase_cost_events to authenticated;
grant select on public.product_last_purchase_costs to authenticated;
drop policy if exists product_purchase_cost_events_select on public.product_purchase_cost_events;
create policy product_purchase_cost_events_select on public.product_purchase_cost_events for select to authenticated
  using (company_id = private.current_company_id() and private.has_permission(company_id, 'products.read'));
drop policy if exists product_last_purchase_costs_select on public.product_last_purchase_costs;
create policy product_last_purchase_costs_select on public.product_last_purchase_costs for select to authenticated
  using (company_id = private.current_company_id() and private.has_permission(company_id, 'products.read'));

-- Append-only: no update, no delete (except the ERP reset purge), through the shared guard.
drop trigger if exists product_purchase_cost_events_append_only on public.product_purchase_cost_events;
create trigger product_purchase_cost_events_append_only before update or delete on public.product_purchase_cost_events
  for each row execute function private.prevent_history_mutation();

-- -----------------------------------------------------------------------------
-- 2. Settings
-- -----------------------------------------------------------------------------
-- Same as 20261122090000_product_import_match_key.sql plus the purchase cost keys.
create or replace function private.erp_setting_defaults()
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'general.date_format', 'DD MMM YYYY',
    'numbering.po_prefix', 'PO',
    'numbering.grn_prefix', 'GRN',
    'numbering.production_prefix', 'PRD',
    'numbering.sales_order_prefix', 'SO',
    'product.auto_sku', true,
    'product.sku_prefixes', jsonb_build_object('FINISHED_GOOD', 'FG', 'RAW_MATERIAL', 'RM', 'COMPONENT', 'CMP', 'SUBASSEMBLY', 'SUB',
      'OUTSOURCED_COMPONENT', 'OSC', 'PACKAGING_MATERIAL', 'PKG', 'CONSUMABLE', 'CON', 'OTHER', 'ITM'),
    'product.units', jsonb_build_array('PCS', 'NOS', 'SET', 'PAIR', 'BOX', 'KG', 'G', 'LTR', 'ML', 'MTR', 'SQM'),
    'product.default_gst_rate', 18,
    'product.hsn_codes', '[]'::jsonb,
    'product.group_heads', '[]'::jsonb,
    'product.import_match_key', 'SKU',
    'product.purchase_cost_auto_update', true,
    'product.purchase_cost_increase_alerts', true,
    'product.purchase_cost_decrease_alerts', true,
    'product.purchase_cost_alert_percent', 10,
    'product.purchase_cost_zero_policy', 'IGNORE',
    'product.purchase_cost_override_permission', 'purchase_exception.approve',
    'inventory.adjustment_reasons', jsonb_build_array('Damaged', 'Count correction', 'Expired', 'Sample issued', 'Found in stock', 'Other'),
    'purchase.default_payment_terms', 'DAYS_30',
    'purchase.default_delivery_terms', null,
    'production.default_wastage_percent', 0,
    'production.consumption_prefill', 'STANDARD',
    'sales.default_payment_terms', null,
    'sales.default_delivery_instructions', null,
    'sales.default_warehouse_id', null,
    'import.date_order', 'DMY');
$$;
revoke all on function private.erp_setting_defaults() from public, anon, authenticated;

-- Same as 20261122090000 plus the purchase cost keys.
create or replace function private.company_settings_validate()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_t text := jsonb_typeof(new.setting_value);
begin
  if new.setting_key = 'product.group_heads' and not (
       jsonb_typeof(new.setting_value) = 'array' and jsonb_array_length(new.setting_value) <= 200
       and not exists (select 1 from jsonb_array_elements(new.setting_value) e
                       where jsonb_typeof(e) <> 'string' or length(btrim(e #>> '{}')) not between 1 and 100)
       and (select count(*) from jsonb_array_elements_text(new.setting_value) e)
           = (select count(distinct lower(btrim(e))) from jsonb_array_elements_text(new.setting_value) e)) then
    raise exception 'Group heads: up to 200 different names of 1 to 100 characters.' using errcode = 'P0001';
  end if;
  if new.setting_key = 'product.import_match_key' and not (
       v_t = 'string' and (new.setting_value #>> '{}') in ('SKU', 'BARCODE', 'EAN', 'MODEL_NUMBER', 'PRODUCT_NAME', 'NONE')) then
    raise exception 'Import match key: SKU, Barcode, EAN, Model Number, Product Name or None.' using errcode = 'P0001';
  end if;
  if new.setting_key in ('product.purchase_cost_auto_update', 'product.purchase_cost_increase_alerts', 'product.purchase_cost_decrease_alerts')
     and v_t <> 'boolean' then
    raise exception 'This purchase cost option is on or off.' using errcode = 'P0001';
  end if;
  if new.setting_key = 'product.purchase_cost_alert_percent' and not (
       v_t = 'number' and (new.setting_value #>> '{}')::numeric between 0 and 1000
       and (new.setting_value #>> '{}')::numeric = round((new.setting_value #>> '{}')::numeric, 2)) then
    raise exception 'The significant change threshold is a percentage from 0 to 1000 (up to 2 decimals).' using errcode = 'P0001';
  end if;
  if new.setting_key = 'product.purchase_cost_zero_policy' and not (
       v_t = 'string' and (new.setting_value #>> '{}') in ('IGNORE', 'APPLY', 'INITIAL_ONLY')) then
    raise exception 'Zero-cost receipts: ignore, apply, or apply only when the product has no cost yet.' using errcode = 'P0001';
  end if;
  if new.setting_key = 'product.purchase_cost_override_permission' and not (
       v_t = 'string' and (new.setting_value #>> '{}') in ('purchase_exception.approve', 'purchase_order.approve', 'products.update', 'settings.manage')) then
    raise exception 'Cost overrides: purchase exception approvers, purchase order approvers, product editors or settings managers.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function private.company_settings_validate() from public, anon, authenticated;

create or replace function private.purchase_cost_settings(p_company uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'auto_update', coalesce((private.erp_setting(p_company, 'product.purchase_cost_auto_update'))::text::boolean, true),
    'increase_alerts', coalesce((private.erp_setting(p_company, 'product.purchase_cost_increase_alerts'))::text::boolean, true),
    'decrease_alerts', coalesce((private.erp_setting(p_company, 'product.purchase_cost_decrease_alerts'))::text::boolean, true),
    'alert_percent', coalesce((private.erp_setting(p_company, 'product.purchase_cost_alert_percent') #>> '{}')::numeric, 10),
    'zero_policy', coalesce(private.erp_setting(p_company, 'product.purchase_cost_zero_policy') #>> '{}', 'IGNORE'),
    'override_permission', coalesce(private.erp_setting(p_company, 'product.purchase_cost_override_permission') #>> '{}', 'purchase_exception.approve'),
    'trigger', 'GRN_POSTING',
    'history', true);
$$;
revoke all on function private.purchase_cost_settings(uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 3. Core
-- -----------------------------------------------------------------------------
create or replace function private.purchase_cost_lock(p_company uuid, p_product uuid)
returns void
language sql
set search_path = ''
as $$
  select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('purchase_cost:' || p_company::text || ':' || p_product::text, 0));
$$;
revoke all on function private.purchase_cost_lock(uuid, uuid) from public, anon, authenticated;

-- The event that sets the Last Purchase Cost: latest eligible receipt / override that is not reversed
-- (by receipt date, then posting time), optionally ignoring one event (the one being reversed).
create or replace function private.purchase_cost_source(p_company uuid, p_product uuid, p_exclude uuid default null)
returns public.product_purchase_cost_events
language sql
stable
security definer
set search_path = ''
as $$
  select e.* from public.product_purchase_cost_events e
  where e.company_id = p_company and e.product_id = p_product and e.eligible
    and e.event_type in ('GRN_RECEIPT', 'MANUAL_OVERRIDE')
    and e.id is distinct from p_exclude
    and not exists (select 1 from public.product_purchase_cost_events r where r.reversal_of_event_id = e.id)
  order by e.effective_date desc, e.posted_at desc, e.created_at desc
  limit 1;
$$;
revoke all on function private.purchase_cost_source(uuid, uuid, uuid) from public, anon, authenticated;

-- Writes the current-cost row from an applied event (source = the event whose cost now applies).
create or replace function private.purchase_cost_set_current(p_event public.product_purchase_cost_events, p_source public.product_purchase_cost_events)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.product_last_purchase_costs as c (company_id, product_id, last_purchase_cost, last_purchase_date, previous_cost, difference_amount,
    difference_percentage, change_type, supplier_id, supplier_name, source_event_id, last_event_id, updated_at)
  values (p_event.company_id, p_event.product_id, p_event.new_cost, p_source.effective_date, p_event.previous_cost, p_event.difference_amount,
    p_event.difference_percentage, p_event.change_type, p_source.supplier_id, p_source.supplier_name, p_source.id, p_event.id, now())
  on conflict (company_id, product_id) do update set
    last_purchase_cost = excluded.last_purchase_cost, last_purchase_date = excluded.last_purchase_date, previous_cost = excluded.previous_cost,
    difference_amount = excluded.difference_amount, difference_percentage = excluded.difference_percentage, change_type = excluded.change_type,
    supplier_id = excluded.supplier_id, supplier_name = excluded.supplier_name, source_event_id = excluded.source_event_id,
    last_event_id = excluded.last_event_id, updated_at = now();
$$;
revoke all on function private.purchase_cost_set_current(public.product_purchase_cost_events, public.product_purchase_cost_events) from public, anon, authenticated;

-- Increase / decrease notification to purchasing approvers and Super Admins (one per user and event).
create or replace function private.purchase_cost_notify(p_e public.product_purchase_cost_events)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_set   jsonb := private.purchase_cost_settings(p_e.company_id);
  v_p     public.products;
  v_title text;
  v_msg   text;
  v_sev   text;
  v_dedup text := 'purchase_cost:' || p_e.id;
  v_link  text := '/products/' || p_e.product_id || '?tab=purchase-cost';
begin
  if p_e.status <> 'APPLIED' or p_e.change_type not in ('INCREASE', 'DECREASE') then return; end if;
  if p_e.change_type = 'INCREASE' and not (v_set ->> 'increase_alerts')::boolean then return; end if;
  if p_e.change_type = 'DECREASE' and not (v_set ->> 'decrease_alerts')::boolean then return; end if;
  select * into v_p from public.products where id = p_e.product_id;
  v_title := case when p_e.change_type = 'INCREASE' then 'Purchase Cost Increased' else 'Purchase Cost Decreased' end;
  v_msg := format(E'Purchase cost %s for %s (%s).\nPrevious: ₹%s\nNew: ₹%s\n%s: ₹%s (%s%%)\nSupplier: %s\nGRN: %s',
    case when p_e.change_type = 'INCREASE' then 'increased' else 'decreased' end, v_p.product_name, v_p.sku,
    trim_scale(p_e.previous_cost), trim_scale(p_e.new_cost), case when p_e.change_type = 'INCREASE' then 'Increase' else 'Decrease' end,
    trim_scale(abs(p_e.difference_amount)), coalesce(abs(p_e.difference_percentage)::text, '—'),
    coalesce(p_e.supplier_name, 'not recorded'), coalesce(p_e.receipt_number, '—'));
  v_sev := case when p_e.significant then 'HIGH' else 'MEDIUM' end;
  perform private.notify_permission(p_e.company_id, 'purchase_order.approve', 'PURCHASE_COST_CHANGE', v_title, v_msg, v_sev, 'PRODUCT',
    p_e.product_id::text, v_link, v_dedup);
  perform private.notify_super_admins(p_e.company_id, 'PURCHASE_COST_CHANGE', v_title, v_msg, v_sev, 'PRODUCT', p_e.product_id::text, v_link, v_dedup);
end;
$$;
revoke all on function private.purchase_cost_notify(public.product_purchase_cost_events) from public, anon, authenticated;

-- Records the cost of one posted receipt: one event per product with the quantity-weighted accepted unit cost.
-- Products in id order (one lock order for every receipt). Idempotent per receipt and product.
create or replace function private.purchase_cost_process_receipt(p_receipt uuid)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_r       public.goods_receipts;
  v_po      public.purchase_orders;
  v_set     jsonb;
  v_g       record;
  v_key     text;
  v_cur     public.product_last_purchase_costs;
  v_src     public.product_purchase_cost_events;
  v_cost    numeric;
  v_elig    boolean;
  v_newer   boolean;
  v_reason  text;
  v_status  text;
  v_sig     boolean;
  v_e       public.product_purchase_cost_events;
  v_n       int := 0;
begin
  select * into v_r from public.goods_receipts where id = p_receipt;
  if not found or v_r.status <> 'POSTED' then return 0; end if;
  if v_r.purchase_order_id is not null then
    select * into v_po from public.purchase_orders where id = v_r.purchase_order_id;
  end if;
  v_set := private.purchase_cost_settings(v_r.company_id);

  for v_g in
    select l.product_id, min(l.unit) as unit,
      sum(l.accepted_quantity) as accepted, sum(l.rejected_quantity) as rejected,
      bool_or(l.unit_cost is null) as missing_cost,
      round(sum(l.accepted_quantity * l.unit_cost) / nullif(sum(l.accepted_quantity), 0), 4) as weighted,
      array_agg(l.id order by l.created_at, l.id) as line_ids,
      case when count(*) = 1 then min(l.purchase_order_line_id::text)::uuid end as po_line,
      jsonb_agg(jsonb_build_object('goods_receipt_line_id', l.id, 'purchase_order_line_id', l.purchase_order_line_id,
        'accepted_quantity', l.accepted_quantity, 'rejected_quantity', l.rejected_quantity, 'unit_cost', l.unit_cost,
        'po_unit_price', pl.unit_price, 'po_discount_percent', pl.discount_percent, 'po_discount_amount', pl.discount_amount,
        'po_ordered_quantity', pl.ordered_quantity, 'po_taxable_value', pl.taxable_value, 'gst_rate', coalesce(pl.gst_rate, l.gst_rate))
        order by l.created_at, l.id) as lines
    from public.goods_receipt_lines l
    left join public.purchase_order_lines pl on pl.id = l.purchase_order_line_id
    where l.goods_receipt_id = v_r.id and l.line_type = 'GOODS' and l.product_id is not null and l.accepted_quantity > 0
    group by l.product_id
    order by l.product_id
  loop
    v_key := 'GRN:' || v_r.id || ':' || v_g.product_id;
    continue when exists (select 1 from public.product_purchase_cost_events where company_id = v_r.company_id and idempotency_key = v_key);
    perform private.purchase_cost_lock(v_r.company_id, v_g.product_id);
    continue when exists (select 1 from public.product_purchase_cost_events where company_id = v_r.company_id and idempotency_key = v_key);

    v_cur := null;
    select * into v_cur from public.product_last_purchase_costs where company_id = v_r.company_id and product_id = v_g.product_id;
    v_src := private.purchase_cost_source(v_r.company_id, v_g.product_id);
    v_cost := case when v_g.missing_cost then null else v_g.weighted end;
    v_reason := null;
    v_elig := true;
    if not (v_set ->> 'auto_update')::boolean then
      v_elig := false; v_reason := 'Automatic cost updates are disabled (ERP Settings)';
    elsif v_cost is null then
      v_elig := false; v_reason := 'The receipt line has no unit cost';
    elsif v_cost = 0 and (v_set ->> 'zero_policy') = 'IGNORE' then
      v_elig := false; v_reason := 'Zero-cost receipt: ignored by the zero-cost policy';
    elsif v_cost = 0 and (v_set ->> 'zero_policy') = 'INITIAL_ONLY' and v_cur.last_purchase_cost is not null then
      v_elig := false; v_reason := 'Zero-cost receipt: the product already has a cost (zero-cost policy)';
    end if;
    -- A receipt dated before the current cost never overwrites it.
    v_newer := v_src.id is null or (v_r.receipt_date, v_r.created_at) >= (v_src.effective_date, v_src.posted_at);
    if v_elig and not v_newer then
      v_reason := format('Dated before the current cost (%s); kept in the history only', v_src.effective_date);
    end if;
    v_status := case when v_elig and v_newer then 'APPLIED' else 'NOT_APPLIED' end;
    v_sig := v_cur.last_purchase_cost > 0 and v_cost is not null
             and abs(v_cost - v_cur.last_purchase_cost) / v_cur.last_purchase_cost * 100 >= (v_set ->> 'alert_percent')::numeric
             and v_cost <> v_cur.last_purchase_cost;

    insert into public.product_purchase_cost_events (company_id, product_id, event_type, status, not_applied_reason, eligible, previous_cost, new_cost,
      significant, received_quantity, rejected_quantity, unit, currency, cost_basis, supplier_id, supplier_name, purchase_order_id, po_number,
      purchase_order_line_id, goods_receipt_id, receipt_number, goods_receipt_line_ids, effective_date, posted_at, reason, idempotency_key, created_by)
    values (v_r.company_id, v_g.product_id, 'GRN_RECEIPT', v_status, v_reason, v_elig, v_cur.last_purchase_cost, v_cost,
      coalesce(v_sig, false), v_g.accepted, v_g.rejected, v_g.unit, coalesce(v_po.currency_code, 'INR'),
      jsonb_build_object(
        'method', case when v_r.purchase_order_id is null then 'DIRECT_RECEIPT_UNIT_COST' else 'PO_LINE_TAXABLE_VALUE_PER_UNIT' end,
        'formula', case when v_r.purchase_order_id is null then 'unit cost entered on the receipt (default: Standard Purchase Cost)'
                        else 'round((quantity x unit price - line discount) / quantity, 4)' end,
        'gst', 'excluded', 'other_charges', 'excluded (separate charge lines)', 'round_off', 'excluded',
        'currency', coalesce(v_po.currency_code, 'INR'), 'unit_conversion', 'none (base unit)',
        'weighting', 'accepted quantity', 'rejected_quantity_excluded', true, 'lines', v_g.lines),
      v_r.supplier_id, coalesce(v_po.supplier_name, (select coalesce(s.display_name, s.legal_name) from public.suppliers s where s.id = v_r.supplier_id)),
      v_r.purchase_order_id, v_po.po_number, v_g.po_line, v_r.id, v_r.receipt_number, v_g.line_ids, v_r.receipt_date, v_r.created_at,
      left(case when v_r.purchase_order_id is null then 'Direct goods receipt ' || v_r.receipt_number
                else 'Goods receipt ' || v_r.receipt_number || ' against ' || v_po.po_number end
           || case when cardinality(v_g.line_ids) > 1 then format(' (%s lines, weighted by accepted quantity)', cardinality(v_g.line_ids)) else '' end
           || case when v_g.rejected > 0 then format(' — %s rejected, excluded', trim_scale(v_g.rejected)) else '' end, 500),
      v_key, auth.uid())
    returning * into v_e;

    if v_status = 'APPLIED' then
      perform private.purchase_cost_set_current(v_e, v_e);
    end if;
    insert into public.audit_logs (company_id, actor_user_id, action, resource_type, resource_id, request_id, metadata)
    values (v_r.company_id, auth.uid(), case when v_status = 'APPLIED' then 'products.purchase_cost_updated' else 'products.purchase_cost_recorded' end,
      'product', v_g.product_id::text, nullif(current_setting('app.request_id', true), ''),
      jsonb_build_object('event_id', v_e.id, 'receipt_number', v_r.receipt_number, 'po_number', v_po.po_number, 'previous_cost', v_e.previous_cost,
        'new_cost', v_e.new_cost, 'change_type', v_e.change_type, 'difference', v_e.difference_amount, 'percentage', v_e.difference_percentage,
        'status', v_status, 'reason', v_reason));
    perform private.purchase_cost_notify(v_e);
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;
revoke all on function private.purchase_cost_process_receipt(uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 4. Triggers
-- -----------------------------------------------------------------------------
-- Deferred to the end of the posting transaction, so every line of the receipt exists (weighted cost per product),
-- and still inside it (a failure rolls back the receipt, stock, cost, history and audit together).
create or replace function private.purchase_cost_on_receipt_line()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.line_type = 'GOODS' and new.product_id is not null and new.accepted_quantity > 0 then
    perform private.purchase_cost_process_receipt(new.goods_receipt_id);
  end if;
  return null;
end;
$$;
revoke all on function private.purchase_cost_on_receipt_line() from public, anon, authenticated;

drop trigger if exists goods_receipt_lines_purchase_cost on public.goods_receipt_lines;
create constraint trigger goods_receipt_lines_purchase_cost after insert on public.goods_receipt_lines
  deferrable initially deferred
  for each row execute function private.purchase_cost_on_receipt_line();

-- A reversed receipt: one reversal event per cost event of the receipt; the Last Purchase Cost is recalculated from the
-- latest remaining valid receipt (or cleared when none is left). The original events are never changed.
create or replace function private.purchase_cost_on_receipt_reversal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_e    public.product_purchase_cost_events;
  v_cur  public.product_last_purchase_costs;
  v_src  public.product_purchase_cost_events;
  v_new  public.product_purchase_cost_events;
  v_key  text;
  v_was  boolean;
begin
  if not (old.status = 'POSTED' and new.status = 'REVERSED') then return null; end if;
  for v_e in select * from public.product_purchase_cost_events
             where goods_receipt_id = new.id and event_type = 'GRN_RECEIPT' order by product_id loop
    v_key := 'GRN_REVERSAL:' || v_e.id;
    continue when exists (select 1 from public.product_purchase_cost_events where company_id = v_e.company_id and idempotency_key = v_key);
    perform private.purchase_cost_lock(v_e.company_id, v_e.product_id);
    continue when exists (select 1 from public.product_purchase_cost_events where company_id = v_e.company_id and idempotency_key = v_key);
    v_cur := null;
    select * into v_cur from public.product_last_purchase_costs where company_id = v_e.company_id and product_id = v_e.product_id;
    v_was := v_cur.source_event_id is not distinct from v_e.id;
    v_src := private.purchase_cost_source(v_e.company_id, v_e.product_id, v_e.id);
    insert into public.product_purchase_cost_events (company_id, product_id, event_type, status, not_applied_reason, eligible, previous_cost, new_cost,
      received_quantity, rejected_quantity, unit, currency, cost_basis, supplier_id, supplier_name, purchase_order_id, po_number, purchase_order_line_id,
      goods_receipt_id, receipt_number, goods_receipt_line_ids, effective_date, posted_at, reversal_of_event_id, reason, idempotency_key, created_by)
    values (v_e.company_id, v_e.product_id, 'GRN_REVERSAL', case when v_was then 'APPLIED' else 'NOT_APPLIED' end,
      case when v_was then null when v_e.status = 'APPLIED' then 'A later receipt sets the current cost, so it is unchanged'
           else 'The reversed receipt never set the cost' end,
      false, v_cur.last_purchase_cost, case when v_was then v_src.new_cost else v_cur.last_purchase_cost end,
      -v_e.received_quantity, v_e.rejected_quantity, v_e.unit, v_e.currency,
      jsonb_build_object('method', 'RECALCULATED_FROM_LATEST_VALID_RECEIPT', 'reversed_event_id', v_e.id,
        'restored_from_event_id', case when v_was then v_src.id end, 'restored_from_receipt', case when v_was then v_src.receipt_number end),
      v_e.supplier_id, v_e.supplier_name, v_e.purchase_order_id, v_e.po_number, v_e.purchase_order_line_id, v_e.goods_receipt_id, v_e.receipt_number,
      v_e.goods_receipt_line_ids, private.company_today(v_e.company_id), now(), v_e.id,
      left('Receipt ' || new.receipt_number || ' reversed' || coalesce(': ' || new.reversal_reason, '')
        || case when not v_was then '' when v_src.id is null then ' — no valid receipt remains, Last Purchase Cost cleared'
                else ' — cost recalculated from ' || coalesce(v_src.receipt_number, 'a manual override') end, 500),
      v_key, auth.uid())
    returning * into v_new;
    if v_was then
      perform private.purchase_cost_set_current(v_new, v_src);
    end if;
    insert into public.audit_logs (company_id, actor_user_id, action, resource_type, resource_id, request_id, metadata)
    values (v_e.company_id, auth.uid(), 'products.purchase_cost_reversed', 'product', v_e.product_id::text, nullif(current_setting('app.request_id', true), ''),
      jsonb_build_object('event_id', v_new.id, 'reversed_event_id', v_e.id, 'receipt_number', new.receipt_number, 'previous_cost', v_new.previous_cost,
        'new_cost', v_new.new_cost, 'recalculated', v_was));
  end loop;
  return null;
end;
$$;
revoke all on function private.purchase_cost_on_receipt_reversal() from public, anon, authenticated;

drop trigger if exists goods_receipts_purchase_cost_reversal on public.goods_receipts;
create trigger goods_receipts_purchase_cost_reversal after update of status on public.goods_receipts
  for each row execute function private.purchase_cost_on_receipt_reversal();

-- -----------------------------------------------------------------------------
-- 5. Read and override
-- -----------------------------------------------------------------------------
-- Last Purchase Cost of each product (Product Master, PO lines); with p_supplier, that supplier's latest valid price too.
create or replace function public.product_purchase_costs(p_ids uuid[], p_supplier uuid default null)
returns table (product_id uuid, last_cost numeric, last_date date, previous_cost numeric, difference numeric, change_percent numeric,
               change_type text, supplier_name text, supplier_last_cost numeric, supplier_last_date date, threshold numeric)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('products.read');
  v_thr     numeric := (private.purchase_cost_settings(v_company) ->> 'alert_percent')::numeric;
begin
  if coalesce(cardinality(p_ids), 0) > 2000 then
    raise exception 'Ask for at most 2000 products at a time.' using errcode = 'P0001';
  end if;
  return query
  select p.id, c.last_purchase_cost, c.last_purchase_date, c.previous_cost, c.difference_amount, c.difference_percentage, c.change_type,
    c.supplier_name, s.new_cost, s.effective_date, v_thr
  from public.products p
  left join public.product_last_purchase_costs c on c.company_id = v_company and c.product_id = p.id
  left join lateral (
    select e.new_cost, e.effective_date from public.product_purchase_cost_events e
    where p_supplier is not null and e.company_id = v_company and e.product_id = p.id and e.supplier_id = p_supplier
      and e.event_type = 'GRN_RECEIPT' and e.new_cost is not null
      and not exists (select 1 from public.product_purchase_cost_events r where r.reversal_of_event_id = e.id)
    order by e.effective_date desc, e.posted_at desc limit 1) s on true
  where p.company_id = v_company and p.id = any(p_ids) and (c.product_id is not null or s.new_cost is not null);
end;
$$;

-- Purchase Cost History of one product: current cost, the other cost types (unchanged), every event newest first.
create or replace function public.product_purchase_cost_history(p_product_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('products.read');
  v_p       public.products;
  v_c       public.product_last_purchase_costs;
  v_set     jsonb;
begin
  select * into v_p from public.products where id = p_product_id and company_id = v_company;
  if not found then
    raise exception 'Product not found in your company.' using errcode = 'P0001';
  end if;
  select * into v_c from public.product_last_purchase_costs where company_id = v_company and product_id = v_p.id;
  v_set := private.purchase_cost_settings(v_company);
  return jsonb_build_object(
    'product', jsonb_build_object('id', v_p.id, 'sku', v_p.sku, 'product_name', v_p.product_name, 'base_unit', v_p.base_unit,
      'standard_cost', v_p.standard_cost, 'standard_manufacturing_cost', v_p.standard_manufacturing_cost, 'mrp', v_p.mrp, 'selling_price', v_p.selling_price),
    'current', case when v_c.product_id is null then null else jsonb_build_object('cost', v_c.last_purchase_cost, 'date', v_c.last_purchase_date,
      'previous_cost', v_c.previous_cost, 'difference', v_c.difference_amount, 'change_percent', v_c.difference_percentage, 'change_type', v_c.change_type,
      'supplier_name', v_c.supplier_name, 'source_event_id', v_c.source_event_id) end,
    -- Same valuation rule as the stock reports (lot-level weighted average of costed inflows over the stock on hand); shown, never changed.
    'average_inventory_cost', (
      select case when count(*) filter (where x.cost is null) = 0 and sum(x.on_hand) > 0 then round(sum(x.on_hand * x.cost) / sum(x.on_hand), 4) end
      from (select b.on_hand, private.lot_average_cost(b.batch_id) as cost from public.inventory_balances b
            where b.company_id = v_company and b.product_id = v_p.id and b.on_hand > 0) x),
    'settings', v_set,
    'can_override', private.has_permission(v_company, v_set ->> 'override_permission'),
    'events', coalesce((select jsonb_agg(jsonb_build_object(
        'id', e.id, 'event_type', e.event_type, 'status', e.status, 'not_applied_reason', e.not_applied_reason, 'previous_cost', e.previous_cost,
        'new_cost', e.new_cost, 'difference', e.difference_amount, 'change_percent', e.difference_percentage, 'change_type', e.change_type,
        'significant', e.significant, 'received_quantity', e.received_quantity, 'rejected_quantity', e.rejected_quantity, 'unit', e.unit,
        'currency', e.currency, 'cost_basis', e.cost_basis, 'supplier_id', e.supplier_id, 'supplier_name', e.supplier_name,
        'purchase_order_id', e.purchase_order_id, 'po_number', e.po_number, 'goods_receipt_id', e.goods_receipt_id, 'receipt_number', e.receipt_number,
        'effective_date', e.effective_date, 'posted_at', e.posted_at, 'reason', e.reason, 'created_at', e.created_at,
        'reversed', exists (select 1 from public.product_purchase_cost_events r where r.reversal_of_event_id = e.id),
        'created_by_name', (select coalesce(pr.full_name, pr.email) from public.profiles pr where pr.id = e.created_by))
        order by e.created_at desc)
      from public.product_purchase_cost_events e where e.company_id = v_company and e.product_id = v_p.id), '[]'::jsonb));
end;
$$;

-- Exceptional manual override of the Last Purchase Cost (permission chosen in ERP Settings). Recorded and audited;
-- a later posted receipt replaces it as usual.
create or replace function public.product_purchase_cost_override(p_product_id uuid, p_cost numeric, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('products.read');
  v_perm    text := private.purchase_cost_settings(v_company) ->> 'override_permission';
  v_reason  text := btrim(coalesce(p_reason, ''));
  v_cur     public.product_last_purchase_costs;
  v_e       public.product_purchase_cost_events;
begin
  if auth.uid() is null or not private.has_permission(v_company, v_perm) then
    raise exception 'Overriding the purchase cost needs the % permission (ERP Settings → Products).', v_perm using errcode = '42501';
  end if;
  if p_cost is null or p_cost < 0 or p_cost <> round(p_cost, 4) then
    raise exception 'Enter a cost of zero or more (up to 4 decimals).' using errcode = 'P0001';
  end if;
  if length(v_reason) < 5 then
    raise exception 'Enter the reason for the override (at least 5 characters).' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.products where id = p_product_id and company_id = v_company) then
    raise exception 'Product not found in your company.' using errcode = 'P0001';
  end if;
  perform private.purchase_cost_lock(v_company, p_product_id);
  select * into v_cur from public.product_last_purchase_costs where company_id = v_company and product_id = p_product_id;
  insert into public.product_purchase_cost_events (company_id, product_id, event_type, status, eligible, previous_cost, new_cost, currency, cost_basis,
    effective_date, posted_at, reason, idempotency_key, created_by)
  values (v_company, p_product_id, 'MANUAL_OVERRIDE', 'APPLIED', true, v_cur.last_purchase_cost, round(p_cost, 4), 'INR',
    jsonb_build_object('method', 'MANUAL_OVERRIDE', 'permission', v_perm), private.company_today(v_company), now(),
    left('Manual override: ' || v_reason, 500), 'OVERRIDE:' || gen_random_uuid(), auth.uid())
  returning * into v_e;
  perform private.purchase_cost_set_current(v_e, v_e);
  insert into public.audit_logs (company_id, actor_user_id, action, resource_type, resource_id, request_id, metadata)
  values (v_company, auth.uid(), 'products.purchase_cost_overridden', 'product', p_product_id::text, nullif(current_setting('app.request_id', true), ''),
    jsonb_build_object('event_id', v_e.id, 'previous_cost', v_e.previous_cost, 'new_cost', v_e.new_cost, 'reason', v_reason));
  return jsonb_build_object('event_id', v_e.id, 'cost', v_e.new_cost);
end;
$$;

revoke all on function public.product_purchase_costs(uuid[], uuid) from public, anon;
revoke all on function public.product_purchase_cost_history(uuid) from public, anon;
revoke all on function public.product_purchase_cost_override(uuid, numeric, text) from public, anon;
grant execute on function public.product_purchase_costs(uuid[], uuid) to authenticated;
grant execute on function public.product_purchase_cost_history(uuid) to authenticated;
grant execute on function public.product_purchase_cost_override(uuid, numeric, text) to authenticated;

-- -----------------------------------------------------------------------------
-- 6. ERP reset: the purchase cost history and current costs are deleted with the purchase documents
--    (same list as 20261118090000_master_versioning.sql plus the two purchase cost tables).
-- -----------------------------------------------------------------------------
create or replace function private.erp_reset_tables()
returns table (ord int, table_name text, category text, label text)
language sql
stable
set search_path = ''
as $$
  select * from (values
    (0, 'amazon_ad_change_requests', 'Amazon', 'Amazon ad change requests'),
    (0, 'amazon_ad_groups', 'Amazon', 'Amazon ad groups'),
    (0, 'amazon_ad_product_daily', 'Amazon', 'Amazon advertised-product daily data'),
    (0, 'amazon_budget_plans', 'Amazon', 'Amazon budget plans'),
    (0, 'amazon_campaign_daily', 'Amazon', 'Amazon campaign daily data'),
    (0, 'amazon_campaigns', 'Amazon', 'Amazon campaigns'),
    (0, 'amazon_inventory_snapshots', 'Amazon', 'Amazon inventory snapshots'),
    (0, 'amazon_listings', 'Amazon', 'Amazon listings'),
    (0, 'amazon_search_term_daily', 'Amazon', 'Amazon search-term daily data'),
    (0, 'amazon_sku_daily', 'Amazon', 'Amazon SKU daily sales'),
    (0, 'amazon_sync_errors', 'Amazon', 'Amazon sync errors'),
    (0, 'amazon_targets', 'Amazon', 'Amazon targets'),
    (0, 'approval_decisions', 'Approvals, notifications & imports', 'Approval decisions'),
    (0, 'billing_events', 'Billing & receivables', 'Billing history'),
    (0, 'bom_items', 'Production & BOMs', 'BOM components'),
    (0, 'customer_po_allocation_runs', 'Customer purchase orders', 'Customer PO allocation runs'),
    (0, 'customer_po_analysis_snapshots', 'Customer purchase orders', 'Customer PO analysis snapshots'),
    (0, 'customer_po_events', 'Customer purchase orders', 'Customer PO history'),
    (0, 'customer_po_shortage_notes', 'Customer purchase orders', 'Customer PO shortage notes'),
    (0, 'customer_product_codes', 'Customers & suppliers', 'Customer product codes'),
    (0, 'customer_return_lines', 'Sales & fulfilment', 'Customer return lines'),
    (0, 'delivery_events', 'Sales & fulfilment', 'Delivery history'),
    (0, 'erp_form_drafts', 'Approvals, notifications & imports', 'Unsaved form drafts'),
    (0, 'goods_receipt_lines', 'Supplier purchasing', 'Goods receipt lines'),
    (0, 'import_job_rows', 'Approvals, notifications & imports', 'Import rows'),
    (0, 'inventory_adjustments', 'Inventory', 'Stock adjustments'),
    (0, 'inventory_alerts', 'Inventory', 'Stock alerts'),
    (0, 'inventory_balances', 'Inventory', 'Stock balances'),
    (0, 'inventory_count_lines', 'Inventory', 'Stock count lines'),
    (0, 'inventory_opening_lines', 'Inventory', 'Opening stock lines'),
    (0, 'inventory_requests', 'Inventory', 'Stock operation requests'),
    (0, 'invoice_adjustment_note_lines', 'Billing & receivables', 'Credit / debit note lines'),
    (0, 'invoice_payment_allocations', 'Billing & receivables', 'Payment allocations'),
    (0, 'notifications', 'Approvals, notifications & imports', 'Notifications'),
    (0, 'outsourcing_material_movements', 'Outsourcing', 'Outsourcing material movements'),
    (0, 'outsourcing_order_events', 'Outsourcing', 'Outsourcing history'),
    (0, 'product_last_purchase_costs', 'Supplier purchasing', 'Last purchase costs'),
    (0, 'product_purchase_cost_events', 'Supplier purchasing', 'Purchase cost history'),
    (0, 'production_material_consumption', 'Production & BOMs', 'Material issues'),
    (0, 'production_order_events', 'Production & BOMs', 'Production history'),
    (0, 'production_order_requests', 'Production & BOMs', 'Production order request ids'),
    (0, 'production_output_receipts', 'Production & BOMs', 'Production output'),
    (0, 'purchase_document_refs', 'Supplier purchasing', 'Supplier invoice / challan references'),
    (0, 'purchase_order_amendments', 'Supplier purchasing', 'Purchase order amendments'),
    (0, 'purchase_order_events', 'Supplier purchasing', 'Purchase order history'),
    (0, 'purchase_order_import_refs', 'Supplier purchasing', 'Purchase order import references'),
    (0, 'sales_invoice_dispatch_allocations', 'Billing & receivables', 'Invoice dispatch allocations'),
    (0, 'sales_order_events', 'Sales & fulfilment', 'Sales order history'),
    (1, 'amazon_recommendations', 'Amazon', 'Amazon recommendations'),
    (1, 'amazon_sync_jobs', 'Amazon', 'Amazon sync jobs'),
    (1, 'approval_requests', 'Approvals, notifications & imports', 'Approval requests'),
    (1, 'customer_payments', 'Billing & receivables', 'Customer payments'),
    (1, 'supplier_payments', 'Customers & suppliers', 'Supplier payments'),
    (1, 'goods_receipts', 'Supplier purchasing', 'Goods receipts'),
    (1, 'import_jobs', 'Approvals, notifications & imports', 'Import jobs'),
    (1, 'inventory_counts', 'Inventory', 'Stock counts'),
    (1, 'inventory_opening_batches', 'Inventory', 'Opening stock documents'),
    (1, 'invoice_adjustment_notes', 'Billing & receivables', 'Credit / debit notes'),
    (1, 'outsourcing_order_materials', 'Outsourcing', 'Outsourcing material plans'),
    (1, 'outsourcing_receipts', 'Outsourcing', 'Outsourcing receipts'),
    (1, 'production_order_materials', 'Production & BOMs', 'Production material plans'),
    (1, 'purchase_order_lines', 'Supplier purchasing', 'Purchase order lines'),
    (1, 'sales_invoice_lines', 'Billing & receivables', 'Invoice lines'),
    (2, 'customer_returns', 'Sales & fulfilment', 'Customer returns'),
    (2, 'parties', 'Customers & suppliers', 'Ledger parties'),
    (2, 'fulfilment_lines', 'Sales & fulfilment', 'Fulfilment lines'),
    (2, 'outsourcing_orders', 'Outsourcing', 'Outsourcing orders'),
    (2, 'production_orders', 'Production & BOMs', 'Production orders'),
    (2, 'purchase_orders', 'Supplier purchasing', 'Supplier purchase orders'),
    (2, 'sales_invoices', 'Billing & receivables', 'Sales invoices'),
    (3, 'boms', 'Production & BOMs', 'Bills of materials'),
    (3, 'fulfilments', 'Sales & fulfilment', 'Fulfilments and dispatches'),
    (3, 'inventory_transactions', 'Inventory', 'Stock ledger'),
    (3, 'production_order_revisions', 'Production & BOMs', 'Production order revisions'),
    (3, 'sales_order_lines', 'Sales & fulfilment', 'Sales order lines'),
    (3, 'stock_reservations', 'Inventory', 'Stock reservations'),
    (3, 'suppliers', 'Customers & suppliers', 'Suppliers'),
    (4, 'customer_purchase_order_lines', 'Customer purchase orders', 'Customer PO lines'),
    (4, 'inventory_batches', 'Inventory', 'Stock batches / lots'),
    (4, 'sales_orders', 'Sales & fulfilment', 'Sales orders'),
    (5, 'customer_purchase_orders', 'Customer purchase orders', 'Customer purchase orders'),
    (6, 'customer_po_import_batches', 'Customer purchase orders', 'Customer PO import batches'),
    (6, 'customers', 'Customers & suppliers', 'Customers')
  ) t (ord, table_name, category, label)
  union all
  select 0, 'demo_presentation_data', 'Demo data', 'Demo presentation data'
  where exists (select 1 from pg_catalog.pg_attribute a
                where a.attrelid = to_regclass('public.demo_presentation_data') and a.attname = 'company_id' and not a.attisdropped);
$$;
revoke all on function private.erp_reset_tables() from public, anon, authenticated;

notify pgrst, 'reload schema';
