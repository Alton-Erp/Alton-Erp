-- =============================================================================
-- Phase 10: barcode / QR lookup and assignment, user activity and sessions,
-- system health, and audit-trail coverage of the module event histories.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Barcode / QR
-- QR codes carry only an internal link "<app>/scan?c=<K>-<uuid>" (P product,
-- B batch, L location, W warehouse, F dispatch). Opening it requires signing in,
-- and this lookup checks the user's permission for every match.
-- -----------------------------------------------------------------------------
create or replace function public.barcode_lookup(p_code text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.current_company_id();
  v_code    text := btrim(coalesce(p_code, ''));
  v_kind    text;
  v_id      uuid;
  v_inv     boolean;
  v_matches jsonb := '[]'::jsonb;
  v_m       text[];
begin
  if v_company is null then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if v_code = '' or length(v_code) > 300 then
    raise exception 'Scan or enter a code (up to 300 characters).' using errcode = 'P0001';
  end if;
  v_inv := private.has_permission(v_company, 'inventory.read');
  v_m := regexp_match(v_code, '(?:^|[?&]c=)([PBLWF])-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$');
  if v_m is not null then
    v_kind := v_m[1];
    v_id := v_m[2]::uuid;
  end if;

  if private.has_permission(v_company, 'products.read') or v_inv then
    v_matches := v_matches || coalesce((select jsonb_agg(jsonb_build_object('kind', 'PRODUCT', 'id', p.id, 'label', p.sku, 'detail', p.product_name,
        'barcode', p.barcode, 'unit', p.base_unit, 'status', p.status,
        'matched_on', case when v_kind = 'P' then 'QR' when p.barcode = v_code then 'BARCODE' else 'SKU' end,
        'on_hand', case when v_inv then (select coalesce(sum(b.on_hand), 0) from public.inventory_balances b where b.product_id = p.id) end,
        'available', case when v_inv then (select coalesce(sum(b.on_hand - b.reserved), 0) from public.inventory_balances b
                                           join public.inventory_locations l on l.id = b.location_id where b.product_id = p.id and l.stock_usage = 'STORAGE') end,
        'track_batches', p.track_batches,
        'link', case when v_inv then '/inventory/stock/' || p.id else '/products/' || p.id end))
      from public.products p
      where p.company_id = v_company and p.archived_at is null
        and ((v_kind = 'P' and p.id = v_id) or (v_kind is null and (p.barcode = v_code or lower(p.sku) = lower(v_code))))), '[]'::jsonb);
  end if;
  if v_inv then
    v_matches := v_matches || coalesce((select jsonb_agg(jsonb_build_object('kind', 'BATCH', 'id', bt.id, 'label', coalesce(bt.batch_number, 'Untracked lot'),
        'detail', p.sku || ' — ' || p.product_name, 'product_id', p.id, 'unit', p.base_unit, 'source_type', bt.source_type, 'expiry_date', bt.expiry_date,
        'matched_on', case when v_kind = 'B' then 'QR' else 'BATCH_NUMBER' end,
        'on_hand', (select coalesce(sum(b.on_hand), 0) from public.inventory_balances b where b.batch_id = bt.id),
        'locations', (select coalesce(jsonb_agg(jsonb_build_object('location_id', b.location_id, 'warehouse', w.warehouse_code, 'location', l.location_code,
                        'on_hand', b.on_hand, 'reserved', b.reserved, 'usage', l.stock_usage) order by w.warehouse_code, l.location_code), '[]'::jsonb)
                      from public.inventory_balances b join public.inventory_locations l on l.id = b.location_id join public.warehouses w on w.id = b.warehouse_id
                      where b.batch_id = bt.id and b.on_hand > 0),
        'link', '/inventory/stock/' || p.id))
      from public.inventory_batches bt join public.products p on p.id = bt.product_id
      where bt.company_id = v_company and ((v_kind = 'B' and bt.id = v_id) or (v_kind is null and bt.batch_number is not null and lower(bt.batch_number) = lower(v_code)))
      limit 20), '[]'::jsonb);
    v_matches := v_matches || coalesce((select jsonb_agg(jsonb_build_object('kind', 'LOCATION', 'id', l.id, 'label', w.warehouse_code || '/' || l.location_code,
        'detail', l.location_name, 'warehouse_id', w.id, 'usage', l.stock_usage, 'status', l.status,
        'matched_on', case when v_kind = 'L' then 'QR' else 'LOCATION_CODE' end, 'link', '/inventory/warehouses'))
      from public.inventory_locations l join public.warehouses w on w.id = l.warehouse_id
      where l.company_id = v_company and ((v_kind = 'L' and l.id = v_id)
        or (v_kind is null and (lower(w.warehouse_code || '/' || l.location_code) = lower(v_code) or lower(l.location_code) = lower(v_code))))
      limit 20), '[]'::jsonb);
    v_matches := v_matches || coalesce((select jsonb_agg(jsonb_build_object('kind', 'WAREHOUSE', 'id', w.id, 'label', w.warehouse_code, 'detail', w.warehouse_name,
        'matched_on', case when v_kind = 'W' then 'QR' else 'WAREHOUSE_CODE' end, 'link', '/inventory/warehouses'))
      from public.warehouses w where w.company_id = v_company and ((v_kind = 'W' and w.id = v_id) or (v_kind is null and lower(w.warehouse_code) = lower(v_code)))), '[]'::jsonb);
  end if;
  if private.has_permission(v_company, 'fulfilment.read') then
    v_matches := v_matches || coalesce((select jsonb_agg(jsonb_build_object('kind', 'DISPATCH', 'id', f.id, 'label', f.fulfilment_number,
        'detail', so.sales_order_number || ' · ' || so.customer_name_snapshot, 'status', f.fulfilment_status,
        'matched_on', case when v_kind = 'F' then 'QR' else 'NUMBER' end, 'link', '/sales/delivery?f=' || f.id))
      from public.fulfilments f join public.sales_orders so on so.id = f.sales_order_id
      where f.company_id = v_company and ((v_kind = 'F' and f.id = v_id) or (v_kind is null and lower(f.fulfilment_number) = lower(v_code)))), '[]'::jsonb);
  end if;
  return jsonb_build_object('code', v_code, 'internal_qr', v_kind is not null, 'matches', v_matches);
end;
$$;

create or replace function public.product_assign_barcode(p_product_id uuid, p_barcode text, p_expected_current text default null, p_confirm_replace boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('products.update');
  v_p       public.products;
  v_new     text := nullif(btrim(coalesce(p_barcode, '')), '');
  v_other   text;
begin
  select * into v_p from public.products where id = p_product_id and company_id = v_company for update;
  if not found then
    raise exception 'Product not found in your company.' using errcode = 'P0001';
  end if;
  if v_new is not null and v_new !~ '^[A-Za-z0-9-]{4,64}$' then
    raise exception 'A barcode has 4-64 letters, digits or hyphens.' using errcode = 'P0001';
  end if;
  if v_p.barcode is not distinct from v_new then
    return jsonb_build_object('product_id', v_p.id, 'barcode', v_new, 'changed', false);
  end if;
  if v_p.barcode is distinct from nullif(btrim(coalesce(p_expected_current, '')), '') then
    raise exception 'The product''s barcode changed since you opened it (now %). Reload and try again.', coalesce(v_p.barcode, 'none') using errcode = 'P0001';
  end if;
  if v_p.barcode is not null and not coalesce(p_confirm_replace, false) then
    raise exception 'The product already has barcode %. Confirm that it should be replaced.', v_p.barcode using errcode = 'P0001';
  end if;
  if v_new is not null then
    select sku into v_other from public.products where company_id = v_company and barcode = v_new and id <> v_p.id;
    if found then
      raise exception 'Barcode % is already assigned to %.', v_new, v_other using errcode = 'P0001';
    end if;
  end if;
  update public.products set barcode = v_new, updated_by = auth.uid() where id = v_p.id;
  perform private.write_audit_log(v_company, 'product.barcode_changed', 'product', v_p.id::text,
    jsonb_build_object('module', 'products', 'result', 'success', 'sku', v_p.sku, 'old_barcode', v_p.barcode, 'new_barcode', v_new));
  return jsonb_build_object('product_id', v_p.id, 'barcode', v_new, 'changed', true);
end;
$$;

revoke all on function public.barcode_lookup(text) from public, anon;
revoke all on function public.product_assign_barcode(uuid, text, text, boolean) from public, anon;
grant execute on function public.barcode_lookup(text), public.product_assign_barcode(uuid, text, text, boolean) to authenticated;

-- -----------------------------------------------------------------------------
-- User activity (users.manage). Only non-secret facts are returned: no password
-- hashes, tokens, session ids or IP addresses.
-- -----------------------------------------------------------------------------
create or replace function public.user_activity_list()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('users.manage');
  v_has_login boolean := exists (select 1 from information_schema.columns where table_schema = 'auth' and table_name = 'users' and column_name = 'last_sign_in_at');
  v_rows jsonb;
begin
  select coalesce(jsonb_agg(x order by x ->> 'name'), '[]'::jsonb) into v_rows from (
    select jsonb_build_object('user_id', p.id, 'name', coalesce(p.full_name, p.email), 'email', p.email, 'is_active', p.is_active, 'created_at', p.created_at,
      'roles', coalesce((select jsonb_agg(r.code order by r.code) from public.user_roles ur join public.roles r on r.id = ur.role_id
                         where ur.user_id = p.id and ur.company_id = v_company), '[]'::jsonb),
      'last_activity_at', (select max(a.event_timestamp) from public.audit_logs a where a.actor_user_id = p.id and a.company_id = v_company),
      'last_sign_in_event_at', (select max(a.event_timestamp) from public.audit_logs a where a.actor_user_id = p.id and a.company_id = v_company and a.action = 'auth.sign_in'),
      'actions_30d', (select count(*) from public.audit_logs a where a.actor_user_id = p.id and a.company_id = v_company and a.event_timestamp > now() - interval '30 days'),
      'denied_30d', (select count(*) from public.audit_logs a where a.actor_user_id = p.id and a.company_id = v_company and a.action = 'auth.access_denied'
                     and a.event_timestamp > now() - interval '30 days')) x
    from public.profiles p where p.company_id = v_company) y;
  if v_has_login then
    -- Supabase Auth's own last sign-in time, when the column exists.
    execute $q$ select coalesce(jsonb_agg(e || jsonb_build_object('auth_last_sign_in_at', u.last_sign_in_at)), '[]'::jsonb)
                from jsonb_array_elements($1) e left join auth.users u on u.id = (e ->> 'user_id')::uuid $q$ into v_rows using v_rows;
  end if;
  return jsonb_build_object('users', v_rows, 'auth_sign_in_available', v_has_login, 'generated_at', now());
end;
$$;

create or replace function public.user_activity_detail(p_user_id uuid, p_limit int default 50)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('users.manage');
begin
  if not exists (select 1 from public.profiles where id = p_user_id and company_id = v_company) then
    raise exception 'User not found in your company.' using errcode = 'P0001';
  end if;
  return jsonb_build_object(
    'actions', coalesce((select jsonb_agg(jsonb_build_object('at', a.event_timestamp, 'action', a.action, 'resource_type', a.resource_type, 'resource_id', a.resource_id))
      from (select * from public.audit_logs a where a.company_id = v_company and a.actor_user_id = p_user_id order by a.event_timestamp desc limit least(greatest(p_limit, 1), 200)) a), '[]'::jsonb),
    'security_events', coalesce((select jsonb_agg(jsonb_build_object('at', a.event_timestamp, 'action', a.action, 'by', a.actor_user_id))
      from (select * from public.audit_logs a where a.company_id = v_company
              and (a.action like 'auth.%' or a.action like 'user.%' or a.action like 'user_role.%' or a.action like 'security.%')
              and (a.actor_user_id = p_user_id or a.resource_id = p_user_id::text)
            order by a.event_timestamp desc limit 50) a), '[]'::jsonb));
end;
$$;

-- Ends a user's sessions on the server: refresh tokens stop working, so the
-- user must sign in again once the current access token expires (Supabase
-- default: 1 hour). Access tokens already issued cannot be recalled.
create or replace function public.admin_revoke_sessions(p_user_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('users.manage');
  v_n       int;
begin
  if not exists (select 1 from public.profiles where id = p_user_id and company_id = v_company) then
    raise exception 'User not found in your company.' using errcode = 'P0001';
  end if;
  if p_user_id = auth.uid() then
    raise exception 'Use Sign out to end your own session.' using errcode = 'P0001';
  end if;
  if private.user_has_role(p_user_id, v_company, 'SUPER_ADMIN') and not private.has_role(v_company, 'SUPER_ADMIN') then
    raise exception 'Only a Super Admin can end a Super Admin''s sessions.' using errcode = '42501';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 5 then
    raise exception 'Enter the reason (at least 5 characters).' using errcode = 'P0001';
  end if;
  if to_regclass('auth.sessions') is null then
    return jsonb_build_object('revoked', false, 'reason', 'Session storage is not available in this environment.');
  end if;
  begin
    execute 'delete from auth.sessions where user_id = $1' using p_user_id;
    get diagnostics v_n = row_count;
  exception when insufficient_privilege then
    perform private.write_audit_log(v_company, 'security.sessions_revoke_failed', 'profile', p_user_id::text,
      jsonb_build_object('module', 'security', 'result', 'failure', 'reason', left(btrim(p_reason), 300)));
    return jsonb_build_object('revoked', false,
      'reason', 'The database role is not allowed to end sessions on this project. Use Supabase Dashboard > Authentication > Users to sign the user out.');
  end;
  perform private.write_audit_log(v_company, 'security.sessions_revoked', 'profile', p_user_id::text,
    jsonb_build_object('module', 'security', 'result', 'success', 'sessions', v_n, 'reason', left(btrim(p_reason), 300)));
  return jsonb_build_object('revoked', true, 'sessions', v_n);
end;
$$;

revoke all on function public.user_activity_list() from public, anon;
revoke all on function public.user_activity_detail(uuid, int) from public, anon;
revoke all on function public.admin_revoke_sessions(uuid, text) from public, anon;
grant execute on function public.user_activity_list(), public.user_activity_detail(uuid, int), public.admin_revoke_sessions(uuid, text) to authenticated;

-- -----------------------------------------------------------------------------
-- System health (system_health.read). Every status comes from a check run now;
-- components that are not set up are reported as NOT_CONFIGURED.
-- -----------------------------------------------------------------------------
create or replace function public.system_health_check()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('system_health.read');
  v_t0      timestamptz := clock_timestamp();
  v_checks  jsonb := '[]'::jsonb;
  v_n       bigint;
  v_txt     text;
  v_errors  bigint;
begin
  perform 1;
  v_checks := v_checks || jsonb_build_object('key', 'database', 'label', 'Database', 'status', 'HEALTHY',
    'detail', 'Query answered in ' || round(extract(epoch from clock_timestamp() - v_t0) * 1000, 1) || ' ms.');

  if to_regclass('supabase_migrations.schema_migrations') is not null then
    execute 'select max(version)::text, count(*) from supabase_migrations.schema_migrations' into v_txt, v_n;
    v_checks := v_checks || jsonb_build_object('key', 'migrations', 'label', 'Database migrations', 'status',
      case when v_txt >= '20261018090500' then 'HEALTHY' else 'DEGRADED' end,
      'detail', v_n || ' applied; latest ' || coalesce(v_txt, 'none') || case when v_txt >= '20261018090500' then '.' else ' (Phase 10 migrations missing).' end);
  else
    v_checks := v_checks || jsonb_build_object('key', 'migrations', 'label', 'Database migrations', 'status', 'NOT_CONFIGURED',
      'detail', 'Migration history is not tracked in this database (applied outside the Supabase CLI). Phase 10 objects are '
        || case when to_regclass('public.approval_requests') is not null and to_regclass('public.documents') is not null then 'present.' else 'missing.' end);
  end if;

  begin
    select count(*) into v_n from auth.users u join public.profiles p on p.id = u.id where p.company_id = v_company;
    v_checks := v_checks || jsonb_build_object('key', 'auth', 'label', 'Authentication', 'status', 'HEALTHY', 'detail', v_n || ' user account(s) in your company.');
  exception when others then
    v_checks := v_checks || jsonb_build_object('key', 'auth', 'label', 'Authentication', 'status', 'UNAVAILABLE', 'detail', 'The user store could not be read.');
  end;

  begin
    select count(*) into v_n from storage.buckets where id in ('documents', 'product-images') and not coalesce(public, false);
    v_checks := v_checks || jsonb_build_object('key', 'storage', 'label', 'File storage (buckets)',
      'status', case when v_n = 2 then 'HEALTHY' when v_n = 1 then 'DEGRADED' else 'UNAVAILABLE' end,
      'detail', v_n || ' of 2 private buckets (documents, product-images) present.');
  exception when others then
    v_checks := v_checks || jsonb_build_object('key', 'storage', 'label', 'File storage (buckets)', 'status', 'UNAVAILABLE', 'detail', 'Storage configuration could not be read.');
  end;

  v_checks := v_checks || jsonb_build_object('key', 'scheduled_jobs', 'label', 'Scheduled jobs',
    'status', case when exists (select 1 from pg_extension where extname = 'pg_cron') then 'HEALTHY' else 'NOT_CONFIGURED' end,
    'detail', case when exists (select 1 from pg_extension where extname = 'pg_cron') then 'pg_cron is installed.'
                   else 'No background scheduler. Alerts, notifications and escalations are evaluated when users open the app.' end);
  v_checks := v_checks || jsonb_build_object('key', 'realtime', 'label', 'Realtime updates', 'status', 'NOT_CONFIGURED',
    'detail', 'Not used. The notification badge refreshes from the database every 60 seconds.');
  v_checks := v_checks || jsonb_build_object('key', 'email', 'label', 'Email notifications', 'status', 'NOT_CONFIGURED',
    'detail', 'No email delivery provider is configured. Notifications are in-app only. (User invitations use Supabase Auth email separately.)');
  v_checks := v_checks || jsonb_build_object('key', 'push', 'label', 'Push notifications', 'status', 'NOT_CONFIGURED', 'detail', 'No push provider is configured.');
  v_checks := v_checks || jsonb_build_object('key', 'e_invoicing', 'label', 'E-invoicing / e-way bill', 'status', 'NOT_CONFIGURED',
    'detail', 'No IRP or GST portal integration (see Invoice Settings).');

  select count(*) into v_n from public.import_jobs where company_id = v_company and started_at > now() - interval '7 days' and status in ('FAILED', 'REJECTED', 'COMPLETED_WITH_ERRORS');
  v_checks := v_checks || jsonb_build_object('key', 'imports', 'label', 'Imports (last 7 days)', 'status', case when v_n = 0 then 'HEALTHY' else 'DEGRADED' end,
    'detail', case when v_n = 0 then 'No failed or partially failed imports.' else v_n || ' import(s) with rejected rows or failures. See Bulk Operations.' end);

  select count(*) into v_errors from public.error_events where company_id = v_company and severity = 'ERROR' and created_at > now() - interval '24 hours';
  v_checks := v_checks || jsonb_build_object('key', 'errors', 'label', 'Application errors (24 h)', 'status', case when v_errors = 0 then 'HEALTHY' else 'DEGRADED' end,
    'detail', case when v_errors = 0 then 'No errors reported.' else v_errors || ' error(s) reported. See the error log below.' end);

  select count(*) into v_n from public.approval_requests where company_id = v_company and status = 'PENDING_APPROVAL'
    and (workflow_snapshot ->> 'escalate_after_hours') is not null and stage_started_at < now() - make_interval(hours => (workflow_snapshot ->> 'escalate_after_hours')::int);
  v_checks := v_checks || jsonb_build_object('key', 'approvals', 'label', 'Approvals past escalation time', 'status', case when v_n = 0 then 'HEALTHY' else 'DEGRADED' end,
    'detail', v_n || ' request(s).');

  perform private.write_audit_log(v_company, 'system.health_checked', 'system', null, jsonb_build_object('module', 'system', 'result', 'success'));
  return jsonb_build_object('checks', v_checks, 'checked_at', now(),
    'recent_errors', coalesce((select jsonb_agg(jsonb_build_object('at', e.created_at, 'source', e.source, 'severity', e.severity, 'code', e.code,
        'message', e.message, 'correlation_id', e.correlation_id) order by e.created_at desc)
      from (select * from public.error_events where company_id = v_company order by created_at desc limit 25) e), '[]'::jsonb));
end;
$$;

revoke all on function public.system_health_check() from public, anon;
grant execute on function public.system_health_check() to authenticated;

-- -----------------------------------------------------------------------------
-- Audit coverage: mirror the module histories into the single audit log
-- (append-only, same transaction as the business change). Metadata carries the
-- module and result; details are truncated and never contain secrets.
-- -----------------------------------------------------------------------------
create or replace function private.audit_action_part(p text)
returns text
language sql
immutable
set search_path = ''
as $$
  select coalesce(nullif(trim(both '_' from regexp_replace(lower(coalesce(p, '')), '[^a-z_]+', '_', 'g')), ''), 'event');
$$;

create or replace function private.audit_mirror_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row    jsonb := to_jsonb(new);
  v_module text := tg_argv[0];
  v_res    text := tg_argv[1];
  v_id     text := v_row ->> tg_argv[2];
begin
  insert into public.audit_logs (company_id, actor_user_id, action, resource_type, resource_id, event_timestamp, metadata)
  values ((v_row ->> 'company_id')::uuid, coalesce((v_row ->> 'actor_user_id')::uuid, auth.uid()),
    v_module || '.' || private.audit_action_part(v_row ->> 'event_type'),
    case when v_res = 'billing_' then 'billing_' || private.audit_action_part(v_row ->> 'entity_type') else v_res end,
    v_id, coalesce((v_row ->> 'created_at')::timestamptz, now()),
    jsonb_strip_nulls(jsonb_build_object('module', v_module, 'result', 'success', 'from_status', v_row ->> 'from_status', 'to_status', v_row ->> 'to_status',
      'note', left(v_row ->> 'note', 300), 'source_event_id', v_row ->> 'id', 'details', left((v_row -> 'details')::text, 1500))));
  return new;
end;
$$;

create or replace function private.audit_mirror_inventory_tx()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.audit_logs (company_id, actor_user_id, action, resource_type, resource_id, event_timestamp, metadata)
  values (new.company_id, coalesce(new.created_by, auth.uid()), 'inventory.' || private.audit_action_part(new.transaction_type), 'inventory_transaction',
    new.id::text, new.created_at,
    jsonb_strip_nulls(jsonb_build_object('module', 'inventory', 'result', 'success', 'transaction_number', new.transaction_number,
      'product_id', new.product_id, 'quantity', new.quantity, 'unit', new.unit, 'direction', new.direction, 'warehouse_id', new.warehouse_id,
      'document_type', new.document_type, 'reference', new.reference_number, 'reason', left(new.reason, 300),
      'reversal_of', new.reversal_of_transaction_id)));
  return new;
end;
$$;

revoke all on function private.audit_action_part(text) from public, anon, authenticated;
revoke all on function private.audit_mirror_event() from public, anon, authenticated;
revoke all on function private.audit_mirror_inventory_tx() from public, anon, authenticated;

drop trigger if exists audit_mirror on public.billing_events;
create trigger audit_mirror after insert on public.billing_events for each row execute function private.audit_mirror_event('billing', 'billing_', 'entity_id');
drop trigger if exists audit_mirror on public.sales_order_events;
create trigger audit_mirror after insert on public.sales_order_events for each row execute function private.audit_mirror_event('sales', 'sales_order', 'sales_order_id');
drop trigger if exists audit_mirror on public.production_order_events;
create trigger audit_mirror after insert on public.production_order_events for each row execute function private.audit_mirror_event('production', 'production_order', 'production_order_id');
drop trigger if exists audit_mirror on public.outsourcing_order_events;
create trigger audit_mirror after insert on public.outsourcing_order_events for each row execute function private.audit_mirror_event('outsourcing', 'outsourcing_order', 'outsourcing_order_id');
drop trigger if exists audit_mirror on public.customer_po_events;
create trigger audit_mirror after insert on public.customer_po_events for each row execute function private.audit_mirror_event('customer_po', 'customer_po', 'purchase_order_id');
drop trigger if exists audit_mirror on public.inventory_transactions;
create trigger audit_mirror after insert on public.inventory_transactions for each row execute function private.audit_mirror_inventory_tx();

-- Audit viewer support: readable module list and actor names for the company.
create or replace function public.audit_log_filters()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('audit_logs.read');
begin
  return jsonb_build_object(
    'modules', coalesce((select jsonb_agg(distinct split_part(action, '.', 1) order by split_part(action, '.', 1)) from public.audit_logs where company_id = v_company), '[]'::jsonb),
    'actors', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', coalesce(p.full_name, p.email)) order by coalesce(p.full_name, p.email))
                        from public.profiles p where p.company_id = v_company), '[]'::jsonb));
end;
$$;

revoke all on function public.audit_log_filters() from public, anon;
grant execute on function public.audit_log_filters() to authenticated;

-- -----------------------------------------------------------------------------
-- Approval Inbox: documents of a type that can be submitted for approval now.
-- -----------------------------------------------------------------------------
create or replace function public.approval_document_search(p_document_type text, p_term text default '')
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('approvals.read');
  v_t       text := '%' || replace(replace(btrim(coalesce(p_term, '')), '%', ''), '_', '') || '%';
begin
  if private.approval_read_permission(p_document_type) is null or not private.has_permission(v_company, private.approval_read_permission(p_document_type)) then
    return '[]'::jsonb;
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'reference', x.ref, 'detail', x.detail) order by x.ref) from (
    select a.id, a.adjustment_number ref, lower(replace(a.reason_code, '_', ' ')) detail from public.inventory_adjustments a
      where p_document_type = 'STOCK_ADJUSTMENT' and a.company_id = v_company and a.status = 'PENDING_APPROVAL' and a.adjustment_number ilike v_t
    union all select c.id, c.count_number, 'submitted count' from public.inventory_counts c
      where p_document_type = 'STOCK_COUNT' and c.company_id = v_company and c.status = 'SUBMITTED' and c.count_number ilike v_t
    union all select o.id, o.document_number, o.line_count || ' line(s)' from public.inventory_opening_batches o
      where p_document_type = 'OPENING_STOCK' and o.company_id = v_company and o.status = 'PENDING_APPROVAL' and o.document_number ilike v_t
    union all select o.id, o.production_order_number, o.status from public.production_orders o
      where p_document_type = 'PRODUCTION_ORDER' and o.company_id = v_company and o.status = 'PENDING_APPROVAL' and o.production_order_number ilike v_t
    union all select o.id, o.outsourcing_order_number, o.supplier_name from public.outsourcing_orders o
      where p_document_type = 'OUTSOURCING_ORDER' and o.company_id = v_company and o.status = 'PENDING_APPROVAL' and (o.outsourcing_order_number ilike v_t or o.supplier_name ilike v_t)
    union all select s.id, s.sales_order_number, s.customer_name_snapshot from public.sales_orders s
      where p_document_type = 'SALES_ORDER' and s.company_id = v_company and s.order_status = 'PENDING_CONFIRMATION' and (s.sales_order_number ilike v_t or s.customer_name_snapshot ilike v_t)
    union all select i.id, 'Draft · ' || i.customer_legal_name, to_char(i.grand_total, 'FM999,999,999,990.00') from public.sales_invoices i
      where p_document_type = 'INVOICE' and i.company_id = v_company and i.status in ('DRAFT', 'PENDING_APPROVAL') and i.customer_legal_name ilike v_t
    union all select n.id, 'Draft ' || lower(n.note_type) || ' note · ' || i.invoice_number, to_char(n.total_amount, 'FM999,999,999,990.00')
      from public.invoice_adjustment_notes n join public.sales_invoices i on i.id = n.original_invoice_id
      where p_document_type in ('CREDIT_NOTE', 'DEBIT_NOTE') and n.note_type = (case p_document_type when 'CREDIT_NOTE' then 'CREDIT' else 'DEBIT' end)
        and n.company_id = v_company and n.status in ('DRAFT', 'PENDING_APPROVAL') and i.invoice_number ilike v_t
    union all select p.id, p.receipt_number, to_char(p.amount_received, 'FM999,999,999,990.00') from public.customer_payments p
      where p_document_type = 'PAYMENT_REVERSAL' and p.company_id = v_company and p.status = 'RECORDED' and p.receipt_number ilike v_t
    limit 30) x), '[]'::jsonb);
