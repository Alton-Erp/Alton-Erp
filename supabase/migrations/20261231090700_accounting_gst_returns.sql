-- =============================================================================
-- Alton Accounts — Phase 5 (Gate D): GST return preparation
--
-- Additive. GSTR-1 and GSTR-3B working data, sales / purchase / RCM registers, the GST liability dashboard, payment and challan views,
-- tax-head summaries, reconciliation with the accounting ledgers, exception lists, and a manual record of returns filed on the GST portal.
--
-- Principles:
--   * Nothing is recalculated: every figure comes from the stored totals of issued / posted documents, the ITC decision history, posted
--     set-offs and the ledgers (Phase 3–5). Nothing is posted and nothing is filed: there is no GSTN / portal integration. A "filed" value
--     is only a record, entered by a user, of a return the user filed on the portal (ARN and date).
--   * Draft, pending, cancelled and discarded documents never enter a return; they are listed as exceptions.
--   * Values are labelled CALCULATED (live, from documents), ADJUSTED (approved manual return adjustments applied), APPROVED (the period's
--     approved snapshot) and FILED (a filing record exists). Approved / closed periods are always shown from their snapshot, which now also
--     stores the GSTR-1 and GSTR-3B working; snapshots are never changed. A period with a filing record cannot be reopened.
--   * The approved configuration in force at the period end (B2CL threshold, UQC map) is used and named in every working.
--   * GSTR-2B results and ITC verification are shown as evidence only.
--
-- Outstanding items from the Gate C review handled here:
--   * Historical credit: credit available as of each return-period end (accrued by that end less set-offs of that and earlier periods) is
--     separated from the current available credit (ledger). A set-off may use only credit that keeps cumulative utilisation within
--     cumulative accrual at every later period end, within the ledger balance; later-period set-offs never change approved snapshots.
--   * Match tolerance: the optional configuration key gstr2b_match_tolerance is validated (0–100, 2 decimals; default 1.00) and every match
--     records the configuration version whose tolerance it applied.
--
-- Rollback: supabase/rollback/20261231090700_accounting_gst_returns_down.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Match tolerance: configuration version recorded on every GSTR-2B match
-- -----------------------------------------------------------------------------
alter table public.gst_2b_matches add column if not exists config_version_id uuid;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'gst_2b_matches_config_fk') then
    alter table public.gst_2b_matches add constraint gst_2b_matches_config_fk foreign key (config_version_id, company_id)
      references public.gst_config_versions (id, company_id) on delete restrict;
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- 2. Filing records (manual; the return is filed by the user on the GST portal)
-- -----------------------------------------------------------------------------
create table if not exists public.gst_return_filings (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null,
  period_id    uuid not null,
  return_type  text not null check (return_type in ('GSTR1', 'GSTR3B')),
  snapshot_id  uuid not null,
  arn          text not null check (arn ~ '^[A-Z0-9]{15}$'),
  filed_on     date not null,
  note         text check (note is null or length(note) <= 1000),
  status       text not null default 'RECORDED' check (status in ('RECORDED', 'VOIDED')),
  recorded_by  uuid not null,
  recorded_at  timestamptz not null default now(),
  voided_by    uuid,
  voided_at    timestamptz,
  void_reason  text check (void_reason is null or length(void_reason) <= 1000),
  constraint gst_return_filings_id_company_unique unique (id, company_id),
  constraint gst_return_filings_period_fk foreign key (period_id, company_id) references public.gst_return_periods (id, company_id) on delete restrict,
  constraint gst_return_filings_snapshot_fk foreign key (snapshot_id, company_id) references public.gst_period_snapshots (id, company_id) on delete restrict,
  constraint gst_return_filings_voided check ((status = 'VOIDED') = (voided_by is not null and voided_at is not null and void_reason is not null))
);
create unique index if not exists gst_return_filings_one_recorded on public.gst_return_filings (period_id, return_type) where status = 'RECORDED';
create unique index if not exists gst_return_filings_arn_unique on public.gst_return_filings (company_id, arn) where status = 'RECORDED';

alter table public.gst_return_filings enable row level security;
revoke all on table public.gst_return_filings from public, anon, authenticated, service_role;
grant select on table public.gst_return_filings to authenticated;
drop policy if exists gst_return_filings_select on public.gst_return_filings;
create policy gst_return_filings_select on public.gst_return_filings for select to authenticated using (private.has_permission(company_id, 'gst.read'));

create or replace function private.gst_return_filing_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if private.erp_force_purge_allows(tg_table_name, old.company_id) then
      return old;
    end if;
    raise exception 'GST filing records are permanent: void a wrong record instead.' using errcode = '42501';
  end if;
  if old.status <> 'RECORDED' or new.status <> 'VOIDED'
     or (to_jsonb(new) - array['status', 'voided_by', 'voided_at', 'void_reason']) <> (to_jsonb(old) - array['status', 'voided_by', 'voided_at', 'void_reason']) then
    raise exception 'A GST filing record cannot be changed; only a recorded filing can be voided (with a reason).' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function private.gst_return_filing_guard() from public, anon, authenticated;
drop trigger if exists gst_return_filings_guard on public.gst_return_filings;
create trigger gst_return_filings_guard before update or delete on public.gst_return_filings for each row execute function private.gst_return_filing_guard();

