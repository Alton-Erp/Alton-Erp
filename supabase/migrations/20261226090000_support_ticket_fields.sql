-- =============================================================================
-- Support ticket field builder and Product Master links
--
-- Additive. Extends the existing Support Centre tickets (20261210090000); the ticket table, its numbering,
-- SLA, assignment, automation and notifications are unchanged (support_ticket_create is called as it is).
--
--   * support_ticket_field_definitions  custom ticket fields per company (stable field_key, immutable type)
--   * support_ticket_field_layout       order / visibility / required override of the New Ticket form, for the
--                                       standard fields (standard_key) and the custom fields (field_definition_id)
--   * support_ticket_field_values       custom field values per ticket (kept when a field is removed from the
--                                       form or deactivated; definitions with values cannot be deleted: FK)
--   * support_ticket_products           Product Master products on a ticket (real product id + name/SKU snapshot)
--
--   All four: company_id on every row, composite same-company foreign keys, RLS select-only, writes only
--   through the SECURITY DEFINER functions below. At most 25 active custom fields per company (trigger).
--   Formula fields are a small whitelisted arithmetic language (numbers, {field_key}, + - * / ( ),
--   ROUND MIN MAX ABS) validated here; nothing is ever executed as SQL or JavaScript. Their result is
--   calculated when shown, never stored.
--
--   Permissions (resource.action; actions cannot contain dots in this ERP):
--     support_ticket_fields.view / create / update / delete, support_ticket_products.view / manage
--
-- Rollback: supabase/rollback/20261226090000_support_ticket_fields_down.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Permissions
-- -----------------------------------------------------------------------------
insert into public.permissions (resource, action, description) values
  ('support_ticket_fields', 'view', 'View the ticket field builder (custom field definitions and the New Ticket layout)'),
  ('support_ticket_fields', 'create', 'Create custom ticket fields'),
  ('support_ticket_fields', 'update', 'Edit custom ticket fields and the New Ticket form layout'),
  ('support_ticket_fields', 'delete', 'Deactivate custom ticket fields (their saved values are kept)'),
  ('support_ticket_products', 'view', 'See the Product Master products linked to support tickets'),
  ('support_ticket_products', 'manage', 'Add, change and remove Product Master products on support tickets')
on conflict (code) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.resource in ('support_ticket_fields', 'support_ticket_products')
where r.code in ('SUPER_ADMIN', 'ADMIN')
on conflict do nothing;

-- Sales Manager (day-to-day support work): uses the fields and links products; does not change the field builder.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p
  on p.code in ('support_ticket_fields.view', 'support_ticket_products.view', 'support_ticket_products.manage')
where r.code = 'SALES_MANAGER'
on conflict do nothing;

-- -----------------------------------------------------------------------------
-- 2. Tables
-- -----------------------------------------------------------------------------
create table if not exists public.support_ticket_field_definitions (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies (id) on delete restrict,
  field_label     text not null check (length(btrim(field_label)) between 1 and 80 and field_label = btrim(field_label)),
  field_key       text not null check (field_key ~ '^cf_[a-z0-9_]{1,40}$'),
  field_type      text not null check (field_type in ('PICKLIST', 'TEXT', 'NUMBER', 'LOOKUP', 'FORMULA', 'DATE', 'CURRENCY', 'EMAIL', 'PHONE', 'URL', 'CHECKBOX', 'USER')),
  field_config    jsonb not null default '{}'::jsonb check (jsonb_typeof(field_config) = 'object' and length(field_config::text) <= 20000),
  is_required     boolean not null default false,
  is_active       boolean not null default true,
  default_value   jsonb check (default_value is null or length(default_value::text) <= 2000),
  help_text       text check (help_text is null or length(help_text) <= 300),
  placeholder     text check (placeholder is null or length(placeholder) <= 120),
  -- Who sees the value: every support user, or only users who manage tickets.
  visibility      text not null default 'ALL_AGENTS' check (visibility in ('ALL_AGENTS', 'TICKET_MANAGERS')),
  deactivated_at  timestamptz,
  deactivated_by  uuid,
  created_by      uuid,
  updated_by      uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint support_ticket_field_definitions_id_company_unique unique (id, company_id),
  constraint support_ticket_field_definitions_key_unique unique (company_id, field_key),
  constraint support_ticket_field_definitions_not_required check (not is_required or field_type not in ('CHECKBOX', 'FORMULA')),
  constraint support_ticket_field_definitions_inactive check (is_active or deactivated_at is not null)
);
create unique index if not exists support_ticket_field_definitions_label_unique
  on public.support_ticket_field_definitions (company_id, lower(field_label)) where is_active;

create table if not exists public.support_ticket_field_layout (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references public.companies (id) on delete restrict,
  field_definition_id   uuid,
  standard_key          text check (standard_key is null or standard_key in ('subject', 'customer', 'products', 'customer_phone', 'customer_email',
                          'priority', 'assigned_agent', 'category', 'subcategory', 'department', 'description')),
  display_order         integer not null check (display_order between 0 and 100000),
  is_visible            boolean not null default true,
  is_required_override  boolean,
  updated_by            uuid,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint support_ticket_field_layout_one_target check ((field_definition_id is null) <> (standard_key is null)),
  constraint support_ticket_field_layout_definition_fk foreign key (field_definition_id, company_id)
    references public.support_ticket_field_definitions (id, company_id) on delete restrict,
  constraint support_ticket_field_layout_definition_unique unique (company_id, field_definition_id),
  constraint support_ticket_field_layout_standard_unique unique (company_id, standard_key)
);

