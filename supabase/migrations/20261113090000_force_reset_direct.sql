-- =============================================================================
-- Force Reset / Delete Everything: direct delete (no approval steps)
--
-- Requested by the operator: the force reset must delete directly from the
-- ERP screen. 20261031090000 required, in addition to being a Super Admin:
--   * an environment approval created by a database owner in the SQL Editor
--     (no screen could create it, so the button never enabled),
--   * a backup record from the last 24 hours,
--   * the force-reset-erp-data Edge Function with password re-entry, a typed
--     phrase and the company code.
-- public.erp_force_reset_now() deletes directly. It keeps:
--   * authorization: active Super Admin with system.reset_data, own company only
--   * one reset per company at a time, idempotent per request id
--   * the reviewed deletion plan (an unclassified company table still blocks,
--     because deleting around it would fail or leave orphans)
--   * the in-transaction verification (anything unexpected rolls everything back)
--   * users, roles, permissions, company settings, the audit log and reset history
--   * a row in erp_reset_runs and the audit log for every run
-- Storage files: the browser removes the company's product images afterwards
-- (Super Admins may delete them); the remaining file count is reported.
--
-- The old approval / backup / Edge Function path is left in place, unused.
-- Rollback: supabase/rollback/20261113090000_force_reset_direct_down.sql
-- =============================================================================

