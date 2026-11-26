-- Rollback of 20261231090200_accounting_cost_centres.
--
-- Restores the Phase 0 / Phase 1 accounting functions exactly as 20261231090000 defined them, drops the Phase 2
-- functions, the allocation and budget tables, the added columns (cost centre type and effective dates, account
-- cost-centre rule, voucher line key) and the three budget permissions, and restores the ERP reset list.
-- Vouchers, voucher lines, accounts and cost centres themselves are kept. audit_logs entries stay (append-only).
--
-- Refused while allocations or budgets exist, because dropping them loses that analysis. To roll back anyway,
-- export it, then   set app.accounting_cost_centre_rollback_force = 'on';   in the same session.

do $$
begin
  if coalesce(current_setting('app.accounting_cost_centre_rollback_force', true), '') <> 'on' and to_regclass('public.accounting_cost_allocations') is not null
     and (exists (select 1 from public.accounting_cost_allocations) or exists (select 1 from public.accounting_budgets)) then
    raise exception 'Cost-centre allocations or budgets exist. Export them, then set app.accounting_cost_centre_rollback_force = on to roll back.';
  end if;
end;
$$;

drop function if exists public.accounting_cost_centre_delete(uuid);
drop function if exists public.accounting_account_set_cost_centre_policy(uuid, text);
drop function if exists public.accounting_cost_centre_summary(date, date);
drop function if exists public.accounting_cost_centre_profitability(date, date);
drop function if exists public.accounting_cost_centre_ledger(uuid, date, date, uuid);
drop function if exists public.accounting_budget_vs_actual(text, integer, uuid, uuid);
drop function if exists public.accounting_budgets(text);
drop function if exists public.accounting_budget_get(uuid);
drop function if exists public.accounting_budget_create(date, text, text);
drop function if exists public.accounting_budget_lines_replace(uuid, jsonb, text, text);
drop function if exists public.accounting_budget_approve(uuid, text);
drop function if exists public.accounting_budget_revise(uuid, text);
drop function if exists public.accounting_budget_cancel(uuid, text);
drop function if exists public.accounting_general_ledger(uuid, date, date, uuid, uuid);
drop function if exists public.accounting_day_book(date, date, text, uuid);
drop function if exists private.accounting_gl_rows(uuid, date, uuid, uuid);
drop function if exists private.accounting_cc_facts(uuid, date, date);
drop function if exists private.accounting_cc_budget(uuid, date, date);
drop function if exists private.accounting_budget_json(uuid);
drop function if exists private.accounting_budget_log(public.accounting_budgets, text, text, jsonb);

-- Phase 0 functions as they were (they no longer reference allocations).
create or replace function private.accounting_create_voucher(
  p_company uuid, p_type_code text, p_date date, p_reference text, p_narration text, p_source text,
  p_source_type text, p_source_id uuid, p_source_number text, p_reversal_of uuid, p_lines jsonb)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  s      public.accounting_settings := private.accounting_require_setup(p_company);
  v_type public.accounting_voucher_types;
  v_id   uuid;
begin
  select * into v_type from public.accounting_voucher_types where company_id = p_company and type_code = upper(p_type_code);
  if not found then
    raise exception 'Unknown voucher type %.', p_type_code using errcode = '22023';
  end if;
  if p_date is null then
    raise exception 'The voucher date is required.' using errcode = '22023';
  end if;
  insert into public.accounting_vouchers (company_id, voucher_type_id, financial_year, voucher_date, reference_number, narration, source,
    source_type, source_id, source_number, reversal_of_voucher_id, created_by, updated_by)
  values (p_company, v_type.id, private.financial_year(p_date, s.fy_start_month), p_date, left(p_reference, 100), left(p_narration, 1000), p_source,
    p_source_type, p_source_id, left(p_source_number, 100), p_reversal_of, auth.uid(), auth.uid())
  returning id into v_id;
  insert into public.accounting_voucher_lines (company_id, voucher_id, line_no, account_id, party_id, debit, credit, line_narration)
  select p_company, v_id, l.line_no, l.account_id, l.party_id, l.debit, l.credit, l.narration
  from private.accounting_parse_lines(p_company, coalesce(p_lines, '[]'::jsonb)) l;
  return v_id;
end;
$$;