-- -----------------------------------------------------------------------------
-- 3. Historical and current credit (per head)
-- -----------------------------------------------------------------------------
-- accrued_to_period_end     input credit accrued up to the period end (set-off vouchers and their reversals excluded)
-- used_to_period            credit used by POSTED set-offs of this and earlier periods (reversed set-offs excluded)
-- available_at_period_end   the historical position: accrued_to_period_end − used_to_period (later set-offs never change it)
-- cumulative_headroom       the smallest (accrued by q's end − used through q) over this and every later period q, so cumulative
--                           utilisation never exceeds cumulative accrual at any period end
-- ledger_balance            the current input-ledger balance (= current available credit; later ITC reversals reduce it)
-- available                 what a set-off of this period may still use: min(historical, headroom, ledger), never below zero
create or replace function private.gst_credit_position(p public.gst_return_periods)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with heads (h) as (values ('IGST'), ('CGST'), ('SGST'), ('CESS')),
  used as (
    select l.source_head as h, sp.period_start, sum(l.amount) as amt
    from public.gst_set_off_lines l join public.gst_set_offs s on s.id = l.set_off_id join public.gst_return_periods sp on sp.id = s.period_id
    where s.registration_id = p.registration_id and s.status = 'POSTED' and l.source = 'CREDIT'
    group by 1, 2),
  pos as (
    select heads.h,
      private.gst_ledger_movement(p.company_id, 'INPUT_' || heads.h, null, p.period_end, 'GST_SET_OFF') as accrued,
      coalesce((select sum(u.amt) from used u where u.h = heads.h and u.period_start <= p.period_start), 0) as used_to,
      coalesce((select sum(u.amt) from used u where u.h = heads.h), 0) as used_all,
      (select min(private.gst_ledger_movement(p.company_id, 'INPUT_' || heads.h, null, q.period_end, 'GST_SET_OFF')
                  - coalesce((select sum(u.amt) from used u where u.h = heads.h and u.period_start <= q.period_start), 0))
       from public.gst_return_periods q where q.registration_id = p.registration_id and q.period_start >= p.period_start) as headroom,
      private.gst_ledger_movement(p.company_id, 'INPUT_' || heads.h, null, null) as ledger
    from heads)
  select jsonb_object_agg(h, jsonb_build_object(
    'accrued_to_period_end', accrued, 'used_to_period', used_to, 'used_in_posted_set_offs', used_all,
    'available_at_period_end', greatest(0, accrued - used_to), 'cumulative_headroom', greatest(0, coalesce(headroom, accrued - used_to)),
    'ledger_balance', ledger, 'current_available', greatest(0, ledger),
    'available', greatest(0, least(accrued - used_to, coalesce(headroom, accrued - used_to), ledger))))
  from pos;
$$;
revoke all on function private.gst_credit_position(public.gst_return_periods) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 4. Classification and document sets (stored totals only)
-- -----------------------------------------------------------------------------
-- GSTR-1 section of a sales invoice. A reviewed override (gst_sales_document_details) wins.
create or replace function private.gst_sales_section(p_category text, p_reg_type text, p_gstin text, p_treatment text, p_value numeric, p_igst numeric,
  p_other_tax numeric, p_threshold numeric, p_override text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_override = 'EXP' then case when p_igst > 0 then 'EXPWP' else 'EXPWOP' end
    when p_override is not null then p_override
    when p_category in ('EXEMPT', 'NON_GST') then 'NIL'
    when p_reg_type = 'OVERSEAS' or (p_category = 'ZERO_RATED' and coalesce(p_reg_type, '') <> 'SEZ') then case when p_igst > 0 then 'EXPWP' else 'EXPWOP' end
    when p_reg_type = 'SEZ' then case when p_igst > 0 then 'SEZWP' else 'SEZWOP' end
    when p_igst + p_other_tax = 0 then 'NIL'
    when p_gstin is not null and coalesce(p_reg_type, 'REGISTERED') in ('REGISTERED', 'COMPOSITION') then 'B2B'
    when p_treatment = 'INTER_STATE' and p_value > p_threshold then 'B2CL'
    else 'B2CS' end;
$$;

-- Issued sales invoices and customer notes of a date range with their GSTR-1 section (credit notes carry sign −1).
create or replace function private.gst_sales_docs(p_company uuid, p_from date, p_to date, p_threshold numeric)
returns table (kind text, id uuid, number text, doc_date date, customer_name text, customer_gstin text, registration_type text, place_of_supply text,
  tax_treatment text, supply_category text, section text, sign integer, taxable numeric, igst numeric, cgst numeric, sgst numeric, cess numeric, doc_value numeric,
  original_invoice text, has_voucher boolean, export_details jsonb)
language sql
stable
security definer
set search_path = ''
as $$
  select 'INVOICE', i.id, i.invoice_number, i.invoice_date, i.customer_legal_name, i.customer_gstin, i.customer_registration_type, i.place_of_supply_state_code,
    i.tax_treatment, i.supply_category,
    private.gst_sales_section(i.supply_category, i.customer_registration_type, i.customer_gstin, i.tax_treatment, i.grand_total, i.igst_total, i.cgst_total + i.sgst_total,
      p_threshold, d.section_override),
    1, i.taxable_subtotal, i.igst_total, i.cgst_total, i.sgst_total, 0::numeric, i.grand_total, null::text,
    exists (select 1 from public.accounting_vouchers v where v.company_id = p_company and v.source = 'AUTO' and v.source_type = 'SALES_INVOICE' and v.source_id = i.id
            and v.status in ('POSTED', 'REVERSED')),
    case when d.id is null then null else jsonb_build_object('export_type', d.export_type, 'shipping_bill_number', d.shipping_bill_number,
      'shipping_bill_date', d.shipping_bill_date, 'port_code', d.port_code) end
  from public.sales_invoices i left join public.gst_sales_document_details d on d.sales_invoice_id = i.id
  where i.company_id = p_company and i.status = 'ISSUED' and not coalesce(i.is_proforma, false) and i.invoice_date between p_from and p_to
  union all
  select case n.note_type when 'CREDIT' then 'CREDIT_NOTE' else 'DEBIT_NOTE' end, n.id, n.note_number, n.note_date, o.customer_legal_name, o.customer_gstin,
    o.customer_registration_type, o.place_of_supply_state_code, n.tax_treatment, o.supply_category,
    coalesce(nd.section_override, case private.gst_sales_section(o.supply_category, o.customer_registration_type, o.customer_gstin, o.tax_treatment, o.grand_total,
        o.igst_total, o.cgst_total + o.sgst_total, p_threshold, od.section_override)
      when 'B2B' then 'CDNR' when 'SEZWP' then 'CDNR' when 'SEZWOP' then 'CDNR' when 'DE' then 'CDNR' when 'B2CS' then 'B2CS' when 'NIL' then 'NIL' else 'CDNUR' end),
    case n.note_type when 'CREDIT' then -1 else 1 end, n.taxable_amount, n.igst_amount, n.cgst_amount, n.sgst_amount, 0::numeric, n.total_amount, o.invoice_number,
    exists (select 1 from public.accounting_vouchers v where v.company_id = p_company and v.source = 'AUTO' and v.source_type = case n.note_type when 'CREDIT' then 'CREDIT_NOTE' else 'DEBIT_NOTE' end
            and v.source_id = n.id and v.status in ('POSTED', 'REVERSED')),
    null::jsonb
  from public.invoice_adjustment_notes n join public.sales_invoices o on o.id = n.original_invoice_id
  left join public.gst_sales_document_details od on od.sales_invoice_id = o.id
  left join public.gst_sales_document_details nd on nd.adjustment_note_id = n.id
  where n.company_id = p_company and n.status = 'ISSUED' and n.note_date between p_from and p_to;
$$;

-- Lines of those documents (for rate-wise rows and the HSN summary); note lines take the unit of the invoice line they adjust.
create or replace function private.gst_sales_doc_lines(p_company uuid, p_from date, p_to date)
returns table (doc_id uuid, hsn_sac text, unit text, gst_rate numeric, quantity numeric, taxable numeric, igst numeric, cgst numeric, sgst numeric, sign integer)
language sql
stable
security definer
set search_path = ''
as $$
  select l.invoice_id, l.hsn_sac, l.unit, coalesce(l.gst_rate, 0), l.quantity, l.taxable_value, l.igst_amount, l.cgst_amount, l.sgst_amount, 1
  from public.sales_invoice_lines l join public.sales_invoices i on i.id = l.invoice_id
  where i.company_id = p_company and i.status = 'ISSUED' and not coalesce(i.is_proforma, false) and i.invoice_date between p_from and p_to
  union all
  select nl.note_id, coalesce(nl.hsn_sac, il.hsn_sac), il.unit, coalesce(nl.gst_rate, il.gst_rate, 0), coalesce(nl.quantity, 0), nl.taxable_amount, nl.igst_amount,
    nl.cgst_amount, nl.sgst_amount, case n.note_type when 'CREDIT' then -1 else 1 end
  from public.invoice_adjustment_note_lines nl join public.invoice_adjustment_notes n on n.id = nl.note_id join public.sales_invoice_lines il on il.id = nl.invoice_line_id
  where n.company_id = p_company and n.status = 'ISSUED' and n.note_date between p_from and p_to;
$$;

-- ITC events of a period (by voucher date) from the decision history and ITC adjustments, per head, with the GSTR-2B evidence.
create or replace function private.gst_itc_events(p_company uuid, p_from date, p_to date)
returns table (event text, purchase_invoice_id uuid, invoice_number text, reverse_charge boolean, voucher_number text, voucher_date date,
  igst numeric, cgst numeric, sgst numeric, cess numeric, ineligible numeric, gstr2b_status text)
language sql
stable
security definer
set search_path = ''
as $$
  with ev as (
    select 'AVAILED' as event, d.purchase_invoice_id, v.voucher_number, v.voucher_date, d.eligible_igst as igst, d.eligible_cgst as cgst, d.eligible_sgst as sgst,
      d.eligible_cess as cess, d.ineligible_igst + d.ineligible_cgst + d.ineligible_sgst + d.ineligible_cess as ineligible
    from public.gst_itc_decisions d join public.accounting_vouchers v on v.id = d.voucher_id
    where d.company_id = p_company and d.stage = 'DECIDED' and v.voucher_date between p_from and p_to
    union all
    select 'DECISION_REVERSED', o.purchase_invoice_id, v.voucher_number, v.voucher_date, o.eligible_igst, o.eligible_cgst, o.eligible_sgst, o.eligible_cess,
      -(o.ineligible_igst + o.ineligible_cgst + o.ineligible_sgst + o.ineligible_cess)
    from public.gst_itc_decisions r join public.gst_itc_decisions o on o.id = r.proposal_id join public.accounting_vouchers v on v.id = r.voucher_id
    where r.company_id = p_company and r.stage in ('DECISION_REVERSED', 'REVERSED_WITH_INVOICE') and v.voucher_date between p_from and p_to
    union all
    select case a.kind when 'REVERSAL' then 'ITC_REVERSAL' else 'ITC_RECLAIM' end, a.purchase_invoice_id, v.voucher_number, v.voucher_date, a.igst, a.cgst, a.sgst, a.cess, 0
    from public.gst_itc_adjustments a join public.accounting_vouchers v on v.id = a.voucher_id
    where a.company_id = p_company and a.status in ('POSTED', 'REVERSED') and v.voucher_date between p_from and p_to
    union all
    select case a.kind when 'REVERSAL' then 'ITC_RECLAIM' else 'ITC_REVERSAL' end, a.purchase_invoice_id, v.voucher_number, v.voucher_date, a.igst, a.cgst, a.sgst, a.cess, 0
    from public.gst_itc_adjustments a join public.accounting_vouchers v on v.id = a.reversal_voucher_id
    where a.company_id = p_company and a.status = 'REVERSED' and v.voucher_date between p_from and p_to)
  select ev.event, ev.purchase_invoice_id, pi.invoice_number, pi.reverse_charge, ev.voucher_number, ev.voucher_date, ev.igst, ev.cgst, ev.sgst, ev.cess, ev.ineligible,
    (private.gst_2b_evidence(ev.purchase_invoice_id) ->> 'match_status')
  from ev join public.purchase_invoices pi on pi.id = ev.purchase_invoice_id;
$$;

revoke all on function private.gst_sales_section(text, text, text, text, numeric, numeric, numeric, numeric, text) from public, anon, authenticated;
revoke all on function private.gst_sales_docs(uuid, date, date, numeric) from public, anon, authenticated;
revoke all on function private.gst_sales_doc_lines(uuid, date, date) from public, anon, authenticated;
revoke all on function private.gst_itc_events(uuid, date, date) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 5. Manual return adjustments applied as a separate layer (calculated → adjusted)
-- -----------------------------------------------------------------------------
create or replace function private.gst_apply_adjustments(p_sections jsonb, p_period uuid, p_type text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  k     text;
  s     jsonb;
  v_out jsonb := '{}'::jsonb;
  a     public.gst_return_adjustments;
  f     text;
  v_any boolean;
begin
  for k, s in select key, value from jsonb_each(p_sections) loop
    s := s || jsonb_build_object('adjusted', s -> 'calculated', 'adjustments', '[]'::jsonb);
    v_any := false;
    for a in select * from public.gst_return_adjustments where period_id = p_period and return_type = p_type and section = k and status in ('APPROVED', 'DRAFT')
             order by prepared_at, id loop
      f := case a.tax_head when 'TAXABLE' then 'taxable' when 'IGST' then 'igst' when 'CGST' then 'cgst' when 'SGST' then 'sgst' when 'CESS' then 'cess' else lower(a.field) end;
      s := jsonb_set(s, '{adjustments}', (s -> 'adjustments') || jsonb_build_object('id', a.id, 'field', a.field, 'tax_head', a.tax_head, 'amount', a.amount,
        'reason', a.reason, 'status', a.status));
      if a.status = 'APPROVED' then
        s := jsonb_set(s, array['adjusted', f], to_jsonb(coalesce((s -> 'adjusted' ->> f)::numeric, 0) + a.amount));
        v_any := true;
      end if;
    end loop;
    v_out := v_out || jsonb_build_object(k, s || jsonb_build_object('value_status', case when v_any then 'ADJUSTED' else 'CALCULATED' end));
  end loop;
  return v_out;
end;
$$;
revoke all on function private.gst_apply_adjustments(jsonb, uuid, text) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 6. Exceptions of a period
-- -----------------------------------------------------------------------------
create or replace function private.gst_return_exceptions(p public.gst_return_periods)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with cfg as (select coalesce((private.gst_config_on(p.company_id, p.period_end)).payload, '{}'::jsonb) as payload),
  inv as (select * from public.sales_invoices i where i.company_id = p.company_id and not coalesce(i.is_proforma, false) and i.invoice_date between p.period_start and p.period_end),
  x as (
    select 'MISSING_GSTIN' as code, 'ERROR' as severity, 'SALES_INVOICE' as source_kind, i.id as source_id, i.invoice_number as document_no, i.invoice_date as document_date,
      'The customer is registered but the invoice has no GSTIN.' as message
    from inv i where i.status = 'ISSUED' and i.customer_registration_type in ('REGISTERED', 'COMPOSITION', 'SEZ') and i.customer_gstin is null
    union all
    select 'INVALID_GSTIN', 'ERROR', 'SALES_INVOICE', i.id, i.invoice_number, i.invoice_date, format('Customer GSTIN %s is not a valid GSTIN.', i.customer_gstin)
    from inv i where i.status = 'ISSUED' and i.customer_gstin is not null and i.customer_gstin !~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'
    union all
    select 'MISSING_PLACE_OF_SUPPLY', 'ERROR', 'SALES_INVOICE', i.id, i.invoice_number, i.invoice_date, 'The invoice has no place of supply.'
    from inv i where i.status = 'ISSUED' and i.place_of_supply_state_code is null and i.supply_category <> 'NON_GST'
    union all
    select 'MISSING_HSN', 'ERROR', 'SALES_INVOICE', i.id, i.invoice_number, i.invoice_date, format('%s line(s) without HSN / SAC.', count(*))
    from inv i join public.sales_invoice_lines l on l.invoice_id = i.id
    where i.status = 'ISSUED' and i.supply_category <> 'NON_GST' and l.hsn_sac is null group by i.id, i.invoice_number, i.invoice_date
    union all
    select 'UQC_UNMAPPED', 'WARNING', 'SALES_INVOICE', i.id, i.invoice_number, i.invoice_date, format('Unit %s has no UQC in the GST configuration.', l.unit)
    from inv i join public.sales_invoice_lines l on l.invoice_id = i.id cross join cfg
    where i.status = 'ISSUED' and l.unit is not null and not ((cfg.payload -> 'uqc_map') ? upper(l.unit)) group by i.id, i.invoice_number, i.invoice_date, l.unit
    union all
    select 'INVALID_CLASSIFICATION', 'ERROR', 'SALES_INVOICE', i.id, i.invoice_number, i.invoice_date,
      case when i.tax_treatment = 'UNRESOLVED' then 'The tax treatment (intra / inter-state) is unresolved.'
           when i.tax_treatment = 'INTRA_STATE' and i.igst_total > 0 then 'Intra-state invoice carries IGST.'
           when i.tax_treatment = 'INTER_STATE' and i.cgst_total + i.sgst_total > 0 then 'Inter-state invoice carries CGST / SGST.'
           when i.supply_category in ('EXEMPT', 'NON_GST') and i.cgst_total + i.sgst_total + i.igst_total > 0 then 'An exempt / non-GST supply carries GST.'
           when d.section_override in ('B2B', 'CDNR') and i.customer_gstin is null then 'Section override B2B without a customer GSTIN.'
           else 'The place of supply does not agree with the tax treatment.' end
    from inv i left join public.gst_sales_document_details d on d.sales_invoice_id = i.id
    where i.status = 'ISSUED' and (i.tax_treatment = 'UNRESOLVED' or (i.tax_treatment = 'INTRA_STATE' and i.igst_total > 0)
      or (i.tax_treatment = 'INTER_STATE' and i.cgst_total + i.sgst_total > 0)
      or (i.supply_category in ('EXEMPT', 'NON_GST') and i.cgst_total + i.sgst_total + i.igst_total > 0)
      or (d.section_override in ('B2B', 'CDNR') and i.customer_gstin is null)
      or (i.place_of_supply_state_code is not null and i.seller_state_code is not null and i.customer_registration_type is distinct from 'OVERSEAS'
          and ((i.tax_treatment = 'INTRA_STATE' and i.place_of_supply_state_code <> i.seller_state_code)
            or (i.tax_treatment = 'INTER_STATE' and i.place_of_supply_state_code = i.seller_state_code and i.customer_registration_type is distinct from 'SEZ'))))
    union all
    select 'EXPORT_DETAILS_MISSING', 'WARNING', 'SALES_INVOICE', i.id, i.invoice_number, i.invoice_date, 'Export / SEZ supply without shipping bill or port details.'
    from inv i left join public.gst_sales_document_details d on d.sales_invoice_id = i.id
    where i.status = 'ISSUED' and (i.customer_registration_type = 'OVERSEAS' or (i.supply_category = 'ZERO_RATED' and i.customer_registration_type is distinct from 'SEZ'))
      and (d.id is null or d.shipping_bill_number is null or d.port_code is null)
    union all
    select 'UNPOSTED_SOURCE', 'WARNING', 'SALES_INVOICE', i.id, coalesce(i.invoice_number, '(draft)'), i.invoice_date,
      case when i.status = 'ISSUED' then 'Issued invoice without an accounting voucher (run the posting).' else format('Invoice is %s — not in the return.', lower(replace(i.status, '_', ' '))) end
    from inv i where (i.status in ('DRAFT', 'PENDING_APPROVAL'))
      or (i.status = 'ISSUED' and not exists (select 1 from public.accounting_vouchers v where v.company_id = p.company_id and v.source = 'AUTO' and v.source_type = 'SALES_INVOICE'
            and v.source_id = i.id and v.status in ('POSTED', 'REVERSED')))
    union all
    select 'UNPOSTED_SOURCE', 'WARNING', case n.note_type when 'CREDIT' then 'CREDIT_NOTE' else 'DEBIT_NOTE' end, n.id, coalesce(n.note_number, '(draft)'), n.note_date,
      case when n.status = 'ISSUED' then 'Issued note without an accounting voucher.' else format('Note is %s — not in the return.', lower(replace(n.status, '_', ' '))) end
    from public.invoice_adjustment_notes n where n.company_id = p.company_id and n.note_date between p.period_start and p.period_end
      and (n.status in ('DRAFT', 'PENDING_APPROVAL') or (n.status = 'ISSUED' and not exists (select 1 from public.accounting_vouchers v where v.company_id = p.company_id
        and v.source = 'AUTO' and v.source_type = case n.note_type when 'CREDIT' then 'CREDIT_NOTE' else 'DEBIT_NOTE' end and v.source_id = n.id and v.status in ('POSTED', 'REVERSED'))))
    union all
    select 'UNPOSTED_SOURCE', 'WARNING', 'PURCHASE_INVOICE', i.id, i.invoice_number, i.supplier_invoice_date, format('Supplier invoice is %s — not in the return until posted.', lower(i.status))
    from public.purchase_invoices i where i.company_id = p.company_id and i.status in ('DRAFT', 'SUBMITTED', 'APPROVED') and i.supplier_invoice_date between p.period_start and p.period_end
    union all
    select 'MISSING_SUPPLIER_GSTIN', 'ERROR', 'PURCHASE_INVOICE', i.id, i.invoice_number, i.supplier_invoice_date, 'Supplier invoice with GST but no supplier GSTIN.'
    from public.purchase_invoices i where i.company_id = p.company_id and i.status = 'POSTED' and i.recorded_date between p.period_start and p.period_end
      and i.supplier_gstin is null and not i.reverse_charge and i.cgst_total + i.sgst_total + i.igst_total + i.cess_total > 0
    union all
    select 'ITC_PENDING', 'WARNING', 'PURCHASE_INVOICE', i.id, i.invoice_number, i.supplier_invoice_date,
      case when exists (select 1 from public.gst_itc_decisions d where d.purchase_invoice_id = i.id and d.seq = (select max(seq) from public.gst_itc_decisions x where x.purchase_invoice_id = i.id)
             and d.stage = 'PROPOSED') then 'ITC decision proposed, awaiting approval.' else 'ITC not yet decided (pending verification).' end
    from public.purchase_invoices i where i.company_id = p.company_id and i.status = 'POSTED' and i.gst_status = 'PENDING_VERIFICATION' and i.recorded_date <= p.period_end
      and i.cgst_total + i.sgst_total + i.igst_total + i.cess_total > 0
    union all
    select 'ITC_WITHOUT_GSTR2B', 'WARNING', 'PURCHASE_INVOICE', e.purchase_invoice_id, e.invoice_number, e.voucher_date,
      'ITC availed without an approved GSTR-2B match (evidence only; review the decision).'
    from private.gst_itc_events(p.company_id, p.period_start, p.period_end) e where e.event = 'AVAILED' and e.igst + e.cgst + e.sgst + e.cess > 0
      and e.gstr2b_status is distinct from 'APPROVED')
  select coalesce(jsonb_agg(to_jsonb(x) order by x.severity, x.code, x.document_date, x.document_no), '[]'::jsonb) from x;
$$;
revoke all on function private.gst_return_exceptions(public.gst_return_periods) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 7. GSTR-1 working
-- -----------------------------------------------------------------------------
create or replace function private.gst_gstr1(p public.gst_return_periods)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_cfg     public.gst_config_versions := private.gst_config_on(p.company_id, p.period_end);
  v_thr     numeric := coalesce((v_cfg.payload ->> 'b2cl_invoice_threshold')::numeric, 100000);
  v_uqc     jsonb := coalesce(v_cfg.payload -> 'uqc_map', '{}'::jsonb);
  v_codes   text[] := array['B2B', 'SEZWP', 'SEZWOP', 'DE', 'B2CL', 'B2CS', 'EXPWP', 'EXPWOP', 'CDNR', 'CDNUR', 'NIL'];
  v_sec     jsonb := '{}'::jsonb;
  k         text;
  v_rows    jsonb;
  v_calc    jsonb;
begin
  foreach k in array v_codes loop
    select jsonb_build_object('documents', count(*), 'taxable', coalesce(sum(sign * taxable), 0), 'igst', coalesce(sum(sign * igst), 0), 'cgst', coalesce(sum(sign * cgst), 0),
      'sgst', coalesce(sum(sign * sgst), 0), 'cess', coalesce(sum(sign * cess), 0))
    into v_calc from private.gst_sales_docs(p.company_id, p.period_start, p.period_end, v_thr) where section = k;
    if k = 'B2CS' then
      -- B2CS is reported in aggregate by place of supply, rate and supply type (notes against B2CS invoices net off here).
      select coalesce(jsonb_agg(jsonb_build_object('place_of_supply', pos, 'supply_type', st, 'rate', rate, 'taxable', taxable, 'igst', igst, 'cgst', cgst, 'sgst', sgst, 'cess', 0)
               order by pos, rate), '[]'::jsonb)
      into v_rows from (
        select d.place_of_supply as pos, case when d.tax_treatment = 'INTER_STATE' then 'INTER' else 'INTRA' end as st, l.gst_rate as rate, sum(l.sign * l.taxable) as taxable,
          sum(l.sign * l.igst) as igst, sum(l.sign * l.cgst) as cgst, sum(l.sign * l.sgst) as sgst
        from private.gst_sales_docs(p.company_id, p.period_start, p.period_end, v_thr) d join private.gst_sales_doc_lines(p.company_id, p.period_start, p.period_end) l on l.doc_id = d.id where d.section = 'B2CS' group by 1, 2, 3) x;
    else
      select coalesce(jsonb_agg(jsonb_build_object('kind', d.kind, 'id', d.id, 'number', d.number, 'date', d.doc_date, 'customer', d.customer_name, 'gstin', d.customer_gstin,
               'place_of_supply', d.place_of_supply, 'value', d.doc_value, 'sign', d.sign, 'taxable', d.taxable, 'igst', d.igst, 'cgst', d.cgst, 'sgst', d.sgst, 'cess', d.cess,
               'original_invoice', d.original_invoice, 'export', d.export_details,
               'rates', (select coalesce(jsonb_agg(jsonb_build_object('rate', r.rate, 'taxable', r.taxable, 'igst', r.igst, 'cgst', r.cgst, 'sgst', r.sgst) order by r.rate), '[]'::jsonb)
                         from (select l.gst_rate as rate, sum(l.taxable) as taxable, sum(l.igst) as igst, sum(l.cgst) as cgst, sum(l.sgst) as sgst
                               from private.gst_sales_doc_lines(p.company_id, p.period_start, p.period_end) l where l.doc_id = d.id group by 1) r)) order by d.doc_date, d.number), '[]'::jsonb)
      into v_rows from private.gst_sales_docs(p.company_id, p.period_start, p.period_end, v_thr) d where d.section = k;
    end if;
    v_sec := v_sec || jsonb_build_object(k, jsonb_build_object('label', coalesce(v_cfg.payload -> 'section_map' ->> k, k), 'calculated', v_calc, 'rows', v_rows));
  end loop;
  return jsonb_build_object('return_type', 'GSTR1', 'period', p.period_code, 'from', p.period_start, 'to', p.period_end,
    'config_version_id', v_cfg.id, 'config_version_no', v_cfg.version_no, 'b2cl_invoice_threshold', v_thr,
    'sections', private.gst_apply_adjustments(v_sec, p.id, 'GSTR1'),
    'unmatched_adjustments', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'section', a.section, 'field', a.field, 'amount', a.amount, 'status', a.status))
       from public.gst_return_adjustments a where a.period_id = p.id and a.return_type = 'GSTR1' and a.status in ('APPROVED', 'DRAFT') and not (a.section = any (v_codes))), '[]'::jsonb),
    'hsn', coalesce((select jsonb_agg(jsonb_build_object('hsn_sac', hsn, 'uqc', uqc, 'rate', rate, 'b2b', b2b, 'quantity', qty, 'taxable', taxable, 'igst', igst, 'cgst', cgst,
         'sgst', sgst, 'cess', 0) order by b2b desc, hsn, rate) from (
       select coalesce(l.hsn_sac, '(missing)') as hsn, coalesce(v_uqc ->> upper(l.unit), 'OTH') as uqc, l.gst_rate as rate, d.section in ('B2B', 'SEZWP', 'SEZWOP', 'DE', 'CDNR') as b2b,
         sum(l.sign * l.quantity) as qty, sum(l.sign * l.taxable) as taxable, sum(l.sign * l.igst) as igst, sum(l.sign * l.cgst) as cgst, sum(l.sign * l.sgst) as sgst
       from private.gst_sales_doc_lines(p.company_id, p.period_start, p.period_end) l join private.gst_sales_docs(p.company_id, p.period_start, p.period_end, v_thr) d on d.id = l.doc_id group by 1, 2, 3, 4) h), '[]'::jsonb),
    'documents_issued', coalesce((select jsonb_agg(jsonb_build_object('nature', nature, 'series', series, 'from', min_no, 'to', max_no, 'total', total, 'cancelled', cancelled,
         'net_issued', total - cancelled) order by nature, series) from (
       select 'Invoices for outward supply' as nature, coalesce(i.numbering_scope, '') as series, min(i.invoice_number) as min_no, max(i.invoice_number) as max_no, count(*) as total,
         count(*) filter (where i.status = 'CANCELLED') as cancelled
       from public.sales_invoices i where i.company_id = p.company_id and i.invoice_number is not null and i.status in ('ISSUED', 'CANCELLED') and not coalesce(i.is_proforma, false)
         and i.invoice_date between p.period_start and p.period_end group by 2
       union all
       select case n.note_type when 'CREDIT' then 'Credit notes' else 'Debit notes' end, coalesce(n.numbering_scope, ''), min(n.note_number), max(n.note_number), count(*),
         count(*) filter (where n.status = 'CANCELLED')
       from public.invoice_adjustment_notes n where n.company_id = p.company_id and n.note_number is not null and n.status in ('ISSUED', 'CANCELLED')
         and n.note_date between p.period_start and p.period_end group by 1, 2) dd), '[]'::jsonb),
    'excluded', jsonb_build_object(
      'draft_or_pending', (select count(*) from public.sales_invoices i where i.company_id = p.company_id and i.status in ('DRAFT', 'PENDING_APPROVAL') and i.invoice_date between p.period_start and p.period_end)
        + (select count(*) from public.invoice_adjustment_notes n where n.company_id = p.company_id and n.status in ('DRAFT', 'PENDING_APPROVAL') and n.note_date between p.period_start and p.period_end),
      'cancelled', (select count(*) from public.sales_invoices i where i.company_id = p.company_id and i.status in ('CANCELLED', 'DISCARDED') and i.invoice_date between p.period_start and p.period_end)
        + (select count(*) from public.invoice_adjustment_notes n where n.company_id = p.company_id and n.status in ('CANCELLED', 'DISCARDED') and n.note_date between p.period_start and p.period_end),
      'proforma', (select count(*) from public.sales_invoices i where i.company_id = p.company_id and coalesce(i.is_proforma, false) and i.invoice_date between p.period_start and p.period_end)));
