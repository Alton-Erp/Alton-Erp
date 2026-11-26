-- Rollback of 20261231090700_accounting_gst_returns (Phase 5, Gate D).
--
-- Restores the Gate B / Gate C functions exactly (liability summary, configuration validation, GSTR-2B match proposal / view, period
-- transitions, ERP reset registry); drops the return-preparation functions, the filing records table and the configuration version column
-- of GSTR-2B matches. Approved snapshots keep their stored return working (snapshots are never changed). Vouchers are untouched.
--
-- Refused while filing records exist or matches carry a configuration version (export them, then
--   set app.accounting_gst_returns_rollback_force = 'on';   in the session).

do $$
begin
  if coalesce(current_setting('app.accounting_gst_returns_rollback_force', true), '') <> 'on' and to_regclass('public.gst_return_filings') is not null and (
       exists (select 1 from public.gst_return_filings) or exists (select 1 from public.gst_2b_matches where config_version_id is not null)) then
    raise exception 'GST filing records or versioned GSTR-2B matches exist. Export them, then set app.accounting_gst_returns_rollback_force = on to roll back.';
  end if;
end;
$$;

-- Functions as 20261231090500 / 20261231090600 left them.
create or replace function private.gst_liability(p public.gst_return_periods)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  -- Phase 5 Gate C: credit available is QUALIFIED, never the unqualified ledger balance:
  --   input credit accrued up to the period end (input ledger movements dated on or before it, set-off vouchers and their reversals excluded)
  --   less credit used by POSTED set-offs of this registration (reversed set-offs excluded),
  --   never more than the current input ledger balance (later ITC reversals reduce it) and never below zero.
  -- Liability: output (ledger movement in the period, set-off vouchers excluded) and reverse charge (posted RCM invoices recorded in the period);
  -- open = liability less posted set-offs of the period; previous_outstanding = the same for the registration's earlier periods.
  with heads (h) as (values ('IGST'), ('CGST'), ('SGST'), ('CESS')),
  bounds as (select coalesce((select min(period_start) from public.gst_return_periods where registration_id = p.registration_id), p.period_start) as first_start),
  outp as (
    select h,
      case when h = 'CESS' then 0 else -private.gst_ledger_movement(p.company_id, 'OUTPUT_' || h, p.period_start, p.period_end, 'GST_SET_OFF') end as cur,
      case when h = 'CESS' then 0 else -private.gst_ledger_movement(p.company_id, 'OUTPUT_' || h, (select first_start from bounds), p.period_start - 1, 'GST_SET_OFF') end as prev
    from heads),
  rcm as (
    select heads.h,
      coalesce(sum(case heads.h when 'IGST' then x.igst_total when 'CGST' then x.cgst_total when 'SGST' then x.sgst_total else x.cess_total end)
        filter (where x.recorded_date between p.period_start and p.period_end), 0) as cur,
      coalesce(sum(case heads.h when 'IGST' then x.igst_total when 'CGST' then x.cgst_total when 'SGST' then x.sgst_total else x.cess_total end)
        filter (where x.recorded_date >= (select first_start from bounds) and x.recorded_date < p.period_start), 0) as prev
    from heads left join public.purchase_invoices x on x.company_id = p.company_id and x.status = 'POSTED' and x.reverse_charge
    group by heads.h),
  so as (
    select l.liability_kind as kind, l.liability_head as h,
      coalesce(sum(l.amount) filter (where s.period_id = p.id), 0) as cur,
      coalesce(sum(l.amount) filter (where sp.period_start < p.period_start), 0) as prev
    from public.gst_set_off_lines l join public.gst_set_offs s on s.id = l.set_off_id join public.gst_return_periods sp on sp.id = s.period_id
    where s.registration_id = p.registration_id and s.status = 'POSTED'
    group by 1, 2),
  liab as (
    select 'OUTPUT' as kind, o.h, o.cur, o.prev from outp o
    union all select 'RCM', r.h, r.cur, r.prev from rcm r),
  cred as (
    select h,
      private.gst_ledger_movement(p.company_id, 'INPUT_' || h, null, p.period_end, 'GST_SET_OFF') as accrued,
      coalesce((select sum(l.amount) from public.gst_set_off_lines l join public.gst_set_offs s on s.id = l.set_off_id
                where s.registration_id = p.registration_id and s.status = 'POSTED' and l.source = 'CREDIT' and l.source_head = heads.h), 0) as used,
      private.gst_ledger_movement(p.company_id, 'INPUT_' || h, null, null) as ledger
    from heads)
  select jsonb_build_object(
    'output', (select jsonb_object_agg(h, cur) from outp),
    'rcm', (select jsonb_object_agg(h, cur) from rcm),
    'set_off', (select coalesce(jsonb_object_agg(kind || ':' || h, cur), '{}'::jsonb) from so where cur > 0),
    'open', (select jsonb_object_agg(a.kind || ':' || a.h, a.cur - coalesce((select so.cur from so where so.kind = a.kind and so.h = a.h), 0)) from liab a),
    'previous_outstanding', (select jsonb_object_agg(a.kind || ':' || a.h, a.prev - coalesce((select so.prev from so where so.kind = a.kind and so.h = a.h), 0)) from liab a),
    'previous_from', (select first_start from bounds),
    'credit', (select jsonb_object_agg(h, greatest(0, least(accrued - used, ledger))) from cred),
    'credit_detail', (select jsonb_object_agg(h, jsonb_build_object('accrued_to_period_end', accrued, 'used_in_posted_set_offs', used, 'ledger_balance', ledger,
       'available', greatest(0, least(accrued - used, ledger)))) from cred),
    'credit_basis', 'Input credit accrued by the period end (set-off vouchers excluded) less credit used by posted set-offs (reversed set-offs excluded), never more than the input ledger balance.',
    'warnings', coalesce((select jsonb_agg(format('%s %s of earlier periods is still outstanding: %s', initcap(lower(a.kind)), a.h,
       a.prev - coalesce((select so.prev from so where so.kind = a.kind and so.h = a.h), 0)) order by a.kind, a.h)
       from liab a where a.prev - coalesce((select so.prev from so where so.kind = a.kind and so.h = a.h), 0) > 0), '[]'::jsonb),
    'cash', coalesce((select jsonb_object_agg(c.major_head || ':' || c.minor_head, c.amount) from private.gst_cash_available(p.registration_id) c), '{}'::jsonb),
    'cash_ledger', private.gst_ledger_movement(p.company_id, 'GST_ELECTRONIC_CASH', null, null));