create or replace function private.accounting_voucher_issues(p_voucher uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v        public.accounting_vouchers;
  t        public.accounting_voucher_types;
  v_issues jsonb := '[]'::jsonb;
  v_n      int;
  v_dr     numeric;
  v_cr     numeric;
  v_date   jsonb;
  r        record;
begin
  select * into v from public.accounting_vouchers where id = p_voucher;
  if not found then
    return jsonb_build_array(jsonb_build_object('code', 'NOT_FOUND', 'message', 'Voucher not found.'));
  end if;
  select * into t from public.accounting_voucher_types where id = v.voucher_type_id;
  select count(*), coalesce(sum(debit), 0), coalesce(sum(credit), 0) into v_n, v_dr, v_cr
  from public.accounting_voucher_lines where voucher_id = p_voucher;

  if v_n < 2 then
    v_issues := v_issues || jsonb_build_object('code', 'MIN_LINES', 'message', 'A voucher needs at least two lines.');
  end if;
  if v_n > 0 and (not exists (select 1 from public.accounting_voucher_lines where voucher_id = p_voucher and debit > 0)
                  or not exists (select 1 from public.accounting_voucher_lines where voucher_id = p_voucher and credit > 0)) then
    v_issues := v_issues || jsonb_build_object('code', 'ONE_SIDED', 'message', 'A voucher needs at least one debit line and one credit line.');
  end if;
  if v_dr <> v_cr then
    v_issues := v_issues || jsonb_build_object('code', 'UNBALANCED', 'message',
      format('Total debit (%s) does not equal total credit (%s); difference %s.', to_char(v_dr, 'FM999999999999990.00'),
             to_char(v_cr, 'FM999999999999990.00'), to_char(abs(v_dr - v_cr), 'FM999999999999990.00')));
  end if;
  if not t.is_active then
    v_issues := v_issues || jsonb_build_object('code', 'TYPE_INACTIVE', 'message', format('Voucher type %s is inactive.', t.type_name));
  end if;
  if v.source = 'MANUAL' and not t.allow_manual then
    v_issues := v_issues || jsonb_build_object('code', 'TYPE_NOT_MANUAL', 'message', format('%s vouchers are created automatically only.', t.type_name));
  end if;
  v_date := private.accounting_date_issue(v.company_id, v.voucher_date, v.source);
  if v_date is not null then
    v_issues := v_issues || v_date;
  end if;

  for r in
    select l.line_no, l.party_id, a.account_code, a.account_name, a.is_active, a.is_postable, a.allow_manual_posting, a.requires_party, g.is_active as group_active
    from public.accounting_voucher_lines l
    join public.accounts a on a.id = l.account_id
    join public.account_groups g on g.id = a.group_id
    where l.voucher_id = p_voucher
    order by l.line_no
  loop
    -- A reversal must always be possible, so it is not stopped by later account changes.
    if v.source <> 'REVERSAL' and not (r.is_active and r.group_active) then
      v_issues := v_issues || jsonb_build_object('code', 'ACCOUNT_INACTIVE', 'line_no', r.line_no,
        'message', format('Line %s: account %s %s is inactive.', r.line_no, r.account_code, r.account_name));
    end if;
    if v.source <> 'REVERSAL' and not r.is_postable then
      v_issues := v_issues || jsonb_build_object('code', 'ACCOUNT_NOT_POSTABLE', 'line_no', r.line_no,
        'message', format('Line %s: account %s %s does not accept postings.', r.line_no, r.account_code, r.account_name));
    end if;
    if v.source = 'MANUAL' and not r.allow_manual_posting then
      v_issues := v_issues || jsonb_build_object('code', 'ACCOUNT_NO_MANUAL', 'line_no', r.line_no,
        'message', format('Line %s: account %s %s is posted automatically only (control account).', r.line_no, r.account_code, r.account_name));
    end if;
    if r.requires_party and r.party_id is null then
      v_issues := v_issues || jsonb_build_object('code', 'PARTY_REQUIRED', 'line_no', r.line_no,
        'message', format('Line %s: account %s %s needs a customer or supplier.', r.line_no, r.account_code, r.account_name));
    end if;
    if not r.requires_party and r.party_id is not null then
      v_issues := v_issues || jsonb_build_object('code', 'PARTY_NOT_ALLOWED', 'line_no', r.line_no,
        'message', format('Line %s: account %s %s is not a party account; remove the customer / supplier.', r.line_no, r.account_code, r.account_name));
    end if;
  end loop;

  for r in
    select a.account_code, a.account_name
    from public.accounting_voucher_lines l join public.accounts a on a.id = l.account_id
    where l.voucher_id = p_voucher
    group by a.account_code, a.account_name, l.party_id
    having bool_or(l.debit > 0) and bool_or(l.credit > 0)
  loop
    v_issues := v_issues || jsonb_build_object('code', 'SAME_ACCOUNT_BOTH_SIDES', 'message',
      format('Account %s %s is both debited and credited in this voucher; enter the net amount once.', r.account_code, r.account_name));
  end loop;
  return v_issues;
end;
$$;

create or replace function private.accounting_reverse_voucher(p_voucher uuid, p_reason text, p_date date)
returns public.accounting_vouchers
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_orig   public.accounting_vouchers;
  v_rev    public.accounting_vouchers;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_date   date;
  v_lines  jsonb;
  v_id     uuid;
begin
  select * into v_orig from public.accounting_vouchers where id = p_voucher for update;
  if not found then
    raise exception 'Voucher not found.' using errcode = 'P0002';
  end if;
  if v_orig.status = 'REVERSED' then
    raise exception 'Voucher % has already been reversed.', v_orig.voucher_number using errcode = 'P0001';
  end if;
  if v_orig.status <> 'POSTED' then
    raise exception 'Only posted vouchers can be reversed (voucher is %).', lower(v_orig.status) using errcode = 'P0001';
  end if;
  if v_orig.source = 'REVERSAL' then
    raise exception 'Voucher % is itself a reversal and cannot be reversed.', v_orig.voucher_number using errcode = 'P0001';
  end if;
  if v_reason is null or length(v_reason) < 5 then
    raise exception 'A reversal reason of at least 5 characters is required.' using errcode = '22023';
  end if;
  if length(v_reason) > 1000 then
    raise exception 'The reversal reason is too long (maximum 1000 characters).' using errcode = '22023';
  end if;
  v_date := coalesce(p_date, private.company_today(v_orig.company_id));
  if v_date < v_orig.voucher_date then
    raise exception 'The reversal date cannot be before the original voucher date (%).', to_char(v_orig.voucher_date, 'DD-Mon-YYYY') using errcode = '22023';
  end if;
  select jsonb_agg(jsonb_build_object('account_id', l.account_id, 'party_id', l.party_id, 'debit', l.credit, 'credit', l.debit,
                                      'narration', l.line_narration) order by l.line_no)
    into v_lines from public.accounting_voucher_lines l where l.voucher_id = v_orig.id;
  v_id := private.accounting_create_voucher(v_orig.company_id, 'REV', v_date, v_orig.voucher_number,
    left('Reversal of ' || v_orig.voucher_number || ': ' || v_reason, 1000), 'REVERSAL', v_orig.source_type, v_orig.source_id, v_orig.source_number,
    v_orig.id, v_lines);
  v_rev := private.accounting_post_voucher(v_id);

  perform private.accounting_issue_token(v_orig.id, 'REVERSE');
  update public.accounting_vouchers
     set status = 'REVERSED', reversed_at = now(), reversed_by = auth.uid(), reversal_reason = v_reason, updated_by = auth.uid(), updated_at = now(),
         row_version = row_version + 1
   where id = v_orig.id;
  perform private.accounting_consume_token(v_orig.id);

  perform private.write_audit_log(v_orig.company_id, 'accounting.voucher.reversed', 'accounting_voucher', v_orig.id::text,
    jsonb_build_object('voucher_number', v_orig.voucher_number, 'reversal_voucher_id', v_rev.id, 'reversal_voucher_number', v_rev.voucher_number,
      'reversal_date', v_date, 'reason', left(v_reason, 500)));
  return v_rev;
end;
$$;

create or replace function private.accounting_voucher_json(p_voucher uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('id', v.id, 'voucher_type', t.type_code, 'voucher_type_name', t.type_name, 'voucher_number', v.voucher_number,
    'financial_year', v.financial_year, 'voucher_date', v.voucher_date, 'reference_number', v.reference_number, 'narration', v.narration,
    'status', v.status, 'source', v.source, 'source_type', v.source_type, 'source_id', v.source_id, 'source_number', v.source_number,
    'reversal_of_voucher_id', v.reversal_of_voucher_id,
    'reversal_of_number', (select o.voucher_number from public.accounting_vouchers o where o.id = v.reversal_of_voucher_id),
    'reversed_by_voucher_id', (select r.id from public.accounting_vouchers r where r.reversal_of_voucher_id = v.id),
    'reversed_by_number', (select r.voucher_number from public.accounting_vouchers r where r.reversal_of_voucher_id = v.id),
    'reversal_reason', v.reversal_reason, 'reversed_at', v.reversed_at,
    'reversed_by_name', (select full_name from public.profiles where id = v.reversed_by),
    'total_debit', coalesce((select sum(debit) from public.accounting_voucher_lines where voucher_id = v.id), 0),
    'total_credit', coalesce((select sum(credit) from public.accounting_voucher_lines where voucher_id = v.id), 0),
    'row_version', v.row_version, 'created_at', v.created_at, 'created_by_name', (select full_name from public.profiles where id = v.created_by),
    'updated_at', v.updated_at, 'posted_at', v.posted_at, 'posted_by_name', (select full_name from public.profiles where id = v.posted_by),
    'discarded_at', v.discarded_at, 'discard_reason', v.discard_reason,
    'lines', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'line_no', l.line_no, 'account_id', l.account_id, 'account_code', a.account_code,
        'account_name', a.account_name, 'party_id', l.party_id, 'party_name', case when l.party_id is not null then private.accounting_party_name(l.party_id) end,
        'debit', l.debit, 'credit', l.credit, 'narration', l.line_narration) order by l.line_no)
      from public.accounting_voucher_lines l join public.accounts a on a.id = l.account_id where l.voucher_id = v.id), '[]'::jsonb))
  from public.accounting_vouchers v join public.accounting_voucher_types t on t.id = v.voucher_type_id
  where v.id = p_voucher;