end;
$$;
revoke all on function private.gst_gstr1(public.gst_return_periods) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 8. GSTR-3B working
-- -----------------------------------------------------------------------------
create or replace function private.gst_gstr3b(p public.gst_return_periods)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_cfg   public.gst_config_versions := private.gst_config_on(p.company_id, p.period_end);
  v_thr   numeric := coalesce((v_cfg.payload ->> 'b2cl_invoice_threshold')::numeric, 100000);
  v_sec   jsonb := '{}'::jsonb;
  v_liab  jsonb := private.gst_liability(p);
  amt     jsonb;
begin
  -- 3.1 outward supplies (net of credit / debit notes) and inward supplies liable to reverse charge.
  for amt in
    select jsonb_build_object('code', c.code, 'label', c.label, 'calculated', (select jsonb_build_object('taxable', coalesce(sum(sign * taxable), 0), 'igst', coalesce(sum(sign * igst), 0),
             'cgst', coalesce(sum(sign * cgst), 0), 'sgst', coalesce(sum(sign * sgst), 0), 'cess', coalesce(sum(sign * cess), 0))
           from private.gst_sales_docs(p.company_id, p.period_start, p.period_end, v_thr) d where d.section = any (c.sections) and (c.categories is null or d.supply_category = any (c.categories))))
    from (values ('3.1(a)', 'Outward taxable supplies (other than zero rated, nil rated and exempted)', array['B2B', 'B2CL', 'B2CS', 'DE', 'CDNR', 'CDNUR'], null::text[]),
                 ('3.1(b)', 'Outward taxable supplies (zero rated)', array['EXPWP', 'EXPWOP', 'SEZWP', 'SEZWOP'], null::text[]),
                 ('3.1(c)', 'Other outward supplies (nil rated, exempted)', array['NIL'], array['TAXABLE', 'EXEMPT']),
                 ('3.1(e)', 'Non-GST outward supplies', array['NIL'], array['NON_GST'])) c (code, label, sections, categories)
  loop
    v_sec := v_sec || jsonb_build_object(amt ->> 'code', amt - 'code');
  end loop;
  v_sec := v_sec || jsonb_build_object('3.1(d)', jsonb_build_object('label', 'Inward supplies liable to reverse charge', 'calculated',
    (select jsonb_build_object('taxable', coalesce(sum(i.taxable_value), 0), 'igst', coalesce(sum(i.igst_total), 0), 'cgst', coalesce(sum(i.cgst_total), 0),
       'sgst', coalesce(sum(i.sgst_total), 0), 'cess', coalesce(sum(i.cess_total), 0))
     from public.purchase_invoices i where i.company_id = p.company_id and i.status = 'POSTED' and i.reverse_charge and i.recorded_date between p.period_start and p.period_end)));
  -- 4 ITC (from the decision history and ITC adjustments, by voucher date).
  v_sec := v_sec
    || jsonb_build_object('4(A)(3)', jsonb_build_object('label', 'ITC: inward supplies liable to reverse charge', 'calculated',
         (select jsonb_build_object('taxable', 0, 'igst', coalesce(sum(igst), 0), 'cgst', coalesce(sum(cgst), 0), 'sgst', coalesce(sum(sgst), 0), 'cess', coalesce(sum(cess), 0))
          from private.gst_itc_events(p.company_id, p.period_start, p.period_end) where event in ('AVAILED', 'ITC_RECLAIM') and reverse_charge)))
    || jsonb_build_object('4(A)(5)', jsonb_build_object('label', 'ITC: all other ITC', 'calculated',
         (select jsonb_build_object('taxable', 0, 'igst', coalesce(sum(igst), 0), 'cgst', coalesce(sum(cgst), 0), 'sgst', coalesce(sum(sgst), 0), 'cess', coalesce(sum(cess), 0))
          from private.gst_itc_events(p.company_id, p.period_start, p.period_end) where event in ('AVAILED', 'ITC_RECLAIM') and not reverse_charge)))
    || jsonb_build_object('4(B)(2)', jsonb_build_object('label', 'ITC reversed: others (reversals and reversed decisions)', 'calculated',
         (select jsonb_build_object('taxable', 0, 'igst', coalesce(sum(igst), 0), 'cgst', coalesce(sum(cgst), 0), 'sgst', coalesce(sum(sgst), 0), 'cess', coalesce(sum(cess), 0))
          from private.gst_itc_events(p.company_id, p.period_start, p.period_end) where event in ('ITC_REVERSAL', 'DECISION_REVERSED'))))
    || jsonb_build_object('4(D)(2)', jsonb_build_object('label', 'Ineligible ITC (blocked / not claimed)', 'calculated',
         jsonb_build_object('taxable', 0, 'igst', 0, 'cgst', 0, 'sgst', 0, 'cess', 0, 'total', (select coalesce(sum(ineligible), 0) from private.gst_itc_events(p.company_id, p.period_start, p.period_end) where event in ('AVAILED', 'DECISION_REVERSED')))))
    || jsonb_build_object('5', jsonb_build_object('label', 'Exempt, nil rated and non-GST inward supplies', 'calculated',
         (select jsonb_build_object('taxable', coalesce(sum(i.taxable_value), 0), 'inter_state', coalesce(sum(i.taxable_value) filter (where i.tax_treatment = 'INTER_STATE'), 0),
            'intra_state', coalesce(sum(i.taxable_value) filter (where i.tax_treatment is distinct from 'INTER_STATE'), 0), 'igst', 0, 'cgst', 0, 'sgst', 0, 'cess', 0)
          from public.purchase_invoices i where i.company_id = p.company_id and i.status = 'POSTED' and i.supply_category in ('EXEMPT', 'NIL_RATED', 'NON_GST')
            and i.recorded_date between p.period_start and p.period_end)));
  v_sec := private.gst_apply_adjustments(v_sec, p.id, 'GSTR3B');
  return jsonb_build_object('return_type', 'GSTR3B', 'period', p.period_code, 'from', p.period_start, 'to', p.period_end,
    'config_version_id', v_cfg.id, 'config_version_no', v_cfg.version_no,
    'sections', v_sec,
    'net_itc', (select jsonb_object_agg(h, coalesce((v_sec -> '4(A)(3)' -> 'adjusted' ->> h)::numeric, 0) + coalesce((v_sec -> '4(A)(5)' -> 'adjusted' ->> h)::numeric, 0)
                 - coalesce((v_sec -> '4(B)(2)' -> 'adjusted' ->> h)::numeric, 0)) from unnest(array['igst', 'cgst', 'sgst', 'cess']) h),
    '3.2_inter_state_unregistered', coalesce((select jsonb_agg(jsonb_build_object('place_of_supply', pos, 'taxable', taxable, 'igst', igst) order by pos) from (
       select d.place_of_supply as pos, sum(d.sign * d.taxable) as taxable, sum(d.sign * d.igst) as igst from private.gst_sales_docs(p.company_id, p.period_start, p.period_end, v_thr) d
       where d.section in ('B2CL', 'B2CS', 'CDNUR') and d.tax_treatment = 'INTER_STATE' and d.customer_gstin is null group by 1) x), '[]'::jsonb),
    'unmatched_adjustments', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'section', a.section, 'field', a.field, 'amount', a.amount, 'status', a.status))
       from public.gst_return_adjustments a where a.period_id = p.id and a.return_type = 'GSTR3B' and a.status in ('APPROVED', 'DRAFT') and not (v_sec ? a.section)), '[]'::jsonb),
    -- 6.1 payment of tax: liability by head from the return, set-offs posted for the period (credit by credit head, cash) and interest / late fee.
    '6.1', (select jsonb_agg(jsonb_build_object('head', h.head,
        'payable_per_return', coalesce((v_sec -> '3.1(a)' -> 'adjusted' ->> lower(h.head))::numeric, 0) + coalesce((v_sec -> '3.1(b)' -> 'adjusted' ->> lower(h.head))::numeric, 0)
          + coalesce((v_sec -> '3.1(d)' -> 'adjusted' ->> lower(h.head))::numeric, 0),
        'liability_per_ledger', coalesce((v_liab -> 'output' ->> h.head)::numeric, 0) + coalesce((v_liab -> 'rcm' ->> h.head)::numeric, 0),
        'paid_through_itc', (select coalesce(jsonb_object_agg(l.source_head, l.amt), '{}'::jsonb) from (select l.source_head, sum(l.amount) as amt from public.gst_set_off_lines l
           join public.gst_set_offs s on s.id = l.set_off_id where s.period_id = p.id and s.status = 'POSTED' and l.source = 'CREDIT' and l.liability_head = h.head
           and l.liability_kind in ('OUTPUT', 'RCM') group by 1) l),
        'paid_in_cash', (select coalesce(sum(l.amount), 0) from public.gst_set_off_lines l join public.gst_set_offs s on s.id = l.set_off_id where s.period_id = p.id
           and s.status = 'POSTED' and l.source = 'CASH' and l.liability_head = h.head and l.liability_kind in ('OUTPUT', 'RCM')),
        'interest', (select coalesce(sum(l.amount), 0) from public.gst_set_off_lines l join public.gst_set_offs s on s.id = l.set_off_id where s.period_id = p.id
           and s.status = 'POSTED' and l.liability_head = h.head and l.liability_kind = 'INTEREST'),
        'late_fee', (select coalesce(sum(l.amount), 0) from public.gst_set_off_lines l join public.gst_set_offs s on s.id = l.set_off_id where s.period_id = p.id
           and s.status = 'POSTED' and l.liability_head = h.head and l.liability_kind = 'LATE_FEE'),
        'open_after_set_off', (v_liab -> 'open' ->> ('OUTPUT:' || h.head))::numeric + (v_liab -> 'open' ->> ('RCM:' || h.head))::numeric) order by h.ord)
      from (values (1, 'IGST'), (2, 'CGST'), (3, 'SGST'), (4, 'CESS')) h (ord, head)),
    'credit', v_liab -> 'credit_detail',
    'itc_evidence', jsonb_build_object(
      'note', 'GSTR-2B results are evidence only: ITC comes from approved maker-checker decisions, never from GSTR-2B.',
      'by_gstr2b_status', coalesce((select jsonb_object_agg(coalesce(gstr2b_status, 'NOT_MATCHED'), jsonb_build_object('decisions', n, 'itc', itc)) from (
         select gstr2b_status, count(*) as n, sum(igst + cgst + sgst + cess) as itc from private.gst_itc_events(p.company_id, p.period_start, p.period_end) where event = 'AVAILED' group by 1) x), '{}'::jsonb),
      'events', coalesce((select jsonb_agg(to_jsonb(e) order by e.voucher_date, e.voucher_number) from private.gst_itc_events(p.company_id, p.period_start, p.period_end) e), '[]'::jsonb)));
