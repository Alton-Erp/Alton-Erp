-- Rollback of 20261231090600_accounting_gst_2b (Phase 5, Gate C).
--
-- Restores the Gate B functions exactly (one-step Phase 3 GST verification, ITC view, liability summary, set-off, ERP reset registry,
-- force-reset storage cleanup); drops the GSTR-2B tables, functions, storage policies and the gst-files bucket (when empty). Vouchers are
-- untouched (GSTR-2B never posts). audit_logs stay.
--
-- Refused while any GSTR-2B record exists (export it, then   set app.accounting_gst_2b_rollback_force = 'on';   in the session), and
-- always while original files remain in the gst-files bucket (remove them through the Storage API first: they are evidence).

do $$
begin
  if coalesce(current_setting('app.accounting_gst_2b_rollback_force', true), '') <> 'on' and to_regclass('public.gst_2b_imports') is not null and (
       exists (select 1 from public.gst_2b_match_history) or
       exists (select 1 from public.gst_file_access_grants) or
       exists (select 1 from public.gst_2b_matches) or
       exists (select 1 from public.gst_2b_document_versions) or
       exists (select 1 from public.gst_2b_lines) or
       exists (select 1 from public.gst_2b_documents) or
       exists (select 1 from public.gst_2b_imports)) then
    raise exception 'GSTR-2B records exist. Export them, then set app.accounting_gst_2b_rollback_force = on to roll back.';
  end if;
  if exists (select 1 from storage.objects where bucket_id = 'gst-files') then
    raise exception 'Original GSTR-2B files remain in the gst-files bucket; remove them through the Storage API before rolling back.';
  end if;
end;
$$;

-- Functions as 20261231090500 / 20261031090000 left them.
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
  v_full    jsonb;
  v_zero    jsonb := '{"cgst": 0, "sgst": 0, "igst": 0, "cess": 0}'::jsonb;
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
  -- Phase 5: one decision history; a pending proposal (maker-checker) must be approved or rejected first.
  if (select stage from public.gst_itc_decisions where purchase_invoice_id = i.id order by seq desc limit 1) = 'PROPOSED' then
    raise exception 'A partial-ITC proposal is awaiting approval; approve or reject it first (Accounts › GST › ITC verification).' using errcode = 'P0001';
  end if;
  v_full := jsonb_build_object('cgst', i.cgst_total, 'sgst', i.sgst_total, 'igst', i.igst_total, 'cess', i.cess_total);
  i := private.gst_itc_apply_decision(i, private.gst_itc_split(i, case when v_status = 'ELIGIBLE' then v_full else v_zero end,
         case when v_status = 'ELIGIBLE' then v_zero else v_full end), p_reason, coalesce(p_checks, '{}'::jsonb), '[]'::jsonb, null, true);
  return private.pi_json(i.id);
end;
$$;

