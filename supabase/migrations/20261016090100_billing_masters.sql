-- =============================================================================
-- Phase 8: billing master data
--
--   customers (extended)      billing identity used by invoices: legal name,
--                             GSTIN, registration type, addresses, state codes,
--                             payment terms. Snapshotted onto each invoice.
--   gst_state_code()          GST state / UT codes (verify against the current
--                             official list before production use)
--   invoice_settings          one row per company: numbering, financial year,
--                             tax and billing policy, terms, bank and footer
--   billing_number_sequences  transactional counters for official numbers
--   billing_events            append-only history of every billing action
--
-- The company's legal name, registered address, state and GSTIN stay in
-- public.companies (Company Settings). Nothing here is seeded with company data.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Customers: billing fields
-- -----------------------------------------------------------------------------
alter table public.customers add column if not exists legal_name text;
alter table public.customers add column if not exists gstin text;
alter table public.customers add column if not exists gst_registration_type text;
alter table public.customers add column if not exists pan text;
alter table public.customers add column if not exists billing_address text;
alter table public.customers add column if not exists billing_state_code text;
alter table public.customers add column if not exists shipping_address text;
alter table public.customers add column if not exists shipping_state_code text;
alter table public.customers add column if not exists payment_terms_days integer;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'customers_billing_check') then
    alter table public.customers add constraint customers_billing_check check (
      (legal_name is null or length(btrim(legal_name)) between 1 and 200)
      and (gstin is null or gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$')
      and (gst_registration_type is null or gst_registration_type in ('REGISTERED', 'COMPOSITION', 'UNREGISTERED', 'CONSUMER', 'SEZ', 'OVERSEAS'))
      and (gst_registration_type not in ('REGISTERED', 'COMPOSITION', 'SEZ') or gstin is not null)
      and (pan is null or pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$')
      and (billing_address is null or length(billing_address) <= 1000)
      and (shipping_address is null or length(shipping_address) <= 1000)
      and (billing_state_code is null or billing_state_code ~ '^[0-9]{2}$')
      and (shipping_state_code is null or shipping_state_code ~ '^[0-9]{2}$')
      and (payment_terms_days is null or payment_terms_days between 0 and 365));
  end if;
end;
$$;

comment on column public.customers.gst_registration_type is 'REGISTERED / COMPOSITION / SEZ need a GSTIN. UNREGISTERED, CONSUMER (B2C) and OVERSEAS do not. Used for tax validation and review flags; it does not decide tax treatment on its own.';

create or replace function private.before_customer_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.customer_code := upper(btrim(new.customer_code));
  new.customer_name := btrim(regexp_replace(new.customer_name, '\s+', ' ', 'g'));
  new.contact_email := nullif(lower(btrim(coalesce(new.contact_email, ''))), '');
  new.notes := nullif(btrim(coalesce(new.notes, '')), '');
  new.legal_name := nullif(btrim(regexp_replace(coalesce(new.legal_name, ''), '\s+', ' ', 'g')), '');
  new.gstin := nullif(upper(btrim(coalesce(new.gstin, ''))), '');
  new.pan := nullif(upper(btrim(coalesce(new.pan, ''))), '');
  new.billing_address := nullif(btrim(coalesce(new.billing_address, '')), '');
  new.shipping_address := nullif(btrim(coalesce(new.shipping_address, '')), '');
  new.billing_state_code := nullif(btrim(coalesce(new.billing_state_code, '')), '');
  new.shipping_state_code := nullif(btrim(coalesce(new.shipping_state_code, '')), '');
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
  else
    new.created_by := old.created_by;
    new.company_id := old.company_id;
    new.customer_code := old.customer_code;
  end if;
  new.updated_by := auth.uid();
  return new;
end;
$$;

revoke all on function private.before_customer_write() from public, anon, authenticated;

grant insert (legal_name, gstin, gst_registration_type, pan, billing_address, billing_state_code, shipping_address, shipping_state_code, payment_terms_days)
  on public.customers to authenticated;
grant update (legal_name, gstin, gst_registration_type, pan, billing_address, billing_state_code, shipping_address, shipping_state_code, payment_terms_days)
  on public.customers to authenticated;

-- Billing users need to read customers.
drop policy if exists customers_select on public.customers;
create policy customers_select on public.customers for select to authenticated
  using (private.has_permission(company_id, 'customers.read') or private.has_permission(company_id, 'customer_po.read')
         or private.has_permission(company_id, 'invoices.read') or private.has_permission(company_id, 'payments.read'));

-- -----------------------------------------------------------------------------
-- GST state / UT codes
-- -----------------------------------------------------------------------------
create or replace function private.gst_state_name(p_code text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_code
    when '01' then 'Jammu and Kashmir' when '02' then 'Himachal Pradesh' when '03' then 'Punjab' when '04' then 'Chandigarh'
    when '05' then 'Uttarakhand' when '06' then 'Haryana' when '07' then 'Delhi' when '08' then 'Rajasthan' when '09' then 'Uttar Pradesh'
    when '10' then 'Bihar' when '11' then 'Sikkim' when '12' then 'Arunachal Pradesh' when '13' then 'Nagaland' when '14' then 'Manipur'
    when '15' then 'Mizoram' when '16' then 'Tripura' when '17' then 'Meghalaya' when '18' then 'Assam' when '19' then 'West Bengal'
    when '20' then 'Jharkhand' when '21' then 'Odisha' when '22' then 'Chhattisgarh' when '23' then 'Madhya Pradesh' when '24' then 'Gujarat'
    when '26' then 'Dadra and Nagar Haveli and Daman and Diu' when '27' then 'Maharashtra' when '29' then 'Karnataka' when '30' then 'Goa'
    when '31' then 'Lakshadweep' when '32' then 'Kerala' when '33' then 'Tamil Nadu' when '34' then 'Puducherry'
    when '35' then 'Andaman and Nicobar Islands' when '36' then 'Telangana' when '37' then 'Andhra Pradesh' when '38' then 'Ladakh'
    when '97' then 'Other Territory' when '96' then 'Other Country (outside India)'
  end;
$$;

revoke all on function private.gst_state_name(text) from public, anon;
grant execute on function private.gst_state_name(text) to authenticated;

create or replace function public.gst_state_codes()
returns table (code text, name text)
language sql
stable
set search_path = ''
as $$
  select c, private.gst_state_name(c)
  from unnest(array['01','02','03','04','05','06','07','08','09','10','11','12','13','14','15','16','17','18','19','20','21','22','23','24',
                    '26','27','29','30','31','32','33','34','35','36','37','38','97','96']) c;
$$;

revoke all on function public.gst_state_codes() from public, anon;
grant execute on function public.gst_state_codes() to authenticated;

-- -----------------------------------------------------------------------------
-- Invoice settings (one row per company; defaults are safe, nothing invented)
-- -----------------------------------------------------------------------------
create table if not exists public.invoice_settings (
  company_id                    uuid primary key references public.companies (id) on delete restrict,
  gst_registered                boolean not null default true,
  seller_pan                    text check (seller_pan is null or seller_pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
  invoice_prefix                text not null default 'INV' check (invoice_prefix ~ '^[A-Z0-9-]{1,8}$'),
  credit_note_prefix            text not null default 'CN' check (credit_note_prefix ~ '^[A-Z0-9-]{1,8}$'),
  debit_note_prefix             text not null default 'DN' check (debit_note_prefix ~ '^[A-Z0-9-]{1,8}$'),
  receipt_prefix                text not null default 'RCT' check (receipt_prefix ~ '^[A-Z0-9-]{1,8}$'),
  include_fy_in_number          boolean not null default true,
  number_padding                integer not null default 4 check (number_padding between 3 and 8),
  fy_start_month                integer not null default 4 check (fy_start_month between 1 and 12),
  default_payment_terms_days    integer not null default 30 check (default_payment_terms_days between 0 and 365),
  billing_basis                 text not null default 'DISPATCH' check (billing_basis in ('DISPATCH', 'DELIVERY')),
  allow_partial_dispatch_invoicing boolean not null default false,
  allow_line_discount           boolean not null default false,
  require_approval              boolean not null default false,
  round_off_enabled             boolean not null default false,
  other_charge_enabled          boolean not null default false,
  other_charge_label            text check (other_charge_label is null or length(other_charge_label) <= 60),
  other_charge_sac              text check (other_charge_sac is null or other_charge_sac ~ '^([0-9]{4}|[0-9]{6}|[0-9]{8})$'),
  other_charge_gst_rate         numeric(5,2) check (other_charge_gst_rate is null or other_charge_gst_rate between 0 and 100),
  allowed_special_categories    text[] not null default '{}' check (allowed_special_categories <@ array['EXEMPT', 'ZERO_RATED', 'NON_GST']),
  payment_methods               text[] not null default array['BANK_TRANSFER', 'UPI', 'CHEQUE', 'CASH'],
  terms_text                    text check (terms_text is null or length(terms_text) <= 2000),
  footer_text                   text check (footer_text is null or length(footer_text) <= 1000),
  bank_account_name             text check (bank_account_name is null or length(bank_account_name) <= 120),
  bank_name                     text check (bank_name is null or length(bank_name) <= 120),
  bank_account_number           text check (bank_account_number is null or bank_account_number ~ '^[0-9A-Z]{6,34}$'),
  bank_ifsc                     text check (bank_ifsc is null or bank_ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
  bank_branch                   text check (bank_branch is null or length(bank_branch) <= 120),
  show_bank_details             boolean not null default false,
  e_invoice_status              text not null default 'NOT_CONFIGURED' check (e_invoice_status in ('NOT_CONFIGURED')),
  updated_by                    uuid,
  updated_at                    timestamptz not null default now(),
  constraint invoice_settings_other_charge check (not other_charge_enabled
    or (other_charge_label is not null and other_charge_sac is not null and other_charge_gst_rate is not null)),
  constraint invoice_settings_bank check (not show_bank_details or (bank_account_name is not null and bank_account_number is not null and bank_ifsc is not null))
);

comment on column public.invoice_settings.e_invoice_status is 'No e-invoice / IRN integration is configured. Only NOT_CONFIGURED is allowed until a verified integration exists.';

alter table public.invoice_settings enable row level security;
revoke all on table public.invoice_settings from anon, authenticated;
grant select on public.invoice_settings to authenticated;
grant all on table public.invoice_settings to service_role;
drop policy if exists invoice_settings_select on public.invoice_settings;
create policy invoice_settings_select on public.invoice_settings for select to authenticated
  using (private.has_permission(company_id, 'invoices.read') or private.has_permission(company_id, 'payments.read')
         or private.has_permission(company_id, 'billing_settings.manage'));

create or replace function private.billing_settings(p_company uuid)
returns public.invoice_settings
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.invoice_settings;
begin
  insert into public.invoice_settings (company_id) values (p_company) on conflict do nothing;
  select * into v from public.invoice_settings where company_id = p_company;
  return v;
end;
$$;

revoke all on function private.billing_settings(uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Financial year and official numbering
-- -----------------------------------------------------------------------------
-- Financial year label ('2026-27') of a date for a start month (4 = April-March).
create or replace function private.financial_year(p_date date, p_start_month integer)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when p_start_month = 1 then extract(year from p_date)::int::text
    else (case when extract(month from p_date) >= p_start_month then extract(year from p_date)::int else extract(year from p_date)::int - 1 end)::text
         || '-' || lpad(((case when extract(month from p_date) >= p_start_month then extract(year from p_date)::int else extract(year from p_date)::int - 1 end + 1) % 100)::text, 2, '0')
  end;
$$;

revoke all on function private.financial_year(date, integer) from public, anon;
grant execute on function private.financial_year(date, integer) to authenticated;

create table if not exists public.billing_number_sequences (
  company_id uuid not null references public.companies (id) on delete restrict,
  scope      text not null check (length(scope) between 1 and 80),
  last_value bigint not null default 0,
  primary key (company_id, scope)
);

alter table public.billing_number_sequences enable row level security;
revoke all on table public.billing_number_sequences from anon, authenticated;
grant all on table public.billing_number_sequences to service_role;

-- Formats a number for a document type without consuming it.
create or replace function private.format_billing_number(p_settings public.invoice_settings, p_doc text, p_fy text, p_seq bigint)
returns text
language sql
immutable
set search_path = ''
as $$
  select (case p_doc when 'INVOICE' then p_settings.invoice_prefix when 'CREDIT_NOTE' then p_settings.credit_note_prefix
                     when 'DEBIT_NOTE' then p_settings.debit_note_prefix else p_settings.receipt_prefix end)
    || '/' || case when p_settings.include_fy_in_number then substr(p_fy, 3, 2) || '-' || right(p_fy, 2) || '/' else '' end
    || lpad(p_seq::text, p_settings.number_padding, '0');
$$;

revoke all on function private.format_billing_number(public.invoice_settings, text, text, bigint) from public, anon, authenticated;

-- Consumes the next official number atomically (the upsert row-locks the
-- counter). Numbers are never reused, including after cancellation.
create or replace function private.next_billing_number(p_company uuid, p_doc text, p_date date)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_s     public.invoice_settings := private.billing_settings(p_company);
  v_fy    text := private.financial_year(p_date, v_s.fy_start_month);
  v_pref  text := case p_doc when 'INVOICE' then v_s.invoice_prefix when 'CREDIT_NOTE' then v_s.credit_note_prefix
                             when 'DEBIT_NOTE' then v_s.debit_note_prefix else v_s.receipt_prefix end;
  v_scope text := p_doc || ':' || v_pref || case when v_s.include_fy_in_number then ':' || v_fy else '' end;
  v_next  bigint;
begin
  insert into public.billing_number_sequences (company_id, scope, last_value) values (p_company, v_scope, 1)
  on conflict (company_id, scope) do update set last_value = public.billing_number_sequences.last_value + 1
  returning last_value into v_next;
  return jsonb_build_object('number', private.format_billing_number(v_s, p_doc, v_fy, v_next), 'scope', v_scope, 'financial_year', v_fy);
end;
$$;

revoke all on function private.next_billing_number(uuid, text, date) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Billing history (append-only)
-- -----------------------------------------------------------------------------
create table if not exists public.billing_events (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies (id) on delete restrict,
  entity_type   text not null check (entity_type in ('INVOICE', 'PAYMENT', 'ALLOCATION', 'NOTE', 'SETTINGS')),
  entity_id     uuid,
  invoice_id    uuid,
  event_type    text not null,
  from_status   text,
  to_status     text,
  note          text,
  details       jsonb not null default '{}'::jsonb,
  actor_user_id uuid,
  created_at    timestamptz not null default now()
);

create index if not exists billing_events_entity_idx on public.billing_events (entity_id, created_at);
create index if not exists billing_events_invoice_idx on public.billing_events (invoice_id, created_at);
create index if not exists billing_events_date_idx on public.billing_events (company_id, created_at desc);

drop trigger if exists billing_events_append_only on public.billing_events;
create trigger billing_events_append_only before update or delete on public.billing_events
  for each row execute function private.prevent_history_mutation();

alter table public.billing_events enable row level security;
revoke all on table public.billing_events from anon, authenticated;
grant select on public.billing_events to authenticated;
grant all on table public.billing_events to service_role;
drop policy if exists billing_events_select on public.billing_events;
create policy billing_events_select on public.billing_events for select to authenticated
  using (private.has_permission(company_id, 'invoices.read') or private.has_permission(company_id, 'payments.read'));

create or replace function private.log_billing_event(
  p_company uuid, p_entity text, p_entity_id uuid, p_invoice uuid, p_event text, p_from text, p_to text, p_note text, p_details jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.billing_events (company_id, entity_type, entity_id, invoice_id, event_type, from_status, to_status, note, details, actor_user_id)
  values (p_company, p_entity, p_entity_id, p_invoice, p_event, p_from, p_to, nullif(btrim(coalesce(p_note, '')), ''), coalesce(p_details, '{}'::jsonb), auth.uid());
  perform private.write_audit_log(p_company, 'billing.' || lower(p_entity) || '.' || lower(p_event), lower(p_entity), p_entity_id::text,
    coalesce(p_details, '{}'::jsonb) || jsonb_build_object('invoice_id', p_invoice, 'from_status', p_from, 'to_status', p_to, 'note', p_note));
end;
$$;

revoke all on function private.log_billing_event(uuid, text, uuid, uuid, text, text, text, text, jsonb) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Settings RPCs
-- -----------------------------------------------------------------------------
create or replace function public.billing_settings_get()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_any_permission(array['invoices.read', 'payments.read', 'billing_settings.manage']);
  v_s       public.invoice_settings := private.billing_settings(v_company);
  v_c       public.companies;
  v_today   date := private.company_today(v_company);
  v_fy      text;
begin
  select * into v_c from public.companies where id = v_company;
  v_fy := private.financial_year(v_today, v_s.fy_start_month);
  return to_jsonb(v_s) || jsonb_build_object(
    'company', jsonb_build_object('legal_name', v_c.legal_name, 'legal_address', v_c.legal_address, 'state', v_c.state, 'gstin', v_c.gstin,
      'state_code', left(v_c.gstin, 2), 'state_name', private.gst_state_name(left(v_c.gstin, 2)), 'currency_code', v_c.currency_code),
    'current_financial_year', v_fy,
    'example_invoice_number', private.format_billing_number(v_s, 'INVOICE', v_fy, 1),
    'example_credit_note_number', private.format_billing_number(v_s, 'CREDIT_NOTE', v_fy, 1),
    'example_receipt_number', private.format_billing_number(v_s, 'RECEIPT', v_fy, 1));
end;
$$;

-- p_changes: any invoice_settings field except company_id / e_invoice_status / audit fields.
create or replace function public.billing_settings_update(p_changes jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('billing_settings.manage');
  v_old     public.invoice_settings := private.billing_settings(v_company);
  v_new     public.invoice_settings;
  v_key     text;
  v_fy      text;
begin
  if p_changes is null or jsonb_typeof(p_changes) <> 'object' then
    raise exception 'Nothing to change.' using errcode = 'P0001';
  end if;
  for v_key in select jsonb_object_keys(p_changes) loop
    if v_key in ('company_id', 'e_invoice_status', 'updated_by', 'updated_at') then
      raise exception 'Setting % cannot be changed here.', v_key using errcode = 'P0001';
    end if;
  end loop;
  begin
    v_new := jsonb_populate_record(v_old, p_changes);
  exception when others then
    raise exception 'Invalid setting value: %', sqlerrm using errcode = 'P0001';
  end;
  v_new.seller_pan := nullif(upper(btrim(coalesce(v_new.seller_pan, ''))), '');
  v_new.invoice_prefix := upper(btrim(v_new.invoice_prefix));
  v_new.credit_note_prefix := upper(btrim(v_new.credit_note_prefix));
  v_new.debit_note_prefix := upper(btrim(v_new.debit_note_prefix));
  v_new.receipt_prefix := upper(btrim(v_new.receipt_prefix));
  v_new.bank_ifsc := nullif(upper(btrim(coalesce(v_new.bank_ifsc, ''))), '');
  v_new.bank_account_number := nullif(upper(regexp_replace(coalesce(v_new.bank_account_number, ''), '\s', '', 'g')), '');
  v_fy := private.financial_year(private.company_today(v_company), v_new.fy_start_month);
  -- GST invoice and note numbers are limited to 16 characters.
  if length(private.format_billing_number(v_new, 'INVOICE', v_fy, 1)) > 16 or length(private.format_billing_number(v_new, 'CREDIT_NOTE', v_fy, 1)) > 16
     or length(private.format_billing_number(v_new, 'DEBIT_NOTE', v_fy, 1)) > 16 then
    raise exception 'Invoice / note numbers would exceed 16 characters (e.g. %). Shorten the prefix or padding.', private.format_billing_number(v_new, 'INVOICE', v_fy, 1)
      using errcode = 'P0001';
  end if;
  update public.invoice_settings set
    gst_registered = v_new.gst_registered, seller_pan = v_new.seller_pan, invoice_prefix = v_new.invoice_prefix, credit_note_prefix = v_new.credit_note_prefix,
    debit_note_prefix = v_new.debit_note_prefix, receipt_prefix = v_new.receipt_prefix, include_fy_in_number = v_new.include_fy_in_number,
    number_padding = v_new.number_padding, fy_start_month = v_new.fy_start_month, default_payment_terms_days = v_new.default_payment_terms_days,
    billing_basis = v_new.billing_basis, allow_partial_dispatch_invoicing = v_new.allow_partial_dispatch_invoicing, allow_line_discount = v_new.allow_line_discount,
    require_approval = v_new.require_approval, round_off_enabled = v_new.round_off_enabled, other_charge_enabled = v_new.other_charge_enabled,
    other_charge_label = v_new.other_charge_label, other_charge_sac = v_new.other_charge_sac, other_charge_gst_rate = v_new.other_charge_gst_rate,
    allowed_special_categories = v_new.allowed_special_categories, payment_methods = v_new.payment_methods, terms_text = v_new.terms_text,
    footer_text = v_new.footer_text, bank_account_name = v_new.bank_account_name, bank_name = v_new.bank_name, bank_account_number = v_new.bank_account_number,
    bank_ifsc = v_new.bank_ifsc, bank_branch = v_new.bank_branch, show_bank_details = v_new.show_bank_details, updated_by = auth.uid(), updated_at = now()
  where company_id = v_company;
  if cardinality(v_new.payment_methods) = 0 or not (v_new.payment_methods <@ array['BANK_TRANSFER', 'UPI', 'CHEQUE', 'CASH', 'CARD', 'DEMAND_DRAFT', 'OTHER']) then
    raise exception 'Choose at least one payment method from the supported list.' using errcode = 'P0001';
  end if;
  perform private.log_billing_event(v_company, 'SETTINGS', null, null, 'UPDATED', null, null, null, jsonb_build_object('changes', p_changes));
  return public.billing_settings_get();
end;
$$;

revoke all on function public.billing_settings_get() from public, anon;
grant execute on function public.billing_settings_get() to authenticated;
revoke all on function public.billing_settings_update(jsonb) from public, anon;
grant execute on function public.billing_settings_update(jsonb) to authenticated;
