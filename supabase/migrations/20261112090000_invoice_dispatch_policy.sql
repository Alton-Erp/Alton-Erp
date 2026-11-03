-- =============================================================================
-- ALTON ERP V2 — Dispatch before invoice posting
--
-- Policy: an invoice with stock-tracked goods can be posted (DRAFT /
-- PENDING_APPROVAL -> ISSUED) only when valid, posted dispatches cover the full
-- invoiced quantity of every stock-tracked line. The dispatch is the only event
-- that deducts stock; issuing an invoice never moves stock (unchanged).
--
-- Inspected schema (no stock-posting function changes):
--   * invoice lines are PRODUCT (always a product) or CHARGE (freight, packing,
--     other: services, never dispatched)
--   * a PRODUCT line links to a dispatch line (fulfilment_line_id, DISPATCH
--     invoices) and/or a sales order line (sales_order_line_id); MANUAL and
--     IMPORT lines link to neither
--   * valid dispatched quantity of a sales order line = quantity_dispatched,
--     raised only by a posted dispatch (fulfilment_dispatch) and lowered only by
--     the dispatch reversal; draft / cancelled consignments never count; goods
--     received back on customer returns are deducted
--   * issuing: sales_invoice_v2_issue -> private.invoice_v2_issue_core,
--     sales_invoice_issue (approval path), invoice_import -> invoice_v2_issue_core;
--     every path ends in UPDATE sales_invoices SET status = 'ISSUED'
--
-- Added:
--   1. products.inventory_tracked (default true: every existing product keeps
--      today's behaviour). false = service / non-stock item: invoiceable
--      without dispatch.
--   2. private.invoice_dispatch_lines(invoice): per line required, validly
--      dispatched, remaining, status (read-only).
--   3. Trigger on sales_invoices: the change to ISSUED is refused while any
--      stock-tracked line is not fully dispatched (all issuing paths, same
--      transaction; sales order and dispatch lines are locked first so
--      concurrent postings serialise). Errors list SKU, name, invoiced,
--      dispatched and remaining quantities.
--   4. Trigger on fulfilment_lines: a dispatch reversal cannot lower the
--      dispatched quantity below what posted invoices already bill.
--   5. public.invoice_dispatch_status(invoice) for the invoice screen and
--      public.invoice_dispatch_exceptions() listing historical posted invoices
--      that do not meet the rule (reported, never rewritten).
-- Rollback: supabase/rollback/20261112090000_invoice_dispatch_policy_down.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Product classification
-- -----------------------------------------------------------------------------
alter table public.products add column if not exists inventory_tracked boolean not null default true;
comment on column public.products.inventory_tracked is
  'true = physical stock item: invoices need a posted dispatch for it. false = service / non-stock item (installation, AMC, ...): invoiced without dispatch.';
grant insert (inventory_tracked) on public.products to authenticated;
grant update (inventory_tracked) on public.products to authenticated;

-- -----------------------------------------------------------------------------
-- 2. Dispatch coverage of an invoice, line by line (read-only)
--
-- Counted per posted dispatch line (the same basis the invoicing rules use):
--   open(dispatch line) = GREATEST(dispatched - received back - billed on posted
--                         invoices for that dispatch line, 0)
--   open(order line)    = SUM(open of its dispatch lines)
--                         - billed on posted order invoices not tied to a dispatch line
-- Draft / cancelled consignments have no actual_dispatch_at and count 0; a reversal
-- resets the dispatch line to 0. Proforma, draft, cancelled and discarded invoices
-- never consume dispatched quantity.
-- -----------------------------------------------------------------------------
-- p_qty overrides the dispatch line's quantity (used by the reversal guard while the
-- reversal is being written).
create or replace function private.fulfilment_line_dispatch_open(p_fl uuid, p_exclude uuid default null, p_qty numeric default null)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select greatest(coalesce(p_qty, fl.quantity_dispatched)
      - coalesce((select sum(rl.quantity_received) from public.customer_return_lines rl where rl.fulfilment_line_id = fl.id), 0)
      - coalesce((select sum(l.quantity) from public.sales_invoice_lines l join public.sales_invoices i on i.id = l.invoice_id
                  where l.fulfilment_line_id = fl.id and l.line_type = 'PRODUCT' and i.status = 'ISSUED' and not i.is_proforma
                    and (p_exclude is null or i.id <> p_exclude)), 0), 0)
    from public.fulfilment_lines fl join public.fulfilments f on f.id = fl.fulfilment_id
    where fl.id = p_fl and (f.actual_dispatch_at is not null or p_qty is not null)), 0);