end;
$$;
revoke all on function private.gst_gstr3b(public.gst_return_periods) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 9. Reconciliation with the ledgers and tax-head summary
-- -----------------------------------------------------------------------------
create or replace function private.gst_ledger_reconciliation(p public.gst_return_periods)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_cfg  public.gst_config_versions := private.gst_config_on(p.company_id, p.period_end);
  v_thr  numeric := coalesce((v_cfg.payload ->> 'b2cl_invoice_threshold')::numeric, 100000);
  v_rows jsonb := '[]'::jsonb;
  h      text;
  d_out  numeric;
  l_out  numeric;
  d_itc  numeric;
  l_itc  numeric;
  v_liab jsonb := private.gst_liability(p);
begin
  foreach h in array array['IGST', 'CGST', 'SGST', 'CESS'] loop
    select coalesce(sum(d.sign * case h when 'IGST' then d.igst when 'CGST' then d.cgst when 'SGST' then d.sgst else d.cess end), 0) into d_out
    from private.gst_sales_docs(p.company_id, p.period_start, p.period_end, v_thr) d;
    l_out := case when h = 'CESS' then 0 else -private.gst_ledger_movement(p.company_id, 'OUTPUT_' || h, p.period_start, p.period_end, 'GST_SET_OFF') end;
    select coalesce(sum(case when e.event in ('AVAILED', 'ITC_RECLAIM') then 1 else -1 end * case h when 'IGST' then e.igst when 'CGST' then e.cgst when 'SGST' then e.sgst else e.cess end), 0)
    into d_itc from private.gst_itc_events(p.company_id, p.period_start, p.period_end) e;
    l_itc := private.gst_ledger_movement(p.company_id, 'INPUT_' || h, p.period_start, p.period_end, 'GST_SET_OFF');
    v_rows := v_rows || jsonb_build_object('head', h, 'output_documents', d_out, 'output_ledger', l_out, 'output_difference', l_out - d_out,
      'itc_documents', d_itc, 'itc_ledger', l_itc, 'itc_difference', l_itc - d_itc,
      'rcm_documents', coalesce((v_liab -> 'rcm' ->> h)::numeric, 0),
      'set_off_credit', (select coalesce(sum(l.amount), 0) from public.gst_set_off_lines l join public.gst_set_offs s on s.id = l.set_off_id where s.period_id = p.id and s.status = 'POSTED'
         and l.source = 'CREDIT' and l.liability_head = h),
      'set_off_cash', (select coalesce(sum(l.amount), 0) from public.gst_set_off_lines l join public.gst_set_offs s on s.id = l.set_off_id where s.period_id = p.id and s.status = 'POSTED'
         and l.source = 'CASH' and l.liability_head = h),
      'open_liability', coalesce((v_liab -> 'open' ->> ('OUTPUT:' || h))::numeric, 0) + coalesce((v_liab -> 'open' ->> ('RCM:' || h))::numeric, 0),
      'credit_available_at_period_end', (v_liab -> 'credit_detail' -> h ->> 'available_at_period_end')::numeric,
      'credit_available_now', (v_liab -> 'credit_detail' -> h ->> 'current_available')::numeric);
  end loop;
  return jsonb_build_object('period', p.period_code, 'from', p.period_start, 'to', p.period_end, 'tax_heads', v_rows,
    'rcm_payable_ledger', -private.gst_ledger_movement(p.company_id, 'RCM_GST_PAYABLE', p.period_start, p.period_end, 'GST_SET_OFF'),
    'rcm_documents_total', (select coalesce(sum(i.cgst_total + i.sgst_total + i.igst_total + i.cess_total), 0) from public.purchase_invoices i where i.company_id = p.company_id
       and i.status = 'POSTED' and i.reverse_charge and i.recorded_date between p.period_start and p.period_end),
    'cash_ledger', v_liab -> 'cash_ledger', 'cash', v_liab -> 'cash',
    -- Vouchers on the GST output / input / RCM ledgers of the period that no GST source document explains (manual journals, other modules).
    'unexplained_vouchers', coalesce((select jsonb_agg(jsonb_build_object('voucher_id', v.id, 'voucher_number', v.voucher_number, 'date', v.voucher_date, 'source', v.source,
         'source_type', v.source_type, 'account', a.account_code || ' ' || a.account_name, 'rule_key', r.rule_key, 'debit', l.debit, 'credit', l.credit, 'narration', v.narration)
         order by v.voucher_date, v.voucher_number)
       from public.accounting_voucher_lines l join public.accounting_vouchers v on v.id = l.voucher_id join public.accounts a on a.id = l.account_id
       join public.accounting_posting_rules r on r.company_id = p.company_id and r.account_id = l.account_id
         and r.rule_key in ('OUTPUT_IGST', 'OUTPUT_CGST', 'OUTPUT_SGST', 'INPUT_IGST', 'INPUT_CGST', 'INPUT_SGST', 'INPUT_CESS', 'RCM_GST_PAYABLE')
       where v.company_id = p.company_id and v.status in ('POSTED', 'REVERSED') and v.voucher_date between p.period_start and p.period_end
         and (v.source is distinct from 'AUTO' or v.source_type is null
              or v.source_type not in ('SALES_INVOICE', 'CREDIT_NOTE', 'DEBIT_NOTE', 'PURCHASE_INVOICE', 'PURCHASE_INVOICE_GST', 'GST_ITC_DECISION', 'GST_ITC_ADJUSTMENT', 'GST_SET_OFF'))), '[]'::jsonb),
    'note', 'Documents: issued sales invoices and notes, posted supplier invoices and the ITC decision history. Ledgers: posted and reversed vouchers, set-off vouchers excluded.');
