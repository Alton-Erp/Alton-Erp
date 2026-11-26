-- =============================================================================
-- Alton Accounts — Phase 5 (Gate E): GST period close controls and the ten reconciliation / control reports
--
-- Additive, no new tables. Everything is computed from the existing Phase 3–5 records and functions: issued / posted documents,
-- the ITC decision history, GSTR-2B documents and matches, challans, payments, set-offs, filing records, snapshots and the ledgers.
--
--   * Close controls: mandatory BLOCKERS (must pass) and WARNINGS (shown, never treated as passed; closing with open warnings needs an
--     acknowledgement reason of 10+ characters, stored with the CLOSED event together with every control and its result). CLOSE is
--     enforced in the database (gst_period_transition), so the screen cannot be bypassed.
--   * Ten reports (gst_control_report): tax liability, ITC, GSTR-2B, reverse charge, GST cash ledger, GST credit ledger, GST vouchers,
--     document completeness / exceptions, GSTR-1 vs GSTR-3B, period close and audit. Read only: no report posts, changes or creates
--     anything. Period or date-range filtering; company isolation through the caller's company. The cash-ledger report (bank /
--     payment details) additionally needs gst_payments.create or gst_payments.post; bank account numbers are shown masked only.
--   * Nothing is filed: every report carries the working-data disclaimer.
--
-- Rollback: supabase/rollback/20261231090800_accounting_gst_close_down.sql
-- =============================================================================

create or replace function private.gst_disclaimer()
returns text
language sql
immutable
set search_path = ''
as $$
  select 'Prepared by Alton ERP for review and working purposes. This document is not proof of filing with the GST Portal. The taxpayer must independently verify and file the return on the official GST Portal.'::text;
$$;
revoke all on function private.gst_disclaimer() from public, anon, authenticated;

-- GSTR-2B return months (YYYY-MM) covered by a date range.
create or replace function private.gst_months(p_from date, p_to date)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select coalesce(array_agg(to_char(m, 'YYYY-MM') order by m), '{}') from generate_series(date_trunc('month', p_from), date_trunc('month', p_to), interval '1 month') m;
$$;
revoke all on function private.gst_months(date, date) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 1. Close controls of a period
-- -----------------------------------------------------------------------------
create or replace function private.gst_close_controls(p public.gst_return_periods)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_snap    public.gst_period_snapshots;
  v_months  text[] := private.gst_months(p.period_start, p.period_end);
  v_ex      jsonb := private.gst_return_exceptions(p);
  v_rec     jsonb := private.gst_ledger_reconciliation(p);
  v_liab    jsonb := private.gst_liability(p);
  v_out     jsonb := '[]'::jsonb;
  v_live1   jsonb;
  v_live3   jsonb;
  c         record;
begin
  select s.* into v_snap from public.gst_period_current_snapshot x join public.gst_period_snapshots s on s.id = x.snapshot_id where x.period_id = p.id;
  if v_snap.id is not null and v_snap.data ? 'returns' then
    v_live1 := private.gst_gstr1(p);
    v_live3 := private.gst_gstr3b(p);
  end if;
  for c in
    select * from (values
      ('SNAPSHOT_MISSING', 'BLOCKER', case when v_snap.id is null or not (v_snap.data ? 'returns') then 1 else 0 end,
       'The period has no approved snapshot with the GSTR-1 / GSTR-3B working (approve it first).'),
      ('GST_ACCOUNTS_UNMAPPED', 'BLOCKER', (select count(*) from unnest(array['OUTPUT_IGST', 'OUTPUT_CGST', 'OUTPUT_SGST', 'INPUT_IGST', 'INPUT_CGST', 'INPUT_SGST', 'INPUT_CESS',
         'GST_INPUT_PENDING', 'GST_INPUT_INELIGIBLE', 'RCM_GST_PAYABLE', 'GST_ELECTRONIC_CASH', 'GST_INTEREST', 'GST_LATE_FEE']) k
         where private.accounting_rule_account(p.company_id, k, '') is null)::int, 'GST posting rules without an active account.'),
      ('ADJUSTMENTS_DRAFT', 'BLOCKER', (select count(*) from public.gst_return_adjustments a where a.period_id = p.id and a.status = 'DRAFT')::int,
       'Return adjustments awaiting approval.'),
      ('AMENDMENTS_UNRESOLVED', 'BLOCKER', (select count(*) from public.gst_amendment_exceptions e where e.assigned_period_id = p.id and e.status <> 'RESOLVED')::int,
       'Amendment exceptions assigned to the period are unresolved.'),
      ('ITC_PROPOSALS_PENDING', 'BLOCKER', (select count(*) from public.purchase_invoices i where i.company_id = p.company_id and i.status = 'POSTED'
         and i.recorded_date <= p.period_end and (select d.stage from public.gst_itc_decisions d where d.purchase_invoice_id = i.id order by d.seq desc limit 1) = 'PROPOSED')::int,
       'ITC decisions proposed but not approved (maker-checker).'),
      ('GSTR2B_UNAPPROVED_MATCHES', 'BLOCKER', (select count(*) from public.gst_2b_matches m where m.company_id = p.company_id and m.status = 'PROPOSED'
         and (private.gst_2b_current_version(m.document_id)).return_period = any (v_months))::int, 'GSTR-2B matches of the period awaiting approval.'),
      ('SET_OFF_DRAFT', 'BLOCKER', (select count(*) from public.gst_set_offs s where s.period_id = p.id and s.status = 'DRAFT')::int, 'Set-off drafts of the period not posted or cancelled.'),
      ('PAYMENTS_UNPOSTED', 'BLOCKER', (select count(*) from public.gst_challan_payments y join public.gst_challans ch on ch.id = y.challan_id
         where ch.registration_id = p.registration_id and y.status = 'SUCCESS' and y.voucher_id is null and y.payment_date <= p.period_end)::int,
       'Successful GST payments not yet posted.'),
      ('SOURCE_ERRORS', 'WARNING', (select count(*) from jsonb_array_elements(v_ex) e where e ->> 'severity' = 'ERROR')::int,
       'Source documents with missing or invalid GST information (GSTIN, place of supply, HSN, classification).'),
      ('MISSING_DOCUMENTS', 'WARNING', ((select count(*) from jsonb_array_elements(v_ex) e where e ->> 'code' = 'UNPOSTED_SOURCE')
         + (select count(*) from public.gst_2b_documents d where d.company_id = p.company_id and d.doc_type = 'INVOICE'
              and (private.gst_2b_current_version(d.id)).return_period = any (v_months)
              and not exists (select 1 from public.gst_2b_matches m where m.document_id = d.id and m.status in ('PROPOSED', 'APPROVED'))))::int,
       'Unposted / draft source documents, and GSTR-2B documents missing in the books.'),
      ('ITC_PENDING_VERIFICATION', 'WARNING', (select count(*) from jsonb_array_elements(v_ex) e where e ->> 'code' = 'ITC_PENDING')::int,
       'Posted supplier invoices whose ITC is not decided.'),
      ('GSTR2B_DIFFERENCES', 'WARNING', ((select count(*) from public.gst_2b_matches m where m.company_id = p.company_id and m.status = 'APPROVED' and m.outcome <> 'EXACT'
         and (private.gst_2b_current_version(m.document_id)).return_period = any (v_months))
         + (select count(*) from public.gst_2b_documents d where d.company_id = p.company_id and (d.doc_type <> 'INVOICE' or d.needs_review)
              and (private.gst_2b_current_version(d.id)).return_period = any (v_months))
         + (select count(*) from jsonb_array_elements(v_ex) e where e ->> 'code' = 'ITC_WITHOUT_GSTR2B'))::int,
       'GSTR-2B differences: non-exact approved matches, supplier notes, changed documents, ITC without an approved match.'),
      ('LEDGER_UNRECONCILED', 'WARNING', (select count(*) from jsonb_array_elements(v_rec -> 'tax_heads') h
         where (h ->> 'output_difference')::numeric <> 0 or (h ->> 'itc_difference')::numeric <> 0)::int,
       'Tax heads where documents and GST ledgers differ.'),
      ('UNEXPLAINED_VOUCHERS', 'WARNING', jsonb_array_length(v_rec -> 'unexplained_vouchers'), 'Vouchers on GST ledgers without a GST source document.'),
      ('LIABILITY_OPEN', 'WARNING', (select count(*) from jsonb_each_text(v_liab -> 'open') o where o.value::numeric > 0)::int,
       'Liability of the period not fully set off.'),
      ('LIVE_DIFFERS', 'WARNING', case when v_live1 is null then 0 else
         (case when (v_live1 -> 'sections') is distinct from (v_snap.data -> 'returns' -> 'GSTR1' -> 'sections') then 1 else 0 end)
         + (case when (v_live3 -> 'sections') is distinct from (v_snap.data -> 'returns' -> 'GSTR3B' -> 'sections') then 1 else 0 end) end,
       'Documents changed after approval (late documents): the approved values are kept; review the live differences.')
    ) x (code, severity, n, message)
  loop
    v_out := v_out || jsonb_build_object('code', c.code, 'severity', c.severity, 'count', c.n, 'passed', c.n = 0, 'message', c.message);
  end loop;
  return v_out;
