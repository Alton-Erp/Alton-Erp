-- Rollback of 20261115090000_partial_invoicing.sql
-- Restores invoice posting of 20261107090000 (no dispatch on posting, no partial notice)
-- and the dispatch status of 20261112090000; removes the tracking, preview and release
-- functions. Invoices, dispatches, releases (quantity_cancelled), events, audit rows and
-- notifications already recorded are kept. No stock is changed.

begin;

drop function if exists public.sales_order_line_release_pending(uuid, numeric, text, uuid);
drop function if exists public.sales_invoice_tracking(jsonb);
drop function if exists public.invoice_partial_preview(uuid);

create or replace function public.sales_invoice_v2_issue(p_invoice_id uuid, p_convert_proforma boolean default false, p_idempotency_key uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('invoices.issue');
  v_prev    jsonb;
  v_inv     public.sales_invoices;
begin
  v_prev := private.idempotency_begin(v_company, p_idempotency_key, 'sales_invoice_v2_issue');
  if v_prev is not null then return v_prev; end if;
  v_inv := private.lock_invoice(v_company, p_invoice_id);
  if v_inv.is_proforma and coalesce(p_convert_proforma, false) then
    update public.sales_invoices set is_proforma = false where id = v_inv.id;
    perform private.log_billing_event(v_company, 'INVOICE', v_inv.id, v_inv.id, 'PROFORMA_CONVERTED', 'DRAFT', 'DRAFT', null,
      jsonb_build_object('proforma_number', v_inv.proforma_number));
  end if;
  return private.idempotency_finish(v_company, p_idempotency_key, private.invoice_v2_issue_core(v_company, v_inv.id, null));
end;
$$;

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

drop function if exists private.invoice_partial_notice(uuid, uuid);
drop function if exists private.invoice_order_lines(uuid);
drop function if exists private.invoice_dispatch_on_posting(uuid, uuid, uuid);
drop function if exists private.user_label(uuid);
drop function if exists private.notify_super_admins(uuid, text, text, text, text, text, text, text, text);
drop function if exists private.so_invoice_tracking_lines(uuid);
drop function if exists private.so_line_released(uuid);
drop function if exists private.so_line_posted_invoiced(uuid, uuid);

notify pgrst, 'reload schema';

commit;
