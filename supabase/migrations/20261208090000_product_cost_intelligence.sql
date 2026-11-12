-- =============================================================================
-- Unified Product Cost Intelligence and BOM cost
--
-- Inspected before writing (reused, not replaced):
--   * Sourcing method = the existing products.default_source_type
--       IN_HOUSE = Manufacture, OUTSOURCED = Purchase, HYBRID = Both (Make & Buy).
--     No new column, no value of an existing product is changed by this migration.
--   * Purchase cost = Purchase Cost Intelligence (20261123090000): product_last_purchase_costs
--     is kept from posted GRNs only (deferred trigger at the end of the posting), GST excluded,
--     PO line discount applied, rejected quantity excluded, reversed / corrected receipts removed,
--     the authorised manual override kept with its own rules. It is not changed here.
--   * BOM cost formula = the one the BOM pages use (src/features/production/bom-tools-model.ts
--     bomCost): per line round(quantity x (1 + wastage% / 100) x component cost / output, 4),
--     per unit = round(sum, 2); component cost = Product Master Cost; a line without a cost makes
--     the BOM cost incomplete (never counted as zero).
--   * Active BOM = private.production_v2_active_bom: status APPROVED, effective today. Draft,
--     pending, rejected and archived versions are never costed into the Product Master.
--   * Stock receipts keep their own cost and are not touched: a GRN lot is valued at the actual
--     GRN cost, a production receipt at the actual cost of the materials issued
--     (production_order_v2_complete). Product Master Cost is never written into a posted
--     transaction, lot or ledger entry.
--
-- New:
--   * bom_cost_snapshots      cost of each approved BOM version (per unit, lines, missing costs,
--                             calculation time)
--   * product_cost_profiles   per product: BOM Manufacturing Cost, the current Product Master Cost
--                             with its source (BOM / GRN / MANUAL) and reference, the default
--                             cost source for Both products, the cost status
--   * product_cost_history    append-only: previous / new cost, source, BOM version or GRN, event,
--                             reason, user, time. A row only when the cost or its source changes,
--                             so repeated recalculation adds nothing.
--   * private.product_cost_refresh: the one place the rules are applied:
--       Manufacture -> active approved BOM cost; Purchase -> latest valid purchase cost;
--       Both -> the product's default cost source (BOM or GRN), never an average or "latest wins".
--       No valid cost (none, incomplete BOM, zero) -> the current cost is kept, status shows why.
--     After a change the BOMs that use the product as a component are recalculated, up the
--     BOM tree (depth limit 25; circular BOMs are already refused by bom_creates_cycle).
--   * Triggers (same transaction as the event): BOM status change to / from APPROVED;
--     product_last_purchase_costs written (GRN posted, reversed, corrected, purchase override);
--     products.default_source_type / standard cost changed.
--   * product_master_list re-created: master_cost = the stored current cost when there is one,
--     otherwise exactly the earlier rule (20261128090000), so nothing changes at deployment.
--     New columns: bom_manufacturing_cost, cost status, default cost source, cost updated.
--   * bom_cost_list view (BOM list: BOM Cost / Unit, Product Master Cost, Cost Difference,
--     Cost Updated); RPCs product_cost_recalculate, product_cost_set_default_source,
--     product_sourcing_proposals, product_sourcing_apply.
--
-- Nothing is backfilled: costs are stored when an event happens or when an authorised user runs
-- Recalculate (products.update).
--
-- Rollback: supabase/rollback/20261208090000_product_cost_intelligence_down.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Tables
-- -----------------------------------------------------------------------------
create table if not exists public.bom_cost_snapshots (
  bom_id              uuid primary key,
  company_id          uuid not null references public.companies (id) on delete restrict,
  finished_product_id uuid not null,
  bom_version         integer not null,
  output_quantity     numeric(14,3) not null,
  unit_cost           numeric(16,4) check (unit_cost is null or unit_cost >= 0),
  known_unit_cost     numeric(16,4),
  total_cost          numeric(16,2),
  line_count          integer not null,
  missing_count       integer not null,
  status              text not null check (status in ('COMPLETE', 'MISSING_COSTS', 'NO_COMPONENTS')),
  lines               jsonb not null default '[]'::jsonb,
  event               text not null,
  calculated_at       timestamptz not null default now(),
  constraint bom_cost_snapshots_bom_fk foreign key (bom_id, company_id) references public.boms (id, company_id) on delete cascade
);
comment on table public.bom_cost_snapshots is
  'Cost of approved BOM versions (migration 20261208090000). unit_cost only when every component has a cost. Written only by private.bom_cost_store.';
