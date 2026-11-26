-- Rollback of 20261231090500_accounting_gst (Phase 5, Gate B).
--
-- Restores the Phase 3 GST verification / invoice reversal / GST-pending report, the posting-rule keys, the chart seed and the ERP reset
-- registries exactly as the previous migrations left them; drops the GST tables, functions and permissions; restores the purchase-invoice
-- GST status constraint (refused while an invoice is PARTIALLY_ELIGIBLE); removes the GST voucher type and the three GST ledgers only
-- when unused. Posted GST vouchers stay in the books. audit_logs stay.
--
-- Refused while any GST record exists. To roll back anyway, export it, then   set app.accounting_gst_rollback_force = 'on';   in the session.

do $$
begin
  if coalesce(current_setting('app.accounting_gst_rollback_force', true), '') <> 'on' and to_regclass('public.gst_registrations') is not null and (
       exists (select 1 from public.gst_period_current_snapshot) or
       exists (select 1 from public.gst_snapshot_documents) or
       exists (select 1 from public.gst_amendment_exceptions) or
       exists (select 1 from public.gst_set_off_lines) or
       exists (select 1 from public.gst_set_off_events) or
       exists (select 1 from public.gst_challan_heads) or
       exists (select 1 from public.gst_sales_document_detail_history) or
       exists (select 1 from public.gst_period_snapshots) or
       exists (select 1 from public.gst_challan_payments) or
       exists (select 1 from public.gst_set_offs) or
       exists (select 1 from public.gst_period_events) or
       exists (select 1 from public.gst_return_adjustments) or
       exists (select 1 from public.gst_sales_document_details) or
       exists (select 1 from public.gst_itc_decisions) or
       exists (select 1 from public.gst_itc_adjustments) or
       exists (select 1 from public.gst_challans) or
       exists (select 1 from public.gst_return_periods) or
       exists (select 1 from public.gst_hsn_rates) or
       exists (select 1 from public.gst_config_versions) or
       exists (select 1 from public.gst_registration_frequencies) or
       exists (select 1 from public.gst_registrations)) then
    raise exception 'GST records exist. Export them, then set app.accounting_gst_rollback_force = on to roll back.';
  end if;
  if exists (select 1 from public.purchase_invoices where gst_status = 'PARTIALLY_ELIGIBLE') then
    raise exception 'Purchase invoices with partial ITC exist; the previous GST status list cannot hold them.';
  end if;
end;
$$;

