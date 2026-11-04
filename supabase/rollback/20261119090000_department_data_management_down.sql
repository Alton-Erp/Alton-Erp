-- =============================================================================
-- Rollback of 20261119090000_department_data_management.sql
--
-- Restores the guard functions exactly as they were, then removes the department
-- functions and the session tables. Department rows in erp_reset_runs are history and
-- are kept (that table is append-only); the four columns stay, so the rows stay readable.
-- The mode check keeps DEPARTMENT only if department runs exist, otherwise it is restored.
-- No business data is touched.
-- =============================================================================

-- 1. Guard functions as before (generated from the definitions before this migration)
CREATE OR REPLACE FUNCTION private.prevent_history_mutation()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if tg_op = 'DELETE' and coalesce(current_setting('app.erp_force_purge', true), '') <> '' then
    if private.erp_force_purge_allows(tg_table_name, (to_jsonb(old) ->> 'company_id')::uuid) then return old; end if;
  end if;
  raise exception 'History records cannot be changed or deleted.' using errcode = '42501';
end;
$function$;

CREATE OR REPLACE FUNCTION private.guard_bom_write()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if tg_op = 'DELETE' and coalesce(current_setting('app.erp_force_purge', true), '') <> '' then
    if private.erp_force_purge_allows(tg_table_name, (to_jsonb(old) ->> 'company_id')::uuid) then return old; end if;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'BOMs are never deleted; archive them instead.' using errcode = '42501';
  end if;
  new.company_id := old.company_id;
  new.bom_code := old.bom_code;
  new.finished_product_id := old.finished_product_id;
  new.version := old.version;
  new.created_by := old.created_by;
  new.created_at := old.created_at;
  if old.status in ('APPROVED', 'ARCHIVED')
     and (new.effective_from is distinct from old.effective_from
          or new.output_quantity is distinct from old.output_quantity
          or new.output_unit is distinct from old.output_unit
          or new.notes is distinct from old.notes
          or new.approved_by is distinct from old.approved_by) then
    raise exception 'An approved BOM cannot be changed. Create a new version instead.' using errcode = 'P0001';
  end if;
  if old.status = 'ARCHIVED' and new.status <> 'ARCHIVED' then
    raise exception 'An archived BOM cannot be reactivated. Create a new version instead.' using errcode = 'P0001';
  end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION private.guard_bom_item_write()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_status text;
begin
  if tg_op = 'DELETE' and coalesce(current_setting('app.erp_force_purge', true), '') <> '' then
    if private.erp_force_purge_allows(tg_table_name, (to_jsonb(old) ->> 'company_id')::uuid) then return old; end if;
  end if;
  select status into v_status from public.boms where id = coalesce(new.bom_id, old.bom_id);
  if tg_op = 'UPDATE' and v_status in ('DRAFT', 'REJECTED', 'PENDING_APPROVAL')
     and (to_jsonb(new) - 'component_version_id') = (to_jsonb(old) - 'component_version_id') then
    return new;
  end if;
  if v_status not in ('DRAFT', 'REJECTED') then
    raise exception 'Components of a % BOM cannot be changed. Create a new version instead.', lower(v_status) using errcode = 'P0001';
  end if;
  return coalesce(new, old);
end;
$function$;

CREATE OR REPLACE FUNCTION private.guard_product_version()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if tg_op = 'DELETE' then
    if coalesce(current_setting('app.erp_force_purge', true), '') <> '' and private.erp_force_purge_allows(tg_table_name, old.company_id) then
      return old;
    end if;
    raise exception 'Product versions are permanent history and cannot be deleted.' using errcode = '42501';
  end if;
  if not old.is_current or new.is_current or new.effective_to is null
     or (to_jsonb(new) - array['effective_to', 'is_current']) <> (to_jsonb(old) - array['effective_to', 'is_current']) then
    raise exception 'Historical product versions are read-only. Change the product to create a new version.' using errcode = '42501';
  end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION private.guard_invoice_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if tg_op = 'DELETE' and coalesce(current_setting('app.erp_force_purge', true), '') <> '' then
    if private.erp_force_purge_allows(tg_table_name, (to_jsonb(old) ->> 'company_id')::uuid) then return old; end if;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Invoices are never deleted. Discard a draft or cancel an issued invoice.' using errcode = 'P0001';
  end if;
  if old.status in ('CANCELLED', 'DISCARDED') then
    raise exception 'A % invoice cannot be changed.', lower(old.status) using errcode = 'P0001';
  end if;
  if old.status = 'ISSUED' then
    if new.status <> 'CANCELLED'
       or (to_jsonb(new) - array['status', 'cancelled_by', 'cancelled_at', 'cancellation_reason', 'updated_at', 'updated_by'])
          is distinct from (to_jsonb(old) - array['status', 'cancelled_by', 'cancelled_at', 'cancellation_reason', 'updated_at', 'updated_by']) then
      raise exception 'Issued invoice % cannot be edited. Use a credit or debit note, or cancel it through the approved workflow.', old.invoice_number
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION private.guard_invoice_line_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_status text;
begin
  if tg_op = 'DELETE' and coalesce(current_setting('app.erp_force_purge', true), '') <> '' then
    if private.erp_force_purge_allows(tg_table_name, (to_jsonb(old) ->> 'company_id')::uuid) then return old; end if;
  end if;
  select status into v_status from public.sales_invoices where id = coalesce(new.invoice_id, old.invoice_id);
  -- Drafts are edited; invoices pending approval are only recalculated at issue.
  if v_status is null or v_status not in ('DRAFT', 'PENDING_APPROVAL') then
    raise exception 'Lines of a % invoice cannot be changed.', replace(lower(coalesce(v_status, 'unknown')), '_', ' ') using errcode = 'P0001';
  end if;
  return coalesce(new, old);