create index if not exists bom_cost_snapshots_product_idx on public.bom_cost_snapshots (company_id, finished_product_id);

create table if not exists public.product_cost_profiles (
  company_id                uuid not null references public.companies (id) on delete restrict,
  product_id                uuid not null,
  bom_cost                  numeric(16,4) check (bom_cost is null or bom_cost >= 0),
  bom_id                    uuid,
  bom_code                  text,
  bom_version               integer,
  bom_cost_status           text check (bom_cost_status in ('COMPLETE', 'MISSING_COSTS', 'NO_COMPONENTS', 'NO_ACTIVE_BOM')),
  bom_cost_at               timestamptz,
  current_cost              numeric(16,4) check (current_cost is null or current_cost >= 0),
  current_source            text check (current_source in ('BOM', 'GRN', 'MANUAL')),
  current_reference         text,
  current_bom_id            uuid,
  current_goods_receipt_id  uuid,
  current_purchase_event_id uuid,
  current_updated_at        timestamptz,
  default_cost_source       text not null default 'BOM' check (default_cost_source in ('BOM', 'GRN')),
  cost_status               text not null default 'NO_NEW_COST'
                            check (cost_status in ('CURRENT', 'NO_NEW_COST', 'BOM_INCOMPLETE', 'CIRCULAR_DEPENDENCY')),
  status_note               text,
  last_master_cost          numeric(16,4),
  updated_at                timestamptz not null default now(),
  primary key (company_id, product_id),
  constraint product_cost_profiles_product_fk foreign key (product_id, company_id)
    references public.products (id, company_id) on delete cascade
);
comment on table public.product_cost_profiles is
  'Product cost sources (migration 20261208090000): BOM Manufacturing Cost, current Product Master Cost and its source. Written only by private.product_cost_refresh and the cost RPCs.';

create table if not exists public.product_cost_history (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies (id) on delete restrict,
  product_id        uuid not null,
  previous_cost     numeric(16,4),
  new_cost          numeric(16,4) not null check (new_cost >= 0),
  previous_source   text,
  new_source        text not null check (new_source in ('BOM', 'GRN', 'MANUAL')),
  event             text not null check (event in ('BOM_ACTIVATED', 'BOM_DEACTIVATED', 'GRN_POSTED', 'GRN_REVERSED', 'PURCHASE_OVERRIDE',
                      'COMPONENT_COST_CHANGED', 'DEFAULT_SOURCE_CHANGED', 'SOURCING_CHANGED', 'STANDARD_COST_CHANGED', 'RECALCULATED')),
  bom_id            uuid,
  bom_code          text,
  bom_version       integer,
  goods_receipt_id  uuid,
  receipt_number    text,
  purchase_event_id uuid,
  reason            text not null check (length(reason) between 1 and 500),
  created_by        uuid,
  created_at        timestamptz not null default clock_timestamp(),
  constraint product_cost_history_product_fk foreign key (product_id, company_id)
    references public.products (id, company_id) on delete restrict
);
comment on table public.product_cost_history is
  'Product Master Cost history (migration 20261208090000): one immutable row per change of the cost or its source.';
create index if not exists product_cost_history_product_idx on public.product_cost_history (company_id, product_id, created_at desc);

alter table public.bom_cost_snapshots enable row level security;
alter table public.product_cost_profiles enable row level security;
alter table public.product_cost_history enable row level security;
revoke all on public.bom_cost_snapshots, public.product_cost_profiles, public.product_cost_history from public, anon, authenticated;
grant select on public.bom_cost_snapshots, public.product_cost_profiles, public.product_cost_history to authenticated;
grant all on public.bom_cost_snapshots, public.product_cost_profiles, public.product_cost_history to service_role;

drop policy if exists bom_cost_snapshots_select on public.bom_cost_snapshots;
create policy bom_cost_snapshots_select on public.bom_cost_snapshots for select to authenticated
  using (company_id = private.current_company_id() and private.has_permission(company_id, 'production_bom.read'));
drop policy if exists product_cost_profiles_select on public.product_cost_profiles;
create policy product_cost_profiles_select on public.product_cost_profiles for select to authenticated
  using (company_id = private.current_company_id() and private.has_permission(company_id, 'products.read'));
drop policy if exists product_cost_history_select on public.product_cost_history;
create policy product_cost_history_select on public.product_cost_history for select to authenticated
  using (company_id = private.current_company_id() and private.has_permission(company_id, 'products.read'));

drop trigger if exists product_cost_history_append_only on public.product_cost_history;
create trigger product_cost_history_append_only before update or delete on public.product_cost_history
  for each row execute function private.prevent_history_mutation();