end;
$$;
revoke all on function private.gst_ledger_reconciliation(public.gst_return_periods) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 10. Public read RPCs (gst.read)
-- -----------------------------------------------------------------------------
create or replace function private.gst_filing_json(p_period uuid, p_type text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select to_jsonb(f) - 'company_id' || jsonb_build_object('recorded_by_name', (select full_name from public.profiles where id = f.recorded_by),
    'note_on_filing', 'Recorded by a user after filing on the GST portal; this system does not file returns.')
  from public.gst_return_filings f where f.period_id = p_period and f.return_type = p_type and f.status = 'RECORDED';
$$;
revoke all on function private.gst_filing_json(uuid, text) from public, anon, authenticated;

-- A return working: approved / closed periods from their snapshot (APPROVED, or FILED when a filing is recorded); open periods live
-- (CALCULATED, or ADJUSTED when approved adjustments apply).
create or replace function public.gst_return_get(p_period_id uuid, p_return_type text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('gst.read');
  v_type    text := upper(coalesce(p_return_type, ''));
  p         public.gst_return_periods;
  s         public.gst_period_snapshots;
  v_body    jsonb;
  v_live    jsonb;
  v_filing  jsonb;
  v_source  text;
begin
  if v_type not in ('GSTR1', 'GSTR3B') then
    raise exception 'Return type must be GSTR1 or GSTR3B.' using errcode = '22023';
  end if;
  select * into p from public.gst_return_periods where id = p_period_id and company_id = v_company;
  if not found then
    raise exception 'GST return period not found.' using errcode = 'P0002';
  end if;
  v_filing := private.gst_filing_json(p.id, v_type);
  if p.status in ('APPROVED', 'CLOSED') then
    select sn.* into s from public.gst_period_current_snapshot c join public.gst_period_snapshots sn on sn.id = c.snapshot_id where c.period_id = p.id;
  end if;
  v_live := case v_type when 'GSTR1' then private.gst_gstr1(p) else private.gst_gstr3b(p) end;
  if s.id is not null and s.data -> 'returns' ? v_type then
    v_body := s.data -> 'returns' -> v_type;
    v_source := 'SNAPSHOT';
  else
    v_body := v_live;
    v_source := 'LIVE';
  end if;
  return v_body || jsonb_build_object(
    'source', v_source,
    'value_status', case when v_filing is not null then 'FILED' when v_source = 'SNAPSHOT' then 'APPROVED'
                         when exists (select 1 from public.gst_return_adjustments a where a.period_id = p.id and a.return_type = v_type and a.status = 'APPROVED') then 'ADJUSTED'
                         else 'CALCULATED' end,
    'period_status', p.status,
    'snapshot', case when s.id is null then null else jsonb_build_object('id', s.id, 'version_no', s.version_no, 'snapshot_hash', s.snapshot_hash, 'created_at', s.created_at,
      'has_return_working', s.data -> 'returns' ? v_type) end,
    'live_differs', case when v_source = 'SNAPSHOT' then (v_live -> 'sections') is distinct from (v_body -> 'sections') else false end,
    'filing', v_filing,
    'exceptions', private.gst_return_exceptions(p),
    'disclaimer', 'Working data for preparing the return on the GST portal. This system does not file returns and has no GSTN / portal connection.');
end;
$$;

create or replace function public.gst_register(p_register text, p_filters jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('gst.read');
  v_kind    text := upper(coalesce(p_register, ''));
  p         public.gst_return_periods;
  v_from    date := nullif(p_filters ->> 'from', '')::date;
  v_to      date := nullif(p_filters ->> 'to', '')::date;
  v_thr     numeric;
  v_rows    jsonb;
begin
  if nullif(p_filters ->> 'period_id', '') is not null then
    select * into p from public.gst_return_periods where id = (p_filters ->> 'period_id')::uuid and company_id = v_company;
    if not found then
      raise exception 'GST return period not found.' using errcode = 'P0002';
    end if;
    v_from := p.period_start; v_to := p.period_end;
  end if;
  if v_from is null or v_to is null or v_to < v_from then
    raise exception 'Choose a return period or a date range.' using errcode = '22023';
  end if;
  v_thr := coalesce(((private.gst_config_on(v_company, v_to)).payload ->> 'b2cl_invoice_threshold')::numeric, 100000);
  if v_kind = 'SALES' then
    select coalesce(jsonb_agg(to_jsonb(d) order by d.doc_date, d.number), '[]'::jsonb) into v_rows from private.gst_sales_docs(v_company, v_from, v_to, v_thr) d;
  elsif v_kind in ('PURCHASE', 'RCM') then
    select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'invoice_number', i.invoice_number, 'supplier_name', coalesce(s.display_name, s.legal_name), 'supplier_gstin', i.supplier_gstin,
        'supplier_invoice_number', i.supplier_invoice_number, 'supplier_invoice_date', i.supplier_invoice_date, 'recorded_date', i.recorded_date, 'supply_category', i.supply_category,
        'place_of_supply', i.place_of_supply_state_code, 'reverse_charge', i.reverse_charge, 'taxable', i.taxable_value, 'igst', i.igst_total, 'cgst', i.cgst_total,
        'sgst', i.sgst_total, 'cess', i.cess_total, 'gst_status', i.gst_status,
        'itc_eligible', (select n.eligible_igst + n.eligible_cgst + n.eligible_sgst + n.eligible_cess from private.gst_itc_net(i.id) n),
        'itc_ineligible', (select n.ineligible_igst + n.ineligible_cgst + n.ineligible_sgst + n.ineligible_cess from private.gst_itc_net(i.id) n),
        'itc_stage', (select d.stage from public.gst_itc_decisions d where d.purchase_invoice_id = i.id order by d.seq desc limit 1),
        'gstr2b', private.gst_2b_evidence(i.id) ->> 'match_status',
        'rcm_period', case when i.reverse_charge then (select q.period_code from public.gst_return_periods q where q.company_id = v_company and i.recorded_date between q.period_start and q.period_end) end)
        order by i.recorded_date, i.invoice_number), '[]'::jsonb)
    into v_rows from public.purchase_invoices i left join public.suppliers s on s.id = i.supplier_id
    where i.company_id = v_company and i.status = 'POSTED' and i.recorded_date between v_from and v_to and (v_kind = 'PURCHASE' or i.reverse_charge);
  else
    raise exception 'Register must be SALES, PURCHASE or RCM.' using errcode = '22023';
  end if;
  return jsonb_build_object('register', v_kind, 'from', v_from, 'to', v_to, 'rows', v_rows,
    'totals', (select jsonb_build_object('documents', count(*), 'taxable', coalesce(sum(coalesce((r ->> 'sign')::int, 1) * (r ->> 'taxable')::numeric), 0),
       'igst', coalesce(sum(coalesce((r ->> 'sign')::int, 1) * (r ->> 'igst')::numeric), 0), 'cgst', coalesce(sum(coalesce((r ->> 'sign')::int, 1) * (r ->> 'cgst')::numeric), 0),
       'sgst', coalesce(sum(coalesce((r ->> 'sign')::int, 1) * (r ->> 'sgst')::numeric), 0), 'cess', coalesce(sum(coalesce((r ->> 'sign')::int, 1) * (r ->> 'cess')::numeric), 0))
       from jsonb_array_elements(v_rows) r),
    'note', 'Issued / posted documents only; drafts, pending and cancelled documents are excluded (see the exceptions).');