$$;

create or replace function public.accounting_voucher_update(p_voucher_id uuid, p_voucher jsonb, p_row_version integer default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('vouchers.create');
  v         public.accounting_vouchers := private.accounting_lock_draft(v_company, p_voucher_id, p_row_version);
  s         public.accounting_settings := private.accounting_require_setup(v_company);
  v_date    date := v.voucher_date;
begin
  if p_voucher is null or jsonb_typeof(p_voucher) <> 'object' then
    raise exception 'The voucher must be an object.' using errcode = '22023';
  end if;
  if p_voucher ? 'voucher_date' then
    v_date := private.accounting_date(p_voucher, 'voucher_date', 'Voucher date');
    if v_date is null then
      raise exception 'The voucher date is required.' using errcode = '22023';
    end if;
  end if;
  update public.accounting_vouchers
     set voucher_date = v_date, financial_year = private.financial_year(v_date, s.fy_start_month),
         reference_number = case when p_voucher ? 'reference_number' then private.accounting_text(p_voucher, 'reference_number', 100, 'Reference number') else reference_number end,
         narration = case when p_voucher ? 'narration' then private.accounting_text(p_voucher, 'narration', 1000, 'Narration') else narration end,
         updated_by = auth.uid(), updated_at = now(), row_version = row_version + 1
   where id = v.id;
  if p_voucher ? 'lines' then
    delete from public.accounting_voucher_lines where voucher_id = v.id;
    insert into public.accounting_voucher_lines (company_id, voucher_id, line_no, account_id, party_id, debit, credit, line_narration)
    select v_company, v.id, l.line_no, l.account_id, l.party_id, l.debit, l.credit, l.narration from private.accounting_parse_lines(v_company, p_voucher -> 'lines') l;
  end if;
  perform private.write_audit_log(v_company, 'accounting.voucher.updated', 'accounting_voucher', v.id::text,
    jsonb_build_object('lines_replaced', p_voucher ? 'lines', 'voucher_date', v_date));
  return private.accounting_voucher_json(v.id) || jsonb_build_object('issues', private.accounting_voucher_issues(v.id));
end;
$$;

create or replace function public.accounting_voucher_line_save(p_voucher_id uuid, p_line_id uuid, p_line jsonb, p_row_version integer default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('vouchers.create');
  v         public.accounting_vouchers := private.accounting_lock_draft(v_company, p_voucher_id, p_row_version);
  l         record;
  v_no      int;
begin
  select * into l from private.accounting_parse_lines(v_company, jsonb_build_array(p_line));
  if p_line_id is null then
    select coalesce(max(line_no), 0) + 1 into v_no from public.accounting_voucher_lines where voucher_id = v.id;
    if v_no > 500 then
      raise exception 'A voucher can have at most 500 lines.' using errcode = '22023';
    end if;
    insert into public.accounting_voucher_lines (company_id, voucher_id, line_no, account_id, party_id, debit, credit, line_narration)
    values (v_company, v.id, v_no, l.account_id, l.party_id, l.debit, l.credit, l.narration);
  else
    update public.accounting_voucher_lines set account_id = l.account_id, party_id = l.party_id, debit = l.debit, credit = l.credit,
      line_narration = l.narration, updated_at = now() where id = p_line_id and voucher_id = v.id;
    if not found then
      raise exception 'Voucher line not found.' using errcode = 'P0002';
    end if;
  end if;
  update public.accounting_vouchers set row_version = row_version + 1, updated_by = auth.uid(), updated_at = now() where id = v.id;
  return private.accounting_voucher_json(v.id) || jsonb_build_object('issues', private.accounting_voucher_issues(v.id));
end;
$$;

create or replace function public.accounting_voucher_line_delete(p_voucher_id uuid, p_line_id uuid, p_row_version integer default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('vouchers.create');
  v         public.accounting_vouchers := private.accounting_lock_draft(v_company, p_voucher_id, p_row_version);
begin
  delete from public.accounting_voucher_lines where id = p_line_id and voucher_id = v.id;
  if not found then
    raise exception 'Voucher line not found.' using errcode = 'P0002';
  end if;
  -- Keep line numbers consecutive (through a temporary offset: a voucher has at most 500 lines).
  update public.accounting_voucher_lines x set line_no = n.rn + 5000
    from (select id, row_number() over (order by line_no) as rn from public.accounting_voucher_lines where voucher_id = v.id) n where x.id = n.id;
  update public.accounting_voucher_lines set line_no = line_no - 5000 where voucher_id = v.id;
  update public.accounting_vouchers set row_version = row_version + 1, updated_by = auth.uid(), updated_at = now() where id = v.id;
  return private.accounting_voucher_json(v.id) || jsonb_build_object('issues', private.accounting_voucher_issues(v.id));
end;
$$;

create or replace function public.accounting_accounts(p_search text default null, p_include_inactive boolean default false)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_any_permission(array['accounts.read', 'vouchers.read', 'accounting_reports.read']);
  v_term    text := nullif(btrim(coalesce(p_search, '')), '');
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', a.id, 'account_code', a.account_code, 'account_name', a.account_name, 'group_name', g.group_name,
      'classification', a.classification, 'normal_balance', a.normal_balance, 'account_nature', a.account_nature, 'is_postable', a.is_postable,
      'allow_manual_posting', a.allow_manual_posting, 'requires_party', a.requires_party, 'is_system', a.is_system, 'is_active', a.is_active,
      'balance', coalesce((select sum(l.debit - l.credit) from public.accounting_voucher_lines l join public.accounting_vouchers v on v.id = l.voucher_id
                           where l.account_id = a.id and v.status in ('POSTED', 'REVERSED')), 0))
      order by a.account_code)
    from public.accounts a join public.account_groups g on g.id = a.group_id
    where a.company_id = v_company and (p_include_inactive or a.is_active)
      and (v_term is null or a.account_code ilike '%' || v_term || '%' or a.account_name ilike '%' || v_term || '%' or g.group_name ilike '%' || v_term || '%')),
    '[]'::jsonb);