create or replace function public.gst_itc_action(p_invoice_id uuid, p_action text, p jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('purchase_invoices.verify_gst');
  v_action  text := upper(coalesce(p_action, ''));
  i         public.purchase_invoices;
  last      public.gst_itc_decisions;
  v_split   jsonb;
  v_reason  text := btrim(coalesce(p ->> 'reason', ''));
  n         record;
  v_rev     public.accounting_vouchers;
begin
  i := private.pi_lock(v_company, p_invoice_id, array['POSTED']);
  select * into last from public.gst_itc_decisions where purchase_invoice_id = i.id order by seq desc limit 1;
  if v_action in ('UNDER_REVIEW', 'ON_HOLD', 'PROPOSE') and i.gst_status <> 'PENDING_VERIFICATION' then
    raise exception 'The GST of this invoice is % — only pending GST is reviewed or decided.', lower(replace(i.gst_status, '_', ' ')) using errcode = 'P0001';
  end if;
  if v_action in ('UNDER_REVIEW', 'ON_HOLD') then
    if length(v_reason) < 5 then
      raise exception 'A reason of at least 5 characters is required.' using errcode = '22023';
    end if;
    if last.stage = 'PROPOSED' then
      raise exception 'A proposal is awaiting approval; approve or reject it first.' using errcode = 'P0001';
    end if;
    perform private.gst_itc_append(i, v_action, null, null, v_reason, null, p -> 'document_refs', null, null);
  elsif v_action = 'PROPOSE' then
    if last.stage = 'PROPOSED' then
      raise exception 'A proposal is already awaiting approval.' using errcode = 'P0001';
    end if;
    if length(v_reason) < 10 then
      raise exception 'Record why (at least 10 characters), e.g. what was checked against the supplier invoice.' using errcode = '22023';
    end if;
    v_split := private.gst_itc_split(i, coalesce(p -> 'eligible', '{}'::jsonb), coalesce(p -> 'ineligible', '{}'::jsonb));
    if (v_split ->> 'eligible_total')::numeric > 0 and not private.gst_itc_checks_ok(p -> 'checks') then
      raise exception 'Eligible input GST needs the checks: supplier invoice verified, goods / services received, supplier GSTIN valid.' using errcode = 'P0001';
    end if;
    perform private.gst_itc_append(i, 'PROPOSED', v_split ->> 'decision', v_split, v_reason, p -> 'checks', p -> 'document_refs', null, null);
  elsif v_action in ('APPROVE', 'REJECT') then
    if last.stage is distinct from 'PROPOSED' then
      raise exception 'There is no proposal awaiting approval.' using errcode = 'P0001';
    end if;
    if last.actor_id = auth.uid() then
      raise exception 'Maker-checker: the person who proposed an ITC decision cannot approve or reject it.' using errcode = '42501';
    end if;
    if v_action = 'REJECT' then
      if length(v_reason) < 5 then
        raise exception 'A reason of at least 5 characters is required.' using errcode = '22023';
      end if;
      perform private.gst_itc_append(i, 'REJECTED', null, null, v_reason, null, null, last.id, null);
    else
      v_split := private.gst_itc_split(i, jsonb_build_object('cgst', last.eligible_cgst, 'sgst', last.eligible_sgst, 'igst', last.eligible_igst, 'cess', last.eligible_cess),
        jsonb_build_object('cgst', last.ineligible_cgst, 'sgst', last.ineligible_sgst, 'igst', last.ineligible_igst, 'cess', last.ineligible_cess));
      i := private.gst_itc_apply_decision(i, v_split, last.reason, last.checks, last.document_refs, last.id, false);
    end if;
  elsif v_action = 'REVERSE_DECISION' then
    if i.gst_status not in ('ELIGIBLE', 'INELIGIBLE', 'PARTIALLY_ELIGIBLE') or i.gst_voucher_id is null then
      raise exception 'There is no posted ITC decision to reverse.' using errcode = 'P0001';
    end if;
    if length(v_reason) < 10 then
      raise exception 'Record why the decision is reversed (at least 10 characters).' using errcode = '22023';
    end if;
    if exists (select 1 from public.gst_itc_adjustments where purchase_invoice_id = i.id and status in ('DRAFT', 'POSTED')) then
      raise exception 'Reverse or cancel the ITC adjustments of this invoice first (newest first).' using errcode = 'P0001';
    end if;
    select * into n from private.gst_itc_net(i.id);
    perform private.gst_itc_input_available(i.company_id, n.eligible_cgst, n.eligible_sgst, n.eligible_igst, n.eligible_cess);
    v_rev := private.accounting_reverse_voucher(i.gst_voucher_id, 'ITC decision reversed: ' || v_reason, null);
    perform private.gst_itc_append(i, 'DECISION_REVERSED', null, null, v_reason, null, null, n.decision_id, v_rev.id);
    update public.purchase_invoices set gst_status = 'PENDING_VERIFICATION', gst_voucher_id = null, gst_verified_by = null, gst_verified_at = null, gst_verification = null,
      updated_by = auth.uid(), updated_at = now(), row_version = row_version + 1 where id = i.id returning * into i;
  else
    raise exception 'Unknown ITC action %.', p_action using errcode = '22023';
  end if;
  return private.gst_itc_json(i.id);
end;
$$;

create or replace function private.gst_itc_json(p_invoice uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('invoice_id', i.id, 'invoice_number', i.invoice_number, 'supplier_invoice_number', i.supplier_invoice_number, 'supplier_gstin', i.supplier_gstin,
    'gst_status', i.gst_status, 'gst_voucher_id', i.gst_voucher_id,
    'pending', jsonb_build_object('cgst', i.cgst_total, 'sgst', i.sgst_total, 'igst', i.igst_total, 'cess', i.cess_total),
    'net', (select to_jsonb(n) from private.gst_itc_net(i.id) n),
    'stage', (select stage from public.gst_itc_decisions where purchase_invoice_id = i.id order by seq desc limit 1),
    'history', coalesce((select jsonb_agg(to_jsonb(d) - 'company_id' || jsonb_build_object('by', (select full_name from public.profiles where id = d.actor_id),
       'voucher_number', (select voucher_number from public.accounting_vouchers where id = d.voucher_id)) order by d.seq)
       from public.gst_itc_decisions d where d.purchase_invoice_id = i.id), '[]'::jsonb),
    'adjustments', coalesce((select jsonb_agg(to_jsonb(a) - 'company_id' || jsonb_build_object('voucher_number', (select voucher_number from public.accounting_vouchers where id = a.voucher_id))
       order by a.prepared_at) from public.gst_itc_adjustments a where a.purchase_invoice_id = i.id), '[]'::jsonb))
  from public.purchase_invoices i where i.id = p_invoice;
$$;

create or replace function private.gst_liability(p public.gst_return_periods)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'output', jsonb_build_object(
      'IGST', -private.gst_ledger_movement(p.company_id, 'OUTPUT_IGST', p.period_start, p.period_end, 'GST_SET_OFF'),
      'CGST', -private.gst_ledger_movement(p.company_id, 'OUTPUT_CGST', p.period_start, p.period_end, 'GST_SET_OFF'),
      'SGST', -private.gst_ledger_movement(p.company_id, 'OUTPUT_SGST', p.period_start, p.period_end, 'GST_SET_OFF'),
      'CESS', 0),
    'rcm', (select jsonb_build_object('IGST', coalesce(sum(igst_total), 0), 'CGST', coalesce(sum(cgst_total), 0), 'SGST', coalesce(sum(sgst_total), 0), 'CESS', coalesce(sum(cess_total), 0))
            from public.purchase_invoices where company_id = p.company_id and status = 'POSTED' and reverse_charge and recorded_date between p.period_start and p.period_end),
    'set_off', (select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) from (
            select l.liability_kind || ':' || l.liability_head as k, sum(l.amount) as v from public.gst_set_off_lines l join public.gst_set_offs s on s.id = l.set_off_id
            where s.period_id = p.id and s.status = 'POSTED' group by 1) x),
    'credit', jsonb_build_object('IGST', private.gst_ledger_movement(p.company_id, 'INPUT_IGST', null, null), 'CGST', private.gst_ledger_movement(p.company_id, 'INPUT_CGST', null, null),
      'SGST', private.gst_ledger_movement(p.company_id, 'INPUT_SGST', null, null), 'CESS', private.gst_ledger_movement(p.company_id, 'INPUT_CESS', null, null)),
    'cash', coalesce((select jsonb_object_agg(c.major_head || ':' || c.minor_head, c.amount) from private.gst_cash_available(p.registration_id) c), '{}'::jsonb),
    'cash_ledger', private.gst_ledger_movement(p.company_id, 'GST_ELECTRONIC_CASH', null, null));
