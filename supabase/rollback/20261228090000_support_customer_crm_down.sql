-- Rollback of 20261228090000_support_customer_crm.
--
-- Drops customer custom fields (definitions, layout and values), customer activities, note revisions and the new
-- customer columns, and restores the field functions of 20261226090000. Customers, tickets, conversations, calls
-- and notes stay (edited notes keep their current text; deleted notes become visible again). Refused while customer
-- field values, activities or note revisions exist unless   set app.support_crm_rollback_force = 'on';

do $$
begin
  if coalesce(current_setting('app.support_crm_rollback_force', true), '') <> 'on' and to_regclass('public.support_customer_field_values') is not null
     and (exists (select 1 from public.support_customer_field_values) or exists (select 1 from public.support_customer_activities)
          or exists (select 1 from public.support_note_revisions)) then
    raise exception 'Customer field values, activities or note history exist. Export them, then set app.support_crm_rollback_force = on to roll back.';
  end if;
end;
$$;

drop function if exists public.support_customer_report(date, date);
drop function if exists public.support_customer_activity_save(uuid, uuid, jsonb);
drop function if exists public.support_customer_note_history(uuid);
drop function if exists public.support_customer_note_delete(uuid);
drop function if exists public.support_customer_note_save(uuid, uuid, text);
drop function if exists public.support_customer_records(uuid, text);
drop function if exists public.support_customer_timeline(uuid, integer, timestamptz);
drop function if exists public.support_customer_tickets(uuid, text);
drop function if exists public.support_customer_workspace(uuid);
drop function if exists private.support_customer_of(uuid, uuid);
drop function if exists public.support_customer_lookup(text, text);
drop function if exists public.support_customer_save_v2(uuid, jsonb, boolean);
drop function if exists public.support_customer_form();
drop function if exists private.support_customer_values_apply(uuid, uuid, jsonb, boolean);

drop table if exists public.support_customer_activities;
drop table if exists public.support_note_revisions;
drop function if exists private.support_note_revisions_immutable();
drop table if exists public.support_customer_field_values;
drop index if exists public.support_internal_notes_customer_idx;
alter table public.support_internal_notes drop column if exists deleted_by;
alter table public.support_internal_notes drop column if exists deleted_at;
alter table public.support_internal_notes drop column if exists edited_at;
alter table public.support_internal_notes drop column if exists updated_by;

drop trigger if exists support_customers_zz_contacts on public.support_customers;
drop function if exists private.support_customer_contacts();
alter table public.support_customers drop constraint if exists support_customers_agent_fk;
drop index if exists public.support_customers_agent_idx;
drop index if exists public.support_customers_type_idx;
alter table public.support_customers drop column if exists assigned_agent_id, drop column if exists country, drop column if exists pin_code, drop column if exists state,
  drop column if exists city, drop column if exists customer_category, drop column if exists customer_type, drop column if exists gstin, drop column if exists alternate_email,
  drop column if exists email, drop column if exists landline, drop column if exists alternate_phone, drop column if exists mobile, drop column if exists contact_person;