end;
$$;

create or replace function public.accounting_chart()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_any_permission(array['accounts.read', 'vouchers.read', 'accounting_reports.read']);
begin
  return jsonb_build_object(
    'groups', coalesce((select jsonb_agg(jsonb_build_object('id', g.id, 'group_code', g.group_code, 'group_name', g.group_name,
        'parent_group_id', g.parent_group_id, 'classification', g.classification, 'normal_balance', g.normal_balance, 'is_system', g.is_system,
        'is_active', g.is_active, 'sort_order', g.sort_order, 'description', g.description) order by g.sort_order, g.group_code)
      from public.account_groups g where g.company_id = v_company), '[]'::jsonb),
    'accounts', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'account_code', a.account_code, 'account_name', a.account_name,
        'group_id', a.group_id, 'group_name', g.group_name, 'classification', a.classification, 'normal_balance', a.normal_balance,
        'account_nature', a.account_nature, 'is_postable', a.is_postable, 'allow_manual_posting', a.allow_manual_posting,
        'requires_party', a.requires_party, 'is_control', a.is_control, 'is_system', a.is_system, 'system_key', a.system_key,
        'is_active', a.is_active, 'description', a.description, 'balance', coalesce(b.balance, 0), 'line_count', coalesce(b.n, 0))
        order by a.account_code)
      from public.accounts a
      join public.account_groups g on g.id = a.group_id
      left join (select l.account_id, sum(l.debit - l.credit) as balance, count(*) as n
                 from public.accounting_voucher_lines l join public.accounting_vouchers v on v.id = l.voucher_id
                 where v.company_id = v_company and v.status in ('POSTED', 'REVERSED') group by l.account_id) b on b.account_id = a.id
      where a.company_id = v_company), '[]'::jsonb));