$$;

create or replace function public.gst_set_off(p_action text, p_id uuid, p jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_action  text := upper(coalesce(p_action, ''));
  v_company uuid := private.require_permission(case when v_action in ('POST', 'REVERSE') then 'gst_payments.post' else 'gst_payments.create' end);
  s         public.gst_set_offs;
  per       public.gst_return_periods;
  v_cfg     public.gst_config_versions;
  liab      jsonb;
  l         record;
  v_used    numeric;
  v_open    numeric;
  v_lines   jsonb := '[]'::jsonb;
  v_id      uuid;
  v         public.accounting_vouchers;
  k         text;
  v_amt     numeric;
begin
  if v_action = 'SAVE' then
    if jsonb_typeof(p -> 'lines') <> 'array' or jsonb_array_length(p -> 'lines') = 0 then
      raise exception 'A set-off needs at least one line.' using errcode = '22023';
    end if;
    if p_id is null then
      per := private.gst_period_lock(v_company, private.accounting_uuid(p, 'period_id', 'Period'));
      insert into public.gst_set_offs (company_id, registration_id, period_id, notes, prepared_by)
      values (v_company, per.registration_id, per.id, left(p ->> 'notes', 1000), auth.uid()) returning * into s;
    else
      select * into s from public.gst_set_offs where id = p_id and company_id = v_company for update;
      if not found or s.status <> 'DRAFT' then
        raise exception 'Only a draft set-off can be edited.' using errcode = 'P0001';
      end if;
      if nullif(p ->> 'row_version', '') is not null and s.row_version <> (p ->> 'row_version')::int then
        raise exception 'This set-off was changed by someone else. Reload it and try again.' using errcode = '40001';
      end if;
      delete from public.gst_set_off_lines where set_off_id = s.id;
      update public.gst_set_offs set notes = left(p ->> 'notes', 1000), prepared_by = auth.uid(), prepared_at = now(), row_version = row_version + 1 where id = s.id returning * into s;
    end if;
    insert into public.gst_set_off_lines (company_id, set_off_id, line_no, liability_kind, liability_head, source, source_head, cash_minor_head, amount)
    select v_company, s.id, row_number() over (), upper(x ->> 'liability_kind'), upper(x ->> 'liability_head'), upper(x ->> 'source'), upper(x ->> 'source_head'),
           nullif(upper(coalesce(x ->> 'cash_minor_head', '')), ''), (x ->> 'amount')::numeric
    from jsonb_array_elements(p -> 'lines') x;
    insert into public.gst_set_off_events (company_id, set_off_id, action, details, actor_id) values (v_company, s.id, 'SAVED', jsonb_build_object('lines', p -> 'lines'), auth.uid());
  else
    select * into s from public.gst_set_offs where id = p_id and company_id = v_company;
    if not found then
      raise exception 'Set-off not found.' using errcode = 'P0002';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('gst_setoff:' || s.registration_id::text, 0));
    per := private.gst_period_lock(v_company, s.period_id);
    select * into s from public.gst_set_offs where id = p_id for update;
    if v_action = 'CANCEL' then
      if s.status <> 'DRAFT' then
        raise exception 'Only a draft set-off can be cancelled.' using errcode = 'P0001';
      end if;
      update public.gst_set_offs set status = 'CANCELLED', status_reason = left(p ->> 'reason', 1000), row_version = row_version + 1 where id = s.id returning * into s;
      insert into public.gst_set_off_events (company_id, set_off_id, action, reason, actor_id) values (v_company, s.id, 'CANCELLED', p ->> 'reason', auth.uid());
    elsif v_action = 'POST' then
      if s.status <> 'DRAFT' then
        raise exception 'Only a draft set-off can be posted (this one is %).', lower(s.status) using errcode = 'P0001';
      end if;
      if s.prepared_by = auth.uid() then
        raise exception 'Maker-checker: the person who prepared the set-off cannot post it.' using errcode = '42501';
      end if;
      if exists (select 1 from public.gst_set_offs where period_id = per.id and status = 'POSTED') then
        raise exception 'A set-off is already posted for period %; reverse it before posting another.', per.period_code using errcode = 'P0001';
      end if;
      v_cfg := private.gst_config_on(v_company, per.period_end);
      if v_cfg.id is null then
        raise exception 'No approved GST configuration is in force for period %.', per.period_code using errcode = 'P0001';
      end if;
      foreach k in array array['GST_ELECTRONIC_CASH', 'GST_INTEREST', 'GST_LATE_FEE'] loop
        if private.accounting_rule_account(v_company, k, '') is null then
          raise exception 'Set up the GST ledgers first (% is not mapped).', k using errcode = 'P0001';
        end if;
      end loop;
      liab := private.gst_liability(per);
      -- Every line: valid pairing, and the source / liability kinds allowed.
      for l in select * from public.gst_set_off_lines where set_off_id = s.id order by line_no loop
        if l.source = 'CREDIT' and not ((v_cfg.payload -> 'set_off_matrix' -> l.liability_head) ? l.source_head) then
          raise exception 'Line %: % credit may not pay % liability (configured set-off matrix).', l.line_no, l.source_head, l.liability_head using errcode = 'P0001';
        end if;
        if l.source = 'CASH' and l.source_head <> l.liability_head then
          raise exception 'Line %: % liability is paid from % electronic cash only.', l.line_no, l.liability_head, l.liability_head using errcode = 'P0001';
        end if;
        if l.liability_kind = 'RCM' and l.source = 'CREDIT' and (v_cfg.payload ->> 'rcm_cash_only')::boolean then
          raise exception 'Line %: reverse-charge liability is paid in cash only (configuration).', l.line_no using errcode = 'P0001';
        end if;
        if l.source = 'CASH' and l.liability_kind in ('OUTPUT', 'RCM') and l.cash_minor_head <> 'TAX' or l.liability_kind = 'INTEREST' and l.cash_minor_head <> 'INTEREST'
           or l.liability_kind = 'LATE_FEE' and l.cash_minor_head not in ('FEE', 'PENALTY') then
          raise exception 'Line %: the electronic-cash minor head does not fit the liability (tax from TAX, interest from INTEREST, late fee from FEE / PENALTY).', l.line_no
            using errcode = 'P0001';
        end if;
      end loop;
      -- Liability per kind / head never exceeded.
      for l in select liability_kind, liability_head, sum(amount) as amt from public.gst_set_off_lines where set_off_id = s.id and liability_kind in ('OUTPUT', 'RCM') group by 1, 2 loop
        v_open := coalesce((liab -> lower(l.liability_kind) ->> l.liability_head)::numeric, 0) - coalesce((liab -> 'set_off' ->> (l.liability_kind || ':' || l.liability_head))::numeric, 0);
        if l.amt > v_open then
          raise exception '% % liability of % is % — the set-off uses %.', initcap(lower(l.liability_kind)), l.liability_head, per.period_code, v_open, l.amt using errcode = 'P0001';
        end if;
      end loop;
      -- Credit per head never exceeded.
      for l in select source_head, sum(amount) as amt from public.gst_set_off_lines where set_off_id = s.id and source = 'CREDIT' group by 1 loop
        if l.amt > coalesce((liab -> 'credit' ->> l.source_head)::numeric, 0) then
          raise exception 'Input % available is % — the set-off uses %.', l.source_head, coalesce((liab -> 'credit' ->> l.source_head)::numeric, 0), l.amt using errcode = 'P0001';
        end if;
      end loop;
      -- Electronic cash per head never negative; the ledger as a whole too.
      for l in select source_head, cash_minor_head, sum(amount) as amt from public.gst_set_off_lines where set_off_id = s.id and source = 'CASH' group by 1, 2 loop
        if l.amt > coalesce((liab -> 'cash' ->> (l.source_head || ':' || l.cash_minor_head))::numeric, 0) then
          raise exception 'Electronic cash % % available is % — the set-off uses %.', l.source_head, l.cash_minor_head,
            coalesce((liab -> 'cash' ->> (l.source_head || ':' || l.cash_minor_head))::numeric, 0), l.amt using errcode = 'P0001';
        end if;
      end loop;
      if (select coalesce(sum(amount), 0) from public.gst_set_off_lines where set_off_id = s.id and source = 'CASH') > (liab ->> 'cash_ledger')::numeric then
        raise exception 'The GST electronic cash ledger balance is lower than the cash used.' using errcode = 'P0001';
      end if;
      -- Voucher: Dr liabilities / Cr credits and electronic cash.
      for l in select liability_kind, liability_head, sum(amount) as amt from public.gst_set_off_lines where set_off_id = s.id group by 1, 2 order by 1, 2 loop
        v_lines := v_lines || jsonb_build_object('account_id', private.accounting_rule_account(v_company,
          case l.liability_kind when 'OUTPUT' then 'OUTPUT_' || l.liability_head when 'RCM' then 'RCM_GST_PAYABLE' when 'INTEREST' then 'GST_INTEREST' else 'GST_LATE_FEE' end, ''),
          'debit', l.amt, 'narration', initcap(lower(l.liability_kind)) || ' ' || l.liability_head || ' ' || per.period_code);
      end loop;
      for l in select source, source_head, sum(amount) as amt from public.gst_set_off_lines where set_off_id = s.id group by 1, 2 order by 1, 2 loop
        v_lines := v_lines || jsonb_build_object('account_id', private.accounting_rule_account(v_company, case l.source when 'CREDIT' then 'INPUT_' || l.source_head else 'GST_ELECTRONIC_CASH' end, ''),
          'credit', l.amt, 'narration', case l.source when 'CREDIT' then 'Input ' || l.source_head || ' utilised' else 'Electronic cash ' || l.source_head || ' utilised' end);
      end loop;
      if (select count(*) from public.gst_set_off_lines where set_off_id = s.id and liability_kind in ('OUTPUT', 'RCM') and liability_head = 'CESS' and source = 'CREDIT') > 0
         and private.accounting_rule_account(v_company, 'INPUT_CESS', '') is null then
        raise exception 'Map the Input cess account first.' using errcode = 'P0001';
      end if;
      v_id := private.accounting_create_voucher(v_company, 'GST', private.company_today(v_company), per.period_code,
        left(format('GST set-off for %s', per.period_code), 1000), 'AUTO', 'GST_SET_OFF', s.id, per.period_code, null, v_lines);
      v := private.accounting_post_voucher(v_id);
      update public.gst_set_offs set status = 'POSTED', voucher_id = v.id, posted_by = auth.uid(), posted_at = now(), row_version = row_version + 1 where id = s.id returning * into s;
      insert into public.gst_set_off_events (company_id, set_off_id, action, details, actor_id) values (v_company, s.id, 'POSTED', jsonb_build_object('voucher', v.voucher_number), auth.uid());
    elsif v_action = 'REVERSE' then
      if s.status <> 'POSTED' then
        raise exception 'Only a posted set-off can be reversed.' using errcode = 'P0001';
      end if;
      if length(btrim(coalesce(p ->> 'reason', ''))) < 10 then
        raise exception 'Record why (at least 10 characters).' using errcode = '22023';
      end if;
      v := private.accounting_reverse_voucher(s.voucher_id, 'GST set-off reversed: ' || btrim(p ->> 'reason'), null);
      update public.gst_set_offs set status = 'REVERSED', reversal_voucher_id = v.id, reversed_by = auth.uid(), reversed_at = now(), status_reason = left(btrim(p ->> 'reason'), 1000),
        row_version = row_version + 1 where id = s.id returning * into s;
      insert into public.gst_set_off_events (company_id, set_off_id, action, reason, details, actor_id)
      values (v_company, s.id, 'REVERSED', p ->> 'reason', jsonb_build_object('voucher', v.voucher_number), auth.uid());
    else
      raise exception 'Unknown action %.', p_action using errcode = '22023';
    end if;
  end if;
  perform private.write_audit_log(v_company, 'gst.set_off_' || lower(v_action), 'gst_set_off', s.id::text, jsonb_build_object('period', s.period_id, 'status', s.status));
  return to_jsonb(s) || jsonb_build_object('lines', (select jsonb_agg(to_jsonb(x) - 'company_id' order by x.line_no) from public.gst_set_off_lines x where x.set_off_id = s.id),
    'voucher_number', (select voucher_number from public.accounting_vouchers where id = s.voucher_id));
