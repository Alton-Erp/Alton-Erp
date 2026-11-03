-- =============================================================================
-- Phase 8: billing overview, receivables / ageing and billing reports
--
-- Management reports from issued records only (drafts, discarded and - unless
-- stated - cancelled documents are excluded). Each total is computed per
-- document first, so joins never duplicate amounts. These are NOT GST returns.
-- =============================================================================

-- Balance of an issued invoice as of a date: credit / debit notes issued on or
-- before the date and payment allocations dated on or before it that were not
-- reversed by then. Invoices cancelled on or before the date have no balance.
create or replace function private.invoice_position_as_of(p_company uuid, p_as_of date)
returns table (
  invoice_id uuid, invoice_number text, invoice_date date, due_date date, customer_id uuid, customer_name text, customer_code text,
  grand_total numeric, credited numeric, debited numeric, paid numeric, balance numeric, days_overdue integer, bucket text
)
language sql
stable
security definer
set search_path = ''
as $$
  with tz as (select private.company_tz(p_company) as tz),
  inv as (
    select i.*,
      coalesce((select sum(n.total_amount) from public.invoice_adjustment_notes n where n.original_invoice_id = i.id and n.note_type = 'CREDIT'
        and n.status in ('ISSUED', 'CANCELLED') and n.note_date <= p_as_of and (n.cancelled_at is null or (n.cancelled_at at time zone (select tz from tz))::date > p_as_of)), 0) as cr,
      coalesce((select sum(n.total_amount) from public.invoice_adjustment_notes n where n.original_invoice_id = i.id and n.note_type = 'DEBIT'
        and n.status in ('ISSUED', 'CANCELLED') and n.note_date <= p_as_of and (n.cancelled_at is null or (n.cancelled_at at time zone (select tz from tz))::date > p_as_of)), 0) as dr,
      coalesce((select sum(a.allocated_amount) from public.invoice_payment_allocations a where a.invoice_id = i.id and a.allocation_date <= p_as_of
        and (a.status = 'ACTIVE' or (a.reversed_at at time zone (select tz from tz))::date > p_as_of)), 0) as pd
    from public.sales_invoices i
    where i.company_id = p_company and i.status in ('ISSUED', 'CANCELLED') and i.invoice_date <= p_as_of
      and (i.cancelled_at is null or (i.cancelled_at at time zone (select tz from tz))::date > p_as_of)
  )
  select inv.id, inv.invoice_number, inv.invoice_date, inv.due_date, inv.customer_id, inv.customer_legal_name, inv.customer_code_snapshot,
    inv.grand_total, inv.cr, inv.dr, inv.pd, inv.grand_total - inv.cr + inv.dr - inv.pd,
    greatest(p_as_of - inv.due_date, 0),
    case when p_as_of <= inv.due_date then 'NOT_DUE' when p_as_of - inv.due_date <= 30 then '1_30' when p_as_of - inv.due_date <= 60 then '31_60'
         when p_as_of - inv.due_date <= 90 then '61_90' else 'OVER_90' end
  from inv;
$$;

revoke all on function private.invoice_position_as_of(uuid, date) from public, anon, authenticated;

-- Outstanding receivables / ageing as of a reporting date.
create or replace function public.billing_receivables(p_as_of date, p_customer_id uuid default null, p_bucket text default null)
returns setof jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_any_permission(array['billing_reports.read', 'payments.read']);
begin
  if p_as_of is null or p_as_of > private.company_today(v_company) + 366 then
    raise exception 'Choose a valid reporting date.' using errcode = 'P0001';
  end if;
  return query
  select to_jsonb(x) from (
    select * from private.invoice_position_as_of(v_company, p_as_of) p
    where p.balance <> 0 and (p_customer_id is null or p.customer_id = p_customer_id) and (p_bucket is null or p.bucket = p_bucket)
    order by p.days_overdue desc, p.due_date, p.invoice_number) x;
end;
$$;