end;
$$;

create or replace function public.accounting_voucher_list(p_filters jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_any_permission(array['vouchers.read', 'accounting_reports.read']);
  f         jsonb := coalesce(p_filters, '{}'::jsonb);
  v_from    date := private.accounting_date(f, 'from', 'From date');
  v_to      date := private.accounting_date(f, 'to', 'To date');
  v_status  text := upper(nullif(f ->> 'status', ''));
  v_type    text := upper(nullif(f ->> 'voucher_type', ''));
  v_source  text := upper(nullif(f ->> 'source', ''));
  v_term    text := nullif(btrim(coalesce(f ->> 'search', '')), '');
  v_account uuid := private.accounting_uuid(f, 'account_id', 'Account');
  v_creator uuid := private.accounting_uuid(f, 'created_by', 'Created by');
  v_limit   int := least(greatest(coalesce((f ->> 'limit')::int, 200), 1), 1000);
  v_offset  int := greatest(coalesce((f ->> 'offset')::int, 0), 0);
begin
  return (
    with base as (
      select v.*, t.type_code, t.type_name,
        (select coalesce(sum(debit), 0) from public.accounting_voucher_lines where voucher_id = v.id) as dr,
        (select coalesce(sum(credit), 0) from public.accounting_voucher_lines where voucher_id = v.id) as cr
      from public.accounting_vouchers v join public.accounting_voucher_types t on t.id = v.voucher_type_id
      where v.company_id = v_company
        and (v_from is null or v.voucher_date >= v_from) and (v_to is null or v.voucher_date <= v_to)
        and (v_status is null or v.status = v_status) and (v_type is null or t.type_code = v_type) and (v_source is null or v.source = v_source)
        and (v_creator is null or v.created_by = v_creator)
        and (v_account is null or exists (select 1 from public.accounting_voucher_lines l where l.voucher_id = v.id and l.account_id = v_account))
        and (v_term is null or coalesce(v.voucher_number, '') ilike '%' || v_term || '%' or coalesce(v.reference_number, '') ilike '%' || v_term || '%'
             or coalesce(v.narration, '') ilike '%' || v_term || '%' or coalesce(v.source_number, '') ilike '%' || v_term || '%')
    )
    select jsonb_build_object('total', (select count(*) from base),
      'rows', coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'voucher_number', b.voucher_number, 'voucher_type', b.type_code,
          'voucher_type_name', b.type_name, 'voucher_date', b.voucher_date, 'reference_number', b.reference_number, 'narration', b.narration,
          'status', b.status, 'source', b.source, 'source_type', b.source_type, 'source_number', b.source_number, 'total_debit', b.dr,
          'total_credit', b.cr, 'reversal_of_voucher_id', b.reversal_of_voucher_id,
          'created_by', b.created_by, 'created_by_name', (select full_name from public.profiles where id = b.created_by), 'created_at', b.created_at,
          'posted_at', b.posted_at) order by b.voucher_date desc, b.created_at desc)
        from (select * from base order by voucher_date desc, created_at desc limit v_limit offset v_offset) b), '[]'::jsonb)));
