-- Rollback of 20261220090000_whatsapp_preflight_checks: restores the 20261219090000 verification RPC and preflight
-- (verbatim). Stored version-2 evidence is cleared (the 20261219090000 rules read the version-1 format); run Test
-- connection again afterwards. Messages, webhook events and Meta are not touched.

create or replace function public.support_whatsapp_verification_result(p_account uuid, p_verification jsonb)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.support_whatsapp_config;
  v jsonb := coalesce(p_verification, '{}'::jsonb);
  t jsonb;
  e jsonb;
  num constant text := '^[0-9]{5,25}$';
begin
  select * into c from public.support_whatsapp_config where channel_account_id = p_account for update;
  if not found then
    raise exception 'WhatsApp settings not found.' using errcode = 'P0001';
  end if;
  if jsonb_typeof(v) <> 'object' then
    raise exception 'Invalid verification result.' using errcode = 'P0001';
  end if;
  t := case when jsonb_typeof(v -> 'token') = 'object' then v -> 'token' end;
  e := jsonb_strip_nulls(jsonb_build_object(
    'checked_at', coalesce((v ->> 'checked_at')::timestamptz, now()),
    'waba_id', case when v ->> 'waba_id' ~ num then v ->> 'waba_id' end,
    'phone_number_id', case when v ->> 'phone_number_id' ~ num then v ->> 'phone_number_id' end,
    'app_id', case when v ->> 'app_id' ~ num then v ->> 'app_id' end,
    'phone_in_waba', case when jsonb_typeof(v -> 'phone_in_waba') = 'boolean' then v -> 'phone_in_waba' end,
    'waba_phone_count', case when jsonb_typeof(v -> 'waba_phone_count') = 'number' then v -> 'waba_phone_count' end,
    'waba_error', left(v ->> 'waba_error', 200),
    'owner_business_id', case when v ->> 'owner_business_id' ~ num then v ->> 'owner_business_id' end,
    'owner_business_name', left(v ->> 'owner_business_name', 200),
    'waba_name', left(v ->> 'waba_name', 200),
    'account_review_status', left(v ->> 'account_review_status', 40),
    'owner_error', left(v ->> 'owner_error', 200),
    'subscribed_app_ids', case when jsonb_typeof(v -> 'subscribed_app_ids') = 'array'
      then (select coalesce(jsonb_agg(x), '[]'::jsonb) from jsonb_array_elements_text(v -> 'subscribed_app_ids') x where x ~ num) end,
    'subscribed_error', left(v ->> 'subscribed_error', 200),
    'token', case when t is not null then jsonb_strip_nulls(jsonb_build_object(
      'is_valid', coalesce((t ->> 'is_valid')::boolean, false),
      'type', left(t ->> 'type', 40),
      'app_id', case when t ->> 'app_id' ~ num then t ->> 'app_id' end,
      'expires_at', case when jsonb_typeof(t -> 'expires_at') = 'number' then t -> 'expires_at' end,
      'scopes', (select coalesce(jsonb_agg(x), '[]'::jsonb) from jsonb_array_elements_text(case when jsonb_typeof(t -> 'scopes') = 'array' then t -> 'scopes' else '[]'::jsonb end) x
                 where x ~ '^[a-z_]{2,60}$'),
      'targets', (select coalesce(jsonb_object_agg(k.key, case when jsonb_typeof(k.value) = 'array'
                    then (select coalesce(jsonb_agg(y), '[]'::jsonb) from jsonb_array_elements_text(k.value) y where y ~ num) end), '{}'::jsonb)
                  from jsonb_each(case when jsonb_typeof(t -> 'targets') = 'object' then t -> 'targets' else '{}'::jsonb end) k
                  where k.key in ('whatsapp_business_messaging', 'whatsapp_business_management')))) end,
    'token_error', left(v ->> 'token_error', 200)));
  update public.support_whatsapp_config set meta_verification = e, meta_verified_at = now() where company_id = c.company_id;
  perform private.support_gmail_event(c.company_id, p_account, 'HEALTH_CHECK', 'Meta account verification recorded.',
    e - 'token' || jsonb_build_object('token_checked', t is not null), 'PROCESSED', null);
  return private.support_whatsapp_refresh(c.company_id, 'meta verification');