$$;

create or replace function private.gst_config_validate(p jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  e      jsonb := '[]'::jsonb;
  v_h    text;
  v_r    jsonb;
  v_x    text;
begin
  if jsonb_typeof(p -> 'gst_rates') <> 'array' or jsonb_array_length(p -> 'gst_rates') = 0
     or exists (select 1 from jsonb_array_elements(p -> 'gst_rates') x where jsonb_typeof(x) <> 'number' or x::text::numeric < 0 or x::text::numeric > 100
                or x::text::numeric <> round(x::text::numeric, 2)) then
    e := e || to_jsonb('gst_rates: a non-empty list of rates between 0 and 100 (2 decimals).'::text);
  end if;
  if jsonb_typeof(p -> 'b2cl_invoice_threshold') <> 'number' or (p ->> 'b2cl_invoice_threshold')::numeric <= 0 then
    e := e || to_jsonb('b2cl_invoice_threshold: the invoice value above which inter-state B2C invoices are reported individually (a positive amount).'::text);
  end if;
  for v_x in select unnest(array['gstr1_monthly_day', 'gstr1_quarterly_day', 'gstr3b_monthly_day', 'gstr3b_quarterly_day']) loop
    if jsonb_typeof(p -> 'due_days' -> v_x) <> 'number' or (p -> 'due_days' ->> v_x)::numeric not between 1 and 31 then
      e := e || to_jsonb(format('due_days.%s: a day of the following month (1-31).', v_x));
    end if;
  end loop;
  if jsonb_typeof(p -> 'uqc_map') <> 'object' or exists (select 1 from jsonb_each_text(p -> 'uqc_map') x where x.value !~ '^[A-Z]{3}$') then
    e := e || to_jsonb('uqc_map: unit → three-letter UQC, e.g. {"PCS": "PCS", "KG": "KGS"}.'::text);
  end if;
  if jsonb_typeof(p -> 'set_off_matrix') <> 'object' then
    e := e || to_jsonb('set_off_matrix: for each liability head (IGST, CGST, SGST, CESS) the credit heads that may pay it.'::text);
  else
    foreach v_h in array array['IGST', 'CGST', 'SGST', 'CESS'] loop
      v_r := p -> 'set_off_matrix' -> v_h;
      if jsonb_typeof(v_r) <> 'array' or jsonb_array_length(v_r) = 0
         or exists (select 1 from jsonb_array_elements_text(v_r) x where x not in ('IGST', 'CGST', 'SGST', 'CESS')) then
        e := e || to_jsonb(format('set_off_matrix.%s: a non-empty list of credit heads.', v_h));
      elsif (v_h = 'CESS' and v_r <> '["CESS"]'::jsonb) or (v_h <> 'CESS' and v_r ? 'CESS') then
        e := e || to_jsonb('set_off_matrix: cess credit may pay only cess, and cess only from cess credit.'::text);
      end if;
    end loop;
  end if;
  if coalesce(p ->> 'set_off_order', '') not in ('IGST_FIRST', 'NONE') then
    e := e || to_jsonb('set_off_order: IGST_FIRST or NONE.'::text);
  end if;
  if jsonb_typeof(p -> 'rcm_cash_only') <> 'boolean' then
    e := e || to_jsonb('rcm_cash_only: true / false — whether reverse-charge liability may be paid only in cash.'::text);
  end if;
  if jsonb_typeof(p -> 'challan') <> 'object' or coalesce(p -> 'challan' ->> 'cpin_pattern', '') = '' or coalesce(p -> 'challan' ->> 'cin_pattern', '') = ''
     or jsonb_typeof(p -> 'challan' -> 'cin_starts_with_cpin') <> 'boolean' then
    e := e || to_jsonb('challan: {cpin_pattern, cin_pattern, cin_starts_with_cpin} — the reference formats to validate.'::text);
  else
    begin
      perform '' ~ (p -> 'challan' ->> 'cpin_pattern');
      perform '' ~ (p -> 'challan' ->> 'cin_pattern');
    exception when others then
      e := e || to_jsonb('challan: cpin_pattern / cin_pattern must be valid regular expressions.'::text);
    end;
  end if;
  if jsonb_typeof(p -> 'section_map') <> 'object' or not (p -> 'section_map' ?& array['B2B', 'B2CL', 'B2CS', 'EXP', 'CDNR', 'CDNUR', 'NIL']) then
    e := e || to_jsonb('section_map: descriptions for B2B, B2CL, B2CS, EXP, CDNR, CDNUR and NIL (how supplies map to GSTR-1 sections).'::text);
  end if;
  return e;
exception
  when invalid_text_representation or numeric_value_out_of_range then
    return e || to_jsonb('A number in the configuration is not valid.'::text);
end;
$$;

create or replace function private.gst_2b_propose(d public.gst_2b_documents, i public.purchase_invoices, p_method text, p_reason text)
returns public.gst_2b_matches
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v   public.gst_2b_document_versions := private.gst_2b_current_version(d.id);
  tol numeric := private.gst_2b_tolerance(d.company_id);
  c   jsonb := private.gst_2b_compare(v, d.supplier_gstin, i, tol);
  m   public.gst_2b_matches;
begin
  insert into public.gst_2b_matches (company_id, registration_id, document_id, document_version_id, purchase_invoice_id, method, outcome, mismatches, differences, tolerance,
    reason, proposed_by)
  values (d.company_id, d.registration_id, d.id, v.id, i.id, p_method, c ->> 'outcome', array(select jsonb_array_elements_text(c -> 'mismatches')), c -> 'differences', tol,
    nullif(btrim(coalesce(p_reason, '')), ''), auth.uid())
  returning * into m;
  perform private.gst_2b_match_log(m, 'PROPOSED', p_reason, c || jsonb_build_object('method', p_method, 'version_no', v.version_no));
  return m;
exception
  when unique_violation then
    raise exception 'This GSTR-2B document or purchase invoice already has a proposed or approved match.' using errcode = 'P0001';
end;
$$;

create or replace function private.gst_2b_match_json(p_match uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select to_jsonb(m) - 'company_id' || jsonb_build_object(
    'invoice_number', i.invoice_number, 'supplier_invoice_number', i.supplier_invoice_number, 'invoice_status', i.status, 'invoice_gst_status', i.gst_status,
    'supplier_gstin', d.supplier_gstin, 'doc_number', v.doc_number, 'doc_date', v.doc_date, 'version_no', v.version_no, 'doc_type', d.doc_type,
    'is_current_version', v.id = (private.gst_2b_current_version(d.id)).id,
    'proposed_by_name', (select full_name from public.profiles where id = m.proposed_by), 'decided_by_name', (select full_name from public.profiles where id = m.decided_by),
    'history', coalesce((select jsonb_agg(to_jsonb(h) - 'company_id' || jsonb_build_object('by', (select full_name from public.profiles where id = h.actor_id)) order by h.created_at, h.id)
       from public.gst_2b_match_history h where h.match_id = m.id), '[]'::jsonb))
  from public.gst_2b_matches m join public.purchase_invoices i on i.id = m.purchase_invoice_id join public.gst_2b_documents d on d.id = m.document_id
  join public.gst_2b_document_versions v on v.id = m.document_version_id
  where m.id = p_match;
$$;

create or replace function public.gst_period_transition(p_period_id uuid, p_action text, p_reason text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_action  text := upper(coalesce(p_action, ''));
  v_company uuid := private.require_any_permission(case v_action when 'APPROVE' then array['gst_returns.approve'] when 'CLOSE' then array['gst_periods.close']
                      when 'REOPEN' then array['gst_periods.reopen'] else array['gst_returns.prepare'] end);
  p         public.gst_return_periods := private.gst_period_lock(v_company, p_period_id);
  v_from    text := p.status;
  v_block   jsonb;
  v_snap    uuid;
  v_ver     integer;
  v_cfg     public.gst_config_versions;
  v_totals  jsonb;
  v_data    jsonb;
begin
  if v_action = 'START_REVIEW' and p.status = 'OPEN' then
    update public.gst_return_periods set status = 'UNDER_REVIEW', updated_at = now(), row_version = row_version + 1 where id = p.id returning * into p;
    perform private.gst_period_event(p, 'REVIEW_STARTED', v_from, p_reason);
  elsif v_action = 'READY' and p.status = 'UNDER_REVIEW' then
    select jsonb_agg(x) into v_block from jsonb_array_elements(private.gst_period_checklist(p)) x where (x ->> 'blocking')::boolean and (x ->> 'count')::int > 0;
    if v_block is not null then
      raise exception '%', v_block -> 0 ->> 'message' using errcode = 'P0001', detail = v_block::text;
    end if;
    update public.gst_return_periods set status = 'READY_FOR_APPROVAL', prepared_by = auth.uid(), prepared_at = now(), updated_at = now(), row_version = row_version + 1
    where id = p.id returning * into p;
    perform private.gst_period_event(p, 'READY', v_from, p_reason);
  elsif v_action = 'RETURN' and p.status = 'READY_FOR_APPROVAL' then
    if length(btrim(coalesce(p_reason, ''))) < 5 then
      raise exception 'A reason of at least 5 characters is required.' using errcode = '22023';
    end if;
    update public.gst_return_periods set status = 'UNDER_REVIEW', prepared_by = null, prepared_at = null, updated_at = now(), row_version = row_version + 1
    where id = p.id returning * into p;
    perform private.gst_period_event(p, 'RETURNED', v_from, p_reason);
  elsif v_action = 'APPROVE' and p.status = 'READY_FOR_APPROVAL' then
    if p.prepared_by = auth.uid() then
      raise exception 'Maker-checker: the person who prepared the period cannot approve it.' using errcode = '42501';
    end if;
    select jsonb_agg(x) into v_block from jsonb_array_elements(private.gst_period_checklist(p)) x where (x ->> 'blocking')::boolean and (x ->> 'count')::int > 0;
    if v_block is not null then
      raise exception '%', v_block -> 0 ->> 'message' using errcode = 'P0001', detail = v_block::text;
    end if;
    v_cfg := private.gst_config_on(v_company, p.period_end);
    select coalesce(max(version_no), 0) + 1 into v_ver from public.gst_period_snapshots where period_id = p.id;
    select jsonb_build_object(
        'outward', jsonb_build_object('documents', count(*) filter (where source_kind = 'SALES_INVOICE'),
          'taxable', coalesce(sum((amounts ->> 'taxable')::numeric) filter (where source_kind = 'SALES_INVOICE'), 0),
          'cgst', coalesce(sum((amounts ->> 'cgst')::numeric) filter (where source_kind = 'SALES_INVOICE'), 0),
          'sgst', coalesce(sum((amounts ->> 'sgst')::numeric) filter (where source_kind = 'SALES_INVOICE'), 0),
          'igst', coalesce(sum((amounts ->> 'igst')::numeric) filter (where source_kind = 'SALES_INVOICE'), 0)),
        'credit_notes', jsonb_build_object('documents', count(*) filter (where source_kind = 'CREDIT_NOTE'),
          'taxable', coalesce(sum((amounts ->> 'taxable')::numeric) filter (where source_kind = 'CREDIT_NOTE'), 0),
          'tax', coalesce(sum((amounts ->> 'cgst')::numeric + (amounts ->> 'sgst')::numeric + (amounts ->> 'igst')::numeric) filter (where source_kind = 'CREDIT_NOTE'), 0)),
        'debit_notes', jsonb_build_object('documents', count(*) filter (where source_kind = 'DEBIT_NOTE'),
          'taxable', coalesce(sum((amounts ->> 'taxable')::numeric) filter (where source_kind = 'DEBIT_NOTE'), 0),
          'tax', coalesce(sum((amounts ->> 'cgst')::numeric + (amounts ->> 'sgst')::numeric + (amounts ->> 'igst')::numeric) filter (where source_kind = 'DEBIT_NOTE'), 0)),
        'inward', jsonb_build_object('documents', count(*) filter (where source_kind = 'PURCHASE_INVOICE'),
          'taxable', coalesce(sum((amounts ->> 'taxable')::numeric) filter (where source_kind = 'PURCHASE_INVOICE'), 0),
          'tax', coalesce(sum((amounts ->> 'cgst')::numeric + (amounts ->> 'sgst')::numeric + (amounts ->> 'igst')::numeric + (amounts ->> 'cess')::numeric)
                   filter (where source_kind = 'PURCHASE_INVOICE'), 0),
          'rcm_tax', coalesce(sum((amounts ->> 'cgst')::numeric + (amounts ->> 'sgst')::numeric + (amounts ->> 'igst')::numeric + (amounts ->> 'cess')::numeric)
                   filter (where source_kind = 'PURCHASE_INVOICE' and (amounts ->> 'reverse_charge')::boolean), 0)),
        'itc', jsonb_build_object(
          'eligible', coalesce(sum((amounts ->> 'eligible_cgst')::numeric + (amounts ->> 'eligible_sgst')::numeric + (amounts ->> 'eligible_igst')::numeric
                   + (amounts ->> 'eligible_cess')::numeric) filter (where source_kind = 'ITC_DECISION'), 0),
          'ineligible', coalesce(sum((amounts ->> 'ineligible')::numeric) filter (where source_kind = 'ITC_DECISION'), 0),
          'reversed', coalesce(sum((amounts ->> 'cgst')::numeric + (amounts ->> 'sgst')::numeric + (amounts ->> 'igst')::numeric + (amounts ->> 'cess')::numeric)
                   filter (where source_kind = 'ITC_ADJUSTMENT' and amounts ->> 'kind' = 'REVERSAL'), 0),
          'reclaimed', coalesce(sum((amounts ->> 'cgst')::numeric + (amounts ->> 'sgst')::numeric + (amounts ->> 'igst')::numeric + (amounts ->> 'cess')::numeric)
                   filter (where source_kind = 'ITC_ADJUSTMENT' and amounts ->> 'kind' = 'RECLAIM'), 0)))
      into v_totals
    from private.gst_period_documents(v_company, p.period_start, p.period_end);
    v_data := jsonb_build_object('period', p.period_code, 'from', p.period_start, 'to', p.period_end, 'frequency', p.frequency,
      'registration', (select gstin from public.gst_registrations where id = p.registration_id), 'config_version', v_cfg.version_no,
      'adjustments', coalesce((select jsonb_agg(to_jsonb(a) - 'company_id' order by a.prepared_at) from public.gst_return_adjustments a where a.period_id = p.id and a.status = 'APPROVED'), '[]'::jsonb),
      'amendments_resolved', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'source_kind', e.source_kind, 'source_id', e.source_id,
        'resolution', e.resolution, 'reason', e.resolution_reason)) from public.gst_amendment_exceptions e where e.assigned_period_id = p.id and e.status = 'RESOLVED'), '[]'::jsonb),
      'liability', private.gst_liability(p));
    v_snap := gen_random_uuid();
    insert into public.gst_period_snapshots (id, company_id, period_id, version_no, config_version_id, data, totals, snapshot_hash, prepared_by, approved_by)
    values (v_snap, v_company, p.id, v_ver, v_cfg.id, v_data, v_totals,
      private.gst_hash(jsonb_build_object('data', v_data, 'totals', v_totals, 'documents',
        (select jsonb_agg(jsonb_build_array(d.source_kind, d.source_id, private.gst_hash(d.content)) order by d.source_kind, d.source_id)
         from private.gst_period_documents(v_company, p.period_start, p.period_end) d))), p.prepared_by, auth.uid());
    insert into public.gst_snapshot_documents (company_id, snapshot_id, source_kind, source_id, document_no, document_date, content_hash, amounts)
    select v_company, v_snap, d.source_kind, d.source_id, d.document_no, d.document_date, private.gst_hash(d.content), d.amounts
    from private.gst_period_documents(v_company, p.period_start, p.period_end) d;
    insert into public.gst_period_current_snapshot (period_id, company_id, snapshot_id) values (p.id, v_company, v_snap)
    on conflict (period_id) do update set snapshot_id = excluded.snapshot_id, set_at = now();
    update public.gst_return_periods set status = 'APPROVED', approved_by = auth.uid(), approved_at = now(), updated_at = now(), row_version = row_version + 1
    where id = p.id returning * into p;
    perform private.gst_period_event(p, 'SNAPSHOT', v_from, null, jsonb_build_object('snapshot_id', v_snap, 'version', v_ver));
    perform private.gst_period_event(p, 'APPROVED', v_from, p_reason, jsonb_build_object('snapshot_id', v_snap));
  elsif v_action = 'CLOSE' and p.status = 'APPROVED' then
    if p.prepared_by = auth.uid() then
      raise exception 'Maker-checker: the person who prepared the period cannot close it.' using errcode = '42501';
    end if;
    update public.gst_return_periods set status = 'CLOSED', closed_by = auth.uid(), closed_at = now(), updated_at = now(), row_version = row_version + 1
    where id = p.id returning * into p;
    perform private.gst_period_event(p, 'CLOSED', v_from, p_reason);
  elsif v_action = 'REOPEN' and p.status in ('APPROVED', 'CLOSED') then
    if length(btrim(coalesce(p_reason, ''))) < 10 then
      raise exception 'Reopening needs a reason of at least 10 characters.' using errcode = '22023';
    end if;
    -- The approved snapshot stays exactly as it is; a later approval adds version n+1 and moves the pointer.
    update public.gst_return_periods set status = 'OPEN', prepared_by = null, prepared_at = null, approved_by = null, approved_at = null, closed_by = null, closed_at = null,
      updated_at = now(), row_version = row_version + 1 where id = p.id returning * into p;
    perform private.gst_period_event(p, 'REOPENED', v_from, p_reason);
  else
    raise exception 'Action % is not possible while the period is %.', lower(v_action), lower(replace(p.status, '_', ' ')) using errcode = 'P0001';
  end if;
  return private.gst_period_json(p.id);