end;
$$;
revoke all on function private.gst_close_controls(public.gst_return_periods) from public, anon, authenticated;

-- Lifecycle of a period as the screens show it (Filed and Reopened are derived from the filing records and the period events).
create or replace function private.gst_period_lifecycle(p public.gst_return_periods)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('status', p.status,
    'filed', coalesce((select jsonb_agg(jsonb_build_object('return_type', f.return_type, 'arn', f.arn, 'filed_on', f.filed_on) order by f.return_type)
       from public.gst_return_filings f where f.period_id = p.id and f.status = 'RECORDED'), '[]'::jsonb),
    'reopened_count', (select count(*) from public.gst_period_events e where e.period_id = p.id and e.action = 'REOPENED'),
    'last_reopened', (select jsonb_build_object('at', e.created_at, 'reason', e.reason, 'by', (select full_name from public.profiles where id = e.actor_id))
       from public.gst_period_events e where e.period_id = p.id and e.action = 'REOPENED' order by e.created_at desc limit 1),
    'label', case when exists (select 1 from public.gst_return_filings f where f.period_id = p.id and f.status = 'RECORDED') then 'FILED'
                  when p.status = 'OPEN' and exists (select 1 from public.gst_period_events e where e.period_id = p.id and e.action = 'REOPENED') then 'REOPENED'
                  else p.status end);
$$;
revoke all on function private.gst_period_lifecycle(public.gst_return_periods) from public, anon, authenticated;