-- -----------------------------------------------------------------------------
-- 2. Product Master list: stored current cost first, otherwise the earlier rule unchanged
-- -----------------------------------------------------------------------------
drop view if exists public.bom_cost_list;
drop view if exists public.product_master_list;
create view public.product_master_list
with (security_invoker = true) as
select p.*,
  coalesce(pc.current_cost, r.cost, f.standard) as master_cost,
  case when pc.current_cost is not null then pc.current_source
       when r.cost is not null then 'PURCHASE'
       when f.standard is not null then 'STANDARD' end as master_cost_source,
  case when pc.current_cost is not null then case when pc.current_source = 'GRN' then pc.current_reference end else r.receipt_number end as master_cost_receipt_number,
  case when pc.current_cost is null then r.receipt_date end as master_cost_receipt_date,
  f.standard as fallback_cost,
  c.last_purchase_cost,
  c.last_purchase_date,
  c.last_purchase_cost - coalesce(pc.current_cost, r.cost, f.standard) as master_cost_change,
  case when coalesce(pc.current_cost, r.cost, f.standard) > 0 and c.last_purchase_cost is not null
       then round((c.last_purchase_cost - coalesce(pc.current_cost, r.cost, f.standard)) / coalesce(pc.current_cost, r.cost, f.standard) * 100, 2) end as master_cost_change_percent,
  pc.bom_cost as bom_manufacturing_cost,
  pc.bom_code as bom_cost_bom_code,
  pc.bom_version as bom_cost_version,
  pc.bom_cost_status,
  pc.bom_cost_at,
  pc.current_reference as master_cost_reference,
  pc.current_updated_at as cost_updated_at,
  coalesce(pc.default_cost_source, 'BOM') as default_cost_source,
  case when pc.current_cost is not null and pc.cost_status = 'CURRENT' then 'CURRENT' else coalesce(pc.cost_status, 'NO_NEW_COST') end as cost_status,
  pc.status_note as cost_status_note
from public.products p
cross join lateral (select coalesce(p.standard_manufacturing_cost, p.standard_cost) as standard) f
left join public.product_cost_profiles pc on pc.company_id = p.company_id and pc.product_id = p.id
left join public.product_last_purchase_costs c on c.company_id = p.company_id and c.product_id = p.id
left join lateral (
  select e.new_cost as cost, e.receipt_number, e.effective_date as receipt_date
  from public.product_purchase_cost_events e
  where e.company_id = p.company_id and e.product_id = p.id
    and e.event_type = 'GRN_RECEIPT' and e.eligible and e.new_cost is not null
    and not exists (select 1 from public.product_purchase_cost_events x where x.reversal_of_event_id = e.id)
  order by e.effective_date desc, e.posted_at desc, e.created_at desc
  offset 1 limit 1
) r on true;

comment on view public.product_master_list is
  'Product Master rows with Cost (stored current cost from BOM / GRN / manual override, else the rule of 20261128090000), BOM Manufacturing Cost, Last Purchase Cost and cost status (migration 20261208090000).';
revoke all on public.product_master_list from public, anon;
grant select on public.product_master_list to authenticated;