end;
$$;

create or replace function public.gst_reconciliation_get(p_period_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('gst.read');
  p         public.gst_return_periods;
begin
  select * into p from public.gst_return_periods where id = p_period_id and company_id = v_company;
  if not found then
    raise exception 'GST return period not found.' using errcode = 'P0002';
  end if;
  return private.gst_ledger_reconciliation(p);
end;
$$;

create or replace function public.gst_return_exceptions(p_period_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('gst.read');
  p         public.gst_return_periods;
begin
  select * into p from public.gst_return_periods where id = p_period_id and company_id = v_company;
  if not found then
    raise exception 'GST return period not found.' using errcode = 'P0002';
  end if;
  return jsonb_build_object('period', p.period_code, 'rows', private.gst_return_exceptions(p));
end;
$$;

create or replace function public.gst_dashboard()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('gst.read');
  r         public.gst_registrations;
  v_cfg     public.gst_config_versions := private.gst_config_on(v_company, private.company_today(v_company));
begin
  select * into r from public.gst_registrations where company_id = v_company and is_active;
  return jsonb_build_object(
    'registration', case when r.id is null then null else jsonb_build_object('gstin', r.gstin, 'legal_name', r.legal_name, 'state_code', r.state_code) end,
    'config_version_no', v_cfg.version_no, 'today', private.company_today(v_company),
    'periods', coalesce((select jsonb_agg(jsonb_build_object('id', q.id, 'period_code', q.period_code, 'frequency', q.frequency, 'from', q.period_start, 'to', q.period_end,
        'status', q.status, 'liability', l -> 'open', 'credit', l -> 'credit', 'warnings', l -> 'warnings',
        'set_off', (select s.status from public.gst_set_offs s where s.period_id = q.id and s.status in ('POSTED', 'DRAFT') order by (s.status = 'POSTED') desc limit 1),
        'snapshot_version', (select sn.version_no from public.gst_period_current_snapshot c join public.gst_period_snapshots sn on sn.id = c.snapshot_id where c.period_id = q.id),
        'filed', (select coalesce(jsonb_object_agg(f.return_type, jsonb_build_object('arn', f.arn, 'filed_on', f.filed_on)), '{}'::jsonb) from public.gst_return_filings f
                  where f.period_id = q.id and f.status = 'RECORDED')) order by q.period_start desc)
       from (select q.*, private.gst_liability(q) as l from (select * from public.gst_return_periods x where x.company_id = v_company order by x.period_start desc limit 12) q) q), '[]'::jsonb),
    'cash', coalesce((select jsonb_object_agg(c.major_head || ':' || c.minor_head, c.amount) from private.gst_cash_available(r.id) c), '{}'::jsonb),
    'challans_unpaid', (select count(*) from public.gst_challans c where c.company_id = v_company and c.status = 'CREATED'),
    'itc_pending', (select count(*) from public.purchase_invoices i where i.company_id = v_company and i.status = 'POSTED' and i.gst_status = 'PENDING_VERIFICATION'
       and i.cgst_total + i.sgst_total + i.igst_total + i.cess_total > 0),
    'gstr2b_missing_in_books', (select count(*) from private.gst_2b_scope(v_company, '{}'::jsonb) s where s.doc_type = 'INVOICE' and s.match_id is null),
    'note', 'Liability is shown per head after posted set-offs. Values are working data; returns are filed by the user on the GST portal.');
end;
$$;

create or replace function public.gst_payments_view(p_filters jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('gst.read');
  v_period  uuid := nullif(p_filters ->> 'period_id', '')::uuid;
begin
  return jsonb_build_object(
    'challans', coalesce((select jsonb_agg(to_jsonb(c) - 'company_id' || jsonb_build_object(
        'heads', (select coalesce(jsonb_agg(to_jsonb(h) - 'company_id'), '[]'::jsonb) from public.gst_challan_heads h where h.challan_id = c.id),
        'payments', (select coalesce(jsonb_agg(to_jsonb(y) - 'company_id' || jsonb_build_object('voucher_number', (select voucher_number from public.accounting_vouchers where id = y.voucher_id))
                       order by y.attempt_no), '[]'::jsonb) from public.gst_challan_payments y where y.challan_id = c.id))
        order by c.challan_date desc, c.cpin) from public.gst_challans c where c.company_id = v_company), '[]'::jsonb),
    'set_offs', coalesce((select jsonb_agg(to_jsonb(s) - 'company_id' || jsonb_build_object('period_code', q.period_code,
        'lines', (select coalesce(jsonb_agg(to_jsonb(l) - 'company_id' order by l.line_no), '[]'::jsonb) from public.gst_set_off_lines l where l.set_off_id = s.id),
        'voucher_number', (select voucher_number from public.accounting_vouchers where id = s.voucher_id),
        'reversal_voucher_number', (select voucher_number from public.accounting_vouchers where id = s.reversal_voucher_id))
        order by q.period_start desc, s.prepared_at desc)
       from public.gst_set_offs s join public.gst_return_periods q on q.id = s.period_id where s.company_id = v_company and (v_period is null or s.period_id = v_period)), '[]'::jsonb),
    'cash_ledger', private.gst_ledger_movement(v_company, 'GST_ELECTRONIC_CASH', null, null));
end;
$$;

-- -----------------------------------------------------------------------------
-- 11. Filing record (gst_returns.approve): only for an approved / closed period, against its current snapshot
-- -----------------------------------------------------------------------------
create or replace function public.gst_return_filing(p_action text, p_id uuid, p jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('gst_returns.approve');
  v_action  text := upper(coalesce(p_action, ''));
  q         public.gst_return_periods;
  f         public.gst_return_filings;
  v_type    text := upper(coalesce(p ->> 'return_type', ''));
  v_snap    public.gst_period_snapshots;
  v_date    date;
begin
  if v_action = 'RECORD' then
    q := private.gst_period_lock(v_company, private.accounting_uuid(p, 'period_id', 'Period'));
    if v_type not in ('GSTR1', 'GSTR3B') then
      raise exception 'Return type must be GSTR1 or GSTR3B.' using errcode = '22023';
    end if;
    if q.status not in ('APPROVED', 'CLOSED') then
      raise exception 'Record a filing only for an approved or closed period (this one is %).', lower(replace(q.status, '_', ' ')) using errcode = 'P0001';
    end if;
    select sn.* into v_snap from public.gst_period_current_snapshot c join public.gst_period_snapshots sn on sn.id = c.snapshot_id where c.period_id = q.id;
    if v_snap.id is null or not (v_snap.data -> 'returns' ? v_type) then
      raise exception 'The approved snapshot of % has no % working; reopen and approve the period again first.', q.period_code, v_type using errcode = 'P0001';
    end if;
    if upper(btrim(coalesce(p ->> 'arn', ''))) !~ '^[A-Z0-9]{15}$' then
      raise exception 'The ARN shown by the GST portal (15 letters / digits) is required.' using errcode = '22023';
    end if;
    begin
      v_date := (p ->> 'filed_on')::date;
    exception when others then
      v_date := null;
    end;
    if v_date is null or v_date > private.company_today(v_company) or v_date < q.period_start then
      raise exception 'The filing date must be a date between the start of the period and today.' using errcode = '22023';
    end if;
    begin
      insert into public.gst_return_filings (company_id, period_id, return_type, snapshot_id, arn, filed_on, note, recorded_by)
      values (v_company, q.id, v_type, v_snap.id, upper(btrim(p ->> 'arn')), v_date, left(p ->> 'note', 1000), auth.uid()) returning * into f;
    exception when unique_violation then
      raise exception 'A filing of % for % (or this ARN) is already recorded.', v_type, q.period_code using errcode = '23505';
    end;
  elsif v_action = 'VOID' then
    select * into f from public.gst_return_filings where id = p_id and company_id = v_company for update;
    if not found then
      raise exception 'Filing record not found.' using errcode = 'P0002';
    end if;
    if f.status <> 'RECORDED' then
      raise exception 'This filing record is already voided.' using errcode = 'P0001';
    end if;
    if length(btrim(coalesce(p ->> 'reason', ''))) < 10 then
      raise exception 'Record why the filing record is wrong (at least 10 characters).' using errcode = '22023';
    end if;
    update public.gst_return_filings set status = 'VOIDED', voided_by = auth.uid(), voided_at = now(), void_reason = left(btrim(p ->> 'reason'), 1000) where id = f.id returning * into f;
  else
    raise exception 'Unknown action %.', p_action using errcode = '22023';
  end if;
  perform private.write_audit_log(v_company, 'gst.return_filing_' || lower(v_action), 'gst_return_filing', f.id::text,
    jsonb_build_object('period_id', f.period_id, 'return_type', f.return_type, 'arn', f.arn, 'status', f.status));
  return to_jsonb(f) - 'company_id' || jsonb_build_object('note_on_filing', 'Recorded by a user after filing on the GST portal; this system does not file returns.');
end;
$$;


-- -----------------------------------------------------------------------------
-- 12. Existing functions changed (each from its latest text; Gate D lines marked): liability credit (historical / current), the match
--     tolerance (validation, configuration version on matches), snapshots with the return working, no reopening of a filed period, reset registry.
-- -----------------------------------------------------------------------------
create or replace function private.gst_liability(p public.gst_return_periods)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  -- Phase 5 Gate D: credit comes from private.gst_credit_position — historical (as of the period end) and current positions separated;
  -- a set-off may use only credit that keeps cumulative utilisation within cumulative accrual at every later period end.
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
    union all select 'RCM', r.h, r.cur, r.prev from rcm r)
  select jsonb_build_object(
    'output', (select jsonb_object_agg(h, cur) from outp),
    'rcm', (select jsonb_object_agg(h, cur) from rcm),
    'set_off', (select coalesce(jsonb_object_agg(kind || ':' || h, cur), '{}'::jsonb) from so where cur > 0),
    'open', (select jsonb_object_agg(a.kind || ':' || a.h, a.cur - coalesce((select so.cur from so where so.kind = a.kind and so.h = a.h), 0)) from liab a),
    'previous_outstanding', (select jsonb_object_agg(a.kind || ':' || a.h, a.prev - coalesce((select so.prev from so where so.kind = a.kind and so.h = a.h), 0)) from liab a),
    'previous_from', (select first_start from bounds),
    'credit', (select jsonb_object_agg(x.key, (x.value ->> 'available')::numeric) from jsonb_each(private.gst_credit_position(p)) x),
    'credit_detail', private.gst_credit_position(p),
    'credit_basis', 'Available = min(credit accrued by the period end less set-offs of this and earlier periods; the smallest such headroom at any later period end; the input ledger balance), never below zero. available_at_period_end is the historical position, current_available the ledger today.',
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
  -- Gate D: optional GSTR-2B match tolerance per amount (default 1.00 when absent).
  if p ? 'gstr2b_match_tolerance' and (jsonb_typeof(p -> 'gstr2b_match_tolerance') <> 'number' or (p ->> 'gstr2b_match_tolerance')::numeric < 0
     or (p ->> 'gstr2b_match_tolerance')::numeric > 100 or (p ->> 'gstr2b_match_tolerance')::numeric <> round((p ->> 'gstr2b_match_tolerance')::numeric, 2)) then
    e := e || to_jsonb('gstr2b_match_tolerance: the GSTR-2B match tolerance per amount, 0 to 100 with at most 2 decimals (default 1.00).'::text);
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
    reason, proposed_by, config_version_id)
  values (d.company_id, d.registration_id, d.id, v.id, i.id, p_method, c ->> 'outcome', array(select jsonb_array_elements_text(c -> 'mismatches')), c -> 'differences', tol,
    nullif(btrim(coalesce(p_reason, '')), ''), auth.uid(),
    -- Gate D: the configuration version whose tolerance was applied.
    (private.gst_config_on(d.company_id, private.company_today(d.company_id))).id)
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
    -- Gate D: tolerance applied and its configuration version.
    'config_version_no', (select c.version_no from public.gst_config_versions c where c.id = m.config_version_id),
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
    update public.gst_return_periods set status = 'CLOSED', closed_by = auth.uid(), closed_at = now(), updated_at = now(), row_version = row_version + 1
    where id = p.id returning * into p;
    perform private.gst_period_event(p, 'CLOSED', v_from, p_reason);
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

create or replace function private.erp_reset_tables()
returns table (ord int, table_name text, category text, label text)
language sql
stable
set search_path = ''
as $$
  select * from (values
    (-13, 'gst_return_filings', 'Accounting', 'GST return filing records'),
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

-- -----------------------------------------------------------------------------
-- 13. Grants: signed-in users only (each function checks its permission); never anon or service_role
-- -----------------------------------------------------------------------------
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.gst_return_get(uuid, text)',
    'public.gst_register(text, jsonb)',
    'public.gst_reconciliation_get(uuid)',
    'public.gst_return_exceptions(uuid)',
    'public.gst_dashboard()',
    'public.gst_payments_view(jsonb)',
    'public.gst_return_filing(text, uuid, jsonb)'] loop
    execute format('revoke all on function %s from public, anon, service_role', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;