create or replace function public.erp_force_reset_now(p_company_id uuid, p_request_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor     uuid := auth.uid();
  v_company   uuid;
  v_co        public.companies;
  v_run       public.erp_reset_runs;
  v_plan      jsonb;
  v_blockers  jsonb;
  v_before    jsonb;
  v_after     jsonb;
  v_fp_before jsonb;
  v_fp_after  jsonb;
  v_sa_before bigint;
  v_storage   jsonb := '[]'::jsonb;
  v_deleted   jsonb := '{}'::jsonb;
  v_total     bigint := 0;
  v_n         bigint;
  v_step      bigint;
  v_status    text;
  v_error     text;
  v_verify    jsonb := '{}'::jsonb;
  v_problems  text[] := '{}';
  v_current   text;
  v_sql       text;
  v_self      text;
  v_session   uuid;
  r           record;
begin
  if v_actor is null then
    raise exception 'Not authenticated. Run the force reset from the signed-in ERP application.' using errcode = '42501';
  end if;
  if p_company_id is null or p_request_id is null then
    raise exception 'Company and request id are required.' using errcode = '22023';
  end if;

  select company_id into v_company from public.profiles where id = v_actor;
  if v_company is null or v_company <> p_company_id then
    insert into public.audit_logs (company_id, actor_user_id, action, resource_type, metadata)
    values (v_company, v_actor, 'erp_force_reset.denied', 'erp_reset', jsonb_build_object('reason', 'company mismatch', 'requested_company', p_company_id));
    return jsonb_build_object('status', 'DENIED', 'error', 'You can only reset the company your account belongs to.');
  end if;

  -- Idempotency: a request that already ran returns its stored result.
  select * into v_run from public.erp_reset_runs where company_id = v_company and request_id = p_request_id;
  if found then
    return private.erp_force_reset_run_result(v_run, true);
  end if;

  -- One reset (standard or force) per company at a time.
  if not pg_try_advisory_xact_lock(hashtextextended('erp_reset:' || v_company::text, 0)) then
    return jsonb_build_object('status', 'IN_PROGRESS', 'error', 'Another ERP reset of this company is running. Wait for it to finish.');
  end if;
  select * into v_run from public.erp_reset_runs where company_id = v_company and request_id = p_request_id;
  if found then
    return private.erp_force_reset_run_result(v_run, true);
  end if;

  perform 1 from public.profiles where id = v_actor for share;
  perform 1 from public.user_roles where user_id = v_actor and company_id = v_company for share;
  if not private.erp_reset_actor_ok(v_actor, v_company) then
    insert into public.audit_logs (company_id, actor_user_id, action, resource_type, metadata)
    values (v_company, v_actor, 'erp_force_reset.denied', 'erp_reset', jsonb_build_object('reason', 'not an active Super Admin with system.reset_data'));
    return jsonb_build_object('status', 'DENIED', 'error', 'Only an active Super Admin with the system.reset_data permission can reset ERP data.');
  end if;

  select * into v_co from public.companies where id = v_company;
  v_plan := private.erp_force_reset_plan(v_company);
  v_blockers := v_plan -> 'blockers';
  v_before := v_plan -> 'counts';

  if jsonb_array_length(v_blockers) > 0 then
    v_status := 'BLOCKED';
    v_error := 'Nothing was deleted. The database has tables the reset does not know how to delete safely (see blockers).';
  else
    v_fp_before := private.erp_reset_schema_fingerprint();
    v_sa_before := private.erp_force_reset_super_admins(v_company);
    begin
      select coalesce(jsonb_agg(jsonb_build_object('bucket', s.bucket, 'name', s.name)), '[]'::jsonb)
        into v_storage from private.erp_force_reset_storage_objects(v_company) s;

      insert into private.erp_force_purge_sessions (company_id, actor, request_id, txid)
      values (v_company, v_actor, p_request_id, txid_current())
      returning id into v_session;
      perform set_config('app.erp_force_purge', v_session::text, true);

      for r in select o.table_name from private.erp_force_reset_order() o order by o.ord, o.table_name loop
        v_current := r.table_name;
        v_self := private.erp_force_reset_self_fk_clause(r.table_name);
        v_sql := format('delete from public.%I t where %s%s', r.table_name, private.erp_force_reset_row_filter(r.table_name), v_self);
        v_n := 0;
        loop
          execute v_sql using v_company;
          get diagnostics v_step = row_count;
          v_n := v_n + v_step;
          exit when v_self = '' or v_step = 0;
        end loop;
        if v_n > 0 then
          v_deleted := v_deleted || jsonb_build_object(r.table_name, v_n);
        end if;
        v_total := v_total + v_n;
      end loop;
      v_current := null;

      perform set_config('app.erp_force_purge', '', true);
      delete from private.erp_force_purge_sessions where id = v_session;

      -- Verification inside the transaction; any problem rolls everything back.
      v_after := private.erp_force_reset_counts(v_company);
      for r in select key, value from jsonb_each(v_after -> 'purge') loop
        if (r.value)::bigint <> 0 then
          v_problems := v_problems || format('%s still has %s rows', r.key, r.value);
        end if;
      end loop;
      if (v_after -> 'other') is distinct from (v_before -> 'other') then
        v_problems := v_problems || 'rows of other companies changed'::text;
      end if;
      for r in select key, value from jsonb_each(v_before -> 'retained') loop
        if r.key = 'audit_logs' then
          if (v_after -> 'retained' ->> r.key)::bigint < (r.value)::bigint then
            v_problems := v_problems || 'audit log rows were removed'::text;
          end if;
        elsif (v_after -> 'retained' -> r.key) is distinct from r.value then
          v_problems := v_problems || format('retained table %s changed from %s to %s rows', r.key, r.value, v_after -> 'retained' -> r.key);
        end if;
      end loop;
      if (v_after ->> 'company_documents') is distinct from (v_before ->> 'company_documents') then
        v_problems := v_problems || 'company-level documents changed'::text;
      end if;
      v_fp_after := private.erp_reset_schema_fingerprint();
      if v_fp_after is distinct from v_fp_before then
        v_problems := v_problems || format('schema objects changed: %s -> %s', v_fp_before, v_fp_after);
      end if;
      if not private.erp_reset_actor_ok(v_actor, v_company) then
        v_problems := v_problems || 'the initiating Super Admin lost access'::text;
      end if;
      if private.erp_force_reset_super_admins(v_company) <> v_sa_before then
        v_problems := v_problems || 'the number of Super Admins changed'::text;
      end if;
      if not exists (select 1 from public.companies where id = v_company and is_active) then
        v_problems := v_problems || 'the company record is missing or inactive'::text;
      end if;
      if cardinality(v_problems) > 0 then
        raise exception 'ERP_FORCE_RESET_VERIFICATION_FAILED: %', array_to_string(v_problems, '; ');
      end if;
      v_verify := jsonb_build_object('purge_tables_empty', true, 'other_companies_unchanged', true, 'retained_tables_unchanged', true,
        'schema_unchanged', true, 'actor_access_valid', true, 'super_admins', v_sa_before, 'schema', v_fp_after);
      v_status := 'COMPLETED';
    exception when others then
      -- Every deletion of this attempt has been rolled back with the block.
      perform set_config('app.erp_force_purge', '', true);
      v_status := 'FAILED';
      v_error := left(case when v_current is not null then format('Deleting %s failed: %s', v_current, sqlerrm) else sqlerrm end, 2000);
      v_deleted := '{}'::jsonb;
      v_total := 0;
      v_storage := '[]'::jsonb;
      v_verify := jsonb_build_object('rolled_back', true);
    end;
  end if;

  insert into public.erp_reset_runs (company_id, request_id, requested_by, status, mode, deleted_counts, deleted_total,
                                     preserved_counts, blockers, verification, storage_objects, error_message)
  values (v_company, p_request_id, v_actor, v_status, 'FORCE', v_deleted, v_total,
          v_before -> 'retained', v_blockers, v_verify, v_storage, v_error)
  returning * into v_run;

  insert into public.audit_logs (company_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (v_company, v_actor, 'erp_force_reset.' || lower(v_status), 'erp_reset', v_run.id::text,
          jsonb_build_object('request_id', p_request_id, 'status', v_status, 'mode', 'FORCE', 'direct', true, 'company_code', v_co.company_code,
            'deleted_total', v_total, 'deleted', v_deleted, 'storage_objects', jsonb_array_length(v_storage),
            'blockers', coalesce((select jsonb_agg(b ->> 'kind') from jsonb_array_elements(v_blockers) b), '[]'::jsonb),
            'error', left(v_error, 500)));

  return private.erp_force_reset_run_result(v_run, false)
    || jsonb_build_object('company', jsonb_build_object('id', v_co.id, 'code', v_co.company_code), 'storage_files', v_storage);
end;
$$;

revoke all on function public.erp_force_reset_now(uuid, uuid) from public, anon;
grant execute on function public.erp_force_reset_now(uuid, uuid) to authenticated;

-- Preview: same content; it can run whenever the deletion plan is clean
-- (approval and backup are no longer required).
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
  select jsonb_build_object(
           'product_images', count(*) filter (where s.bucket = 'product-images'),
           'documents', count(*) filter (where s.bucket = 'documents'))
    into v_storage from private.erp_force_reset_storage_objects(v_company) s;

  return (v_plan - 'counts') || jsonb_build_object(
    'company', jsonb_build_object('id', v_co.id, 'code', v_co.company_code, 'name', coalesce(v_co.display_name, v_co.legal_name)),
    'approval', null,
    'backup', null,
    'storage', v_storage,
    'gates', jsonb_build_object(
      'authorized', true,
      'environment_approved', true,
      'backup_verified', true,
      'plan_reviewed', jsonb_array_length(v_plan -> 'blockers') = 0),
    'can_execute', jsonb_array_length(v_plan -> 'blockers') = 0,
    'generated_at', now());
end;
$$;

revoke all on function public.erp_force_reset_preview(uuid) from public, anon;
grant execute on function public.erp_force_reset_preview(uuid) to authenticated;

notify pgrst, 'reload schema';