create table if not exists public.support_ticket_field_values (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references public.companies (id) on delete restrict,
  ticket_id             uuid not null,
  field_definition_id   uuid not null,
  value_json            jsonb not null check (value_json <> 'null'::jsonb and length(value_json::text) <= 4000),
  created_by            uuid,
  updated_by            uuid,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint support_ticket_field_values_ticket_fk foreign key (ticket_id, company_id) references public.support_tickets (id, company_id) on delete restrict,
  constraint support_ticket_field_values_definition_fk foreign key (field_definition_id, company_id)
    references public.support_ticket_field_definitions (id, company_id) on delete restrict,
  constraint support_ticket_field_values_unique unique (ticket_id, field_definition_id)
);

create table if not exists public.support_ticket_products (
  id                     uuid primary key default gen_random_uuid(),
  company_id             uuid not null references public.companies (id) on delete restrict,
  ticket_id              uuid not null,
  product_id             uuid not null,
  quantity               numeric(14,3) not null check (quantity > 0 and quantity <= 999999999),
  product_name_snapshot  text not null check (length(product_name_snapshot) between 1 and 200),
  sku_snapshot           text not null check (length(sku_snapshot) between 1 and 100),
  created_by             uuid,
  updated_by             uuid,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint support_ticket_products_ticket_fk foreign key (ticket_id, company_id) references public.support_tickets (id, company_id) on delete restrict,
  constraint support_ticket_products_product_fk foreign key (product_id, company_id) references public.products (id, company_id) on delete restrict,
  constraint support_ticket_products_unique unique (ticket_id, product_id)
);

create index if not exists support_ticket_field_definitions_company_idx on public.support_ticket_field_definitions (company_id, is_active);
create index if not exists support_ticket_field_layout_company_idx on public.support_ticket_field_layout (company_id, display_order);
create index if not exists support_ticket_field_values_company_idx on public.support_ticket_field_values (company_id, field_definition_id);
create index if not exists support_ticket_products_company_idx on public.support_ticket_products (company_id, product_id);
create index if not exists support_ticket_products_ticket_idx on public.support_ticket_products (ticket_id);

-- Product Master search by identifier (exact and prefix matches use these; name search uses products_company_name_idx).
create index if not exists products_company_ean_idx on public.products (company_id, ean) where ean is not null;
create index if not exists products_company_model_idx on public.products (company_id, lower(model_number)) where model_number is not null;

