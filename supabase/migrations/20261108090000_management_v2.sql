-- =============================================================================
-- ALTON ERP V2 — Stage 7: management overview, module dashboards, ERP settings,
-- global search, activity centre, reconciliation and the reporting centre.
--
-- No new tables. Everything reads the existing records:
--   settings      companies (new profile columns) + company_settings (key/value)
--                 + invoice_settings (financial year, invoicing)
--   numbering     inventory_number_sequences via private.next_document_number /
--                 private.next_product_sku (prefixes now configurable)
--   figures       stock ledger, balances and reservations, purchase orders and
--                 goods receipts, production orders / output / consumption,
--                 sales orders and fulfilments, invoices, notes and receipts,
--                 supplier payments, parties (opening balances)
-- Existing dashboards (production_dashboard, sales_dashboard, invoice_dashboard,
-- purchase_order_dashboard) are reused, not re-implemented.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Company profile
-- -----------------------------------------------------------------------------
alter table public.companies add column if not exists pan text;
alter table public.companies add column if not exists cin text;
alter table public.companies add column if not exists phone text;
alter table public.companies add column if not exists email text;
alter table public.companies add column if not exists website text;
alter table public.companies add column if not exists logo_data_url text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'companies_profile_v2_check') then
    alter table public.companies add constraint companies_profile_v2_check check (
      (pan is null or pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$')
      and (cin is null or cin ~ '^[A-Z0-9]{21}$')
      and (phone is null or length(phone) <= 30)
      and (email is null or (length(email) <= 200 and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'))
      and (website is null or length(website) <= 200)
      and (logo_data_url is null or (length(logo_data_url) <= 400000 and logo_data_url ~ '^data:image/(png|jpeg|webp|svg\+xml);base64,')));
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- 2. ERP settings (company_settings keys with defaults)
-- -----------------------------------------------------------------------------
create or replace function private.erp_setting_defaults()
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'general.date_format', 'DD MMM YYYY',
    'numbering.po_prefix', 'PO',
    'numbering.grn_prefix', 'GRN',
    'numbering.production_prefix', 'PRD',
    'numbering.sales_order_prefix', 'SO',
    'product.auto_sku', true,
    'product.sku_prefixes', jsonb_build_object('FINISHED_GOOD', 'FG', 'RAW_MATERIAL', 'RM', 'COMPONENT', 'CMP', 'SUBASSEMBLY', 'SUB',
      'OUTSOURCED_COMPONENT', 'OSC', 'PACKAGING_MATERIAL', 'PKG', 'CONSUMABLE', 'CON', 'OTHER', 'ITM'),
    'product.units', jsonb_build_array('PCS', 'NOS', 'SET', 'PAIR', 'BOX', 'KG', 'G', 'LTR', 'ML', 'MTR', 'SQM'),
    'product.default_gst_rate', 18,
    'product.hsn_codes', '[]'::jsonb,
    'inventory.adjustment_reasons', jsonb_build_array('Damaged', 'Count correction', 'Expired', 'Sample issued', 'Found in stock', 'Other'),
    'purchase.default_payment_terms', 'DAYS_30',
    'purchase.default_delivery_terms', null,
    'production.default_wastage_percent', 0,
    'production.consumption_prefill', 'STANDARD',
    'sales.default_payment_terms', null,
    'sales.default_delivery_instructions', null,
    'sales.default_warehouse_id', null,
    'import.date_order', 'DMY');
$$;

create or replace function private.erp_settings_of(p_company uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select private.erp_setting_defaults()
    || coalesce((select jsonb_object_agg(s.setting_key, s.setting_value) from public.company_settings s
                 where s.company_id = p_company and private.erp_setting_defaults() ? s.setting_key), '{}'::jsonb);
$$;

create or replace function private.erp_setting(p_company uuid, p_key text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select s.setting_value from public.company_settings s where s.company_id = p_company and s.setting_key = p_key),
                  private.erp_setting_defaults() -> p_key);
$$;

revoke all on function private.erp_setting_defaults() from public, anon, authenticated;
revoke all on function private.erp_settings_of(uuid) from public, anon, authenticated;
revoke all on function private.erp_setting(uuid, text) from public, anon, authenticated;

-- Document numbers: the counter stays keyed by the document type (so changing
-- a prefix never restarts or reuses numbers); only the printed prefix changes.
create or replace function private.next_document_number(p_company uuid, p_prefix text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_next    bigint;
  v_display text := p_prefix;
begin
  if p_prefix in ('PO', 'GRN', 'PRD', 'SO') then
    v_display := coalesce(private.erp_setting(p_company, case p_prefix when 'PO' then 'numbering.po_prefix' when 'GRN' then 'numbering.grn_prefix'
      when 'PRD' then 'numbering.production_prefix' else 'numbering.sales_order_prefix' end) #>> '{}', p_prefix);
  end if;
  insert into public.inventory_number_sequences (company_id, prefix, last_value)
  values (p_company, p_prefix, 1)
  on conflict (company_id, prefix) do update set last_value = public.inventory_number_sequences.last_value + 1
  returning last_value into v_next;
  return v_display || '-' || lpad(v_next::text, 6, '0');
end;
$$;

revoke all on function private.next_document_number(uuid, text) from public, anon, authenticated;

alter table public.purchase_orders drop constraint if exists purchase_orders_po_number_check;
alter table public.goods_receipts drop constraint if exists goods_receipts_receipt_number_check;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'purchase_orders_po_number_v2') then
    alter table public.purchase_orders add constraint purchase_orders_po_number_v2 check (po_number ~ '^[A-Z]{2,5}-[0-9]{6,}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'goods_receipts_receipt_number_v2') then
    alter table public.goods_receipts add constraint goods_receipts_receipt_number_v2 check (receipt_number ~ '^[A-Z]{2,5}-[0-9]{6,}$');
  end if;
end;
$$;

-- Automatic SKUs: prefix per product type from settings; can be switched off.
create or replace function private.next_product_sku(p_company uuid, p_type text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prefix text := coalesce(private.erp_setting(p_company, 'product.sku_prefixes') ->> p_type, private.product_sku_prefix(p_type));
  v_key    text := left('SKU' || private.product_sku_prefix(p_type), 5);
  v_next   bigint;
  v_sku    text;
begin
  if coalesce((private.erp_setting(p_company, 'product.auto_sku') #>> '{}')::boolean, true) = false then
    raise exception 'Enter the SKU: automatic SKU numbering is switched off in ERP Settings.' using errcode = 'P0001';
  end if;
  loop
    insert into public.inventory_number_sequences (company_id, prefix, last_value)
    values (p_company, v_key, 1)
    on conflict (company_id, prefix) do update set last_value = public.inventory_number_sequences.last_value + 1
    returning last_value into v_next;
    v_sku := v_prefix || '-' || lpad(v_next::text, 6, '0');
    exit when not exists (select 1 from public.products where company_id = p_company and lower(sku) = lower(v_sku));
  end loop;
  return v_sku;
end;
$$;

revoke all on function private.next_product_sku(uuid, text) from public, anon, authenticated;

-- Preferences any signed-in user of the company needs for forms and dates.
create or replace function public.erp_preferences()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.current_company_id();
  v jsonb;
begin
  if v_company is null then
    raise exception 'No active company.' using errcode = '42501';
  end if;
  v := private.erp_settings_of(v_company);
  return v || jsonb_build_object('company.logo_data_url', (select logo_data_url from public.companies where id = v_company));
end;
$$;

create or replace function public.erp_settings_get()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('settings.manage');
  v_c       public.companies;
  v_inv     public.invoice_settings := private.billing_settings(v_company);
begin
  select * into v_c from public.companies where id = v_company;
  return jsonb_build_object(
    'company', jsonb_build_object('id', v_c.id, 'legal_name', v_c.legal_name, 'display_name', v_c.display_name, 'company_code', v_c.company_code,
      'legal_address', v_c.legal_address, 'state', v_c.state, 'country', v_c.country, 'gstin', v_c.gstin, 'state_code', left(v_c.gstin, 2),
      'state_name', private.gst_state_name(left(v_c.gstin, 2)), 'pan', v_c.pan, 'cin', v_c.cin, 'phone', v_c.phone, 'email', v_c.email,
      'website', v_c.website, 'currency_code', v_c.currency_code, 'timezone', v_c.timezone, 'logo_data_url', v_c.logo_data_url,
      'fy_start_month', v_inv.fy_start_month, 'current_financial_year', private.financial_year(private.company_today(v_company), v_inv.fy_start_month)),
    'settings', private.erp_settings_of(v_company),
    'defaults', private.erp_setting_defaults(),
    'counters', coalesce((select jsonb_object_agg(prefix, last_value) from public.inventory_number_sequences
                          where company_id = v_company and prefix in ('PO', 'GRN', 'PRD', 'SO')), '{}'::jsonb),
    'warehouses', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'code', warehouse_code, 'name', warehouse_name, 'is_default', is_default) order by warehouse_code)
                            from public.warehouses where company_id = v_company and status = 'ACTIVE'), '[]'::jsonb));
end;
$$;

-- p_company: any of legal_name, display_name, legal_address, state, country, gstin, pan, cin, phone, email,
--            website, currency_code, logo_data_url, fy_start_month
-- p_settings: {key: value} for the keys in private.erp_setting_defaults()
create or replace function public.erp_settings_save(p_company jsonb, p_settings jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('settings.manage');
  v_c       jsonb := coalesce(p_company, '{}'::jsonb);
  v_s       jsonb := coalesce(p_settings, '{}'::jsonb);
  v_key     text;
  v_val     jsonb;
  v_t       text;
  v_e       jsonb;
  v_prefixes text[];
  v_allowed text[] := array['legal_name', 'display_name', 'legal_address', 'state', 'country', 'gstin', 'pan', 'cin', 'phone', 'email', 'website',
                            'currency_code', 'logo_data_url', 'fy_start_month'];
  v_txt     text;
begin
  if jsonb_typeof(v_c) <> 'object' or jsonb_typeof(v_s) <> 'object' then
    raise exception 'Settings must be sent as objects.' using errcode = 'P0001';
  end if;
  for v_key in select jsonb_object_keys(v_c) loop
    if not v_key = any(v_allowed) then
      raise exception 'Company field % cannot be changed here.', v_key using errcode = 'P0001';
    end if;
  end loop;
  for v_key in select jsonb_object_keys(v_s) loop
    if not private.erp_setting_defaults() ? v_key then
      raise exception 'Unknown setting %.', v_key using errcode = 'P0001';
    end if;
  end loop;

  -- Settings validation
  for v_key, v_val in select key, value from jsonb_each(v_s) loop
    v_t := jsonb_typeof(v_val);
    v_txt := case when v_t = 'string' then btrim(v_val #>> '{}') end;
    if v_key = 'general.date_format' and coalesce(v_txt, '') not in ('DD-MM-YYYY', 'DD/MM/YYYY', 'DD MMM YYYY', 'YYYY-MM-DD') then
      raise exception 'Date format must be DD-MM-YYYY, DD/MM/YYYY, DD MMM YYYY or YYYY-MM-DD.' using errcode = 'P0001';
    elsif v_key like 'numbering.%' and coalesce(v_txt, '') !~ '^[A-Z]{2,5}$' then
      raise exception 'Number prefixes are 2 to 5 capital letters (e.g. PO).' using errcode = 'P0001';
    elsif v_key = 'product.auto_sku' and v_t <> 'boolean' then
      raise exception 'Automatic SKU numbering is on or off.' using errcode = 'P0001';
    elsif v_key = 'product.sku_prefixes' and (v_t <> 'object' or exists (select 1 from jsonb_each(v_val) e
          where e.key not in ('FINISHED_GOOD', 'RAW_MATERIAL', 'COMPONENT', 'SUBASSEMBLY', 'OUTSOURCED_COMPONENT', 'PACKAGING_MATERIAL', 'CONSUMABLE', 'OTHER')
             or jsonb_typeof(e.value) <> 'string' or (e.value #>> '{}') !~ '^[A-Z]{2,4}$')) then
      raise exception 'SKU prefixes are 2 to 4 capital letters per product type.' using errcode = 'P0001';
    elsif v_key = 'product.units' and (v_t <> 'array' or jsonb_array_length(v_val) not between 1 and 50
          or exists (select 1 from jsonb_array_elements(v_val) e where jsonb_typeof(e) <> 'string' or (e #>> '{}') !~ '^[A-Z]{1,10}$')) then
      raise exception 'Units are 1 to 50 codes of capital letters (e.g. PCS, KG).' using errcode = 'P0001';
    elsif v_key in ('product.default_gst_rate', 'production.default_wastage_percent')
          and (v_t <> 'number' or (v_val #>> '{}')::numeric not between 0 and 100) then
      raise exception '% must be a number from 0 to 100.', case when v_key like 'product%' then 'The default GST rate' else 'The default wastage %' end using errcode = 'P0001';
    elsif v_key = 'product.hsn_codes' and (v_t <> 'array' or jsonb_array_length(v_val) > 300 or exists (select 1 from jsonb_array_elements(v_val) e
          where coalesce(e ->> 'code', '') !~ '^([0-9]{4}|[0-9]{6}|[0-9]{8})$' or length(coalesce(e ->> 'description', '')) > 120
             or (e ? 'gst_rate' and e ->> 'gst_rate' is not null and (jsonb_typeof(e -> 'gst_rate') <> 'number' or (e ->> 'gst_rate')::numeric not between 0 and 100)))) then
      raise exception 'HSN codes need 4, 6 or 8 digits (with an optional description and GST rate).' using errcode = 'P0001';
    elsif v_key = 'inventory.adjustment_reasons' and (v_t <> 'array' or jsonb_array_length(v_val) not between 1 and 40
          or exists (select 1 from jsonb_array_elements(v_val) e where jsonb_typeof(e) <> 'string' or length(btrim(e #>> '{}')) not between 1 and 80)) then
      raise exception 'Adjustment reasons: 1 to 40 reasons of up to 80 characters.' using errcode = 'P0001';
    elsif v_key = 'purchase.default_payment_terms' and coalesce(v_txt, '') not in ('IMMEDIATE', 'DAYS_7', 'DAYS_15', 'DAYS_30', 'DAYS_45') then
      raise exception 'Default purchase payment terms: immediate, 7, 15, 30 or 45 days.' using errcode = 'P0001';
    elsif v_key in ('purchase.default_delivery_terms', 'sales.default_payment_terms', 'sales.default_delivery_instructions')
          and not (v_t = 'null' or (v_t = 'string' and length(v_txt) <= 500)) then
      raise exception 'Default terms are text of up to 500 characters.' using errcode = 'P0001';
    elsif v_key = 'production.consumption_prefill' and coalesce(v_txt, '') not in ('STANDARD', 'BLANK') then
      raise exception 'Material consumption is pre-filled with the BOM standard or left blank.' using errcode = 'P0001';
    elsif v_key = 'sales.default_warehouse_id' and v_t <> 'null' and not exists (
          select 1 from public.warehouses where company_id = v_company and status = 'ACTIVE' and id::text = v_txt) then
      raise exception 'Choose an active warehouse of your company.' using errcode = 'P0001';
    elsif v_key = 'import.date_order' and coalesce(v_txt, '') not in ('DMY', 'MDY') then
      raise exception 'Import dates are read day-month-year or month-day-year.' using errcode = 'P0001';
    end if;
  end loop;
  select array_agg(coalesce(v_s ->> k, private.erp_setting(v_company, k) #>> '{}')) into v_prefixes
  from unnest(array['numbering.po_prefix', 'numbering.grn_prefix', 'numbering.production_prefix', 'numbering.sales_order_prefix']) k;
  if (select count(distinct x) from unnest(v_prefixes) x) < 4 then
    raise exception 'Purchase order, goods receipt, production and sales order prefixes must all be different.' using errcode = 'P0001';
  end if;

  -- Company validation and update
  if v_c <> '{}'::jsonb then
    if v_c ? 'legal_name' and length(btrim(coalesce(v_c ->> 'legal_name', ''))) not between 2 and 200 then
      raise exception 'The company name needs 2 to 200 characters.' using errcode = 'P0001';
    end if;
    if v_c ? 'gstin' and nullif(upper(btrim(coalesce(v_c ->> 'gstin', ''))), '') !~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$' then
      raise exception 'The GSTIN is not valid (15 characters, e.g. 27AAACA1234A1Z5).' using errcode = 'P0001';
    end if;
    if v_c ? 'fy_start_month' and coalesce((v_c ->> 'fy_start_month')::int, 0) not between 1 and 12 then
      raise exception 'The financial year starts in a month from 1 to 12.' using errcode = 'P0001';
    end if;
    if v_c ? 'currency_code' and coalesce(v_c ->> 'currency_code', '') !~ '^[A-Z]{3}$' then
      raise exception 'Currency is a 3-letter code (e.g. INR).' using errcode = 'P0001';
    end if;
    begin
      update public.companies set
        legal_name = case when v_c ? 'legal_name' then btrim(v_c ->> 'legal_name') else legal_name end,
        display_name = case when v_c ? 'display_name' then coalesce(nullif(btrim(coalesce(v_c ->> 'display_name', '')), ''), legal_name) else display_name end,
        legal_address = case when v_c ? 'legal_address' then nullif(btrim(coalesce(v_c ->> 'legal_address', '')), '') else legal_address end,
        state = case when v_c ? 'state' then nullif(btrim(coalesce(v_c ->> 'state', '')), '') else state end,
        country = case when v_c ? 'country' then nullif(btrim(coalesce(v_c ->> 'country', '')), '') else country end,
        gstin = case when v_c ? 'gstin' then nullif(upper(btrim(coalesce(v_c ->> 'gstin', ''))), '') else gstin end,
        pan = case when v_c ? 'pan' then nullif(upper(btrim(coalesce(v_c ->> 'pan', ''))), '') else pan end,
        cin = case when v_c ? 'cin' then nullif(upper(btrim(coalesce(v_c ->> 'cin', ''))), '') else cin end,
        phone = case when v_c ? 'phone' then nullif(btrim(coalesce(v_c ->> 'phone', '')), '') else phone end,
        email = case when v_c ? 'email' then nullif(lower(btrim(coalesce(v_c ->> 'email', ''))), '') else email end,
        website = case when v_c ? 'website' then nullif(btrim(coalesce(v_c ->> 'website', '')), '') else website end,
        currency_code = case when v_c ? 'currency_code' then v_c ->> 'currency_code' else currency_code end,
        logo_data_url = case when v_c ? 'logo_data_url' then nullif(v_c ->> 'logo_data_url', '') else logo_data_url end
      where id = v_company;
    exception
      when unique_violation then
        raise exception 'That GSTIN is already used by another company.' using errcode = 'P0001';
      when check_violation then
        raise exception 'Check the company details: PAN (ABCDE1234F), CIN (21 characters), e-mail, and a PNG/JPEG/WebP/SVG logo under about 300 KB.' using errcode = 'P0001';
    end;
    if v_c ? 'fy_start_month' then
      perform private.billing_settings(v_company);
      update public.invoice_settings set fy_start_month = (v_c ->> 'fy_start_month')::int, updated_by = auth.uid(), updated_at = now() where company_id = v_company;
    end if;
  end if;

  for v_key, v_val in select key, value from jsonb_each(v_s) loop
    insert into public.company_settings (company_id, setting_key, setting_value)
    values (v_company, v_key, case when jsonb_typeof(v_val) = 'string' then to_jsonb(btrim(v_val #>> '{}')) else v_val end)
    on conflict (company_id, setting_key) do update set setting_value = excluded.setting_value;
  end loop;
  perform private.write_audit_log(v_company, 'settings.erp_updated', 'company_settings', v_company::text,
    jsonb_build_object('company_fields', (select coalesce(jsonb_agg(k), '[]'::jsonb) from jsonb_object_keys(v_c - 'logo_data_url') k)
      || case when v_c ? 'logo_data_url' then '["logo"]'::jsonb else '[]'::jsonb end, 'settings', v_s));
  return public.erp_settings_get();
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. Shared figures
-- -----------------------------------------------------------------------------
-- Quantities per unit as [{unit, quantity}] (units are never added together).
create or replace function private.units_json(p_rows jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('unit', unit, 'quantity', q) order by unit), '[]'::jsonb)
  from (select r ->> 'unit' as unit, sum((r ->> 'quantity')::numeric) as q from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
        group by r ->> 'unit' having sum((r ->> 'quantity')::numeric) <> 0) x;
$$;

revoke all on function private.units_json(jsonb) from public, anon, authenticated;

-- Customer and supplier balances (ledger definitions of Stage 2, opening balances included).
create or replace function private.party_balances(p_company uuid)
returns table (party_id uuid, party_code text, party_name text, customer_id uuid, supplier_id uuid,
  receivable numeric, payable numeric, invoice_outstanding numeric, overdue numeric)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, p.party_code, coalesce(c.customer_name, s.display_name, s.legal_name), p.customer_id, p.supplier_id,
    case when p.is_customer and p.customer_id is not null then round(private.customer_receivable(p.customer_id)
      + case when p.opening_balance_type = 'RECEIVABLE' then coalesce(p.opening_balance, 0) else 0 end, 2) else 0 end,
    case when p.is_supplier and p.supplier_id is not null then round(private.supplier_payable(p.supplier_id)
      + case when p.opening_balance_type = 'PAYABLE' then coalesce(p.opening_balance, 0) else 0 end, 2) else 0 end,
    coalesce((select sum(greatest(private.invoice_balance(i.id), 0)) from public.sales_invoices i where i.customer_id = p.customer_id and i.status = 'ISSUED'), 0),
    coalesce((select sum(greatest(private.invoice_balance(i.id), 0)) from public.sales_invoices i where i.customer_id = p.customer_id and i.status = 'ISSUED'
              and i.due_date < private.company_today(p_company)), 0)
  from public.parties p
  left join public.customers c on c.id = p.customer_id
  left join public.suppliers s on s.id = p.supplier_id
  where p.company_id = p_company;
$$;

revoke all on function private.party_balances(uuid) from public, anon, authenticated;

-- Stock on hand per lot with its cost (weighted-average receipt cost of the lot).
create or replace function private.stock_lots(p_company uuid)
returns table (product_id uuid, product_type text, unit text, warehouse_id uuid, stock_usage text, on_hand numeric, reserved numeric, cost numeric)
language sql
stable
security definer
set search_path = ''
as $$
  select b.product_id, p.product_type, p.base_unit, b.warehouse_id, l.stock_usage, b.on_hand, b.reserved, private.lot_average_cost(b.batch_id)
  from public.inventory_balances b
  join public.products p on p.id = b.product_id
  join public.inventory_locations l on l.id = b.location_id
  where b.company_id = p_company and b.on_hand > 0 and p.archived_at is null;
$$;

revoke all on function private.stock_lots(uuid) from public, anon, authenticated;

-- Runs a section and turns a permission or data error into {available:false}.
create or replace function private.safe_section(p_sql text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v jsonb;
begin
  execute p_sql into v;
  return coalesce(v, '{}'::jsonb) || jsonb_build_object('available', true);
exception when others then
  return jsonb_build_object('available', false, 'reason', sqlerrm);
end;
$$;

revoke all on function private.safe_section(text) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 4. Alerts (each links to the record or module)
-- -----------------------------------------------------------------------------
create or replace function private.management_alerts(p_company uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_today date := private.company_today(p_company);
  v_out   jsonb := '[]'::jsonb;
  v_items jsonb;
  v_n     bigint;
begin
  -- helper pattern: count + up to 6 items
  -- Low stock / out of stock
  select count(*), coalesce(jsonb_agg(x) filter (where rn <= 6), '[]'::jsonb) into v_n, v_items from (
    select jsonb_build_object('label', s.sku || ' — ' || s.product_name, 'detail', 'Available ' || trim_scale(s.available) || ' ' || s.base_unit
      || coalesce(' · reorder at ' || trim_scale(s.reorder_level), ''), 'link', '/inventory/stock/' || s.product_id) as x, row_number() over (order by s.available) rn
    from public.inventory_product_stock s where s.company_id = p_company and s.archived_at is null and s.product_status = 'ACTIVE' and s.stock_status = 'LOW_STOCK') z;
  v_out := v_out || jsonb_build_object('code', 'LOW_STOCK', 'title', 'Low stock', 'severity', 'WARNING', 'count', v_n, 'link', '/inventory/alerts', 'items', v_items);
  select count(*), coalesce(jsonb_agg(x) filter (where rn <= 6), '[]'::jsonb) into v_n, v_items from (
    select jsonb_build_object('label', s.sku || ' — ' || s.product_name, 'detail', 'No stock' || coalesce(' · reorder at ' || trim_scale(s.reorder_level), ''),
      'link', '/inventory/stock/' || s.product_id) as x, row_number() over (order by s.sku) rn
    from public.inventory_product_stock s where s.company_id = p_company and s.archived_at is null and s.product_status = 'ACTIVE'
      and s.stock_status = 'OUT_OF_STOCK' and s.has_history) z;
  v_out := v_out || jsonb_build_object('code', 'OUT_OF_STOCK', 'title', 'Out of stock', 'severity', 'CRITICAL', 'count', v_n, 'link', '/inventory/alerts', 'items', v_items);

  -- Material shortages for open production orders (same rule as the production dashboard)
  select count(*), coalesce(jsonb_agg(x) filter (where rn <= 6), '[]'::jsonb) into v_n, v_items from (
    select jsonb_build_object('label', p.sku || ' — ' || p.product_name, 'detail', 'Short ' || trim_scale(n.needed - n.reserved - n.available) || ' ' || n.unit
      || ' for ' || n.orders || ' order(s)', 'link', '/inventory/stock/' || n.component_product_id) as x, row_number() over (order by p.sku) rn
    from (
      select g.*, (select coalesce(sum(s.available), 0) from unnest(g.warehouses) w cross join lateral private.storage_stock(p_company, g.component_product_id, w) s) as available
      from (
        select m.component_product_id, m.unit, sum(greatest(m.planned_quantity - m.issued_quantity, 0)) as needed,
          sum(private.order_open_reserved(o.id, m.component_product_id)) as reserved, count(distinct o.id) as orders,
          array_agg(distinct o.source_warehouse_id) as warehouses
        from public.production_order_materials m join public.production_orders o on o.id = m.production_order_id
        where o.company_id = p_company and o.status not in ('COMPLETED', 'CANCELLED')
        group by m.component_product_id, m.unit) g) n
    join public.products p on p.id = n.component_product_id
    where n.needed - n.reserved - n.available > 0) z;
  v_out := v_out || jsonb_build_object('code', 'MATERIAL_SHORTAGE', 'title', 'Material shortages', 'severity', 'CRITICAL', 'count', v_n, 'link', '/production', 'items', v_items);

  -- Production pending past its target date
  select count(*), coalesce(jsonb_agg(x) filter (where rn <= 6), '[]'::jsonb) into v_n, v_items from (
    select jsonb_build_object('label', o.production_order_number || ' — ' || p.sku, 'detail', 'Target ' || o.target_completion_date || ' · '
      || trim_scale(greatest(o.planned_quantity - o.actual_quantity, 0)) || ' ' || o.unit || ' pending', 'link', '/production/orders/' || o.id) as x,
      row_number() over (order by o.target_completion_date) rn
    from public.production_orders o join public.products p on p.id = o.finished_product_id
    where o.company_id = p_company and o.status not in ('COMPLETED', 'CANCELLED') and o.target_completion_date < v_today) z;
  v_out := v_out || jsonb_build_object('code', 'PRODUCTION_PENDING', 'title', 'Production past target date', 'severity', 'WARNING', 'count', v_n, 'link', '/production/orders', 'items', v_items);

  -- Purchase deliveries overdue
  select count(*), coalesce(jsonb_agg(x) filter (where rn <= 6), '[]'::jsonb) into v_n, v_items from (
    select jsonb_build_object('label', o.po_number || ' — ' || o.supplier_name, 'detail', 'Expected ' || o.expected_delivery_date, 'link', '/purchase-orders/' || o.id) as x,
      row_number() over (order by o.expected_delivery_date) rn
    from public.purchase_orders o where o.company_id = p_company and o.status in ('APPROVED', 'SENT', 'PARTIALLY_RECEIVED') and o.expected_delivery_date < v_today) z;
  v_out := v_out || jsonb_build_object('code', 'PURCHASE_OVERDUE', 'title', 'Purchase deliveries overdue', 'severity', 'WARNING', 'count', v_n, 'link', '/purchase-orders', 'items', v_items);

  -- Sales orders pending past their delivery date / ready but not dispatched
  select count(*), coalesce(jsonb_agg(x) filter (where rn <= 6), '[]'::jsonb) into v_n, v_items from (
    select jsonb_build_object('label', so.sales_order_number || ' — ' || so.customer_name_snapshot, 'detail', 'Delivery due ' || so.requested_delivery_date,
      'link', '/sales/orders/' || so.id) as x, row_number() over (order by so.requested_delivery_date) rn
    from public.sales_orders so where so.company_id = p_company and so.requested_delivery_date < v_today
      and private.so_v2_status(so.id) not in ('FULLY_DISPATCHED', 'CANCELLED', 'DRAFT')) z;
  v_out := v_out || jsonb_build_object('code', 'SALES_PENDING', 'title', 'Sales orders past delivery date', 'severity', 'WARNING', 'count', v_n, 'link', '/sales/orders', 'items', v_items);
  select count(*), coalesce(jsonb_agg(x) filter (where rn <= 6), '[]'::jsonb) into v_n, v_items from (
    select jsonb_build_object('label', so.sales_order_number || ' — ' || so.customer_name_snapshot, 'detail', 'Stock reserved, ready to dispatch',
      'link', '/sales/orders/' || so.id) as x, row_number() over (order by so.order_date) rn
    from public.sales_orders so where so.company_id = p_company and private.so_v2_status(so.id) = 'READY_FOR_DISPATCH') z;
  v_out := v_out || jsonb_build_object('code', 'DISPATCH_PENDING', 'title', 'Ready for dispatch', 'severity', 'INFO', 'count', v_n, 'link', '/sales/orders', 'items', v_items);

  -- Invoices overdue / customer and supplier payments pending
  select count(*), coalesce(jsonb_agg(x) filter (where rn <= 6), '[]'::jsonb) into v_n, v_items from (
    select jsonb_build_object('label', i.invoice_number || ' — ' || i.customer_legal_name, 'detail', i.days_overdue || ' days overdue · balance ' || i.balance_due,
      'link', '/billing/invoices/' || i.id) as x, row_number() over (order by i.days_overdue desc) rn
    from public.sales_invoice_list i where i.company_id = p_company and i.display_status = 'OVERDUE') z;
  v_out := v_out || jsonb_build_object('code', 'INVOICE_OVERDUE', 'title', 'Invoices overdue', 'severity', 'CRITICAL', 'count', v_n, 'link', '/billing/receivables', 'items', v_items);
  select count(*), coalesce(jsonb_agg(x) filter (where rn <= 6), '[]'::jsonb) into v_n, v_items from (
    select jsonb_build_object('label', b.party_name, 'detail', 'Receivable ' || b.receivable, 'link', '/ledger/' || b.party_id) as x,
      row_number() over (order by b.receivable desc) rn
    from private.party_balances(p_company) b where b.receivable > 0) z;
  v_out := v_out || jsonb_build_object('code', 'CUSTOMER_PAYMENT_PENDING', 'title', 'Customer payments pending', 'severity', 'INFO', 'count', v_n, 'link', '/ledger', 'items', v_items);
  select count(*), coalesce(jsonb_agg(x) filter (where rn <= 6), '[]'::jsonb) into v_n, v_items from (
    select jsonb_build_object('label', b.party_name, 'detail', 'Payable ' || b.payable, 'link', '/ledger/' || b.party_id) as x,
      row_number() over (order by b.payable desc) rn
    from private.party_balances(p_company) b where b.payable > 0) z;
  v_out := v_out || jsonb_build_object('code', 'SUPPLIER_PAYMENT_PENDING', 'title', 'Supplier payments pending', 'severity', 'INFO', 'count', v_n, 'link', '/ledger', 'items', v_items);

  -- Master data gaps
  select count(*), coalesce(jsonb_agg(x) filter (where rn <= 6), '[]'::jsonb) into v_n, v_items from (
    select jsonb_build_object('label', p.sku || ' — ' || p.product_name, 'detail', 'No approved BOM', 'link', '/products/' || p.id) as x,
      row_number() over (order by p.sku) rn
    from public.products p where p.company_id = p_company and p.archived_at is null and p.status = 'ACTIVE'
      and p.product_type in ('FINISHED_GOOD', 'SUBASSEMBLY') and p.default_source_type <> 'OUTSOURCED'
      and not exists (select 1 from public.boms b where b.finished_product_id = p.id and b.status = 'APPROVED')) z;
  v_out := v_out || jsonb_build_object('code', 'MISSING_BOM', 'title', 'Products without a BOM', 'severity', 'WARNING', 'count', v_n, 'link', '/production/boms', 'items', v_items);
  select count(*), coalesce(jsonb_agg(x) filter (where rn <= 6), '[]'::jsonb) into v_n, v_items from (
    select jsonb_build_object('label', p.sku || ' — ' || p.product_name, 'detail', 'Missing ' || array_to_string(array_remove(array[
        case when p.hsn_code is null then 'HSN' end, case when p.gst_rate is null then 'GST rate' end,
        case when p.product_type = 'FINISHED_GOOD' and p.selling_price is null then 'selling price' end,
        case when p.product_type <> 'FINISHED_GOOD' and p.standard_cost is null then 'cost' end], null), ', '),
      'link', '/products/' || p.id || '/edit') as x, row_number() over (order by p.sku) rn
    from public.products p where p.company_id = p_company and p.archived_at is null and p.status = 'ACTIVE'
      and (p.hsn_code is null or p.gst_rate is null or (p.product_type = 'FINISHED_GOOD' and p.selling_price is null)
           or (p.product_type <> 'FINISHED_GOOD' and p.standard_cost is null))) z;
  v_out := v_out || jsonb_build_object('code', 'MISSING_PRODUCT_INFO', 'title', 'Products with missing information', 'severity', 'INFO', 'count', v_n, 'link', '/products', 'items', v_items);
  return v_out;
end;
$$;

revoke all on function private.management_alerts(uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 5. Management overview
-- -----------------------------------------------------------------------------
create or replace function private.mo_inventory(p_company uuid, p_from date, p_to date)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with lots as (select * from private.stock_lots(p_company)),
  storage as (select * from lots where stock_usage = 'STORAGE'),
  incoming as (
    select l.unit, sum(l.pending_quantity) as q from public.purchase_order_line_list l join public.purchase_orders o on o.id = l.purchase_order_id
    where o.company_id = p_company and o.status in ('APPROVED', 'SENT', 'PARTIALLY_RECEIVED') and l.line_type = 'GOODS' and l.pending_quantity > 0 group by l.unit),
  tz as (select private.company_tz(p_company) as tz)
  select jsonb_build_object(
    'by_type', coalesce((select jsonb_agg(jsonb_build_object('product_type', product_type, 'unit', unit, 'on_hand', oh, 'reserved', rs, 'available', av,
        'value', val, 'uncosted_lots', unc) order by product_type, unit) from (
        select product_type, unit, sum(on_hand) oh, sum(reserved) rs, sum(on_hand - reserved) filter (where stock_usage = 'STORAGE') av,
          sum(round(on_hand * cost, 2)) filter (where cost is not null) val, count(*) filter (where cost is null) unc
        from lots group by product_type, unit) x), '[]'::jsonb),
    'finished_goods', private.units_json((select jsonb_agg(jsonb_build_object('unit', unit, 'quantity', on_hand)) from lots where product_type = 'FINISHED_GOOD')),
    'raw_materials', private.units_json((select jsonb_agg(jsonb_build_object('unit', unit, 'quantity', on_hand)) from lots where product_type = 'RAW_MATERIAL')),
    'components', private.units_json((select jsonb_agg(jsonb_build_object('unit', unit, 'quantity', on_hand)) from lots where product_type in ('COMPONENT', 'SUBASSEMBLY'))),
    'outsourced_components', private.units_json((select jsonb_agg(jsonb_build_object('unit', unit, 'quantity', on_hand)) from lots where product_type = 'OUTSOURCED_COMPONENT')),
    'physical', private.units_json((select jsonb_agg(jsonb_build_object('unit', unit, 'quantity', on_hand)) from lots)),
    'reserved', private.units_json((select jsonb_agg(jsonb_build_object('unit', unit, 'quantity', reserved)) from lots)),
    'available_stock', private.units_json((select jsonb_agg(jsonb_build_object('unit', unit, 'quantity', on_hand - reserved)) from storage)),
    'rejected', private.units_json((select jsonb_agg(jsonb_build_object('unit', unit, 'quantity', on_hand)) from lots where stock_usage = 'REJECTED')),
    'incoming', private.units_json((select jsonb_agg(jsonb_build_object('unit', unit, 'quantity', q)) from incoming)),
    'low_stock_items', (select count(*) from public.inventory_product_stock s where s.company_id = p_company and s.archived_at is null and s.product_status = 'ACTIVE' and s.stock_status = 'LOW_STOCK'),
    'out_of_stock_items', (select count(*) from public.inventory_product_stock s where s.company_id = p_company and s.archived_at is null and s.product_status = 'ACTIVE' and s.stock_status = 'OUT_OF_STOCK' and s.has_history),
    'total_value', (select sum(round(on_hand * cost, 2)) filter (where cost is not null) from lots),
    'finished_goods_value', (select sum(round(on_hand * cost, 2)) filter (where cost is not null) from lots where product_type = 'FINISHED_GOOD'),
    'raw_material_value', (select sum(round(on_hand * cost, 2)) filter (where cost is not null) from lots where product_type = 'RAW_MATERIAL'),
    'uncosted_lots', (select count(*) filter (where cost is null) from lots),
    'lots', (select count(*) from lots),
    'by_warehouse', coalesce((select jsonb_agg(jsonb_build_object('warehouse_code', w.warehouse_code, 'warehouse_name', w.warehouse_name, 'unit', x.unit,
        'on_hand', x.oh, 'reserved', x.rs, 'available', x.av) order by w.warehouse_code, x.unit) from (
        select warehouse_id, unit, sum(on_hand) oh, sum(reserved) rs, coalesce(sum(on_hand - reserved) filter (where stock_usage = 'STORAGE'), 0) av
        from lots group by warehouse_id, unit) x join public.warehouses w on w.id = x.warehouse_id), '[]'::jsonb),
    'low_stock', coalesce((select jsonb_agg(jsonb_build_object('product_id', product_id, 'sku', sku, 'product_name', product_name, 'unit', base_unit,
        'available', available, 'reorder_level', reorder_level, 'status', stock_status) order by available) from (
        select * from public.inventory_product_stock s where s.company_id = p_company and s.archived_at is null and s.product_status = 'ACTIVE'
          and (s.stock_status = 'LOW_STOCK' or (s.stock_status = 'OUT_OF_STOCK' and s.has_history)) order by s.available limit 10) x), '[]'::jsonb),
    'movement', coalesce((select jsonb_agg(jsonb_build_object('day', d, 'unit', unit, 'in', qin, 'out', qout) order by d, unit) from (
        select (t.transaction_date at time zone (select tz from tz))::date d, t.unit,
          sum(t.quantity) filter (where t.direction = 1) qin, sum(t.quantity) filter (where t.direction = -1) qout
        from public.inventory_transactions t where t.company_id = p_company and t.transaction_type not in ('TRANSFER_IN', 'TRANSFER_OUT')
          and (t.transaction_date at time zone (select tz from tz))::date between p_from and p_to
        group by 1, 2) x), '[]'::jsonb));
$$;

revoke all on function private.mo_inventory(uuid, date, date) from public, anon, authenticated;

create or replace function public.management_overview(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('dashboard.read');
  v_today   date := private.company_today(v_company);
  v_tz      text := private.company_tz(v_company);
  v_month0  date;
  v_alerts  jsonb;
  v_inv     jsonb;
  v_pur     jsonb;
  v_prod    jsonb;
  v_sales   jsonb;
  v_bill    jsonb;
  v_party   jsonb;
  v_q       text;
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 3700 then
    raise exception 'Choose a valid date range.' using errcode = 'P0001';
  end if;
  v_month0 := (date_trunc('month', p_to::timestamp) - interval '11 months')::date;
  v_q := quote_literal(p_from) || '::date, ' || quote_literal(p_to) || '::date';

  v_alerts := private.management_alerts(v_company);
  v_inv := case when private.has_permission(v_company, 'inventory.read') then private.mo_inventory(v_company, p_from, p_to) || jsonb_build_object('available', true,
             'production_shortages', (select (a ->> 'count')::int from jsonb_array_elements(v_alerts) a where a ->> 'code' = 'MATERIAL_SHORTAGE'))
           else jsonb_build_object('available', false, 'reason', 'No inventory access.') end;

  -- Purchase
  v_pur := case when private.has_permission(v_company, 'purchases.read') then
    private.safe_section('select public.purchase_order_dashboard(' || v_q || ')') || jsonb_build_object(
      'created', (select count(*) from public.purchase_orders where company_id = v_company and po_date between p_from and p_to),
      'partially_received', (select count(*) from public.purchase_orders where company_id = v_company and status = 'PARTIALLY_RECEIVED'),
      'completed', (select count(*) from public.purchase_orders where company_id = v_company and status in ('RECEIVED', 'CLOSED')),
      'received_value', (select coalesce(sum(private.goods_receipt_value(r.id)), 0) from public.goods_receipts r
                         where r.company_id = v_company and r.status = 'POSTED' and r.receipt_date between p_from and p_to),
      'receipts', (select count(*) from public.goods_receipts r where r.company_id = v_company and r.status = 'POSTED' and r.receipt_date between p_from and p_to),
      'by_supplier', coalesce((select jsonb_agg(jsonb_build_object('supplier', supplier_name, 'value', v, 'orders', n) order by v desc) from (
          select supplier_name, sum(grand_total) v, count(*) n from public.purchase_orders where company_id = v_company and po_date between p_from and p_to
            and status in ('APPROVED', 'SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED') group by supplier_name order by sum(grand_total) desc limit 10) x), '[]'::jsonb),
      'monthly', coalesce((select jsonb_agg(jsonb_build_object('month', m, 'ordered', o, 'received', r) order by m) from (
          select gs::date m,
            (select coalesce(sum(grand_total), 0) from public.purchase_orders where company_id = v_company and date_trunc('month', po_date::timestamp) = gs
               and status in ('APPROVED', 'SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED')) o,
            (select coalesce(sum(private.goods_receipt_value(r.id)), 0) from public.goods_receipts r where r.company_id = v_company and r.status = 'POSTED'
               and date_trunc('month', r.receipt_date::timestamp) = gs) r
          from generate_series(v_month0::timestamp, date_trunc('month', p_to::timestamp), interval '1 month') gs) x), '[]'::jsonb))
    else jsonb_build_object('available', false, 'reason', 'No purchase access.') end;

  -- Production
  v_prod := case when private.has_permission(v_company, 'manufacturing.read') then
    private.safe_section('select public.production_dashboard(' || v_q || ')') || jsonb_build_object(
      'total_orders', (select count(*) from public.production_orders where company_id = v_company and status <> 'CANCELLED'),
      'planned', private.units_json((select jsonb_agg(jsonb_build_object('unit', unit, 'quantity', planned_quantity)) from public.production_orders
                   where company_id = v_company and status <> 'CANCELLED' and planned_start_date between p_from and p_to)),
      'actual', private.units_json((select jsonb_agg(jsonb_build_object('unit', unit, 'quantity', good_quantity + rejected_quantity + scrap_quantity))
                   from public.production_output_receipts where company_id = v_company and status = 'POSTED' and production_date between p_from and p_to)),
      'daily', coalesce((select jsonb_agg(jsonb_build_object('day', production_date, 'unit', unit, 'good', g, 'rejected', r) order by production_date, unit) from (
          select production_date, unit, sum(good_quantity) g, sum(rejected_quantity + scrap_quantity) r from public.production_output_receipts
          where company_id = v_company and status = 'POSTED' and production_date between p_from and p_to group by 1, 2) x), '[]'::jsonb),
      'monthly', coalesce((select jsonb_agg(jsonb_build_object('month', m, 'unit', unit, 'good', g) order by m, unit) from (
          select date_trunc('month', production_date::timestamp)::date m, unit, sum(good_quantity) g from public.production_output_receipts
          where company_id = v_company and status = 'POSTED' and production_date >= v_month0 and production_date <= p_to group by 1, 2) x), '[]'::jsonb),
      'by_product', coalesce((select jsonb_agg(jsonb_build_object('product_id', p.id, 'sku', p.sku, 'product_name', p.product_name, 'unit', x.unit,
          'good', x.g, 'rejected', x.r, 'scrap', x.s, 'planned', x.planned,
          -- efficiency only where both planned and actual output exist
          'yield_percent', case when x.g + x.r + x.s > 0 then round(100 * x.g / (x.g + x.r + x.s), 1) end,
          'plan_percent', case when x.planned > 0 and x.g > 0 then round(100 * x.g / x.planned, 1) end) order by x.g desc) from (
          select r.product_id, r.unit, sum(r.good_quantity) g, sum(r.rejected_quantity) r, sum(r.scrap_quantity) s,
            (select sum(o.planned_quantity) from public.production_orders o where o.id in (select production_order_id from public.production_output_receipts r2
               where r2.product_id = r.product_id and r2.status = 'POSTED' and r2.production_date between p_from and p_to)) planned
          from public.production_output_receipts r where r.company_id = v_company and r.status = 'POSTED' and r.production_date between p_from and p_to
          group by r.product_id, r.unit) x join public.products p on p.id = x.product_id), '[]'::jsonb))
    else jsonb_build_object('available', false, 'reason', 'No production access.') end;

  -- Sales (order value; not revenue)
  v_sales := case when private.has_permission(v_company, 'sales_orders.read') then
    private.safe_section('select public.sales_dashboard(' || v_q || ', null, null)') || jsonb_build_object(
      'orders_requiring_production', (select count(*) from public.sales_orders so where so.company_id = v_company
                                       and private.so_v2_status(so.id) not in ('FULLY_DISPATCHED', 'CANCELLED', 'DRAFT')
                                       and exists (select 1 from public.sales_order_lines l where l.sales_order_id = so.id and private.so_v2_to_produce(l) > 0)),
      'orders_with_shortages', (select count(*) from public.sales_orders so where so.company_id = v_company
                                 and private.so_v2_status(so.id) not in ('FULLY_DISPATCHED', 'CANCELLED', 'DRAFT')
                                 and jsonb_array_length(coalesce(private.so_v2_shortages(so.id), '[]'::jsonb)) > 0),
      'dispatches', (select count(*) from public.fulfilments f where f.company_id = v_company and f.actual_dispatch_at is not null
                     and (f.actual_dispatch_at at time zone v_tz)::date between p_from and p_to),
      'dispatched', private.units_json((select jsonb_agg(jsonb_build_object('unit', p.base_unit, 'quantity', fl.quantity_dispatched))
                     from public.fulfilment_lines fl join public.fulfilments f on f.id = fl.fulfilment_id join public.products p on p.id = fl.product_id
                     where f.company_id = v_company and f.actual_dispatch_at is not null and fl.quantity_dispatched > 0
                       and (f.actual_dispatch_at at time zone v_tz)::date between p_from and p_to)),
      'daily', coalesce((select jsonb_agg(jsonb_build_object('day', order_date, 'value', v, 'orders', n) order by order_date) from (
          select order_date, sum(grand_total) v, count(*) n from public.sales_orders where company_id = v_company and order_date between p_from and p_to
            and order_status not in ('DRAFT', 'CANCELLED') group by order_date) x), '[]'::jsonb),
      'monthly', coalesce((select jsonb_agg(jsonb_build_object('month', m, 'value', v, 'orders', n) order by m) from (
          select gs::date m, (select coalesce(sum(grand_total), 0) from public.sales_orders where company_id = v_company and order_status not in ('DRAFT', 'CANCELLED')
                and date_trunc('month', order_date::timestamp) = gs) v,
            (select count(*) from public.sales_orders where company_id = v_company and order_status not in ('DRAFT', 'CANCELLED')
                and date_trunc('month', order_date::timestamp) = gs) n
          from generate_series(v_month0::timestamp, date_trunc('month', p_to::timestamp), interval '1 month') gs) x), '[]'::jsonb),
      'by_product', coalesce((select jsonb_agg(jsonb_build_object('sku', sku, 'product_name', name, 'unit', unit, 'ordered', q, 'value', v) order by v desc nulls last) from (
          select l.sku_snapshot sku, l.product_name_snapshot name, l.unit, sum(l.quantity_ordered - l.quantity_cancelled) q, sum(l.line_total) v
          from public.sales_order_lines l join public.sales_orders so on so.id = l.sales_order_id
          where so.company_id = v_company and so.order_date between p_from and p_to and so.order_status not in ('DRAFT', 'CANCELLED')
          group by 1, 2, 3 order by sum(l.line_total) desc nulls last limit 10) x), '[]'::jsonb),
      'by_customer', coalesce((select jsonb_agg(jsonb_build_object('customer', c, 'value', v, 'orders', n) order by v desc) from (
          select customer_name_snapshot c, sum(grand_total) v, count(*) n from public.sales_orders where company_id = v_company and order_date between p_from and p_to
            and order_status not in ('DRAFT', 'CANCELLED') group by 1 order by 2 desc limit 10) x), '[]'::jsonb))
    else jsonb_build_object('available', false, 'reason', 'No sales order access.') end;

  -- Invoicing (revenue) and collections
  v_bill := case when private.has_permission(v_company, 'invoices.read') then
    private.safe_section('select public.invoice_dashboard(' || v_q || ', null, null, null)') || jsonb_build_object(
      'customer_outstanding', coalesce((select jsonb_agg(jsonb_build_object('party_id', party_id, 'customer', party_name, 'outstanding', invoice_outstanding,
          'overdue', overdue, 'receivable', receivable) order by invoice_outstanding desc) from (
          select * from private.party_balances(v_company) where invoice_outstanding > 0 order by invoice_outstanding desc limit 10) x), '[]'::jsonb))
    else jsonb_build_object('available', false, 'reason', 'No invoice access.') end;

  select jsonb_build_object(
    'customer_outstanding', coalesce(sum(invoice_outstanding), 0),
    'receivables', coalesce(sum(greatest(receivable, 0)), 0),
    'customer_advances', coalesce(sum(greatest(-receivable, 0)), 0),
    'supplier_outstanding', coalesce(sum(greatest(case when supplier_id is not null then private.supplier_payable(supplier_id) else 0 end, 0)), 0),
    'payables', coalesce(sum(greatest(payable, 0)), 0))
  into v_party from private.party_balances(v_company);

  return jsonb_build_object(
    'from', p_from, 'to', p_to, 'today', v_today, 'generated_at', now(),
    'currency', (select currency_code from public.companies where id = v_company),
    'kpis', jsonb_build_object(
      'sales_invoiced', (select coalesce(sum(grand_total), 0) from public.sales_invoices where company_id = v_company and status = 'ISSUED' and invoice_date between p_from and p_to),
      'sales_order_value', (select coalesce(sum(grand_total), 0) from public.sales_orders where company_id = v_company and order_date between p_from and p_to
                              and order_status not in ('DRAFT', 'CANCELLED')),
      'purchase_received', (select coalesce(sum(private.goods_receipt_value(r.id)), 0) from public.goods_receipts r
                              where r.company_id = v_company and r.status = 'POSTED' and r.receipt_date between p_from and p_to),
      'purchase_ordered', (select coalesce(sum(grand_total), 0) from public.purchase_orders where company_id = v_company and po_date between p_from and p_to
                              and status in ('APPROVED', 'SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED')),
      'production', private.units_json((select jsonb_agg(jsonb_build_object('unit', unit, 'quantity', good_quantity)) from public.production_output_receipts
                      where company_id = v_company and status = 'POSTED' and production_date between p_from and p_to)),
      'inventory_value', v_inv -> 'total_value', 'finished_goods_value', v_inv -> 'finished_goods_value', 'raw_material_value', v_inv -> 'raw_material_value',
      'uncosted_lots', v_inv -> 'uncosted_lots',
      'invoices', (select count(*) from public.sales_invoices where company_id = v_company and status = 'ISSUED' and invoice_date between p_from and p_to),
      'receipts', (select coalesce(sum(amount_received), 0) from public.customer_payments where company_id = v_company and status = 'RECORDED'
                     and receipt_date between p_from and p_to),
      'receipt_count', (select count(*) from public.customer_payments where company_id = v_company and status = 'RECORDED' and receipt_date between p_from and p_to))
      || v_party,
    'inventory', v_inv, 'purchase', v_pur, 'production', v_prod, 'sales', v_sales, 'invoicing', v_bill,
    'alerts', v_alerts);
end;
$$;

-- -----------------------------------------------------------------------------
-- 6. Module dashboards not covered by Stages 4-6 (products, ledger, purchase, goods received)
-- -----------------------------------------------------------------------------
create or replace function public.module_dashboard(p_module text, p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid;
  v_today   date;
begin
  v_company := case upper(coalesce(p_module, ''))
    when 'PRODUCTS' then private.require_permission('products.read')
    when 'LEDGER' then private.require_permission('ledger.read')
    when 'PURCHASE' then private.require_permission('purchases.read')
    when 'GRN' then private.require_permission('purchases.read') end;
  if v_company is null then
    raise exception 'Unknown dashboard %.', p_module using errcode = 'P0001';
  end if;
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'Choose a valid date range.' using errcode = 'P0001';
  end if;
  v_today := private.company_today(v_company);
  if upper(p_module) = 'PRODUCTS' then
    return (with p as (select * from public.products where company_id = v_company and archived_at is null)
    select jsonb_build_object('module', 'PRODUCTS',
      'total', (select count(*) from p), 'active', (select count(*) from p where status = 'ACTIVE'),
      'finished_goods', (select count(*) from p where product_type = 'FINISHED_GOOD'),
      'raw_materials', (select count(*) from p where product_type = 'RAW_MATERIAL'),
      'components', (select count(*) from p where product_type in ('COMPONENT', 'SUBASSEMBLY')),
      'outsourced', (select count(*) from p where product_type = 'OUTSOURCED_COMPONENT' or default_source_type = 'OUTSOURCED'),
      'other', (select count(*) from p where product_type in ('PACKAGING_MATERIAL', 'CONSUMABLE', 'OTHER')),
      'without_bom', (select count(*) from p where status = 'ACTIVE' and product_type in ('FINISHED_GOOD', 'SUBASSEMBLY') and default_source_type <> 'OUTSOURCED'
                        and not exists (select 1 from public.boms b where b.finished_product_id = p.id and b.status = 'APPROVED')),
      'without_bom_list', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'sku', sku, 'product_name', product_name) order by sku) from (
          select * from p where status = 'ACTIVE' and product_type in ('FINISHED_GOOD', 'SUBASSEMBLY') and default_source_type <> 'OUTSOURCED'
            and not exists (select 1 from public.boms b where b.finished_product_id = p.id and b.status = 'APPROVED') order by sku limit 10) x), '[]'::jsonb),
      'added_in_period', (select count(*) from p where (created_at at time zone private.company_tz(v_company))::date between p_from and p_to),
      'recent', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'sku', sku, 'product_name', product_name, 'product_type', product_type, 'created_at', created_at)
          order by created_at desc) from (select * from p order by created_at desc limit 8) x), '[]'::jsonb),
      'low_stock', coalesce((select jsonb_agg(jsonb_build_object('product_id', product_id, 'sku', sku, 'product_name', product_name, 'unit', base_unit,
          'available', available, 'reorder_level', reorder_level, 'status', stock_status) order by available) from (
          select * from public.inventory_product_stock s where s.company_id = v_company and s.archived_at is null and s.product_status = 'ACTIVE'
            and (s.stock_status = 'LOW_STOCK' or (s.stock_status = 'OUT_OF_STOCK' and s.has_history)) order by available limit 10) x), '[]'::jsonb),
      'low_stock_count', (select count(*) from public.inventory_product_stock s where s.company_id = v_company and s.archived_at is null and s.product_status = 'ACTIVE'
            and (s.stock_status = 'LOW_STOCK' or (s.stock_status = 'OUT_OF_STOCK' and s.has_history))),
      'by_type', coalesce((select jsonb_object_agg(product_type, n) from (select product_type, count(*) n from p group by 1) x), '{}'::jsonb)) from (select 1) one);
  elsif upper(p_module) = 'LEDGER' then
    return (with b as (select pb.*, pt.is_customer, pt.is_supplier from private.party_balances(v_company) pb join public.parties pt on pt.id = pb.party_id)
    select jsonb_build_object('module', 'LEDGER',
      'customers', (select count(*) from b where is_customer), 'suppliers', (select count(*) from b where is_supplier),
      'both', (select count(*) from b where is_customer and is_supplier), 'parties', (select count(*) from b),
      'receivables', (select coalesce(sum(greatest(receivable, 0)), 0) from b), 'payables', (select coalesce(sum(greatest(payable, 0)), 0) from b),
      'customer_advances', (select coalesce(sum(greatest(-receivable, 0)), 0) from b),
      'with_balance', (select count(*) from b where receivable <> 0 or payable <> 0),
      'outstanding', coalesce((select jsonb_agg(jsonb_build_object('party_id', party_id, 'party_code', party_code, 'name', party_name, 'receivable', receivable, 'payable', payable)
          order by greatest(abs(receivable), abs(payable)) desc) from (select * from b where receivable <> 0 or payable <> 0
          order by greatest(abs(receivable), abs(payable)) desc limit 10) x), '[]'::jsonb),
      'top_customers', coalesce((select jsonb_agg(jsonb_build_object('party_id', b.party_id, 'name', b.party_name, 'invoiced', x.v) order by x.v desc) from (
          select customer_id, sum(grand_total) v from public.sales_invoices where company_id = v_company and status = 'ISSUED' and invoice_date between p_from and p_to
          group by customer_id order by 2 desc limit 8) x join b on b.customer_id = x.customer_id), '[]'::jsonb),
      'top_suppliers', coalesce((select jsonb_agg(jsonb_build_object('party_id', b.party_id, 'name', b.party_name, 'received', x.v) order by x.v desc) from (
          select supplier_id, sum(private.goods_receipt_value(id)) v from public.goods_receipts where company_id = v_company and status = 'POSTED'
            and supplier_id is not null and receipt_date between p_from and p_to group by supplier_id order by 2 desc limit 8) x join b on b.supplier_id = x.supplier_id), '[]'::jsonb))
    from (select 1) one);
  elsif upper(p_module) = 'PURCHASE' then
    return public.purchase_order_dashboard(p_from, p_to) || jsonb_build_object('module', 'PURCHASE',
      'partially_received', (select count(*) from public.purchase_orders where company_id = v_company and status = 'PARTIALLY_RECEIVED'),
      'fully_received', (select count(*) from public.purchase_orders where company_id = v_company and status in ('RECEIVED', 'CLOSED')),
      'overdue_list', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'po_number', po_number, 'supplier', supplier_name, 'expected', expected_delivery_date)
          order by expected_delivery_date) from (select * from public.purchase_orders where company_id = v_company and status in ('APPROVED', 'SENT', 'PARTIALLY_RECEIVED')
          and expected_delivery_date < v_today order by expected_delivery_date limit 10) x), '[]'::jsonb),
      'top_suppliers', coalesce((select jsonb_agg(jsonb_build_object('supplier', supplier_name, 'value', v, 'orders', n) order by v desc) from (
          select supplier_name, sum(grand_total) v, count(*) n from public.purchase_orders where company_id = v_company and po_date between p_from and p_to
            and status in ('APPROVED', 'SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED') group by 1 order by 2 desc limit 8) x), '[]'::jsonb));
  else
    return (with r as (select * from public.goods_receipts where company_id = v_company and status = 'POSTED')
    select jsonb_build_object('module', 'GRN',
      'total', (select count(*) from r), 'today', (select count(*) from r where receipt_date = v_today),
      'month', (select count(*) from r where receipt_date between date_trunc('month', v_today::timestamp)::date and v_today),
      'in_period', (select count(*) from r where receipt_date between p_from and p_to),
      'value_in_period', (select coalesce(sum(private.goods_receipt_value(id)), 0) from r where receipt_date between p_from and p_to),
      'pending_orders', (select count(*) from public.purchase_orders where company_id = v_company and status in ('APPROVED', 'SENT', 'PARTIALLY_RECEIVED')),
      'pending_value', (select coalesce(sum(v.pending_value), 0) from public.purchase_order_line_list v join public.purchase_orders o on o.id = v.purchase_order_id
                        where o.company_id = v_company and o.status in ('APPROVED', 'SENT', 'PARTIALLY_RECEIVED')),
      'rejected', private.units_json((select jsonb_agg(jsonb_build_object('unit', l.unit, 'quantity', l.rejected_quantity)) from public.goods_receipt_lines l
                    join r on r.id = l.goods_receipt_id where r.receipt_date between p_from and p_to and l.rejected_quantity > 0)),
      'unlinked', (select count(*) from r where receipt_type = 'DIRECT'),
      'reversed', (select count(*) from public.goods_receipts where company_id = v_company and status = 'REVERSED'),
      'recent_items', coalesce((select jsonb_agg(x order by x ->> 'receipt_date' desc, x ->> 'receipt_number' desc) from (
          select jsonb_build_object('receipt_id', r.id, 'receipt_number', r.receipt_number, 'receipt_date', r.receipt_date, 'sku', p.sku, 'product_name', p.product_name,
            'unit', l.unit, 'accepted', l.accepted_quantity, 'rejected', l.rejected_quantity, 'direct', r.receipt_type = 'DIRECT') x
          from r join public.goods_receipt_lines l on l.goods_receipt_id = r.id left join public.products p on p.id = l.product_id
          order by r.receipt_date desc, r.created_at desc limit 10) z), '[]'::jsonb))
    from (select 1) one);
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- 7. Global search (partial, case-insensitive)
-- -----------------------------------------------------------------------------
create or replace function public.global_search(p_term text, p_limit int default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.current_company_id();
  v_term    text := btrim(coalesce(p_term, ''));
  v_like    text;
  v_lim     int := least(greatest(coalesce(p_limit, 30), 1), 100);
  v_out     jsonb := '[]'::jsonb;
begin
  if v_company is null then
    raise exception 'No active company.' using errcode = '42501';
  end if;
  if length(v_term) < 2 then
    return '[]'::jsonb;
  end if;
  v_like := '%' || replace(replace(replace(v_term, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  if private.has_permission(v_company, 'products.read') then
    v_out := v_out || coalesce((select jsonb_agg(x) from (select jsonb_build_object('module', 'Product', 'id', id, 'reference', sku, 'title', product_name,
        'subtitle', initcap(replace(lower(product_type), '_', ' ')) || coalesce(' · HSN ' || hsn_code, ''), 'link', '/products/' || id) x
      from public.products where company_id = v_company and archived_at is null
        and (sku ilike v_like or product_name ilike v_like or coalesce(hsn_code, '') ilike v_like or coalesce(barcode, '') ilike v_like)
      order by (lower(sku) = lower(v_term)) desc, sku limit v_lim) z), '[]'::jsonb);
  end if;
  if private.has_permission(v_company, 'customers.read') or private.has_permission(v_company, 'suppliers.read') or private.has_permission(v_company, 'ledger.read') then
    v_out := v_out || coalesce((select jsonb_agg(x) from (select jsonb_build_object('module', case when p.is_customer and p.is_supplier then 'Customer / supplier'
          when p.is_customer then 'Customer' else 'Supplier' end, 'id', p.id, 'reference', p.party_code,
        'title', coalesce(c.customer_name, s.display_name, s.legal_name), 'subtitle', coalesce(c.gstin, s.gstin, coalesce(c.customer_code, s.supplier_code)),
        'link', '/ledger/' || p.id) x
      from public.parties p left join public.customers c on c.id = p.customer_id left join public.suppliers s on s.id = p.supplier_id
      where p.company_id = v_company and (coalesce(c.customer_name, '') ilike v_like or coalesce(c.legal_name, '') ilike v_like or coalesce(s.legal_name, '') ilike v_like
        or coalesce(s.display_name, '') ilike v_like or p.party_code ilike v_like or coalesce(c.customer_code, '') ilike v_like or coalesce(s.supplier_code, '') ilike v_like
        or coalesce(c.gstin, s.gstin, '') ilike v_like)
      order by 1 limit v_lim) z), '[]'::jsonb);
  end if;
  if private.has_permission(v_company, 'purchases.read') then
    v_out := v_out || coalesce((select jsonb_agg(x) from (select jsonb_build_object('module', 'Purchase order', 'id', id, 'reference', po_number, 'title', supplier_name,
        'subtitle', po_date || ' · ' || initcap(replace(lower(status), '_', ' ')), 'link', '/purchase-orders/' || id) x
      from public.purchase_orders where company_id = v_company and (po_number ilike v_like or supplier_name ilike v_like or coalesce(reference_number, '') ilike v_like)
      order by po_date desc limit v_lim) z), '[]'::jsonb);
    v_out := v_out || coalesce((select jsonb_agg(x) from (select jsonb_build_object('module', 'Goods receipt', 'id', r.id, 'reference', r.receipt_number,
        'title', coalesce(s.display_name, s.legal_name, 'No supplier'), 'subtitle', r.receipt_date || case when r.status = 'REVERSED' then ' · reversed' else '' end,
        'link', '/goods-receipts/' || r.id) x
      from public.goods_receipts r left join public.suppliers s on s.id = r.supplier_id
      where r.company_id = v_company and (r.receipt_number ilike v_like or coalesce(r.supplier_document_number, '') ilike v_like)
      order by r.receipt_date desc limit v_lim) z), '[]'::jsonb);
  end if;
  if private.has_permission(v_company, 'manufacturing.read') then
    v_out := v_out || coalesce((select jsonb_agg(x) from (select jsonb_build_object('module', 'Production order', 'id', o.id, 'reference', o.production_order_number,
        'title', p.sku || ' — ' || p.product_name, 'subtitle', trim_scale(o.planned_quantity) || ' ' || o.unit || ' · ' || initcap(replace(lower(o.status), '_', ' ')),
        'link', '/production/orders/' || o.id) x
      from public.production_orders o join public.products p on p.id = o.finished_product_id
      where o.company_id = v_company and (o.production_order_number ilike v_like or p.sku ilike v_like)
      order by o.created_at desc limit v_lim) z), '[]'::jsonb);
  end if;
  if private.has_permission(v_company, 'sales_orders.read') then
    v_out := v_out || coalesce((select jsonb_agg(x) from (select jsonb_build_object('module', 'Sales order', 'id', id, 'reference', sales_order_number,
        'title', customer_name_snapshot, 'subtitle', order_date || coalesce(' · ref ' || coalesce(customer_reference, customer_po_number), ''), 'link', '/sales/orders/' || id) x
      from public.sales_orders where company_id = v_company and (sales_order_number ilike v_like or customer_name_snapshot ilike v_like
        or coalesce(customer_reference, '') ilike v_like or coalesce(customer_po_number, '') ilike v_like)
      order by order_date desc limit v_lim) z), '[]'::jsonb);
  end if;
  if private.has_permission(v_company, 'invoices.read') then
    v_out := v_out || coalesce((select jsonb_agg(x) from (select jsonb_build_object('module', case when is_proforma then 'Proforma invoice' else 'Invoice' end, 'id', id,
        'reference', coalesce(invoice_number, proforma_number, 'Draft'), 'title', customer_legal_name,
        'subtitle', invoice_date || ' · ' || initcap(replace(lower(status), '_', ' ')) || ' · ' || grand_total, 'link', '/billing/invoices/' || id) x
      from public.sales_invoices where company_id = v_company and status <> 'DISCARDED'
        and (coalesce(invoice_number, '') ilike v_like or coalesce(proforma_number, '') ilike v_like or customer_legal_name ilike v_like)
      order by invoice_date desc limit v_lim) z), '[]'::jsonb);
  end if;
  return v_out;
end;
$$;

-- -----------------------------------------------------------------------------
-- 8. Activity centre (built from the business records themselves)
-- -----------------------------------------------------------------------------
create or replace function public.activity_feed(p_from date, p_to date, p_type text default null, p_search text default null, p_limit int default 100, p_offset int default 0)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('dashboard.read');
  v_tz      text := private.company_tz(v_company);
  v_lo      timestamptz;
  v_hi      timestamptz;
  v_rows    jsonb;
  v_like    text := '%' || nullif(btrim(coalesce(p_search, '')), '') || '%';
begin
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'Choose a valid date range.' using errcode = 'P0001';
  end if;
  v_lo := (p_from::timestamp) at time zone v_tz;
  v_hi := ((p_to + 1)::timestamp) at time zone v_tz;
  with a as (
    select 'PRODUCT_CREATED' t, created_at at_, sku ref, product_name || ' added (' || lower(replace(product_type, '_', ' ')) || ')' d, '/products/' || id link
      from public.products where company_id = v_company and created_at >= v_lo and created_at < v_hi
    union all select 'PRODUCT_UPDATED', updated_at, sku, product_name || ' updated', '/products/' || id
      from public.products where company_id = v_company and updated_at >= v_lo and updated_at < v_hi and updated_at > created_at + interval '2 seconds'
    union all select 'BOM_UPDATED', b.updated_at, b.bom_code || ' v' || b.version, 'BOM for ' || p.sku || ' ' || lower(b.status), '/production/boms/' || b.id
      from public.boms b join public.products p on p.id = b.finished_product_id where b.company_id = v_company and b.updated_at >= v_lo and b.updated_at < v_hi
    union all select 'SUPPLIER_ADDED', created_at, supplier_code, coalesce(display_name, legal_name) || ' added as supplier', '/suppliers/' || id
      from public.suppliers where company_id = v_company and created_at >= v_lo and created_at < v_hi
    union all select 'CUSTOMER_ADDED', created_at, customer_code, customer_name || ' added as customer', '/customers'
      from public.customers where company_id = v_company and created_at >= v_lo and created_at < v_hi
    union all select 'PURCHASE_ORDER_CREATED', created_at, po_number, 'Purchase order to ' || supplier_name || ' · ' || grand_total, '/purchase-orders/' || id
      from public.purchase_orders where company_id = v_company and created_at >= v_lo and created_at < v_hi
    union all select case when r.status = 'REVERSED' then 'GOODS_RECEIPT_REVERSED' else 'GOODS_RECEIVED' end, coalesce(r.reversed_at, r.created_at), r.receipt_number,
        case when r.status = 'REVERSED' then 'Goods receipt reversed: ' || coalesce(r.reversal_reason, '') else 'Goods received' || coalesce(' from ' || s.display_name, '') end,
        '/goods-receipts/' || r.id
      from public.goods_receipts r left join public.suppliers s on s.id = r.supplier_id
      where r.company_id = v_company and coalesce(r.reversed_at, r.created_at) >= v_lo and coalesce(r.reversed_at, r.created_at) < v_hi
    union all select case when e.event_type in ('PRODUCTION_RECORDED', 'OUTPUT_RECEIVED') then 'PRODUCTION_COMPLETED'
                          when e.event_type in ('PRODUCTION_REVERSED', 'PRODUCTION_CORRECTED', 'OUTPUT_REVERSED', 'ISSUE_REVERSED', 'REOPENED') then 'PRODUCTION_CORRECTED'
                          else 'PRODUCTION_STARTED' end,
        e.created_at, o.production_order_number, initcap(replace(lower(e.event_type), '_', ' ')) || ' · ' || p.sku || coalesce(' · ' || e.note, ''), '/production/orders/' || o.id
      from public.production_order_events e join public.production_orders o on o.id = e.production_order_id join public.products p on p.id = o.finished_product_id
      where e.company_id = v_company and e.created_at >= v_lo and e.created_at < v_hi
        and e.event_type in ('CREATED', 'START', 'PRODUCTION_RECORDED', 'OUTPUT_RECEIVED', 'PRODUCTION_REVERSED', 'PRODUCTION_CORRECTED', 'OUTPUT_REVERSED', 'ISSUE_REVERSED', 'REOPENED')
    union all select 'SALES_ORDER_CREATED', created_at, sales_order_number, 'Sales order for ' || customer_name_snapshot || ' · ' || grand_total, '/sales/orders/' || id
      from public.sales_orders where company_id = v_company and created_at >= v_lo and created_at < v_hi
    union all select 'STOCK_RESERVED', r.reserved_at, r.reservation_number, 'Reserved ' || trim_scale(r.quantity) || ' ' || p.base_unit || ' of ' || p.sku
        || coalesce(' for ' || r.reference_number, ''), '/inventory/reservations'
      from public.stock_reservations r join public.products p on p.id = r.product_id where r.company_id = v_company and r.reserved_at >= v_lo and r.reserved_at < v_hi
    union all select 'STOCK_DISPATCHED', f.actual_dispatch_at, f.fulfilment_number, 'Dispatched for ' || so.sales_order_number || ' · ' || so.customer_name_snapshot,
        '/sales/orders/' || so.id
      from public.fulfilments f join public.sales_orders so on so.id = f.sales_order_id
      where f.company_id = v_company and f.actual_dispatch_at >= v_lo and f.actual_dispatch_at < v_hi
    union all select 'INVOICE_CREATED', coalesce(i.issued_at, i.created_at), coalesce(i.invoice_number, i.proforma_number, 'Draft'),
        case when i.status = 'ISSUED' then 'Invoice issued' when i.status = 'CANCELLED' then 'Invoice cancelled' else 'Draft invoice' end || ' · ' || i.customer_legal_name || ' · ' || i.grand_total,
        '/billing/invoices/' || i.id
      from public.sales_invoices i where i.company_id = v_company and i.status <> 'DISCARDED' and coalesce(i.issued_at, i.created_at) >= v_lo and coalesce(i.issued_at, i.created_at) < v_hi
    union all select case when p.status = 'REVERSED' then 'PAYMENT_REVERSED' else 'PAYMENT_RECEIVED' end, coalesce(p.reversed_at, p.created_at), p.receipt_number,
        case when p.status = 'REVERSED' then 'Receipt reversed: ' || coalesce(p.reversal_reason, '') else 'Payment received from ' || c.customer_name || ' · ' || p.amount_received end,
        '/billing/payments'
      from public.customer_payments p join public.customers c on c.id = p.customer_id
      where p.company_id = v_company and coalesce(p.reversed_at, p.created_at) >= v_lo and coalesce(p.reversed_at, p.created_at) < v_hi
    union all select case when t.transaction_type = 'REVERSAL' then 'STOCK_REVERSED' else 'STOCK_ADJUSTED' end, t.created_at, t.transaction_number,
        case when t.direction = 1 then '+' else '−' end || trim_scale(t.quantity) || ' ' || t.unit || ' ' || p.sku || ' · ' || t.reason, '/inventory/stock/' || p.id
      from public.inventory_transactions t join public.products p on p.id = t.product_id
      where t.company_id = v_company and t.created_at >= v_lo and t.created_at < v_hi
        and (t.transaction_type in ('ADJUSTMENT_IN', 'ADJUSTMENT_OUT') or (t.transaction_type = 'REVERSAL' and t.reference_type is distinct from 'PRODUCTION_ORDER'))
  ), f as (
    select * from a where (p_type is null or t = upper(p_type)) and (p_search is null or btrim(p_search) = '' or ref ilike v_like or d ilike v_like)
  )
  select jsonb_build_object('total', (select count(*) from f),
    'rows', coalesce((select jsonb_agg(jsonb_build_object('type', t, 'at', at_, 'reference', ref, 'description', d, 'link', link) order by at_ desc, ref)
      from (select * from f order by at_ desc, ref limit least(greatest(coalesce(p_limit, 100), 1), 500) offset greatest(coalesce(p_offset, 0), 0)) z), '[]'::jsonb),
    'by_type', coalesce((select jsonb_object_agg(t, n) from (select t, count(*) n from a group by t) z), '{}'::jsonb))
  into v_rows;
  return v_rows;
end;
$$;

-- -----------------------------------------------------------------------------
-- 9. Reconciliation (inventory and finance), read-only checks
-- -----------------------------------------------------------------------------
create or replace function public.erp_reconciliation()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('dashboard.read');
  v_checks  jsonb := '[]'::jsonb;
  v_n       bigint;
  v_s       jsonb;
begin
  -- Inventory
  select count(*), coalesce(jsonb_agg(x) filter (where rn <= 5), '[]'::jsonb) into v_n, v_s from (
    select jsonb_build_object('reference', p.sku, 'detail', 'balance ' || b.on_hand || ' vs ledger ' || coalesce(l.q, 0)) x, row_number() over () rn
    from public.inventory_balances b join public.products p on p.id = b.product_id
    left join lateral (select sum(t.direction * t.quantity) q from public.inventory_transactions t where t.batch_id = b.batch_id and t.location_id = b.location_id) l on true
    where b.company_id = v_company and b.on_hand <> coalesce(l.q, 0)) z;
  v_checks := v_checks || jsonb_build_object('code', 'STOCK_LEDGER', 'area', 'Inventory', 'title', 'Physical stock equals the stock ledger',
    'rule', 'For every lot and location: on hand = sum of posted movements (receipts and GRNs add, issues and dispatches deduct).', 'issues', v_n, 'samples', v_s);
  select count(*), coalesce(jsonb_agg(x) filter (where rn <= 5), '[]'::jsonb) into v_n, v_s from (
    select jsonb_build_object('reference', p.sku, 'detail', 'reserved ' || b.reserved || ' vs active reservations ' || coalesce(r.q, 0)) x, row_number() over () rn
    from public.inventory_balances b join public.products p on p.id = b.product_id
    left join lateral (select sum(r.quantity - r.fulfilled_quantity - r.released_quantity) q from public.stock_reservations r
                       where r.batch_id = b.batch_id and r.location_id = b.location_id and r.reservation_status in ('ACTIVE', 'PARTIALLY_FULFILLED')) r on true
    where b.company_id = v_company and b.reserved <> coalesce(r.q, 0)) z;
  v_checks := v_checks || jsonb_build_object('code', 'RESERVATIONS', 'area', 'Inventory', 'title', 'Reserved stock equals active reservations',
    'rule', 'Available = physical − active reservations; released, fulfilled and cancelled reservations are not counted.', 'issues', v_n, 'samples', v_s);
  select count(*) into v_n from public.inventory_balances where company_id = v_company and (on_hand < 0 or reserved > on_hand or reserved < 0);
  v_checks := v_checks || jsonb_build_object('code', 'NO_NEGATIVE', 'area', 'Inventory', 'title', 'No negative stock and no over-reservation',
    'rule', 'On hand ≥ 0 and reserved ≤ on hand for every lot and location.', 'issues', v_n, 'samples', '[]'::jsonb);
  select count(*), coalesce(jsonb_agg(x) filter (where rn <= 5), '[]'::jsonb) into v_n, v_s from (
    select jsonb_build_object('reference', reference_number, 'detail', count(*) || ' active reservations of the same lot for the same line') x, row_number() over () rn
    from public.stock_reservations where company_id = v_company and reservation_status in ('ACTIVE', 'PARTIALLY_FULFILLED') and reference_id is not null
    group by reference_type, reference_id, reference_number, batch_id, location_id having count(*) > 1) z;
  v_checks := v_checks || jsonb_build_object('code', 'DUPLICATE_RESERVATIONS', 'area', 'Inventory', 'title', 'No duplicate reservations',
    'rule', 'One active reservation per order line, lot and location.', 'issues', v_n, 'samples', v_s);
  select count(*) into v_n from public.inventory_transactions where company_id = v_company and (reference_type ilike '%INVOICE%' or reference_type ilike '%PAYMENT%');
  v_checks := v_checks || jsonb_build_object('code', 'NO_INVOICE_STOCK', 'area', 'Inventory', 'title', 'Invoices do not move stock again',
    'rule', 'Dispatch deducts the goods; invoices, notes and payments post no stock movement.', 'issues', v_n, 'samples', '[]'::jsonb);
  select count(*), coalesce(jsonb_agg(x) filter (where rn <= 5), '[]'::jsonb) into v_n, v_s from (
    select jsonb_build_object('reference', r.transaction_number, 'detail', 'does not mirror ' || o.transaction_number) x, row_number() over () rn
    from public.inventory_transactions r join public.inventory_transactions o on o.id = r.reversal_of_transaction_id
    where r.company_id = v_company and (r.direction <> -o.direction or r.quantity <> o.quantity or r.batch_id <> o.batch_id or r.location_id <> o.location_id)) z;
  v_checks := v_checks || jsonb_build_object('code', 'REVERSALS', 'area', 'Inventory', 'title', 'Corrections reverse the original movement exactly',
    'rule', 'Each reversal has the opposite direction, same quantity, lot and location; a movement can be reversed only once.', 'issues', v_n, 'samples', v_s);
  select count(*), coalesce(jsonb_agg(x) filter (where rn <= 5), '[]'::jsonb) into v_n, v_s from (
    select jsonb_build_object('reference', so.sales_order_number, 'detail', l.sku_snapshot || ' dispatched ' || l.quantity_dispatched || ' vs consignments ' || coalesce(d.q, 0)) x,
      row_number() over () rn
    from public.sales_order_lines l join public.sales_orders so on so.id = l.sales_order_id
    left join lateral (select sum(fl.quantity_dispatched) q from public.fulfilment_lines fl join public.fulfilments f on f.id = fl.fulfilment_id
                       where fl.sales_order_line_id = l.id and f.actual_dispatch_at is not null and f.fulfilment_status <> 'CANCELLED') d on true
    where so.company_id = v_company and l.quantity_dispatched <> coalesce(d.q, 0)) z;
  v_checks := v_checks || jsonb_build_object('code', 'DISPATCH', 'area', 'Inventory', 'title', 'Dispatched quantities match the consignments',
    'rule', 'Order line dispatched quantity = sum of dispatched consignment lines (reversed dispatches excluded).', 'issues', v_n, 'samples', v_s);

  -- Finance
  select count(*), coalesce(jsonb_agg(x) filter (where rn <= 5), '[]'::jsonb) into v_n, v_s from (
    select jsonb_build_object('reference', coalesce(i.invoice_number, 'draft'), 'detail', 'total ' || i.grand_total || ' vs lines + round-off ' || (l.s + i.round_off)) x, row_number() over () rn
    from public.sales_invoices i cross join lateral (select coalesce(sum(line_total), 0) s from public.sales_invoice_lines where invoice_id = i.id) l
    where i.company_id = v_company and i.status <> 'DISCARDED' and i.grand_total <> l.s + i.round_off) z;
  v_checks := v_checks || jsonb_build_object('code', 'INVOICE_TOTALS', 'area', 'Finance', 'title', 'Invoice totals equal their lines',
    'rule', 'Grand total = sum of line totals (taxable + GST) + round-off.', 'issues', v_n, 'samples', v_s);
  select count(*), coalesce(jsonb_agg(x) filter (where rn <= 5), '[]'::jsonb) into v_n, v_s from (
    select jsonb_build_object('reference', i.invoice_number, 'detail', 'balance ' || private.invoice_balance(i.id)) x, row_number() over () rn
    from public.sales_invoices i where i.company_id = v_company and i.status = 'ISSUED'
      and private.invoice_balance(i.id) <> i.grand_total
        - coalesce((select sum(total_amount) from public.invoice_adjustment_notes where original_invoice_id = i.id and status = 'ISSUED' and note_type = 'CREDIT'), 0)
        + coalesce((select sum(total_amount) from public.invoice_adjustment_notes where original_invoice_id = i.id and status = 'ISSUED' and note_type = 'DEBIT'), 0)
        - coalesce((select sum(a.allocated_amount) from public.invoice_payment_allocations a join public.customer_payments p on p.id = a.payment_id
                    where a.invoice_id = i.id and a.status = 'ACTIVE' and p.status = 'RECORDED'), 0)
      or private.invoice_balance(i.id) < 0) z;
  v_checks := v_checks || jsonb_build_object('code', 'INVOICE_BALANCE', 'area', 'Finance', 'title', 'Invoice outstanding = total − credits + debits − valid payments',
    'rule', 'Reversed payments and cancelled notes are excluded; no invoice is over-paid.', 'issues', v_n, 'samples', v_s);
  select count(*) into v_n from public.invoice_payment_allocations a
    left join public.customer_payments p on p.id = a.payment_id left join public.sales_invoices i on i.id = a.invoice_id
    where a.company_id = v_company and a.status = 'ACTIVE' and (p.status <> 'RECORDED' or i.status <> 'ISSUED');
  v_checks := v_checks || jsonb_build_object('code', 'ACTIVE_ALLOCATIONS', 'area', 'Finance', 'title', 'No payments on cancelled invoices or from reversed receipts',
    'rule', 'Active allocations only link recorded receipts to issued invoices.', 'issues', v_n, 'samples', '[]'::jsonb);
  select count(*), coalesce(jsonb_agg(x) filter (where rn <= 5), '[]'::jsonb) into v_n, v_s from (
    select jsonb_build_object('reference', p.receipt_number, 'detail', 'allocated ' || a.s || ' of ' || p.amount_received) x, row_number() over () rn
    from public.customer_payments p cross join lateral (select coalesce(sum(allocated_amount), 0) s from public.invoice_payment_allocations where payment_id = p.id and status = 'ACTIVE') a
    where p.company_id = v_company and a.s > p.amount_received) z;
  v_checks := v_checks || jsonb_build_object('code', 'RECEIPT_ALLOCATION', 'area', 'Finance', 'title', 'Receipts are not allocated beyond the amount received',
    'rule', 'Sum of active allocations ≤ amount received for every receipt.', 'issues', v_n, 'samples', v_s);
  select count(*), coalesce(jsonb_agg(x) filter (where rn <= 5), '[]'::jsonb) into v_n, v_s from (
    select jsonb_build_object('reference', b.party_code, 'detail', 'ledger ' || b.receivable || ' vs statement ' || s.v) x, row_number() over () rn
    from private.party_balances(v_company) b join public.parties pt on pt.id = b.party_id
    cross join lateral (select round(case when pt.opening_balance_type = 'RECEIVABLE' then coalesce(pt.opening_balance, 0) else 0 end
        + coalesce((select sum(grand_total) from public.sales_invoices where customer_id = b.customer_id and status = 'ISSUED'), 0)
        + coalesce((select sum(total_amount) from public.invoice_adjustment_notes where customer_id = b.customer_id and status = 'ISSUED' and note_type = 'DEBIT'), 0)
        - coalesce((select sum(total_amount) from public.invoice_adjustment_notes where customer_id = b.customer_id and status = 'ISSUED' and note_type = 'CREDIT'), 0)
        - coalesce((select sum(amount_received) from public.customer_payments where customer_id = b.customer_id and status = 'RECORDED'), 0), 2) v) s
    where b.customer_id is not null and b.receivable <> s.v) z;
  v_checks := v_checks || jsonb_build_object('code', 'CUSTOMER_LEDGER', 'area', 'Finance', 'title', 'Customer ledger reconciles',
    'rule', 'Opening + invoices + debit notes − credit notes − payments received = customer outstanding.', 'issues', v_n, 'samples', v_s);
  select count(*), coalesce(jsonb_agg(x) filter (where rn <= 5), '[]'::jsonb) into v_n, v_s from (
    select jsonb_build_object('reference', b.party_code, 'detail', 'ledger ' || b.payable || ' vs statement ' || s.v) x, row_number() over () rn
    from private.party_balances(v_company) b join public.parties pt on pt.id = b.party_id
    cross join lateral (select round(case when pt.opening_balance_type = 'PAYABLE' then coalesce(pt.opening_balance, 0) else 0 end
        + coalesce((select sum(private.goods_receipt_value(r.id)) from public.goods_receipts r where r.supplier_id = b.supplier_id and r.status = 'POSTED'), 0)
        - coalesce((select sum(amount) from public.supplier_payments where supplier_id = b.supplier_id and status = 'RECORDED'), 0), 2) v) s
    where b.supplier_id is not null and b.payable <> s.v) z;
  v_checks := v_checks || jsonb_build_object('code', 'SUPPLIER_LEDGER', 'area', 'Finance', 'title', 'Supplier ledger reconciles',
    'rule', 'Opening + goods accepted on GRNs (the payable record in this ERP) − payments made = supplier outstanding. Purchase orders are not payables.',
    'issues', v_n, 'samples', v_s);
  return jsonb_build_object('generated_at', now(), 'checks', v_checks,
    'issues', (select coalesce(sum((c ->> 'issues')::int), 0) from jsonb_array_elements(v_checks) c));
end;
$$;

-- -----------------------------------------------------------------------------
-- 10. Reporting centre: one function, twenty reports; rows only from records
-- p_filters: {from, to, product_id, customer_id, supplier_id, search}
-- -----------------------------------------------------------------------------
create or replace function public.erp_report(p_report text, p_filters jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid;
  v_f       jsonb := coalesce(p_filters, '{}'::jsonb);
  v_from    date;
  v_to      date;
  v_prod    uuid;
  v_cust    uuid;
  v_sup     uuid;
  v_search  text := nullif(btrim(coalesce(v_f ->> 'search', '')), '');
  v_tz      text;
  v_rows    jsonb;
  v_r       text := upper(coalesce(p_report, ''));
begin
  v_company := case
    when v_r in ('PRODUCTS') then private.require_permission('products.read')
    when v_r in ('STOCK_REGISTER', 'STOCK_MOVEMENTS', 'INVENTORY_VALUATION', 'LOW_STOCK') then private.require_permission('inventory.read')
    when v_r in ('PURCHASE_REGISTER', 'GRN_REGISTER', 'SUPPLIER_PURCHASES') then private.require_permission('purchases.read')
    when v_r in ('PRODUCTION_REGISTER', 'MATERIAL_CONSUMPTION', 'PRODUCTION_WASTAGE') then private.require_permission('manufacturing.read')
    when v_r in ('SALES_ORDER_REGISTER', 'CUSTOMER_SALES', 'PRODUCT_SALES', 'DISPATCH') then private.require_permission('sales_orders.read')
    when v_r in ('INVOICE_REGISTER', 'GST_SUMMARY', 'CUSTOMER_OUTSTANDING', 'PAYMENT_COLLECTION') then private.require_permission('invoices.read')
    when v_r = 'SUPPLIER_OUTSTANDING' then private.require_permission('ledger.read') end;
  if v_company is null then
    raise exception 'Unknown report %.', p_report using errcode = 'P0001';
  end if;
  begin
    v_from := coalesce(nullif(v_f ->> 'from', '')::date, date '2000-01-01');
    v_to := coalesce(nullif(v_f ->> 'to', '')::date, private.company_today(v_company));
    v_prod := nullif(v_f ->> 'product_id', '')::uuid;
    v_cust := nullif(v_f ->> 'customer_id', '')::uuid;
    v_sup := nullif(v_f ->> 'supplier_id', '')::uuid;
  exception when others then
    raise exception 'Invalid report filters.' using errcode = 'P0001';
  end;
  if v_to < v_from then
    raise exception 'The end date cannot be before the start date.' using errcode = 'P0001';
  end if;
  v_tz := private.company_tz(v_company);

  if v_r = 'PRODUCTS' then
    select jsonb_agg(x order by x ->> 'sku') into v_rows from (select jsonb_build_object('id', p.id, 'sku', p.sku, 'product_name', p.product_name,
        'product_type', p.product_type, 'category', c.name, 'unit', p.base_unit, 'hsn_code', p.hsn_code, 'gst_rate', p.gst_rate, 'selling_price', p.selling_price,
        'standard_cost', p.standard_cost, 'reorder_level', p.reorder_level, 'source', p.default_source_type, 'status', p.status,
        'bom', exists (select 1 from public.boms b where b.finished_product_id = p.id and b.status = 'APPROVED'), 'created', (p.created_at at time zone v_tz)::date) x
      from public.products p left join public.product_categories c on c.id = p.category_id
      where p.company_id = v_company and p.archived_at is null and (v_prod is null or p.id = v_prod)) z;
  elsif v_r in ('STOCK_REGISTER', 'INVENTORY_VALUATION') then
    select jsonb_agg(x order by x ->> 'sku') into v_rows from (select jsonb_build_object('product_id', p.id, 'sku', p.sku, 'product_name', p.product_name,
        'product_type', p.product_type, 'unit', p.base_unit, 'on_hand', sum(l.on_hand), 'reserved', sum(l.reserved),
        'available', coalesce(sum(l.on_hand - l.reserved) filter (where l.stock_usage = 'STORAGE'), 0),
        'rejected', coalesce(sum(l.on_hand) filter (where l.stock_usage = 'REJECTED'), 0),
        'average_cost', case when count(*) filter (where l.cost is null) = 0 and sum(l.on_hand) > 0 then round(sum(l.on_hand * l.cost) / sum(l.on_hand), 4) end,
        'value', case when count(*) filter (where l.cost is null) = 0 then round(sum(round(l.on_hand * l.cost, 2)), 2) end,
        'uncosted_quantity', coalesce(sum(l.on_hand) filter (where l.cost is null), 0)) x
      from private.stock_lots(v_company) l join public.products p on p.id = l.product_id
      where (v_prod is null or p.id = v_prod) group by p.id) z;
  elsif v_r = 'LOW_STOCK' then
    select jsonb_agg(x order by x ->> 'sku') into v_rows from (select jsonb_build_object('product_id', s.product_id, 'sku', s.sku, 'product_name', s.product_name,
        'unit', s.base_unit, 'on_hand', s.on_hand, 'reserved', s.reserved, 'available', s.available, 'reorder_level', s.reorder_level, 'status', s.stock_status) x
      from public.inventory_product_stock s where s.company_id = v_company and s.archived_at is null and s.product_status = 'ACTIVE'
        and (s.stock_status = 'LOW_STOCK' or (s.stock_status = 'OUT_OF_STOCK' and s.has_history)) and (v_prod is null or s.product_id = v_prod)) z;
  elsif v_r = 'STOCK_MOVEMENTS' then
    select jsonb_agg(x order by x ->> 'date', x ->> 'number') into v_rows from (select jsonb_build_object('date', (t.transaction_date at time zone v_tz)::date,
        'number', t.transaction_number, 'type', t.transaction_type, 'sku', p.sku, 'product_name', p.product_name, 'quantity', t.direction * t.quantity, 'unit', t.unit,
        'warehouse', w.warehouse_code, 'location', l.location_code, 'reference', coalesce(t.reference_number, t.reference_type), 'reason', t.reason) x
      from public.inventory_transactions t join public.products p on p.id = t.product_id join public.warehouses w on w.id = t.warehouse_id
      join public.inventory_locations l on l.id = t.location_id
      where t.company_id = v_company and (t.transaction_date at time zone v_tz)::date between v_from and v_to and (v_prod is null or t.product_id = v_prod)
      order by t.transaction_date limit 5000) z;
  elsif v_r = 'PURCHASE_REGISTER' then
    select jsonb_agg(x order by x ->> 'date', x ->> 'po_number') into v_rows from (select jsonb_build_object('id', o.id, 'po_number', o.po_number, 'date', o.po_date,
        'supplier', o.supplier_name, 'status', o.status, 'expected', o.expected_delivery_date, 'taxable', o.taxable_total,
        'gst', o.cgst_total + o.sgst_total + o.igst_total, 'grand_total', o.grand_total,
        'pending_value', (select coalesce(sum(v.pending_value), 0) from public.purchase_order_line_list v where v.purchase_order_id = o.id)) x
      from public.purchase_orders o where o.company_id = v_company and o.po_date between v_from and v_to and (v_sup is null or o.supplier_id = v_sup)
        and (v_prod is null or exists (select 1 from public.purchase_order_lines l where l.purchase_order_id = o.id and l.product_id = v_prod))) z;
  elsif v_r = 'GRN_REGISTER' then
    select jsonb_agg(x order by x ->> 'date', x ->> 'receipt_number') into v_rows from (select jsonb_build_object('id', r.id, 'receipt_number', r.receipt_number,
        'date', r.receipt_date, 'supplier', coalesce(s.display_name, s.legal_name), 'po_number', o.po_number, 'sku', p.sku, 'product_name', p.product_name,
        'received', l.received_quantity, 'accepted', l.accepted_quantity, 'rejected', l.rejected_quantity, 'unit', l.unit,
        'value', coalesce(l.line_value, private.grn_line_value(l.accepted_quantity, pol.ordered_quantity, pol.line_total)), 'status', r.status) x
      from public.goods_receipts r join public.goods_receipt_lines l on l.goods_receipt_id = r.id left join public.products p on p.id = l.product_id
      left join public.suppliers s on s.id = r.supplier_id left join public.purchase_orders o on o.id = r.purchase_order_id
      left join public.purchase_order_lines pol on pol.id = l.purchase_order_line_id
      where r.company_id = v_company and r.receipt_date between v_from and v_to and (v_sup is null or r.supplier_id = v_sup) and (v_prod is null or l.product_id = v_prod)) z;
  elsif v_r = 'SUPPLIER_PURCHASES' then
    select jsonb_agg(x order by x ->> 'supplier') into v_rows from (select jsonb_build_object('supplier_id', s.id, 'supplier_code', s.supplier_code,
        'supplier', coalesce(s.display_name, s.legal_name),
        'orders', (select count(*) from public.purchase_orders o where o.supplier_id = s.id and o.po_date between v_from and v_to and o.status not in ('DRAFT', 'CANCELLED', 'PENDING_APPROVAL')),
        'ordered_value', (select coalesce(sum(grand_total), 0) from public.purchase_orders o where o.supplier_id = s.id and o.po_date between v_from and v_to
                          and o.status not in ('DRAFT', 'CANCELLED', 'PENDING_APPROVAL')),
        'received_value', (select coalesce(sum(private.goods_receipt_value(r.id)), 0) from public.goods_receipts r where r.supplier_id = s.id and r.status = 'POSTED'
                           and r.receipt_date between v_from and v_to),
        'paid', (select coalesce(sum(amount), 0) from public.supplier_payments sp where sp.supplier_id = s.id and sp.status = 'RECORDED' and sp.payment_date between v_from and v_to),
        'outstanding', (select payable from private.party_balances(v_company) b where b.supplier_id = s.id limit 1)) x
      from public.suppliers s where s.company_id = v_company and (v_sup is null or s.id = v_sup)) z
    where (x ->> 'orders')::int > 0 or (x ->> 'received_value')::numeric <> 0 or (x ->> 'paid')::numeric <> 0 or coalesce((x ->> 'outstanding')::numeric, 0) <> 0;
  elsif v_r = 'PRODUCTION_REGISTER' then
    select jsonb_agg(x order by x ->> 'date', x ->> 'order_number') into v_rows from (select jsonb_build_object('id', o.id, 'order_number', o.production_order_number,
        'date', o.planned_start_date, 'sku', p.sku, 'product_name', p.product_name, 'unit', o.unit, 'planned', o.planned_quantity,
        'good', (select coalesce(sum(good_quantity), 0) from public.production_output_receipts r where r.production_order_id = o.id and r.status = 'POSTED'),
        'rejected', (select coalesce(sum(rejected_quantity), 0) from public.production_output_receipts r where r.production_order_id = o.id and r.status = 'POSTED'),
        'scrap', (select coalesce(sum(scrap_quantity), 0) from public.production_output_receipts r where r.production_order_id = o.id and r.status = 'POSTED'),
        'status', o.status, 'completed', o.actual_completion_date) x
      from public.production_orders o join public.products p on p.id = o.finished_product_id
      where o.company_id = v_company and o.planned_start_date between v_from and v_to and (v_prod is null or o.finished_product_id = v_prod)) z;
  elsif v_r = 'MATERIAL_CONSUMPTION' then
    select jsonb_agg(x order by x ->> 'date', x ->> 'order_number') into v_rows from (select jsonb_build_object('date', c.consumption_date,
        'order_number', o.production_order_number, 'finished_sku', fp.sku, 'sku', p.sku, 'product_name', p.product_name, 'unit', c.unit,
        'planned', c.planned_quantity, 'actual', c.actual_quantity, 'difference', c.actual_quantity - c.planned_quantity, 'status', c.status) x
      from public.production_material_consumption c join public.production_orders o on o.id = c.production_order_id
      join public.products p on p.id = c.component_product_id join public.products fp on fp.id = o.finished_product_id
      where c.company_id = v_company and c.consumption_date between v_from and v_to and (v_prod is null or c.component_product_id = v_prod or o.finished_product_id = v_prod)) z;
  elsif v_r = 'PRODUCTION_WASTAGE' then
    select jsonb_agg(x order by x ->> 'date', x ->> 'receipt_number') into v_rows from (select jsonb_build_object('date', r.production_date, 'receipt_number', r.receipt_number,
        'order_number', o.production_order_number, 'sku', p.sku, 'product_name', p.product_name, 'unit', r.unit, 'good', r.good_quantity,
        'rejected', r.rejected_quantity, 'scrap', r.scrap_quantity,
        'loss_percent', case when r.good_quantity + r.rejected_quantity + r.scrap_quantity > 0
                             then round(100 * (r.rejected_quantity + r.scrap_quantity) / (r.good_quantity + r.rejected_quantity + r.scrap_quantity), 1) end,
        'material_over_use', (select coalesce(sum(greatest(c.actual_quantity - c.planned_quantity, 0)), 0) from public.production_material_consumption c
                              where c.production_order_id = o.id and c.status = 'POSTED'),
        'reason', r.rejection_reason) x
      from public.production_output_receipts r join public.production_orders o on o.id = r.production_order_id join public.products p on p.id = r.product_id
      where r.company_id = v_company and r.status = 'POSTED' and r.production_date between v_from and v_to and (r.rejected_quantity > 0 or r.scrap_quantity > 0
        or exists (select 1 from public.production_material_consumption c where c.production_order_id = o.id and c.status = 'POSTED' and c.actual_quantity > c.planned_quantity))
        and (v_prod is null or r.product_id = v_prod)) z;
  elsif v_r = 'SALES_ORDER_REGISTER' then
    select jsonb_agg(x order by x ->> 'date', x ->> 'order_number') into v_rows from (select jsonb_build_object('id', so.id, 'order_number', so.sales_order_number,
        'date', so.order_date, 'customer', so.customer_name_snapshot, 'reference', coalesce(so.customer_reference, so.customer_po_number),
        'status', private.so_v2_status(so.id), 'taxable', so.taxable_total, 'grand_total', so.grand_total, 'delivery', so.requested_delivery_date) x
      from public.sales_orders so where so.company_id = v_company and so.order_date between v_from and v_to and (v_cust is null or so.customer_id = v_cust)
        and (v_prod is null or exists (select 1 from public.sales_order_lines l where l.sales_order_id = so.id and l.product_id = v_prod))) z;
  elsif v_r = 'CUSTOMER_SALES' then
    select jsonb_agg(x order by x ->> 'customer') into v_rows from (select jsonb_build_object('customer_id', c.id, 'customer_code', c.customer_code, 'customer', c.customer_name,
        'orders', (select count(*) from public.sales_orders so where so.customer_id = c.id and so.order_date between v_from and v_to and so.order_status not in ('DRAFT', 'CANCELLED')),
        'order_value', (select coalesce(sum(grand_total), 0) from public.sales_orders so where so.customer_id = c.id and so.order_date between v_from and v_to
                        and so.order_status not in ('DRAFT', 'CANCELLED')),
        'invoiced', (select coalesce(sum(grand_total), 0) from public.sales_invoices i where i.customer_id = c.id and i.status = 'ISSUED' and i.invoice_date between v_from and v_to),
        'collected', (select coalesce(sum(amount_received), 0) from public.customer_payments p where p.customer_id = c.id and p.status = 'RECORDED' and p.receipt_date between v_from and v_to),
        'outstanding', (select coalesce(sum(greatest(private.invoice_balance(i.id), 0)), 0) from public.sales_invoices i where i.customer_id = c.id and i.status = 'ISSUED')) x
      from public.customers c where c.company_id = v_company and (v_cust is null or c.id = v_cust)) z
    where (x ->> 'orders')::int > 0 or (x ->> 'invoiced')::numeric <> 0 or (x ->> 'collected')::numeric <> 0 or (x ->> 'outstanding')::numeric <> 0;
  elsif v_r = 'PRODUCT_SALES' then
    select jsonb_agg(x order by x ->> 'sku') into v_rows from (select jsonb_build_object('product_id', p.id, 'sku', p.sku, 'product_name', p.product_name, 'unit', p.base_unit,
        'ordered', coalesce(o.q, 0), 'order_value', coalesce(o.v, 0), 'dispatched', coalesce(d.q, 0), 'invoiced', coalesce(i.q, 0), 'invoiced_taxable', coalesce(i.v, 0)) x
      from public.products p
      left join lateral (select sum(l.quantity_ordered - l.quantity_cancelled) q, sum(l.line_total) v from public.sales_order_lines l join public.sales_orders so on so.id = l.sales_order_id
                         where l.product_id = p.id and so.order_date between v_from and v_to and so.order_status not in ('DRAFT', 'CANCELLED')
                           and (v_cust is null or so.customer_id = v_cust)) o on true
      left join lateral (select sum(fl.quantity_dispatched) q from public.fulfilment_lines fl join public.fulfilments f on f.id = fl.fulfilment_id
                         join public.sales_orders so on so.id = f.sales_order_id
                         where fl.product_id = p.id and f.actual_dispatch_at is not null and (f.actual_dispatch_at at time zone v_tz)::date between v_from and v_to
                           and (v_cust is null or so.customer_id = v_cust)) d on true
      left join lateral (select sum(il.quantity) q, sum(il.taxable_value) v from public.sales_invoice_lines il join public.sales_invoices si on si.id = il.invoice_id
                         where il.product_id = p.id and si.status = 'ISSUED' and si.invoice_date between v_from and v_to and (v_cust is null or si.customer_id = v_cust)) i on true
      where p.company_id = v_company and (v_prod is null or p.id = v_prod) and (o.q is not null or d.q is not null or i.q is not null)) z;
  elsif v_r = 'DISPATCH' then
    select jsonb_agg(x order by x ->> 'date', x ->> 'number') into v_rows from (select jsonb_build_object('date', (f.actual_dispatch_at at time zone v_tz)::date,
        'number', f.fulfilment_number, 'order_number', so.sales_order_number, 'customer', so.customer_name_snapshot, 'sku', p.sku, 'product_name', p.product_name,
        'quantity', fl.quantity_dispatched, 'unit', p.base_unit, 'vehicle', f.vehicle_number, 'status', f.fulfilment_status,
        'invoiced', private.so_v2_fulfilment_invoiced(f.id)) x
      from public.fulfilments f join public.fulfilment_lines fl on fl.fulfilment_id = f.id join public.sales_orders so on so.id = f.sales_order_id
      join public.products p on p.id = fl.product_id
      where f.company_id = v_company and f.actual_dispatch_at is not null and fl.quantity_dispatched > 0
        and (f.actual_dispatch_at at time zone v_tz)::date between v_from and v_to and (v_cust is null or so.customer_id = v_cust) and (v_prod is null or fl.product_id = v_prod)) z;
  elsif v_r = 'INVOICE_REGISTER' then
    select jsonb_agg(x order by x ->> 'date', x ->> 'invoice_number') into v_rows from (select jsonb_build_object('id', i.id, 'invoice_number', i.invoice_number,
        'date', i.invoice_date, 'customer', i.customer_legal_name, 'gstin', i.customer_gstin, 'type', i.invoice_type, 'taxable', i.taxable_subtotal,
        'cgst', i.cgst_total, 'sgst', i.sgst_total, 'igst', i.igst_total, 'grand_total', i.grand_total, 'paid', i.paid, 'balance', i.balance_due,
        'status', i.display_status, 'due_date', i.due_date) x
      from public.sales_invoice_list i where i.company_id = v_company and i.status in ('ISSUED', 'CANCELLED') and i.invoice_date between v_from and v_to
        and (v_cust is null or i.customer_id = v_cust)
        and (v_prod is null or exists (select 1 from public.sales_invoice_lines l where l.invoice_id = i.id and l.product_id = v_prod))) z;
  elsif v_r = 'GST_SUMMARY' then
    select jsonb_agg(x order by x ->> 'document', (x ->> 'gst_rate')::numeric nulls first, x ->> 'hsn_sac') into v_rows from (
      select jsonb_build_object('document', 'Invoices', 'hsn_sac', coalesce(l.hsn_sac, '—'), 'gst_rate', l.gst_rate, 'taxable', sum(l.taxable_value),
        'cgst', sum(l.cgst_amount), 'sgst', sum(l.sgst_amount), 'igst', sum(l.igst_amount), 'total', sum(l.line_total)) x
      from public.sales_invoice_lines l join public.sales_invoices i on i.id = l.invoice_id
      where i.company_id = v_company and i.status = 'ISSUED' and i.invoice_date between v_from and v_to and (v_cust is null or i.customer_id = v_cust)
        and (v_prod is null or l.product_id = v_prod)
      group by l.hsn_sac, l.gst_rate
      union all
      select jsonb_build_object('document', case n.note_type when 'CREDIT' then 'Credit notes (deduct)' else 'Debit notes (add)' end, 'hsn_sac', coalesce(nl.hsn_sac, '—'),
        'gst_rate', nl.gst_rate, 'taxable', sum(nl.taxable_amount), 'cgst', sum(nl.cgst_amount), 'sgst', sum(nl.sgst_amount), 'igst', sum(nl.igst_amount), 'total', sum(nl.line_total))
      from public.invoice_adjustment_note_lines nl join public.invoice_adjustment_notes n on n.id = nl.note_id
      where n.company_id = v_company and n.status = 'ISSUED' and n.note_date between v_from and v_to and (v_cust is null or n.customer_id = v_cust)
      group by n.note_type, nl.hsn_sac, nl.gst_rate) z;
  elsif v_r = 'CUSTOMER_OUTSTANDING' then
    select jsonb_agg(x order by (x ->> 'receivable')::numeric desc) into v_rows from (select jsonb_build_object('party_id', b.party_id, 'party_code', b.party_code,
        'customer', b.party_name, 'invoice_outstanding', b.invoice_outstanding, 'overdue', b.overdue, 'receivable', b.receivable,
        'open_invoices', (select count(*) from public.sales_invoices i where i.customer_id = b.customer_id and i.status = 'ISSUED' and private.invoice_balance(i.id) > 0)) x
      from private.party_balances(v_company) b where b.customer_id is not null and (v_cust is null or b.customer_id = v_cust)
        and (b.receivable <> 0 or b.invoice_outstanding <> 0)) z;
  elsif v_r = 'SUPPLIER_OUTSTANDING' then
    select jsonb_agg(x order by (x ->> 'payable')::numeric desc) into v_rows from (select jsonb_build_object('party_id', b.party_id, 'party_code', b.party_code,
        'supplier', b.party_name, 'received_value', (select coalesce(sum(private.goods_receipt_value(r.id)), 0) from public.goods_receipts r where r.supplier_id = b.supplier_id and r.status = 'POSTED'),
        'paid', (select coalesce(sum(amount), 0) from public.supplier_payments sp where sp.supplier_id = b.supplier_id and sp.status = 'RECORDED'),
        'payable', b.payable) x
      from private.party_balances(v_company) b where b.supplier_id is not null and (v_sup is null or b.supplier_id = v_sup) and b.payable <> 0) z;
  elsif v_r = 'PAYMENT_COLLECTION' then
    select jsonb_agg(x order by x ->> 'date', x ->> 'receipt_number') into v_rows from (select jsonb_build_object('id', p.id, 'receipt_number', p.receipt_number,
        'date', p.receipt_date, 'customer', c.customer_name, 'method', p.payment_method, 'reference', p.transaction_reference, 'amount', p.amount_received,
        'allocated', (select coalesce(sum(allocated_amount), 0) from public.invoice_payment_allocations a where a.payment_id = p.id and a.status = 'ACTIVE'),
        'invoices', (select string_agg(distinct i.invoice_number, ', ') from public.invoice_payment_allocations a join public.sales_invoices i on i.id = a.invoice_id
                     where a.payment_id = p.id and a.status = 'ACTIVE'),
        'status', p.status) x
      from public.customer_payments p join public.customers c on c.id = p.customer_id
      where p.company_id = v_company and p.receipt_date between v_from and v_to and (v_cust is null or p.customer_id = v_cust)) z;
  end if;

  v_rows := coalesce(v_rows, '[]'::jsonb);
  if v_search is not null then
    select coalesce(jsonb_agg(r), '[]'::jsonb) into v_rows from jsonb_array_elements(v_rows) r
    where exists (select 1 from jsonb_each_text(r) e where e.key not in ('id', 'product_id', 'party_id', 'customer_id', 'supplier_id') and e.value ilike '%' || v_search || '%');
  end if;
  return jsonb_build_object('report', v_r, 'from', v_from, 'to', v_to, 'generated_at', now(), 'count', jsonb_array_length(v_rows), 'rows', v_rows);
end;
$$;

-- -----------------------------------------------------------------------------
-- 11. Grants
-- -----------------------------------------------------------------------------
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.erp_preferences()', 'public.erp_settings_get()', 'public.erp_settings_save(jsonb, jsonb)',
    'public.management_overview(date, date)', 'public.module_dashboard(text, date, date)', 'public.global_search(text, int)',
    'public.activity_feed(date, date, text, text, int, int)', 'public.erp_reconciliation()', 'public.erp_report(text, jsonb)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;