-- Functions as the previous migrations left them.
create or replace function public.purchase_invoice_verify_gst(p_invoice_id uuid, p_status text, p_reason text, p_checks jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('purchase_invoices.verify_gst');
  i         public.purchase_invoices := private.pi_lock(v_company, p_invoice_id, array['POSTED']);
  v_status  text := upper(coalesce(p_status, ''));
  v_lines   jsonb := '[]'::jsonb;
  v_total   numeric;
  v_pending uuid := private.accounting_rule_account(v_company, 'GST_INPUT_PENDING', '');
  v_id      uuid;
  v         public.accounting_vouchers;
  v_key     text;
  v_amt     numeric;
begin
  if i.gst_status <> 'PENDING_VERIFICATION' then
    raise exception 'The GST of this invoice is % — only pending GST can be verified.', lower(replace(i.gst_status, '_', ' ')) using errcode = 'P0001';
  end if;
  if v_status not in ('ELIGIBLE', 'INELIGIBLE') then
    raise exception 'Status must be ELIGIBLE or INELIGIBLE.' using errcode = '22023';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 10 then
    raise exception 'Record why (at least 10 characters), e.g. what was checked against the supplier invoice.' using errcode = '22023';
  end if;
  if v_status = 'ELIGIBLE' and not (coalesce((p_checks ->> 'invoice_verified')::boolean, false) and coalesce((p_checks ->> 'goods_services_received')::boolean, false)
      and coalesce((p_checks ->> 'gstin_valid')::boolean, false)) then
    raise exception 'Eligible input GST needs the checks: supplier invoice verified, goods / services received, supplier GSTIN valid.' using errcode = 'P0001';
  end if;
  v_total := i.cgst_total + i.sgst_total + i.igst_total + i.cess_total;
  if v_pending is null then
    raise exception 'Map the GST input pending verification account first.' using errcode = 'P0001';
  end if;
  if v_status = 'ELIGIBLE' then
    foreach v_key in array array['INPUT_CGST', 'INPUT_SGST', 'INPUT_IGST', 'INPUT_CESS'] loop
      v_amt := case v_key when 'INPUT_CGST' then i.cgst_total when 'INPUT_SGST' then i.sgst_total when 'INPUT_IGST' then i.igst_total else i.cess_total end;
      if v_amt > 0 then
        if private.accounting_rule_account(v_company, v_key, '') is null then
          raise exception 'Map an active account in Accounting Settings > Posting rules for %.', v_key using errcode = 'P0001';
        end if;
        v_lines := v_lines || jsonb_build_object('account_id', private.accounting_rule_account(v_company, v_key, ''), 'debit', v_amt, 'narration', 'Eligible input ' || replace(v_key, 'INPUT_', ''));
      end if;
    end loop;
  else
    if private.accounting_rule_account(v_company, 'GST_INPUT_INELIGIBLE', '') is null then
      raise exception 'Map an active account in Accounting Settings > Posting rules for the ineligible input GST expense.' using errcode = 'P0001';
    end if;
    v_lines := jsonb_build_array(jsonb_build_object('account_id', private.accounting_rule_account(v_company, 'GST_INPUT_INELIGIBLE', ''), 'debit', v_total,
      'narration', 'Ineligible input GST'));
  end if;
  v_lines := v_lines || jsonb_build_object('account_id', v_pending, 'credit', v_total, 'narration', 'Out of GST input pending verification');
  v_id := private.accounting_create_voucher(v_company, 'PIN', private.company_today(v_company), i.supplier_invoice_number,
    left(format('Input GST of supplier invoice %s (%s) verified %s', i.supplier_invoice_number, i.invoice_number, lower(v_status)), 1000),
    'AUTO', 'PURCHASE_INVOICE_GST', i.id, i.invoice_number, null, v_lines);
  v := private.accounting_post_voucher(v_id);
  update public.purchase_invoices set gst_status = v_status, gst_verified_by = auth.uid(), gst_verified_at = now(), gst_voucher_id = v.id,
    gst_verification = jsonb_build_object('status', v_status, 'reason', left(btrim(p_reason), 1000), 'checks', coalesce(p_checks, '{}'::jsonb)),
    updated_by = auth.uid(), updated_at = now(), row_version = row_version + 1 where id = i.id returning * into i;
  perform private.pi_log(i, 'GST_VERIFIED', p_reason, jsonb_build_object('status', v_status, 'amount', v_total, 'voucher_number', v.voucher_number, 'checks', p_checks));
  return private.pi_json(i.id);
end;
$$;

create or replace function public.purchase_invoice_reverse(p_invoice_id uuid, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('purchase_invoices.reverse');
  i         public.purchase_invoices := private.pi_lock(v_company, p_invoice_id, array['POSTED']);
  v1        public.accounting_vouchers;
  v2        public.accounting_vouchers;
begin
  if length(btrim(coalesce(p_reason, ''))) < 5 then
    raise exception 'A reversal reason of at least 5 characters is required.' using errcode = '22023';
  end if;
  if exists (select 1 from public.supplier_payment_allocations a join public.supplier_payments p on p.id = a.payment_id
             where a.invoice_id = i.id and a.status = 'ACTIVE' and p.status = 'RECORDED') then
    raise exception 'Payments are allocated to this invoice; remove the allocations first.' using errcode = 'P0001';
  end if;
  if i.gst_voucher_id is not null then
    v2 := private.accounting_reverse_voucher(i.gst_voucher_id, 'Supplier invoice reversed: ' || btrim(p_reason), null);
  end if;
  if i.voucher_id is not null then
    v1 := private.accounting_reverse_voucher(i.voucher_id, 'Supplier invoice reversed: ' || btrim(p_reason), null);
  end if;
  update public.purchase_invoices set status = 'REVERSED', reversed_by = auth.uid(), reversed_at = now(), reversal_reason = left(btrim(p_reason), 1000),
    updated_by = auth.uid(), updated_at = now(), row_version = row_version + 1 where id = i.id returning * into i;
  perform private.pi_log(i, 'REVERSED', p_reason, jsonb_build_object('reversal_voucher', v1.voucher_number, 'gst_reversal_voucher', v2.voucher_number));
  return private.pi_json(i.id);
end;
$$;

create or replace function public.purchase_invoice_report(p_report text, p_filters jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('purchase_invoices.read');
  f         jsonb := coalesce(p_filters, '{}'::jsonb);
  v_from    date := coalesce(private.accounting_date(f, 'from', 'From'), date '2000-01-01');
  v_to      date := coalesce(private.accounting_date(f, 'to', 'To'), private.company_today(v_company));
  v_asof    date := coalesce(private.accounting_date(f, 'as_of', 'As of'), private.company_today(v_company));
  v_sup     uuid := private.accounting_uuid(f, 'supplier_id', 'Supplier');
  v_rep     text := upper(coalesce(p_report, ''));
begin
  if v_rep = 'PURCHASE_REGISTER' or v_rep = 'SUPPLIER_INVOICE_REGISTER' then
    return jsonb_build_object('report', v_rep, 'rows', coalesce((select jsonb_agg(jsonb_build_object('invoice_number', i.invoice_number, 'supplier_invoice_number', i.supplier_invoice_number,
        'supplier_invoice_date', i.supplier_invoice_date, 'recorded_date', i.recorded_date, 'supplier', coalesce(s.display_name, s.legal_name), 'supplier_gstin', i.supplier_gstin,
        'invoice_type', i.invoice_type, 'status', i.status, 'reverse_charge', i.reverse_charge, 'taxable_value', i.taxable_value, 'cgst', i.cgst_total, 'sgst', i.sgst_total,
        'igst', i.igst_total, 'cess', i.cess_total, 'grand_total', i.grand_total, 'gst_status', i.gst_status,
        'voucher_number', (select voucher_number from public.accounting_vouchers where id = i.voucher_id)) order by i.recorded_date, i.invoice_number)
      from public.purchase_invoices i join public.suppliers s on s.id = i.supplier_id
      where i.company_id = v_company and i.recorded_date between v_from and v_to and (v_sup is null or i.supplier_id = v_sup)
        and (v_rep = 'SUPPLIER_INVOICE_REGISTER' or i.status in ('POSTED', 'REVERSED'))), '[]'::jsonb));
  elsif v_rep in ('OUTSTANDING', 'AGEING') then
    return (with o as (
      select i.id, i.invoice_number, i.supplier_invoice_number, i.supplier_invoice_date, i.due_date, i.grand_total, i.supplier_id, coalesce(s.display_name, s.legal_name) as supplier,
             i.party_id, private.pi_outstanding(i.id) as outstanding, greatest(v_asof - coalesce(i.due_date, i.supplier_invoice_date), 0) as overdue_days,
             v_asof <= coalesce(i.due_date, i.supplier_invoice_date) as not_due
      from public.purchase_invoices i join public.suppliers s on s.id = i.supplier_id
      where i.company_id = v_company and i.status = 'POSTED' and i.recorded_date <= v_asof and (v_sup is null or i.supplier_id = v_sup)
    )
    select jsonb_build_object('report', v_rep, 'as_of', v_asof,
      'rows', case when v_rep = 'OUTSTANDING' then coalesce((select jsonb_agg(jsonb_build_object('invoice_id', o.id, 'invoice_number', o.invoice_number,
          'supplier_invoice_number', o.supplier_invoice_number, 'supplier_invoice_date', o.supplier_invoice_date, 'due_date', o.due_date, 'supplier', o.supplier,
          'grand_total', o.grand_total, 'paid', o.grand_total - o.outstanding, 'outstanding', o.outstanding, 'overdue_days', o.overdue_days,
          'payment_status', case when o.outstanding = 0 then 'PAID' when o.outstanding < o.grand_total then 'PARTLY_PAID' else 'UNPAID' end) order by o.due_date)
        from o where o.outstanding > 0), '[]'::jsonb)
      else coalesce((select jsonb_agg(jsonb_build_object('supplier_id', ag.supplier_id, 'supplier', ag.supplier, 'not_due', ag.nd, 'd1_30', ag.b1, 'd31_60', ag.b2, 'd61_90', ag.b3,
          'd90_plus', ag.b4, 'total', ag.nd + ag.b1 + ag.b2 + ag.b3 + ag.b4,
          -- Accounting figure: the supplier's Creditors balance in the ledger (includes receipts not yet invoiced, payments on account and openings).
          'ledger_creditors', coalesce((select sum(l.credit - l.debit) from public.accounting_voucher_lines l join public.accounting_vouchers v on v.id = l.voucher_id
             join public.accounts a on a.id = l.account_id where l.party_id = ag.party_id and a.account_nature = 'PAYABLE_CONTROL' and v.status in ('POSTED', 'REVERSED')
             and v.voucher_date <= v_asof), 0)) order by ag.supplier)
        from (select supplier_id, supplier, party_id,
                     coalesce(sum(outstanding) filter (where not_due), 0) as nd,
                     coalesce(sum(outstanding) filter (where not not_due and overdue_days <= 30), 0) as b1,
                     coalesce(sum(outstanding) filter (where not not_due and overdue_days between 31 and 60), 0) as b2,
                     coalesce(sum(outstanding) filter (where not not_due and overdue_days between 61 and 90), 0) as b3,
                     coalesce(sum(outstanding) filter (where not not_due and overdue_days > 90), 0) as b4
              from o where outstanding > 0 group by supplier_id, supplier, party_id) ag), '[]'::jsonb) end));
  elsif v_rep = 'GRN_RECONCILIATION' then
    return jsonb_build_object('report', v_rep, 'rows', coalesce((select jsonb_agg(jsonb_build_object('receipt_number', g.receipt_number, 'receipt_date', g.receipt_date,
        'supplier', coalesce(s.display_name, s.legal_name), 'description', v.description, 'accepted_quantity', l.accepted_quantity, 'receipt_payable', v.payable,
        'invoiced_quantity', coalesce(pi.qty, 0), 'receipt_share_invoiced', coalesce(pi.share, 0), 'invoiced_amount', coalesce(pi.amount, 0),
        'difference_posted', coalesce(pi.amount, 0) - coalesce(pi.share, 0), 'uninvoiced_quantity', l.accepted_quantity - coalesce(pi.qty, 0),
        'uninvoiced_payable', v.payable - coalesce(pi.share, 0),
        'state', case when coalesce(pi.qty, 0) = 0 then 'NOT_INVOICED' when pi.qty < l.accepted_quantity then 'PARTLY_INVOICED' else 'FULLY_INVOICED' end,
        'invoices', pi.numbers) order by g.receipt_date, g.receipt_number)
      from public.goods_receipt_lines l join public.goods_receipts g on g.id = l.goods_receipt_id join public.suppliers s on s.id = g.supplier_id
      cross join lateral (select * from private.pi_grn_line(l.id)) v
      left join lateral (select sum(il.quantity) as qty, sum(il.matched_payable) as share, sum(il.taxable_value + il.cgst + il.sgst + il.igst + il.cess) as amount,
                                string_agg(i.invoice_number, ', ') as numbers
                         from public.purchase_invoice_lines il join public.purchase_invoices i on i.id = il.invoice_id
                         where il.goods_receipt_line_id = l.id and i.status = 'POSTED') pi on true
      where g.company_id = v_company and g.status = 'POSTED' and l.accepted_quantity > 0 and g.receipt_date between v_from and v_to
        and (v_sup is null or g.supplier_id = v_sup)), '[]'::jsonb));
  elsif v_rep = 'GST_PENDING' then
    return jsonb_build_object('report', v_rep, 'rows', coalesce((select jsonb_agg(jsonb_build_object('invoice_id', i.id, 'invoice_number', i.invoice_number,
        'supplier_invoice_number', i.supplier_invoice_number, 'supplier_invoice_date', i.supplier_invoice_date, 'supplier', coalesce(s.display_name, s.legal_name),
        'supplier_gstin', i.supplier_gstin, 'cgst', i.cgst_total, 'sgst', i.sgst_total, 'igst', i.igst_total, 'cess', i.cess_total, 'reverse_charge', i.reverse_charge,
        'days_pending', private.company_today(v_company) - i.recorded_date) order by i.recorded_date)
      from public.purchase_invoices i join public.suppliers s on s.id = i.supplier_id
      where i.company_id = v_company and i.status = 'POSTED' and i.gst_status = 'PENDING_VERIFICATION'), '[]'::jsonb),
      'ledger_pending_balance', coalesce((select sum(l.debit - l.credit) from public.accounting_voucher_lines l join public.accounting_vouchers v on v.id = l.voucher_id
         join public.accounting_posting_rules r on r.account_id = l.account_id and r.rule_key = 'GST_INPUT_PENDING' and r.company_id = v_company
         where v.company_id = v_company and v.status in ('POSTED', 'REVERSED') and v.voucher_date <= v_to), 0));
  elsif v_rep = 'ITC_SUMMARY' then
    return jsonb_build_object('report', v_rep, 'from', v_from, 'to', v_to, 'rows', coalesce((select jsonb_agg(jsonb_build_object('rule_key', r.rule_key, 'account_code', a.account_code,
        'account_name', a.account_name, 'period_debit', coalesce(m.dr, 0), 'period_credit', coalesce(m.cr, 0), 'closing_balance', coalesce(m.closing, 0)) order by r.rule_key)
      from public.accounting_posting_rules r join public.accounts a on a.id = r.account_id
      left join lateral (select sum(l.debit) filter (where v.voucher_date >= v_from) as dr, sum(l.credit) filter (where v.voucher_date >= v_from) as cr,
                                sum(l.debit - l.credit) as closing
                         from public.accounting_voucher_lines l join public.accounting_vouchers v on v.id = l.voucher_id
                         where l.account_id = r.account_id and v.status in ('POSTED', 'REVERSED') and v.voucher_date <= v_to) m on true
      where r.company_id = v_company and r.rule_key in ('GST_INPUT_PENDING', 'INPUT_CGST', 'INPUT_SGST', 'INPUT_IGST', 'INPUT_CESS', 'GST_INPUT_INELIGIBLE', 'RCM_GST_PAYABLE')),
      '[]'::jsonb),
      'invoices', (select jsonb_object_agg(gst_status, n) from (select gst_status, count(*) as n from public.purchase_invoices
        where company_id = v_company and status = 'POSTED' and recorded_date between v_from and v_to group by gst_status) x));
  elsif v_rep = 'PRICE_VARIANCE' then
    return jsonb_build_object('report', v_rep, 'rows', coalesce((select jsonb_agg(jsonb_build_object('invoice_number', i.invoice_number, 'supplier_invoice_number', i.supplier_invoice_number,
        'supplier', coalesce(s.display_name, s.legal_name), 'receipt_number', g.receipt_number, 'description', l.description, 'quantity', l.quantity,
        'receipt_unit_cost', l.grn_unit_cost, 'invoice_unit_price', l.unit_price, 'receipt_value', l.matched_net, 'invoice_value', l.taxable_value,
        'variance', l.taxable_value - l.matched_net, 'variance_percent', case when l.matched_net > 0 then round((l.taxable_value - l.matched_net) * 100 / l.matched_net, 2) end,
        'variance_status', i.variance_status) order by i.recorded_date, i.invoice_number, l.line_no)
      from public.purchase_invoice_lines l join public.purchase_invoices i on i.id = l.invoice_id join public.suppliers s on s.id = i.supplier_id
      join public.goods_receipts g on g.id = l.goods_receipt_id
      where i.company_id = v_company and i.status = 'POSTED' and l.line_kind = 'GRN' and i.recorded_date between v_from and v_to
        and (v_sup is null or i.supplier_id = v_sup) and l.taxable_value <> l.matched_net), '[]'::jsonb));
  elsif v_rep = 'COST_CENTRE_EXPENSE' then
    return jsonb_build_object('report', v_rep, 'rows', coalesce((select jsonb_agg(jsonb_build_object('cost_centre_code', c.cost_centre_code, 'cost_centre_name', c.cost_centre_name,
        'account_code', a.account_code, 'account_name', a.account_name, 'amount', t.amount) order by c.cost_centre_code, a.account_code)
      from (select x.cost_centre_id, l.account_id, sum(case when l.debit > 0 then x.amount else -x.amount end) as amount
            from public.accounting_cost_allocations x join public.accounting_voucher_lines l on l.id = x.voucher_line_id
            join public.accounting_vouchers v on v.id = x.voucher_id join public.accounting_voucher_types t on t.id = v.voucher_type_id
            where x.company_id = v_company and t.type_code in ('PIN', 'REV') and v.source_type = 'PURCHASE_INVOICE' and v.status in ('POSTED', 'REVERSED')
              and v.voucher_date between v_from and v_to
            group by x.cost_centre_id, l.account_id) t
      join public.accounting_cost_centres c on c.id = t.cost_centre_id join public.accounts a on a.id = t.account_id where t.amount <> 0), '[]'::jsonb),
      'unallocated', coalesce((select sum(l.debit - l.credit) from public.accounting_voucher_lines l join public.accounting_vouchers v on v.id = l.voucher_id
        join public.accounts a on a.id = l.account_id
        where v.company_id = v_company and v.source_type = 'PURCHASE_INVOICE' and v.status in ('POSTED', 'REVERSED') and v.voucher_date between v_from and v_to
          and a.classification = 'EXPENSE' and not exists (select 1 from public.accounting_cost_allocations x where x.voucher_line_id = l.id)), 0));
  end if;
  raise exception 'Unknown report %.', p_report using errcode = '22023';
end;
$$;

create or replace function public.accounting_posting_rule_save(p_rule_key text, p_match_value text, p_account_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('accounting_settings.manage');
  v_key     text := upper(coalesce(p_rule_key, ''));
  v_match   text := upper(coalesce(p_match_value, ''));
  v_a       public.accounts;
  v_old     public.accounting_posting_rules;
begin
  perform private.accounting_require_setup(v_company);
  if v_key not in ('DEBTORS', 'CREDITORS', 'SALES', 'SALES_RETURNS', 'OUTPUT_CGST', 'OUTPUT_SGST', 'OUTPUT_IGST', 'ROUND_OFF', 'PURCHASES',
                   'GST_INPUT_PENDING', 'RECEIPT_ACCOUNT', 'SUPPLIER_PAYMENT_ACCOUNT',
                   -- Phase 3: supplier invoices.
                   'PURCHASE_PRICE_VARIANCE', 'INPUT_CGST', 'INPUT_SGST', 'INPUT_IGST', 'INPUT_CESS', 'GST_INPUT_INELIGIBLE', 'RCM_GST_PAYABLE') then
    raise exception 'Unknown posting rule %.', p_rule_key using errcode = '22023';
  end if;
  if (v_key in ('RECEIPT_ACCOUNT', 'SUPPLIER_PAYMENT_ACCOUNT')) <> (v_match <> '') then
    raise exception 'Receipt and supplier-payment rules need a payment method; the other rules do not.' using errcode = '22023';
  end if;
  select * into v_old from public.accounting_posting_rules where company_id = v_company and rule_key = v_key and match_value = v_match for update;
  if p_account_id is null then
    if v_key not in ('RECEIPT_ACCOUNT', 'SUPPLIER_PAYMENT_ACCOUNT') then
      raise exception 'Only payment-method mappings can be removed; select another account instead.' using errcode = 'P0001';
    end if;
    delete from public.accounting_posting_rules where id = v_old.id;
  else
    select * into v_a from public.accounts where id = p_account_id and company_id = v_company;
    if not found then
      raise exception 'The account does not exist in this company.' using errcode = '42501';
    end if;
    if not (v_a.is_active and v_a.is_postable) then
      raise exception 'Account % is inactive or does not accept postings.', v_a.account_code using errcode = 'P0001';
    end if;
    if v_key = 'DEBTORS' and v_a.account_nature <> 'RECEIVABLE_CONTROL' or v_key = 'CREDITORS' and v_a.account_nature <> 'PAYABLE_CONTROL' then
      raise exception 'Debtors and Creditors must map to the matching control account.' using errcode = 'P0001';
    end if;
    if v_key in ('RECEIPT_ACCOUNT', 'SUPPLIER_PAYMENT_ACCOUNT') and v_a.account_nature not in ('CASH', 'BANK') then
      raise exception 'Payment methods must map to a cash or bank account.' using errcode = 'P0001';
    end if;
    if v_key not in ('DEBTORS', 'CREDITORS') and v_a.account_nature in ('RECEIVABLE_CONTROL', 'PAYABLE_CONTROL') then
      raise exception 'A control account can only be used for the Debtors / Creditors rule.' using errcode = 'P0001';
    end if;
    insert into public.accounting_posting_rules (company_id, rule_key, match_value, account_id, created_by, updated_by)
    values (v_company, v_key, v_match, v_a.id, auth.uid(), auth.uid())
    on conflict (company_id, rule_key, match_value) do update set account_id = excluded.account_id, is_active = true, updated_by = auth.uid(), updated_at = now();
  end if;
  perform private.write_audit_log(v_company, 'accounting.posting_rule.saved', 'accounting_posting_rule', v_key || ':' || v_match,
    jsonb_build_object('rule_key', v_key, 'match_value', v_match, 'from_account', v_old.account_id, 'to_account', p_account_id));
  return jsonb_build_object('rule_key', v_key, 'match_value', v_match, 'account_id', p_account_id);
end;
$$;

create or replace function private.accounting_seed_chart(p_company uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  r record;
begin
  -- Groups (Indian-style hierarchy; classification inherited from the root).
  for r in
    select * from (values
      (1, 'AS', 'Assets', null, 'ASSET', 'DEBIT'),
      (2, 'AS.FA', 'Fixed Assets', 'AS', 'ASSET', 'DEBIT'),
      (3, 'AS.CA', 'Current Assets', 'AS', 'ASSET', 'DEBIT'),
      (4, 'AS.CA.CASH', 'Cash-in-Hand', 'AS.CA', 'ASSET', 'DEBIT'),
      (5, 'AS.CA.BANK', 'Bank Accounts', 'AS.CA', 'ASSET', 'DEBIT'),
      (6, 'AS.CA.DEB', 'Sundry Debtors', 'AS.CA', 'ASSET', 'DEBIT'),
      (7, 'AS.CA.STK', 'Stock-in-Hand', 'AS.CA', 'ASSET', 'DEBIT'),
      (8, 'AS.CA.TAX', 'Duties & Taxes Receivable', 'AS.CA', 'ASSET', 'DEBIT'),
      (9, 'AS.CA.ADV', 'Loans & Advances (Asset)', 'AS.CA', 'ASSET', 'DEBIT'),
      (10, 'LI', 'Liabilities', null, 'LIABILITY', 'CREDIT'),
      (11, 'LI.CL', 'Current Liabilities', 'LI', 'LIABILITY', 'CREDIT'),
      (12, 'LI.CL.CRD', 'Sundry Creditors', 'LI.CL', 'LIABILITY', 'CREDIT'),
      (13, 'LI.CL.TAX', 'Duties & Taxes', 'LI.CL', 'LIABILITY', 'CREDIT'),
      (14, 'LI.CL.PRV', 'Provisions', 'LI.CL', 'LIABILITY', 'CREDIT'),
      (15, 'LI.LN', 'Loans (Liability)', 'LI', 'LIABILITY', 'CREDIT'),
      (16, 'EQ', 'Capital & Reserves', null, 'EQUITY', 'CREDIT'),
      (17, 'EQ.CAP', 'Capital Account', 'EQ', 'EQUITY', 'CREDIT'),
      (18, 'EQ.RES', 'Reserves & Surplus', 'EQ', 'EQUITY', 'CREDIT'),
      (19, 'IN', 'Income', null, 'INCOME', 'CREDIT'),
      (20, 'IN.SAL', 'Sales Accounts', 'IN', 'INCOME', 'CREDIT'),
      (21, 'IN.OTH', 'Other Income', 'IN', 'INCOME', 'CREDIT'),
      (22, 'EX', 'Expenses', null, 'EXPENSE', 'DEBIT'),
      (23, 'EX.PUR', 'Purchase Accounts', 'EX', 'EXPENSE', 'DEBIT'),
      (24, 'EX.DIR', 'Direct Expenses', 'EX', 'EXPENSE', 'DEBIT'),
      (25, 'EX.IND', 'Indirect Expenses', 'EX', 'EXPENSE', 'DEBIT')
    ) g (ord, code, name, parent, cls, nb) order by ord
  loop
    insert into public.account_groups (company_id, group_code, group_name, parent_group_id, classification, normal_balance, is_system, sort_order, created_by, updated_by)
    values (p_company, r.code, r.name, (select id from public.account_groups where company_id = p_company and group_code = r.parent), r.cls, r.nb, true, r.ord,
            auth.uid(), auth.uid())
    on conflict (company_id, group_code) do nothing;
  end loop;

  -- System ledgers used by automatic posting. No bank account and no payment-method mapping is created.
  for r in
    select * from (values
      ('1100', 'Cash in Hand', 'AS.CA.CASH', 'DEBIT', 'CASH', true, false, false, null),
      ('1300', 'Sundry Debtors (Control)', 'AS.CA.DEB', 'DEBIT', 'RECEIVABLE_CONTROL', false, true, true, 'DEBTORS_CONTROL'),
      ('1400', 'Inventory (Stock-in-Hand)', 'AS.CA.STK', 'DEBIT', 'INVENTORY', true, false, false, 'INVENTORY'),
      ('1510', 'GST Input Pending Verification', 'AS.CA.TAX', 'DEBIT', 'TAX', true, false, false, 'GST_INPUT_PENDING'),
      ('2100', 'Sundry Creditors (Control)', 'LI.CL.CRD', 'CREDIT', 'PAYABLE_CONTROL', false, true, true, 'CREDITORS_CONTROL'),
      ('2210', 'Output CGST', 'LI.CL.TAX', 'CREDIT', 'TAX', true, false, false, 'OUTPUT_CGST'),
      ('2220', 'Output SGST', 'LI.CL.TAX', 'CREDIT', 'TAX', true, false, false, 'OUTPUT_SGST'),
      ('2230', 'Output IGST', 'LI.CL.TAX', 'CREDIT', 'TAX', true, false, false, 'OUTPUT_IGST'),
      ('3100', 'Capital Account', 'EQ.CAP', 'CREDIT', 'CAPITAL', true, false, false, null),
      ('4100', 'Sales', 'IN.SAL', 'CREDIT', 'GENERAL', true, false, false, 'SALES'),
      ('4110', 'Sales Returns', 'IN.SAL', 'DEBIT', 'GENERAL', true, false, false, 'SALES_RETURNS'),
      ('5100', 'Purchases', 'EX.PUR', 'DEBIT', 'GENERAL', true, false, false, 'PURCHASES'),
      ('5900', 'Round Off', 'EX.IND', 'DEBIT', 'ROUND_OFF', true, false, false, 'ROUND_OFF')
    ) a (code, name, grp, nb, nature, manual, party, control, skey)
  loop
    insert into public.accounts (company_id, account_code, account_name, group_id, classification, normal_balance, account_nature,
      allow_manual_posting, requires_party, is_control, is_system, system_key, created_by, updated_by)
    select p_company, r.code, r.name, g.id, g.classification, r.nb, r.nature, r.manual, r.party, r.control, r.skey is not null, r.skey, auth.uid(), auth.uid()
    from public.account_groups g where g.company_id = p_company and g.group_code = r.grp
    on conflict (company_id, account_code) do nothing;
  end loop;

  insert into public.accounting_voucher_types (company_id, type_code, type_name, prefix, allow_manual)
  select p_company, t.code, t.name, t.code, t.manual from (values
    ('JV', 'Journal Voucher', true), ('SAL', 'Sales', false), ('RCT', 'Receipt', false), ('PMT', 'Payment', false),
    ('CRN', 'Credit Note', false), ('DBN', 'Debit Note', false), ('PUR', 'Purchase (Goods Receipt)', false),
    ('OPN', 'Opening Balance', false), ('REV', 'Reversal', false)) t (code, name, manual)
  on conflict (company_id, type_code) do nothing;

  insert into public.accounting_posting_rules (company_id, rule_key, account_id, created_by, updated_by)
  select p_company, m.rule_key, a.id, auth.uid(), auth.uid()
  from (values ('DEBTORS', 'DEBTORS_CONTROL'), ('CREDITORS', 'CREDITORS_CONTROL'), ('SALES', 'SALES'), ('SALES_RETURNS', 'SALES_RETURNS'),
               ('OUTPUT_CGST', 'OUTPUT_CGST'), ('OUTPUT_SGST', 'OUTPUT_SGST'), ('OUTPUT_IGST', 'OUTPUT_IGST'), ('ROUND_OFF', 'ROUND_OFF'),
               ('PURCHASES', 'PURCHASES'), ('GST_INPUT_PENDING', 'GST_INPUT_PENDING')) m (rule_key, skey)
  join public.accounts a on a.company_id = p_company and a.system_key = m.skey
  on conflict (company_id, rule_key, match_value) do nothing;
  -- Phase 3: purchase-invoice ledgers, rules and the PIN voucher type.
  perform private.accounting_seed_purchase_invoices(p_company);
  -- Phase 4: contra and bank adjustment voucher types.
  perform private.accounting_seed_bank_cash(p_company);
end;
$$;

create or replace function private.erp_reset_tables()
returns table (ord int, table_name text, category text, label text)
language sql
stable
set search_path = ''
as $$
  select * from (values
    (-10, 'bank_reconciliation_match_items', 'Accounting', 'Bank reconciliation match lines'),
    (-9, 'bank_reconciliation_matches', 'Accounting', 'Bank reconciliation matches'),
    (-9, 'bank_reconciliations', 'Accounting', 'Saved bank reconciliations'),
    (-9, 'bank_statement_files', 'Accounting', 'Imported bank statement files'),
    (-8, 'bank_statement_lines', 'Accounting', 'Imported bank statement lines'),
    (-7, 'bank_statement_imports', 'Accounting', 'Bank statement import batches'),
    (-6, 'bank_transfers', 'Accounting', 'Bank / cash transfers'),
    (-6, 'bank_payment_assignments', 'Accounting', 'Bank / cash account of receipts and payments'),
    (-9, 'purchase_invoice_allocations', 'Accounting', 'Supplier invoice cost-centre splits'),
    (-8, 'purchase_invoice_lines', 'Accounting', 'Supplier invoice lines'),
    (-8, 'purchase_invoice_history', 'Accounting', 'Supplier invoice history'),
    (-8, 'supplier_payment_allocations', 'Accounting', 'Supplier payments allocated to invoices'),
    (-6, 'purchase_invoices', 'Accounting', 'Supplier (purchase) invoices'),
    (-8, 'accounting_cost_allocations', 'Accounting', 'Cost centre allocations'),
    (-4, 'accounting_budget_lines', 'Accounting', 'Cost centre budget lines'),
    (-4, 'accounting_budget_history', 'Accounting', 'Cost centre budget history'),
    (-3, 'accounting_budgets', 'Accounting', 'Cost centre budgets'),
    (-7, 'accounting_voucher_lines', 'Accounting', 'Accounting voucher lines'),
    (-7, 'accounting_opening_balance_lines', 'Accounting', 'Accounting opening balance lines'),
    (-6, 'accounting_posting_events', 'Accounting', 'Automatic accounting posting events'),
    (-6, 'accounting_opening_balance_batches', 'Accounting', 'Accounting opening balance batches'),
    (-5, 'accounting_vouchers', 'Accounting', 'Accounting vouchers'),
    (-3, 'support_call_signals', 'Support Centre', 'Realtime call signals'),
    (0, 'support_ticket_field_values', 'Support Centre', 'Custom ticket field values'),
    (0, 'support_ticket_products', 'Support Centre', 'Products on support tickets'),
    (0, 'support_ticket_field_layout', 'Support Centre', 'New Ticket form layout'),
    (1, 'support_ticket_field_definitions', 'Support Centre', 'Custom ticket fields'),
    (0, 'support_ticket_stage_history', 'Support Centre', 'Ticket stage history'),
    (4, 'support_pipeline_stages', 'Support Centre', 'Pipeline stages'),
    (5, 'support_pipelines', 'Support Centre', 'Support pipelines'),
    (0, 'support_customer_field_values', 'Support Centre', 'Custom customer field values'),
    (0, 'support_customer_activities', 'Support Centre', 'Customer tasks, follow-ups and appointments'),
    (-4, 'support_note_revisions', 'Support Centre', 'Note history'),
    (-2, 'support_call_events', 'Support Centre', 'Call status history'),
    (2, 'support_ticket_escalations', 'Support Centre', 'SLA warnings, breaches and escalations'),
    (3, 'support_ticket_rules', 'Support Centre', 'Ticket automation rules'),
    (3, 'support_business_calendar', 'Support Centre', 'Business hours'),
    (3, 'support_holidays', 'Support Centre', 'Holidays'),
    (3, 'support_sla_escalation_levels', 'Support Centre', 'SLA escalation levels'),
    (3, 'support_assignment_rules', 'Support Centre', 'Ticket assignment rules'),
    (0, 'support_whatsapp_messages', 'Support Centre', 'WhatsApp messages'),
    (0, 'support_whatsapp_statuses', 'Support Centre', 'WhatsApp delivery statuses'),
    (1, 'support_whatsapp_threads', 'Support Centre', 'WhatsApp contacts per conversation'),
    (3, 'support_whatsapp_templates', 'Support Centre', 'WhatsApp templates (from Meta)'),
    (3, 'support_whatsapp_webhook_events', 'Support Centre', 'WhatsApp webhook events'),
    (3, 'support_whatsapp_config', 'Support Centre', 'WhatsApp settings'),
    (0, 'support_email_messages', 'Support Centre', 'Email messages (Gmail)'),
    (1, 'support_email_templates', 'Support Centre', 'Email templates'),
    (3, 'support_email_config', 'Support Centre', 'Email settings'),
    (3, 'support_email_credentials', 'Support Centre', 'Email connection (encrypted)'),
    (3, 'support_oauth_states', 'Support Centre', 'Email authorisation requests'),
    (-1, 'support_calls', 'Support Centre', 'Phone calls'),
    (3, 'support_phone_agents', 'Support Centre', 'Phone agent lines'),
    (3, 'support_phone_config', 'Support Centre', 'Phone settings'),
    (0, 'support_attachments', 'Support Centre', 'Support attachments'),
    (0, 'support_audit_logs', 'Support Centre', 'Support activity log'),
    (0, 'support_automation_rules', 'Support Centre', 'Support automation rules'),
    (0, 'support_conversation_tags', 'Support Centre', 'Support conversation tags'),
    (0, 'support_conversation_prefs', 'Support Centre', 'Pinned / muted / favourite conversations'),
    (0, 'support_email_thread_state', 'Support Centre', 'Email starred / snoozed / folder state'),
    (0, 'support_email_sync_queue', 'Support Centre', 'Email sync queue'),
    (1, 'support_email_sync_jobs', 'Support Centre', 'Email full re-sync jobs'),
    (0, 'support_email_sync_state', 'Support Centre', 'Email sync lock and progress'),
    (0, 'support_integration_events', 'Support Centre', 'Support integration events'),
    (-3, 'support_internal_notes', 'Support Centre', 'Support internal notes'),
    (0, 'support_kb_articles', 'Support Centre', 'Knowledge base articles'),
    (0, 'support_ticket_events', 'Support Centre', 'Support ticket history'),
    (1, 'support_messages', 'Support Centre', 'Support messages and calls'),
    (1, 'support_tags', 'Support Centre', 'Support tags'),
    (2, 'support_conversations', 'Support Centre', 'Support conversations'),
    (3, 'support_tickets', 'Support Centre', 'Support tickets'),
    (5, 'support_agents', 'Support Centre', 'Support agents'),
    (4, 'support_channel_accounts', 'Support Centre', 'Support channel accounts'),
    (4, 'support_customers', 'Support Centre', 'Support customers'),
    (4, 'support_sla_policies', 'Support Centre', 'Support SLA policies'),
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
    (0, 'bom_change_batch_lines', 'Production & BOMs', 'Bulk BOM change lines'),
    (0, 'bom_change_approvals', 'Production & BOMs', 'Bulk BOM change approvals and history'),
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
    (1, 'bom_change_batches', 'Production & BOMs', 'Bulk BOM change batches'),
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

create or replace function private.erp_reset_kept_tables()
returns table (table_name text, label text, company_scoped boolean)
language sql
immutable
set search_path = ''
as $$
  select * from (values
    ('accounting_settings', 'Accounting settings', true),
    ('accounting_periods', 'Accounting periods', true),
    ('account_groups', 'Account groups', true),
    ('accounts', 'Ledger accounts', true),
    ('accounting_cost_centres', 'Cost centres', true),
    ('accounting_voucher_types', 'Voucher types', true),
    ('accounting_voucher_sequences', 'Voucher number series', true),
    ('accounting_posting_rules', 'Posting account mappings', true),
    ('bank_cash_accounts', 'Bank and cash accounts', true),
    ('bank_account_numbers', 'Bank account numbers', true),
    ('bank_payment_method_policies', 'Payment-method account policies', true),
    ('companies', 'Company record', true),
    ('company_settings', 'Company settings', true),
    ('profiles', 'User profiles', true),
    ('user_roles', 'Role assignments', true),
    ('user_invitations', 'User invitations', true),
    ('roles', 'Roles', false),
    ('permissions', 'Permissions', false),
    ('role_permissions', 'Role permissions', false),
    ('audit_logs', 'Audit log', true),
    ('erp_reset_runs', 'Reset history', true),
    ('erp_reset_backup_attestations', 'Reset backup records', true),
    ('invoice_settings', 'Invoice settings', true),
    ('billing_number_sequences', 'Billing number series', true),
    ('inventory_number_sequences', 'Inventory number series', true),
    ('approval_workflows', 'Approval workflows', true),
    ('approval_workflow_stages', 'Approval workflow stages', true),
    ('notification_preferences', 'Notification preferences', true),
    ('notification_sync_state', 'Notification sync state', true),
    ('error_events', 'System error log', true),
    ('amazon_settings', 'Amazon settings', true),
    ('amazon_connections', 'Amazon connections', true),
    ('warehouses', 'Warehouses', true),
    ('inventory_locations', 'Warehouse locations', true),
    ('products', 'Products', true),
    ('product_versions', 'Product version history', true),
    ('product_categories', 'Product categories', true),
    ('documents', 'Documents', true),
    ('document_versions', 'Document files', true)
  ) t (table_name, label, company_scoped);
$$;

create or replace function private.erp_force_reset_tables()
returns table (table_name text, category text, label text)
language sql
stable
set search_path = ''
as $$
  select t.table_name, t.category, t.label from private.erp_reset_tables() t
  union all
  select * from (values
    ('accounting_settings', 'Accounting', 'Accounting settings'),
    ('accounting_periods', 'Accounting', 'Accounting periods'),
    ('account_groups', 'Accounting', 'Account groups'),
    ('accounts', 'Accounting', 'Ledger accounts'),
    ('accounting_cost_centres', 'Accounting', 'Cost centres'),
    ('accounting_voucher_types', 'Accounting', 'Voucher types'),
    ('accounting_voucher_sequences', 'Accounting', 'Voucher number series'),
    ('accounting_posting_rules', 'Accounting', 'Posting account mappings'),
    ('bank_cash_accounts', 'Accounting', 'Bank and cash accounts'),
    ('bank_account_numbers', 'Accounting', 'Bank account numbers'),
    ('bank_payment_method_policies', 'Accounting', 'Payment-method account policies'),
    ('products', 'Products & catalogue', 'Products'),
    ('product_versions', 'Products & catalogue', 'Product version history'),
    ('product_categories', 'Products & catalogue', 'Product categories'),
    ('warehouses', 'Warehouses & locations', 'Warehouses'),
    ('inventory_locations', 'Warehouses & locations', 'Warehouse locations'),
    ('documents', 'Documents', 'Documents (except company-level documents)'),
    ('document_versions', 'Documents', 'Document file versions')
  ) x (table_name, category, label);
$$;

revoke all on function private.erp_reset_tables() from public, anon, authenticated;
revoke all on function private.erp_reset_kept_tables() from public, anon, authenticated;

drop function if exists public.gst_registration_save(jsonb);
drop function if exists public.gst_frequency_add(text, date, text);
drop function if exists public.gst_config_save(uuid, date, jsonb, text, integer);
drop function if exists public.gst_config_submit(uuid);
drop function if exists public.gst_config_approve(uuid, text);
drop function if exists public.gst_config_reject(uuid, text);
drop function if exists public.gst_hsn_rate_save(jsonb);
drop function if exists public.gst_ledgers_setup();
drop function if exists public.gst_overview();
drop function if exists public.gst_config_get(uuid);
drop function if exists public.gst_sales_details_save(jsonb);
drop function if exists public.gst_period_create(date);
drop function if exists public.gst_period_transition(uuid, text, text);
drop function if exists public.gst_period_get(uuid);
drop function if exists public.gst_periods_list(text);
drop function if exists public.gst_amendments_scan();
drop function if exists public.gst_amendment_resolve(uuid, text, text, text);
drop function if exists public.gst_return_adjustment(text, uuid, jsonb);
drop function if exists public.gst_itc_action(uuid, text, jsonb);
drop function if exists public.gst_itc_get(uuid);
drop function if exists public.gst_itc_adjustment(text, uuid, jsonb);
drop function if exists public.gst_itc_queue(jsonb);
drop function if exists public.gst_liability_summary(uuid);
drop function if exists public.gst_challan(text, uuid, jsonb);
drop function if exists public.gst_challan_payment(text, uuid, jsonb);
drop function if exists public.gst_set_off(text, uuid, jsonb);
drop function if exists private.gst_liability(public.gst_return_periods);
drop function if exists private.gst_cash_available(uuid);
drop function if exists private.gst_itc_json(uuid);
drop function if exists private.gst_itc_input_available(uuid, numeric, numeric, numeric, numeric);
drop function if exists private.gst_itc_checks_ok(jsonb);
drop function if exists private.gst_itc_apply_decision(public.purchase_invoices, jsonb, text, jsonb, jsonb, uuid, boolean);
drop function if exists private.gst_itc_split(public.purchase_invoices, jsonb, jsonb);
drop function if exists private.gst_itc_append(public.purchase_invoices, text, text, jsonb, text, jsonb, jsonb, uuid, uuid, uuid);
drop function if exists private.gst_itc_net(uuid);
drop function if exists private.gst_period_json(uuid);
drop function if exists private.gst_period_checklist(public.gst_return_periods);
drop function if exists private.gst_period_event(public.gst_return_periods, text, text, text, jsonb);
drop function if exists private.gst_period_lock(uuid, uuid);
drop function if exists private.gst_document_now(uuid, text, uuid);
drop function if exists private.gst_period_documents(uuid, date, date);
drop function if exists private.gst_fy_start_month(uuid);
drop function if exists private.gst_ledger_movement(uuid, text, date, date, text);
drop function if exists private.gst_config_validate(jsonb);
drop function if exists private.gst_config_on(uuid, date);
drop function if exists private.gst_registration_of(uuid);
drop function if exists private.gst_hash(jsonb);
drop function if exists private.accounting_seed_gst(uuid);
drop function if exists private.gst_ledgers_ensure(uuid);

drop table if exists public.gst_period_current_snapshot;
drop table if exists public.gst_snapshot_documents;
drop table if exists public.gst_amendment_exceptions;
drop table if exists public.gst_set_off_lines;
drop table if exists public.gst_set_off_events;
drop table if exists public.gst_challan_heads;
drop table if exists public.gst_sales_document_detail_history;
drop table if exists public.gst_period_snapshots;
drop table if exists public.gst_challan_payments;
drop table if exists public.gst_set_offs;
drop table if exists public.gst_period_events;
drop table if exists public.gst_return_adjustments;
drop table if exists public.gst_sales_document_details;
drop table if exists public.gst_itc_decisions;
drop table if exists public.gst_itc_adjustments;
drop table if exists public.gst_challans;
drop table if exists public.gst_return_periods;
drop table if exists public.gst_hsn_rates;
drop table if exists public.gst_config_versions;
drop table if exists public.gst_registration_frequencies;
drop table if exists public.gst_registrations;
drop function if exists private.gst_insert_only_guard();
drop function if exists private.gst_period_guard();
drop function if exists private.gst_config_guard();
drop function if exists private.gst_posted_guard();

alter table public.purchase_invoices drop constraint if exists purchase_invoices_gst_status_p5_check;
alter table public.purchase_invoices add constraint purchase_invoices_gst_status_check check (gst_status in ('NOT_APPLICABLE', 'PENDING_VERIFICATION', 'ELIGIBLE', 'INELIGIBLE'));

-- GST ledgers and rules (only when unused), the GST voucher type (when unused), the rule-key list as 20261231090300 defined it.
delete from public.accounting_posting_rules r where r.rule_key in ('GST_ELECTRONIC_CASH', 'GST_INTEREST', 'GST_LATE_FEE')
  and not exists (select 1 from public.accounting_voucher_lines l where l.account_id = r.account_id);
delete from public.accounts a where a.system_key in ('GST_ELECTRONIC_CASH', 'GST_INTEREST', 'GST_LATE_FEE')
  and not exists (select 1 from public.accounting_voucher_lines l where l.account_id = a.id)
  and not exists (select 1 from public.accounting_posting_rules r where r.account_id = a.id);
delete from public.accounting_voucher_sequences where voucher_type_id in (select t.id from public.accounting_voucher_types t where t.type_code = 'GST'
  and not exists (select 1 from public.accounting_vouchers v where v.voucher_type_id = t.id));
delete from public.accounting_voucher_types t where t.type_code = 'GST' and not exists (select 1 from public.accounting_vouchers v where v.voucher_type_id = t.id);
do $$
begin
  if not exists (select 1 from public.accounting_posting_rules where rule_key in ('GST_ELECTRONIC_CASH', 'GST_INTEREST', 'GST_LATE_FEE')) then
    alter table public.accounting_posting_rules drop constraint if exists accounting_posting_rules_rule_key_gst_check;
    alter table public.accounting_posting_rules add constraint accounting_posting_rules_rule_key_pi_check check (rule_key in ('DEBTORS', 'CREDITORS', 'SALES',
      'SALES_RETURNS', 'OUTPUT_CGST', 'OUTPUT_SGST', 'OUTPUT_IGST', 'ROUND_OFF', 'PURCHASES', 'GST_INPUT_PENDING', 'RECEIPT_ACCOUNT', 'SUPPLIER_PAYMENT_ACCOUNT',
      'PURCHASE_PRICE_VARIANCE', 'INPUT_CGST', 'INPUT_SGST', 'INPUT_IGST', 'INPUT_CESS', 'GST_INPUT_INELIGIBLE', 'RCM_GST_PAYABLE'));
  else
    raise notice 'GST ledgers carry postings: the GST posting-rule keys are kept.';
  end if;
end;
$$;

delete from public.role_permissions where permission_id in (select id from public.permissions where resource in ('gst', 'gst_reconciliation', 'gst_returns', 'gst_payments', 'gst_periods'));
delete from public.permissions where resource in ('gst', 'gst_reconciliation', 'gst_returns', 'gst_payments', 'gst_periods');