create or replace function public.gst_period_readiness(p_period_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('gst.read');
  p         public.gst_return_periods;
  v_ctl     jsonb;
begin
  select * into p from public.gst_return_periods where id = p_period_id and company_id = v_company;
  if not found then
    raise exception 'GST return period not found.' using errcode = 'P0002';
  end if;
  v_ctl := private.gst_close_controls(p);
  return jsonb_build_object('period_id', p.id, 'period_code', p.period_code, 'from', p.period_start, 'to', p.period_end, 'lifecycle', private.gst_period_lifecycle(p),
    'checklist', private.gst_period_checklist(p), 'controls', v_ctl,
    'blockers_failed', (select count(*) from jsonb_array_elements(v_ctl) x where x ->> 'severity' = 'BLOCKER' and not (x ->> 'passed')::boolean),
    'warnings_open', (select count(*) from jsonb_array_elements(v_ctl) x where x ->> 'severity' = 'WARNING' and not (x ->> 'passed')::boolean),
    'can_close', p.status = 'APPROVED' and not exists (select 1 from jsonb_array_elements(v_ctl) x where x ->> 'severity' = 'BLOCKER' and not (x ->> 'passed')::boolean),
    'note', 'Blockers must pass before closing. Warnings are never treated as passed: closing with open warnings needs an acknowledgement reason, recorded with the close.');
end;
$$;

-- -----------------------------------------------------------------------------
-- 2. The ten reports
-- -----------------------------------------------------------------------------
create or replace function public.gst_control_report(p_report text, p_filters jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('gst.read');
  v_report  text := upper(coalesce(p_report, ''));
  p         public.gst_return_periods;
  v_range   boolean := false;
  v_reg     public.gst_registrations;
  v_cfg     public.gst_config_versions;
  v_snap    public.gst_period_snapshots;
  v_filing  jsonb;
  v_months  text[];
  v_head    jsonb;
  v_body    jsonb;
  r1        jsonb;
  r3        jsonb;
  rec       jsonb;
  pos       jsonb;
  h         text;
  v_rows    jsonb := '[]'::jsonb;
  v_keys    text[] := array['OUTPUT_IGST', 'OUTPUT_CGST', 'OUTPUT_SGST', 'INPUT_IGST', 'INPUT_CGST', 'INPUT_SGST', 'INPUT_CESS', 'GST_INPUT_PENDING', 'GST_INPUT_INELIGIBLE',
                              'RCM_GST_PAYABLE', 'GST_ELECTRONIC_CASH', 'GST_INTEREST', 'GST_LATE_FEE'];
begin
  if v_report not in ('TAX_LIABILITY', 'ITC', 'GSTR2B', 'RCM', 'CASH_LEDGER', 'CREDIT_LEDGER', 'VOUCHERS', 'COMPLETENESS', 'GSTR1_VS_GSTR3B', 'PERIOD_AUDIT') then
    raise exception 'Unknown GST report %.', p_report using errcode = '22023';
  end if;
  if v_report = 'CASH_LEDGER' and not (private.has_permission(v_company, 'gst_payments.create') or private.has_permission(v_company, 'gst_payments.post')) then
    raise exception 'You are not allowed to perform this action (requires gst_payments.create or gst_payments.post).' using errcode = '42501';
  end if;
  select * into v_reg from public.gst_registrations where company_id = v_company and is_active;
  if v_reg.id is null then
    raise exception 'Set up the GST registration first (Accounts › GST › Settings).' using errcode = 'P0001';
  end if;
  if nullif(p_filters ->> 'period_id', '') is not null then
    select * into p from public.gst_return_periods where id = (p_filters ->> 'period_id')::uuid and company_id = v_company;
    if not found then
      raise exception 'GST return period not found.' using errcode = 'P0002';
    end if;
  else
    if v_report = 'PERIOD_AUDIT' then
      raise exception 'The period close and audit report needs a return period.' using errcode = '22023';
    end if;
    begin
      p.period_start := (p_filters ->> 'from')::date;
      p.period_end := (p_filters ->> 'to')::date;
    exception when others then
      p.period_start := null;
    end;
    if p.period_start is null or p.period_end is null or p.period_end < p.period_start then
      raise exception 'Choose a return period or a date range.' using errcode = '22023';
    end if;
    -- A date range: no period-bound records (adjustments, set-offs, snapshots) apply.
    p.company_id := v_company; p.registration_id := v_reg.id; p.period_code := to_char(p.period_start, 'DD-MM-YYYY') || ' to ' || to_char(p.period_end, 'DD-MM-YYYY');
    p.status := 'DATE_RANGE'; p.frequency := 'RANGE'; p.financial_year := private.financial_year(p.period_start, private.gst_fy_start_month(v_company));
    v_range := true;
  end if;
  v_cfg := private.gst_config_on(v_company, p.period_end);
  v_months := private.gst_months(p.period_start, p.period_end);
  if not v_range then
    select s.* into v_snap from public.gst_period_current_snapshot x join public.gst_period_snapshots s on s.id = x.snapshot_id where x.period_id = p.id;
    select coalesce(jsonb_agg(jsonb_build_object('return_type', f.return_type, 'arn', f.arn, 'filed_on', f.filed_on)), '[]'::jsonb) into v_filing
    from public.gst_return_filings f where f.period_id = p.id and f.status = 'RECORDED';
  end if;
  v_head := jsonb_build_object('report', v_report,
    'company', (select jsonb_build_object('legal_name', c.legal_name, 'display_name', c.display_name) from public.companies c where c.id = v_company),
    'gstin', v_reg.gstin, 'registration_legal_name', v_reg.legal_name, 'period_id', p.id, 'period_code', p.period_code, 'from', p.period_start, 'to', p.period_end,
    'financial_year', p.financial_year, 'period_status', p.status, 'config_version_no', v_cfg.version_no, 'config_version_id', v_cfg.id,
    'snapshot', case when v_snap.id is null then null else jsonb_build_object('id', v_snap.id, 'version_no', v_snap.version_no, 'snapshot_hash', v_snap.snapshot_hash,
      'created_at', v_snap.created_at, 'has_return_working', v_snap.data ? 'returns') end,
    'filings', coalesce(v_filing, '[]'::jsonb),
    'value_status', case when v_range then 'CALCULATED' when jsonb_array_length(coalesce(v_filing, '[]'::jsonb)) > 0 then 'FILED' when v_snap.id is not null and p.status in ('APPROVED', 'CLOSED') then 'APPROVED'
                         when exists (select 1 from public.gst_return_adjustments a where a.period_id = p.id and a.status = 'APPROVED') then 'ADJUSTED' else 'CALCULATED' end,
    'generated_at', now(), 'disclaimer', private.gst_disclaimer());

  if v_report in ('TAX_LIABILITY', 'GSTR1_VS_GSTR3B', 'ITC', 'COMPLETENESS', 'PERIOD_AUDIT') then
    r1 := private.gst_gstr1(p);
    r3 := private.gst_gstr3b(p);
  end if;

  if v_report = 'TAX_LIABILITY' then
    rec := private.gst_ledger_reconciliation(p);
    foreach h in array array['taxable', 'igst', 'cgst', 'sgst', 'cess'] loop
      v_rows := v_rows || (select jsonb_build_object('head', upper(h),
        'documents', case when h = 'taxable' then (select coalesce(sum(d.sign * d.taxable), 0) from private.gst_sales_docs(p.company_id, p.period_start, p.period_end,
             coalesce((v_cfg.payload ->> 'b2cl_invoice_threshold')::numeric, 100000)) d)
           else (select (t ->> 'output_documents')::numeric from jsonb_array_elements(rec -> 'tax_heads') t where t ->> 'head' = upper(h)) end,
        'ledger', case when h = 'taxable' then null else (select (t ->> 'output_ledger')::numeric from jsonb_array_elements(rec -> 'tax_heads') t where t ->> 'head' = upper(h)) end,
        'gstr1_calculated', (select coalesce(sum((s.value -> 'calculated' ->> h)::numeric), 0) from jsonb_each(r1 -> 'sections') s),
        'gstr1_adjusted', (select coalesce(sum((s.value -> 'adjusted' ->> h)::numeric), 0) from jsonb_each(r1 -> 'sections') s),
        'gstr3b_calculated', (select coalesce(sum((r3 -> 'sections' -> k -> 'calculated' ->> h)::numeric), 0) from unnest(array['3.1(a)', '3.1(b)', '3.1(c)', '3.1(e)']) k),
        'gstr3b_adjusted', (select coalesce(sum((r3 -> 'sections' -> k -> 'adjusted' ->> h)::numeric), 0) from unnest(array['3.1(a)', '3.1(b)', '3.1(c)', '3.1(e)']) k),
        'gstr3b_rcm', (r3 -> 'sections' -> '3.1(d)' -> 'calculated' ->> h)::numeric,
        'snapshot_gstr1', case when v_snap.data ? 'returns' then (select coalesce(sum((s.value -> 'adjusted' ->> h)::numeric), 0) from jsonb_each(v_snap.data -> 'returns' -> 'GSTR1' -> 'sections') s) end,
        'snapshot_gstr3b', case when v_snap.data ? 'returns' then (select coalesce(sum((v_snap.data -> 'returns' -> 'GSTR3B' -> 'sections' -> k -> 'adjusted' ->> h)::numeric), 0)
           from unnest(array['3.1(a)', '3.1(b)', '3.1(c)', '3.1(e)']) k) end));
    end loop;
    v_rows := (select jsonb_agg(x || jsonb_build_object(
        'ledger_minus_documents', case when x ->> 'ledger' is null then null else (x ->> 'ledger')::numeric - (x ->> 'documents')::numeric end,
        'gstr1_minus_documents', (x ->> 'gstr1_calculated')::numeric - (x ->> 'documents')::numeric,
        'gstr3b_minus_gstr1', (x ->> 'gstr3b_calculated')::numeric - (x ->> 'gstr1_calculated')::numeric,
        'approved_adjustments_gstr1', (x ->> 'gstr1_adjusted')::numeric - (x ->> 'gstr1_calculated')::numeric,
        'approved_adjustments_gstr3b', (x ->> 'gstr3b_adjusted')::numeric - (x ->> 'gstr3b_calculated')::numeric,
        'snapshot_minus_live_gstr3b', case when x ->> 'snapshot_gstr3b' is null then null else (x ->> 'snapshot_gstr3b')::numeric - (x ->> 'gstr3b_adjusted')::numeric end))
      from jsonb_array_elements(v_rows) x);
    v_body := jsonb_build_object('rows', v_rows, 'unexplained_vouchers', rec -> 'unexplained_vouchers',
      'note', 'Documents: issued invoices and notes (signed). Ledger: output GST ledgers, set-off vouchers excluded. GSTR-3B: 3.1(a)+(b)+(c)+(e); reverse charge (3.1(d)) shown apart.');

  elsif v_report = 'ITC' then
    rec := private.gst_ledger_reconciliation(p);
    v_body := jsonb_build_object(
      'invoices_by_status', coalesce((select jsonb_agg(jsonb_build_object('status', st, 'invoices', n, 'igst', ig, 'cgst', cg, 'sgst', sg, 'cess', cs) order by st) from (
         select case when i.gst_status = 'PENDING_VERIFICATION' and (select d.stage from public.gst_itc_decisions d where d.purchase_invoice_id = i.id order by d.seq desc limit 1) = 'PROPOSED'
                     then 'PROPOSED' else i.gst_status end as st, count(*) as n, sum(i.igst_total) as ig, sum(i.cgst_total) as cg, sum(i.sgst_total) as sg, sum(i.cess_total) as cs
         from public.purchase_invoices i where i.company_id = v_company and i.status = 'POSTED' and i.recorded_date between p.period_start and p.period_end
           and i.cgst_total + i.sgst_total + i.igst_total + i.cess_total > 0 group by 1) x), '[]'::jsonb),
      'events', coalesce((select jsonb_agg(jsonb_build_object('event', ev, 'count', n, 'igst', ig, 'cgst', cg, 'sgst', sg, 'cess', cs, 'ineligible', inel) order by ev) from (
         select e.event as ev, count(*) as n, sum(e.igst) as ig, sum(e.cgst) as cg, sum(e.sgst) as sg, sum(e.cess) as cs, sum(e.ineligible) as inel
         from private.gst_itc_events(v_company, p.period_start, p.period_end) e group by 1) x), '[]'::jsonb),
      'heads', (select jsonb_agg(jsonb_build_object('head', t ->> 'head', 'itc_per_decisions', (t ->> 'itc_documents')::numeric, 'input_ledger', (t ->> 'itc_ledger')::numeric,
         'difference', (t ->> 'itc_difference')::numeric,
         'gstr3b_4a', coalesce((r3 -> 'sections' -> '4(A)(3)' -> 'adjusted' ->> lower(t ->> 'head'))::numeric, 0) + coalesce((r3 -> 'sections' -> '4(A)(5)' -> 'adjusted' ->> lower(t ->> 'head'))::numeric, 0),
         'gstr3b_4b', coalesce((r3 -> 'sections' -> '4(B)(2)' -> 'adjusted' ->> lower(t ->> 'head'))::numeric, 0),
         'gstr3b_net', (r3 -> 'net_itc' ->> lower(t ->> 'head'))::numeric)) from jsonb_array_elements(rec -> 'tax_heads') t),
      'pending_verification_ledger', jsonb_build_object('movement', private.gst_ledger_movement(v_company, 'GST_INPUT_PENDING', p.period_start, p.period_end),
         'closing', private.gst_ledger_movement(v_company, 'GST_INPUT_PENDING', null, p.period_end)),
      'ineligible_ledger', jsonb_build_object('movement', private.gst_ledger_movement(v_company, 'GST_INPUT_INELIGIBLE', p.period_start, p.period_end),
         'closing', private.gst_ledger_movement(v_company, 'GST_INPUT_INELIGIBLE', null, p.period_end)),
      'note', 'ITC comes only from approved maker-checker decisions and ITC adjustments (by voucher date); GSTR-2B is evidence and never creates a decision.');

  elsif v_report = 'GSTR2B' then
    v_body := jsonb_build_object(
      'documents', coalesce((select jsonb_agg(jsonb_build_object('document_id', d.id, 'supplier_gstin', d.supplier_gstin, 'doc_type', d.doc_type, 'doc_number', v.doc_number,
           'doc_date', v.doc_date, 'return_period', v.return_period, 'version_no', v.version_no, 'version_count', d.version_count, 'needs_review', d.needs_review,
           'taxable_value', v.taxable_value, 'igst', v.igst, 'cgst', v.cgst, 'sgst', v.sgst, 'cess', v.cess,
           'match_id', m.id, 'match_status', m.status, 'outcome', m.outcome, 'exact', m.outcome = 'EXACT', 'tolerance', m.tolerance, 'config_version_no', cv.version_no,
           'invoice_number', i.invoice_number,
           'category', case when d.doc_type <> 'INVOICE' then 'SUPPLIER_NOTE' when m.id is null then 'MISSING_IN_BOOKS' when m.status = 'PROPOSED' then 'UNAPPROVED'
                            when m.outcome = 'EXACT' then 'EXACT' when m.outcome = 'PARTIAL' then 'PARTIAL' else 'NON_EXACT' end)
           order by v.doc_date, v.doc_number)
         from public.gst_2b_documents d cross join lateral private.gst_2b_current_version(d.id) v
         left join public.gst_2b_matches m on m.document_id = d.id and m.status in ('PROPOSED', 'APPROVED')
         left join public.gst_config_versions cv on cv.id = m.config_version_id
         left join public.purchase_invoices i on i.id = m.purchase_invoice_id
         where d.company_id = v_company and v.return_period = any (v_months)), '[]'::jsonb),
      'reversed_matches', coalesce((select jsonb_agg(jsonb_build_object('match_id', m.id, 'doc_number', d.doc_number, 'invoice_number', i.invoice_number, 'outcome', m.outcome,
           'tolerance', m.tolerance, 'config_version_no', cv.version_no, 'reversed_at', m.reversed_at, 'reason', m.reversal_reason) order by m.reversed_at)
         from public.gst_2b_matches m join public.gst_2b_documents d on d.id = m.document_id join public.purchase_invoices i on i.id = m.purchase_invoice_id
         left join public.gst_config_versions cv on cv.id = m.config_version_id
         where m.company_id = v_company and m.status in ('REVERSED', 'REJECTED', 'SUPERSEDED') and (private.gst_2b_current_version(d.id)).return_period = any (v_months)), '[]'::jsonb),
      'amendments', coalesce((select jsonb_agg(jsonb_build_object('document_id', d.id, 'doc_number', d.doc_number, 'versions', d.version_count, 'needs_review', d.needs_review))
         from public.gst_2b_documents d where d.company_id = v_company and d.version_count > 1 and (private.gst_2b_current_version(d.id)).return_period = any (v_months)), '[]'::jsonb),
      'duplicates', coalesce((select jsonb_agg(jsonb_build_object('file_name', im.file_name, 'return_period', im.return_period, 'line_no', l.line_no, 'doc_number', l.doc_number,
           'kind', case when l.row_status = 'DUPLICATE_IN_FILE' then 'DUPLICATE_IN_FILE' else 'DUPLICATE_OF_EARLIER' end))
         from public.gst_2b_lines l join public.gst_2b_imports im on im.id = l.import_id
         where l.company_id = v_company and im.return_period = any (v_months) and (l.row_status = 'DUPLICATE_IN_FILE' or l.commit_outcome = 'DUPLICATE_OF_EARLIER')), '[]'::jsonb),
      'missing_in_2b', coalesce((select jsonb_agg(jsonb_build_object('purchase_invoice_id', i.id, 'invoice_number', i.invoice_number, 'supplier_gstin', i.supplier_gstin,
           'supplier_invoice_number', i.supplier_invoice_number, 'supplier_invoice_date', i.supplier_invoice_date, 'tax', i.igst_total + i.cgst_total + i.sgst_total + i.cess_total)
           order by i.supplier_invoice_date)
         from public.purchase_invoices i where i.company_id = v_company and i.status = 'POSTED' and i.supplier_gstin is not null
           and i.igst_total + i.cgst_total + i.sgst_total + i.cess_total > 0 and i.supplier_invoice_date between p.period_start and p.period_end
           and not exists (select 1 from public.gst_2b_matches m where m.purchase_invoice_id = i.id and m.status = 'APPROVED')), '[]'::jsonb),
      'note', 'Each match shows the tolerance it applied and the configuration version it came from. Only an EXACT outcome is labelled exact; a match within tolerance is PARTIAL. Matches never decide ITC.');
    v_body := v_body || jsonb_build_object('summary', (select jsonb_object_agg(cat, n) from (select x ->> 'category' as cat, count(*) as n
      from jsonb_array_elements(v_body -> 'documents') x group by 1) s) || jsonb_build_object('reversed', jsonb_array_length(v_body -> 'reversed_matches'),
      'amendments', jsonb_array_length(v_body -> 'amendments'), 'duplicates', jsonb_array_length(v_body -> 'duplicates'), 'missing_in_2b', jsonb_array_length(v_body -> 'missing_in_2b')));

  elsif v_report = 'RCM' then
    v_body := jsonb_build_object(
      'invoices', coalesce((select jsonb_agg(jsonb_build_object('purchase_invoice_id', i.id, 'invoice_number', i.invoice_number, 'supplier_invoice_number', i.supplier_invoice_number,
           'recorded_date', i.recorded_date, 'taxable', i.taxable_value, 'igst', i.igst_total, 'cgst', i.cgst_total, 'sgst', i.sgst_total, 'cess', i.cess_total, 'gst_status', i.gst_status,
           'itc_eligible', (select n.eligible_igst + n.eligible_cgst + n.eligible_sgst + n.eligible_cess from private.gst_itc_net(i.id) n)) order by i.recorded_date)
         from public.purchase_invoices i where i.company_id = v_company and i.status = 'POSTED' and i.reverse_charge and i.recorded_date between p.period_start and p.period_end), '[]'::jsonb),
      'totals', (select jsonb_build_object('taxable', coalesce(sum(i.taxable_value), 0), 'igst', coalesce(sum(i.igst_total), 0), 'cgst', coalesce(sum(i.cgst_total), 0),
           'sgst', coalesce(sum(i.sgst_total), 0), 'cess', coalesce(sum(i.cess_total), 0), 'tax', coalesce(sum(i.igst_total + i.cgst_total + i.sgst_total + i.cess_total), 0))
         from public.purchase_invoices i where i.company_id = v_company and i.status = 'POSTED' and i.reverse_charge and i.recorded_date between p.period_start and p.period_end),
      'payable_ledger', jsonb_build_object('credited_in_period', -private.gst_ledger_movement(v_company, 'RCM_GST_PAYABLE', p.period_start, p.period_end, 'GST_SET_OFF'),
         'set_off_in_period', private.gst_ledger_movement(v_company, 'RCM_GST_PAYABLE', p.period_start, p.period_end)
           - private.gst_ledger_movement(v_company, 'RCM_GST_PAYABLE', p.period_start, p.period_end, 'GST_SET_OFF'),
         'closing', -private.gst_ledger_movement(v_company, 'RCM_GST_PAYABLE', null, p.period_end)),
      'set_offs', coalesce((select jsonb_agg(jsonb_build_object('period_code', q.period_code, 'liability_head', l.liability_head, 'source', l.source, 'source_head', l.source_head,
           'amount', l.amount, 'status', s.status)) from public.gst_set_off_lines l join public.gst_set_offs s on s.id = l.set_off_id join public.gst_return_periods q on q.id = s.period_id
         where s.company_id = v_company and l.liability_kind = 'RCM' and s.status = 'POSTED' and q.period_start between p.period_start and p.period_end), '[]'::jsonb),
      'note', 'Reverse charge on direct supplier invoices only (receipt-matched reverse charge is not supported by Phase 3).');
    v_body := v_body || jsonb_build_object('difference', (v_body -> 'payable_ledger' ->> 'credited_in_period')::numeric - (v_body -> 'totals' ->> 'tax')::numeric);

  elsif v_report = 'CASH_LEDGER' then
    v_body := jsonb_build_object(
      'payments', coalesce((select jsonb_agg(jsonb_build_object('cpin', ch.cpin, 'challan_date', ch.challan_date, 'challan_status', ch.status, 'challan_total', ch.total_amount,
           'attempt_no', y.attempt_no, 'payment_status', y.status, 'payment_date', y.payment_date, 'amount', y.amount, 'cin', y.cin, 'bank_reference', y.bank_reference,
           'counted', y.status = 'SUCCESS' and y.voucher_id is not null, 'flag', case when y.status = 'SUCCESS' and y.voucher_id is null then 'SUCCESS_NOT_POSTED'
             when y.status in ('FAILED', 'INITIATED') then 'NOT_A_PAYMENT' when y.status = 'REVERSED' then 'REVERSED' end,
           'voucher_number', (select voucher_number from public.accounting_vouchers where id = y.voucher_id),
           'bank_account', (select jsonb_build_object('code', b.account_code, 'name', b.account_name, 'number', b.account_number_masked) from public.bank_cash_accounts b where b.id = y.bank_cash_account_id),
           'bank_amount', (select coalesce(sum(vl.credit - vl.debit), 0) from public.accounting_voucher_lines vl join public.bank_cash_accounts b on b.ledger_account_id = vl.account_id
                           where vl.voucher_id = y.voucher_id and b.id = y.bank_cash_account_id)) order by y.payment_date, ch.cpin, y.attempt_no)
         from public.gst_challan_payments y join public.gst_challans ch on ch.id = y.challan_id
         where ch.registration_id = v_reg.id and y.payment_date between p.period_start and p.period_end), '[]'::jsonb),
      'cash_ledger', jsonb_build_object('opening', private.gst_ledger_movement(v_company, 'GST_ELECTRONIC_CASH', null, p.period_start - 1),
         'deposits', private.gst_ledger_movement(v_company, 'GST_ELECTRONIC_CASH', p.period_start, p.period_end, 'GST_SET_OFF'),
         'utilised', private.gst_ledger_movement(v_company, 'GST_ELECTRONIC_CASH', p.period_start, p.period_end, 'GST_SET_OFF')
           - private.gst_ledger_movement(v_company, 'GST_ELECTRONIC_CASH', p.period_start, p.period_end),
         'closing', private.gst_ledger_movement(v_company, 'GST_ELECTRONIC_CASH', null, p.period_end)),
      'available_by_head', coalesce((select jsonb_object_agg(c.major_head || ':' || c.minor_head, c.amount) from private.gst_cash_available(v_reg.id) c), '{}'::jsonb),
      'note', 'Only successful, posted payments are counted. Failed or initiated attempts are listed but never counted; bank account numbers are masked.');
    v_body := v_body || jsonb_build_object('counted_payments', (select coalesce(sum((x ->> 'amount')::numeric), 0) from jsonb_array_elements(v_body -> 'payments') x where (x ->> 'counted')::boolean),
      'reversed_payments', (select coalesce(sum((x ->> 'amount')::numeric), 0) from jsonb_array_elements(v_body -> 'payments') x where x ->> 'payment_status' = 'REVERSED'));
    v_body := v_body || jsonb_build_object('deposits_difference', (v_body -> 'cash_ledger' ->> 'deposits')::numeric - (v_body ->> 'counted_payments')::numeric);

  elsif v_report = 'CREDIT_LEDGER' then
    pos := case when v_range then null else private.gst_credit_position(p) end;
    foreach h in array array['IGST', 'CGST', 'SGST', 'CESS'] loop
      v_rows := v_rows || (select jsonb_build_object('head', h,
        'opening_historical', private.gst_ledger_movement(v_company, 'INPUT_' || h, null, p.period_start - 1, 'GST_SET_OFF')
          - coalesce((select sum(l.amount) from public.gst_set_off_lines l join public.gst_set_offs s on s.id = l.set_off_id join public.gst_return_periods q on q.id = s.period_id
                      where s.registration_id = v_reg.id and s.status = 'POSTED' and l.source = 'CREDIT' and l.source_head = h and q.period_start < p.period_start), 0),
        'accrual_ledger', private.gst_ledger_movement(v_company, 'INPUT_' || h, p.period_start, p.period_end, 'GST_SET_OFF'),
        'availed', coalesce((select sum(case h when 'IGST' then e.igst when 'CGST' then e.cgst when 'SGST' then e.sgst else e.cess end) from private.gst_itc_events(v_company, p.period_start, p.period_end) e where e.event = 'AVAILED'), 0),
        'reclaimed', coalesce((select sum(case h when 'IGST' then e.igst when 'CGST' then e.cgst when 'SGST' then e.sgst else e.cess end) from private.gst_itc_events(v_company, p.period_start, p.period_end) e where e.event = 'ITC_RECLAIM'), 0),
        'reversed', coalesce((select sum(case h when 'IGST' then e.igst when 'CGST' then e.cgst when 'SGST' then e.sgst else e.cess end) from private.gst_itc_events(v_company, p.period_start, p.period_end) e where e.event in ('ITC_REVERSAL', 'DECISION_REVERSED')), 0),
        'utilised', coalesce((select sum(l.amount) from public.gst_set_off_lines l join public.gst_set_offs s on s.id = l.set_off_id join public.gst_return_periods q on q.id = s.period_id
                      where s.registration_id = v_reg.id and s.status = 'POSTED' and l.source = 'CREDIT' and l.source_head = h and q.period_start between p.period_start and p.period_end), 0),
        'current_available', greatest(0, private.gst_ledger_movement(v_company, 'INPUT_' || h, null, null)),
        'position', pos -> h));
    end loop;
    v_rows := (select jsonb_agg(x || jsonb_build_object(
        'other_movements', (x ->> 'accrual_ledger')::numeric - ((x ->> 'availed')::numeric + (x ->> 'reclaimed')::numeric - (x ->> 'reversed')::numeric),
        'closing_historical', (x ->> 'opening_historical')::numeric + (x ->> 'accrual_ledger')::numeric - (x ->> 'utilised')::numeric)) from jsonb_array_elements(v_rows) x);
    v_body := jsonb_build_object('rows', v_rows, 'note', 'Closing historical = opening + accrual − utilisation, as of the period end (later set-offs never change it). Current available is the ledger today.');

  elsif v_report = 'VOUCHERS' then
    v_body := jsonb_build_object(
      'vouchers', coalesce((select jsonb_agg(jsonb_build_object('voucher_id', v.id, 'voucher_number', v.voucher_number, 'date', v.voucher_date, 'type', t.type_code, 'status', v.status,
           'source', v.source, 'source_type', v.source_type, 'source_id', v.source_id,
           'source_document', case v.source_type when 'SALES_INVOICE' then (select invoice_number from public.sales_invoices where id = v.source_id)
             when 'CREDIT_NOTE' then (select note_number from public.invoice_adjustment_notes where id = v.source_id) when 'DEBIT_NOTE' then (select note_number from public.invoice_adjustment_notes where id = v.source_id)
             when 'PURCHASE_INVOICE' then (select invoice_number from public.purchase_invoices where id = v.source_id) when 'PURCHASE_INVOICE_GST' then (select invoice_number from public.purchase_invoices where id = v.source_id)
             when 'GST_ITC_DECISION' then (select pi.invoice_number from public.gst_itc_decisions d join public.purchase_invoices pi on pi.id = d.purchase_invoice_id where d.id = v.source_id)
             when 'GST_ITC_ADJUSTMENT' then (select pi.invoice_number from public.gst_itc_adjustments a join public.purchase_invoices pi on pi.id = a.purchase_invoice_id where a.id = v.source_id)
             when 'GST_SET_OFF' then (select q.period_code from public.gst_set_offs s join public.gst_return_periods q on q.id = s.period_id where s.id = v.source_id)
             when 'GST_CHALLAN_PAYMENT' then (select ch.cpin from public.gst_challan_payments y join public.gst_challans ch on ch.id = y.challan_id where y.id = v.source_id) end,
           'posting_event', (select jsonb_build_object('status', e.status, 'error', e.error_message) from public.accounting_posting_events e where e.company_id = v_company
             and e.source_type = v.source_type and e.source_id = v.source_id and e.event_action = case when v.reversal_of_voucher_id is null then 'POST' else 'REVERSE' end limit 1),
           'reversal_of', (select o.voucher_number from public.accounting_vouchers o where o.id = v.reversal_of_voucher_id),
           'reversed_by', (select string_agg(r.voucher_number, ', ') from public.accounting_vouchers r where r.reversal_of_voucher_id = v.id),
           'gst_amounts', (select jsonb_object_agg(k.rule_key, k.amt) from (select r.rule_key, sum(l.debit - l.credit) as amt from public.accounting_voucher_lines l
             join public.accounting_posting_rules r on r.company_id = v_company and r.account_id = l.account_id and r.rule_key = any (v_keys) where l.voucher_id = v.id group by 1) k),
           'flags', to_jsonb(array_remove(array[
             case when v.source is distinct from 'AUTO' or v.source_type is null or v.source_type not in ('SALES_INVOICE', 'CREDIT_NOTE', 'DEBIT_NOTE', 'PURCHASE_INVOICE', 'PURCHASE_INVOICE_GST',
               'GST_ITC_DECISION', 'GST_ITC_ADJUSTMENT', 'GST_SET_OFF', 'GST_CHALLAN_PAYMENT') then 'UNEXPLAINED' end,
             case when v.reversal_of_voucher_id is not null then 'REVERSAL' end,
             case when v.status = 'REVERSED' then 'REVERSED' end,
             case when v.source = 'AUTO' and v.reversal_of_voucher_id is null and (select count(*) from public.accounting_vouchers d2 where d2.company_id = v_company and d2.source = 'AUTO'
               and d2.source_type = v.source_type and d2.source_id = v.source_id and d2.reversal_of_voucher_id is null and d2.status = 'POSTED') > 1 then 'DUPLICATE_SOURCE' end], null)))
           order by v.voucher_date, v.voucher_number)
         from public.accounting_vouchers v join public.accounting_voucher_types t on t.id = v.voucher_type_id
         where v.company_id = v_company and v.status in ('POSTED', 'REVERSED') and v.voucher_date between p.period_start and p.period_end
           and exists (select 1 from public.accounting_voucher_lines l join public.accounting_posting_rules r on r.company_id = v_company and r.account_id = l.account_id
                       where l.voucher_id = v.id and r.rule_key = any (v_keys))), '[]'::jsonb),
      'documents_without_voucher', coalesce((select jsonb_agg(jsonb_build_object('kind', d.kind, 'number', d.number, 'date', d.doc_date)) from private.gst_sales_docs(v_company,
           p.period_start, p.period_end, coalesce((v_cfg.payload ->> 'b2cl_invoice_threshold')::numeric, 100000)) d where not d.has_voucher), '[]'::jsonb),
      'posting_problems', coalesce((select jsonb_agg(jsonb_build_object('source_type', e.source_type, 'source_number', e.source_number, 'date', e.source_date, 'status', e.status,
           'error', e.error_message)) from public.accounting_posting_events e where e.company_id = v_company and e.source_date between p.period_start and p.period_end
           and e.source_type in ('SALES_INVOICE', 'CREDIT_NOTE', 'DEBIT_NOTE') and e.status in ('PENDING', 'FAILED', 'NEEDS_ACCOUNT_MAPPING')), '[]'::jsonb),
      'note', 'Read only: this report never creates or posts a voucher.');

  elsif v_report = 'COMPLETENESS' then
    v_body := jsonb_build_object('rows', private.gst_return_exceptions(p)
      || coalesce((select jsonb_agg(jsonb_build_object('code', 'SUPPLIER_NOTE_UNRESOLVED', 'severity', 'WARNING', 'source_kind', 'GSTR2B_DOCUMENT', 'source_id', d.id,
           'document_no', d.doc_number, 'document_date', v.doc_date, 'message', format('Supplier %s %s in GSTR-2B %s: review; record an ITC reversal if needed.',
             lower(replace(d.doc_type, '_', ' ')), d.supplier_gstin, v.return_period)))
         from public.gst_2b_documents d cross join lateral private.gst_2b_current_version(d.id) v
         where d.company_id = v_company and d.doc_type <> 'INVOICE' and v.return_period = any (v_months)), '[]'::jsonb));
    v_body := v_body || jsonb_build_object('summary', coalesce((select jsonb_agg(jsonb_build_object('code', c, 'severity', s, 'count', n) order by s, c) from (
      select x ->> 'code' as c, x ->> 'severity' as s, count(*) as n from jsonb_array_elements(v_body -> 'rows') x group by 1, 2) y), '[]'::jsonb));

  elsif v_report = 'GSTR1_VS_GSTR3B' then
    v_rows := coalesce((select jsonb_agg(jsonb_build_object('line', m.line, 'gstr1_sections', to_jsonb(m.s1), 'gstr3b_sections', to_jsonb(m.s3), 'head', upper(hh),
        'gstr1_calculated', (select coalesce(sum((r1 -> 'sections' -> k -> 'calculated' ->> hh)::numeric), 0) from unnest(m.s1) k),
        'gstr1_adjusted', (select coalesce(sum((r1 -> 'sections' -> k -> 'adjusted' ->> hh)::numeric), 0) from unnest(m.s1) k),
        'gstr3b_calculated', (select coalesce(sum((r3 -> 'sections' -> k -> 'calculated' ->> hh)::numeric), 0) from unnest(m.s3) k),
        'gstr3b_adjusted', (select coalesce(sum((r3 -> 'sections' -> k -> 'adjusted' ->> hh)::numeric), 0) from unnest(m.s3) k),
        'snapshot_gstr1', case when v_snap.data ? 'returns' then (select coalesce(sum((v_snap.data -> 'returns' -> 'GSTR1' -> 'sections' -> k -> 'adjusted' ->> hh)::numeric), 0) from unnest(m.s1) k) end,
        'snapshot_gstr3b', case when v_snap.data ? 'returns' then (select coalesce(sum((v_snap.data -> 'returns' -> 'GSTR3B' -> 'sections' -> k -> 'adjusted' ->> hh)::numeric), 0) from unnest(m.s3) k) end)
        order by m.ord, hh.ord)
      from (values (1, 'Outward taxable supplies (domestic)', array['B2B', 'B2CL', 'B2CS', 'DE', 'CDNR', 'CDNUR'], array['3.1(a)']),
                   (2, 'Zero-rated supplies (exports, SEZ)', array['EXPWP', 'EXPWOP', 'SEZWP', 'SEZWOP'], array['3.1(b)']),
                   (3, 'Nil rated, exempt and non-GST supplies', array['NIL'], array['3.1(c)', '3.1(e)'])) m (ord, line, s1, s3)
      cross join unnest(array['taxable', 'igst', 'cgst', 'sgst', 'cess']) with ordinality hh (hh, ord)), '[]'::jsonb);
    v_rows := (select jsonb_agg(x || jsonb_build_object(
        'difference_calculated', (x ->> 'gstr3b_calculated')::numeric - (x ->> 'gstr1_calculated')::numeric,
        'difference_adjusted', (x ->> 'gstr3b_adjusted')::numeric - (x ->> 'gstr1_adjusted')::numeric,
        'explanation', concat_ws('; ',
          case when (x ->> 'gstr3b_calculated')::numeric <> (x ->> 'gstr1_calculated')::numeric then 'Calculated values differ: check the document classification.' end,
          case when (x ->> 'gstr1_adjusted')::numeric <> (x ->> 'gstr1_calculated')::numeric then format('Approved GSTR-1 adjustments %s.', (x ->> 'gstr1_adjusted')::numeric - (x ->> 'gstr1_calculated')::numeric) end,
          case when (x ->> 'gstr3b_adjusted')::numeric <> (x ->> 'gstr3b_calculated')::numeric then format('Approved GSTR-3B adjustments %s.', (x ->> 'gstr3b_adjusted')::numeric - (x ->> 'gstr3b_calculated')::numeric) end,
          case when x ->> 'snapshot_gstr3b' is not null and ((x ->> 'snapshot_gstr3b')::numeric <> (x ->> 'gstr3b_adjusted')::numeric
                     or (x ->> 'snapshot_gstr1')::numeric <> (x ->> 'gstr1_adjusted')::numeric) then 'Documents changed after approval (late documents): approved snapshot values differ from live values.' end)))
      from jsonb_array_elements(v_rows) x);
    v_body := jsonb_build_object('rows', v_rows, 'note', 'Both returns are read from the same documents; differences come only from approved adjustments or late documents. Source documents are never changed to force agreement.');

  else -- PERIOD_AUDIT
    v_body := jsonb_build_object(
      'lifecycle', private.gst_period_lifecycle(p),
      'period', to_jsonb(p) - 'company_id',
      'registration', jsonb_build_object('gstin', v_reg.gstin, 'legal_name', v_reg.legal_name, 'state_code', v_reg.state_code),
      'snapshots', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'version_no', s.version_no, 'snapshot_hash', s.snapshot_hash, 'created_at', s.created_at,
          'config_version_no', (select c.version_no from public.gst_config_versions c where c.id = s.config_version_id), 'has_return_working', s.data ? 'returns',
          'prepared_by', (select full_name from public.profiles where id = s.prepared_by), 'approved_by', (select full_name from public.profiles where id = s.approved_by),
          'current', s.id = v_snap.id) order by s.version_no) from public.gst_period_snapshots s where s.period_id = p.id), '[]'::jsonb),
      'history', coalesce((select jsonb_agg(jsonb_build_object('action', e.action, 'from', e.from_status, 'to', e.to_status, 'reason', e.reason, 'at', e.created_at,
          'by', (select full_name from public.profiles where id = e.actor_id), 'details', e.details) order by e.created_at, e.id) from public.gst_period_events e where e.period_id = p.id), '[]'::jsonb),
      'adjustments', coalesce((select jsonb_agg(to_jsonb(a) - 'company_id' order by a.prepared_at) from public.gst_return_adjustments a where a.period_id = p.id), '[]'::jsonb),
      'filing_records', coalesce((select jsonb_agg(to_jsonb(f) - 'company_id' order by f.recorded_at) from public.gst_return_filings f where f.period_id = p.id), '[]'::jsonb),
      'set_offs', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'status', s.status, 'voucher_number', (select voucher_number from public.accounting_vouchers where id = s.voucher_id),
          'lines', (select jsonb_agg(jsonb_build_object('liability_kind', l.liability_kind, 'liability_head', l.liability_head, 'source', l.source, 'source_head', l.source_head, 'amount', l.amount))
                    from public.gst_set_off_lines l where l.set_off_id = s.id)) order by s.prepared_at) from public.gst_set_offs s where s.period_id = p.id), '[]'::jsonb),
      'payment_of_tax', coalesce(v_snap.data -> 'returns' -> 'GSTR3B' -> '6.1', r3 -> '6.1'),
      'close_controls', private.gst_close_controls(p),
      'exceptions_summary', coalesce((select jsonb_agg(jsonb_build_object('code', c, 'severity', s, 'count', n)) from (select x ->> 'code' as c, x ->> 'severity' as s, count(*) as n
          from jsonb_array_elements(private.gst_return_exceptions(p)) x group by 1, 2) y), '[]'::jsonb),
      'late_documents', jsonb_build_object(
        'gstr1_live_differs', case when v_snap.data ? 'returns' then (r1 -> 'sections') is distinct from (v_snap.data -> 'returns' -> 'GSTR1' -> 'sections') end,
        'gstr3b_live_differs', case when v_snap.data ? 'returns' then (r3 -> 'sections') is distinct from (v_snap.data -> 'returns' -> 'GSTR3B' -> 'sections') end,
        'amendment_exceptions', coalesce((select jsonb_agg(jsonb_build_object('kind', e.kind, 'source_kind', e.source_kind, 'document_no', e.document_no, 'status', e.status,
            'assigned_period', (select q.period_code from public.gst_return_periods q where q.id = e.assigned_period_id))) from public.gst_amendment_exceptions e where e.origin_period_id = p.id), '[]'::jsonb)));
  end if;
  return v_head || v_body;