end;
$$;

revoke all on function public.approval_document_search(text, text) from public, anon;
grant execute on function public.approval_document_search(text, text) to authenticated;

-- -----------------------------------------------------------------------------
-- Analytics context: adds the company default reporting period (ERP Settings).
-- -----------------------------------------------------------------------------
create or replace function public.analytics_context()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('dashboard.read');
  v_c       public.companies;
  v_inv     boolean := private.has_permission(v_company, 'inventory.read');
begin
  select * into v_c from public.companies where id = v_company;
  return jsonb_build_object(
    'company', jsonb_build_object('legal_name', v_c.legal_name, 'display_name', v_c.display_name, 'currency_code', v_c.currency_code),
    'timezone', v_c.timezone,
    'today', private.company_today(v_company),
    'fy_start_month', coalesce((select fy_start_month from public.invoice_settings where company_id = v_company), 4),
    'default_period', coalesce((select s.setting_value #>> '{}' from public.company_settings s where s.company_id = v_company and s.setting_key = 'reporting.default_period'
                                and s.setting_value #>> '{}' in ('today', 'this_week', 'this_month', 'previous_month', 'this_quarter', 'current_fy', 'previous_fy')), 'this_month'),
    'access', jsonb_build_object(
      'sales', private.has_permission(v_company, 'sales_orders.read'),
      'fulfilment', private.has_permission(v_company, 'fulfilment.read'),
      'billing', private.has_permission(v_company, 'billing_reports.read'),
      'payments', private.has_permission(v_company, 'payments.read'),
      'inventory', v_inv,
      'valuation', private.has_permission(v_company, 'inventory_reports.read'),
      'production', private.has_permission(v_company, 'manufacturing.read'),
      'outsourcing', private.has_permission(v_company, 'outsourcing.read'),
      'purchase_orders', private.has_permission(v_company, 'customer_po.read'),
      'shortages', private.has_permission(v_company, 'customer_po_shortages.read'),
      'data_quality', private.has_permission(v_company, 'audit_logs.read')),
    'export', jsonb_build_object(
      'sales', private.has_permission(v_company, 'fulfilment_reports.export'),
      'billing', private.has_permission(v_company, 'billing_reports.export'),
      'inventory', private.has_permission(v_company, 'inventory.export'),
      'production', private.has_permission(v_company, 'production_reports.export'),
      'purchase_orders', private.has_permission(v_company, 'customer_po_reports.export'),
      'data_quality', private.has_permission(v_company, 'audit_logs.read')),
    'warehouses', case when v_inv or private.has_permission(v_company, 'sales_orders.read') or private.has_permission(v_company, 'manufacturing.read') then
      coalesce((select jsonb_agg(jsonb_build_object('id', id, 'code', warehouse_code, 'name', warehouse_name) order by warehouse_code)
                from public.warehouses where company_id = v_company and status = 'ACTIVE'), '[]'::jsonb) else '[]'::jsonb end,
    'categories', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name) order by name)
                from public.product_categories where company_id = v_company and is_active), '[]'::jsonb),
    'generated_at', now()
  );
end;
$$;