end;
$$;

create or replace function private.erp_reset_tables()
returns table (ord int, table_name text, category text, label text)
language sql
stable
set search_path = ''
as $$
  select * from (values
    (-14, 'gst_2b_match_history', 'Accounting', 'GSTR-2B match history'),
    (-14, 'gst_file_access_grants', 'Accounting', 'GST file download grants'),
    (-13, 'gst_2b_matches', 'Accounting', 'GSTR-2B matches'),
    (-12, 'gst_2b_document_versions', 'Accounting', 'GSTR-2B document versions'),
    (-11, 'gst_2b_lines', 'Accounting', 'GSTR-2B imported rows'),
    (-11, 'gst_2b_documents', 'Accounting', 'GSTR-2B supplier documents'),
    (-10, 'gst_2b_imports', 'Accounting', 'GSTR-2B imports'),
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

revoke all on function private.erp_reset_tables() from public, anon, authenticated;

drop function if exists public.gst_return_get(uuid, text);
drop function if exists public.gst_register(text, jsonb);
drop function if exists public.gst_reconciliation_get(uuid);
drop function if exists public.gst_return_exceptions(uuid);
drop function if exists public.gst_dashboard();
drop function if exists public.gst_payments_view(jsonb);
drop function if exists public.gst_return_filing(text, uuid, jsonb);
drop function if exists private.gst_filing_json(uuid, text);
drop function if exists private.gst_ledger_reconciliation(public.gst_return_periods);
drop function if exists private.gst_gstr3b(public.gst_return_periods);
drop function if exists private.gst_gstr1(public.gst_return_periods);
drop function if exists private.gst_return_exceptions(public.gst_return_periods);
drop function if exists private.gst_apply_adjustments(jsonb, uuid, text);
drop function if exists private.gst_itc_events(uuid, date, date);
drop function if exists private.gst_sales_doc_lines(uuid, date, date);
drop function if exists private.gst_sales_docs(uuid, date, date, numeric);
drop function if exists private.gst_sales_section(text, text, text, text, numeric, numeric, numeric, numeric, text);
drop function if exists private.gst_credit_position(public.gst_return_periods);

drop table if exists public.gst_return_filings;
drop function if exists private.gst_return_filing_guard();
alter table public.gst_2b_matches drop constraint if exists gst_2b_matches_config_fk;
alter table public.gst_2b_matches drop column if exists config_version_id;
