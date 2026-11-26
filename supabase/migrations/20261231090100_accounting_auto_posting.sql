-- =============================================================================
-- ALTON ACCOUNTS — Phase 0: automatic posting of verified ERP business events
--
-- Reads the existing source documents; changes none of them and adds no trigger
-- to any operational table, so sales, purchasing and payment workflows behave
-- exactly as before and can never fail because of accounting.
--
--   scan     queues one accounting_posting_events row per source document and
--            action (POST / REVERSE). Unique per company, source and action, so
--            repeating a scan never queues a document twice (idempotent).
--   run      processes queued events through the one posting engine
--            (private.accounting_create_voucher / _post_voucher / _reverse_voucher)
--            under a per-company advisory lock and row locks (FOR UPDATE SKIP
--            LOCKED), so two runs never post the same event. The voucher table also
--            allows only one AUTO voucher per source document.
--
-- Events and their vouchers
--   SALES_INVOICE    ISSUED     Dr Debtors (party) / Cr Sales, Output CGST/SGST/IGST, Round-off
--   CUSTOMER_RECEIPT RECORDED   Dr mapped cash/bank for the payment method / Cr Debtors (party)
--   CREDIT_NOTE      ISSUED     Dr Sales Returns, Output GST / Cr Debtors (party)
--   DEBIT_NOTE       ISSUED     Dr Debtors (party) / Cr Sales, Output GST
--   SUPPLIER_PAYMENT RECORDED   Dr Creditors (party) / Cr mapped cash/bank for the payment method
--   GOODS_RECEIPT    POSTED     Dr Purchases (net), GST Input Pending Verification / Cr Creditors (ERP payable)
--   cancellation / reversal of any of them: linked reversal voucher of the original.
--
-- Never guessed: a missing account mapping (including the cash / bank account of a
-- payment method) leaves the event NEEDS_ACCOUNT_MAPPING. Not posted: drafts,
-- pending, discarded and cancelled-before-posting documents, documents before the
-- books start date, non-INR documents, zero values, direct receipts without a
-- supplier (no ERP payable). No purchase invoices, purchase returns, COGS or stock
-- movements are created. Calculated purchase GST is never treated as eligible ITC.
--
-- Rollback: supabase/rollback/20261231090100_accounting_auto_posting_down.sql
-- =============================================================================

-- Active, postable account mapped to a rule (NULL when not mapped).
create or replace function private.accounting_rule_account(p_company uuid, p_rule text, p_match text default '')
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select a.id from public.accounting_posting_rules r join public.accounts a on a.id = r.account_id
  where r.company_id = p_company and r.rule_key = p_rule and r.match_value = coalesce(p_match, '') and r.is_active and a.is_active and a.is_postable;
$$;

