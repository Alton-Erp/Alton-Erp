-- Rollback of 20261219090000_whatsapp_activation_preflight: restores the 20261213090000 setup-state rules,
-- refresh, settings read and activation functions (verbatim), removes the preflight, the verification RPC and
-- the evidence columns. Messages, webhook events and the Meta configuration are not touched.
-- The integration is switched off if the restored rules no longer give CONNECTED (as those rules always did).

drop function if exists public.support_whatsapp_verification_result(uuid, jsonb);

create or replace function private.support_whatsapp_compute_state(c public.support_whatsapp_config)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  k record;
begin
  if c.waba_id is null or c.phone_number_id is null or c.display_phone_number is null or c.app_id is null or c.graph_api_version is null then
    return 'NOT_CONFIGURED';
  end if;
  if c.number_path = 'UNKNOWN' or not private.support_whatsapp_done(c, 'number_path_confirmed') or not private.support_whatsapp_done(c, 'cloud_api_eligibility')
     or c.last_test_ok is null then
    return 'NUMBER_ELIGIBILITY_PENDING';
  end if;
  if c.number_path in ('BUSINESS_APP_ONLY', 'BSP') and not (private.support_whatsapp_done(c, 'migration_completed') and private.support_whatsapp_done(c, 'previous_routing_retired')) then
    return 'MIGRATION_REQUIRED';
  end if;
  if c.number_path = 'COEXISTENCE' and not (private.support_whatsapp_done(c, 'coexistence_approved') and private.support_whatsapp_done(c, 'previous_routing_retired')) then
    return 'COEXISTENCE_PENDING';
  end if;
  if c.last_test_ok = false then
    return 'ERROR';
  end if;
  for k in select * from private.support_whatsapp_checklist_items() i where c.number_path = any (i.required_for) loop
    if not private.support_whatsapp_done(c, k.key) then
      return case when k.key in ('webhook_subscribed', 'system_user_token') then 'WEBHOOK_PENDING' else 'NUMBER_ELIGIBILITY_PENDING' end;
    end if;
  end loop;
  if c.webhook_verified_at is null or c.webhook_signed_event_at is null then
    return 'WEBHOOK_PENDING';
  end if;
  return 'CONNECTED';
end;
$$;