-- -----------------------------------------------------------------------------
-- 3. BOM cost (the BOM pages' formula)
-- -----------------------------------------------------------------------------
create or replace function private.bom_cost_store(p_bom uuid, p_event text)
returns public.bom_cost_snapshots
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_b     public.boms;
  v_s     public.bom_cost_snapshots;
  v_lines jsonb;
  v_count integer;
  v_miss  integer;
  v_sum   numeric;
  v_known numeric;
  v_total numeric;
begin
  select * into v_b from public.boms where id = p_bom;
  if not found then return null; end if;
  with l as (
    select bi.line_no, bi.component_product_id, m.sku, bi.quantity_required q, coalesce(bi.wastage_percentage, 0) w, m.master_cost c
    from public.bom_items bi
    left join public.product_master_list m on m.id = bi.component_product_id and m.company_id = bi.company_id
    where bi.bom_id = v_b.id
  ), x as (
    select l.*, l.q * (1 + l.w / 100) * l.c as batch, round(l.q * (1 + l.w / 100) * l.c / v_b.output_quantity, 4) as per_unit from l
  )
  select coalesce(jsonb_agg(jsonb_build_object('line_no', line_no, 'component_product_id', component_product_id, 'sku', sku,
           'quantity', q, 'wastage_percentage', w, 'unit_cost', c, 'line_cost', round(batch, 2), 'per_unit', per_unit) order by line_no), '[]'::jsonb),
         count(*)::int, count(*) filter (where c is null)::int, sum(per_unit), sum(per_unit) filter (where c is not null), sum(batch)
  into v_lines, v_count, v_miss, v_sum, v_known, v_total
  from x;

  insert into public.bom_cost_snapshots as s (bom_id, company_id, finished_product_id, bom_version, output_quantity, unit_cost, known_unit_cost,
    total_cost, line_count, missing_count, status, lines, event, calculated_at)
  values (v_b.id, v_b.company_id, v_b.finished_product_id, v_b.version, v_b.output_quantity,
    case when v_count > 0 and v_miss = 0 then round(v_sum, 2) end, round(coalesce(v_known, 0), 2),
    case when v_count > 0 and v_miss = 0 then round(v_total, 2) end, v_count, v_miss,
    case when v_count = 0 then 'NO_COMPONENTS' when v_miss > 0 then 'MISSING_COSTS' else 'COMPLETE' end, v_lines, p_event, now())
  on conflict (bom_id) do update set unit_cost = excluded.unit_cost, known_unit_cost = excluded.known_unit_cost, total_cost = excluded.total_cost,
    line_count = excluded.line_count, missing_count = excluded.missing_count, status = excluded.status, lines = excluded.lines,
    event = excluded.event, calculated_at = excluded.calculated_at, output_quantity = excluded.output_quantity
  returning * into v_s;
  return v_s;
end;
$$;
revoke all on function private.bom_cost_store(uuid, text) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 4. The cost rules
-- -----------------------------------------------------------------------------
create or replace function private.product_cost_refresh(p_company uuid, p_product uuid, p_event text, p_reason text default null, p_depth integer default 0)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_p        public.products;
  v_prof     public.product_cost_profiles;
  v_had      boolean;
  v_bom      public.boms;
  v_snap     public.bom_cost_snapshots;
  v_b        public.boms;
  v_lpc      public.product_last_purchase_costs;
  v_pev      public.product_purchase_cost_events;
  v_bom_cost numeric;
  v_pur      numeric;
  v_pref     text;
  v_cand     numeric;
  v_src      text;
  v_ref      text;
  v_c_bom    uuid;
  v_c_grn    uuid;
  v_c_pev    uuid;
  v_status   text := 'NO_NEW_COST';
  v_note     text;
  v_before   numeric;
  v_before_src text;
  v_after    numeric;
  v_changed  boolean := false;
  v_parent   uuid;
begin
  select * into v_p from public.products where id = p_product and company_id = p_company;
  if not found then return; end if;
  if p_depth > 25 then
    update public.product_cost_profiles set cost_status = 'CIRCULAR_DEPENDENCY', updated_at = now(),
      status_note = 'Cost recalculation stopped: the BOM tree is deeper than 25 levels or circular.'
    where company_id = p_company and product_id = p_product;
    return;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('product_cost:' || p_company::text || ':' || p_product::text, 0));
  select * into v_prof from public.product_cost_profiles where company_id = p_company and product_id = p_product;
  v_had := found;
  select master_cost, master_cost_source into v_before, v_before_src from public.product_master_list where id = p_product;

  -- Every approved version keeps an up-to-date cost; the one effective today is the BOM Manufacturing Cost.
  for v_b in select * from public.boms where company_id = p_company and finished_product_id = p_product and status = 'APPROVED' loop
    perform private.bom_cost_store(v_b.id, p_event);
  end loop;
  v_bom := private.production_v2_active_bom(p_company, p_product);
  if v_bom.id is not null then
    select * into v_snap from public.bom_cost_snapshots where bom_id = v_bom.id;
    if v_snap.status = 'COMPLETE' and v_snap.unit_cost > 0 then v_bom_cost := v_snap.unit_cost; end if;
  end if;

  select * into v_lpc from public.product_last_purchase_costs where company_id = p_company and product_id = p_product;
  if found and v_lpc.last_purchase_cost > 0 then
    v_pur := v_lpc.last_purchase_cost;
    select * into v_pev from public.product_purchase_cost_events where id = v_lpc.source_event_id;
  end if;

  if v_had or v_bom.id is not null or v_lpc.product_id is not null then
    v_pref := case v_p.default_source_type when 'IN_HOUSE' then 'BOM' when 'OUTSOURCED' then 'GRN'
                   else coalesce(v_prof.default_cost_source, 'BOM') end;
    if v_pref = 'BOM' then
      if v_bom_cost is not null then
        v_cand := v_bom_cost; v_src := 'BOM'; v_c_bom := v_bom.id; v_ref := v_bom.bom_code || ' v' || v_bom.version; v_status := 'CURRENT';
      elsif v_bom.id is null then
        v_note := 'No new cost available: no active approved BOM.';
      elsif v_snap.status = 'NO_COMPONENTS' then
        v_status := 'BOM_INCOMPLETE'; v_note := 'No new cost available: the active BOM has no components.';
      elsif v_snap.status = 'MISSING_COSTS' then
        v_status := 'BOM_INCOMPLETE'; v_note := format('No new cost available: %s component(s) of %s v%s have no cost.', v_snap.missing_count, v_bom.bom_code, v_bom.version);
      else
        v_note := 'No new cost available: the BOM cost is zero.';
      end if;
    else
      if v_pur is not null then
        v_cand := v_pur; v_src := case when v_pev.event_type = 'MANUAL_OVERRIDE' then 'MANUAL' else 'GRN' end;
        v_c_grn := v_pev.goods_receipt_id; v_c_pev := v_pev.id; v_status := 'CURRENT';
        v_ref := case when v_pev.event_type = 'MANUAL_OVERRIDE' then 'Manual purchase cost override' else v_pev.receipt_number end;
      else
        v_note := 'No new cost available: no valid posted GRN with a cost.';
      end if;
    end if;

    if v_cand is not null and (v_cand is distinct from v_prof.current_cost or v_src is distinct from v_prof.current_source) then
      insert into public.product_cost_history (company_id, product_id, previous_cost, new_cost, previous_source, new_source, event,
        bom_id, bom_code, bom_version, goods_receipt_id, receipt_number, purchase_event_id, reason, created_by)
      values (p_company, p_product, coalesce(v_prof.current_cost, v_before), v_cand, coalesce(v_prof.current_source, v_before_src), v_src, p_event,
        v_c_bom, case when v_c_bom is not null then v_bom.bom_code end, case when v_c_bom is not null then v_bom.version end,
        v_c_grn, case when v_src = 'GRN' then v_ref end, v_c_pev,
        left(coalesce(nullif(btrim(p_reason), ''), p_event), 500), auth.uid());
      insert into public.audit_logs (company_id, actor_user_id, action, resource_type, resource_id, request_id, metadata)
      values (p_company, auth.uid(), 'products.master_cost_updated', 'product', p_product::text, nullif(current_setting('app.request_id', true), ''),
        jsonb_build_object('previous_cost', coalesce(v_prof.current_cost, v_before), 'new_cost', v_cand, 'source', v_src, 'reference', v_ref, 'event', p_event));
      v_changed := true;
    end if;

    insert into public.product_cost_profiles as c (company_id, product_id, bom_cost, bom_id, bom_code, bom_version, bom_cost_status, bom_cost_at,
      current_cost, current_source, current_reference, current_bom_id, current_goods_receipt_id, current_purchase_event_id, current_updated_at,
      cost_status, status_note, updated_at)
    values (p_company, p_product, v_bom_cost, v_bom.id, v_bom.bom_code, v_bom.version,
      case when v_bom.id is null then 'NO_ACTIVE_BOM' else v_snap.status end, case when v_bom.id is not null then v_snap.calculated_at end,
      v_cand, v_src, v_ref, v_c_bom, v_c_grn, v_c_pev, case when v_cand is not null then now() end,
      v_status, v_note, now())
    on conflict (company_id, product_id) do update set
      bom_cost = excluded.bom_cost, bom_id = excluded.bom_id, bom_code = excluded.bom_code, bom_version = excluded.bom_version,
      bom_cost_status = excluded.bom_cost_status, bom_cost_at = excluded.bom_cost_at,
      -- No valid new cost: the current cost, its source and its date stay as they are (never zero or blank).
      current_cost = coalesce(excluded.current_cost, c.current_cost),
      current_source = case when excluded.current_cost is not null then excluded.current_source else c.current_source end,
      current_reference = case when excluded.current_cost is not null then excluded.current_reference else c.current_reference end,
      current_bom_id = case when excluded.current_cost is not null then excluded.current_bom_id else c.current_bom_id end,
      current_goods_receipt_id = case when excluded.current_cost is not null then excluded.current_goods_receipt_id else c.current_goods_receipt_id end,
      current_purchase_event_id = case when excluded.current_cost is not null then excluded.current_purchase_event_id else c.current_purchase_event_id end,
      current_updated_at = case when v_changed then now() else c.current_updated_at end,
      cost_status = excluded.cost_status, status_note = excluded.status_note, updated_at = now();
  end if;

  -- The cost of BOMs that use this product follows its Product Master Cost (up the BOM tree).
  select master_cost into v_after from public.product_master_list where id = p_product;
  if not v_had or v_after is distinct from v_prof.last_master_cost or v_after is distinct from v_before then
    update public.product_cost_profiles set last_master_cost = v_after where company_id = p_company and product_id = p_product;
    for v_parent in
      select distinct b.finished_product_id from public.bom_items bi join public.boms b on b.id = bi.bom_id
      where bi.company_id = p_company and bi.component_product_id = p_product and b.status = 'APPROVED' and b.finished_product_id <> p_product
    loop
      perform private.product_cost_refresh(p_company, v_parent, 'COMPONENT_COST_CHANGED', 'Component ' || v_p.sku || ' cost changed', p_depth + 1);
    end loop;
  end if;