$$;

-- Open dispatched quantity of an order line (may be negative when posted invoices
-- bill more than is dispatched, e.g. historical invoices). p_fl / p_fl_qty: see above.
create or replace function private.so_line_dispatch_open(p_sol uuid, p_exclude uuid default null, p_fl uuid default null, p_fl_qty numeric default null)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select sum(private.fulfilment_line_dispatch_open(fl.id, p_exclude, case when fl.id = p_fl then p_fl_qty end))
                   from public.fulfilment_lines fl where fl.sales_order_line_id = p_sol), 0)
       - coalesce((select sum(l.quantity) from public.sales_invoice_lines l join public.sales_invoices i on i.id = l.invoice_id
                   where l.sales_order_line_id = p_sol and l.fulfilment_line_id is null and l.line_type = 'PRODUCT'
                     and i.status = 'ISSUED' and not i.is_proforma and (p_exclude is null or i.id <> p_exclude)), 0);
$$;

revoke all on function private.fulfilment_line_dispatch_open(uuid, uuid, numeric) from public, anon, authenticated;
revoke all on function private.so_line_dispatch_open(uuid, uuid, uuid, numeric) from public, anon, authenticated;

-- status: NOT_APPLICABLE (charge / non-stock), AWAITING_DISPATCH, PARTIALLY_DISPATCHED, FULLY_DISPATCHED
create or replace function private.invoice_dispatch_lines(p_invoice uuid)
returns table (line_no int, line_type text, product_id uuid, sku text, product_name text, unit text, applies boolean, required numeric,
  dispatched numeric, remaining numeric, status text, reason text, sales_order_id uuid, sales_order_number text)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_line  record;
  v_cover numeric;
  v_used  jsonb := '{}'::jsonb;
  v_fkey  text;
  v_skey  text;
begin
  for v_line in
    select l.*, p.inventory_tracked, p.base_unit, p.product_name as p_name, so.id as so_id, so.sales_order_number as so_number,
      coalesce(l.sales_order_line_id, fl.sales_order_line_id) as sol_id
    from public.sales_invoice_lines l
    left join public.products p on p.id = l.product_id
    left join public.fulfilment_lines fl on fl.id = l.fulfilment_line_id
    left join public.sales_order_lines sol on sol.id = coalesce(l.sales_order_line_id, fl.sales_order_line_id)
    left join public.sales_orders so on so.id = sol.sales_order_id
    where l.invoice_id = p_invoice
    order by l.line_no
  loop
    line_no := v_line.line_no; line_type := v_line.line_type; product_id := v_line.product_id; sku := v_line.sku;
    product_name := coalesce(v_line.p_name, v_line.description); unit := coalesce(v_line.unit, v_line.base_unit);
    sales_order_id := v_line.so_id; sales_order_number := v_line.so_number;
    required := v_line.quantity; reason := null;
    if v_line.line_type <> 'PRODUCT' or not coalesce(v_line.inventory_tracked, true) then
      applies := false; dispatched := null; remaining := 0; status := 'NOT_APPLICABLE';
      reason := case when v_line.line_type <> 'PRODUCT' then 'Charge / service line' else 'Non-stock item' end;
      return next;
      continue;
    end if;
    applies := true;
    v_fkey := 'F' || coalesce(v_line.fulfilment_line_id::text, '');
    v_skey := 'S' || coalesce(v_line.sol_id::text, '');
    if v_line.unit is not null and upper(v_line.unit) <> upper(v_line.base_unit) then
      v_cover := 0;
      reason := format('Invoiced in %s but stocked in %s; no unit conversion is configured.', v_line.unit, v_line.base_unit);
    elsif v_line.sol_id is null and v_line.fulfilment_line_id is null then
      v_cover := 0;
      reason := 'Not linked to a sales order or dispatch: invoice it from the sales order or the dispatch.';
    else
      -- Order line: its open dispatched quantity less what earlier lines of this invoice took.
      v_cover := greatest(coalesce(private.so_line_dispatch_open(v_line.sol_id, p_invoice), 0) - coalesce((v_used ->> v_skey)::numeric, 0), 0);
      if v_line.fulfilment_line_id is not null then
        -- Dispatch invoice line: also limited to that dispatch line.
        v_cover := least(v_cover, greatest(private.fulfilment_line_dispatch_open(v_line.fulfilment_line_id, p_invoice) - coalesce((v_used ->> v_fkey)::numeric, 0), 0));
        v_used := v_used || jsonb_build_object(v_fkey, coalesce((v_used ->> v_fkey)::numeric, 0) + least(v_cover, v_line.quantity));
      end if;
      v_used := v_used || jsonb_build_object(v_skey, coalesce((v_used ->> v_skey)::numeric, 0) + least(v_cover, v_line.quantity));
    end if;
    dispatched := least(v_cover, v_line.quantity);
    remaining := greatest(v_line.quantity - v_cover, 0);
    status := case when remaining = 0 then 'FULLY_DISPATCHED' when dispatched > 0 then 'PARTIALLY_DISPATCHED' else 'AWAITING_DISPATCH' end;
    return next;
  end loop;