create or replace function private.support_whatsapp_refresh(p_company uuid, p_reason text default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.support_whatsapp_config;
  v_state text;
  v_health text;
  v_detail text;
begin
  select * into c from public.support_whatsapp_config where company_id = p_company for update;
  if not found then
    return null;
  end if;
  v_state := private.support_whatsapp_compute_state(c);
  update public.support_whatsapp_config set setup_state = v_state,
    integration_enabled = integration_enabled and v_state = 'CONNECTED',
    enabled_at = case when integration_enabled and v_state = 'CONNECTED' then enabled_at end
  where company_id = p_company;
  select * into c from public.support_whatsapp_config where company_id = p_company;
  v_health := case when c.integration_enabled then 'CONNECTED' when v_state = 'ERROR' then 'ERROR' when v_state = 'NOT_CONFIGURED' then 'NOT_CONNECTED' else 'SETUP_REQUIRED' end;
  v_detail := case v_state
    when 'NOT_CONFIGURED' then 'Enter the Meta identifiers and the Graph API version.'
    when 'NUMBER_ELIGIBILITY_PENDING' then 'Confirm the number''s Cloud API eligibility and run Test connection.'
    when 'MIGRATION_REQUIRED' then 'The number must be migrated to the Cloud API through Meta''s supported path first.'
    when 'COEXISTENCE_PENDING' then 'Coexistence onboarding through an approved partner is not confirmed yet.'
    when 'WEBHOOK_PENDING' then 'Waiting for webhook verification and a signed webhook event from Meta.'
    when 'ERROR' then coalesce(c.last_test_result, 'The last connection test failed.')
    else case when c.integration_enabled then 'Connected to the WhatsApp Cloud API.' else 'Ready: an administrator can switch the integration on.' end end;
  if exists (select 1 from public.support_channel_accounts where id = c.channel_account_id and (status <> v_health or status_detail is distinct from left(v_detail, 500))) then
    perform public.support_record_integration_health(c.channel_account_id, v_health, v_detail, jsonb_build_object('setup_state', v_state, 'reason', p_reason));
  end if;
  return v_state;
end;
$$;

create or replace function public.support_whatsapp_config_get()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.manage_integrations');
  c public.support_whatsapp_config;
begin
  select * into c from public.support_whatsapp_config where company_id = v_company;
  return jsonb_build_object(
    'config', case when c.company_id is null then null else to_jsonb(c) - 'company_id' - 'created_by' - 'updated_by' end,
    'account', (select jsonb_build_object('id', a.id, 'status', a.status, 'status_detail', a.status_detail, 'last_checked_at', a.last_checked_at)
                from public.support_channel_accounts a where a.id = c.channel_account_id),
    'checklist_items', (select jsonb_agg(jsonb_build_object('key', i.key, 'label', i.label, 'required', coalesce(c.number_path, 'UNKNOWN') = any (i.required_for),
                          'done', coalesce((c.checklist -> i.key ->> 'done')::boolean, false), 'note', c.checklist -> i.key ->> 'note',
                          'by', (select coalesce(p.full_name, p.email) from public.profiles p where p.id::text = c.checklist -> i.key ->> 'by'),
                          'at', c.checklist -> i.key ->> 'at')) from private.support_whatsapp_checklist_items() i),
    'templates', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'language', t.language, 'category', t.category, 'status', t.status) order by t.name, t.language)
                           from public.support_whatsapp_templates t where t.company_id = v_company), '[]'::jsonb),
    'counts', jsonb_build_object(
      'received', (select count(*) from public.support_whatsapp_messages where company_id = v_company and direction = 'INBOUND'),
      'sent', (select count(*) from public.support_whatsapp_messages where company_id = v_company and status in ('SENT', 'DELIVERED', 'READ')),
      'pending', (select count(*) from public.support_whatsapp_messages where company_id = v_company and status = 'PENDING'),
      'failed', (select count(*) from public.support_whatsapp_messages where company_id = v_company and status = 'FAILED'),
      'media_pending', (select count(*) from public.support_whatsapp_messages where company_id = v_company and media_state = 'PENDING')),
    -- Webhook log without message content.
    'events', coalesce((select jsonb_agg(e order by e ->> 'received_at' desc) from (
                select jsonb_build_object('id', w.id, 'field', w.field, 'result', w.result, 'error', w.error, 'counts', w.counts, 'replay_count', w.replay_count,
                  'received_at', w.received_at, 'processed_at', w.processed_at, 'purged', w.payload is null) e
                from public.support_whatsapp_webhook_events w where w.company_id = v_company order by w.received_at desc limit 50) z), '[]'::jsonb));
end;
$$;

create or replace function public.support_whatsapp_set_enabled(p_enabled boolean, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.manage_integrations');
  c public.support_whatsapp_config;
begin
  perform private.support_whatsapp_refresh(v_company, 'activation check');
  select * into c from public.support_whatsapp_config where company_id = v_company for update;
  if not found then
    raise exception 'Save the WhatsApp settings first.' using errcode = 'P0001';
  end if;
  if p_enabled and c.setup_state <> 'CONNECTED' then
    raise exception 'WhatsApp cannot be switched on yet: the setup state is %. Complete the onboarding checklist, the connection test and the webhook verification first.',
      replace(lower(c.setup_state), '_', ' ') using errcode = 'P0001';
  end if;
  update public.support_whatsapp_config set integration_enabled = coalesce(p_enabled, false), enabled_at = case when p_enabled then now() end,
    enabled_by = case when p_enabled then auth.uid() end, updated_by = auth.uid() where company_id = v_company;
  perform private.support_gmail_event(v_company, c.channel_account_id, 'SETUP', left(case when p_enabled then 'WhatsApp integration switched on.' else
    'WhatsApp integration switched off: ' || coalesce(nullif(btrim(p_reason), ''), 'no reason given') end, 1000), '{}'::jsonb, null, null, null, auth.uid());
  perform private.support_whatsapp_refresh(v_company, case when p_enabled then 'enabled' else 'disabled' end);
  return public.support_whatsapp_config_get();
end;
$$;

revoke all on function private.support_whatsapp_compute_state(public.support_whatsapp_config), private.support_whatsapp_refresh(uuid, text) from public, anon, authenticated;
do $$
declare
  f text;
begin
  foreach f in array array['public.support_whatsapp_config_get()', 'public.support_whatsapp_set_enabled(boolean, text)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;

drop function if exists private.support_whatsapp_preflight(public.support_whatsapp_config);
alter table public.support_whatsapp_config drop column if exists meta_verification;
alter table public.support_whatsapp_config drop column if exists meta_verified_at;