-- Field system back to tickets only.
delete from public.support_ticket_field_layout where module = 'CUSTOMER';
delete from public.support_ticket_field_definitions where module = 'CUSTOMER';
drop function if exists public.support_fields_save_layout(text, jsonb, text);
drop function if exists public.support_field_save(text, uuid, jsonb);
drop function if exists public.support_fields_admin(text);
create or replace function private.support_ticket_layout(p_company uuid)
returns table (standard_key text, field_definition_id uuid, display_order int, is_visible boolean, is_required_override boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select s.standard_key, null::uuid, coalesce(l.display_order, s.default_order), coalesce(l.is_visible, true) or s.locked, l.is_required_override
  from private.support_ticket_standard_fields() s
  left join public.support_ticket_field_layout l on l.company_id = p_company and l.standard_key = s.standard_key
  union all
  select null, l.field_definition_id, l.display_order, l.is_visible, l.is_required_override
  from public.support_ticket_field_layout l where l.company_id = p_company and l.field_definition_id is not null;
$$;
create or replace function private.support_ticket_layout_stamp(p_company uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select md5(coalesce(string_agg(concat_ws(':', coalesce(l.standard_key, l.field_definition_id::text), l.display_order, l.is_visible, l.is_required_override),
    ',' order by coalesce(l.standard_key, l.field_definition_id::text)), ''))
  from public.support_ticket_field_layout l where l.company_id = p_company;
$$;
create or replace function private.support_ticket_field_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and (new.field_key <> old.field_key or new.field_type <> old.field_type or new.company_id <> old.company_id) then
    raise exception 'The internal key and the type of a ticket field cannot be changed after it is created.' using errcode = 'P0001';
  end if;
  if new.is_active and (tg_op = 'INSERT' or not old.is_active) then
    -- One writer at a time per company, so two saves cannot both take the 25th place.
    perform pg_advisory_xact_lock(hashtextextended('support_ticket_fields:' || new.company_id::text, 0));
    if (select count(*) from public.support_ticket_field_definitions d where d.company_id = new.company_id and d.is_active and d.id <> new.id) >= 25 then
      raise exception 'A company can have at most 25 active custom ticket fields. Deactivate one first.' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;
create or replace function private.support_ticket_field_config(p_company uuid, p_type text, p_key text, p jsonb)
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
      select field_type into v_ref_type from public.support_ticket_field_definitions where company_id = p_company and field_key = v_ref;
      if v_ref_type is null then
        raise exception 'The formula uses {%}, which is not a ticket field.', v_ref using errcode = 'P0001';
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
    if not exists (select 1 from public.support_ticket_field_definitions where company_id = p_company and field_key = k) then
      raise exception 'Unknown ticket field "%".', k using errcode = 'P0001';
    end if;
  end loop;
  for d in select * from public.support_ticket_field_definitions where company_id = p_company order by created_at loop
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
create or replace function public.support_ticket_fields_admin()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support_ticket_fields.view');
begin
  return jsonb_build_object(
    'stamp', private.support_ticket_layout_stamp(v_company),
    'max_custom', 25,
    'active_custom', (select count(*) from public.support_ticket_field_definitions where company_id = v_company and is_active),
    'standard', (select jsonb_agg(jsonb_build_object('standard_key', s.standard_key, 'label', s.label, 'field_type', s.field_type, 'locked', s.locked,
        'required', s.required, 'required_editable', s.required_editable) order by s.default_order) from private.support_ticket_standard_fields() s),
    'definitions', coalesce((select jsonb_agg(private.support_ticket_field_json(d) || jsonb_build_object(
        'value_count', (select count(*) from public.support_ticket_field_values v where v.field_definition_id = d.id)) order by d.created_at)
      from public.support_ticket_field_definitions d where d.company_id = v_company), '[]'::jsonb),
    'layout', coalesce((select jsonb_agg(jsonb_build_object('standard_key', l.standard_key, 'field_definition_id', l.field_definition_id,
        'display_order', l.display_order, 'is_visible', l.is_visible, 'is_required_override', l.is_required_override)
        order by l.display_order, l.standard_key nulls last) from private.support_ticket_layout(v_company) l), '[]'::jsonb),
    'can', jsonb_build_object('create', private.has_permission(v_company, 'support_ticket_fields.create'),
      'update', private.has_permission(v_company, 'support_ticket_fields.update'),
      'delete', private.has_permission(v_company, 'support_ticket_fields.delete')));
end;
$$;
create or replace function public.support_ticket_field_save(p_id uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support_ticket_fields.view');
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
    perform private.require_permission('support_ticket_fields.create');
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
    while exists (select 1 from public.support_ticket_field_definitions where company_id = v_company and field_key = v_key) loop
      v_n := v_n + 1;
      v_key := v_base || '_' || v_n;
    end loop;
    d.company_id := v_company;
    d.field_key := v_key;
    d.field_type := v_type;
    d.is_active := true;
  else
    select * into d from public.support_ticket_field_definitions where id = p_id and company_id = v_company for update;
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
      perform private.require_permission(case when v_active then 'support_ticket_fields.update' else 'support_ticket_fields.delete' end);
    end if;
    if (p - 'is_active') <> '{}'::jsonb then
      perform private.require_permission('support_ticket_fields.update');
    end if;
    if p ? 'field_label' and v_label is null then
      raise exception 'Enter the field label.' using errcode = 'P0001';
    end if;
    d.is_active := v_active;
  end if;

  if p ? 'field_label' or p_id is null then d.field_label := v_label; end if;
  if p ? 'field_config' or p_id is null then
    d.field_config := private.support_ticket_field_config(v_company, d.field_type, d.field_key, p -> 'field_config');
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
    insert into public.support_ticket_field_definitions (company_id, field_label, field_key, field_type, field_config, is_required, is_active, default_value,
      help_text, placeholder, visibility, created_by, updated_by)
    values (v_company, d.field_label, d.field_key, d.field_type, d.field_config, d.is_required, true, d.default_value, d.help_text, d.placeholder, d.visibility,
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
  perform private.support_audit(v_company, case when p_id is null then 'ticket_field.created' else 'ticket_field.updated' end, 'ticket_field', v_new.id::text,
    jsonb_build_object('field_key', v_new.field_key, 'field_type', v_new.field_type, 'is_active', v_new.is_active));
  return private.support_ticket_field_json(v_new);
end;
$$;
create or replace function public.support_ticket_fields_save_layout(p_used jsonb, p_stamp text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support_ticket_fields.update');
  it jsonb;
  i int := 0;
  s record;
  d public.support_ticket_field_definitions;
  v_seen text[] := '{}';
  v_target text;
  v_req boolean;
begin
  perform pg_advisory_xact_lock(hashtextextended('support_ticket_layout:' || v_company::text, 0));
  if p_stamp is distinct from private.support_ticket_layout_stamp(v_company) then
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
      select * into s from private.support_ticket_standard_fields() f where f.standard_key = it ->> 'standard_key';
      if s.standard_key is null then
        raise exception 'Unknown standard field "%".', it ->> 'standard_key' using errcode = 'P0001';
      end if;
      if v_req is not null and not s.required_editable and v_req is distinct from s.required then
        raise exception '% cannot be made % here.', s.label, case when v_req then 'required' else 'optional' end using errcode = 'P0001';
      end if;
      insert into public.support_ticket_field_layout (company_id, standard_key, display_order, is_visible, is_required_override, updated_by)
      values (v_company, s.standard_key, i * 10, true, case when s.required_editable then v_req end, auth.uid())
      on conflict (company_id, standard_key) do update set display_order = excluded.display_order, is_visible = true,
        is_required_override = excluded.is_required_override, updated_by = auth.uid();
    else
      select * into d from public.support_ticket_field_definitions where id = (it ->> 'field_definition_id')::uuid and company_id = v_company;
      if d.id is null then
        raise exception 'Ticket field not found in your company.' using errcode = 'P0001';
      end if;
      if not d.is_active then
        raise exception '% is inactive. Activate it before putting it on the form.', d.field_label using errcode = 'P0001';
      end if;
      if v_req and d.field_type in ('CHECKBOX', 'FORMULA') then
        raise exception '% fields cannot be required.', initcap(d.field_type) using errcode = 'P0001';
      end if;
      insert into public.support_ticket_field_layout (company_id, field_definition_id, display_order, is_visible, is_required_override, updated_by)
      values (v_company, d.id, i * 10, true, v_req, auth.uid())
      on conflict (company_id, field_definition_id) do update set display_order = excluded.display_order, is_visible = true,
        is_required_override = excluded.is_required_override, updated_by = auth.uid();
      d := null;
    end if;
    s := null;
  end loop;
  for s in select * from private.support_ticket_standard_fields() f where f.locked loop
    if not (s.standard_key = any (v_seen)) then
      raise exception '% is always on the New Ticket form.', s.label using errcode = 'P0001';
    end if;
  end loop;
  -- Fields taken off the form: kept (with their last place), hidden. Their saved values are untouched.
  insert into public.support_ticket_field_layout (company_id, standard_key, display_order, is_visible, updated_by)
  select v_company, f.standard_key, 100000, false, auth.uid() from private.support_ticket_standard_fields() f
  where not (f.standard_key = any (v_seen))
  on conflict (company_id, standard_key) do update set is_visible = false, updated_by = auth.uid();
  update public.support_ticket_field_layout set is_visible = false, updated_by = auth.uid()
  where company_id = v_company and field_definition_id is not null and not (field_definition_id::text = any (v_seen)) and is_visible;
  perform private.support_audit(v_company, 'ticket_field.layout_saved', 'ticket_field_layout', null, jsonb_build_object('fields', to_jsonb(v_seen)));
  return jsonb_build_object('stamp', private.support_ticket_layout_stamp(v_company));
end;
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
        from public.support_ticket_field_definitions d where d.company_id = v_company and d.field_type in ('NUMBER', 'CURRENCY')), '[]'::jsonb),
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
      where d.company_id = v_company and (v_manager or d.visibility = 'ALL_AGENTS')
        and ((coalesce(l.is_visible, false) and d.is_active) or v.id is not null)), '[]'::jsonb),
    'formula_inputs', coalesce((select jsonb_object_agg(d.field_key, v.value_json)
        from public.support_ticket_field_definitions d join public.support_ticket_field_values v on v.field_definition_id = d.id and v.ticket_id = t.id
        where d.company_id = v_company and d.field_type in ('NUMBER', 'CURRENCY')), '{}'::jsonb),
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

drop function if exists private.support_field_config(uuid, text, text, text, jsonb);
drop function if exists private.support_field_layout_stamp(uuid, text);
drop function if exists private.support_field_layout(uuid, text);
drop function if exists private.support_field_standard(text);
drop function if exists private.support_field_permission(text, text);
drop index if exists public.support_ticket_field_definitions_module_idx;
drop index if exists public.support_ticket_field_definitions_module_label_unique;
create unique index if not exists support_ticket_field_definitions_label_unique on public.support_ticket_field_definitions (company_id, lower(field_label)) where is_active;
alter table public.support_ticket_field_definitions drop constraint if exists support_ticket_field_definitions_module_key_unique;
alter table public.support_ticket_field_definitions add constraint support_ticket_field_definitions_key_unique unique (company_id, field_key);
alter table public.support_ticket_field_layout drop constraint if exists support_ticket_field_layout_module_standard_unique;
alter table public.support_ticket_field_layout add constraint support_ticket_field_layout_standard_unique unique (company_id, standard_key);
alter table public.support_ticket_field_layout drop constraint if exists support_ticket_field_layout_standard_key_check;
alter table public.support_ticket_field_layout add constraint support_ticket_field_layout_standard_key_check check (standard_key is null or standard_key in ('subject', 'customer', 'products',
  'customer_phone', 'customer_email', 'priority', 'assigned_agent', 'category', 'subcategory', 'department', 'description'));
alter table public.support_ticket_field_definitions drop constraint if exists support_ticket_field_definitions_module_check;
alter table public.support_ticket_field_layout drop constraint if exists support_ticket_field_layout_module_check;
alter table public.support_ticket_field_definitions drop column if exists module;
alter table public.support_ticket_field_layout drop column if exists module;

delete from public.role_permissions where permission_id in (select id from public.permissions where resource in ('support_customer_fields', 'support_customers'));
delete from public.permissions where resource in ('support_customer_fields', 'support_customers');

-- Customer matching of 20261210090000.
create or replace function private.support_match_customers(p_company uuid, p_phone text, p_email text)
returns table (customer_id uuid, matched_on text[])
language sql
stable
security definer
set search_path = ''
as $$
  with keys as (select private.support_normalize_phone(p_phone) as ph, private.support_normalize_email(p_email) as em)
  select c.id, array_remove(array[case when k.ph is not null and k.ph = any (c.normalized_phones) then 'phone' end,
                                  case when k.em is not null and k.em = any (c.normalized_emails) then 'email' end], null)
  from public.support_customers c cross join keys k
  where c.company_id = p_company and c.is_active
    and ((k.ph is not null and k.ph = any (c.normalized_phones)) or (k.em is not null and k.em = any (c.normalized_emails)))
  order by c.created_at;
$$;

-- ERP reset allowlist of 20261227090000.
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
    (4, 'support_agents', 'Support Centre', 'Support agents'),
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