create or replace function public.billing_overview(
  p_from           date,
  p_to             date,
  p_customer_id    uuid default null,
  p_status         text default null,
  p_payment_status text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_any_permission(array['billing_reports.read', 'invoices.read']);
  v_today   date := private.company_today(v_company);
  v_result  jsonb;
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 3700 then
    raise exception 'Choose a valid date range.' using errcode = 'P0001';
  end if;
  with cur as (
    select * from private.invoice_position_as_of(v_company, v_today) p where p_customer_id is null or p.customer_id = p_customer_id
  ),
  period_inv as (
    select l.* from public.sales_invoice_list l
    where l.company_id = v_company and l.status = 'ISSUED' and l.invoice_date between p_from and p_to
      and (p_customer_id is null or l.customer_id = p_customer_id)
      and (p_status is null or l.display_status = p_status)
      and (p_payment_status is null or l.payment_status = p_payment_status)
  ),
  receipts as (
    select p.* from public.customer_payments p
    where p.company_id = v_company and p.status = 'RECORDED' and p.receipt_date between p_from and p_to and (p_customer_id is null or p.customer_id = p_customer_id)
  ),
  months as (
    select generate_series(date_trunc('month', p_from::timestamp), date_trunc('month', p_to::timestamp), interval '1 month')::date as m
  )
  select jsonb_build_object(
    'has_records', exists (select 1 from public.sales_invoices where company_id = v_company and status <> 'DISCARDED'),
    'currency', (select currency_code from public.companies where id = v_company),
    'invoiced_total', (select coalesce(sum(grand_total), 0) from period_inv),
    'received_total', (select coalesce(sum(amount_received), 0) from receipts),
    'outstanding_total', (select coalesce(sum(balance), 0) from cur where balance > 0),
    'overdue_total', (select coalesce(sum(balance), 0) from cur where balance > 0 and bucket <> 'NOT_DUE'),
    'customer_credit_total', (select coalesce(-sum(balance), 0) from cur where balance < 0),
    'unallocated_receipts_total', (select coalesce(sum(amount_received - private.payment_allocated(id)), 0) from public.customer_payments
      where company_id = v_company and status = 'RECORDED' and (p_customer_id is null or customer_id = p_customer_id)),
    'invoices_issued', (select count(*) from period_inv),
    'drafts_awaiting', (select count(*) from public.sales_invoices where company_id = v_company and status in ('DRAFT', 'PENDING_APPROVAL')
      and (p_customer_id is null or customer_id = p_customer_id)),
    'pending_approval', (select count(*) from public.sales_invoices where company_id = v_company and status = 'PENDING_APPROVAL'
      and (p_customer_id is null or customer_id = p_customer_id)),
    'partially_paid', (select count(*) from period_inv where payment_status = 'PARTIALLY_PAID'),
    'fully_paid', (select count(*) from period_inv where payment_status = 'PAID'),
    'monthly', (select coalesce(jsonb_agg(jsonb_build_object('month', m, 'invoiced', inv, 'collected', col) order by m), '[]'::jsonb) from (
        select months.m,
          (select coalesce(sum(grand_total), 0) from period_inv where date_trunc('month', invoice_date::timestamp)::date = months.m) as inv,
          (select coalesce(sum(amount_received), 0) from receipts where date_trunc('month', receipt_date::timestamp)::date = months.m) as col
        from months) x),
    'outstanding_by_customer', (select coalesce(jsonb_agg(x order by x.balance desc), '[]'::jsonb) from (
        select customer_id, max(customer_name) as customer_name, sum(balance) as balance, sum(balance) filter (where bucket <> 'NOT_DUE') as overdue
        from cur where balance > 0 group by customer_id order by sum(balance) desc limit 10) x),
    'ageing', (select jsonb_agg(jsonb_build_object('bucket', b, 'amount', coalesce((select sum(balance) from cur where bucket = b and balance > 0), 0),
        'invoices', (select count(*) from cur where bucket = b and balance > 0))) from unnest(array['NOT_DUE', '1_30', '31_60', '61_90', 'OVER_90']) b),
    'top_customers', (select coalesce(jsonb_agg(x order by x.invoiced desc), '[]'::jsonb) from (
        select customer_id, max(customer_legal_name) as customer_name, sum(grand_total) as invoiced, count(*) as invoices
        from period_inv group by customer_id order by sum(grand_total) desc limit 10) x),
    'recent_invoices', (select coalesce(jsonb_agg(x order by x.issued_at desc), '[]'::jsonb) from (
        select id, invoice_number, invoice_date, customer_legal_name, grand_total, balance_due, display_status, issued_at
        from public.sales_invoice_list where company_id = v_company and status = 'ISSUED' and (p_customer_id is null or customer_id = p_customer_id)
        order by issued_at desc limit 8) x),
    'recent_receipts', (select coalesce(jsonb_agg(x order by x.created_at desc), '[]'::jsonb) from (
        select id, receipt_number, receipt_date, customer_name, amount_received, unallocated_amount, payment_method, status, created_at
        from public.customer_payment_list where company_id = v_company and (p_customer_id is null or customer_id = p_customer_id)
        order by created_at desc limit 8) x),
    'overdue_invoices', (select coalesce(jsonb_agg(x order by x.days_overdue desc), '[]'::jsonb) from (
        select invoice_id, invoice_number, customer_name, due_date, balance, days_overdue from cur where balance > 0 and bucket <> 'NOT_DUE'
        order by days_overdue desc limit 10) x),
    'as_of', now(), 'today', v_today
  ) into v_result;
  return v_result;
end;
$$;

-- Reports (rows as jsonb). Dates are document dates unless stated.
create or replace function public.billing_report(p_report text, p_from date, p_to date, p_customer_id uuid default null, p_status text default null)
returns setof jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('billing_reports.read');
  v_tz      text := private.company_tz(v_company);
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 3700 then
    raise exception 'Choose a valid date range (at most about 10 years).' using errcode = 'P0001';
  end if;

  if p_report = 'INVOICES' then
    return query select to_jsonb(x) from (
      select l.invoice_number, l.invoice_date, l.due_date, l.financial_year, l.customer_legal_name as customer, l.customer_gstin, l.place_of_supply_state_code as place_of_supply,
        l.tax_treatment, l.taxable_subtotal, l.cgst_total, l.sgst_total, l.igst_total, l.round_off, l.grand_total, l.credited, l.debited, l.paid, l.balance_due,
        l.display_status, l.order_references, l.dispatch_references
      from public.sales_invoice_list l
      where l.company_id = v_company and l.status = 'ISSUED' and l.invoice_date between p_from and p_to
        and (p_customer_id is null or l.customer_id = p_customer_id) and (p_status is null or l.display_status = p_status)
      order by l.invoice_date, l.invoice_number) x;

  elsif p_report in ('BY_GST_RATE', 'HSN_SUMMARY') then
    return query select to_jsonb(x) from (
      select src as document_type, case when p_report = 'HSN_SUMMARY' then hsn_sac end as hsn_sac, case when p_report = 'HSN_SUMMARY' then unit end as unit,
        gst_rate, sum(quantity) as quantity, sum(taxable) as taxable_value, sum(cgst) as cgst, sum(sgst) as sgst, sum(igst) as igst, sum(taxable + cgst + sgst + igst) as total
      from (
        select 'INVOICES' as src, il.hsn_sac, il.unit, il.gst_rate, il.quantity, il.taxable_value as taxable, il.cgst_amount as cgst, il.sgst_amount as sgst, il.igst_amount as igst
        from public.sales_invoice_lines il join public.sales_invoices i on i.id = il.invoice_id
        where i.company_id = v_company and i.status = 'ISSUED' and i.invoice_date between p_from and p_to and (p_customer_id is null or i.customer_id = p_customer_id)
        union all
        select case n.note_type when 'CREDIT' then 'CREDIT_NOTES' else 'DEBIT_NOTES' end, nl.hsn_sac, il.unit, nl.gst_rate, nl.quantity,
          nl.taxable_amount, nl.cgst_amount, nl.sgst_amount, nl.igst_amount
        from public.invoice_adjustment_note_lines nl join public.invoice_adjustment_notes n on n.id = nl.note_id join public.sales_invoice_lines il on il.id = nl.invoice_line_id
        where n.company_id = v_company and n.status = 'ISSUED' and n.note_date between p_from and p_to and (p_customer_id is null or n.customer_id = p_customer_id)
      ) t
      group by src, case when p_report = 'HSN_SUMMARY' then hsn_sac end, case when p_report = 'HSN_SUMMARY' then unit end, gst_rate
      order by 1, 2, 4) x;

  elsif p_report = 'TAX_COMPONENTS' then
    return query select to_jsonb(x) from (
      select to_char(m, 'YYYY-MM') as month, sum(taxable) as taxable_value, sum(cgst) as cgst, sum(sgst) as sgst, sum(igst) as igst, sum(cgst + sgst + igst) as total_tax
      from (
        select date_trunc('month', invoice_date::timestamp) m, taxable_subtotal taxable, cgst_total cgst, sgst_total sgst, igst_total igst
        from public.sales_invoices where company_id = v_company and status = 'ISSUED' and invoice_date between p_from and p_to and (p_customer_id is null or customer_id = p_customer_id)
        union all
        select date_trunc('month', note_date::timestamp), case note_type when 'CREDIT' then -1 else 1 end * taxable_amount, case note_type when 'CREDIT' then -1 else 1 end * cgst_amount,
          case note_type when 'CREDIT' then -1 else 1 end * sgst_amount, case note_type when 'CREDIT' then -1 else 1 end * igst_amount
        from public.invoice_adjustment_notes where company_id = v_company and status = 'ISSUED' and note_date between p_from and p_to and (p_customer_id is null or customer_id = p_customer_id)
      ) t group by m order by m) x;

  elsif p_report = 'CUSTOMER_WISE' then
    return query select to_jsonb(x) from (
      select l.customer_code_snapshot as customer_code, max(l.customer_legal_name) as customer, count(*) as invoices, sum(l.taxable_subtotal) as taxable_value,
        sum(l.cgst_total + l.sgst_total + l.igst_total) as tax, sum(l.grand_total) as invoiced, sum(l.credited) as credited, sum(l.debited) as debited,
        sum(l.paid) as received, sum(l.balance_due) as balance
      from public.sales_invoice_list l
      where l.company_id = v_company and l.status = 'ISSUED' and l.invoice_date between p_from and p_to and (p_customer_id is null or l.customer_id = p_customer_id)
      group by l.customer_id, l.customer_code_snapshot order by sum(l.grand_total) desc) x;

  elsif p_report = 'MONTHLY_INVOICING' then
    return query select to_jsonb(x) from (
      select to_char(date_trunc('month', invoice_date::timestamp), 'YYYY-MM') as month, count(*) as invoices, sum(taxable_subtotal) as taxable_value,
        sum(cgst_total + sgst_total + igst_total) as tax, sum(grand_total) as invoiced
      from public.sales_invoices where company_id = v_company and status = 'ISSUED' and invoice_date between p_from and p_to and (p_customer_id is null or customer_id = p_customer_id)
      group by 1 order by 1) x;

  elsif p_report = 'COLLECTIONS_BY_MONTH' then
    return query select to_jsonb(x) from (
      select to_char(date_trunc('month', receipt_date::timestamp), 'YYYY-MM') as month, count(*) filter (where status = 'RECORDED') as receipts,
        coalesce(sum(amount_received) filter (where status = 'RECORDED'), 0) as received, count(*) filter (where status = 'REVERSED') as reversed_receipts,
        coalesce(sum(amount_received) filter (where status = 'REVERSED'), 0) as reversed_amount
      from public.customer_payments where company_id = v_company and receipt_date between p_from and p_to and (p_customer_id is null or customer_id = p_customer_id)
      group by 1 order by 1) x;

  elsif p_report in ('OUTSTANDING', 'OVERDUE') then
    return query select to_jsonb(x) from (
      select * from private.invoice_position_as_of(v_company, p_to) p
      where p.balance <> 0 and (p_report = 'OUTSTANDING' or (p.balance > 0 and p.bucket <> 'NOT_DUE')) and (p_customer_id is null or p.customer_id = p_customer_id)
      order by p.days_overdue desc, p.invoice_number) x;

  elsif p_report = 'NOTES' then
    return query select to_jsonb(x) from (
      select n.note_number, n.note_type, n.note_date, n.status, n.customer_name as customer, n.invoice_number, n.reason_code, n.reason, n.taxable_amount,
        n.cgst_amount, n.sgst_amount, n.igst_amount, n.total_amount, n.return_number, n.tax_review_note
      from public.adjustment_note_list n
      where n.company_id = v_company and n.status in ('ISSUED', 'CANCELLED') and n.note_date between p_from and p_to and (p_customer_id is null or n.customer_id = p_customer_id)
        and (p_status is null or n.status = p_status)
      order by n.note_date, n.note_number) x;

  elsif p_report = 'UNALLOCATED_RECEIPTS' then
    return query select to_jsonb(x) from (
      select receipt_number, receipt_date, customer_name as customer, payment_method, transaction_reference, amount_received, allocated_amount, unallocated_amount
      from public.customer_payment_list
      where company_id = v_company and status = 'RECORDED' and unallocated_amount > 0 and receipt_date <= p_to and (p_customer_id is null or customer_id = p_customer_id)
      order by receipt_date) x;

  elsif p_report = 'CANCELLED' then
    return query select to_jsonb(x) from (
      select 'INVOICE' as document_type, invoice_number as document_number, invoice_date as document_date, (cancelled_at at time zone v_tz)::date as cancelled_date,
        customer_legal_name as customer, grand_total as amount, cancellation_reason as reason
      from public.sales_invoices where company_id = v_company and status = 'CANCELLED' and (cancelled_at at time zone v_tz)::date between p_from and p_to
        and (p_customer_id is null or customer_id = p_customer_id)
      union all
      select note_type || '_NOTE', note_number, note_date, (cancelled_at at time zone v_tz)::date, (select coalesce(legal_name, customer_name) from public.customers c where c.id = n.customer_id),
        total_amount, cancellation_reason
      from public.invoice_adjustment_notes n where company_id = v_company and status = 'CANCELLED' and (cancelled_at at time zone v_tz)::date between p_from and p_to
        and (p_customer_id is null or customer_id = p_customer_id)
      union all
      select 'RECEIPT', receipt_number, receipt_date, (reversed_at at time zone v_tz)::date, (select coalesce(legal_name, customer_name) from public.customers c where c.id = p.customer_id),
        amount_received, reversal_reason
      from public.customer_payments p where company_id = v_company and status = 'REVERSED' and (reversed_at at time zone v_tz)::date between p_from and p_to
        and (p_customer_id is null or customer_id = p_customer_id)
      order by 4, 2) x;

  else
    raise exception 'Unknown report %.', p_report using errcode = 'P0001';
  end if;
end;
$$;

revoke all on function public.billing_receivables(date, uuid, text) from public, anon;
grant execute on function public.billing_receivables(date, uuid, text) to authenticated;
revoke all on function public.billing_overview(date, date, uuid, text, text) from public, anon;
grant execute on function public.billing_overview(date, date, uuid, text, text) to authenticated;
revoke all on function public.billing_report(text, date, date, uuid, text) from public, anon;
grant execute on function public.billing_report(text, date, date, uuid, text) to authenticated;