create or replace function private.accounting_rule_label(p_rule text, p_match text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_rule
    when 'RECEIPT_ACCOUNT' then 'Customer receipts by ' || replace(lower(p_match), '_', ' ') || ' (cash / bank account)'
    when 'SUPPLIER_PAYMENT_ACCOUNT' then 'Supplier payments by ' || replace(lower(p_match), '_', ' ') || ' (cash / bank account)'
    else initcap(replace(lower(p_rule), '_', ' ')) end;
$$;

-- What to post for a POST event: {outcome POST | SKIP | MAPPING | FAIL, code, message, type, date, reference, narration, lines}.
create or replace function private.accounting_build_event(p_event public.accounting_posting_events)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c         uuid := p_event.company_id;
  v_lines   jsonb := '[]'::jsonb;
  v_missing text[] := '{}';
  v_party   uuid;
  v_acc     jsonb := '{}'::jsonb;
  v_need    text[][];
  v_k       text[];
  v_id      uuid;
  inv       public.sales_invoices;
  pay       public.customer_payments;
  note      public.invoice_adjustment_notes;
  spay      public.supplier_payments;
  grn       public.goods_receipts;
  v_cur     text;
  v_payable numeric;
  v_net     numeric;
  v_gst     numeric;
  v_check   numeric;
  v_type    text;
  v_date    date;
  v_ref     text;
  v_narr    text;
begin
  if p_event.source_type = 'SALES_INVOICE' then
    select * into inv from public.sales_invoices where id = p_event.source_id and company_id = c;
    if not found or inv.status not in ('ISSUED', 'CANCELLED') then
      return jsonb_build_object('outcome', 'SKIP', 'code', 'NOT_ISSUED', 'message', 'The invoice is not issued.');
    end if;
    if inv.currency <> 'INR' then
      return jsonb_build_object('outcome', 'FAIL', 'code', 'UNSUPPORTED_CURRENCY', 'message', format('Invoice currency %s: only INR documents are posted until a currency design is approved.', inv.currency));
    end if;
    if inv.grand_total = 0 then
      return jsonb_build_object('outcome', 'SKIP', 'code', 'ZERO_VALUE', 'message', 'The invoice total is zero.');
    end if;
    select id into v_party from public.parties where company_id = c and customer_id = inv.customer_id;
    v_need := array[array['DEBTORS', ''], array['SALES', '']];
    if inv.cgst_total <> 0 then v_need := v_need || array[array['OUTPUT_CGST', '']]; end if;
    if inv.sgst_total <> 0 then v_need := v_need || array[array['OUTPUT_SGST', '']]; end if;
    if inv.igst_total <> 0 then v_need := v_need || array[array['OUTPUT_IGST', '']]; end if;
    if inv.round_off <> 0 then v_need := v_need || array[array['ROUND_OFF', '']]; end if;
    v_type := 'SAL'; v_date := inv.invoice_date; v_ref := inv.invoice_number;
    v_narr := format('Sales invoice %s — %s', inv.invoice_number, inv.customer_legal_name);
  elsif p_event.source_type = 'CUSTOMER_RECEIPT' then
    select * into pay from public.customer_payments where id = p_event.source_id and company_id = c;
    if not found then
      return jsonb_build_object('outcome', 'SKIP', 'code', 'NOT_FOUND', 'message', 'The receipt no longer exists.');
    end if;
    if pay.currency <> 'INR' then
      return jsonb_build_object('outcome', 'FAIL', 'code', 'UNSUPPORTED_CURRENCY', 'message', format('Receipt currency %s: only INR documents are posted.', pay.currency));
    end if;
    select id into v_party from public.parties where company_id = c and customer_id = pay.customer_id;
    v_need := array[array['RECEIPT_ACCOUNT', pay.payment_method], array['DEBTORS', '']];
    v_type := 'RCT'; v_date := pay.receipt_date; v_ref := pay.receipt_number;
    v_narr := format('Customer receipt %s (%s)%s', pay.receipt_number, replace(lower(pay.payment_method), '_', ' '),
                     coalesce(' ref ' || pay.transaction_reference, ''));
  elsif p_event.source_type in ('CREDIT_NOTE', 'DEBIT_NOTE') then
    select * into note from public.invoice_adjustment_notes where id = p_event.source_id and company_id = c;
    if not found or note.status not in ('ISSUED', 'CANCELLED') then
      return jsonb_build_object('outcome', 'SKIP', 'code', 'NOT_ISSUED', 'message', 'The note is not issued.');
    end if;
    select currency into v_cur from public.sales_invoices where id = note.original_invoice_id;
    if v_cur <> 'INR' then
      return jsonb_build_object('outcome', 'FAIL', 'code', 'UNSUPPORTED_CURRENCY', 'message', format('Note currency %s: only INR documents are posted.', v_cur));
    end if;
    if note.total_amount = 0 then
      return jsonb_build_object('outcome', 'SKIP', 'code', 'ZERO_VALUE', 'message', 'The note total is zero.');
    end if;
    if least(note.cgst_amount, note.sgst_amount, note.igst_amount) < 0 then
      return jsonb_build_object('outcome', 'FAIL', 'code', 'NEGATIVE_TAX', 'message', 'The note has a negative tax amount; post it by journal voucher after review.');
    end if;
    select id into v_party from public.parties where company_id = c and customer_id = note.customer_id;
    v_need := array[array['DEBTORS', ''], array[case when note.note_type = 'CREDIT' then 'SALES_RETURNS' else 'SALES' end, '']];
    if note.cgst_amount <> 0 then v_need := v_need || array[array['OUTPUT_CGST', '']]; end if;
    if note.sgst_amount <> 0 then v_need := v_need || array[array['OUTPUT_SGST', '']]; end if;
    if note.igst_amount <> 0 then v_need := v_need || array[array['OUTPUT_IGST', '']]; end if;
    v_type := case when note.note_type = 'CREDIT' then 'CRN' else 'DBN' end; v_date := note.note_date; v_ref := note.note_number;
    v_narr := format('%s note %s against invoice %s — %s', initcap(note.note_type), note.note_number,
                     (select invoice_number from public.sales_invoices where id = note.original_invoice_id), note.reason);
  elsif p_event.source_type = 'SUPPLIER_PAYMENT' then
    select * into spay from public.supplier_payments where id = p_event.source_id and company_id = c;
    if not found then
      return jsonb_build_object('outcome', 'SKIP', 'code', 'NOT_FOUND', 'message', 'The supplier payment no longer exists.');
    end if;
    select id into v_party from public.parties where company_id = c and supplier_id = spay.supplier_id;
    v_need := array[array['CREDITORS', ''], array['SUPPLIER_PAYMENT_ACCOUNT', spay.payment_method]];
    v_type := 'PMT'; v_date := spay.payment_date; v_ref := spay.payment_number;
    v_narr := format('Supplier payment %s (%s)%s', spay.payment_number, replace(lower(spay.payment_method), '_', ' '), coalesce(' ref ' || spay.reference, ''));
  elsif p_event.source_type = 'GOODS_RECEIPT' then
    select * into grn from public.goods_receipts where id = p_event.source_id and company_id = c;
    if not found then
      return jsonb_build_object('outcome', 'SKIP', 'code', 'NOT_FOUND', 'message', 'The goods receipt no longer exists.');
    end if;
    if grn.supplier_id is null then
      return jsonb_build_object('outcome', 'SKIP', 'code', 'NO_SUPPLIER', 'message', 'Direct receipt without a supplier: the ERP records no payable for it.');
    end if;
    -- Payable value exactly as the ERP computes it; net / GST split per line (GST = payable - net, so it balances to the paisa).
    select coalesce(sum(x.payable), 0), coalesce(sum(x.net), 0) into v_payable, v_net
    from (
      select y.payable,
             case when y.purchase_order_line_id is not null then
                    case when coalesce(y.line_total, 0) > 0 then round(y.payable * y.taxable_value / y.line_total, 2) else y.payable end
                  else round(y.payable * 100 / (100 + coalesce(y.gst_rate, 0)), 2) end as net
      from (select coalesce(l.line_value, private.grn_line_value(l.accepted_quantity, pol.ordered_quantity, pol.line_total), 0) as payable,
                   l.purchase_order_line_id, l.gst_rate, pol.taxable_value, pol.line_total
            from public.goods_receipt_lines l left join public.purchase_order_lines pol on pol.id = l.purchase_order_line_id
            where l.goods_receipt_id = grn.id) y
    ) x;
    v_check := private.goods_receipt_value(grn.id);
    if v_payable <> v_check then
      return jsonb_build_object('outcome', 'FAIL', 'code', 'PAYABLE_MISMATCH', 'message', format('Line payable %s differs from the ERP payable %s.', v_payable, v_check));
    end if;
    if v_payable = 0 then
      return jsonb_build_object('outcome', 'SKIP', 'code', 'ZERO_VALUE', 'message', 'Nothing was accepted on this receipt (no payable).');
    end if;
    v_gst := v_payable - v_net;
    if v_gst < 0 or v_net < 0 then
      return jsonb_build_object('outcome', 'FAIL', 'code', 'GST_SPLIT_NEGATIVE', 'message', 'The net / GST split of this receipt is negative; review it and post by journal voucher.');
    end if;
    select id into v_party from public.parties where company_id = c and supplier_id = grn.supplier_id;
    v_need := array[array['CREDITORS', ''], array['PURCHASES', '']];
    if v_gst <> 0 then v_need := v_need || array[array['GST_INPUT_PENDING', '']]; end if;
    v_type := 'PUR'; v_date := grn.receipt_date; v_ref := grn.receipt_number;
    v_narr := format('Goods receipt %s%s', grn.receipt_number, coalesce(' — supplier document ' || grn.supplier_document_number, ''));
  else
    return jsonb_build_object('outcome', 'FAIL', 'code', 'UNKNOWN_SOURCE', 'message', 'Unknown source type.');
  end if;

  if v_party is null then
    return jsonb_build_object('outcome', 'FAIL', 'code', 'NO_PARTY', 'message', 'The customer / supplier has no ledger party. Open Ledger once (it creates missing parties) and retry.');
  end if;
  foreach v_k slice 1 in array v_need loop
    v_id := private.accounting_rule_account(c, v_k[1], v_k[2]);
    if v_id is null then
      v_missing := v_missing || private.accounting_rule_label(v_k[1], v_k[2]);
    else
      v_acc := v_acc || jsonb_build_object(v_k[1], v_id);
    end if;
  end loop;
  if cardinality(v_missing) > 0 then
    return jsonb_build_object('outcome', 'MAPPING', 'code', 'NEEDS_ACCOUNT_MAPPING',
      'message', 'Map an active account in Accounting Settings > Posting rules for: ' || array_to_string(v_missing, ', ') || '.');
  end if;

  if p_event.source_type = 'SALES_INVOICE' then
    v_lines := jsonb_build_array(jsonb_build_object('account_id', v_acc ->> 'DEBTORS', 'party_id', v_party, 'debit', inv.grand_total));
    if inv.taxable_subtotal <> 0 then v_lines := v_lines || jsonb_build_object('account_id', v_acc ->> 'SALES', 'credit', inv.taxable_subtotal); end if;
    if inv.cgst_total <> 0 then v_lines := v_lines || jsonb_build_object('account_id', v_acc ->> 'OUTPUT_CGST', 'credit', inv.cgst_total); end if;
    if inv.sgst_total <> 0 then v_lines := v_lines || jsonb_build_object('account_id', v_acc ->> 'OUTPUT_SGST', 'credit', inv.sgst_total); end if;
    if inv.igst_total <> 0 then v_lines := v_lines || jsonb_build_object('account_id', v_acc ->> 'OUTPUT_IGST', 'credit', inv.igst_total); end if;
    if inv.round_off > 0 then v_lines := v_lines || jsonb_build_object('account_id', v_acc ->> 'ROUND_OFF', 'credit', inv.round_off); end if;
    if inv.round_off < 0 then v_lines := v_lines || jsonb_build_object('account_id', v_acc ->> 'ROUND_OFF', 'debit', -inv.round_off); end if;
  elsif p_event.source_type = 'CUSTOMER_RECEIPT' then
    v_lines := jsonb_build_array(jsonb_build_object('account_id', v_acc ->> 'RECEIPT_ACCOUNT', 'debit', pay.amount_received),
                                 jsonb_build_object('account_id', v_acc ->> 'DEBTORS', 'party_id', v_party, 'credit', pay.amount_received));
  elsif p_event.source_type = 'CREDIT_NOTE' then
    v_lines := '[]'::jsonb;
    if note.taxable_amount <> 0 then v_lines := v_lines || jsonb_build_object('account_id', v_acc ->> 'SALES_RETURNS', 'debit', note.taxable_amount); end if;
    if note.cgst_amount <> 0 then v_lines := v_lines || jsonb_build_object('account_id', v_acc ->> 'OUTPUT_CGST', 'debit', note.cgst_amount); end if;
    if note.sgst_amount <> 0 then v_lines := v_lines || jsonb_build_object('account_id', v_acc ->> 'OUTPUT_SGST', 'debit', note.sgst_amount); end if;
    if note.igst_amount <> 0 then v_lines := v_lines || jsonb_build_object('account_id', v_acc ->> 'OUTPUT_IGST', 'debit', note.igst_amount); end if;
    v_lines := v_lines || jsonb_build_object('account_id', v_acc ->> 'DEBTORS', 'party_id', v_party, 'credit', note.total_amount);
  elsif p_event.source_type = 'DEBIT_NOTE' then
    v_lines := jsonb_build_array(jsonb_build_object('account_id', v_acc ->> 'DEBTORS', 'party_id', v_party, 'debit', note.total_amount));
    if note.taxable_amount <> 0 then v_lines := v_lines || jsonb_build_object('account_id', v_acc ->> 'SALES', 'credit', note.taxable_amount); end if;
    if note.cgst_amount <> 0 then v_lines := v_lines || jsonb_build_object('account_id', v_acc ->> 'OUTPUT_CGST', 'credit', note.cgst_amount); end if;
    if note.sgst_amount <> 0 then v_lines := v_lines || jsonb_build_object('account_id', v_acc ->> 'OUTPUT_SGST', 'credit', note.sgst_amount); end if;
    if note.igst_amount <> 0 then v_lines := v_lines || jsonb_build_object('account_id', v_acc ->> 'OUTPUT_IGST', 'credit', note.igst_amount); end if;
  elsif p_event.source_type = 'SUPPLIER_PAYMENT' then
    v_lines := jsonb_build_array(jsonb_build_object('account_id', v_acc ->> 'CREDITORS', 'party_id', v_party, 'debit', spay.amount),
                                 jsonb_build_object('account_id', v_acc ->> 'SUPPLIER_PAYMENT_ACCOUNT', 'credit', spay.amount));
  else
    v_lines := jsonb_build_array(jsonb_build_object('account_id', v_acc ->> 'PURCHASES', 'debit', v_net));
    if v_gst <> 0 then v_lines := v_lines || jsonb_build_object('account_id', v_acc ->> 'GST_INPUT_PENDING', 'debit', v_gst); end if;
    v_lines := v_lines || jsonb_build_object('account_id', v_acc ->> 'CREDITORS', 'party_id', v_party, 'credit', v_payable);
  end if;
  return jsonb_build_object('outcome', 'POST', 'type', v_type, 'date', v_date, 'reference', v_ref, 'narration', left(v_narr, 1000), 'lines', v_lines);
end;
$$;

-- Reason text of a source document's cancellation / reversal.
create or replace function private.accounting_source_reversal_reason(p_type text, p_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(case p_type
    when 'SALES_INVOICE' then (select 'Invoice ' || invoice_number || ' cancelled: ' || coalesce(cancellation_reason, '') from public.sales_invoices where id = p_id)
    when 'CUSTOMER_RECEIPT' then (select 'Receipt ' || receipt_number || ' reversed: ' || coalesce(reversal_reason, '') from public.customer_payments where id = p_id)
    when 'CREDIT_NOTE' then (select 'Credit note ' || note_number || ' cancelled: ' || coalesce(cancellation_reason, '') from public.invoice_adjustment_notes where id = p_id)
    when 'DEBIT_NOTE' then (select 'Debit note ' || note_number || ' cancelled: ' || coalesce(cancellation_reason, '') from public.invoice_adjustment_notes where id = p_id)
    when 'SUPPLIER_PAYMENT' then (select 'Supplier payment ' || payment_number || ' reversed: ' || coalesce(reversal_reason, '') from public.supplier_payments where id = p_id)
    when 'GOODS_RECEIPT' then (select 'Goods receipt ' || receipt_number || ' reversed: ' || coalesce(reversal_reason, '') from public.goods_receipts where id = p_id)
  end, 'Source document cancelled in the ERP');
$$;

-- Queues events for every eligible source document. Idempotent. Returns the number of new events per status.
create or replace function private.accounting_scan(p_company uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  s     public.accounting_settings := private.accounting_require_setup(p_company);
  v_tz  text := private.company_tz(p_company);
  v_new int := 0;
  v_n   int;
begin
  -- POST events: issued / recorded / posted documents dated on or after the books start date (later cancelled ones too:
  -- they were valid documents first and are reversed by their REVERSE event).
  insert into public.accounting_posting_events (company_id, source_type, source_id, event_action, source_number, source_date, amount)
  select p_company, x.source_type, x.id, 'POST', x.num, x.dt, x.amount from (
    select 'SALES_INVOICE' as source_type, i.id, i.invoice_number as num, i.invoice_date as dt, i.grand_total as amount
    from public.sales_invoices i where i.company_id = p_company and i.status in ('ISSUED', 'CANCELLED')
    union all
    select 'CUSTOMER_RECEIPT', p.id, p.receipt_number, p.receipt_date, p.amount_received from public.customer_payments p where p.company_id = p_company
    union all
    select case n.note_type when 'CREDIT' then 'CREDIT_NOTE' else 'DEBIT_NOTE' end, n.id, n.note_number, n.note_date, n.total_amount
    from public.invoice_adjustment_notes n where n.company_id = p_company and n.status in ('ISSUED', 'CANCELLED')
    union all
    select 'SUPPLIER_PAYMENT', sp.id, sp.payment_number, sp.payment_date, sp.amount from public.supplier_payments sp where sp.company_id = p_company
    union all
    select 'GOODS_RECEIPT', g.id, g.receipt_number, g.receipt_date, private.goods_receipt_value(g.id) from public.goods_receipts g where g.company_id = p_company
  ) x
  where x.dt >= s.books_start_date
  on conflict (company_id, source_type, source_id, event_action) do nothing;
  get diagnostics v_n = row_count;
  v_new := v_new + v_n;

  -- REVERSE events: cancelled / reversed documents. When the document itself pre-dates the books start date (it is part of the
  -- opening balances) but was cancelled afterwards, the event is flagged for a manual correction instead of being guessed.
  insert into public.accounting_posting_events (company_id, source_type, source_id, event_action, source_number, source_date, amount, status, error_code, error_message)
  select p_company, x.source_type, x.id, 'REVERSE', x.num, greatest(x.cancel_date, x.dt), x.amount,
         case when x.dt >= s.books_start_date then 'PENDING' else 'FAILED' end,
         case when x.dt >= s.books_start_date then null else 'PRE_BOOKS_SOURCE' end,
         case when x.dt >= s.books_start_date then null else
           'The document is dated before the books start date (it belongs to the opening balances) but was cancelled afterwards. '
           || 'Record the correction with a journal voucher, then dismiss this event.' end
  from (
    select 'SALES_INVOICE' as source_type, i.id, i.invoice_number as num, i.invoice_date as dt, (i.cancelled_at at time zone v_tz)::date as cancel_date, i.grand_total as amount
    from public.sales_invoices i where i.company_id = p_company and i.status = 'CANCELLED'
    union all
    select 'CUSTOMER_RECEIPT', p.id, p.receipt_number, p.receipt_date, (p.reversed_at at time zone v_tz)::date, p.amount_received
    from public.customer_payments p where p.company_id = p_company and p.status = 'REVERSED'
    union all
    select case n.note_type when 'CREDIT' then 'CREDIT_NOTE' else 'DEBIT_NOTE' end, n.id, n.note_number, n.note_date, (n.cancelled_at at time zone v_tz)::date, n.total_amount
    from public.invoice_adjustment_notes n where n.company_id = p_company and n.status = 'CANCELLED'
    union all
    select 'SUPPLIER_PAYMENT', sp.id, sp.payment_number, sp.payment_date, (sp.reversed_at at time zone v_tz)::date, sp.amount
    from public.supplier_payments sp where sp.company_id = p_company and sp.status = 'REVERSED'
    union all
    select 'GOODS_RECEIPT', g.id, g.receipt_number, g.receipt_date, (g.reversed_at at time zone v_tz)::date, private.goods_receipt_value(g.id)
    from public.goods_receipts g where g.company_id = p_company and g.status = 'REVERSED'
  ) x
  where x.cancel_date is not null and (x.dt >= s.books_start_date or x.cancel_date >= s.books_start_date)
  on conflict (company_id, source_type, source_id, event_action) do nothing;
  get diagnostics v_n = row_count;
  v_new := v_new + v_n;
  return jsonb_build_object('queued', v_new);
end;
$$;

-- Processes one event (its own subtransaction). Returns the resulting status.
create or replace function private.accounting_process_event(p_event uuid)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  e        public.accounting_posting_events;
  orig     public.accounting_posting_events;
  b        jsonb;
  v_id     uuid;
  v        public.accounting_vouchers;
  v_status text;
  v_code   text;
  v_msg    text;
  v_vid    uuid;
begin
  -- A concurrent run skips an event another run is working on.
  select * into e from public.accounting_posting_events where id = p_event for update skip locked;
  if not found then
    return 'LOCKED';
  end if;
  if e.status not in ('PENDING', 'FAILED', 'NEEDS_ACCOUNT_MAPPING') then
    return e.status;
  end if;
  begin
    if e.event_action = 'POST' then
      b := private.accounting_build_event(e);
      if b ->> 'outcome' = 'POST' then
        v_id := private.accounting_create_voucher(e.company_id, b ->> 'type', (b ->> 'date')::date, b ->> 'reference', b ->> 'narration', 'AUTO',
          e.source_type, e.source_id, e.source_number, null, b -> 'lines');
        v := private.accounting_post_voucher(v_id);
        v_status := 'POSTED'; v_vid := v.id;
      else
        v_status := case b ->> 'outcome' when 'SKIP' then 'SKIPPED' when 'MAPPING' then 'NEEDS_ACCOUNT_MAPPING' else 'FAILED' end;
        v_code := b ->> 'code'; v_msg := b ->> 'message';
      end if;
    else
      select * into orig from public.accounting_posting_events
      where company_id = e.company_id and source_type = e.source_type and source_id = e.source_id and event_action = 'POST' for update;
      if not found then
        v_status := 'FAILED'; v_code := 'PRE_BOOKS_SOURCE';
        v_msg := 'The document is dated before the books start date (it belongs to the opening balances) but was cancelled afterwards. '
                 || 'Record the correction with a journal voucher, then dismiss this event.';
      elsif orig.status = 'POSTED' then
        v := private.accounting_reverse_voucher(orig.voucher_id, private.accounting_source_reversal_reason(e.source_type, e.source_id),
          greatest(e.source_date, (select voucher_date from public.accounting_vouchers where id = orig.voucher_id)));
        v_status := 'POSTED'; v_vid := v.id;
      elsif orig.status in ('SKIPPED', 'DISMISSED') then
        v_status := 'SKIPPED'; v_code := 'NOTHING_TO_REVERSE'; v_msg := 'The original document was not posted, so there is nothing to reverse.';
      else
        -- Cancelled before it could be posted: net effect zero, post neither.
        update public.accounting_posting_events set status = 'SKIPPED', error_code = 'CANCELLED_BEFORE_POSTING',
          error_message = 'The document was cancelled / reversed before it was posted.', updated_at = now() where id = orig.id;
        v_status := 'SKIPPED'; v_code := 'NOTHING_TO_REVERSE'; v_msg := 'The original document was never posted, so there is nothing to reverse.';
      end if;
    end if;
  exception when others then
    v_status := 'FAILED'; v_code := 'POSTING_ERROR'; v_msg := left(sqlerrm, 2000); v_vid := null;
  end;
  update public.accounting_posting_events
     set status = v_status, voucher_id = v_vid, error_code = case when v_status = 'POSTED' then null else v_code end,
         error_message = case when v_status = 'POSTED' then null else v_msg end,
         -- Only real failures count towards the retry limit (waiting for a mapping does not).
         attempts = attempts + case when v_status = 'FAILED' then 1 else 0 end, last_attempt_at = now(),
         posted_at = case when v_status = 'POSTED' then now() end, updated_at = now()
   where id = e.id;
  return v_status;
end;
$$;

revoke all on function private.accounting_rule_account(uuid, text, text) from public, anon, authenticated;
revoke all on function private.accounting_rule_label(text, text) from public, anon, authenticated;
revoke all on function private.accounting_build_event(public.accounting_posting_events) from public, anon, authenticated;
revoke all on function private.accounting_source_reversal_reason(text, uuid) from public, anon, authenticated;
revoke all on function private.accounting_scan(uuid) from public, anon, authenticated, service_role;
revoke all on function private.accounting_process_event(uuid) from public, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Public RPCs
-- -----------------------------------------------------------------------------
create or replace function public.accounting_posting_scan()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('accounting_posting.manage');
  v_result  jsonb;
begin
  v_result := private.accounting_scan(v_company);
  perform private.write_audit_log(v_company, 'accounting.posting.scanned', 'accounting_posting_event', null, v_result);
  return v_result;
end;
$$;

-- Scans, then processes up to p_limit events: PENDING, NEEDS_ACCOUNT_MAPPING (re-checked every run) and FAILED below the retry limit.
-- Original postings are processed before reversals.
create or replace function public.accounting_posting_run(p_limit integer default 200)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('accounting_posting.manage');
  s         public.accounting_settings := private.accounting_require_setup(v_company);
  v_scan    jsonb;
  r         record;
  v_res     text;
  v_counts  jsonb := '{}'::jsonb;
  v_done    int := 0;
begin
  if not pg_try_advisory_xact_lock(hashtextextended('accounting_posting_run:' || v_company::text, 0)) then
    return jsonb_build_object('busy', true, 'message', 'Another posting run is in progress for this company. Try again in a moment.');
  end if;
  v_scan := private.accounting_scan(v_company);
  for r in
    select id from public.accounting_posting_events
    where company_id = v_company
      and (status in ('PENDING', 'NEEDS_ACCOUNT_MAPPING')
           or (status = 'FAILED' and attempts < s.auto_posting_max_attempts and coalesce(error_code, '') <> 'PRE_BOOKS_SOURCE'))
    order by (event_action = 'REVERSE'), source_date, created_at
    limit least(greatest(coalesce(p_limit, 200), 1), 1000)
  loop
    v_res := private.accounting_process_event(r.id);
    v_counts := jsonb_set(v_counts, array[v_res], to_jsonb(coalesce((v_counts ->> v_res)::int, 0) + 1));
    v_done := v_done + 1;
  end loop;
  perform private.write_audit_log(v_company, 'accounting.posting.run', 'accounting_posting_event', null,
    jsonb_build_object('queued', v_scan -> 'queued', 'processed', v_done, 'results', v_counts));
  return jsonb_build_object('busy', false, 'queued', v_scan -> 'queued', 'processed', v_done, 'results', v_counts,
    'remaining', (select count(*) from public.accounting_posting_events where company_id = v_company and status = 'PENDING'));
end;
$$;

-- Manual retry: resets the attempt counter and processes the event now.
create or replace function public.accounting_posting_retry(p_event_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('accounting_posting.manage');
  e         public.accounting_posting_events;
  v_res     text;
begin
  perform private.accounting_require_setup(v_company);
  select * into e from public.accounting_posting_events where id = p_event_id and company_id = v_company for update;
  if not found then
    raise exception 'Posting event not found.' using errcode = 'P0002';
  end if;
  if e.status not in ('FAILED', 'NEEDS_ACCOUNT_MAPPING', 'PENDING') then
    raise exception 'Only pending, failed or unmapped events can be retried (event is %).', lower(e.status) using errcode = 'P0001';
  end if;
  update public.accounting_posting_events set attempts = 0, status = 'PENDING', updated_at = now() where id = e.id;
  v_res := private.accounting_process_event(e.id);
  perform private.write_audit_log(v_company, 'accounting.posting.retried', 'accounting_posting_event', e.id::text,
    jsonb_build_object('source_type', e.source_type, 'source_number', e.source_number, 'action', e.event_action, 'result', v_res));
  return (select to_jsonb(x) from public.accounting_posting_events x where x.id = e.id);
end;
$$;

create or replace function public.accounting_posting_dismiss(p_event_id uuid, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('accounting_posting.manage');
  e         public.accounting_posting_events;
  v_reason  text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  select * into e from public.accounting_posting_events where id = p_event_id and company_id = v_company for update;
  if not found then
    raise exception 'Posting event not found.' using errcode = 'P0002';
  end if;
  if e.status not in ('FAILED', 'NEEDS_ACCOUNT_MAPPING', 'PENDING') then
    raise exception 'Only pending, failed or unmapped events can be dismissed (event is %).', lower(e.status) using errcode = 'P0001';
  end if;
  if v_reason is null or length(v_reason) < 5 then
    raise exception 'A reason of at least 5 characters is required to dismiss an event.' using errcode = '22023';
  end if;
  update public.accounting_posting_events set status = 'DISMISSED', dismissed_by = auth.uid(), dismissed_at = now(), dismiss_reason = left(v_reason, 500),
    updated_at = now() where id = e.id;
  perform private.write_audit_log(v_company, 'accounting.posting.dismissed', 'accounting_posting_event', e.id::text,
    jsonb_build_object('source_type', e.source_type, 'source_number', e.source_number, 'action', e.event_action, 'reason', left(v_reason, 500)));
  return (select to_jsonb(x) from public.accounting_posting_events x where x.id = e.id);
end;
$$;

-- Posting monitor: filters {status, source_type, search, limit}.
create or replace function public.accounting_posting_events(p_filters jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_any_permission(array['accounting_posting.manage', 'accounting_reports.read']);
  f         jsonb := coalesce(p_filters, '{}'::jsonb);
  v_status  text := upper(nullif(f ->> 'status', ''));
  v_type    text := upper(nullif(f ->> 'source_type', ''));
  v_term    text := nullif(btrim(coalesce(f ->> 'search', '')), '');
  v_limit   int := least(greatest(coalesce((f ->> 'limit')::int, 300), 1), 2000);
begin
  return jsonb_build_object(
    'counts', coalesce((select jsonb_object_agg(status, n) from (select status, count(*) as n from public.accounting_posting_events
                        where company_id = v_company group by status) x), '{}'::jsonb),
    'rows', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'source_type', e.source_type, 'source_id', e.source_id, 'event_action', e.event_action,
        'source_number', e.source_number, 'source_date', e.source_date, 'amount', e.amount, 'status', e.status, 'attempts', e.attempts,
        'last_attempt_at', e.last_attempt_at, 'error_code', e.error_code, 'error_message', e.error_message, 'voucher_id', e.voucher_id,
        'voucher_number', (select voucher_number from public.accounting_vouchers where id = e.voucher_id), 'dismiss_reason', e.dismiss_reason,
        'dismissed_at', e.dismissed_at, 'posted_at', e.posted_at, 'created_at', e.created_at)
        order by e.source_date desc, e.created_at desc)
      from (select * from public.accounting_posting_events
            where company_id = v_company and (v_status is null or status = v_status) and (v_type is null or source_type = v_type)
              and (v_term is null or coalesce(source_number, '') ilike '%' || v_term || '%' or coalesce(error_message, '') ilike '%' || v_term || '%')
            order by source_date desc, created_at desc limit v_limit) e), '[]'::jsonb),
    'max_attempts', (select auto_posting_max_attempts from public.accounting_settings where company_id = v_company));
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array['public.accounting_posting_scan()', 'public.accounting_posting_run(integer)', 'public.accounting_posting_retry(uuid)',
    'public.accounting_posting_dismiss(uuid, text)', 'public.accounting_posting_events(jsonb)'] loop
    execute format('revoke all on function %s from public, anon, service_role', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;