-- -----------------------------------------------------------------------------
-- 3. Row-level security: SELECT only, by permission. Writes go through the functions below.
-- -----------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['support_ticket_field_definitions', 'support_ticket_field_layout', 'support_ticket_field_values', 'support_ticket_products'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant all on table public.%I to service_role', t);
    execute format('grant select on table public.%I to authenticated', t);
    execute format('drop trigger if exists %I on public.%I', t || '_set_updated_at', t);
    execute format('create trigger %I before update on public.%I for each row execute function private.set_updated_at()', t || '_set_updated_at', t);
    execute format('drop trigger if exists %I on public.%I', t || '_audit', t);
    execute format('create trigger %I after insert or update or delete on public.%I for each row execute function private.support_audit_row()', t || '_audit', t);
  end loop;
end;
$$;

drop policy if exists support_ticket_field_definitions_select on public.support_ticket_field_definitions;
create policy support_ticket_field_definitions_select on public.support_ticket_field_definitions for select to authenticated
  using (private.has_permission(company_id, 'support.view'));
drop policy if exists support_ticket_field_layout_select on public.support_ticket_field_layout;
create policy support_ticket_field_layout_select on public.support_ticket_field_layout for select to authenticated
  using (private.has_permission(company_id, 'support.view'));
drop policy if exists support_ticket_field_values_select on public.support_ticket_field_values;
create policy support_ticket_field_values_select on public.support_ticket_field_values for select to authenticated
  using (private.has_permission(company_id, 'support.view')
         and (private.has_permission(company_id, 'support.manage_tickets')
              or exists (select 1 from public.support_ticket_field_definitions d where d.id = field_definition_id and d.visibility = 'ALL_AGENTS')));
drop policy if exists support_ticket_products_select on public.support_ticket_products;
create policy support_ticket_products_select on public.support_ticket_products for select to authenticated
  using (private.has_permission(company_id, 'support.view') and private.has_permission(company_id, 'support_ticket_products.view'));

-- -----------------------------------------------------------------------------
-- 4. Definition guard: stable key and type, at most 25 active custom fields per company
-- -----------------------------------------------------------------------------
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

drop trigger if exists support_ticket_field_definitions_guard on public.support_ticket_field_definitions;
create trigger support_ticket_field_definitions_guard before insert or update on public.support_ticket_field_definitions
  for each row execute function private.support_ticket_field_guard();

-- -----------------------------------------------------------------------------
-- 5. Standard fields, layout and formulas
-- -----------------------------------------------------------------------------
-- The existing New Ticket fields, in their current order. locked = always on the form; required_editable = an
-- administrator may make it required (the others are already required by the ticket rules, or have a default).
create or replace function private.support_ticket_standard_fields()
returns table (standard_key text, label text, field_type text, default_order int, locked boolean, required boolean, required_editable boolean)
language sql
immutable
set search_path = ''
as $$
  select * from (values
    ('subject', 'Subject', 'TEXT', 10, true, true, false),
    ('customer', 'Customer', 'LOOKUP', 20, true, false, false),
    ('products', 'Products (Product Master)', 'PRODUCTS', 30, false, false, true),
    ('customer_phone', 'Phone', 'PHONE', 40, false, false, false),
    ('customer_email', 'Email', 'EMAIL', 50, false, false, false),
    ('priority', 'Priority', 'PICKLIST', 60, false, false, false),
    ('assigned_agent', 'Assigned agent', 'USER', 70, false, false, true),
    ('category', 'Category', 'TEXT', 80, false, false, true),
    ('subcategory', 'Subcategory', 'TEXT', 90, false, false, true),
    ('department', 'Department', 'TEXT', 100, false, false, true),
    ('description', 'Description', 'TEXTAREA', 110, false, false, true)
  ) t (standard_key, label, field_type, default_order, locked, required, required_editable);
$$;

-- The effective layout: stored rows, plus every standard field without a row (visible, default order).
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

-- A short fingerprint of the stored layout, so two administrators cannot overwrite each other's work unknowingly.
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

-- Formula check: only numbers, {field_key} references, + - * / ( ) , and ROUND(x[, digits]) MIN(a, b, …)
-- MAX(a, b, …) ABS(x), in a valid order. Returns the referenced keys. Nothing is executed.
create or replace function private.support_ticket_formula_refs(p_expr text)
returns text[]
language plpgsql
immutable
set search_path = ''
as $$
declare
  m text[];
  tok text;
  expect_operand boolean := true;
  stack text[] := '{}';       -- per open parenthesis: '' (grouping) or the function name
  argc int[] := '{}';
  depth int := 0;
  refs text[] := '{}';
  fn text;
  pending_fn text;
begin
  if p_expr is null or length(btrim(p_expr)) = 0 then
    raise exception 'Enter the formula.' using errcode = 'P0001';
  end if;
  if length(p_expr) > 500 then
    raise exception 'A formula can be at most 500 characters.' using errcode = 'P0001';
  end if;
  for m in select regexp_matches(p_expr, '(\{[a-z][a-z0-9_]*\})|([0-9]+(?:\.[0-9]+)?)|([A-Za-z_]+)|([-+*/(),])|(\S)', 'g') loop
    if m[5] is not null then
      raise exception 'The formula contains "%", which is not allowed. Use numbers, {field_key}, + - * / ( ) and ROUND, MIN, MAX, ABS.', m[5] using errcode = 'P0001';
    end if;
    if pending_fn is not null and coalesce(m[4], '') <> '(' then
      raise exception 'Write % with brackets, for example %(…).', pending_fn, pending_fn using errcode = 'P0001';
    end if;
    if m[1] is not null or m[2] is not null then
      if not expect_operand then raise exception 'The formula is missing an operator before %.', coalesce(m[1], m[2]) using errcode = 'P0001'; end if;
      if m[1] is not null then refs := refs || substr(m[1], 2, length(m[1]) - 2); end if;
      expect_operand := false;
    elsif m[3] is not null then
      fn := upper(m[3]);
      if fn not in ('ROUND', 'MIN', 'MAX', 'ABS') then
        raise exception 'Unknown function "%". Only ROUND, MIN, MAX and ABS are allowed (fields are written as {field_key}).', m[3] using errcode = 'P0001';
      end if;
      if not expect_operand then raise exception 'The formula is missing an operator before %.', fn using errcode = 'P0001'; end if;
      pending_fn := fn;
    else
      tok := m[4];
      if tok = '(' then
        if not expect_operand then raise exception 'The formula is missing an operator before "(".' using errcode = 'P0001'; end if;
        depth := depth + 1;
        stack := stack || coalesce(pending_fn, '');
        argc := argc || 1;
        pending_fn := null;
      elsif tok = ')' then
        if depth = 0 then raise exception 'The formula has a ")" without a matching "(".' using errcode = 'P0001'; end if;
        if expect_operand then raise exception 'The formula has an empty or unfinished bracket.' using errcode = 'P0001'; end if;
        fn := stack[depth];
        if fn = 'ABS' and argc[depth] <> 1 then raise exception 'ABS takes one value.' using errcode = 'P0001'; end if;
        if fn = 'ROUND' and argc[depth] > 2 then raise exception 'ROUND takes a value and optionally the number of decimals.' using errcode = 'P0001'; end if;
        if fn in ('MIN', 'MAX') and argc[depth] < 2 then raise exception '% needs at least two values.', fn using errcode = 'P0001'; end if;
        stack := stack[1:depth - 1];
        argc := argc[1:depth - 1];
        depth := depth - 1;
        expect_operand := false;
      elsif tok = ',' then
        if depth = 0 or stack[depth] = '' then raise exception 'A comma can only separate the values of a function.' using errcode = 'P0001'; end if;
        if expect_operand then raise exception 'The formula has an empty value before ",".' using errcode = 'P0001'; end if;
        argc[depth] := argc[depth] + 1;
        expect_operand := true;
      else
        -- + - * / ; a leading + or - is a sign.
        if expect_operand then
          if tok not in ('+', '-') then raise exception 'The formula has an operator "%" without a value before it.', tok using errcode = 'P0001'; end if;
        else
          expect_operand := true;
        end if;
      end if;
    end if;
  end loop;
  if pending_fn is not null then raise exception 'Write % with brackets, for example %(…).', pending_fn, pending_fn using errcode = 'P0001'; end if;
  if depth > 0 then raise exception 'The formula has a "(" that is never closed.' using errcode = 'P0001'; end if;
  if expect_operand then raise exception 'The formula ends with an operator.' using errcode = 'P0001'; end if;
  return refs;
end;
$$;

-- -----------------------------------------------------------------------------
-- 6. Configuration and value validation (server-side; the form runs the same rules for messages)
-- -----------------------------------------------------------------------------
create or replace function private.support_ticket_num(p jsonb, p_key text, p_label text)
returns numeric
language plpgsql
immutable
set search_path = ''
as $$
declare
  v text := nullif(btrim(coalesce(p ->> p_key, '')), '');
begin
  if v is null then return null; end if;
  if v !~ '^-?[0-9]{1,15}(\.[0-9]{1,6})?$' then
    raise exception '% must be a number.', p_label using errcode = 'P0001';
  end if;
  return v::numeric;
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

-- A value for one field, checked and normalised; null when empty. Raises a message naming the field.
create or replace function private.support_ticket_field_value(d public.support_ticket_field_definitions, p_value jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c jsonb := d.field_config;
  s text;
  n numeric;
  v_id uuid;
  v_label text;
  v_cur text;
  o jsonb;
begin
  if p_value is null or p_value = 'null'::jsonb then return null; end if;
  if jsonb_typeof(p_value) in ('object', 'array') and d.field_type not in ('CURRENCY', 'LOOKUP', 'USER', 'PICKLIST') then
    raise exception '%: enter a single value.', d.field_label using errcode = 'P0001';
  end if;
  s := case when jsonb_typeof(p_value) = 'object' then null else btrim(p_value #>> '{}') end;
  if s = '' then return null; end if;
  case d.field_type
  when 'FORMULA' then
    raise exception '% is calculated and cannot be entered.', d.field_label using errcode = 'P0001';
  when 'TEXT' then
    if length(s) < coalesce((c ->> 'min_length')::int, 0) then
      raise exception '% needs at least % characters.', d.field_label, c ->> 'min_length' using errcode = 'P0001';
    end if;
    if length(s) > coalesce((c ->> 'max_length')::int, 255) then
      raise exception '% can have at most % characters.', d.field_label, coalesce(c ->> 'max_length', '255') using errcode = 'P0001';
    end if;
    return to_jsonb(s);
  when 'NUMBER' then
    if s !~ '^-?[0-9]{1,15}(\.[0-9]+)?$' then
      raise exception '% must be a number.', d.field_label using errcode = 'P0001';
    end if;
    n := s::numeric;
    if c ->> 'number_kind' = 'INTEGER' and n <> trunc(n) then
      raise exception '% must be a whole number.', d.field_label using errcode = 'P0001';
    end if;
    if n <> round(n, coalesce((c ->> 'decimals')::int, 2)) then
      raise exception '% can have at most % decimals.', d.field_label, coalesce(c ->> 'decimals', '2') using errcode = 'P0001';
    end if;
    if (c ->> 'min') is not null and n < (c ->> 'min')::numeric then
      raise exception '% must be at least %.', d.field_label, c ->> 'min' using errcode = 'P0001';
    end if;
    if (c ->> 'max') is not null and n > (c ->> 'max')::numeric then
      raise exception '% must be at most %.', d.field_label, c ->> 'max' using errcode = 'P0001';
    end if;
    return to_jsonb(n);
  when 'CURRENCY' then
    if jsonb_typeof(p_value) = 'object' then
      s := btrim(coalesce(p_value ->> 'amount', ''));
      v_cur := upper(coalesce(nullif(p_value ->> 'currency', ''), c ->> 'currency', 'INR'));
      if s = '' then return null; end if;
    else
      v_cur := coalesce(c ->> 'currency', 'INR');
    end if;
    if s !~ '^-?[0-9]{1,13}(\.[0-9]{1,2})?$' then
      raise exception '% must be an amount with at most 2 decimals.', d.field_label using errcode = 'P0001';
    end if;
    if v_cur <> coalesce(c ->> 'currency', 'INR') then
      raise exception '% is in %.', d.field_label, coalesce(c ->> 'currency', 'INR') using errcode = 'P0001';
    end if;
    n := s::numeric;
    if (c ->> 'min') is not null and n < (c ->> 'min')::numeric then
      raise exception '% must be at least %.', d.field_label, c ->> 'min' using errcode = 'P0001';
    end if;
    if (c ->> 'max') is not null and n > (c ->> 'max')::numeric then
      raise exception '% must be at most %.', d.field_label, c ->> 'max' using errcode = 'P0001';
    end if;
    return jsonb_build_object('amount', n, 'currency', v_cur);
  when 'DATE' then
    if s !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or to_char(to_date(s, 'YYYY-MM-DD'), 'YYYY-MM-DD') <> s then
      raise exception '% must be a date (YYYY-MM-DD).', d.field_label using errcode = 'P0001';
    end if;
    return to_jsonb(s);
  when 'EMAIL' then
    if length(s) > 320 or private.support_normalize_email(s) is null then
      raise exception '% must be an email address such as name@example.com.', d.field_label using errcode = 'P0001';
    end if;
    return to_jsonb(lower(s));
  when 'PHONE' then
    if s !~ '^\+?[0-9 ()-]{6,24}$' or length(regexp_replace(s, '[^0-9]', '', 'g')) not between 6 and 15 then
      raise exception '% must be a phone number (6 to 15 digits, optionally starting with +).', d.field_label using errcode = 'P0001';
    end if;
    return to_jsonb(s);
  when 'URL' then
    if length(s) > 2048 or s !~* '^https?://[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:[0-9]{1,5})?([/?#][^[:space:]]*)?$' then
      raise exception '% must be a web address starting with http:// or https://.', d.field_label using errcode = 'P0001';
    end if;
    return to_jsonb(s);
  when 'CHECKBOX' then
    if lower(s) in ('true', 'yes', '1') then return 'true'::jsonb; end if;
    if lower(s) in ('false', 'no', '0') then return 'false'::jsonb; end if;
    raise exception '% is ticked or not ticked.', d.field_label using errcode = 'P0001';
  when 'PICKLIST' then
    s := coalesce(s, p_value ->> 'id');
    select x into o from jsonb_array_elements(c -> 'options') x where x ->> 'id' = s;
    if o is null then
      raise exception 'Choose one of the options of %.', d.field_label using errcode = 'P0001';
    end if;
    return jsonb_build_object('id', o ->> 'id', 'label', o ->> 'label');
  when 'USER' then
    s := coalesce(s, p_value ->> 'id');
    if s !~ '^[0-9a-f-]{36}$' then raise exception 'Choose the user for %.', d.field_label using errcode = 'P0001'; end if;
    v_id := s::uuid;
    select coalesce(p.full_name, p.email) into v_label from public.profiles p
    where p.id = v_id and p.company_id = d.company_id and p.is_active
      and (c ->> 'scope' is distinct from 'AGENTS' or exists (select 1 from public.support_agents a where a.user_id = p.id and a.company_id = d.company_id and a.is_active));
    if v_label is null then
      raise exception '%: choose an active % of your company.', d.field_label, case when c ->> 'scope' = 'AGENTS' then 'support agent' else 'employee' end using errcode = 'P0001';
    end if;
    return jsonb_build_object('id', v_id, 'name', v_label);
  when 'LOOKUP' then
    s := coalesce(s, p_value ->> 'id');
    if s !~ '^[0-9a-f-]{36}$' then raise exception 'Choose the record for %.', d.field_label using errcode = 'P0001'; end if;
    v_id := s::uuid;
    v_label := case c ->> 'target'
      when 'PRODUCT' then (select x.sku || ' — ' || x.product_name from public.products x where x.id = v_id and x.company_id = d.company_id)
      when 'SUPPORT_CUSTOMER' then (select x.display_name || ' (' || x.customer_code || ')' from public.support_customers x where x.id = v_id and x.company_id = d.company_id)
      when 'ERP_CUSTOMER' then (select x.customer_code || ' — ' || x.customer_name from public.customers x where x.id = v_id and x.company_id = d.company_id)
      when 'SALES_ORDER' then (select x.sales_order_number || ' — ' || x.customer_name_snapshot from public.sales_orders x where x.id = v_id and x.company_id = d.company_id)
      when 'INVOICE' then (select coalesce(x.invoice_number, 'Draft invoice') || ' — ' || x.customer_legal_name from public.sales_invoices x where x.id = v_id and x.company_id = d.company_id)
      when 'SUPPORT_TICKET' then (select x.ticket_number || ' — ' || x.subject from public.support_tickets x where x.id = v_id and x.company_id = d.company_id)
    end;
    if v_label is null then
      raise exception '%: the chosen record was not found in your company.', d.field_label using errcode = 'P0001';
    end if;
    return jsonb_build_object('id', v_id, 'label', left(v_label, 300), 'target', c ->> 'target');
  end case;
  return null;
end;
$$;

-- Save custom field values of one ticket (create: required fields of the form and defaults; edit: only the keys
-- given). Returns the keys that changed.
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

-- Set the products of one ticket to the given list [{product_id, quantity}]. New links need an active product
-- (archived ones only with p_allow_archived and products.update); links to products archived later are kept.
create or replace function private.support_ticket_products_apply(p_company uuid, p_ticket uuid, p_items jsonb, p_allow_archived boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  it jsonb;
  v_ids uuid[] := '{}';
  v_pid uuid;
  v_qty numeric;
  pr public.products;
  v_old public.support_ticket_products;
  v_added text[] := '{}';
  v_removed text[] := '{}';
  v_changed text[] := '{}';
begin
  if p_items is null then return jsonb_build_object('added', '[]'::jsonb, 'removed', '[]'::jsonb, 'changed', '[]'::jsonb); end if;
  if jsonb_typeof(p_items) <> 'array' then
    raise exception 'Products must be a list.' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_items) > 50 then
    raise exception 'A ticket can list at most 50 products.' using errcode = 'P0001';
  end if;
  if p_allow_archived and not private.has_permission(p_company, 'products.update') then
    raise exception 'Only users who can edit the Product Master may add archived products (requires products.update).' using errcode = '42501';
  end if;
  for it in select * from jsonb_array_elements(p_items) loop
    if coalesce(it ->> 'product_id', '') !~ '^[0-9a-f-]{36}$' then
      raise exception 'Choose each product from the Product Master.' using errcode = 'P0001';
    end if;
    v_pid := (it ->> 'product_id')::uuid;
    if v_pid = any (v_ids) then
      raise exception 'A product is listed twice; change its quantity instead.' using errcode = 'P0001';
    end if;
    v_ids := v_ids || v_pid;
    if coalesce(it ->> 'quantity', '1') !~ '^[0-9]{1,9}(\.[0-9]{1,3})?$' or coalesce(it ->> 'quantity', '1')::numeric <= 0 then
      raise exception 'Each product quantity must be more than 0 (at most 3 decimals).' using errcode = 'P0001';
    end if;
    v_qty := coalesce(it ->> 'quantity', '1')::numeric;
    select * into pr from public.products where id = v_pid and company_id = p_company;
    if not found then
      raise exception 'Product not found in your company.' using errcode = 'P0001';
    end if;
    select * into v_old from public.support_ticket_products where ticket_id = p_ticket and product_id = v_pid;
    if v_old.id is null then
      if (pr.status <> 'ACTIVE' or pr.archived_at is not null) and not p_allow_archived then
        raise exception 'Product % (%) is archived or inactive and cannot be added to a ticket.', pr.product_name, pr.sku using errcode = 'P0001';
      end if;
      insert into public.support_ticket_products (company_id, ticket_id, product_id, quantity, product_name_snapshot, sku_snapshot, created_by, updated_by)
      values (p_company, p_ticket, v_pid, v_qty, left(pr.product_name, 200), left(pr.sku, 100), auth.uid(), auth.uid());
      v_added := v_added || pr.sku;
    elsif v_old.quantity <> v_qty then
      update public.support_ticket_products set quantity = v_qty, updated_by = auth.uid() where id = v_old.id;
      v_changed := v_changed || v_old.sku_snapshot;
    end if;
    v_old := null;
  end loop;
  select coalesce(array_agg(sku_snapshot order by sku_snapshot), '{}') into v_removed
  from public.support_ticket_products where ticket_id = p_ticket and not (product_id = any (v_ids));
  delete from public.support_ticket_products where ticket_id = p_ticket and not (product_id = any (v_ids));
  return jsonb_build_object('added', to_jsonb(v_added), 'removed', to_jsonb(v_removed), 'changed', to_jsonb(v_changed));
end;
$$;

-- The ticket may still be changed (same rule as support_ticket_update).
create or replace function private.support_ticket_editable(p_company uuid, p_ticket uuid)
returns public.support_tickets
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.support_tickets;
begin
  select * into t from public.support_tickets where id = p_ticket and company_id = p_company for update;
  if not found then
    raise exception 'Ticket not found in your company.' using errcode = 'P0001';
  end if;
  if t.merged_into_ticket_id is not null then
    raise exception 'Ticket % was merged into another ticket and cannot be changed.', t.ticket_number using errcode = 'P0001';
  end if;
  if t.status = 'CLOSED' then
    raise exception 'Ticket % is closed. Reopen it to make changes.', t.ticket_number using errcode = 'P0001';
  end if;
  return t;
end;
$$;

-- One custom field definition as the app sees it.
create or replace function private.support_ticket_field_json(d public.support_ticket_field_definitions)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('id', d.id, 'field_key', d.field_key, 'field_label', d.field_label, 'field_type', d.field_type, 'field_config', d.field_config,
    'is_required', d.is_required, 'is_active', d.is_active, 'default_value', d.default_value, 'help_text', d.help_text, 'placeholder', d.placeholder,
    'visibility', d.visibility, 'created_at', d.created_at, 'updated_at', d.updated_at);
$$;

revoke all on function private.support_ticket_field_guard(), private.support_ticket_standard_fields(), private.support_ticket_layout(uuid),
  private.support_ticket_layout_stamp(uuid), private.support_ticket_formula_refs(text), private.support_ticket_num(jsonb, text, text),
  private.support_ticket_field_config(uuid, text, text, jsonb), private.support_ticket_field_value(public.support_ticket_field_definitions, jsonb),
  private.support_ticket_values_apply(uuid, uuid, jsonb, boolean), private.support_ticket_products_apply(uuid, uuid, jsonb, boolean),
  private.support_ticket_editable(uuid, uuid), private.support_ticket_field_json(public.support_ticket_field_definitions)
  from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 7. Field builder (Support → Settings → Ticket fields)
-- -----------------------------------------------------------------------------
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

-- Create (p_id null) or edit a custom field. The key is generated from the label once and never changes;
-- the type cannot change. Deactivating needs support_ticket_fields.delete and removes the field from the form
-- (saved values are kept and still shown on the tickets).
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

-- Save the New Ticket form: p_used = the fields on the form, in order [{standard_key | field_definition_id, is_required}].
-- Everything else is kept but hidden. p_stamp is the stamp read with the layout (refused if someone saved meanwhile).
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

-- -----------------------------------------------------------------------------
-- 8. New Ticket form, ticket values and products
-- -----------------------------------------------------------------------------
-- The fields of the New Ticket form, in order (standard and active custom fields).
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

-- Create a ticket with its custom field values and products in one transaction (the existing
-- support_ticket_create does the ticket itself: number, SLA, automation, notifications).
create or replace function public.support_ticket_create_v2(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.manage_tickets');
  r jsonb;
  s record;
  v_products jsonb := p -> 'products';
  v_has_products boolean := jsonb_typeof(p -> 'products') = 'array' and jsonb_array_length(p -> 'products') > 0;
  v_missing text[] := '{}';
  v_values text[];
begin
  -- Standard fields the administrator made required on the form.
  for s in select f.standard_key, f.label from private.support_ticket_layout(v_company) l join private.support_ticket_standard_fields() f on f.standard_key = l.standard_key
           where l.is_visible and f.required_editable and l.is_required_override loop
    if (s.standard_key = 'products' and not v_has_products)
       or (s.standard_key = 'assigned_agent' and nullif(p ->> 'assigned_agent_id', '') is null)
       or (s.standard_key in ('category', 'subcategory', 'department', 'description') and nullif(btrim(coalesce(p ->> s.standard_key, '')), '') is null) then
      v_missing := v_missing || s.label;
    end if;
  end loop;
  if cardinality(v_missing) > 0 then
    raise exception 'Fill in the required fields: %.', array_to_string(v_missing, ', ') using errcode = 'P0001';
  end if;
  if v_has_products and not (private.has_permission(v_company, 'support_ticket_products.manage') and private.has_permission(v_company, 'products.read')) then
    raise exception 'You are not allowed to add products to tickets (requires support_ticket_products.manage and products.read).' using errcode = '42501';
  end if;
  r := public.support_ticket_create(p - 'custom_fields' - 'products' - 'allow_archived_products');
  v_values := private.support_ticket_values_apply(v_company, (r ->> 'id')::uuid, coalesce(p -> 'custom_fields', '{}'::jsonb), true);
  if v_has_products then
    perform private.support_ticket_products_apply(v_company, (r ->> 'id')::uuid, v_products, coalesce((p ->> 'allow_archived_products')::boolean, false));
  end if;
  return r || jsonb_build_object('custom_fields', cardinality(v_values), 'products', case when v_has_products then jsonb_array_length(v_products) else 0 end);
end;
$$;

-- Custom field values and products of one ticket, for the ticket page.
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

create or replace function public.support_ticket_custom_fields_save(p_ticket uuid, p_values jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.manage_tickets');
  v_changed text[];
begin
  perform private.support_ticket_editable(v_company, p_ticket);
  v_changed := private.support_ticket_values_apply(v_company, p_ticket, p_values, false);
  if cardinality(v_changed) > 0 then
    update public.support_tickets set updated_by = auth.uid(), updated_at = now() where id = p_ticket;
    perform private.support_ticket_event(p_ticket, 'UPDATED', null, null, jsonb_build_object('custom_fields', to_jsonb(v_changed)));
  end if;
  return jsonb_build_object('changed', to_jsonb(v_changed));
end;
$$;

create or replace function public.support_ticket_products_save(p_ticket uuid, p_items jsonb, p_allow_archived boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support_ticket_products.manage');
  r jsonb;
begin
  perform private.require_permission('products.read');
  perform private.support_ticket_editable(v_company, p_ticket);
  r := private.support_ticket_products_apply(v_company, p_ticket, coalesce(p_items, '[]'::jsonb), coalesce(p_allow_archived, false));
  if r <> jsonb_build_object('added', '[]'::jsonb, 'removed', '[]'::jsonb, 'changed', '[]'::jsonb) then
    update public.support_tickets set updated_by = auth.uid(), updated_at = now() where id = p_ticket;
    perform private.support_ticket_event(p_ticket, 'UPDATED', null, null, jsonb_build_object('products', r));
  end if;
  return r;
end;
$$;

-- Product Master search for tickets (name, SKU, model number / product code, barcode, EAN). Active products only;
-- archived ones too when asked by a user who may edit the Product Master.
create or replace function public.support_ticket_product_search(p_term text, p_include_archived boolean default false, p_limit integer default 15)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support_ticket_products.manage');
  v_term text := btrim(left(coalesce(p_term, ''), 80));
  v_esc text;
  v_like text;
  v_archived boolean := coalesce(p_include_archived, false);
begin
  perform private.require_permission('products.read');
  if v_archived and not private.has_permission(v_company, 'products.update') then
    raise exception 'Only users who can edit the Product Master may search archived products (requires products.update).' using errcode = '42501';
  end if;
  if v_term = '' then return '[]'::jsonb; end if;
  v_esc := replace(replace(replace(lower(v_term), '\', '\\'), '%', '\%'), '_', '\_');
  v_like := '%' || v_esc || '%';
  return coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'sku', x.sku, 'product_name', x.product_name, 'model_number', x.model_number,
      'barcode', x.barcode, 'ean', x.ean, 'brand', x.brand, 'base_unit', x.base_unit, 'archived', x.status <> 'ACTIVE' or x.archived_at is not null) order by x.rank, x.product_name)
    from (select p.*, case
                   when lower(p.sku) = lower(v_term) or p.barcode = v_term or p.ean = v_term then 0
                   when lower(p.sku) like v_esc || '%' escape '\' then 1
                   when lower(p.model_number) = lower(v_term) then 1
                   when lower(p.product_name) like v_esc || '%' escape '\' then 2
                   else 3 end as rank
          from public.products p
          where p.company_id = v_company
            and (v_archived or (p.status = 'ACTIVE' and p.archived_at is null))
            and (lower(p.sku) like v_like escape '\' or lower(p.product_name) like v_like escape '\' or lower(coalesce(p.model_number, '')) like v_like escape '\'
                 or lower(coalesce(p.barcode, '')) like v_like escape '\' or lower(coalesce(p.ean, '')) like v_like escape '\'
                 or lower(coalesce(p.supplier_model_number, '')) like v_like escape '\')
          order by rank, p.product_name
          limit least(greatest(coalesce(p_limit, 15), 1), 50)) x), '[]'::jsonb);
end;
$$;

-- Records for a lookup field. Each target needs the permission that already protects it in the ERP.
create or replace function public.support_ticket_lookup_search(p_target text, p_term text, p_limit integer default 10)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.view');
  v_like text := '%' || replace(replace(replace(lower(btrim(left(coalesce(p_term, ''), 80))), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  v_limit int := least(greatest(coalesce(p_limit, 10), 1), 25);
begin
  case p_target
  when 'PRODUCT' then
    perform private.require_permission('products.read');
    return coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'label', x.sku || ' — ' || x.product_name)) from (
      select id, sku, product_name from public.products where company_id = v_company and status = 'ACTIVE' and archived_at is null
        and (lower(sku) like v_like escape '\' or lower(product_name) like v_like escape '\' or lower(coalesce(barcode, '')) like v_like escape '\')
      order by product_name limit v_limit) x), '[]'::jsonb);
  when 'SUPPORT_CUSTOMER' then
    return coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'label', x.display_name || ' (' || x.customer_code || ')')) from (
      select id, display_name, customer_code from public.support_customers where company_id = v_company and is_active
        and (lower(display_name) like v_like escape '\' or lower(customer_code) like v_like escape '\')
      order by display_name limit v_limit) x), '[]'::jsonb);
  when 'ERP_CUSTOMER' then
    perform private.require_permission('customers.read');
    return coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'label', x.customer_code || ' — ' || x.customer_name)) from (
      select id, customer_code, customer_name from public.customers where company_id = v_company
        and (lower(customer_name) like v_like escape '\' or lower(customer_code) like v_like escape '\')
      order by customer_name limit v_limit) x), '[]'::jsonb);
  when 'SALES_ORDER' then
    perform private.require_permission('sales_orders.read');
    return coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'label', x.sales_order_number || ' — ' || x.customer_name_snapshot)) from (
      select id, sales_order_number, customer_name_snapshot, created_at from public.sales_orders where company_id = v_company
        and (lower(sales_order_number) like v_like escape '\' or lower(customer_name_snapshot) like v_like escape '\')
      order by created_at desc limit v_limit) x), '[]'::jsonb);
  when 'INVOICE' then
    perform private.require_permission('invoices.read');
    return coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'label', coalesce(x.invoice_number, 'Draft invoice') || ' — ' || x.customer_legal_name)) from (
      select id, invoice_number, customer_legal_name, created_at from public.sales_invoices where company_id = v_company
        and (lower(coalesce(invoice_number, '')) like v_like escape '\' or lower(customer_legal_name) like v_like escape '\')
      order by created_at desc limit v_limit) x), '[]'::jsonb);
  when 'SUPPORT_TICKET' then
    return coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'label', x.ticket_number || ' — ' || x.subject)) from (
      select id, ticket_number, subject, created_at from public.support_tickets where company_id = v_company
        and (lower(ticket_number) like v_like escape '\' or lower(subject) like v_like escape '\')
      order by created_at desc limit v_limit) x), '[]'::jsonb);
  else
    raise exception 'Unknown lookup target %.', p_target using errcode = 'P0001';
  end case;