end;
$$;

revoke all on function private.invoice_dispatch_lines(uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 3. The posting rule, enforced on every path to ISSUED
-- -----------------------------------------------------------------------------
create or replace function private.invoice_dispatch_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_missing text;
begin
  if new.status = 'ISSUED' and old.status is distinct from 'ISSUED' then
    -- Serialise with concurrent postings and dispatch reversals of the same lines:
    -- the order lines and all their dispatch lines are locked until commit.
    perform 1 from public.sales_order_lines where id in (
      select coalesce(l.sales_order_line_id, fl.sales_order_line_id) from public.sales_invoice_lines l
      left join public.fulfilment_lines fl on fl.id = l.fulfilment_line_id where l.invoice_id = new.id) order by id for update;
    perform 1 from public.fulfilment_lines where id in (select fulfilment_line_id from public.sales_invoice_lines where invoice_id = new.id)
      or sales_order_line_id in (select sales_order_line_id from public.sales_invoice_lines where invoice_id = new.id)
      order by id for update;
    select string_agg(format('%s %s: invoiced %s %s, validly dispatched %s, still to dispatch %s%s', coalesce(d.sku, '—'), d.product_name,
        trim_scale(d.required), coalesce(d.unit, ''), trim_scale(d.dispatched), trim_scale(d.remaining), coalesce(' (' || d.reason || ')', '')), '; ' order by d.line_no)
    into v_missing
    from private.invoice_dispatch_lines(new.id) d where d.applies and d.remaining > 0;
    if v_missing is not null then
      raise exception 'Dispatch the goods before posting this invoice (the dispatch is the only event that deducts stock). Not fully dispatched: %', v_missing
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function private.invoice_dispatch_guard() from public, anon, authenticated;

drop trigger if exists sales_invoices_dispatch_guard on public.sales_invoices;
create trigger sales_invoices_dispatch_guard
  before update of status on public.sales_invoices
  for each row execute function private.invoice_dispatch_guard();

-- A dispatch reversal (dispatch line quantity lowered) may not leave posted
-- invoices billing more than remains dispatched. Existing behaviour already refuses
-- reversing a dispatch that has its own dispatch invoice; this also covers invoices
-- raised from the sales order.
create or replace function private.dispatch_reversal_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_returned numeric;
  v_fl_billed numeric;
  v_sol      public.sales_order_lines;
  v_docs     text;
begin
  if new.quantity_dispatched < old.quantity_dispatched and new.sales_order_line_id is not null then
    select * into v_sol from public.sales_order_lines where id = new.sales_order_line_id;
    v_returned := coalesce((select sum(rl.quantity_received) from public.customer_return_lines rl where rl.fulfilment_line_id = new.id), 0);
    v_fl_billed := coalesce((select sum(l.quantity) from public.sales_invoice_lines l join public.sales_invoices i on i.id = l.invoice_id
      where l.fulfilment_line_id = new.id and l.line_type = 'PRODUCT' and i.status = 'ISSUED' and not i.is_proforma), 0);
    if v_fl_billed > new.quantity_dispatched - v_returned
       or private.so_line_dispatch_open(new.sales_order_line_id, null, new.id, new.quantity_dispatched) < 0 then
      select string_agg(distinct i.invoice_number, ', ') into v_docs
      from public.sales_invoice_lines l join public.sales_invoices i on i.id = l.invoice_id
      where (l.sales_order_line_id = new.sales_order_line_id or l.fulfilment_line_id = new.id)
        and l.line_type = 'PRODUCT' and i.status = 'ISSUED' and not i.is_proforma;
      raise exception 'Line % (%): the dispatched goods are billed on posted invoice(s) % and the reversal would leave them billed but not dispatched. Cancel the invoice or issue a credit note first.',
        v_sol.line_no, v_sol.sku_snapshot, v_docs using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function private.dispatch_reversal_guard() from public, anon, authenticated;

drop trigger if exists fulfilment_lines_dispatch_reversal_guard on public.fulfilment_lines;
create trigger fulfilment_lines_dispatch_reversal_guard
  before update of quantity_dispatched on public.fulfilment_lines
  for each row execute function private.dispatch_reversal_guard();

-- -----------------------------------------------------------------------------
-- 4. Read-only RPCs: the invoice screen and the historical exceptions report
-- -----------------------------------------------------------------------------
create or replace function public.invoice_dispatch_status(p_invoice_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('invoices.read');
  v_inv     public.sales_invoices;
  v_lines   jsonb;
begin
  select * into v_inv from public.sales_invoices where id = p_invoice_id and company_id = v_company;
  if not found then
    raise exception 'Invoice not found in your company.' using errcode = 'P0001';
  end if;
  select coalesce(jsonb_agg(to_jsonb(d) order by d.line_no), '[]'::jsonb) into v_lines from private.invoice_dispatch_lines(v_inv.id) d;
  return jsonb_build_object('invoice_id', v_inv.id, 'invoice_status', v_inv.status, 'sales_order_id', v_inv.sales_order_id,
    'lines', v_lines,
    'stock_lines', (select count(*) from jsonb_array_elements(v_lines) x where (x ->> 'applies')::boolean),
    'outstanding_lines', (select count(*) from jsonb_array_elements(v_lines) x where (x ->> 'applies')::boolean and (x ->> 'remaining')::numeric > 0),
    'ready', not exists (select 1 from jsonb_array_elements(v_lines) x where (x ->> 'applies')::boolean and (x ->> 'remaining')::numeric > 0),
    'checked_at', now());
end;
$$;

-- Posted invoices whose stock-tracked lines are not covered by valid dispatches
-- (for example issued before this rule). Listed for review; never changed.
create or replace function public.invoice_dispatch_exceptions()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('invoices.read');
begin
  return jsonb_build_object('checked_at', now(), 'rows', coalesce((
    select jsonb_agg(jsonb_build_object('invoice_id', i.id, 'invoice_number', i.invoice_number, 'invoice_date', i.invoice_date,
        'customer', i.customer_legal_name, 'source', i.source, 'line_no', d.line_no, 'sku', d.sku, 'product_name', d.product_name,
        'unit', d.unit, 'invoiced', d.required, 'covered', d.dispatched, 'uncovered', d.remaining, 'reason', d.reason)
      order by i.invoice_date, i.invoice_number, d.line_no)
    from public.sales_invoices i
    cross join lateral private.invoice_dispatch_lines(i.id) d
    where i.company_id = v_company and i.status = 'ISSUED' and d.applies and d.remaining > 0), '[]'::jsonb));
end;
$$;

revoke all on function public.invoice_dispatch_status(uuid) from public, anon;
revoke all on function public.invoice_dispatch_exceptions() from public, anon;
grant execute on function public.invoice_dispatch_status(uuid) to authenticated;
grant execute on function public.invoice_dispatch_exceptions() to authenticated;

notify pgrst, 'reload schema';
