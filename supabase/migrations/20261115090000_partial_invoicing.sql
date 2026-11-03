-- =============================================================================
-- ALTON ERP V2 — Sales order partial invoicing, pending-invoice tracking and release
--
-- Inspected first; reused (no new tables, no duplicate quantity fields):
--   sales_order_lines.quantity_ordered / quantity_cancelled / quantity_dispatched
--   sales_invoices + sales_invoice_lines.sales_order_line_id   (invoice <-> order line)
--   private.so_line_invoiced / so_line_invoiceable             (save-time over-invoicing rule)
--   public.sales_order_v2_dispatch                             (one-step dispatch from reservations)
--   public.sales_order_line_update                             (customer-approved line reduction
--                                                               + reservation release)
--   sales_order_events, billing_events, audit_logs             (history)
--   public.notifications + private.notify                      (in-app, read/unread, de-duplicated)
--
-- Policy change (documented in docs/STOCK_RELIABILITY.md section 8):
--   Invoices are created only from Billing & Invoicing (no dispatch screen any more).
--   Posting a sales-order invoice IS the dispatch: sales_invoice_v2_issue first dispatches,
--   through sales_order_v2_dispatch and in the same transaction, the part of each stock
--   line that is not already covered by a posted dispatch, then posts the invoice. The
--   dispatch-before-posting trigger (20261112) stays in force and checks the result, so
--   stock is deducted exactly once and a failure rolls back both.
--
-- Quantities per sales order line:
--   effective  = quantity_ordered - quantity_cancelled
--   invoiced   = posted (ISSUED, non-proforma) invoice quantity; drafts / cancelled excluded
--   released   = quantity released from pending invoicing (PENDING_INVOICE_RELEASED events;
--                also counted in quantity_cancelled)
--   pending    = GREATEST(effective - invoiced, 0)      -- tracking only, never stock
--   releasable = GREATEST(effective - GREATEST(invoiced incl. drafts, dispatched + on pick list), 0)
--
-- Added:
--   private.so_line_posted_invoiced, private.so_line_released, private.so_invoice_tracking_lines
--   public.sales_invoice_tracking(filters)        register + reports (read-only)
--   public.invoice_partial_preview(invoice)       partial-invoice warning before posting
--   public.sales_order_line_release_pending(...)  release a pending quantity (audited, notified)
--   public.sales_invoice_v2_issue                  redefined: dispatch on posting, partial
--                                                  invoice event, audit and Super Admin notice
--   public.invoice_dispatch_status                 redefined: lines dispatched on posting
-- Stock: no stock-in is ever created; release only frees reservations (existing mechanism).
-- Rollback: supabase/rollback/20261115090000_partial_invoicing_down.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Quantities
-- -----------------------------------------------------------------------------
create or replace function private.so_line_posted_invoiced(p_line uuid, p_exclude uuid default null)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(l.quantity), 0)
  from public.sales_invoice_lines l join public.sales_invoices i on i.id = l.invoice_id
  where l.sales_order_line_id = p_line and l.line_type = 'PRODUCT' and i.status = 'ISSUED' and not i.is_proforma
    and (p_exclude is null or i.id <> p_exclude);
$$;

create or replace function private.so_line_released(p_line uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum((e.details ->> 'quantity')::numeric), 0)
  from public.sales_order_events e where e.line_id = p_line and e.event_type = 'PENDING_INVOICE_RELEASED';
$$;

-- One row per line of confirmed (not draft) sales orders of a company.
create or replace function private.so_invoice_tracking_lines(p_company uuid)
returns table (
  sales_order_id uuid, sales_order_number text, order_date date, order_status text, customer_id uuid, customer_name text,
  line_id uuid, line_no int, product_id uuid, sku text, product_name text, unit text,
  ordered numeric, cancelled numeric, released numeric, effective numeric, invoiced numeric, draft_invoiced numeric,
  dispatched numeric, pending numeric, releasable numeric,
  invoice_numbers text[], latest_invoice_id uuid, latest_invoice_number text, latest_invoice_date date, status text)