end;
$function$;

CREATE OR REPLACE FUNCTION private.guard_note_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_status text;
begin
  if tg_op = 'DELETE' and coalesce(current_setting('app.erp_force_purge', true), '') <> '' then
    if private.erp_force_purge_allows(tg_table_name, (to_jsonb(old) ->> 'company_id')::uuid) then return old; end if;
  end if;
  if tg_table_name = 'invoice_adjustment_notes' then
    if tg_op = 'DELETE' then
      raise exception 'Credit and debit notes are never deleted.' using errcode = 'P0001';
    end if;
    if old.status in ('CANCELLED', 'DISCARDED') then
      raise exception 'A % note cannot be changed.', lower(old.status) using errcode = 'P0001';
    end if;
    if old.status = 'ISSUED' and (new.status <> 'CANCELLED'
       or (to_jsonb(new) - array['status', 'cancelled_by', 'cancelled_at', 'cancellation_reason', 'updated_at'])
          is distinct from (to_jsonb(old) - array['status', 'cancelled_by', 'cancelled_at', 'cancellation_reason', 'updated_at'])) then
      raise exception 'Issued note % cannot be edited; issue a new note instead.', old.note_number using errcode = 'P0001';
    end if;
    return new;
  end if;
  select status into v_status from public.invoice_adjustment_notes where id = coalesce(new.note_id, old.note_id);
  if v_status is null or v_status not in ('DRAFT', 'PENDING_APPROVAL') then
    raise exception 'Lines of a % note cannot be changed.', lower(coalesce(v_status, 'unknown')) using errcode = 'P0001';
  end if;
  return coalesce(new, old);
end;
$function$;

CREATE OR REPLACE FUNCTION private.production_material_removed()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if coalesce(current_setting('app.erp_force_purge', true), '') = ''
     and exists (select 1 from public.production_orders where id = old.production_order_id) then
    insert into public.production_order_revisions (company_id, production_order_id, kind, previous, reason, changed_by)
    values (old.company_id, old.production_order_id, 'MATERIAL_REMOVED', to_jsonb(old), private.production_revision_reason(), auth.uid());
  end if;
  return null;
end;
$function$;


-- 2. Public and private functions of the feature
drop function if exists public.department_data_execute(text, text, text[], text, text, uuid, uuid);
drop function if exists public.department_data_preview(text, text, text[]);
drop function if exists public.department_data_overview();
drop function if exists public.department_data_history(int);
drop function if exists private.dept_plan(uuid, text, text, text[]);
drop function if exists private.dept_row_counts(uuid);
drop function if exists private.dept_valid_request(text, text, text[]);
drop function if exists private.dept_recent_password(int);
drop function if exists private.dept_caller_company();
drop function if exists private.dept_row_label(text, text);
drop function if exists private.dept_of_table(text);
drop function if exists private.dept_key_col(text);
drop function if exists private.dept_table_ord(text);
drop function if exists private.dept_categories();
drop function if exists private.dept_purge_allows(text, uuid, text);

-- 3. Session tables (empty outside a running call)
drop table if exists private.dept_purge_rows;
drop table if exists private.dept_purge_sessions;

-- 4. Run history constraints
alter table public.erp_reset_runs drop constraint if exists erp_reset_runs_department_check;
do $$
begin
  if not exists (select 1 from public.erp_reset_runs where mode = 'DEPARTMENT') then
    alter table public.erp_reset_runs drop constraint if exists erp_reset_runs_mode_check;
    alter table public.erp_reset_runs add constraint erp_reset_runs_mode_check check (mode in ('STANDARD', 'FORCE'));
  end if;
end $$;