end;
$$;

-- Active employees (or support agents) for user fields: names only.
create or replace function public.support_ticket_user_options(p_scope text default 'EMPLOYEES')
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.view');
begin
  return coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', coalesce(p.full_name, p.email),
      'is_agent', exists (select 1 from public.support_agents a where a.user_id = p.id and a.company_id = v_company and a.is_active)) order by coalesce(p.full_name, p.email))
    from public.profiles p
    where p.company_id = v_company and p.is_active
      and (coalesce(p_scope, 'EMPLOYEES') <> 'AGENTS' or exists (select 1 from public.support_agents a where a.user_id = p.id and a.company_id = v_company and a.is_active))), '[]'::jsonb);
end;
$$;

revoke all on function public.support_ticket_fields_admin(), public.support_ticket_field_save(uuid, jsonb), public.support_ticket_fields_save_layout(jsonb, text),
  public.support_ticket_form(), public.support_ticket_create_v2(jsonb), public.support_ticket_extras(uuid), public.support_ticket_custom_fields_save(uuid, jsonb),
  public.support_ticket_products_save(uuid, jsonb, boolean), public.support_ticket_product_search(text, boolean, integer),
  public.support_ticket_lookup_search(text, text, integer), public.support_ticket_user_options(text)
  from public, anon;
grant execute on function public.support_ticket_fields_admin(), public.support_ticket_field_save(uuid, jsonb), public.support_ticket_fields_save_layout(jsonb, text),
  public.support_ticket_form(), public.support_ticket_create_v2(jsonb), public.support_ticket_extras(uuid), public.support_ticket_custom_fields_save(uuid, jsonb),
  public.support_ticket_products_save(uuid, jsonb, boolean), public.support_ticket_product_search(text, boolean, integer),
  public.support_ticket_lookup_search(text, text, integer), public.support_ticket_user_options(text)
  to authenticated;

-- -----------------------------------------------------------------------------
-- 9. ERP reset allowlist (20261224090000 plus the four ticket field / product tables; values and links first)
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