end;
$$;

create or replace function public.accounting_cost_centres()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_any_permission(array['accounts.read', 'vouchers.read', 'accounting_reports.read']);
begin
  return coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'cost_centre_code', c.cost_centre_code, 'cost_centre_name', c.cost_centre_name,
      'description', c.description, 'parent_cost_centre_id', c.parent_cost_centre_id, 'is_active', c.is_active, 'updated_at', c.updated_at)
      order by c.cost_centre_code)
    from public.accounting_cost_centres c where c.company_id = v_company), '[]'::jsonb);
end;
$$;

create or replace function public.accounting_cost_centre_save(p_cost_centre_id uuid, p_cost_centre jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('accounts.manage');
  v_code    text := upper(private.accounting_text(p_cost_centre, 'cost_centre_code', 20, 'Cost centre code'));
  v_name    text := private.accounting_text(p_cost_centre, 'cost_centre_name', 120, 'Cost centre name');
  v_desc    text := private.accounting_text(p_cost_centre, 'description', 500, 'Description');
  v_parent  uuid := private.accounting_uuid(p_cost_centre, 'parent_cost_centre_id', 'Parent cost centre');
  v_active  boolean := coalesce((p_cost_centre ->> 'is_active')::boolean, true);
  v_id      uuid := p_cost_centre_id;
begin
  perform private.accounting_require_setup(v_company);
  if v_name is null or length(v_name) < 2 then
    raise exception 'The cost centre name is required (at least 2 characters).' using errcode = '22023';
  end if;
  if v_parent is not null and not exists (select 1 from public.accounting_cost_centres where id = v_parent and company_id = v_company) then
    raise exception 'The parent cost centre does not exist in this company.' using errcode = '42501';
  end if;
  if v_id is null then
    if v_code is null or v_code !~ '^[A-Z0-9][A-Z0-9_.-]{0,19}$' then
      raise exception 'The cost centre code is required: letters, digits, . _ - (up to 20).' using errcode = '22023';
    end if;
    insert into public.accounting_cost_centres (company_id, cost_centre_code, cost_centre_name, description, parent_cost_centre_id, is_active, created_by, updated_by)
    values (v_company, v_code, v_name, v_desc, v_parent, v_active, auth.uid(), auth.uid()) returning id into v_id;
  else
    if not exists (select 1 from public.accounting_cost_centres where id = v_id and company_id = v_company) then
      raise exception 'Cost centre not found.' using errcode = 'P0002';
    end if;
    if v_parent is not null and exists (
      with recursive up (id, parent_id) as (
        select c.id, c.parent_cost_centre_id from public.accounting_cost_centres c where c.id = v_parent
        union
        select c.id, c.parent_cost_centre_id from public.accounting_cost_centres c join up on c.id = up.parent_id
      ) select 1 from up where up.id = v_id) then
      raise exception 'A cost centre cannot be placed under itself or one of its own sub-centres.' using errcode = 'P0001';
    end if;
    update public.accounting_cost_centres set cost_centre_name = v_name, description = v_desc, parent_cost_centre_id = v_parent, is_active = v_active,
      updated_by = auth.uid(), updated_at = now() where id = v_id;
  end if;
  perform private.write_audit_log(v_company, case when p_cost_centre_id is null then 'accounting.cost_centre.created' else 'accounting.cost_centre.updated' end,
    'accounting_cost_centre', v_id::text, jsonb_build_object('name', v_name, 'is_active', v_active));
  return jsonb_build_object('id', v_id);
exception
  when unique_violation then
    raise exception 'A cost centre with this code already exists.' using errcode = '23505';
end;
$$;

create or replace function public.accounting_general_ledger(p_account_id uuid, p_from date, p_to date, p_party_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('accounting_reports.read');
  v_a       public.accounts;
  v_opening numeric;
begin
  perform private.accounting_require_setup(v_company);
  select * into v_a from public.accounts where id = p_account_id and company_id = v_company;
  if not found then
    raise exception 'Ledger account not found.' using errcode = 'P0002';
  end if;
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'Enter a valid date range.' using errcode = '22023';
  end if;
  select coalesce(sum(l.debit - l.credit), 0) into v_opening
  from public.accounting_voucher_lines l join public.accounting_vouchers v on v.id = l.voucher_id
  where l.account_id = v_a.id and v.status in ('POSTED', 'REVERSED') and v.voucher_date < p_from and (p_party_id is null or l.party_id = p_party_id);
  return jsonb_build_object('account', jsonb_build_object('id', v_a.id, 'account_code', v_a.account_code, 'account_name', v_a.account_name,
      'normal_balance', v_a.normal_balance, 'classification', v_a.classification, 'requires_party', v_a.requires_party),
    'from', p_from, 'to', p_to, 'opening_balance', v_opening,
    'entries', coalesce((select jsonb_agg(jsonb_build_object('voucher_id', e.voucher_id, 'voucher_number', e.voucher_number, 'voucher_date', e.voucher_date,
        'voucher_type', e.type_code, 'status', e.status, 'narration', coalesce(e.line_narration, e.narration), 'reference_number', e.reference_number,
        'source_type', e.source_type, 'source_number', e.source_number, 'party_id', e.party_id,
        'party_name', case when e.party_id is not null then private.accounting_party_name(e.party_id) end,
        'debit', e.debit, 'credit', e.credit, 'balance', v_opening + e.running) order by e.voucher_date, e.posted_at, e.line_no)
      from (select v.id as voucher_id, v.voucher_number, v.voucher_date, v.posted_at, v.status, v.narration, v.reference_number, v.source_type, v.source_number,
                   t.type_code, l.line_no, l.line_narration, l.party_id, l.debit, l.credit,
                   sum(l.debit - l.credit) over (order by v.voucher_date, v.posted_at, v.id, l.line_no) as running
            from public.accounting_voucher_lines l join public.accounting_vouchers v on v.id = l.voucher_id
            join public.accounting_voucher_types t on t.id = v.voucher_type_id
            where l.account_id = v_a.id and v.status in ('POSTED', 'REVERSED') and v.voucher_date between p_from and p_to
              and (p_party_id is null or l.party_id = p_party_id)) e), '[]'::jsonb),
    'closing_balance', v_opening + coalesce((select sum(l.debit - l.credit) from public.accounting_voucher_lines l join public.accounting_vouchers v on v.id = l.voucher_id
       where l.account_id = v_a.id and v.status in ('POSTED', 'REVERSED') and v.voucher_date between p_from and p_to
         and (p_party_id is null or l.party_id = p_party_id)), 0));
end;
$$;

create or replace function public.accounting_day_book(p_from date, p_to date, p_voucher_type text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('accounting_reports.read');
begin
  perform private.accounting_require_setup(v_company);
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'Enter a valid date range.' using errcode = '22023';
  end if;
  if p_to - p_from > 400 then
    raise exception 'The day book covers at most 400 days at a time.' using errcode = '22023';
  end if;
  return jsonb_build_object('from', p_from, 'to', p_to,
    'vouchers', coalesce((select jsonb_agg(private.accounting_voucher_json(v.id) order by v.voucher_date, v.posted_at)
      from public.accounting_vouchers v join public.accounting_voucher_types t on t.id = v.voucher_type_id
      where v.company_id = v_company and v.status in ('POSTED', 'REVERSED') and v.voucher_date between p_from and p_to
        and (p_voucher_type is null or t.type_code = upper(p_voucher_type))), '[]'::jsonb),
    'totals', (select jsonb_build_object('debit', coalesce(sum(l.debit), 0), 'credit', coalesce(sum(l.credit), 0), 'vouchers', count(distinct v.id))
      from public.accounting_vouchers v join public.accounting_voucher_lines l on l.voucher_id = v.id
      join public.accounting_voucher_types t on t.id = v.voucher_type_id
      where v.company_id = v_company and v.status in ('POSTED', 'REVERSED') and v.voucher_date between p_from and p_to
        and (p_voucher_type is null or t.type_code = upper(p_voucher_type))));
end;
$$;

revoke all on function public.accounting_general_ledger(uuid, date, date, uuid) from public, anon, service_role;
grant execute on function public.accounting_general_ledger(uuid, date, date, uuid) to authenticated;
revoke all on function public.accounting_day_book(date, date, text) from public, anon, service_role;
grant execute on function public.accounting_day_book(date, date, text) to authenticated;

drop table if exists public.accounting_budget_history;
drop table if exists public.accounting_budget_lines;
drop table if exists public.accounting_budgets;
drop table if exists public.accounting_cost_allocations;
drop function if exists private.accounting_allocation_issues(uuid);
drop function if exists private.accounting_insert_allocations(uuid, uuid, jsonb);
drop function if exists private.accounting_insert_line_allocations(uuid, uuid, uuid, jsonb, text);
drop function if exists private.accounting_line_allocations_json(uuid);
drop function if exists private.accounting_cost_centre_usable(uuid, date);
drop function if exists private.accounting_allocation_guard();
drop function if exists private.accounting_budget_guard();
drop trigger if exists accounts_cost_centre_policy_default on public.accounts;
drop function if exists private.accounting_account_cc_policy_default();

alter table public.accounting_voucher_lines drop constraint if exists accounting_voucher_lines_id_voucher_company_unique;
alter table public.accounts drop constraint if exists accounts_cost_centre_policy_check;
alter table public.accounts drop column if exists cost_centre_policy;
alter table public.accounting_cost_centres drop constraint if exists accounting_cost_centres_type_check;
alter table public.accounting_cost_centres drop constraint if exists accounting_cost_centres_effective_check;
alter table public.accounting_cost_centres drop column if exists cost_centre_type;
alter table public.accounting_cost_centres drop column if exists effective_from;
alter table public.accounting_cost_centres drop column if exists effective_to;

delete from public.role_permissions where permission_id in (select id from public.permissions where resource = 'accounting_budgets');
delete from public.permissions where resource = 'accounting_budgets';

-- ERP reset list as 20261231090000 left it.
create or replace function private.erp_reset_tables()
returns table (ord int, table_name text, category text, label text)
language sql
stable
set search_path = ''
as $$
  select * from (values
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