end;
$$;
revoke all on function private.product_cost_refresh(uuid, uuid, text, text, integer) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 5. Triggers (same transaction as the event)
-- -----------------------------------------------------------------------------
create or replace function private.product_cost_on_bom_status()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.status is not distinct from old.status then return null; end if;
  if new.status = 'APPROVED' then
    perform private.product_cost_refresh(new.company_id, new.finished_product_id, 'BOM_ACTIVATED', format('%s v%s approved and activated', new.bom_code, new.version));
  elsif tg_op = 'UPDATE' and old.status = 'APPROVED' then
    delete from public.bom_cost_snapshots where bom_id = new.id;
    perform private.product_cost_refresh(new.company_id, new.finished_product_id, 'BOM_DEACTIVATED', format('%s v%s %s', new.bom_code, new.version, lower(new.status)));
  end if;
  return null;
end;
$$;
revoke all on function private.product_cost_on_bom_status() from public, anon, authenticated;
drop trigger if exists boms_product_cost on public.boms;
create trigger boms_product_cost after insert or update of status on public.boms
  for each row execute function private.product_cost_on_bom_status();

create or replace function private.product_cost_on_purchase_cost()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_type text;
  v_no   text;
begin
  select event_type, receipt_number into v_type, v_no from public.product_purchase_cost_events where id = new.last_event_id;
  perform private.product_cost_refresh(new.company_id, new.product_id,
    case v_type when 'GRN_REVERSAL' then 'GRN_REVERSED' when 'MANUAL_OVERRIDE' then 'PURCHASE_OVERRIDE' else 'GRN_POSTED' end,
    case v_type when 'GRN_REVERSAL' then 'GRN ' || coalesce(v_no, '') || ' reversed' when 'MANUAL_OVERRIDE' then 'Manual purchase cost override'
                else 'GRN ' || coalesce(v_no, '') || ' posted' end);
  return null;