end;
$$;

revoke all on function public.support_whatsapp_verification_result(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.support_whatsapp_verification_result(uuid, jsonb) to service_role;

create or replace function private.support_whatsapp_preflight(c public.support_whatsapp_config)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  ev       jsonb := coalesce(c.meta_verification, '{}'::jsonb);
  ph       jsonb := coalesce(c.phone_info, '{}'::jsonb);
  tok      jsonb;
  v_ev_ok  boolean;
  v_reg_ok boolean;
  v_cloud  boolean := c.number_path = 'CLOUD_API';
  checks   jsonb := '[]'::jsonb;
  v_status text;
  v_state  text := 'CONNECTED';
  v_block  jsonb := '[]'::jsonb;
  v_scopes text[];
  v_missing text[];
  v_limited text[];
  x        jsonb;
begin
  -- Each check: key, label, mandatory, result (OK / PENDING / BLOCKED / FAILED), source, detail, state (stored state when not OK).
  if c.company_id is null then
    return jsonb_build_object('status', 'NOT_CONFIGURED', 'setup_state', 'NOT_CONFIGURED', 'can_activate', false, 'checks', '[]'::jsonb,
      'blockers', jsonb_build_array('Save the WhatsApp settings first.'));
  end if;

  v_ev_ok := ev ? 'checked_at' and ev ->> 'waba_id' is not distinct from c.waba_id and ev ->> 'phone_number_id' is not distinct from c.phone_number_id
             and ev ->> 'app_id' is not distinct from c.app_id;
  tok := case when v_ev_ok then ev -> 'token' end;
  v_reg_ok := c.last_test_ok is true and upper(coalesce(ph ->> 'status', '')) = 'CONNECTED'
              and upper(coalesce(ph ->> 'platform_type', 'CLOUD_API')) = 'CLOUD_API';

  -- Configuration
  checks := checks || jsonb_build_object('key', 'identifiers', 'label', 'Meta identifiers and Graph API version entered', 'mandatory', true, 'source', 'CONFIG',
    'result', case when c.waba_id is null or c.phone_number_id is null or c.display_phone_number is null or c.app_id is null or c.graph_api_version is null
                   then 'PENDING' else 'OK' end,
    'detail', case when c.waba_id is null or c.phone_number_id is null or c.display_phone_number is null or c.app_id is null or c.graph_api_version is null
                   then 'Enter the WABA id, phone number id, display number, Meta app id and Graph API version.'
                   else format('WABA %s, phone number id %s, app %s, %s.', c.waba_id, c.phone_number_id, c.app_id, c.graph_api_version) end,
    'state', 'NOT_CONFIGURED');
  checks := checks || jsonb_build_object('key', 'usage', 'label', 'How the number is used today', 'mandatory', true, 'source', 'CONFIG',
    'result', case when c.number_path = 'UNKNOWN' then 'PENDING' else 'OK' end,
    'detail', case c.number_path when 'UNKNOWN' then 'Choose how the support number is used today.'
      when 'CLOUD_API' then 'Already on the WhatsApp Business Platform / Cloud API (this WABA): no migration or coexistence onboarding is required.'
      when 'BSP' then 'On another provider: migration through Meta''s supported path is required.'
      when 'BUSINESS_APP_ONLY' then 'WhatsApp Business app only: migration to the Cloud API is required.'
      else 'Coexistence (WhatsApp Business app + Cloud API) through an approved partner.' end,
    'state', 'NUMBER_ELIGIBILITY_PENDING');

  -- Connection test (phone number status from Meta)
  checks := checks || jsonb_build_object('key', 'connection_test', 'label', 'Connection test passed', 'mandatory', true, 'source', 'TEST',
    'result', case when c.last_test_ok is null then 'PENDING' when c.last_test_ok then 'OK' else 'FAILED' end,
    'detail', case when c.last_test_ok is null then 'Run Test connection.' else coalesce(c.last_test_result, '') ||
      case when c.last_test_at is not null then format(' (%s)', to_char(c.last_test_at at time zone 'Asia/Kolkata', 'DD Mon YYYY HH24:MI')) else '' end end,
    'state', case when c.last_test_ok is false then 'ERROR' else 'NUMBER_ELIGIBILITY_PENDING' end);

  -- Account mapping (Meta evidence)
  checks := checks || jsonb_build_object('key', 'phone_in_waba', 'label', 'The phone number id belongs to the configured WhatsApp Business Account', 'mandatory', true, 'source', 'META',
    'result', case when not v_ev_ok then 'PENDING' when (ev -> 'phone_in_waba') = 'true'::jsonb then 'OK' else 'BLOCKED' end,
    'detail', case when not v_ev_ok then 'Not verified yet: run Test connection (it reads the WABA''s phone numbers from Meta).'
      when (ev -> 'phone_in_waba') = 'true'::jsonb then format('Meta lists phone number id %s under WABA %s (%s number(s)).', c.phone_number_id, c.waba_id, coalesce(ev ->> 'waba_phone_count', '?'))
      when (ev -> 'phone_in_waba') = 'false'::jsonb then format('Phone number id %s is NOT under WABA %s according to Meta (%s other number(s) found). Check the ids in WhatsApp Manager: the number may belong to another (e.g. test) WABA. Nothing was changed.',
        c.phone_number_id, c.waba_id, coalesce(ev ->> 'waba_phone_count', '0'))
      else 'Could not be verified: ' || coalesce(ev ->> 'waba_error', 'Meta did not list the WABA''s phone numbers') || '.' end,
    'state', 'NUMBER_ELIGIBILITY_PENDING');
  checks := checks || jsonb_build_object('key', 'business_portfolio', 'label', 'The WhatsApp Business Account belongs to the configured business portfolio', 'mandatory', true, 'source', 'META',
    'result', case when c.business_portfolio_id is null then 'PENDING' when not v_ev_ok then 'PENDING'
      when ev ->> 'owner_business_id' = c.business_portfolio_id then 'OK' else 'BLOCKED' end,
    'detail', case when c.business_portfolio_id is null then 'Enter the Meta business portfolio id.'
      when not v_ev_ok then 'Not verified yet: run Test connection.'
      when ev ->> 'owner_business_id' = c.business_portfolio_id then format('Meta: WABA %s%s is owned by portfolio %s%s.', c.waba_id,
        coalesce(' (' || (ev ->> 'waba_name') || ')', ''), c.business_portfolio_id, coalesce(' (' || (ev ->> 'owner_business_name') || ')', ''))
      when ev ->> 'owner_business_id' is not null then format('Meta: WABA %s is owned by portfolio %s%s, not the configured %s. Activation stays blocked until this is resolved.',
        c.waba_id, ev ->> 'owner_business_id', coalesce(' (' || (ev ->> 'owner_business_name') || ')', ''), c.business_portfolio_id)
      else 'Could not be verified: ' || coalesce(ev ->> 'owner_error', 'Meta did not return the owner') || ' Activation stays blocked until ownership is confirmed.' end,
    'state', 'NUMBER_ELIGIBILITY_PENDING');

  -- Eligibility / registration
  if v_cloud then
    checks := checks || jsonb_build_object('key', 'cloud_api_eligibility', 'label', 'Number registered and active on the Cloud API under this WABA', 'mandatory', true,
      'source', case when v_reg_ok and (ev -> 'phone_in_waba') = 'true'::jsonb and v_ev_ok then 'META' else 'TEST' end,
      'result', case when c.last_test_ok is null or not v_ev_ok then 'PENDING'
        when v_reg_ok and (ev -> 'phone_in_waba') = 'true'::jsonb then 'OK' else 'BLOCKED' end,
      'detail', case when c.last_test_ok is null or not v_ev_ok then 'Run Test connection: Meta''s answer for this number is the evidence (no manual confirmation needed for this usage).'
        when v_reg_ok and (ev -> 'phone_in_waba') = 'true'::jsonb then format('Verified by Meta: %s is %s on %s under WABA %s, quality %s.', coalesce(ph ->> 'display_phone_number', c.display_phone_number),
          ph ->> 'status', coalesce(ph ->> 'platform_type', 'CLOUD_API'), c.waba_id, coalesce(ph ->> 'quality_rating', 'not reported'))
        else 'Meta does not report this number as CONNECTED on the Cloud API under this WABA. If it is still on the WhatsApp Business app or another provider, choose that usage instead.' end,
      'state', 'NUMBER_ELIGIBILITY_PENDING');
  else
    checks := checks || jsonb_build_object('key', 'cloud_api_eligibility', 'label', 'Meta confirmed the number can be registered on the Cloud API under this WABA', 'mandatory', true, 'source', 'ADMIN',
      'result', case when private.support_whatsapp_done(c, 'cloud_api_eligibility') then 'OK' else 'PENDING' end,
      'detail', case when private.support_whatsapp_done(c, 'cloud_api_eligibility') then 'Confirmed: ' || coalesce(c.checklist -> 'cloud_api_eligibility' ->> 'note', '')
        else 'Confirm in the checklist with the evidence (Meta case or partner reference): the number is not on the Cloud API yet, so Meta cannot verify this before migration.' end,
      'state', 'NUMBER_ELIGIBILITY_PENDING');
  end if;
  checks := checks || jsonb_build_object('key', 'number_path_confirmed', 'label', 'Usage of the number confirmed', 'mandatory', true,
    'source', case when private.support_whatsapp_done(c, 'number_path_confirmed') then 'ADMIN' else 'META' end,
    'result', case when private.support_whatsapp_done(c, 'number_path_confirmed') then 'OK'
      when v_cloud and v_reg_ok and v_ev_ok and (ev -> 'phone_in_waba') = 'true'::jsonb then 'OK' else 'PENDING' end,
    'detail', case when private.support_whatsapp_done(c, 'number_path_confirmed') then 'Confirmed in the checklist.'
      when v_cloud and v_reg_ok and v_ev_ok and (ev -> 'phone_in_waba') = 'true'::jsonb then 'Verified by Meta: the number is on the Cloud API under this WABA, as selected.'
      else 'Confirm in the checklist how the number is used today.' end,
    'state', 'NUMBER_ELIGIBILITY_PENDING');

  -- Conditional onboarding steps (only for the paths that need them)
  if c.number_path in ('BUSINESS_APP_ONLY', 'BSP') then
    checks := checks || jsonb_build_object('key', 'migration_completed', 'label', 'Migration completed through Meta''s supported path', 'mandatory', true, 'source', 'ADMIN',
      'result', case when private.support_whatsapp_done(c, 'migration_completed') then 'OK' else 'BLOCKED' end,
      'detail', case when private.support_whatsapp_done(c, 'migration_completed') then 'Confirmed in the checklist.' else 'The number must first be migrated (not done by the ERP).' end,
      'state', 'MIGRATION_REQUIRED');
  end if;
  if c.number_path = 'COEXISTENCE' then
    checks := checks || jsonb_build_object('key', 'coexistence_approved', 'label', 'Coexistence onboarding completed through an approved partner', 'mandatory', true, 'source', 'ADMIN',
      'result', case when private.support_whatsapp_done(c, 'coexistence_approved') then 'OK' else 'BLOCKED' end,
      'detail', case when private.support_whatsapp_done(c, 'coexistence_approved') then 'Confirmed in the checklist.' else 'Coexistence onboarding is not confirmed.' end,
      'state', 'COEXISTENCE_PENDING');
  end if;
  if c.number_path in ('BUSINESS_APP_ONLY', 'BSP', 'COEXISTENCE') then
    checks := checks || jsonb_build_object('key', 'previous_routing_retired', 'label', 'Previous routing (other provider / app) retired or agreed', 'mandatory', true, 'source', 'ADMIN',
      'result', case when private.support_whatsapp_done(c, 'previous_routing_retired') then 'OK' else 'BLOCKED' end,
      'detail', case when private.support_whatsapp_done(c, 'previous_routing_retired') then 'Confirmed in the checklist.' else 'Confirm that messages are no longer routed elsewhere.' end,
      'state', case when c.number_path = 'COEXISTENCE' then 'COEXISTENCE_PENDING' else 'MIGRATION_REQUIRED' end);
  end if;

  -- Access token (permanent, both permissions, covering this WABA)
  if tok is not null then
    v_scopes := array(select jsonb_array_elements_text(coalesce(tok -> 'scopes', '[]'::jsonb)));
    v_missing := array(select s2 from unnest(array['whatsapp_business_messaging', 'whatsapp_business_management']) s2 where not s2 = any (v_scopes));
    v_limited := array(select k.key from jsonb_each(coalesce(tok -> 'targets', '{}'::jsonb)) k
                       where jsonb_typeof(k.value) = 'array' and not (k.value ? c.waba_id));
  end if;
  checks := checks || jsonb_build_object('key', 'access_token', 'label', 'Permanent system-user token with whatsapp_business_messaging and whatsapp_business_management', 'mandatory', true,
    'source', case when tok is not null then 'META' else 'ADMIN' end,
    'result', case when not v_ev_ok then 'PENDING'
      when tok is null then case when private.support_whatsapp_done(c, 'system_user_token') then 'OK' else 'PENDING' end
      when (tok ->> 'is_valid')::boolean is not true or cardinality(v_missing) > 0 or cardinality(v_limited) > 0
           or coalesce((tok ->> 'expires_at')::numeric, 0) > 0 then 'BLOCKED'
      else 'OK' end,
    'detail', case when not v_ev_ok then 'Not verified yet: run Test connection.'
      when tok is null then case when private.support_whatsapp_done(c, 'system_user_token')
        then 'Meta did not describe the token (' || coalesce(ev ->> 'token_error', 'no answer') || '); confirmed by an administrator in the checklist.'
        else 'Meta did not describe the token (' || coalesce(ev ->> 'token_error', 'no answer') || '). Confirm the permanent system-user token in the checklist.' end
      when (tok ->> 'is_valid')::boolean is not true then 'Meta reports the access token as invalid. Replace WHATSAPP_ACCESS_TOKEN.'
      when cardinality(v_missing) > 0 then 'The access token is missing: ' || array_to_string(v_missing, ', ') || '.'
      when cardinality(v_limited) > 0 then format('The token''s %s permission does not include WABA %s.', array_to_string(v_limited, ', '), c.waba_id)
      when coalesce((tok ->> 'expires_at')::numeric, 0) > 0 then format('The token expires on %s: a permanent (never-expiring) system-user token is required.',
        to_char(to_timestamp((tok ->> 'expires_at')::numeric) at time zone 'Asia/Kolkata', 'DD Mon YYYY'))
      else format('Verified by Meta: valid %s token, never expires, with both permissions.', lower(coalesce(tok ->> 'type', 'system-user'))) end,
    'state', 'WEBHOOK_PENDING');

  -- Webhook
  checks := checks || jsonb_build_object('key', 'webhook_subscription', 'label', 'The Meta app is subscribed to this WABA''s webhooks', 'mandatory', true,
    'source', case when v_ev_ok and jsonb_typeof(ev -> 'subscribed_app_ids') = 'array' then 'META' else 'ADMIN' end,
    'result', case when not v_ev_ok then 'PENDING'
      when jsonb_typeof(ev -> 'subscribed_app_ids') = 'array' then case when (ev -> 'subscribed_app_ids') ? c.app_id then 'OK' else 'BLOCKED' end
      when private.support_whatsapp_done(c, 'webhook_subscribed') then 'OK' else 'PENDING' end,
    'detail', case when not v_ev_ok then 'Not verified yet: run Test connection.'
      when jsonb_typeof(ev -> 'subscribed_app_ids') = 'array' then case when (ev -> 'subscribed_app_ids') ? c.app_id
          then format('Verified by Meta: app %s is subscribed to WABA %s.', c.app_id, c.waba_id)
          else format('App %s is not subscribed to WABA %s (subscribed apps: %s). Subscribe it in the Meta app (WhatsApp → Configuration).', c.app_id, c.waba_id,
            coalesce(nullif((select string_agg(a, ', ') from jsonb_array_elements_text(ev -> 'subscribed_app_ids') a), ''), 'none')) end
      when private.support_whatsapp_done(c, 'webhook_subscribed') then 'Meta did not list the subscribed apps (' || coalesce(ev ->> 'subscribed_error', 'no answer') || '); confirmed by an administrator.'
      else 'Meta did not list the subscribed apps (' || coalesce(ev ->> 'subscribed_error', 'no answer') || '). Confirm the subscription in the checklist.' end,
    'state', 'WEBHOOK_PENDING');
  checks := checks || jsonb_build_object('key', 'webhook_verified', 'label', 'Webhook callback verified (challenge)', 'mandatory', true, 'source', 'WEBHOOK',
    'result', case when c.webhook_verified_at is not null then 'OK' else 'PENDING' end,
    'detail', case when c.webhook_verified_at is not null then format('Challenge passed %s.', to_char(c.webhook_verified_at at time zone 'Asia/Kolkata', 'DD Mon YYYY HH24:MI'))
      else 'Verify the callback URL in the Meta app.' end,
    'state', 'WEBHOOK_PENDING');
  checks := checks || jsonb_build_object('key', 'webhook_signed', 'label', 'A correctly signed webhook event received', 'mandatory', true, 'source', 'WEBHOOK',
    'result', case when c.webhook_signed_event_at is not null then 'OK' else 'PENDING' end,
    'detail', case when c.webhook_signed_event_at is not null then format('Last signed event %s (signature checked with the app secret).', to_char(c.webhook_signed_event_at at time zone 'Asia/Kolkata', 'DD Mon YYYY HH24:MI'))
      else 'Waiting for a webhook event signed with the app secret.' end,
    'state', 'WEBHOOK_PENDING');

  -- Recommended (never block activation)
  checks := checks || jsonb_build_object('key', 'quality_rating', 'label', 'Phone quality rating', 'mandatory', false, 'source', 'TEST',
    'result', case when upper(coalesce(ph ->> 'quality_rating', '')) = 'GREEN' then 'OK' else 'PENDING' end,
    'detail', coalesce('Meta: ' || (ph ->> 'quality_rating') || '.', 'Not reported yet.'));
  checks := checks || jsonb_build_object('key', 'account_review', 'label', 'WhatsApp Business Account review', 'mandatory', false, 'source', 'META',
    'result', case when v_ev_ok and upper(coalesce(ev ->> 'account_review_status', '')) = 'APPROVED' then 'OK' else 'PENDING' end,
    'detail', case when v_ev_ok and ev ->> 'account_review_status' is not null then 'Meta: ' || (ev ->> 'account_review_status') || '.' else 'Not reported yet.' end);
  checks := checks || jsonb_build_object('key', 'templates_reviewed', 'label', 'Message templates for business-initiated messages approved', 'mandatory', false, 'source', 'ADMIN',
    'result', case when exists (select 1 from public.support_whatsapp_templates t where t.company_id = c.company_id and t.status = 'APPROVED') then 'OK' else 'PENDING' end,
    'detail', format('%s approved template(s) synchronised.', (select count(*) from public.support_whatsapp_templates t where t.company_id = c.company_id and t.status = 'APPROVED')));

  -- Outcome: the first mandatory check that is not OK decides the stored state (same order as before).
  for x in select value from jsonb_array_elements(checks) loop
    if (x ->> 'mandatory')::boolean and x ->> 'result' <> 'OK' then
      v_block := v_block || to_jsonb(x ->> 'detail');
      if v_state = 'CONNECTED' then v_state := x ->> 'state'; end if;
    end if;
  end loop;
  if exists (select 1 from jsonb_array_elements(checks) y where y ->> 'key' = 'connection_test' and y ->> 'result' = 'FAILED') then
    v_state := 'ERROR';
  end if;
  v_status := case
    when v_state = 'NOT_CONFIGURED' then 'NOT_CONFIGURED'
    when v_state = 'ERROR' then 'ERROR'
    when exists (select 1 from jsonb_array_elements(checks) y where (y ->> 'mandatory')::boolean and y ->> 'result' = 'BLOCKED') then 'ELIGIBILITY_BLOCKED'
    when v_state <> 'CONNECTED' then 'PENDING_VERIFICATION'
    when c.integration_enabled then 'ACTIVE'
    else 'READY_TO_ACTIVATE' end;

  return jsonb_build_object(
    'status', v_status,
    'setup_state', v_state,
    'can_activate', v_state = 'CONNECTED' and not c.integration_enabled,
    'eligibility', case when exists (select 1 from jsonb_array_elements(checks) y where y ->> 'key' = 'cloud_api_eligibility' and y ->> 'result' = 'OK') then 'VERIFIED'
                        when exists (select 1 from jsonb_array_elements(checks) y where y ->> 'key' = 'cloud_api_eligibility' and y ->> 'result' = 'BLOCKED') then 'BLOCKED'
                        else 'PENDING' end,
    'blockers', v_block,
    'checks', checks,
    'verified_at', case when v_ev_ok then ev ->> 'checked_at' end,
    -- Message delivery is proven only by real traffic, never by the webhook challenge.
    'delivery', jsonb_build_object(
      'inbound_messages', (select count(*) from public.support_whatsapp_messages m where m.company_id = c.company_id and m.direction = 'INBOUND'),
      'last_inbound_at', c.last_inbound_at,
      'outbound_accepted', (select count(*) from public.support_whatsapp_messages m where m.company_id = c.company_id and m.direction = 'OUTBOUND' and m.wa_message_id is not null),
      'outbound_delivered', (select count(*) from public.support_whatsapp_messages m where m.company_id = c.company_id and m.direction = 'OUTBOUND' and m.status in ('DELIVERED', 'READ')),
      'outbound_read', (select count(*) from public.support_whatsapp_messages m where m.company_id = c.company_id and m.direction = 'OUTBOUND' and m.status = 'READ'),
      'outbound_failed', (select count(*) from public.support_whatsapp_messages m where m.company_id = c.company_id and m.direction = 'OUTBOUND' and m.status = 'FAILED'),
      'status_callbacks', (select count(*) from public.support_whatsapp_statuses s2 where s2.company_id = c.company_id),
      'last_outbound_success_at', c.last_outbound_success_at,
      'inbound_proven', exists (select 1 from public.support_whatsapp_messages m where m.company_id = c.company_id and m.direction = 'INBOUND'),
      'outbound_proven', exists (select 1 from public.support_whatsapp_messages m where m.company_id = c.company_id and m.direction = 'OUTBOUND' and m.status in ('DELIVERED', 'READ'))));
end;
$$;

revoke all on function private.support_whatsapp_preflight(public.support_whatsapp_config) from public, anon, authenticated;

drop function if exists private.support_whatsapp_meta_part(jsonb, text, text);
drop function if exists private.support_whatsapp_clean_check(jsonb);
update public.support_whatsapp_config set meta_verification = '{}'::jsonb where meta_verification ->> 'version' = '2';