language sql
stable
security definer
set search_path = ''
as $$
  select so.id, so.sales_order_number, so.order_date, so.order_status, so.customer_id, so.customer_name_snapshot,
    l.id, l.line_no, l.product_id, l.sku_snapshot, l.product_name_snapshot, l.unit,
    l.quantity_ordered, l.quantity_cancelled - q.released, q.released, l.quantity_ordered - l.quantity_cancelled, q.invoiced, q.live - q.invoiced,
    l.quantity_dispatched, greatest(l.quantity_ordered - l.quantity_cancelled - q.invoiced, 0),
    case when so.order_status = 'CANCELLED' then 0
         else greatest(l.quantity_ordered - l.quantity_cancelled - greatest(q.live, l.quantity_dispatched + private.so_line_planned(l.id)), 0) end,
    inv.numbers, inv.latest_id, inv.latest_number, inv.latest_date,
    case
      when so.order_status = 'CANCELLED' then 'CANCELLED'
      when l.quantity_ordered - l.quantity_cancelled - q.invoiced <= 0 then
        case when q.released > 0 or l.quantity_cancelled > 0 then 'CLOSED' else 'FULLY_INVOICED' end
      when q.released > 0 then 'PARTIALLY_RELEASED'
      when q.invoiced > 0 then 'PARTIALLY_INVOICED'
      else 'OPEN' end
  from public.sales_orders so
  join public.sales_order_lines l on l.sales_order_id = so.id
  cross join lateral (select private.so_line_posted_invoiced(l.id) as invoiced, private.so_line_invoiced(l.id) as live,
                             private.so_line_released(l.id) as released) q
  left join lateral (
    select array_agg(i.invoice_number order by i.invoice_date, i.invoice_number) as numbers,
           (array_agg(i.id order by i.invoice_date desc, i.issued_at desc))[1] as latest_id,
           (array_agg(i.invoice_number order by i.invoice_date desc, i.issued_at desc))[1] as latest_number,
           max(i.invoice_date) as latest_date
    from public.sales_invoices i
    where i.status = 'ISSUED' and not i.is_proforma
      and exists (select 1 from public.sales_invoice_lines il where il.invoice_id = i.id and il.sales_order_line_id = l.id and il.line_type = 'PRODUCT')) inv on true
  where so.company_id = p_company and so.order_status not in ('DRAFT', 'PENDING_CONFIRMATION');
$$;

revoke all on function private.so_line_posted_invoiced(uuid, uuid) from public, anon, authenticated;
revoke all on function private.so_line_released(uuid) from public, anon, authenticated;
revoke all on function private.so_invoice_tracking_lines(uuid) from public, anon, authenticated;

-- Every active Super Admin of the company (in-app notification, de-duplicated by key).
create or replace function private.notify_super_admins(p_company uuid, p_type text, p_title text, p_message text, p_severity text,
  p_entity_type text, p_entity_id text, p_link text, p_dedup text)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid;
  v_n    int := 0;
begin
  for v_user in
    select distinct p.id from public.profiles p
    join public.user_roles ur on ur.user_id = p.id and ur.company_id = p_company
    join public.roles r on r.id = ur.role_id and r.code = 'SUPER_ADMIN'
    where p.company_id = p_company and p.is_active
  loop
    if private.notify(p_company, v_user, p_type, p_title, p_message, p_severity, p_entity_type, p_entity_id, p_link, p_dedup) then
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end;
$$;

revoke all on function private.notify_super_admins(uuid, text, text, text, text, text, text, text, text) from public, anon, authenticated;

create or replace function private.user_label(p_user uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select coalesce(nullif(btrim(full_name), ''), split_part(email, '@', 1)) from public.profiles where id = p_user), 'system');
$$;