end;
$$;
revoke all on function private.product_cost_on_purchase_cost() from public, anon, authenticated;
drop trigger if exists product_cost_follows_last_purchase on public.product_last_purchase_costs;
create trigger product_cost_follows_last_purchase after insert or update on public.product_last_purchase_costs
  for each row execute function private.product_cost_on_purchase_cost();

create or replace function private.product_cost_on_product()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.default_source_type is distinct from old.default_source_type then
    perform private.product_cost_refresh(new.company_id, new.id, 'SOURCING_CHANGED',
      format('Sourcing method changed from %s to %s', old.default_source_type, new.default_source_type));
  elsif new.standard_cost is distinct from old.standard_cost or new.standard_manufacturing_cost is distinct from old.standard_manufacturing_cost then
    perform private.product_cost_refresh(new.company_id, new.id, 'STANDARD_COST_CHANGED', 'Standard cost changed');
  end if;
  return null;
end;
$$;
revoke all on function private.product_cost_on_product() from public, anon, authenticated;
drop trigger if exists products_product_cost on public.products;
create trigger products_product_cost after update of default_source_type, standard_cost, standard_manufacturing_cost on public.products
  for each row execute function private.product_cost_on_product();

-- -----------------------------------------------------------------------------
-- 6. BOM list costs
-- -----------------------------------------------------------------------------
-- The Product Master Cost is read through a function, not by joining product_master_list: a view on that view
-- would stop earlier migrations from re-creating it. Security invoker: the caller's RLS applies.
create or replace function private.product_master_cost(p_product uuid)
returns table (cost numeric, source text)
language sql
stable
security invoker
set search_path = ''
as $$
  select m.master_cost, m.master_cost_source from public.product_master_list m where m.id = p_product;
$$;
revoke all on function private.product_master_cost(uuid) from public, anon;
grant execute on function private.product_master_cost(uuid) to authenticated, service_role;