end;
$$;


-- -----------------------------------------------------------------------------
-- 3. Existing function changed (from its latest text; Gate E lines marked): CLOSE runs the close controls
-- -----------------------------------------------------------------------------
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
  v_ctl     jsonb;
  v_warn    text;
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
      'liability', private.gst_liability(p),
      -- Gate D: the GSTR-1 / GSTR-3B working is stored in the snapshot; an approved period is never recalculated.
      'returns', jsonb_build_object('GSTR1', private.gst_gstr1(p), 'GSTR3B', private.gst_gstr3b(p)));
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
    -- Gate E: mandatory close controls must pass; open warnings are never treated as passed and need an acknowledgement reason.
    v_ctl := private.gst_close_controls(p);
    select jsonb_agg(x) into v_block from jsonb_array_elements(v_ctl) x where x ->> 'severity' = 'BLOCKER' and not (x ->> 'passed')::boolean;
    if v_block is not null then
      raise exception 'Close controls not passed: %', (select string_agg(format('%s (%s)', x ->> 'message', x ->> 'count'), '; ') from jsonb_array_elements(v_block) x)
        using errcode = 'P0001', detail = v_block::text;
    end if;
    select string_agg(format('%s (%s)', lower(replace(x ->> 'code', '_', ' ')), x ->> 'count'), ', ') into v_warn from jsonb_array_elements(v_ctl) x
    where x ->> 'severity' = 'WARNING' and not (x ->> 'passed')::boolean;
    if v_warn is not null and length(btrim(coalesce(p_reason, ''))) < 10 then
      raise exception 'Open warnings must be acknowledged before closing: %. Record a reason of at least 10 characters.', v_warn using errcode = '22023';
    end if;
    update public.gst_return_periods set status = 'CLOSED', closed_by = auth.uid(), closed_at = now(), updated_at = now(), row_version = row_version + 1
    where id = p.id returning * into p;
    perform private.gst_period_event(p, 'CLOSED', v_from, p_reason, jsonb_build_object('close_controls', v_ctl, 'warnings_acknowledged', v_warn));
  elsif v_action = 'REOPEN' and p.status in ('APPROVED', 'CLOSED') then
    -- Gate D: a return recorded as filed on the GST portal is not reopened here; amend it in a later return (or void a wrong filing record).
    if exists (select 1 from public.gst_return_filings f where f.period_id = p.id and f.status = 'RECORDED') then
      raise exception 'A return of % is recorded as filed; amend it in a later return, or void a wrong filing record first.', p.period_code using errcode = 'P0001';
    end if;
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

-- -----------------------------------------------------------------------------
-- 4. Grants: signed-in users only (each function checks its permission); never anon or service_role
-- -----------------------------------------------------------------------------
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.gst_period_readiness(uuid)',
    'public.gst_control_report(text, jsonb)',
    'public.gst_period_transition(uuid, text, text)'] loop
    execute format('revoke all on function %s from public, anon, service_role', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;
