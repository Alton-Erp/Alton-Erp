-- =============================================================================
-- Support customer CRM: customer field builder, customer profile workspace, notes, activities, matching
--
-- Additive. Reuses:
--   * support_customers (the existing support customer record; no second customer table), its phones / emails
--     arrays and normalisation (matching keeps using normalized_phones / normalized_emails), its numbering (SC-…)
--     and its duplicate check (support_customer_save is called as it is).
--   * support_tickets.customer_id: the only ticket ↔ customer link (no copied history).
--   * support_ticket_field_definitions / support_ticket_field_layout of 20261226090000 with a module discriminator
--     (TICKET | CUSTOMER): one field system; definitions, layout and limits are separate per module. The ticket
--     functions keep their names and behaviour (thin wrappers over the generic ones).
--   * support_internal_notes (customer notes existed already): editing, soft delete and a revision history.
--   * support_audit_logs, support_ticket_events, support_ticket_stage_history, support_calls, email / WhatsApp
--     messages and support_ticket_products for the timeline: only real records, each linked to its source.
--
-- New: support_customer_field_values, support_customer_activities, support_note_revisions; customer columns
-- (contact person, mobile, alternate phone, landline, email, alternate email, GSTIN, type, category, city, state,
-- PIN code, country, assigned agent).
--
-- Permissions: support_customer_fields.view / create / update / delete (administrators),
--   support_customers.manage_notes (edit / delete anyone's customer notes), support_customers.manage_activities.
--   Viewing customers stays support.view; creating and editing them stays support.reply (existing).
--
-- Rollback: supabase/rollback/20261228090000_support_customer_crm_down.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Permissions
-- -----------------------------------------------------------------------------
insert into public.permissions (resource, action, description) values
  ('support_customer_fields', 'view', 'View the customer field builder (custom customer fields and the customer form layout)'),
  ('support_customer_fields', 'create', 'Create custom customer fields'),
  ('support_customer_fields', 'update', 'Edit custom customer fields and the customer form layout'),
  ('support_customer_fields', 'delete', 'Deactivate custom customer fields (their saved values are kept)'),
  ('support_customers', 'manage_notes', 'Edit and delete any customer note (authors can always edit and delete their own)'),
  ('support_customers', 'manage_activities', 'Create and update customer tasks, follow-ups, reminders, visits and service appointments')
on conflict (code) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.resource in ('support_customer_fields', 'support_customers')
where r.code in ('SUPER_ADMIN', 'ADMIN')
on conflict do nothing;
-- Agents follow their existing Support Centre access.
insert into public.role_permissions (role_id, permission_id)
select distinct rp.role_id, p.id from public.role_permissions rp join public.permissions src on src.id = rp.permission_id and src.code = 'support.manage_tickets'
join public.permissions p on p.code = 'support_customers.manage_notes'
on conflict do nothing;
insert into public.role_permissions (role_id, permission_id)
select distinct rp.role_id, p.id from public.role_permissions rp join public.permissions src on src.id = rp.permission_id and src.code = 'support.reply'
join public.permissions p on p.code = 'support_customers.manage_activities'
on conflict do nothing;

-- -----------------------------------------------------------------------------
-- 2. One field system, two modules
-- -----------------------------------------------------------------------------
alter table public.support_ticket_field_definitions add column if not exists module text not null default 'TICKET';
alter table public.support_ticket_field_layout add column if not exists module text not null default 'TICKET';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'support_ticket_field_definitions_module_check') then
    alter table public.support_ticket_field_definitions add constraint support_ticket_field_definitions_module_check check (module in ('TICKET', 'CUSTOMER'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'support_ticket_field_layout_module_check') then
    alter table public.support_ticket_field_layout add constraint support_ticket_field_layout_module_check check (module in ('TICKET', 'CUSTOMER'));
  end if;
end;
$$;
alter table public.support_ticket_field_definitions drop constraint if exists support_ticket_field_definitions_key_unique;
alter table public.support_ticket_field_definitions drop constraint if exists support_ticket_field_definitions_module_key_unique;
alter table public.support_ticket_field_definitions add constraint support_ticket_field_definitions_module_key_unique unique (company_id, module, field_key);
drop index if exists public.support_ticket_field_definitions_label_unique;
create unique index if not exists support_ticket_field_definitions_module_label_unique
  on public.support_ticket_field_definitions (company_id, module, lower(field_label)) where is_active;
alter table public.support_ticket_field_layout drop constraint if exists support_ticket_field_layout_standard_unique;
alter table public.support_ticket_field_layout drop constraint if exists support_ticket_field_layout_module_standard_unique;
alter table public.support_ticket_field_layout add constraint support_ticket_field_layout_module_standard_unique unique (company_id, module, standard_key);
alter table public.support_ticket_field_layout drop constraint if exists support_ticket_field_layout_standard_key_check;
alter table public.support_ticket_field_layout add constraint support_ticket_field_layout_standard_key_check check (standard_key is null or standard_key in (
  'subject', 'customer', 'products', 'customer_phone', 'customer_email', 'priority', 'assigned_agent', 'category', 'subcategory', 'department', 'description',
  'display_name', 'company_name', 'contact_person', 'mobile', 'alternate_phone', 'landline', 'email', 'alternate_email', 'gstin', 'customer_type',
  'customer_category', 'address', 'city', 'state', 'pin_code', 'country', 'erp_customer'));
create index if not exists support_ticket_field_definitions_module_idx on public.support_ticket_field_definitions (company_id, module, is_active);

-- Permission prefix of a module.
create or replace function private.support_field_permission(p_module text, p_action text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_module = 'TICKET' then return 'support_ticket_fields.' || p_action; end if;
  if p_module = 'CUSTOMER' then return 'support_customer_fields.' || p_action; end if;
  raise exception 'Unknown field module %.', p_module using errcode = 'P0001';
end;
$$;

-- Standard fields per module. default_visible: on the form until an administrator changes the layout.
create or replace function private.support_field_standard(p_module text)
returns table (standard_key text, label text, field_type text, default_order int, locked boolean, required boolean, required_editable boolean, default_visible boolean)
language sql
immutable
set search_path = ''
as $$
  select s.standard_key, s.label, s.field_type, s.default_order, s.locked, s.required, s.required_editable, true
  from private.support_ticket_standard_fields() s where p_module = 'TICKET'
  union all
  select * from (values
    ('display_name', 'Customer Name', 'TEXT', 10, true, true, false, true),
    ('company_name', 'Company Name', 'TEXT', 20, false, false, true, true),
    ('contact_person', 'Primary Contact Person', 'TEXT', 30, false, false, true, true),
    ('mobile', 'Mobile', 'PHONE', 40, false, false, true, true),
    ('alternate_phone', 'Alternate Phone', 'PHONE', 50, false, false, true, true),
    ('landline', 'Landline', 'PHONE', 60, false, false, true, false),
    ('email', 'Email', 'EMAIL', 70, false, false, true, true),
    ('alternate_email', 'Alternate Email', 'EMAIL', 80, false, false, true, false),
    ('gstin', 'GSTIN', 'TEXT', 90, false, false, true, true),
    ('customer_type', 'Customer Type', 'PICKLIST', 100, false, false, true, true),
    ('customer_category', 'Customer Category', 'TEXT', 110, false, false, true, true),
    ('address', 'Address', 'TEXTAREA', 120, false, false, true, true),
    ('city', 'City', 'TEXT', 130, false, false, true, true),
    ('state', 'State', 'TEXT', 140, false, false, true, true),
    ('pin_code', 'PIN Code', 'TEXT', 150, false, false, true, true),
    ('country', 'Country', 'TEXT', 160, false, false, true, true),
    ('assigned_agent', 'Assigned Support Agent', 'USER', 170, false, false, true, true),
    ('erp_customer', 'Related ERP Customer', 'LOOKUP', 180, false, false, true, true),
    ('description', 'Description', 'TEXTAREA', 190, false, false, true, true)
  ) c (standard_key, label, field_type, default_order, locked, required, required_editable, default_visible) where p_module = 'CUSTOMER';
$$;

create or replace function private.support_field_layout(p_company uuid, p_module text)
returns table (standard_key text, field_definition_id uuid, display_order int, is_visible boolean, is_required_override boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select s.standard_key, null::uuid, coalesce(l.display_order, s.default_order), coalesce(l.is_visible, s.default_visible) or s.locked, l.is_required_override
  from private.support_field_standard(p_module) s
  left join public.support_ticket_field_layout l on l.company_id = p_company and l.module = p_module and l.standard_key = s.standard_key
  union all
  select null, l.field_definition_id, l.display_order, l.is_visible, l.is_required_override
  from public.support_ticket_field_layout l where l.company_id = p_company and l.module = p_module and l.field_definition_id is not null;
$$;

create or replace function private.support_field_layout_stamp(p_company uuid, p_module text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select md5(coalesce(string_agg(concat_ws(':', coalesce(l.standard_key, l.field_definition_id::text), l.display_order, l.is_visible, l.is_required_override),
    ',' order by coalesce(l.standard_key, l.field_definition_id::text)), ''))
  from public.support_ticket_field_layout l where l.company_id = p_company and l.module = p_module;
$$;

-- The ticket helpers keep their names (used by the 20261226090000 functions) and now read the TICKET module only.
create or replace function private.support_ticket_layout(p_company uuid)
returns table (standard_key text, field_definition_id uuid, display_order int, is_visible boolean, is_required_override boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select * from private.support_field_layout(p_company, 'TICKET');
$$;

create or replace function private.support_ticket_layout_stamp(p_company uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select private.support_field_layout_stamp(p_company, 'TICKET');
$$;

-- -----------------------------------------------------------------------------
-- 3. Field functions for both modules (the 20261226090000 code, made module-aware; ticket names kept as wrappers)
-- -----------------------------------------------------------------------------
create or replace function private.support_ticket_field_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and (new.field_key <> old.field_key or new.field_type <> old.field_type or new.company_id <> old.company_id or new.module <> old.module) then
    raise exception 'The internal key and the type of a ticket field cannot be changed after it is created.' using errcode = 'P0001';
  end if;
  if new.is_active and (tg_op = 'INSERT' or not old.is_active) then
    -- One writer at a time per company, so two saves cannot both take the 25th place.
    perform pg_advisory_xact_lock(hashtextextended('support_fields:' || new.module || ':' || new.company_id::text, 0));
    if (select count(*) from public.support_ticket_field_definitions d where d.company_id = new.company_id and d.module = new.module and d.is_active and d.id <> new.id) >= 25 then
      raise exception 'A company can have at most 25 active custom % fields. Deactivate one first.', lower(new.module) using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

create or replace function private.support_field_config(p_company uuid, p_module text, p_type text, p_key text, p jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c jsonb := coalesce(p, '{}'::jsonb);
  r jsonb := '{}'::jsonb;
  v_min numeric;
  v_max numeric;
  o jsonb;
  v_options jsonb := '[]'::jsonb;
  v_ids text[] := '{}';
  v_labels text[] := '{}';
  v_id text;
  v_label text;
  v_ref text;
  v_ref_type text;
begin
  if jsonb_typeof(c) <> 'object' then
    raise exception 'Field settings must be an object.' using errcode = 'P0001';
  end if;
  case p_type
  when 'PICKLIST' then
    if jsonb_typeof(c -> 'options') is distinct from 'array' or jsonb_array_length(c -> 'options') = 0 then
      raise exception 'Add at least one option to the picklist.' using errcode = 'P0001';
    end if;
    if jsonb_array_length(c -> 'options') > 200 then
      raise exception 'A picklist can have at most 200 options.' using errcode = 'P0001';
    end if;
    for o in select * from jsonb_array_elements(c -> 'options') loop
      v_label := btrim(coalesce(case when jsonb_typeof(o) = 'string' then o #>> '{}' else o ->> 'label' end, ''));
      if v_label = '' or length(v_label) > 100 then
        raise exception 'Each picklist option needs a label of at most 100 characters.' using errcode = 'P0001';
      end if;
      if lower(v_label) = any (v_labels) then
        raise exception 'The picklist option "%" is listed twice.', v_label using errcode = 'P0001';
      end if;
      v_id := nullif(btrim(coalesce(case when jsonb_typeof(o) = 'object' then o ->> 'id' end, '')), '');
      if v_id is not null and v_id !~ '^[a-z0-9_]{1,40}$' then
        raise exception 'Picklist option ids may contain only a-z, 0-9 and _.' using errcode = 'P0001';
      end if;
      v_id := coalesce(v_id, 'opt_' || substr(md5(gen_random_uuid()::text), 1, 10));
      if v_id = any (v_ids) then
        raise exception 'Two picklist options have the same id.' using errcode = 'P0001';
      end if;
      v_ids := v_ids || v_id;
      v_labels := v_labels || lower(v_label);
      v_options := v_options || jsonb_build_array(jsonb_build_object('id', v_id, 'label', v_label));
    end loop;
    r := jsonb_build_object('options', v_options);
  when 'TEXT' then
    v_min := coalesce(private.support_ticket_num(c, 'min_length', 'The minimum length'), 0);
    v_max := coalesce(private.support_ticket_num(c, 'max_length', 'The maximum length'), 255);
    if v_min <> trunc(v_min) or v_max <> trunc(v_max) or v_min < 0 or v_max < 1 or v_max > 2000 then
      raise exception 'Text limits are whole numbers; the maximum is between 1 and 2000 characters.' using errcode = 'P0001';
    end if;
    if v_min > v_max then
      raise exception 'The minimum length cannot be more than the maximum length.' using errcode = 'P0001';
    end if;
    r := jsonb_build_object('min_length', v_min, 'max_length', v_max);
  when 'NUMBER' then
    v_min := private.support_ticket_num(c, 'min', 'The minimum value');
    v_max := private.support_ticket_num(c, 'max', 'The maximum value');
    if coalesce(c ->> 'number_kind', 'DECIMAL') not in ('INTEGER', 'DECIMAL') then
      raise exception 'A number is a whole number (integer) or a decimal.' using errcode = 'P0001';
    end if;
    r := jsonb_build_object('number_kind', coalesce(c ->> 'number_kind', 'DECIMAL'),
      'decimals', case when coalesce(c ->> 'number_kind', 'DECIMAL') = 'INTEGER' then 0
                       else least(greatest(coalesce(private.support_ticket_num(c, 'decimals', 'Decimals'), 2), 0), 6)::int end,
      'min', v_min, 'max', v_max);
    if v_min is not null and v_max is not null and v_min > v_max then
      raise exception 'The minimum value cannot be more than the maximum value.' using errcode = 'P0001';
    end if;
  when 'CURRENCY' then
    v_min := private.support_ticket_num(c, 'min', 'The minimum amount');
    v_max := private.support_ticket_num(c, 'max', 'The maximum amount');
    if v_min is not null and v_max is not null and v_min > v_max then
      raise exception 'The minimum amount cannot be more than the maximum amount.' using errcode = 'P0001';
    end if;
    if upper(coalesce(nullif(c ->> 'currency', ''), 'INR')) !~ '^[A-Z]{3}$' then
      raise exception 'The currency is a three-letter code such as INR.' using errcode = 'P0001';
    end if;
    r := jsonb_build_object('currency', upper(coalesce(nullif(c ->> 'currency', ''), 'INR')), 'min', v_min, 'max', v_max);
  when 'LOOKUP' then
    if coalesce(c ->> 'target', '') not in ('PRODUCT', 'SUPPORT_CUSTOMER', 'ERP_CUSTOMER', 'SALES_ORDER', 'INVOICE', 'SUPPORT_TICKET') then
      raise exception 'Choose what the lookup links to: product, support customer, ERP customer, sales order, invoice or support ticket.' using errcode = 'P0001';
    end if;
    r := jsonb_build_object('target', c ->> 'target');
  when 'FORMULA' then
    foreach v_ref in array private.support_ticket_formula_refs(c ->> 'expression') loop
      if v_ref = p_key then
        raise exception 'A formula cannot use its own field.' using errcode = 'P0001';
      end if;
      select field_type into v_ref_type from public.support_ticket_field_definitions where company_id = p_company and module = p_module and field_key = v_ref;
      if v_ref_type is null then
        raise exception 'The formula uses {%}, which is not a field of this form.', v_ref using errcode = 'P0001';
      end if;
      if v_ref_type not in ('NUMBER', 'CURRENCY') then
        raise exception 'The formula can only use number and currency fields; {%} is not one.', v_ref using errcode = 'P0001';
      end if;
    end loop;
    if coalesce(c ->> 'result_kind', 'NUMBER') not in ('NUMBER', 'CURRENCY') then
      raise exception 'A formula shows a number or an amount.' using errcode = 'P0001';
    end if;
    r := jsonb_build_object('expression', btrim(c ->> 'expression'), 'result_kind', coalesce(c ->> 'result_kind', 'NUMBER'),
      'decimals', least(greatest(coalesce(private.support_ticket_num(c, 'decimals', 'Decimals'), 2), 0), 6)::int,
      'currency', upper(coalesce(nullif(c ->> 'currency', ''), 'INR')));
    if r ->> 'currency' !~ '^[A-Z]{3}$' then
      raise exception 'The currency is a three-letter code such as INR.' using errcode = 'P0001';
    end if;
  when 'USER' then
    if coalesce(c ->> 'scope', 'EMPLOYEES') not in ('EMPLOYEES', 'AGENTS') then
      raise exception 'A user field lists active employees or support agents.' using errcode = 'P0001';
    end if;
    r := jsonb_build_object('scope', coalesce(c ->> 'scope', 'EMPLOYEES'));
  else
    r := '{}'::jsonb; -- DATE, EMAIL, PHONE, URL, CHECKBOX: nothing to configure
  end case;
  return jsonb_strip_nulls(r);
end;
$$;

create or replace function private.support_ticket_field_config(p_company uuid, p_type text, p_key text, p jsonb)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select private.support_field_config(p_company, 'TICKET', p_type, p_key, p);
$$;

create or replace function private.support_ticket_values_apply(p_company uuid, p_ticket uuid, p_values jsonb, p_create boolean)
returns text[]
language plpgsql
security definer
set search_path = ''
as $$
declare
  v jsonb := coalesce(p_values, '{}'::jsonb);
  d public.support_ticket_field_definitions;
  k text;
  v_val jsonb;
  v_old jsonb;
  v_required boolean;
  v_in_form boolean;
  v_missing text[] := '{}';
  v_changed text[] := '{}';
begin
  if jsonb_typeof(v) <> 'object' then
    raise exception 'Custom field values must be an object of field keys.' using errcode = 'P0001';
  end if;
  for k in select jsonb_object_keys(v) loop
    if not exists (select 1 from public.support_ticket_field_definitions where company_id = p_company and module = 'TICKET' and field_key = k) then
      raise exception 'Unknown ticket field "%".', k using errcode = 'P0001';
    end if;
  end loop;
  for d in select * from public.support_ticket_field_definitions where company_id = p_company and module = 'TICKET' order by created_at loop
    select l.is_visible, coalesce(l.is_required_override, d.is_required) into v_in_form, v_required
    from private.support_ticket_layout(p_company) l where l.field_definition_id = d.id;
    v_in_form := coalesce(v_in_form, false) and d.is_active;
    v_required := v_in_form and coalesce(v_required, d.is_required) and d.field_type not in ('CHECKBOX', 'FORMULA');
    if not (v ? d.field_key) then
      if p_create and v_in_form and d.default_value is not null and d.field_type <> 'FORMULA' then
        v_val := private.support_ticket_field_value(d, d.default_value);
      elsif p_create and v_required then
        v_missing := v_missing || d.field_label;
        continue;
      else
        continue;
      end if;
    else
      if not d.is_active and v -> d.field_key <> 'null'::jsonb then
        select value_json into v_old from public.support_ticket_field_values where ticket_id = p_ticket and field_definition_id = d.id;
        if v_old is distinct from private.support_ticket_field_value(d, v -> d.field_key) then
          raise exception '% is no longer in use; its saved value can be seen but not changed.', d.field_label using errcode = 'P0001';
        end if;
        continue;
      end if;
      v_val := private.support_ticket_field_value(d, v -> d.field_key);
      if v_val is null and v_required then
        v_missing := v_missing || d.field_label;
        continue;
      end if;
    end if;
    select value_json into v_old from public.support_ticket_field_values where ticket_id = p_ticket and field_definition_id = d.id;
    if v_val is null then
      if v_old is not null then
        delete from public.support_ticket_field_values where ticket_id = p_ticket and field_definition_id = d.id;
        v_changed := v_changed || d.field_key;
      end if;
    elsif v_old is distinct from v_val then
      insert into public.support_ticket_field_values (company_id, ticket_id, field_definition_id, value_json, created_by, updated_by)
      values (p_company, p_ticket, d.id, v_val, auth.uid(), auth.uid())
      on conflict (ticket_id, field_definition_id) do update set value_json = excluded.value_json, updated_by = auth.uid();
      v_changed := v_changed || d.field_key;
    end if;
  end loop;
  if cardinality(v_missing) > 0 then
    raise exception 'Fill in the required fields: %.', array_to_string(v_missing, ', ') using errcode = 'P0001';
  end if;
  return v_changed;
end;
$$;

create or replace function public.support_fields_admin(p_module text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission(private.support_field_permission(p_module, 'view'));
begin
  return jsonb_build_object(
    'module', p_module, 'stamp', private.support_field_layout_stamp(v_company, p_module),
    'max_custom', 25,
    'active_custom', (select count(*) from public.support_ticket_field_definitions where company_id = v_company and module = p_module and is_active),
    'standard', (select jsonb_agg(jsonb_build_object('standard_key', s.standard_key, 'label', s.label, 'field_type', s.field_type, 'locked', s.locked,
        'required', s.required, 'required_editable', s.required_editable, 'default_visible', s.default_visible) order by s.default_order) from private.support_field_standard(p_module) s),
    'definitions', coalesce((select jsonb_agg(private.support_ticket_field_json(d) || jsonb_build_object(
        'value_count', (case when p_module = 'TICKET' then (select count(*) from public.support_ticket_field_values v where v.field_definition_id = d.id)
                           else (select count(*) from public.support_customer_field_values v where v.field_definition_id = d.id) end)) order by d.created_at)
      from public.support_ticket_field_definitions d where d.company_id = v_company and d.module = p_module), '[]'::jsonb),
    'layout', coalesce((select jsonb_agg(jsonb_build_object('standard_key', l.standard_key, 'field_definition_id', l.field_definition_id,
        'display_order', l.display_order, 'is_visible', l.is_visible, 'is_required_override', l.is_required_override)
        order by l.display_order, l.standard_key nulls last) from private.support_field_layout(v_company, p_module) l), '[]'::jsonb),
    'can', jsonb_build_object('create', private.has_permission(v_company, private.support_field_permission(p_module, 'create')),
      'update', private.has_permission(v_company, private.support_field_permission(p_module, 'update')),
      'delete', private.has_permission(v_company, private.support_field_permission(p_module, 'delete'))));
end;
$$;

create or replace function public.support_ticket_fields_admin()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  -- Runs as the caller; support_fields_admin checks the permission.
  select public.support_fields_admin('TICKET');
$$;

create or replace function public.support_field_save(p_module text, p_id uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission(private.support_field_permission(p_module, 'view'));
  d public.support_ticket_field_definitions;
  v_new public.support_ticket_field_definitions;
  v_label text := private.support_text(p, 'field_label', 80);
  v_type text;
  v_key text;
  v_base text;
  v_n int := 1;
  v_active boolean;
  v_default jsonb;
begin
  if p_id is null then
    perform private.require_permission(private.support_field_permission(p_module, 'create'));
    v_type := upper(coalesce(p ->> 'field_type', ''));
    if v_type not in ('PICKLIST', 'TEXT', 'NUMBER', 'LOOKUP', 'FORMULA', 'DATE', 'CURRENCY', 'EMAIL', 'PHONE', 'URL', 'CHECKBOX', 'USER') then
      raise exception 'Choose the field type.' using errcode = 'P0001';
    end if;
    if v_label is null then
      raise exception 'Enter the field label.' using errcode = 'P0001';
    end if;
    v_base := 'cf_' || left(trim(both '_' from regexp_replace(lower(v_label), '[^a-z0-9]+', '_', 'g')), 34);
    if v_base = 'cf_' then v_base := 'cf_field'; end if;
    v_key := v_base;
    while exists (select 1 from public.support_ticket_field_definitions where company_id = v_company and module = p_module and field_key = v_key) loop
      v_n := v_n + 1;
      v_key := v_base || '_' || v_n;
    end loop;
    d.company_id := v_company;
    d.module := p_module;
    d.field_key := v_key;
    d.field_type := v_type;
    d.is_active := true;
  else
    select * into d from public.support_ticket_field_definitions where id = p_id and company_id = v_company and module = p_module for update;
    if not found then
      raise exception 'Ticket field not found in your company.' using errcode = 'P0001';
    end if;
    if p ? 'field_type' and upper(p ->> 'field_type') <> d.field_type then
      raise exception 'The type of a ticket field cannot be changed after it is created (saved values would no longer fit). Create a new field instead.' using errcode = 'P0001';
    end if;
    if p ? 'field_key' and p ->> 'field_key' <> d.field_key then
      raise exception 'The internal key of a ticket field cannot be changed.' using errcode = 'P0001';
    end if;
    v_active := case when p ? 'is_active' then (p ->> 'is_active')::boolean else d.is_active end;
    if v_active is distinct from d.is_active then
      perform private.require_permission(private.support_field_permission(p_module, case when v_active then 'update' else 'delete' end));
    end if;
    if (p - 'is_active') <> '{}'::jsonb then
      perform private.require_permission(private.support_field_permission(p_module, 'update'));
    end if;
    if p ? 'field_label' and v_label is null then
      raise exception 'Enter the field label.' using errcode = 'P0001';
    end if;
    d.is_active := v_active;
  end if;

  if p ? 'field_label' or p_id is null then d.field_label := v_label; end if;
  if p ? 'field_config' or p_id is null then
    d.field_config := private.support_field_config(v_company, p_module, d.field_type, d.field_key, p -> 'field_config');
  end if;
  if p ? 'is_required' then d.is_required := coalesce((p ->> 'is_required')::boolean, false); end if;
  d.is_required := coalesce(d.is_required, false);
  if d.is_required and d.field_type in ('CHECKBOX', 'FORMULA') then
    raise exception '% fields cannot be required.', initcap(d.field_type) using errcode = 'P0001';
  end if;
  if p ? 'help_text' then d.help_text := private.support_text(p, 'help_text', 300); end if;
  if p ? 'placeholder' then d.placeholder := private.support_text(p, 'placeholder', 120); end if;
  if p ? 'visibility' then
    d.visibility := upper(coalesce(p ->> 'visibility', 'ALL_AGENTS'));
    if d.visibility not in ('ALL_AGENTS', 'TICKET_MANAGERS') then
      raise exception 'Visibility is every support user or only users who manage tickets.' using errcode = 'P0001';
    end if;
  end if;
  d.visibility := coalesce(d.visibility, 'ALL_AGENTS');
  if p ? 'default_value' or (p ? 'field_config' and d.default_value is not null) then
    v_default := case when p ? 'default_value' then p -> 'default_value' else d.default_value end;
    if v_default is not null and v_default <> 'null'::jsonb and d.field_type in ('FORMULA', 'LOOKUP', 'USER') then
      raise exception '% fields have no default value.', initcap(d.field_type) using errcode = 'P0001';
    end if;
    d.default_value := private.support_ticket_field_value(d, v_default);
  end if;

  if p_id is null then
    insert into public.support_ticket_field_definitions (company_id, module, field_label, field_key, field_type, field_config, is_required, is_active, default_value,
      help_text, placeholder, visibility, created_by, updated_by)
    values (v_company, p_module, d.field_label, d.field_key, d.field_type, d.field_config, d.is_required, true, d.default_value, d.help_text, d.placeholder, d.visibility,
      auth.uid(), auth.uid())
    returning * into v_new;
  else
    update public.support_ticket_field_definitions set field_label = d.field_label, field_config = d.field_config, is_required = d.is_required,
      is_active = d.is_active, default_value = d.default_value, help_text = d.help_text, placeholder = d.placeholder, visibility = d.visibility,
      deactivated_at = case when d.is_active then null else coalesce(deactivated_at, now()) end,
      deactivated_by = case when d.is_active then null else coalesce(deactivated_by, auth.uid()) end,
      updated_by = auth.uid()
    where id = p_id
    returning * into v_new;
    if not v_new.is_active then
      update public.support_ticket_field_layout set is_visible = false, updated_by = auth.uid() where field_definition_id = p_id and is_visible;
    end if;
  end if;
  perform private.support_audit(v_company, lower(p_module) || case when p_id is null then '_field.created' else '_field.updated' end, lower(p_module) || '_field', v_new.id::text,
    jsonb_build_object('field_key', v_new.field_key, 'field_type', v_new.field_type, 'is_active', v_new.is_active));
  return private.support_ticket_field_json(v_new);
end;
$$;

create or replace function public.support_ticket_field_save(p_id uuid, p jsonb)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select public.support_field_save('TICKET', p_id, p);
$$;

create or replace function public.support_fields_save_layout(p_module text, p_used jsonb, p_stamp text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission(private.support_field_permission(p_module, 'update'));
  it jsonb;
  i int := 0;
  s record;
  d public.support_ticket_field_definitions;
  v_seen text[] := '{}';
  v_target text;
  v_req boolean;
begin
  perform pg_advisory_xact_lock(hashtextextended('support_layout:' || p_module || ':' || v_company::text, 0));
  if p_stamp is distinct from private.support_field_layout_stamp(v_company, p_module) then
    raise exception 'Someone else changed the ticket fields since you opened this page. Reload to see their changes, then make yours again.' using errcode = 'P0001';
  end if;
  if jsonb_typeof(p_used) is distinct from 'array' then
    raise exception 'The layout must be a list of fields.' using errcode = 'P0001';
  end if;
  for it in select * from jsonb_array_elements(p_used) loop
    i := i + 1;
    v_target := coalesce(it ->> 'standard_key', it ->> 'field_definition_id');
    if v_target is null or v_target = any (v_seen) then
      raise exception 'Each field can be on the form once.' using errcode = 'P0001';
    end if;
    v_seen := v_seen || v_target;
    v_req := case when it ? 'is_required' and it -> 'is_required' <> 'null'::jsonb then (it ->> 'is_required')::boolean end;
    if it ? 'standard_key' then
      select * into s from private.support_field_standard(p_module) f where f.standard_key = it ->> 'standard_key';
      if s.standard_key is null then
        raise exception 'Unknown standard field "%".', it ->> 'standard_key' using errcode = 'P0001';
      end if;
      if v_req is not null and not s.required_editable and v_req is distinct from s.required then
        raise exception '% cannot be made % here.', s.label, case when v_req then 'required' else 'optional' end using errcode = 'P0001';
      end if;
      insert into public.support_ticket_field_layout (company_id, module, standard_key, display_order, is_visible, is_required_override, updated_by)
      values (v_company, p_module, s.standard_key, i * 10, true, case when s.required_editable then v_req end, auth.uid())
      on conflict (company_id, module, standard_key) do update set display_order = excluded.display_order, is_visible = true,
        is_required_override = excluded.is_required_override, updated_by = auth.uid();
    else
      select * into d from public.support_ticket_field_definitions where id = (it ->> 'field_definition_id')::uuid and company_id = v_company and module = p_module;
      if d.id is null then
        raise exception 'Ticket field not found in your company.' using errcode = 'P0001';
      end if;
      if not d.is_active then
        raise exception '% is inactive. Activate it before putting it on the form.', d.field_label using errcode = 'P0001';
      end if;
      if v_req and d.field_type in ('CHECKBOX', 'FORMULA') then
        raise exception '% fields cannot be required.', initcap(d.field_type) using errcode = 'P0001';
      end if;
      insert into public.support_ticket_field_layout (company_id, module, field_definition_id, display_order, is_visible, is_required_override, updated_by)
      values (v_company, p_module, d.id, i * 10, true, v_req, auth.uid())
      on conflict (company_id, field_definition_id) do update set display_order = excluded.display_order, is_visible = true,
        is_required_override = excluded.is_required_override, updated_by = auth.uid();
      d := null;
    end if;
    s := null;
  end loop;
  for s in select * from private.support_field_standard(p_module) f where f.locked loop
    if not (s.standard_key = any (v_seen)) then
      raise exception '% is always on the New Ticket form.', s.label using errcode = 'P0001';
    end if;
  end loop;
  -- Fields taken off the form: kept (with their last place), hidden. Their saved values are untouched.
  insert into public.support_ticket_field_layout (company_id, module, standard_key, display_order, is_visible, updated_by)
  select v_company, p_module, f.standard_key, 100000, false, auth.uid() from private.support_field_standard(p_module) f
  where not (f.standard_key = any (v_seen))
  on conflict (company_id, module, standard_key) do update set is_visible = false, updated_by = auth.uid();
  update public.support_ticket_field_layout set is_visible = false, updated_by = auth.uid()
  where company_id = v_company and module = p_module and field_definition_id is not null and not (field_definition_id::text = any (v_seen)) and is_visible;
  perform private.support_audit(v_company, lower(p_module) || '_field.layout_saved', lower(p_module) || '_field_layout', null, jsonb_build_object('fields', to_jsonb(v_seen)));
  return jsonb_build_object('stamp', private.support_field_layout_stamp(v_company, p_module));
end;
$$;

create or replace function public.support_ticket_fields_save_layout(p_used jsonb, p_stamp text)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select public.support_fields_save_layout('TICKET', p_used, p_stamp);
$$;

create or replace function public.support_ticket_form()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.view');
  v_manager boolean := private.has_permission(v_company, 'support.manage_tickets');
begin
  return jsonb_build_object(
    'fields', coalesce((select jsonb_agg(x.f order by x.o, x.k) from (
        select l.display_order o, s.standard_key k, jsonb_build_object('kind', 'STANDARD', 'standard_key', s.standard_key, 'label', s.label, 'field_type', s.field_type,
          'locked', s.locked, 'required', case when s.required_editable then coalesce(l.is_required_override, false) else s.required end) f
        from private.support_ticket_layout(v_company) l join private.support_ticket_standard_fields() s on s.standard_key = l.standard_key
        where l.is_visible
        union all
        select l.display_order, d.field_key, private.support_ticket_field_json(d) || jsonb_build_object('kind', 'CUSTOM',
          'required', coalesce(l.is_required_override, d.is_required) and d.field_type not in ('CHECKBOX', 'FORMULA'))
        from private.support_ticket_layout(v_company) l join public.support_ticket_field_definitions d on d.id = l.field_definition_id
        where l.is_visible and d.is_active and (v_manager or d.visibility = 'ALL_AGENTS')) x), '[]'::jsonb),
    -- Formulas may use number fields that are not on the form; their definitions are needed to calculate.
    'formula_inputs', coalesce((select jsonb_agg(jsonb_build_object('field_key', d.field_key, 'field_type', d.field_type))
        from public.support_ticket_field_definitions d where d.company_id = v_company and d.module = 'TICKET' and d.field_type in ('NUMBER', 'CURRENCY')), '[]'::jsonb),
    'products', jsonb_build_object('view', private.has_permission(v_company, 'support_ticket_products.view'),
      'manage', private.has_permission(v_company, 'support_ticket_products.manage') and private.has_permission(v_company, 'products.read'),
      'archived', private.has_permission(v_company, 'products.update')));
end;
$$;

create or replace function public.support_ticket_extras(p_ticket uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.view');
  v_manager boolean := private.has_permission(v_company, 'support.manage_tickets');
  v_products boolean := private.has_permission(v_company, 'support_ticket_products.view');
  t public.support_tickets;
begin
  select * into t from public.support_tickets where id = p_ticket and company_id = v_company;
  if not found then
    raise exception 'Ticket not found in your company.' using errcode = 'P0001';
  end if;
  return jsonb_build_object(
    'fields', coalesce((select jsonb_agg(private.support_ticket_field_json(d) || jsonb_build_object('value', v.value_json, 'in_form', coalesce(l.is_visible, false) and d.is_active,
        'required', coalesce(l.is_visible, false) and d.is_active and coalesce(l.is_required_override, d.is_required) and d.field_type not in ('CHECKBOX', 'FORMULA'))
        order by coalesce(l.is_visible, false) and d.is_active desc, l.display_order nulls last, d.created_at)
      from public.support_ticket_field_definitions d
      left join public.support_ticket_field_values v on v.field_definition_id = d.id and v.ticket_id = t.id
      left join private.support_ticket_layout(v_company) l on l.field_definition_id = d.id
      where d.company_id = v_company and d.module = 'TICKET' and (v_manager or d.visibility = 'ALL_AGENTS')
        and ((coalesce(l.is_visible, false) and d.is_active) or v.id is not null)), '[]'::jsonb),
    'formula_inputs', coalesce((select jsonb_object_agg(d.field_key, v.value_json)
        from public.support_ticket_field_definitions d join public.support_ticket_field_values v on v.field_definition_id = d.id and v.ticket_id = t.id
        where d.company_id = v_company and d.module = 'TICKET' and d.field_type in ('NUMBER', 'CURRENCY')), '{}'::jsonb),
    'products', case when v_products then coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'product_id', x.product_id, 'quantity', x.quantity,
        'product_name', coalesce(pr.product_name, x.product_name_snapshot), 'sku', coalesce(pr.sku, x.sku_snapshot),
        'product_name_snapshot', x.product_name_snapshot, 'sku_snapshot', x.sku_snapshot, 'model_number', pr.model_number, 'barcode', pr.barcode, 'ean', pr.ean,
        'base_unit', pr.base_unit, 'archived', pr.status <> 'ACTIVE' or pr.archived_at is not null, 'added_at', x.created_at,
        'added_by', (select coalesce(u.full_name, u.email) from public.profiles u where u.id = x.created_by)) order by x.created_at, x.sku_snapshot)
      from public.support_ticket_products x left join public.products pr on pr.id = x.product_id
      where x.ticket_id = t.id), '[]'::jsonb) end,
    'can', jsonb_build_object('edit_fields', v_manager and t.status <> 'CLOSED' and t.merged_into_ticket_id is null,
      'manage_products', private.has_permission(v_company, 'support_ticket_products.manage') and private.has_permission(v_company, 'products.read')
        and t.status <> 'CLOSED' and t.merged_into_ticket_id is null,
      'archived_products', private.has_permission(v_company, 'products.update')));
end;
$$;

revoke all on function private.support_field_config(uuid, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.support_fields_admin(text), public.support_field_save(text, uuid, jsonb), public.support_fields_save_layout(text, jsonb, text) from public, anon;
grant execute on function public.support_fields_admin(text), public.support_field_save(text, uuid, jsonb), public.support_fields_save_layout(text, jsonb, text) to authenticated;

-- -----------------------------------------------------------------------------
-- 4. Customer record: standard fields (phones / emails arrays stay the matching source)
-- -----------------------------------------------------------------------------
alter table public.support_customers add column if not exists contact_person text check (contact_person is null or length(contact_person) <= 120);
alter table public.support_customers add column if not exists mobile text check (mobile is null or length(mobile) <= 30);
alter table public.support_customers add column if not exists alternate_phone text check (alternate_phone is null or length(alternate_phone) <= 30);
alter table public.support_customers add column if not exists landline text check (landline is null or length(landline) <= 30);
alter table public.support_customers add column if not exists email text check (email is null or length(email) <= 320);
alter table public.support_customers add column if not exists alternate_email text check (alternate_email is null or length(alternate_email) <= 320);
alter table public.support_customers add column if not exists gstin text check (gstin is null or gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$');
alter table public.support_customers add column if not exists customer_type text check (customer_type is null or length(customer_type) <= 40);
alter table public.support_customers add column if not exists customer_category text check (customer_category is null or length(customer_category) <= 80);
alter table public.support_customers add column if not exists city text check (city is null or length(city) <= 80);
alter table public.support_customers add column if not exists state text check (state is null or length(state) <= 80);
alter table public.support_customers add column if not exists pin_code text check (pin_code is null or length(pin_code) <= 12);
alter table public.support_customers add column if not exists country text check (country is null or length(country) <= 80);
alter table public.support_customers add column if not exists assigned_agent_id uuid;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'support_customers_agent_fk') then
    alter table public.support_customers add constraint support_customers_agent_fk foreign key (assigned_agent_id, company_id)
      references public.support_agents (id, company_id) on delete restrict;
  end if;
end;
$$;
create index if not exists support_customers_agent_idx on public.support_customers (company_id, assigned_agent_id) where assigned_agent_id is not null;
create index if not exists support_customers_type_idx on public.support_customers (company_id, customer_type) where customer_type is not null;

-- Mobile / alternate / landline and email / alternate email are labels on entries of the phones / emails arrays:
-- an entry removed from the arrays (an older editor) clears its label; a customer without a mobile or email
-- gets the first remaining entry. Runs after support_customers_normalize (trims, de-duplicates).
create or replace function private.support_customer_contacts()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.mobile is not null and not (btrim(new.mobile) = any (new.phones)) then new.mobile := null; end if;
  if new.alternate_phone is not null and not (btrim(new.alternate_phone) = any (new.phones)) then new.alternate_phone := null; end if;
  if new.landline is not null and not (btrim(new.landline) = any (new.phones)) then new.landline := null; end if;
  if new.email is not null and not (lower(btrim(new.email)) = any (new.emails)) then new.email := null; end if;
  if new.alternate_email is not null and not (lower(btrim(new.alternate_email)) = any (new.emails)) then new.alternate_email := null; end if;
  new.mobile := coalesce(btrim(new.mobile), (select x from unnest(new.phones) x where x is distinct from btrim(new.alternate_phone) and x is distinct from btrim(new.landline) limit 1));
  new.email := coalesce(lower(btrim(new.email)), (select x from unnest(new.emails) x where x is distinct from lower(btrim(new.alternate_email)) limit 1));
  return new;
end;
$$;
drop trigger if exists support_customers_zz_contacts on public.support_customers;
create trigger support_customers_zz_contacts before insert or update of phones, emails, mobile, alternate_phone, landline, email, alternate_email on public.support_customers
  for each row execute function private.support_customer_contacts();

-- Existing customers: labels taken from their stored lists (the rows' own data, updated_at and history untouched).
alter table public.support_customers disable trigger user;
update public.support_customers set mobile = phones[1], alternate_phone = phones[2], email = emails[1], alternate_email = emails[2]
where mobile is null and email is null and (cardinality(phones) > 0 or cardinality(emails) > 0);
alter table public.support_customers enable trigger user;

-- Matching through the GIN indexes (same result as before, phones include the landline).
create or replace function private.support_match_customers(p_company uuid, p_phone text, p_email text)
returns table (customer_id uuid, matched_on text[])
language sql
stable
security definer
set search_path = ''
as $$
  with keys as (select private.support_normalize_phone(p_phone) as ph, private.support_normalize_email(p_email) as em)
  select c.id, array_remove(array[case when k.ph is not null and c.normalized_phones @> array[k.ph] then 'phone' end,
                                  case when k.em is not null and c.normalized_emails @> array[k.em] then 'email' end], null)
  from public.support_customers c cross join keys k
  where c.company_id = p_company and c.is_active
    and ((k.ph is not null and c.normalized_phones @> array[k.ph]) or (k.em is not null and c.normalized_emails @> array[k.em]))
  order by c.created_at;
$$;

-- -----------------------------------------------------------------------------
-- 5. Customer custom field values, notes history, activities
-- -----------------------------------------------------------------------------
create table if not exists public.support_customer_field_values (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references public.companies (id) on delete restrict,
  customer_id           uuid not null,
  field_definition_id   uuid not null,
  value_json            jsonb not null check (value_json <> 'null'::jsonb and length(value_json::text) <= 4000),
  created_by            uuid,
  updated_by            uuid,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint support_customer_field_values_customer_fk foreign key (customer_id, company_id) references public.support_customers (id, company_id) on delete restrict,
  constraint support_customer_field_values_definition_fk foreign key (field_definition_id, company_id)
    references public.support_ticket_field_definitions (id, company_id) on delete restrict,
  constraint support_customer_field_values_unique unique (customer_id, field_definition_id)
);
create index if not exists support_customer_field_values_company_idx on public.support_customer_field_values (company_id, field_definition_id);

alter table public.support_internal_notes add column if not exists updated_by uuid;
alter table public.support_internal_notes add column if not exists edited_at timestamptz;
alter table public.support_internal_notes add column if not exists deleted_at timestamptz;
alter table public.support_internal_notes add column if not exists deleted_by uuid;
create index if not exists support_internal_notes_customer_idx on public.support_internal_notes (customer_id, created_at) where customer_id is not null;

-- Earlier text of an edited or deleted customer note (append-only).
create table if not exists public.support_note_revisions (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies (id) on delete restrict,
  note_id     uuid not null references public.support_internal_notes (id) on delete restrict,
  body        text not null,
  action      text not null check (action in ('EDITED', 'DELETED')),
  changed_by  uuid,
  changed_at  timestamptz not null default now()
);
create index if not exists support_note_revisions_note_idx on public.support_note_revisions (note_id, changed_at);

create table if not exists public.support_customer_activities (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies (id) on delete restrict,
  customer_id       uuid not null,
  ticket_id         uuid,
  activity_type     text not null check (activity_type in ('TASK', 'FOLLOW_UP', 'REMINDER', 'VISIT', 'SERVICE_APPOINTMENT')),
  title             text not null check (length(btrim(title)) between 1 and 200),
  description       text check (description is null or length(description) <= 2000),
  due_at            timestamptz,
  assigned_user_id  uuid,
  priority          text not null default 'NORMAL' check (priority in ('LOW', 'NORMAL', 'HIGH', 'URGENT')),
  status            text not null default 'OPEN' check (status in ('OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED')),
  completed_at      timestamptz,
  created_by        uuid,
  updated_by        uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint support_customer_activities_customer_fk foreign key (customer_id, company_id) references public.support_customers (id, company_id) on delete restrict,
  constraint support_customer_activities_ticket_fk foreign key (ticket_id, company_id) references public.support_tickets (id, company_id) on delete restrict,
  constraint support_customer_activities_user_fk foreign key (assigned_user_id, company_id) references public.profiles (id, company_id) on delete restrict,
  constraint support_customer_activities_done check ((status = 'DONE') = (completed_at is not null))
);
create index if not exists support_customer_activities_customer_idx on public.support_customer_activities (customer_id, status, due_at);
create index if not exists support_customer_activities_assignee_idx on public.support_customer_activities (company_id, assigned_user_id, status) where assigned_user_id is not null;

do $$
declare
  t text;
begin
  foreach t in array array['support_customer_field_values', 'support_note_revisions', 'support_customer_activities'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant all on table public.%I to service_role', t);
    execute format('grant select on table public.%I to authenticated', t);
  end loop;
  foreach t in array array['support_customer_field_values', 'support_customer_activities'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_set_updated_at', t);
    execute format('create trigger %I before update on public.%I for each row execute function private.set_updated_at()', t || '_set_updated_at', t);
    execute format('drop trigger if exists %I on public.%I', t || '_audit', t);
    execute format('create trigger %I after insert or update or delete on public.%I for each row execute function private.support_audit_row()', t || '_audit', t);
  end loop;
end;
$$;
drop policy if exists support_customer_field_values_select on public.support_customer_field_values;
create policy support_customer_field_values_select on public.support_customer_field_values for select to authenticated
  using (private.has_permission(company_id, 'support.view')
         and (private.has_permission(company_id, 'support.manage_tickets')
              or exists (select 1 from public.support_ticket_field_definitions d where d.id = field_definition_id and d.visibility = 'ALL_AGENTS')));
drop policy if exists support_note_revisions_select on public.support_note_revisions;
create policy support_note_revisions_select on public.support_note_revisions for select to authenticated using (private.has_permission(company_id, 'support.view'));
drop policy if exists support_customer_activities_select on public.support_customer_activities;
create policy support_customer_activities_select on public.support_customer_activities for select to authenticated using (private.has_permission(company_id, 'support.view'));

create or replace function private.support_note_revisions_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Note history cannot be changed.' using errcode = 'P0001';
end;
$$;
drop trigger if exists support_note_revisions_immutable on public.support_note_revisions;
create trigger support_note_revisions_immutable before update on public.support_note_revisions for each row execute function private.support_note_revisions_immutable();

-- Tickets linked to a customer only through their conversation (the conversation was linked after the ticket was
-- created): the existing relationship is carried into support_tickets.customer_id when it points to exactly one
-- customer. Ticket rows are otherwise untouched; the link is recorded in the ticket history.
drop table if exists support_crm_links;
create temporary table support_crm_links (ticket_id uuid, customer_id uuid);
insert into support_crm_links
select t.id, min(c.customer_id::text)::uuid
from public.support_tickets t join public.support_conversations c on c.ticket_id = t.id and c.customer_id is not null
where t.customer_id is null
group by t.id having count(distinct c.customer_id) = 1;
alter table public.support_tickets disable trigger user;
update public.support_tickets t set customer_id = l.customer_id from support_crm_links l where l.ticket_id = t.id and t.customer_id is null;
alter table public.support_tickets enable trigger user;
insert into public.support_ticket_events (company_id, ticket_id, event_type, from_value, to_value, details)
select t.company_id, t.id, 'UPDATED', null, null, jsonb_build_object('fields', jsonb_build_array('customer_id'), 'customer_linked_from', 'conversation')
from support_crm_links l join public.support_tickets t on t.id = l.ticket_id;
drop table if exists support_crm_links;

-- -----------------------------------------------------------------------------
-- 6. Customer custom field values (same rules as ticket values, CUSTOMER definitions and layout)
-- -----------------------------------------------------------------------------
create or replace function private.support_customer_values_apply(p_company uuid, p_customer uuid, p_values jsonb, p_create boolean)
returns text[]
language plpgsql
security definer
set search_path = ''
as $$
declare
  v jsonb := coalesce(p_values, '{}'::jsonb);
  d public.support_ticket_field_definitions;
  k text;
  v_val jsonb;
  v_old jsonb;
  v_required boolean;
  v_in_form boolean;
  v_missing text[] := '{}';
  v_changed text[] := '{}';
begin
  if jsonb_typeof(v) <> 'object' then
    raise exception 'Custom field values must be an object of field keys.' using errcode = 'P0001';
  end if;
  for k in select jsonb_object_keys(v) loop
    if not exists (select 1 from public.support_ticket_field_definitions where company_id = p_company and module = 'CUSTOMER' and field_key = k) then
      raise exception 'Unknown customer field "%".', k using errcode = 'P0001';
    end if;
  end loop;
  for d in select * from public.support_ticket_field_definitions where company_id = p_company and module = 'CUSTOMER' order by created_at loop
    select l.is_visible, coalesce(l.is_required_override, d.is_required) into v_in_form, v_required
    from private.support_field_layout(p_company, 'CUSTOMER') l where l.field_definition_id = d.id;
    v_in_form := coalesce(v_in_form, false) and d.is_active;
    v_required := v_in_form and coalesce(v_required, d.is_required) and d.field_type not in ('CHECKBOX', 'FORMULA');
    if not (v ? d.field_key) then
      if p_create and v_in_form and d.default_value is not null and d.field_type <> 'FORMULA' then
        v_val := private.support_ticket_field_value(d, d.default_value);
      elsif p_create and v_required then
        v_missing := v_missing || d.field_label;
        continue;
      else
        continue;
      end if;
    else
      if not d.is_active and v -> d.field_key <> 'null'::jsonb then
        select value_json into v_old from public.support_customer_field_values where customer_id = p_customer and field_definition_id = d.id;
        if v_old is distinct from private.support_ticket_field_value(d, v -> d.field_key) then
          raise exception '% is no longer in use; its saved value can be seen but not changed.', d.field_label using errcode = 'P0001';
        end if;
        continue;
      end if;
      v_val := private.support_ticket_field_value(d, v -> d.field_key);
      if v_val is null and v_required then
        v_missing := v_missing || d.field_label;
        continue;
      end if;
    end if;
    select value_json into v_old from public.support_customer_field_values where customer_id = p_customer and field_definition_id = d.id;
    if v_val is null then
      if v_old is not null then
        delete from public.support_customer_field_values where customer_id = p_customer and field_definition_id = d.id;
        v_changed := v_changed || d.field_key;
      end if;
    elsif v_old is distinct from v_val then
      insert into public.support_customer_field_values (company_id, customer_id, field_definition_id, value_json, created_by, updated_by)
      values (p_company, p_customer, d.id, v_val, auth.uid(), auth.uid())
      on conflict (customer_id, field_definition_id) do update set value_json = excluded.value_json, updated_by = auth.uid();
      v_changed := v_changed || d.field_key;
    end if;
  end loop;
  if cardinality(v_missing) > 0 then
    raise exception 'Fill in the required fields: %.', array_to_string(v_missing, ', ') using errcode = 'P0001';
  end if;
  return v_changed;
end;
$$;

revoke all on function private.support_customer_values_apply(uuid, uuid, jsonb, boolean) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 7. Customer form and saving
-- -----------------------------------------------------------------------------
create or replace function public.support_customer_form()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.view');
  v_manager boolean := private.has_permission(v_company, 'support.manage_tickets');
begin
  return jsonb_build_object(
    'fields', coalesce((select jsonb_agg(x.f order by x.o, x.k) from (
        select l.display_order o, s.standard_key k, jsonb_build_object('kind', 'STANDARD', 'standard_key', s.standard_key, 'label', s.label, 'field_type', s.field_type,
          'locked', s.locked, 'required', case when s.required_editable then coalesce(l.is_required_override, false) else s.required end) f
        from private.support_field_layout(v_company, 'CUSTOMER') l join private.support_field_standard('CUSTOMER') s on s.standard_key = l.standard_key
        where l.is_visible
        union all
        select l.display_order, d.field_key, private.support_ticket_field_json(d) || jsonb_build_object('kind', 'CUSTOM',
          'required', coalesce(l.is_required_override, d.is_required) and d.field_type not in ('CHECKBOX', 'FORMULA'))
        from private.support_field_layout(v_company, 'CUSTOMER') l join public.support_ticket_field_definitions d on d.id = l.field_definition_id
        where l.is_visible and d.is_active and d.module = 'CUSTOMER' and (v_manager or d.visibility = 'ALL_AGENTS')) x), '[]'::jsonb),
    'customer_types', jsonb_build_array('Individual', 'Business', 'Dealer', 'Distributor', 'Contractor', 'Builder / Architect', 'Institution', 'Government', 'Other'),
    'can', jsonb_build_object('save', private.has_permission(v_company, 'support.reply')));
end;
$$;

-- Create (p_id null) or edit a customer from the configured form: standard fields (keys missing from p keep their
-- value), custom_fields {field_key: value}. The existing support_customer_save does the record (numbering,
-- validation, duplicate phone / email check with "save as a different customer"); everything in one transaction.
create or replace function public.support_customer_save_v2(p_id uuid, p jsonb, p_allow_duplicate boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.reply');
  o public.support_customers;
  s record;
  v_missing text[] := '{}';
  v_val text;
  v_mobile text; v_alt text; v_land text; v_email text; v_alte text;
  v_phones text[]; v_emails text[];
  v_gstin text; v_pin text; v_country text; v_agent uuid;
  r jsonb;
  v_id uuid;
  k text;
  -- Value of a standard field: from p when given, else the stored one.
  v jsonb;
begin
  if p_id is not null then
    select * into o from public.support_customers where id = p_id and company_id = v_company for update;
    if not found then raise exception 'Customer not found in your company.' using errcode = 'P0001'; end if;
  end if;
  v := coalesce(to_jsonb(o), '{}'::jsonb) || jsonb_build_object('description', o.notes, 'erp_customer', o.erp_customer_id, 'assigned_agent', o.assigned_agent_id);
  foreach k in array array['display_name', 'company_name', 'contact_person', 'mobile', 'alternate_phone', 'landline', 'email', 'alternate_email', 'gstin', 'customer_type',
                           'customer_category', 'address', 'city', 'state', 'pin_code', 'country', 'description'] loop
    if p ? k then v := v || jsonb_build_object(k, nullif(btrim(coalesce(p ->> k, '')), '')); end if;
  end loop;
  if p ? 'erp_customer_id' then v := v || jsonb_build_object('erp_customer', nullif(p ->> 'erp_customer_id', '')); end if;
  if p ? 'assigned_agent_id' then v := v || jsonb_build_object('assigned_agent', nullif(p ->> 'assigned_agent_id', '')); end if;

  -- Required standard fields of the form.
  for s in select f.standard_key, f.label from private.support_field_layout(v_company, 'CUSTOMER') l join private.support_field_standard('CUSTOMER') f on f.standard_key = l.standard_key
           where l.is_visible and f.required_editable and l.is_required_override loop
    if nullif(v ->> s.standard_key, '') is null then v_missing := v_missing || s.label; end if;
  end loop;
  if cardinality(v_missing) > 0 then
    raise exception 'Fill in the required fields: %.', array_to_string(v_missing, ', ') using errcode = 'P0001';
  end if;

  v_mobile := v ->> 'mobile'; v_alt := v ->> 'alternate_phone'; v_land := v ->> 'landline';
  v_email := lower(v ->> 'email'); v_alte := lower(v ->> 'alternate_email');
  -- Other numbers and addresses already on the customer stay (only the labelled ones are replaced).
  v_phones := array_remove(array[v_mobile, v_alt, v_land], null)
    || coalesce(array(select x from unnest(coalesce(o.phones, '{}')) x where x is distinct from o.mobile and x is distinct from o.alternate_phone and x is distinct from o.landline), '{}');
  v_emails := array_remove(array[v_email, v_alte], null)
    || coalesce(array(select x from unnest(coalesce(o.emails, '{}')) x where x is distinct from o.email and x is distinct from o.alternate_email), '{}');

  v_gstin := upper(v ->> 'gstin');
  if v_gstin is not null and v_gstin !~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$' then
    raise exception 'GSTIN "%" is not valid (15 characters, e.g. 27AAACE1234F1Z5).', v_gstin using errcode = 'P0001';
  end if;
  v_country := v ->> 'country';
  v_pin := v ->> 'pin_code';
  if v_pin is not null and (coalesce(lower(v_country), 'india') = 'india' and v_pin !~ '^[1-9][0-9]{5}$') then
    raise exception 'PIN code "%" is not valid (6 digits).', v_pin using errcode = 'P0001';
  end if;
  if v_pin is not null and v_pin !~ '^[A-Za-z0-9 -]{3,12}$' then
    raise exception 'Postal code "%" is not valid.', v_pin using errcode = 'P0001';
  end if;
  if length(v ->> 'contact_person') > 120 or length(v ->> 'customer_type') > 40 or length(v ->> 'customer_category') > 80
     or length(v ->> 'city') > 80 or length(v ->> 'state') > 80 or length(v_country) > 80 then
    raise exception 'A customer detail is too long.' using errcode = 'P0001';
  end if;
  v_agent := nullif(v ->> 'assigned_agent', '')::uuid;
  if v_agent is not null and not exists (select 1 from public.support_agents where id = v_agent and company_id = v_company and is_active) then
    raise exception 'Choose an active support agent of your company.' using errcode = 'P0001';
  end if;

  r := public.support_customer_save(p_id, jsonb_build_object('display_name', v ->> 'display_name', 'company_name', v ->> 'company_name', 'phones', to_jsonb(v_phones),
    'emails', to_jsonb(v_emails), 'address', v ->> 'address', 'erp_customer_id', v ->> 'erp_customer', 'notes', v ->> 'description'), p_allow_duplicate);
  if not coalesce((r ->> 'ok')::boolean, false) then
    return r;
  end if;
  v_id := (r ->> 'id')::uuid;
  update public.support_customers set contact_person = v ->> 'contact_person', mobile = v_mobile, alternate_phone = v_alt, landline = v_land, email = v_email,
    alternate_email = v_alte, gstin = v_gstin, customer_type = v ->> 'customer_type', customer_category = v ->> 'customer_category', city = v ->> 'city',
    state = v ->> 'state', pin_code = v_pin, country = v_country, assigned_agent_id = v_agent, updated_by = auth.uid()
  where id = v_id;
  perform private.support_customer_values_apply(v_company, v_id, coalesce(p -> 'custom_fields', '{}'::jsonb), p_id is null);
  return r || (select jsonb_build_object('customer_code', c.customer_code, 'display_name', c.display_name) from public.support_customers c where c.id = v_id);
end;
$$;

-- Customers matching a phone number or email (New Ticket): every match is returned (several = the agent chooses),
-- with what matched. Phones are compared normalised (Indian numbers by their last 10 digits; +91 / 0 prefixes and
-- formatting ignored), emails trimmed and lower-cased. Current company only; indexed.
create or replace function public.support_customer_lookup(p_phone text, p_email text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.view');
  v_ph text := private.support_normalize_phone(p_phone);
  v_em text := private.support_normalize_email(p_email);
begin
  if v_ph is null and v_em is null then return '[]'::jsonb; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'customer_code', c.customer_code, 'display_name', c.display_name, 'company_name', c.company_name,
      'mobile', c.mobile, 'alternate_phone', c.alternate_phone, 'landline', c.landline, 'email', c.email, 'alternate_email', c.alternate_email,
      'phones', c.phones, 'emails', c.emails,
      'matched_on', array_remove(array[
        case when v_ph is not null and private.support_normalize_phone(c.mobile) = v_ph then 'Mobile' end,
        case when v_ph is not null and private.support_normalize_phone(c.alternate_phone) = v_ph then 'Alternate phone' end,
        case when v_ph is not null and private.support_normalize_phone(c.landline) = v_ph then 'Landline' end,
        case when v_ph is not null and c.normalized_phones @> array[v_ph] and v_ph is distinct from private.support_normalize_phone(c.mobile)
               and v_ph is distinct from private.support_normalize_phone(c.alternate_phone) and v_ph is distinct from private.support_normalize_phone(c.landline) then 'Other phone' end,
        case when v_em is not null and lower(c.email) = v_em then 'Email' end,
        case when v_em is not null and lower(c.alternate_email) = v_em then 'Alternate email' end,
        case when v_em is not null and c.normalized_emails @> array[v_em] and v_em is distinct from lower(c.email) and v_em is distinct from lower(c.alternate_email) then 'Other email' end], null),
      'open_tickets', (select count(*) from public.support_tickets t where t.customer_id = c.id and t.status not in ('RESOLVED', 'CLOSED') and t.merged_into_ticket_id is null))
      order by c.display_name, c.customer_code)
    from (select * from public.support_customers c
          where c.company_id = v_company and c.is_active
            and ((v_ph is not null and c.normalized_phones @> array[v_ph]) or (v_em is not null and c.normalized_emails @> array[v_em]))
          limit 20) c), '[]'::jsonb);
end;
$$;

-- -----------------------------------------------------------------------------
-- 8. Customer workspace (profile page)
-- -----------------------------------------------------------------------------
create or replace function private.support_customer_of(p_company uuid, p_customer uuid)
returns public.support_customers
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c public.support_customers;
begin
  select * into c from public.support_customers where id = p_customer and company_id = p_company;
  if not found then raise exception 'Customer not found in your company.' using errcode = 'P0001'; end if;
  return c;
end;
$$;

create or replace function public.support_customer_workspace(p_customer uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.view');
  c public.support_customers := private.support_customer_of(v_company, p_customer);
  v_manager boolean := private.has_permission(v_company, 'support.manage_tickets');
  v_manage_notes boolean := private.has_permission(v_company, 'support_customers.manage_notes');
  v_products boolean := private.has_permission(v_company, 'support_ticket_products.view');
begin
  return jsonb_build_object(
    'customer', to_jsonb(c) - 'company_id' - 'normalized_phones' - 'normalized_emails' || jsonb_build_object(
      'assigned_agent', (select jsonb_build_object('id', a.id, 'display_name', a.display_name) from public.support_agents a where a.id = c.assigned_agent_id),
      'erp_customer', (select jsonb_build_object('id', e.id, 'customer_code', e.customer_code, 'customer_name', e.customer_name) from public.customers e where e.id = c.erp_customer_id),
      'created_by_name', (select coalesce(u.full_name, u.email) from public.profiles u where u.id = c.created_by)),
    'tags', coalesce((select jsonb_agg(distinct jsonb_build_object('id', tg.id, 'name', tg.name, 'color', tg.color))
        from public.support_conversations cv join public.support_conversation_tags ct on ct.conversation_id = cv.id join public.support_tags tg on tg.id = ct.tag_id
        where cv.customer_id = c.id), '[]'::jsonb),
    'fields', coalesce((select jsonb_agg(private.support_ticket_field_json(d) || jsonb_build_object('value', fv.value_json, 'in_form', coalesce(l.is_visible, false) and d.is_active,
        'required', coalesce(l.is_visible, false) and d.is_active and coalesce(l.is_required_override, d.is_required) and d.field_type not in ('CHECKBOX', 'FORMULA'))
        order by coalesce(l.is_visible, false) and d.is_active desc, l.display_order nulls last, d.created_at)
      from public.support_ticket_field_definitions d
      left join public.support_customer_field_values fv on fv.field_definition_id = d.id and fv.customer_id = c.id
      left join private.support_field_layout(v_company, 'CUSTOMER') l on l.field_definition_id = d.id
      where d.company_id = v_company and d.module = 'CUSTOMER' and (v_manager or d.visibility = 'ALL_AGENTS')
        and ((coalesce(l.is_visible, false) and d.is_active) or fv.id is not null)), '[]'::jsonb),
    'formula_inputs', coalesce((select jsonb_object_agg(d.field_key, fv.value_json) from public.support_ticket_field_definitions d
        join public.support_customer_field_values fv on fv.field_definition_id = d.id and fv.customer_id = c.id
        where d.company_id = v_company and d.module = 'CUSTOMER' and d.field_type in ('NUMBER', 'CURRENCY')), '{}'::jsonb),
    'metrics', (select jsonb_build_object('total', count(*), 'open', count(*) filter (where t.status not in ('RESOLVED', 'CLOSED')),
        'closed', count(*) filter (where t.status in ('RESOLVED', 'CLOSED')),
        'overdue', count(*) filter (where t.status not in ('RESOLVED', 'CLOSED') and private.support_sla_status(t) = 'OVERDUE'),
        'avg_resolution_hours', round(extract(epoch from avg(t.resolved_at - t.created_at)) / 3600.0, 1),
        'reopened', count(*) filter (where t.reopen_count > 0),
        'product_complaints', case when v_products then (select count(*) from public.support_ticket_products x join public.support_tickets y on y.id = x.ticket_id
                                where y.customer_id = c.id and y.merged_into_ticket_id is null) end,
        'last_ticket_at', max(t.created_at))
      from public.support_tickets t where t.company_id = v_company and t.customer_id = c.id and t.merged_into_ticket_id is null),
    'counts', jsonb_build_object(
      'notes', (select count(*) from public.support_internal_notes n where n.customer_id = c.id and n.deleted_at is null),
      'open_activities', (select count(*) from public.support_customer_activities a where a.customer_id = c.id and a.status in ('OPEN', 'IN_PROGRESS')),
      'conversations', (select count(*) from public.support_conversations cv where cv.customer_id = c.id),
      'calls', (select count(*) from public.support_calls k where k.company_id = v_company and (k.customer_id = c.id
                 or k.conversation_id in (select id from public.support_conversations where customer_id = c.id)))),
    'notes', coalesce((select jsonb_agg(jsonb_build_object('id', n.id, 'body', n.body, 'created_at', n.created_at, 'edited_at', n.edited_at,
        'author', (select coalesce(u.full_name, u.email) from public.profiles u where u.id = n.created_by),
        'can_edit', private.has_permission(v_company, 'support.reply') and (n.created_by = auth.uid() or v_manage_notes),
        'revisions', (select count(*) from public.support_note_revisions r where r.note_id = n.id)) order by n.created_at desc)
      from public.support_internal_notes n where n.customer_id = c.id and n.deleted_at is null), '[]'::jsonb),
    'activities', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'activity_type', a.activity_type, 'title', a.title, 'description', a.description, 'due_at', a.due_at,
        'assigned_user_id', a.assigned_user_id, 'assigned_user', (select coalesce(u.full_name, u.email) from public.profiles u where u.id = a.assigned_user_id),
        'priority', a.priority, 'status', a.status, 'completed_at', a.completed_at, 'ticket_id', a.ticket_id,
        'ticket_number', (select ticket_number from public.support_tickets t where t.id = a.ticket_id), 'created_at', a.created_at,
        'created_by', (select coalesce(u.full_name, u.email) from public.profiles u where u.id = a.created_by))
        order by (a.status in ('OPEN', 'IN_PROGRESS')) desc, a.due_at nulls last, a.created_at desc)
      from public.support_customer_activities a where a.customer_id = c.id), '[]'::jsonb),
    'can', jsonb_build_object('edit', private.has_permission(v_company, 'support.reply'), 'notes', private.has_permission(v_company, 'support.reply'),
      'manage_notes', v_manage_notes, 'activities', private.has_permission(v_company, 'support_customers.manage_activities'),
      'products', v_products, 'create_ticket', v_manager));
end;
$$;

-- Tickets of a customer (support_tickets.customer_id), with pipeline stage. p_filter: ALL | OPEN | IN_PROGRESS |
-- ON_HOLD | RESOLVED | CLOSED | OVERDUE.
create or replace function public.support_customer_tickets(p_customer uuid, p_filter text default 'ALL')
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.view');
  c public.support_customers := private.support_customer_of(v_company, p_customer);
  f text := upper(coalesce(nullif(p_filter, ''), 'ALL'));
begin
  return coalesce((select jsonb_agg(x.row order by x.created_at desc) from (
      select t.created_at, jsonb_build_object('id', t.id, 'ticket_number', t.ticket_number, 'subject', t.subject, 'status', t.status, 'priority', t.priority,
        'pipeline', p.name, 'stage', s.stage_name, 'stage_color', s.color, 'stage_type', s.stage_type, 'outcome_type', s.outcome_type,
        'assigned_agent', a.display_name, 'created_at', t.created_at, 'updated_at', t.updated_at, 'sla_status', private.support_sla_status(t),
        'closed_at', coalesce(t.closed_at, t.resolved_at), 'merged', t.merged_into_ticket_id is not null, 'reopen_count', t.reopen_count) as row
      from public.support_tickets t
      left join public.support_pipelines p on p.id = t.pipeline_id
      left join public.support_pipeline_stages s on s.id = t.stage_id
      left join public.support_agents a on a.id = t.assigned_agent_id
      where t.company_id = v_company and t.customer_id = c.id
        and (f = 'ALL'
             or (f = 'OPEN' and t.status not in ('RESOLVED', 'CLOSED') and t.merged_into_ticket_id is null)
             or (f = 'IN_PROGRESS' and t.status = 'IN_PROGRESS')
             or (f = 'ON_HOLD' and t.status in ('WAITING_CUSTOMER', 'WAITING_INTERNAL'))
             or (f = 'RESOLVED' and t.status = 'RESOLVED')
             or (f = 'CLOSED' and t.status = 'CLOSED')
             or (f = 'OVERDUE' and t.status not in ('RESOLVED', 'CLOSED') and private.support_sla_status(t) = 'OVERDUE'))
      limit 500) x), '[]'::jsonb);
end;
$$;

-- Real events of a customer, newest first, each linked to its record (customer, ticket, call, conversation,
-- activity). No message bodies: email subjects, WhatsApp message types, note excerpts (notes are internal).
create or replace function public.support_customer_timeline(p_customer uuid, p_limit integer default 100, p_before timestamptz default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.view');
  c public.support_customers := private.support_customer_of(v_company, p_customer);
  v_products boolean := private.has_permission(v_company, 'support_ticket_products.view');
begin
  return coalesce((select jsonb_agg(jsonb_build_object('at', e.at, 'type', e.type, 'title', e.title, 'detail', e.detail, 'link_type', e.link_type, 'link_id', e.link_id,
      'channel', e.channel, 'actor', (select coalesce(u.full_name, u.email) from public.profiles u where u.id = e.actor)) order by e.at desc, e.type)
    from (
      with tk as (select * from public.support_tickets where company_id = v_company and customer_id = c.id),
           cv as (select id, channel from public.support_conversations where company_id = v_company and customer_id = c.id),
           ev as (
        select c.created_at as at, 'CUSTOMER_CREATED' as type, 'Customer created' as title, c.customer_code as detail, c.created_by as actor, 'CUSTOMER' as link_type, c.id as link_id, null::text as channel
        union all
        select a.created_at, 'CUSTOMER_UPDATED', 'Customer details updated',
          (select string_agg(replace(x, '_', ' '), ', ') from jsonb_array_elements_text(a.details -> 'changed') x
           where x not in ('normalized_phones', 'normalized_emails', 'updated_at', 'updated_by')), a.actor_user_id, 'CUSTOMER', c.id, null
        from public.support_audit_logs a where a.company_id = v_company and a.entity_type = 'customers' and a.action = 'customers.update' and a.entity_id = c.id::text
        union all
        select t.created_at, 'TICKET_CREATED', 'Ticket ' || t.ticket_number || ' created', t.subject, t.created_by, 'TICKET', t.id, t.channel from tk t
        union all
        select h.changed_at, 'STAGE_CHANGED', t.ticket_number || ': ' || coalesce(fs.stage_name, '—') || ' → ' || ts.stage_name, h.notes, h.changed_by, 'TICKET', t.id, null
        from public.support_ticket_stage_history h join tk t on t.id = h.ticket_id join public.support_pipeline_stages ts on ts.id = h.to_stage_id
        left join public.support_pipeline_stages fs on fs.id = h.from_stage_id where h.source not in ('CREATED', 'MIGRATION')
        union all
        select e.created_at, 'TICKET_ASSIGNED', t.ticket_number || ' assigned', coalesce((select display_name from public.support_agents ag where ag.id::text = e.to_value), 'Unassigned'),
          e.actor_user_id, 'TICKET', t.id, null
        from public.support_ticket_events e join tk t on t.id = e.ticket_id where e.event_type = 'ASSIGNED'
        union all
        select e.created_at, case e.to_value when 'CLOSED' then 'TICKET_CLOSED' else 'TICKET_RESOLVED' end, t.ticket_number || case e.to_value when 'CLOSED' then ' closed' else ' resolved' end,
          t.subject, e.actor_user_id, 'TICKET', t.id, null
        from public.support_ticket_events e join tk t on t.id = e.ticket_id where e.event_type = 'STATUS_CHANGED' and e.to_value in ('RESOLVED', 'CLOSED')
        union all
        select e.created_at, 'TICKET_REOPENED', t.ticket_number || ' reopened', e.details ->> 'reason', e.actor_user_id, 'TICKET', t.id, null
        from public.support_ticket_events e join tk t on t.id = e.ticket_id where e.event_type = 'REOPENED'
        union all
        select n.created_at, 'NOTE_ADDED', 'Note added', left(n.body, 140), n.created_by, 'NOTE', n.id, null
        from public.support_internal_notes n where n.customer_id = c.id and n.deleted_at is null
        union all
        select coalesce(k.started_at, k.created_at), case when k.status in ('MISSED', 'NO_ANSWER', 'BUSY', 'FAILED', 'CANCELLED') then 'CALL_MISSED' else 'CALL' end,
          case k.direction when 'INBOUND' then 'Incoming call' else 'Outgoing call' end || ' — ' || lower(replace(k.status, '_', ' ')),
          case when k.duration_seconds > 0 then (k.duration_seconds / 60) || ' min ' || (k.duration_seconds % 60) || ' s' end, k.initiated_by, 'CALL', k.id, 'PHONE'
        from public.support_calls k where k.company_id = v_company and (k.customer_id = c.id or k.conversation_id in (select id from cv))
        union all
        select m.created_at, case m.direction when 'INBOUND' then 'EMAIL_RECEIVED' else 'EMAIL_SENT' end, case m.direction when 'INBOUND' then 'Email received' else 'Email sent' end,
          left(m.subject, 140), null, 'CONVERSATION', m.conversation_id, 'EMAIL'
        from public.support_email_messages m where m.company_id = v_company and m.conversation_id in (select id from cv)
        union all
        select w.created_at, case w.direction when 'INBOUND' then 'WHATSAPP_RECEIVED' else 'WHATSAPP_SENT' end, case w.direction when 'INBOUND' then 'WhatsApp message received' else 'WhatsApp message sent' end,
          w.msg_type, null, 'CONVERSATION', w.conversation_id, 'WHATSAPP'
        from public.support_whatsapp_messages w where w.company_id = v_company and w.conversation_id in (select id from cv)
        union all
        select x.created_at, 'PRODUCT_LINKED', x.product_name_snapshot || ' (' || x.sku_snapshot || ') on ' || t.ticket_number, 'Quantity ' || x.quantity, x.created_by, 'TICKET', t.id, null
        from public.support_ticket_products x join tk t on t.id = x.ticket_id where v_products
        union all
        select a.created_at, 'ACTIVITY_CREATED', initcap(replace(a.activity_type, '_', ' ')) || ': ' || a.title, case when a.due_at is not null then 'Due ' || to_char(a.due_at, 'DD Mon YYYY') end,
          a.created_by, 'ACTIVITY', a.id, null
        from public.support_customer_activities a where a.customer_id = c.id
        union all
        select a.completed_at, 'ACTIVITY_COMPLETED', initcap(replace(a.activity_type, '_', ' ')) || ' done: ' || a.title, null, a.updated_by, 'ACTIVITY', a.id, null
        from public.support_customer_activities a where a.customer_id = c.id and a.completed_at is not null)
      select * from ev where at is not null and (p_before is null or at < p_before) order by at desc limit least(greatest(coalesce(p_limit, 100), 1), 500)) e), '[]'::jsonb);
end;
$$;

-- Emails, calls, WhatsApp messages, files and products of a customer (profile tabs). No message bodies.
create or replace function public.support_customer_records(p_customer uuid, p_kind text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.view');
  c public.support_customers := private.support_customer_of(v_company, p_customer);
  v_sensitive boolean := private.has_permission(v_company, 'support.manage_tickets');
begin
  case upper(coalesce(p_kind, ''))
  when 'EMAIL' then
    return coalesce((select jsonb_agg(x order by x ->> 'at' desc) from (select jsonb_build_object('id', m.id, 'conversation_id', m.conversation_id, 'direction', m.direction,
        'subject', m.subject, 'from_address', m.from_address, 'from_name', m.from_name, 'at', coalesce(m.internal_date, m.created_at)) x
      from public.support_email_messages m join public.support_conversations cv on cv.id = m.conversation_id
      where m.company_id = v_company and cv.customer_id = c.id order by coalesce(m.internal_date, m.created_at) desc limit 300) q), '[]'::jsonb);
  when 'CALLS' then
    return coalesce((select jsonb_agg(x order by x ->> 'at' desc) from (select jsonb_build_object('id', k.id, 'direction', k.direction, 'status', k.status,
        'at', coalesce(k.started_at, k.created_at), 'answered_at', k.answered_at, 'ended_at', k.ended_at, 'duration_seconds', k.duration_seconds, 'agent_name', k.agent_name,
        'ticket_id', k.ticket_id, 'ticket_number', (select ticket_number from public.support_tickets t where t.id = k.ticket_id), 'conversation_id', k.conversation_id) x
      from public.support_calls k where k.company_id = v_company and (k.customer_id = c.id or k.conversation_id in (select id from public.support_conversations where customer_id = c.id))
      order by coalesce(k.started_at, k.created_at) desc limit 300) q), '[]'::jsonb);
  when 'WHATSAPP' then
    return coalesce((select jsonb_agg(x order by x ->> 'at' desc) from (select jsonb_build_object('id', w.id, 'conversation_id', w.conversation_id, 'direction', w.direction,
        'msg_type', w.msg_type, 'status', w.status, 'at', w.created_at) x
      from public.support_whatsapp_messages w join public.support_conversations cv on cv.id = w.conversation_id
      where w.company_id = v_company and cv.customer_id = c.id order by w.created_at desc limit 300) q), '[]'::jsonb);
  when 'FILES' then
    return coalesce((select jsonb_agg(x order by x ->> 'at' desc) from (select jsonb_build_object('id', a.id, 'file_name', a.file_name, 'content_type', a.content_type,
        'size_bytes', a.size_bytes, 'at', a.created_at, 'ticket_id', a.ticket_id, 'ticket_number', (select ticket_number from public.support_tickets t where t.id = a.ticket_id),
        'conversation_id', a.conversation_id, 'is_recording', a.is_recording, 'is_sensitive', a.is_sensitive,
        'storage_path', case when v_sensitive or not a.is_sensitive then a.storage_path end, 'restricted', a.is_sensitive and not v_sensitive) x
      from public.support_attachments a
      where a.company_id = v_company and (a.ticket_id in (select id from public.support_tickets where customer_id = c.id)
                                          or a.conversation_id in (select id from public.support_conversations where customer_id = c.id))
      order by a.created_at desc limit 300) q), '[]'::jsonb);
  when 'PRODUCTS' then
    perform private.require_permission('support_ticket_products.view');
    return coalesce((select jsonb_agg(x order by (x ->> 'complaints')::int desc, x ->> 'last_complaint_at' desc) from (
      select jsonb_build_object('product_id', x.product_id, 'product_name', coalesce(max(pr.product_name), max(x.product_name_snapshot)), 'sku', coalesce(max(pr.sku), max(x.sku_snapshot)),
        'model_number', max(pr.model_number), 'complaints', count(distinct t.id), 'quantity', sum(x.quantity), 'last_complaint_at', max(t.created_at),
        'tickets', jsonb_agg(distinct jsonb_build_object('id', t.id, 'ticket_number', t.ticket_number))) x
      from public.support_ticket_products x join public.support_tickets t on t.id = x.ticket_id left join public.products pr on pr.id = x.product_id
      where t.company_id = v_company and t.customer_id = c.id and t.merged_into_ticket_id is null
      group by x.product_id) q), '[]'::jsonb);
  else
    raise exception 'Unknown record kind %.', p_kind using errcode = 'P0001';
  end case;
end;
$$;

-- -----------------------------------------------------------------------------
-- 9. Customer notes (support_internal_notes) and activities
-- -----------------------------------------------------------------------------
-- Add (p_note null) or edit a customer note. Authors edit their own; others need support_customers.manage_notes.
create or replace function public.support_customer_note_save(p_customer uuid, p_note uuid, p_body text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.reply');
  c public.support_customers := private.support_customer_of(v_company, p_customer);
  n public.support_internal_notes;
  v_body text := btrim(coalesce(p_body, ''));
  v_id uuid;
begin
  if length(v_body) = 0 or length(v_body) > 5000 then
    raise exception 'A note has 1 to 5000 characters.' using errcode = 'P0001';
  end if;
  if p_note is null then
    insert into public.support_internal_notes (company_id, customer_id, body, created_by, updated_by) values (v_company, c.id, v_body, auth.uid(), auth.uid()) returning id into v_id;
    return jsonb_build_object('id', v_id);
  end if;
  select * into n from public.support_internal_notes where id = p_note and customer_id = c.id and company_id = v_company and deleted_at is null for update;
  if not found then raise exception 'Note not found.' using errcode = 'P0001'; end if;
  if n.created_by is distinct from auth.uid() and not private.has_permission(v_company, 'support_customers.manage_notes') then
    raise exception 'Only the author can edit this note (or someone with support_customers.manage_notes).' using errcode = '42501';
  end if;
  if n.body = v_body then return jsonb_build_object('id', n.id, 'unchanged', true); end if;
  insert into public.support_note_revisions (company_id, note_id, body, action, changed_by) values (v_company, n.id, n.body, 'EDITED', auth.uid());
  update public.support_internal_notes set body = v_body, edited_at = now(), updated_by = auth.uid() where id = n.id;
  return jsonb_build_object('id', n.id);
end;
$$;

-- Delete a customer note: hidden, its text kept in the note history.
create or replace function public.support_customer_note_delete(p_note uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.reply');
  n public.support_internal_notes;
begin
  select * into n from public.support_internal_notes where id = p_note and company_id = v_company and customer_id is not null and deleted_at is null for update;
  if not found then raise exception 'Note not found.' using errcode = 'P0001'; end if;
  if n.created_by is distinct from auth.uid() and not private.has_permission(v_company, 'support_customers.manage_notes') then
    raise exception 'Only the author can delete this note (or someone with support_customers.manage_notes).' using errcode = '42501';
  end if;
  insert into public.support_note_revisions (company_id, note_id, body, action, changed_by) values (v_company, n.id, n.body, 'DELETED', auth.uid());
  update public.support_internal_notes set deleted_at = now(), deleted_by = auth.uid(), updated_by = auth.uid() where id = n.id;
end;
$$;

create or replace function public.support_customer_note_history(p_note uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.view');
begin
  if not exists (select 1 from public.support_internal_notes where id = p_note and company_id = v_company) then
    raise exception 'Note not found.' using errcode = 'P0001';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'body', r.body, 'action', r.action, 'changed_at', r.changed_at,
      'changed_by', (select coalesce(u.full_name, u.email) from public.profiles u where u.id = r.changed_by)) order by r.changed_at desc)
    from public.support_note_revisions r where r.note_id = p_note), '[]'::jsonb);
end;
$$;

-- Create (p_id null) or update a customer activity.
create or replace function public.support_customer_activity_save(p_customer uuid, p_id uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support_customers.manage_activities');
  c public.support_customers := private.support_customer_of(v_company, p_customer);
  a public.support_customer_activities;
  v_status text;
  v_user uuid;
  v_ticket uuid;
begin
  perform private.require_permission('support.view');
  if p_id is not null then
    select * into a from public.support_customer_activities where id = p_id and customer_id = c.id for update;
    if not found then raise exception 'Activity not found.' using errcode = 'P0001'; end if;
  end if;
  a.activity_type := upper(coalesce(case when p ? 'activity_type' then p ->> 'activity_type' end, a.activity_type, 'TASK'));
  if a.activity_type not in ('TASK', 'FOLLOW_UP', 'REMINDER', 'VISIT', 'SERVICE_APPOINTMENT') then
    raise exception 'Choose the activity type: task, follow-up, reminder, customer visit or service appointment.' using errcode = 'P0001';
  end if;
  if p ? 'title' or p_id is null then a.title := private.support_text(p, 'title', 200); end if;
  if a.title is null then raise exception 'Enter the activity title.' using errcode = 'P0001'; end if;
  if p ? 'description' then a.description := private.support_text(p, 'description', 2000); end if;
  if p ? 'due_at' then a.due_at := nullif(p ->> 'due_at', '')::timestamptz; end if;
  a.priority := upper(coalesce(case when p ? 'priority' then p ->> 'priority' end, a.priority, 'NORMAL'));
  if a.priority not in ('LOW', 'NORMAL', 'HIGH', 'URGENT') then raise exception 'Priority must be low, normal, high or urgent.' using errcode = 'P0001'; end if;
  if p ? 'assigned_user_id' then
    v_user := nullif(p ->> 'assigned_user_id', '')::uuid;
    if v_user is not null and not exists (select 1 from public.profiles where id = v_user and company_id = v_company and is_active) then
      raise exception 'Choose an active employee of your company.' using errcode = 'P0001';
    end if;
    a.assigned_user_id := v_user;
  end if;
  if p ? 'ticket_id' then
    v_ticket := nullif(p ->> 'ticket_id', '')::uuid;
    if v_ticket is not null and not exists (select 1 from public.support_tickets where id = v_ticket and customer_id = c.id) then
      raise exception 'The ticket must belong to this customer.' using errcode = 'P0001';
    end if;
    a.ticket_id := v_ticket;
  end if;
  v_status := upper(coalesce(case when p ? 'status' then p ->> 'status' end, a.status, 'OPEN'));
  if v_status not in ('OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED') then raise exception 'Unknown activity status.' using errcode = 'P0001'; end if;
  a.completed_at := case when v_status = 'DONE' then coalesce(case when a.status = 'DONE' then a.completed_at end, now()) end;
  a.status := v_status;
  if p_id is null then
    insert into public.support_customer_activities (company_id, customer_id, ticket_id, activity_type, title, description, due_at, assigned_user_id, priority, status, completed_at, created_by, updated_by)
    values (v_company, c.id, a.ticket_id, a.activity_type, a.title, a.description, a.due_at, a.assigned_user_id, a.priority, a.status, a.completed_at, auth.uid(), auth.uid())
    returning * into a;
  else
    update public.support_customer_activities set activity_type = a.activity_type, title = a.title, description = a.description, due_at = a.due_at,
      assigned_user_id = a.assigned_user_id, ticket_id = a.ticket_id, priority = a.priority, status = a.status, completed_at = a.completed_at, updated_by = auth.uid()
    where id = p_id returning * into a;
  end if;
  return jsonb_build_object('id', a.id, 'status', a.status, 'completed_at', a.completed_at);
end;
$$;

-- -----------------------------------------------------------------------------
-- 10. Customer report (Support Reports)
-- -----------------------------------------------------------------------------
create or replace function public.support_customer_report(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.view_reports');
  v_from timestamptz := coalesce(p_from, current_date - 90)::timestamptz;
  v_to timestamptz := (coalesce(p_to, current_date) + 1)::timestamptz;
  v_products boolean := private.has_permission(v_company, 'support_ticket_products.view');
begin
  return (
    with tk as (select t.*, private.support_sla_status(t) as sla from public.support_tickets t
                where t.company_id = v_company and t.customer_id is not null and t.merged_into_ticket_id is null and t.created_at >= v_from and t.created_at < v_to),
    per as (select tk.customer_id, count(*) as tickets, count(*) filter (where status not in ('RESOLVED', 'CLOSED')) as open,
              count(*) filter (where status in ('RESOLVED', 'CLOSED')) as closed, count(*) filter (where status not in ('RESOLVED', 'CLOSED') and sla = 'OVERDUE') as overdue,
              round(extract(epoch from avg(resolved_at - created_at)) / 3600.0, 1) as avg_resolution_hours, count(*) filter (where reopen_count > 0) as reopened,
              (select count(*) from public.support_ticket_products x join tk y on y.id = x.ticket_id where y.customer_id = tk.customer_id) as product_complaints
            from tk group by tk.customer_id order by count(*) desc limit 20)
    select jsonb_build_object('from', v_from::date, 'to', (v_to - interval '1 day')::date,
      'customers', coalesce((select jsonb_agg(jsonb_build_object('customer_id', per.customer_id, 'customer_code', c.customer_code, 'display_name', c.display_name,
          'tickets', per.tickets, 'open', per.open, 'closed', per.closed, 'overdue', per.overdue, 'avg_resolution_hours', per.avg_resolution_hours,
          'reopened', per.reopened, 'product_complaints', case when v_products then per.product_complaints end) order by per.tickets desc, c.display_name)
        from per join public.support_customers c on c.id = per.customer_id), '[]'::jsonb),
      'trend', coalesce((select jsonb_agg(jsonb_build_object('customer_id', x.customer_id, 'month', x.month, 'tickets', x.n) order by x.customer_id, x.month)
        from (select tk.customer_id, to_char(date_trunc('month', tk.created_at), 'YYYY-MM') as month, count(*) as n from tk
              where tk.customer_id in (select customer_id from per order by tickets desc limit 10) group by 1, 2) x), '[]'::jsonb),
      'products_by_customer', case when v_products then coalesce((select jsonb_agg(x order by (x ->> 'tickets')::int desc) from (
          select jsonb_build_object('customer_id', c.id, 'customer_code', c.customer_code, 'display_name', c.display_name, 'sku', max(p.sku_snapshot),
            'product_name', max(p.product_name_snapshot), 'tickets', count(distinct tk.id)) x
          from public.support_ticket_products p join tk on tk.id = p.ticket_id join public.support_customers c on c.id = tk.customer_id
          group by c.id, p.product_id order by count(distinct tk.id) desc limit 50) q), '[]'::jsonb) end));
end;
$$;

revoke all on function private.support_field_permission(text, text), private.support_field_standard(text), private.support_field_layout(uuid, text),
  private.support_field_layout_stamp(uuid, text), private.support_customer_contacts(), private.support_note_revisions_immutable(),
  private.support_customer_of(uuid, uuid) from public, anon, authenticated;
revoke all on function public.support_customer_form(), public.support_customer_save_v2(uuid, jsonb, boolean), public.support_customer_lookup(text, text),
  public.support_customer_workspace(uuid), public.support_customer_tickets(uuid, text), public.support_customer_timeline(uuid, integer, timestamptz),
  public.support_customer_records(uuid, text), public.support_customer_note_save(uuid, uuid, text), public.support_customer_note_delete(uuid),
  public.support_customer_note_history(uuid), public.support_customer_activity_save(uuid, uuid, jsonb), public.support_customer_report(date, date) from public, anon;
grant execute on function public.support_customer_form(), public.support_customer_save_v2(uuid, jsonb, boolean), public.support_customer_lookup(text, text),
  public.support_customer_workspace(uuid), public.support_customer_tickets(uuid, text), public.support_customer_timeline(uuid, integer, timestamptz),
  public.support_customer_records(uuid, text), public.support_customer_note_save(uuid, uuid, text), public.support_customer_note_delete(uuid),
  public.support_customer_note_history(uuid), public.support_customer_activity_save(uuid, uuid, jsonb), public.support_customer_report(date, date) to authenticated;

-- -----------------------------------------------------------------------------
-- 11. ERP reset allowlist (20261227090000 plus the three CRM tables; note history before the notes)
-- -----------------------------------------------------------------------------
create or replace function private.erp_reset_tables()
returns table (ord int, table_name text, category text, label text)
language sql
stable
set search_path = ''
as $$
  select * from (values
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
