-- Rollback of 20261113090000_force_reset_direct.sql
-- Removes the direct force reset and restores the preview of 20261031090000
-- (environment approval and backup record required again). No data is changed.

begin;

drop function if exists public.erp_force_reset_now(uuid, uuid);

create or replace function public.erp_force_reset_preview(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company  uuid := private.current_company_id();
  v_plan     jsonb;
  v_approval jsonb;
  v_backup   jsonb;
  v_storage  jsonb;
  v_co       public.companies;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated. Open the force reset preview from the signed-in ERP application (auth.uid() is empty in the SQL Editor).'
      using errcode = '42501';
  end if;
  if v_company is null or p_company_id is distinct from v_company then
    raise exception 'You can only preview a force reset of the company your account belongs to.' using errcode = '42501';
  end if;
  if not private.has_role(v_company, 'SUPER_ADMIN') or not private.has_permission(v_company, 'system.reset_data') then
    raise exception 'Only a Super Admin with the system.reset_data permission can reset ERP data.' using errcode = '42501';
  end if;

  select * into v_co from public.companies where id = v_company;
  v_plan := private.erp_force_reset_plan(v_company);
  v_approval := private.erp_force_reset_active_approval(v_company);
  v_backup := private.erp_force_reset_valid_backup(v_company, null);
  select jsonb_build_object(
           'product_images', count(*) filter (where s.bucket = 'product-images'),
           'documents', count(*) filter (where s.bucket = 'documents'))
    into v_storage from private.erp_force_reset_storage_objects(v_company) s;

  return (v_plan - 'counts') || jsonb_build_object(
    'company', jsonb_build_object('id', v_co.id, 'code', v_co.company_code, 'name', coalesce(v_co.display_name, v_co.legal_name)),
    'approval', v_approval,
    'backup', v_backup,
    'storage', v_storage,
    'gates', jsonb_build_object(
      'authorized', true,
      'environment_approved', v_approval is not null,
      'backup_verified', v_backup is not null,
      'plan_reviewed', jsonb_array_length(v_plan -> 'blockers') = 0),
    'can_execute', v_approval is not null and v_backup is not null and jsonb_array_length(v_plan -> 'blockers') = 0,
    'generated_at', now());
end;
$$;

revoke all on function public.erp_force_reset_preview(uuid) from public, anon;
grant execute on function public.erp_force_reset_preview(uuid) to authenticated;

notify pgrst, 'reload schema';

commit;
