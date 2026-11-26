-- Rollback of 20261231090400_accounting_bank_cash.
--
-- Drops the bank / cash tables, functions, permissions and the voucher-balance trigger; removes the CTR / BNK voucher types when
-- unused; restores automatic posting, the chart seed and the ERP reset registries of the previous migrations exactly. Posted
-- transfer and bank-adjustment vouchers stay in the books (they are ordinary vouchers). customer_payments / supplier_payments
-- were never changed. audit_logs entries stay (append-only).
--
-- Refused while bank / cash accounts, transfers, statements, matches, reconciliations or payment assignments exist (their history
-- would be lost). To roll back anyway, export them, then   set app.accounting_bank_cash_rollback_force = 'on';   in the same session.

do $$
begin
  if coalesce(current_setting('app.accounting_bank_cash_rollback_force', true), '') <> 'on' and to_regclass('public.bank_cash_accounts') is not null
     and (exists (select 1 from public.bank_cash_accounts) or exists (select 1 from public.bank_transfers) or exists (select 1 from public.bank_statement_imports)
          or exists (select 1 from public.bank_reconciliation_matches) or exists (select 1 from public.bank_reconciliations)
          or exists (select 1 from public.bank_payment_assignments) or exists (select 1 from public.bank_payment_method_policies)) then
    raise exception 'Bank / cash records exist. Export them, then set app.accounting_bank_cash_rollback_force = on to roll back.';
  end if;
end;
$$;

-- Functions as the previous migrations left them (automatic posting first: it no longer calls the Phase 4 helpers).
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
end;
$$;

create or replace function private.erp_reset_tables()
returns table (ord int, table_name text, category text, label text)
language sql
stable
set search_path = ''
as $$
  select * from (values
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

drop function if exists public.bank_cash_account_list(text, boolean);
drop function if exists public.bank_cash_account_save(uuid, jsonb, integer);
drop function if exists public.bank_cash_account_set_active(uuid, boolean, text);
drop function if exists public.bank_account_reveal_number(uuid);
drop function if exists public.bank_payment_policies();
drop function if exists public.bank_payment_policy_save(text, text, boolean);
drop function if exists public.bank_payment_candidates(jsonb);
drop function if exists public.bank_payment_assign(text, uuid, uuid, text);
drop function if exists public.bank_cash_book(uuid, date, date, jsonb);
drop function if exists public.bank_transfer_save(uuid, jsonb, integer);
drop function if exists public.bank_transfer_post(uuid);
drop function if exists public.bank_transfer_cancel(uuid, text);
drop function if exists public.bank_transfer_reverse(uuid, text);
drop function if exists public.bank_transfer_list(jsonb);
drop function if exists public.bank_statement_import(uuid, jsonb, jsonb, jsonb, boolean);
drop function if exists public.bank_statement_imports_list(uuid);
drop function if exists public.bank_statement_import_get(uuid);
drop function if exists public.bank_statement_file(uuid);
drop function if exists public.bank_reconciliation_workspace(uuid, date, date, boolean);
drop function if exists public.bank_reconciliation_suggestions(uuid, integer);
drop function if exists public.bank_reconciliation_match(uuid, jsonb, text);
drop function if exists public.bank_reconciliation_auto_match(uuid, integer);
drop function if exists public.bank_reconciliation_unmatch(uuid, text);
drop function if exists public.bank_statement_adjustment_proposal(uuid);
drop function if exists public.bank_statement_adjust(uuid, uuid, text, jsonb, text);
drop function if exists public.bank_reconciliation_statement(uuid, date, numeric);
drop function if exists public.bank_reconciliation_save(uuid, date, numeric, text);
drop function if exists public.bank_reconciliation_history(uuid);
drop function if exists public.bank_report(text, jsonb);
drop function if exists public.bank_lookups();
drop trigger if exists accounting_vouchers_bank_cash_balance on public.accounting_vouchers;
drop function if exists private.bank_cash_balance_guard();
drop function if exists private.bank_brs(public.bank_cash_accounts, date, numeric);
drop function if exists private.bank_outstanding_statement(uuid, date);
drop function if exists private.bank_outstanding_ledger(uuid, date);
drop function if exists private.bank_recon_insert_match(public.bank_cash_accounts, jsonb, text, text);
drop function if exists private.bank_recon_proposals(uuid, integer);
drop function if exists private.bank_recon_lock(public.bank_cash_accounts);
drop function if exists private.bank_transfer_json(uuid);
drop function if exists private.bank_account_json(public.bank_cash_accounts);
drop function if exists private.bank_account_for(uuid, uuid, text);
drop function if exists private.bank_ledger_balance(uuid, date);
drop function if exists private.bank_ledger_rows(uuid);
drop function if exists private.bank_match_state(numeric, numeric);
drop function if exists private.bank_ledger_matched(uuid, date);
drop function if exists private.bank_stmt_matched(uuid, date);
drop function if exists private.bank_payment_requires_selection(uuid, text, text);
drop function if exists private.bank_payment_assigned_ledger(text, uuid);
drop function if exists private.accounting_seed_bank_cash(uuid);

drop table if exists public.bank_reconciliation_match_items;
drop table if exists public.bank_reconciliation_matches;
drop table if exists public.bank_reconciliations;
drop table if exists public.bank_statement_files;
drop table if exists public.bank_statement_lines;
drop table if exists public.bank_statement_imports;
drop table if exists public.bank_transfers;
drop table if exists public.bank_payment_assignments;
drop table if exists public.bank_payment_method_policies;
drop table if exists public.bank_account_numbers;
drop table if exists public.bank_cash_accounts;
drop function if exists private.bank_history_guard();

-- Voucher types of transfers and bank adjustments (kept while vouchers use them).
delete from public.accounting_voucher_sequences where voucher_type_id in (select t.id from public.accounting_voucher_types t where t.type_code in ('CTR', 'BNK')
  and not exists (select 1 from public.accounting_vouchers v where v.voucher_type_id = t.id));
delete from public.accounting_voucher_types t where t.type_code in ('CTR', 'BNK') and not exists (select 1 from public.accounting_vouchers v where v.voucher_type_id = t.id);

delete from public.role_permissions where permission_id in (select id from public.permissions where resource in ('bank_accounts', 'cash_accounts', 'bank_reconciliation', 'bank_transfers'));
delete from public.permissions where resource in ('bank_accounts', 'cash_accounts', 'bank_reconciliation', 'bank_transfers');