revoke all on function private.user_label(uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 2. Posting: dispatch on posting, then the existing issue; partial-invoice notice
-- -----------------------------------------------------------------------------
-- Dispatches, per sales order, what the invoice's stock lines need beyond the quantity
-- already covered by posted dispatches. Returns the dispatches made.
create or replace function private.invoice_dispatch_on_posting(p_company uuid, p_invoice uuid, p_key uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_so   record;
  v_res  jsonb;
  v_out  jsonb := '[]'::jsonb;
begin
  for v_so in
    select sol.sales_order_id as so_id,
      jsonb_agg(jsonb_build_object('line_id', n.sol_id, 'quantity', n.need) order by n.sol_id) as lines
    from (
      select l.sales_order_line_id as sol_id,
        greatest(sum(l.quantity) - greatest(coalesce(private.so_line_dispatch_open(l.sales_order_line_id, p_invoice), 0), 0), 0) as need
      from public.sales_invoice_lines l
      join public.products p on p.id = l.product_id
      join public.sales_order_lines s on s.id = l.sales_order_line_id
      where l.invoice_id = p_invoice and l.line_type = 'PRODUCT' and l.fulfilment_line_id is null and l.sales_order_line_id is not null
        and coalesce(p.inventory_tracked, true) and (l.unit is null or upper(l.unit) = upper(p.base_unit))
      group by l.sales_order_line_id
    ) n
    join public.sales_order_lines sol on sol.id = n.sol_id
    where n.need > 0
    group by sol.sales_order_id
    order by sol.sales_order_id
  loop
    v_res := public.sales_order_v2_dispatch(v_so.so_id, v_so.lines,
      jsonb_build_object('notes', 'Dispatched when posting the invoice'),
      case when p_key is null then gen_random_uuid() else md5(p_key::text || ':dispatch:' || v_so.so_id::text)::uuid end);
    v_out := v_out || jsonb_build_object('sales_order_id', v_so.so_id, 'dispatches', v_res -> 'dispatches',
      'transaction_numbers', v_res -> 'transaction_numbers', 'dispatched_quantity', v_res -> 'dispatched_quantity');
  end loop;
  return v_out;
end;
$$;

revoke all on function private.invoice_dispatch_on_posting(uuid, uuid, uuid) from public, anon, authenticated;

-- Per sales-order line of an invoice: ordered (effective), posted before this invoice,
-- this invoice, remaining after it.
create or replace function private.invoice_order_lines(p_invoice uuid)
returns table (sales_order_id uuid, sales_order_number text, line_id uuid, sku text, product_name text, unit text,
  ordered numeric, previously_invoiced numeric, this_invoice numeric, remaining numeric)
language sql
stable
security definer
set search_path = ''
as $$
  select so.id, so.sales_order_number, sol.id, sol.sku_snapshot, sol.product_name_snapshot, sol.unit,
    sol.quantity_ordered - sol.quantity_cancelled, private.so_line_posted_invoiced(sol.id, p_invoice), x.qty,
    greatest(sol.quantity_ordered - sol.quantity_cancelled - private.so_line_posted_invoiced(sol.id, p_invoice) - x.qty, 0)
  from (select l.sales_order_line_id as sol_id, sum(l.quantity) as qty from public.sales_invoice_lines l
        where l.invoice_id = p_invoice and l.line_type = 'PRODUCT' and l.sales_order_line_id is not null group by l.sales_order_line_id) x
  join public.sales_order_lines sol on sol.id = x.sol_id
  join public.sales_orders so on so.id = sol.sales_order_id
  order by so.sales_order_number, sol.line_no;
$$;

revoke all on function private.invoice_order_lines(uuid) from public, anon, authenticated;

-- Records and announces an invoice posted for less than the remaining order quantity.
create or replace function private.invoice_partial_notice(p_company uuid, p_invoice uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inv   public.sales_invoices;
  v_lines jsonb;
  v_text  text;
  v_sos   text;
  v_n     int;
begin
  select * into v_inv from public.sales_invoices where id = p_invoice;
  select jsonb_agg(to_jsonb(x)) into v_lines from private.invoice_order_lines(p_invoice) x where x.remaining > 0;
  if v_lines is null then return null; end if;
  select string_agg(distinct x ->> 'sales_order_number', ', ') into v_sos from jsonb_array_elements(v_lines) x;
  select string_agg(format('%s %s: ordered %s, previously invoiced %s, this invoice %s, remaining %s %s', x ->> 'sku', x ->> 'product_name',
      trim_scale((x ->> 'ordered')::numeric), trim_scale((x ->> 'previously_invoiced')::numeric), trim_scale((x ->> 'this_invoice')::numeric),
      trim_scale((x ->> 'remaining')::numeric), x ->> 'unit'), E'\n')
    into v_text from jsonb_array_elements(v_lines) x;

  perform private.log_billing_event(p_company, 'INVOICE', v_inv.id, v_inv.id, 'PARTIAL_INVOICE', 'ISSUED', 'ISSUED', null,
    jsonb_build_object('invoice_number', v_inv.invoice_number, 'invoice_date', v_inv.invoice_date, 'customer', v_inv.customer_legal_name,
      'sales_orders', v_sos, 'lines', v_lines, 'posted_by', private.user_label(auth.uid())));
  insert into public.audit_logs (company_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (p_company, auth.uid(), 'invoice.partial_posted', 'sales_invoice', v_inv.id::text,
    jsonb_build_object('invoice_number', v_inv.invoice_number, 'sales_orders', v_sos, 'lines', v_lines));
  v_n := private.notify_super_admins(p_company, 'PARTIAL_INVOICE', 'Partial Invoice Created',
    left(format(E'Sales Order: %s\nInvoice: %s\nCustomer: %s\n%s\nPosted by %s on %s (%s).\nAn invoice has been posted for less than the ordered quantity. The remaining quantity is pending.',
      v_sos, v_inv.invoice_number, v_inv.customer_legal_name, v_text, private.user_label(auth.uid()), to_char(v_inv.invoice_date, 'DD Mon YYYY'),
      to_char(coalesce(v_inv.issued_at, now()) at time zone 'Asia/Kolkata', 'DD Mon YYYY HH24:MI')), 1000),
    'MEDIUM', 'SALES_INVOICE', v_inv.id::text, '/billing/invoices/' || v_inv.id::text, 'PARTIAL_INVOICE:' || v_inv.id::text);
  return jsonb_build_object('partial', true, 'lines', v_lines, 'notified', v_n);
end;
$$;

revoke all on function private.invoice_partial_notice(uuid, uuid) from public, anon, authenticated;

create or replace function public.sales_invoice_v2_issue(p_invoice_id uuid, p_convert_proforma boolean default false, p_idempotency_key uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company   uuid := private.require_permission('invoices.issue');
  v_prev      jsonb;
  v_inv       public.sales_invoices;
  v_dispatch  jsonb;
  v_result    jsonb;
  v_partial   jsonb;
  v_issues    jsonb;
begin
  v_prev := private.idempotency_begin(v_company, p_idempotency_key, 'sales_invoice_v2_issue');
  if v_prev is not null then return v_prev; end if;
  v_inv := private.lock_invoice(v_company, p_invoice_id);
  if v_inv.is_proforma and coalesce(p_convert_proforma, false) then
    update public.sales_invoices set is_proforma = false where id = v_inv.id;
    perform private.log_billing_event(v_company, 'INVOICE', v_inv.id, v_inv.id, 'PROFORMA_CONVERTED', 'DRAFT', 'DRAFT', null,
      jsonb_build_object('proforma_number', v_inv.proforma_number));
    v_inv.is_proforma := false;
  end if;
  -- The invoice's own checks first (status, over-invoicing, GST data), so a refused invoice
  -- never dispatches anything and the user sees the real reason.
  if v_inv.status in ('DRAFT', 'PENDING_APPROVAL') and not v_inv.is_proforma then
    perform 1 from public.sales_order_lines where id in (select sales_order_line_id from public.sales_invoice_lines where invoice_id = v_inv.id and sales_order_line_id is not null)
      order by id for update;
    perform private.invoice_recalculate(v_inv.id);
    v_issues := private.invoice_issues(v_inv.id);
    if exists (select 1 from jsonb_array_elements(v_issues) i where i ->> 'severity' = 'BLOCK') then
      raise exception 'The invoice cannot be issued: %', (select string_agg(i ->> 'message', ' ') from jsonb_array_elements(v_issues) i where i ->> 'severity' = 'BLOCK')
        using errcode = 'P0001';
    end if;
  end if;
  -- Posting is the dispatch: stock lines not yet covered by a posted dispatch are dispatched now
  -- (same transaction; the dispatch-before-posting trigger verifies the result).
  v_dispatch := case when v_inv.status in ('DRAFT', 'PENDING_APPROVAL') and not v_inv.is_proforma
    then private.invoice_dispatch_on_posting(v_company, v_inv.id, p_idempotency_key) else '[]'::jsonb end;
  v_result := private.invoice_v2_issue_core(v_company, v_inv.id, null);
  v_partial := private.invoice_partial_notice(v_company, v_inv.id);
  return private.idempotency_finish(v_company, p_idempotency_key, v_result
    || jsonb_build_object('dispatched_on_posting', v_dispatch, 'partial_invoice', coalesce(v_partial, jsonb_build_object('partial', false))));
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. Read-only RPCs
-- -----------------------------------------------------------------------------
-- Dispatch status of an invoice before posting. Sales-order stock lines that are not yet
-- dispatched are dispatched when the invoice is posted (DISPATCH_ON_POSTING); only lines
-- that cannot be dispatched that way (manual lines, unit mismatch) block posting.
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
  select coalesce(jsonb_agg(
      case when d.applies and d.remaining > 0 and d.reason is null and il.sales_order_line_id is not null and il.fulfilment_line_id is null
        then to_jsonb(d) || jsonb_build_object('status', 'DISPATCH_ON_POSTING', 'dispatch_on_posting', d.remaining)
        else to_jsonb(d) || jsonb_build_object('dispatch_on_posting', 0) end
      order by d.line_no), '[]'::jsonb)
    into v_lines
  from private.invoice_dispatch_lines(v_inv.id) d
  left join public.sales_invoice_lines il on il.invoice_id = v_inv.id and il.line_no = d.line_no;
  return jsonb_build_object('invoice_id', v_inv.id, 'invoice_status', v_inv.status, 'sales_order_id', v_inv.sales_order_id,
    'lines', v_lines,
    'stock_lines', (select count(*) from jsonb_array_elements(v_lines) x where (x ->> 'applies')::boolean),
    'outstanding_lines', (select count(*) from jsonb_array_elements(v_lines) x where (x ->> 'applies')::boolean and (x ->> 'remaining')::numeric > 0
                            and x ->> 'status' <> 'DISPATCH_ON_POSTING'),
    'dispatch_on_posting_lines', (select count(*) from jsonb_array_elements(v_lines) x where x ->> 'status' = 'DISPATCH_ON_POSTING'),
    'ready', not exists (select 1 from jsonb_array_elements(v_lines) x where (x ->> 'applies')::boolean and (x ->> 'remaining')::numeric > 0
                           and x ->> 'status' <> 'DISPATCH_ON_POSTING'),
    'checked_at', now());
end;
$$;

-- Partial-invoice warning data for an invoice (draft or posted).
create or replace function public.invoice_partial_preview(p_invoice_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('invoices.read');
  v_lines   jsonb;
begin
  if not exists (select 1 from public.sales_invoices where id = p_invoice_id and company_id = v_company) then
    raise exception 'Invoice not found in your company.' using errcode = 'P0001';
  end if;
  select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) into v_lines from private.invoice_order_lines(p_invoice_id) x;
  return jsonb_build_object('invoice_id', p_invoice_id, 'lines', v_lines,
    'partial', exists (select 1 from jsonb_array_elements(v_lines) x where (x ->> 'remaining')::numeric > 0));
end;
$$;

-- Pending / Incomplete Invoice Orders register and the related reports.
-- p_filters: customer_id, product_id, sales_order_id, search (order number / customer / SKU),
--            invoice_number, from, to (order date), status, pending_only (default true)
create or replace function public.sales_invoice_tracking(p_filters jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_any_permission(array['invoices.read', 'sales_orders.read', 'inventory.read']);
  f         jsonb := coalesce(p_filters, '{}'::jsonb);
  v_search  text := nullif(btrim(coalesce(f ->> 'search', '')), '');
  v_inv     text := nullif(btrim(coalesce(f ->> 'invoice_number', '')), '');
  v_from    date := nullif(f ->> 'from', '')::date;
  v_to      date := nullif(f ->> 'to', '')::date;
  v_lines   jsonb;
begin
  select coalesce(jsonb_agg(to_jsonb(t) order by t.order_date desc, t.sales_order_number desc, t.line_no), '[]'::jsonb) into v_lines
  from private.so_invoice_tracking_lines(v_company) t
  where (nullif(f ->> 'customer_id', '') is null or t.customer_id = (f ->> 'customer_id')::uuid)
    and (nullif(f ->> 'product_id', '') is null or t.product_id = (f ->> 'product_id')::uuid)
    and (nullif(f ->> 'sales_order_id', '') is null or t.sales_order_id = (f ->> 'sales_order_id')::uuid)
    and (v_search is null or t.sales_order_number ilike '%' || v_search || '%' or t.customer_name ilike '%' || v_search || '%'
         or t.sku ilike '%' || v_search || '%' or t.product_name ilike '%' || v_search || '%')
    and (v_inv is null or exists (select 1 from unnest(t.invoice_numbers) n where n ilike '%' || v_inv || '%'))
    and (v_from is null or t.order_date >= v_from) and (v_to is null or t.order_date <= v_to)
    and (nullif(f ->> 'status', '') is null or t.status = f ->> 'status')
    and (coalesce((f ->> 'pending_only')::boolean, true) = false or t.pending > 0);

  return jsonb_build_object(
    'lines', v_lines,
    'totals', coalesce((select jsonb_agg(jsonb_build_object('unit', u, 'ordered', o, 'invoiced', i, 'pending', p, 'released', r) order by u)
      from (select x ->> 'unit' u, sum((x ->> 'effective')::numeric + (x ->> 'released')::numeric) o, sum((x ->> 'invoiced')::numeric) i,
                   sum((x ->> 'pending')::numeric) p, sum((x ->> 'released')::numeric) r
            from jsonb_array_elements(v_lines) x group by x ->> 'unit') s), '[]'::jsonb),
    'partial_invoices', coalesce((
      select jsonb_agg(jsonb_build_object('invoice_id', e.invoice_id, 'invoice_number', e.details ->> 'invoice_number', 'invoice_date', e.details ->> 'invoice_date',
          'customer', e.details ->> 'customer', 'sales_orders', e.details ->> 'sales_orders', 'posted_by', e.details ->> 'posted_by', 'posted_at', e.created_at,
          'lines', e.details -> 'lines') order by e.created_at desc)
      from public.billing_events e
      where e.company_id = v_company and e.event_type = 'PARTIAL_INVOICE'
        and (v_from is null or e.created_at >= v_from) and (v_to is null or e.created_at < v_to + 1)
        and (v_inv is null or e.details ->> 'invoice_number' ilike '%' || v_inv || '%')), '[]'::jsonb),
    'releases', coalesce((
      select jsonb_agg(jsonb_build_object('sales_order_id', e.sales_order_id, 'sales_order_number', so.sales_order_number, 'customer', so.customer_name_snapshot,
          'line_id', e.line_id, 'sku', e.details ->> 'sku', 'product_name', e.details ->> 'product_name', 'unit', e.details ->> 'unit',
          'quantity', (e.details ->> 'quantity')::numeric, 'ordered', (e.details ->> 'ordered')::numeric, 'invoiced', (e.details ->> 'invoiced')::numeric,
          'invoice_numbers', e.details -> 'invoice_numbers', 'reason', e.note, 'released_by', private.user_label(e.actor_user_id), 'released_at', e.created_at)
        order by e.created_at desc)
      from public.sales_order_events e join public.sales_orders so on so.id = e.sales_order_id
      where e.company_id = v_company and e.event_type = 'PENDING_INVOICE_RELEASED'
        and (nullif(f ->> 'customer_id', '') is null or so.customer_id = (f ->> 'customer_id')::uuid)
        and (nullif(f ->> 'sales_order_id', '') is null or so.id = (f ->> 'sales_order_id')::uuid)
        and (v_from is null or e.created_at >= v_from) and (v_to is null or e.created_at < v_to + 1)), '[]'::jsonb),
    'checked_at', now());
end;
$$;

revoke all on function public.invoice_partial_preview(uuid) from public, anon;
revoke all on function public.sales_invoice_tracking(jsonb) from public, anon;
grant execute on function public.invoice_partial_preview(uuid) to authenticated;
grant execute on function public.sales_invoice_tracking(jsonb) to authenticated;

-- -----------------------------------------------------------------------------
-- 4. Release a pending (uninvoiced) quantity
-- -----------------------------------------------------------------------------
create or replace function public.sales_order_line_release_pending(p_line_id uuid, p_quantity numeric, p_reason text, p_idempotency_key uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company  uuid := private.require_permission('sales_orders.cancel');
  v_prev     jsonb;
  v_line     public.sales_order_lines;
  v_so       public.sales_orders;
  v_reason   text := nullif(btrim(coalesce(p_reason, '')), '');
  v_t        record;
  v_upd      jsonb;
  v_mat      numeric := 0;
  v_event    uuid;
  v_details  jsonb;
begin
  v_prev := private.idempotency_begin(v_company, p_idempotency_key, 'sales_order_line_release_pending');
  if v_prev is not null then return v_prev; end if;
  select * into v_line from public.sales_order_lines where id = p_line_id and company_id = v_company;
  if not found then
    raise exception 'Sales order line not found in your company.' using errcode = 'P0001';
  end if;
  select * into v_so from public.sales_orders where id = v_line.sales_order_id for update;
  select * into v_line from public.sales_order_lines where id = p_line_id for update;
  if v_so.order_status in ('DRAFT', 'PENDING_CONFIRMATION', 'CANCELLED') then
    raise exception 'Only a confirmed, open sales order can release a pending quantity.' using errcode = 'P0001';
  end if;
  if v_reason is null or length(v_reason) < 5 or length(v_reason) > 500 then
    raise exception 'Give the reason for the release (5 to 500 characters).' using errcode = 'P0001';
  end if;
  select * into v_t from private.so_invoice_tracking_lines(v_company) t where t.line_id = v_line.id;
  if p_quantity is null or p_quantity <= 0 or p_quantity <> round(p_quantity, 3) or (private.is_whole_unit(v_line.unit) and p_quantity <> trunc(p_quantity)) then
    raise exception 'Line % (%): enter a valid quantity to release.', v_line.line_no, v_line.sku_snapshot using errcode = 'P0001';
  end if;
  if p_quantity > v_t.releasable then
    raise exception 'Line % (%): only % % can be released. Invoiced quantities, quantities on draft invoices and goods already dispatched cannot be released.',
      v_line.line_no, v_line.sku_snapshot, trim_scale(v_t.releasable), v_line.unit using errcode = 'P0001';
  end if;

  -- Existing customer-approved line reduction: quantity_cancelled + release of the freed
  -- finished-goods reservation (no stock movement).
  v_upd := public.sales_order_line_update(v_line.id, null, null, p_quantity, 'Pending invoice quantity released: ' || v_reason);
  -- Nothing left to dispatch on the line: its material reservations are released too.
  if v_line.quantity_ordered - v_line.quantity_cancelled - p_quantity - v_line.quantity_dispatched <= 0 then
    v_mat := private.so_v2_release_materials(v_so.id, v_line.id);
  end if;

  v_details := jsonb_build_object('quantity', p_quantity, 'line_no', v_line.line_no, 'sku', v_line.sku_snapshot, 'product_name', v_line.product_name_snapshot,
    'unit', v_line.unit, 'ordered', v_line.quantity_ordered, 'invoiced', v_t.invoiced, 'pending_before', v_t.pending,
    'pending_after', greatest(v_t.pending - p_quantity, 0), 'invoice_numbers', to_jsonb(coalesce(v_t.invoice_numbers, '{}'::text[])),
    'latest_invoice_id', v_t.latest_invoice_id, 'reservation_released', v_upd -> 'released_quantity', 'materials_released', v_mat);
  insert into public.sales_order_events (company_id, sales_order_id, line_id, event_type, from_status, to_status, note, details, actor_user_id)
  values (v_company, v_so.id, v_line.id, 'PENDING_INVOICE_RELEASED', v_t.status, null, v_reason, v_details, auth.uid())
  returning id into v_event;
  insert into public.audit_logs (company_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (v_company, auth.uid(), 'sales_order.pending_released', 'sales_order', v_so.id::text,
    v_details || jsonb_build_object('sales_order_number', v_so.sales_order_number, 'reason', v_reason));
  perform private.notify_super_admins(v_company, 'PENDING_INVOICE_RELEASED', 'Pending Order Quantity Released',
    left(format(E'Sales Order: %s\nCustomer: %s\nProduct: %s %s\nOrdered: %s %s, invoiced: %s, released: %s, still pending: %s\nInvoice(s): %s\nReason: %s\nReleased by %s.',
      v_so.sales_order_number, v_so.customer_name_snapshot, v_line.sku_snapshot, v_line.product_name_snapshot, trim_scale(v_line.quantity_ordered), v_line.unit,
      trim_scale(v_t.invoiced), trim_scale(p_quantity), trim_scale(greatest(v_t.pending - p_quantity, 0)),
      coalesce(array_to_string(v_t.invoice_numbers, ', '), 'none'), v_reason, private.user_label(auth.uid())), 1000),
    'MEDIUM', 'SALES_ORDER', v_so.id::text, '/sales/orders/' || v_so.id::text, 'PENDING_INVOICE_RELEASED:' || v_event::text);

  select * into v_t from private.so_invoice_tracking_lines(v_company) t where t.line_id = v_line.id;
  return private.idempotency_finish(v_company, p_idempotency_key, jsonb_build_object('line_id', v_line.id, 'released', p_quantity,
    'pending', v_t.pending, 'status', v_t.status, 'order_status', v_upd ->> 'status', 'reservation_released', v_upd -> 'released_quantity',
    'materials_released', v_mat));
end;
$$;

revoke all on function public.sales_order_line_release_pending(uuid, numeric, text, uuid) from public, anon;
grant execute on function public.sales_order_line_release_pending(uuid, numeric, text, uuid) to authenticated;

notify pgrst, 'reload schema';