create view public.bom_cost_list
with (security_invoker = true) as
select b.id as bom_id, b.company_id, b.finished_product_id, b.status,
  case when b.status = 'APPROVED' and s.status = 'COMPLETE' then s.unit_cost end as bom_unit_cost,
  case when b.status <> 'APPROVED' then 'NOT_APPROVED' when s.bom_id is null then 'NOT_CALCULATED' else s.status end as bom_cost_status,
  s.known_unit_cost, s.line_count, s.missing_count,
  case when b.status = 'APPROVED' then s.calculated_at end as cost_calculated_at,
  m.cost as product_master_cost,
  m.source as product_master_cost_source,
  case when b.status = 'APPROVED' and s.status = 'COMPLETE' and m.cost is not null then s.unit_cost - m.cost end as cost_difference
from public.boms b
left join public.bom_cost_snapshots s on s.bom_id = b.id
left join lateral private.product_master_cost(b.finished_product_id) m on true;
comment on view public.bom_cost_list is
  'BOM list cost columns (migration 20261208090000): approved BOM cost per unit, Product Master Cost, difference, calculation time.';
revoke all on public.bom_cost_list from public, anon;
grant select on public.bom_cost_list to authenticated;

-- -----------------------------------------------------------------------------
-- 7. RPCs
-- -----------------------------------------------------------------------------
-- Recalculate BOM and Product Master costs (all products with an approved BOM, a purchase cost or a
-- stored profile; or the given ones). History only where the cost changes.
create or replace function public.product_cost_recalculate(p_product_ids uuid[] default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('products.update');
  v_id      uuid;
  v_n       integer := 0;
  v_hist    bigint;
begin
  select count(*) into v_hist from public.product_cost_history where company_id = v_company;
  for v_id in
    select p.id from public.products p
    where p.company_id = v_company and (p_product_ids is null or p.id = any(p_product_ids))
      and (p_product_ids is not null
           or exists (select 1 from public.boms b where b.finished_product_id = p.id and b.status = 'APPROVED')
           or exists (select 1 from public.product_last_purchase_costs c where c.company_id = v_company and c.product_id = p.id)
           or exists (select 1 from public.product_cost_profiles c where c.company_id = v_company and c.product_id = p.id))
    order by p.sku
  loop
    perform private.product_cost_refresh(v_company, v_id, 'RECALCULATED', 'Costs recalculated');
    v_n := v_n + 1;
  end loop;
  insert into public.audit_logs (company_id, actor_user_id, action, resource_type, resource_id, request_id, metadata)
  values (v_company, auth.uid(), 'products.costs_recalculated', 'company', v_company::text, nullif(current_setting('app.request_id', true), ''),
    jsonb_build_object('products', v_n, 'selected', p_product_ids is not null));
  return jsonb_build_object('products', v_n,
    'changed', (select count(*) from public.product_cost_history where company_id = v_company) - v_hist);
end;
$$;

-- Default cost source of a Both (Make & Buy) product. Changes only the Product Master Cost:
-- stock lots and posted transactions keep their own cost.
create or replace function public.product_cost_set_default_source(p_product_id uuid, p_source text, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('products.update');
  v_p       public.products;
  v_old     text;
begin
  if p_source is null or p_source not in ('BOM', 'GRN') then
    raise exception 'Choose the default cost source: BOM or GRN.' using errcode = 'P0001';
  end if;
  select * into v_p from public.products where id = p_product_id and company_id = v_company;
  if not found then
    raise exception 'Product not found in your company.' using errcode = 'P0001';
  end if;
  if v_p.default_source_type <> 'HYBRID' then
    raise exception 'The default cost source is set only for products sourced as Both (Make & Buy).' using errcode = 'P0001';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('product_cost:' || v_company::text || ':' || p_product_id::text, 0));
  select default_cost_source into v_old from public.product_cost_profiles where company_id = v_company and product_id = p_product_id;
  insert into public.product_cost_profiles as c (company_id, product_id, default_cost_source)
  values (v_company, p_product_id, p_source)
  on conflict (company_id, product_id) do update set default_cost_source = excluded.default_cost_source, updated_at = now();
  if v_old is distinct from p_source then
    insert into public.audit_logs (company_id, actor_user_id, action, resource_type, resource_id, request_id, metadata)
    values (v_company, auth.uid(), 'products.default_cost_source_changed', 'product', p_product_id::text, nullif(current_setting('app.request_id', true), ''),
      jsonb_build_object('from', coalesce(v_old, 'BOM'), 'to', p_source, 'reason', nullif(btrim(coalesce(p_reason, '')), '')));
  end if;
  perform private.product_cost_refresh(v_company, p_product_id, 'DEFAULT_SOURCE_CHANGED',
    coalesce(nullif(btrim(coalesce(p_reason, '')), ''), 'Default cost source set to ' || p_source));
  return jsonb_build_object('product_id', p_product_id, 'default_cost_source', p_source,
    'master_cost', (select master_cost from public.product_master_list where id = p_product_id));
end;
$$;

-- Proposed sourcing method from the BOM and GRN history (read only; nothing is changed).
create or replace function public.product_sourcing_proposals(p_product_ids uuid[] default null, p_only_different boolean default true)
returns table (product_id uuid, sku text, product_name text, current_method text, proposed_method text,
               approved_boms integer, posted_grns integer, reason text)
language sql
stable
security definer
set search_path = ''
as $$
  with c as (select private.require_permission('products.read') as company),
  x as (
    select p.id, p.sku, p.product_name, p.default_source_type,
      (select count(*)::int from public.boms b where b.finished_product_id = p.id and (b.status = 'APPROVED' or (b.status = 'ARCHIVED' and b.approved_at is not null))) as boms,
      (select count(distinct g.id)::int from public.goods_receipt_lines l join public.goods_receipts g on g.id = l.goods_receipt_id
         where l.product_id = p.id and g.status = 'POSTED' and coalesce(l.accepted_quantity, 0) > 0) as grns
    from public.products p, c
    where p.company_id = c.company and (p_product_ids is null or p.id = any(p_product_ids))
  ), y as (
    select x.*, case when boms > 0 and grns > 0 then 'HYBRID' when boms > 0 then 'IN_HOUSE' when grns > 0 then 'OUTSOURCED' end as proposed from x
  )
  select id, sku, product_name, default_source_type, coalesce(proposed, default_source_type), boms, grns,
    case when proposed is null then 'No approved BOM and no posted GRN: no proposal.'
         else format('%s approved BOM version(s), %s posted GRN(s).', boms, grns) end
  from y
  where not p_only_different or (proposed is not null and proposed <> default_source_type)
  order by sku;
$$;

-- Change the sourcing method (products.update; a product version and an audit entry are recorded).
create or replace function public.product_sourcing_apply(p_product_id uuid, p_method text, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('products.update');
  v_p       public.products;
begin
  if p_method is null or p_method not in ('IN_HOUSE', 'OUTSOURCED', 'HYBRID') then
    raise exception 'Choose the sourcing method: Manufacture, Purchase or Both.' using errcode = 'P0001';
  end if;
  select * into v_p from public.products where id = p_product_id and company_id = v_company for update;
  if not found then
    raise exception 'Product not found in your company.' using errcode = 'P0001';
  end if;
  if v_p.default_source_type = p_method then
    return jsonb_build_object('product_id', p_product_id, 'changed', false, 'sourcing_method', p_method);
  end if;
  update public.products set default_source_type = p_method,
    change_reason = left(coalesce(nullif(btrim(coalesce(p_reason, '')), ''), 'Sourcing method changed'), 500)
  where id = p_product_id;
  insert into public.audit_logs (company_id, actor_user_id, action, resource_type, resource_id, request_id, metadata)
  values (v_company, auth.uid(), 'products.sourcing_method_changed', 'product', p_product_id::text, nullif(current_setting('app.request_id', true), ''),
    jsonb_build_object('from', v_p.default_source_type, 'to', p_method, 'reason', nullif(btrim(coalesce(p_reason, '')), '')));
  return jsonb_build_object('product_id', p_product_id, 'changed', true, 'sourcing_method', p_method,
    'master_cost', (select master_cost from public.product_master_list where id = p_product_id));
end;
$$;

revoke all on function public.product_cost_recalculate(uuid[]) from public, anon;
revoke all on function public.product_cost_set_default_source(uuid, text, text) from public, anon;
revoke all on function public.product_sourcing_proposals(uuid[], boolean) from public, anon;
revoke all on function public.product_sourcing_apply(uuid, text, text) from public, anon;
grant execute on function public.product_cost_recalculate(uuid[]) to authenticated;
grant execute on function public.product_cost_set_default_source(uuid, text, text) to authenticated;
grant execute on function public.product_sourcing_proposals(uuid[], boolean) to authenticated;
grant execute on function public.product_sourcing_apply(uuid, text, text) to authenticated;

-- -----------------------------------------------------------------------------
-- 8. ERP reset: the three cost tables are cleared with the BOM and purchase data
--    (same list as 20261203090000_bom_templates_similar_products.sql plus the three tables).
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
    (0, 'bom_template_items', 'Production & BOMs', 'BOM template components'),
    (0, 'bom_cost_snapshots', 'Production & BOMs', 'BOM cost calculations'),
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
    (0, 'product_cost_history', 'Products & catalogue', 'Product cost history'),
    (0, 'product_cost_profiles', 'Products & catalogue', 'Product cost sources'),
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
    (1, 'bom_templates', 'Production & BOMs', 'BOM templates'),
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