exception
  when check_violation or invalid_text_representation or not_null_violation then
    raise exception 'Each set-off line needs liability kind / head, source CREDIT / CASH with its head (and the cash minor head) and a positive amount.' using errcode = '22023';
end;
$$;

create or replace function private.erp_reset_tables()
returns table (ord int, table_name text, category text, label text)
language sql
stable
set search_path = ''
as $$
  select * from (values
    (-13, 'gst_period_current_snapshot', 'Accounting', 'GST current snapshot pointers'),
    (-13, 'gst_snapshot_documents', 'Accounting', 'GST snapshot documents'),
    (-13, 'gst_amendment_exceptions', 'Accounting', 'GST amendment exceptions'),
    (-13, 'gst_set_off_lines', 'Accounting', 'GST set-off lines'),
    (-13, 'gst_set_off_events', 'Accounting', 'GST set-off history'),
    (-13, 'gst_challan_heads', 'Accounting', 'GST challan amounts by head'),
    (-13, 'gst_sales_document_detail_history', 'Accounting', 'GST sales detail history'),
    (-12, 'gst_period_snapshots', 'Accounting', 'GST return snapshots'),
    (-12, 'gst_challan_payments', 'Accounting', 'GST challan payments'),
    (-12, 'gst_set_offs', 'Accounting', 'GST set-offs'),
    (-12, 'gst_period_events', 'Accounting', 'GST period history'),
    (-12, 'gst_return_adjustments', 'Accounting', 'GST return adjustments'),
    (-12, 'gst_sales_document_details', 'Accounting', 'GST sales document details'),
    (-12, 'gst_itc_decisions', 'Accounting', 'ITC decision history'),
    (-12, 'gst_itc_adjustments', 'Accounting', 'ITC reversals and reclaims'),
    (-11, 'gst_challans', 'Accounting', 'GST challans'),
    (-10, 'gst_return_periods', 'Accounting', 'GST return periods'),
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

create or replace function private.erp_force_reset_storage_objects(p_company uuid)
returns table (bucket text, name text)
language sql
stable
security definer
set search_path = ''
as $$
  select o.bucket_id::text, o.name::text
  from storage.objects o
  where o.bucket_id in ('product-images', 'documents')
    and o.name like p_company::text || '/%'
    and not exists (select 1 from public.document_versions v join public.documents d on d.id = v.document_id
                    where d.company_id = p_company and d.related_entity_type = 'COMPANY' and v.storage_path = o.name)
  order by 1, 2;
$$;

revoke all on function private.erp_reset_tables() from public, anon, authenticated;

drop policy if exists gst_files_objects_select on storage.objects;
drop policy if exists gst_files_objects_insert on storage.objects;
drop index if exists public.purchase_invoices_gst_2b_key_idx;
drop function if exists public.gst_2b_upload_prepare(jsonb);
drop function if exists public.gst_2b_upload_complete(uuid);
drop function if exists public.gst_2b_verify_target(uuid);
drop function if exists public.gst_2b_imports_list(jsonb);
drop function if exists public.gst_2b_import_get(uuid, jsonb);
drop function if exists public.gst_2b_import_discard(uuid, text);
drop function if exists public.gst_2b_import_commit(uuid, boolean, integer);
drop function if exists public.gst_2b_auto_match(jsonb);
drop function if exists public.gst_2b_match_manual(jsonb);
drop function if exists public.gst_2b_match_decide(uuid, text, text);
drop function if exists public.gst_2b_match_reverse(uuid, text);
drop function if exists public.gst_2b_match_get(uuid);
drop function if exists public.gst_2b_document_get(uuid);
drop function if exists public.gst_2b_report(text, jsonb);
drop function if exists public.gst_2b_file_access(uuid);
drop function if exists public.gst_2b_verify_record(uuid, uuid, jsonb);
drop function if exists private.gst_2b_scope(uuid, jsonb);
drop function if exists private.gst_2b_evidence(uuid);
drop function if exists private.gst_2b_preview(uuid);
drop function if exists private.gst_2b_import_json(uuid);
drop function if exists private.gst_2b_match_json(uuid);
drop function if exists private.gst_2b_propose(public.gst_2b_documents, public.purchase_invoices, text, text);
drop function if exists private.gst_2b_match_log(public.gst_2b_matches, text, text, jsonb);
drop function if exists private.gst_2b_current_version(uuid);
drop function if exists private.gst_2b_compare(public.gst_2b_document_versions, text, public.purchase_invoices, numeric);
drop function if exists private.gst_2b_tolerance(uuid);
drop function if exists private.gst_2b_parse_line(jsonb, text);
drop function if exists private.gst_2b_amount(text);
drop function if exists private.gst_2b_date(text);
drop function if exists private.gst_2b_fy(date);
drop function if exists private.gst_2b_key(text);
drop function if exists private.gst_file_readable(text);
drop function if exists private.gst_file_writable(text);

drop table if exists public.gst_2b_match_history;
drop table if exists public.gst_file_access_grants;
drop table if exists public.gst_2b_matches;
drop table if exists public.gst_2b_document_versions;
drop table if exists public.gst_2b_lines;
drop table if exists public.gst_2b_documents;
drop table if exists public.gst_2b_imports;
drop function if exists private.gst_2b_import_guard();
drop function if exists private.gst_2b_line_guard();
drop function if exists private.gst_2b_document_guard();
drop function if exists private.gst_2b_match_guard();

do $$
begin
  delete from storage.buckets b where b.id = 'gst-files' and not exists (select 1 from storage.objects o where o.bucket_id = b.id);
exception
  when others then
    raise notice 'The gst-files bucket was kept (%); remove it through the Storage API.', sqlerrm;
end;
$$;
