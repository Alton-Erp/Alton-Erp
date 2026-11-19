-- =============================================================================
-- WhatsApp activation preflight, version 2 (fix of 20261219090000, which is deployed and not edited)
--
-- Problems found in production (2026-11-18):
--   * Meta answered "(#100) Tried accessing nonexisting field (phone_numbers)" and "(name)": the configured
--     WhatsApp Business Account id did not behave as a WhatsApp Business Account (both exist on every WABA). The
--     evidence only kept Meta's raw message, and the WABA name and owner were requested together.
--   * "Meta does not report this number as CONNECTED…" was shown although the number WAS CONNECTED: the check
--     mixed "registered" with "listed under this WABA".
--   * Several checks produced the same text ("Not verified yet: run Test connection."), and the screen used
--     the text as the list key, so stale lines stayed visible.
--   * Signed webhook evidence counted only events for the configured WABA id: with a wrong WABA id every
--     genuine signed event is stored as REJECTED and the signature mechanism looked untested.
--
-- This migration (no table change; the Edge Function sends evidence version 2):
--   * public.support_whatsapp_verification_result: stores per-check results
--     { status VERIFIED | VERIFICATION_FAILED | PERMISSION_DENIED | INVALID_REQUEST | WRONG_ACCOUNT, verified,
--       error_code, error_message, checked_at, … } for phone_registration, waba, ownership, phone_in_waba,
--     subscription, token and whether WHATSAPP_APP_SECRET is set. Whitelisted fields only, never a token.
--   * private.support_whatsapp_preflight: one result per check with its own reason (Not tested, Verified,
--     Verification failed, Permission denied, Invalid request, Wrong account), Meta's error code and the time;
--     unique blocker texts; registration and WABA membership separate; webhook evidence in levels
--     (challenge, app subscription, signed POST received, signed event for this account, customer message);
--     signed events Meta sends for this phone number under another WABA are reported as a wrong account.
--   * Evidence from 20261219090000 (version 1) or for other ids counts as not tested.
-- Rollback: supabase/rollback/20261220090000_whatsapp_preflight_checks_down.sql (restores 20261219090000).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Evidence (service role only)
-- -----------------------------------------------------------------------------
create or replace function private.support_whatsapp_clean_check(p jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case when jsonb_typeof(p) <> 'object' then null else jsonb_strip_nulls(jsonb_build_object(
    'status', case when p ->> 'status' in ('VERIFIED', 'VERIFICATION_FAILED', 'PERMISSION_DENIED', 'INVALID_REQUEST', 'WRONG_ACCOUNT') then p ->> 'status' else 'VERIFICATION_FAILED' end,
    'verified', p ->> 'status' = 'VERIFIED',
    'error_code', case when jsonb_typeof(p -> 'error_code') = 'number' then p -> 'error_code' end,
    'error_message', left(p ->> 'error_message', 300),
    'hint', left(p ->> 'hint', 300),
    'checked_at', case when p ->> 'checked_at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' then p ->> 'checked_at' end,
    'phone_status', left(p ->> 'phone_status', 40), 'platform_type', left(p ->> 'platform_type', 40),
    'display_phone_number', left(p ->> 'display_phone_number', 40), 'verified_name', left(p ->> 'verified_name', 200),
    'quality_rating', left(p ->> 'quality_rating', 20), 'code_verification_status', left(p ->> 'code_verification_status', 40),
    'waba_type', left(p ->> 'waba_type', 60), 'waba_name', left(p ->> 'waba_name', 200), 'account_review_status', left(p ->> 'account_review_status', 40),
    'owner_business_id', case when p ->> 'owner_business_id' ~ '^[0-9]{5,25}$' then p ->> 'owner_business_id' end,
    'owner_business_name', left(p ->> 'owner_business_name', 200),
    'waba_phone_count', case when jsonb_typeof(p -> 'waba_phone_count') = 'number' then p -> 'waba_phone_count' end,
    'suggested_waba_id', case when p ->> 'suggested_waba_id' ~ '^[0-9]{5,25}$' then p ->> 'suggested_waba_id' end,
    'subscribed_app_ids', case when jsonb_typeof(p -> 'subscribed_app_ids') = 'array'
      then (select coalesce(jsonb_agg(x), '[]'::jsonb) from jsonb_array_elements_text(p -> 'subscribed_app_ids') x where x ~ '^[0-9]{5,25}$') end,
    'token_type', left(p ->> 'token_type', 40),
    'expires_at', case when jsonb_typeof(p -> 'expires_at') = 'number' then p -> 'expires_at' end,
    'scopes', case when jsonb_typeof(p -> 'scopes') = 'array'
      then (select coalesce(jsonb_agg(x), '[]'::jsonb) from jsonb_array_elements_text(p -> 'scopes') x where x ~ '^[a-z_]{2,60}$') end,
    'token_waba_ids', case when jsonb_typeof(p -> 'token_waba_ids') = 'array'
      then (select coalesce(jsonb_agg(x), '[]'::jsonb) from jsonb_array_elements_text(p -> 'token_waba_ids') x where x ~ '^[0-9]{5,25}$') end,
    'describable', case when jsonb_typeof(p -> 'describable') = 'boolean' then p -> 'describable' end)) end;
$$;

revoke all on function private.support_whatsapp_clean_check(jsonb) from public, anon, authenticated;

create or replace function public.support_whatsapp_verification_result(p_account uuid, p_verification jsonb)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.support_whatsapp_config;
  v jsonb := coalesce(p_verification, '{}'::jsonb);
  e jsonb;
  num constant text := '^[0-9]{5,25}$';
begin
  select * into c from public.support_whatsapp_config where channel_account_id = p_account for update;
  if not found then
    raise exception 'WhatsApp settings not found.' using errcode = 'P0001';
  end if;
  if coalesce(jsonb_typeof(v), '') <> 'object' or coalesce(jsonb_typeof(v -> 'checks'), '') <> 'object' then
    raise exception 'Invalid verification result (version 2 expected).' using errcode = 'P0001';
  end if;
  e := jsonb_build_object(
    'version', 2,
    'checked_at', coalesce((v ->> 'checked_at')::timestamptz, now()),
    'waba_id', case when v ->> 'waba_id' ~ num then v ->> 'waba_id' end,
    'phone_number_id', case when v ->> 'phone_number_id' ~ num then v ->> 'phone_number_id' end,
    'app_id', case when v ->> 'app_id' ~ num then v ->> 'app_id' end,
    'checks', jsonb_strip_nulls(jsonb_build_object(
      'phone_registration', private.support_whatsapp_clean_check(v -> 'checks' -> 'phone_registration'),
      'waba', private.support_whatsapp_clean_check(v -> 'checks' -> 'waba'),
      'ownership', private.support_whatsapp_clean_check(v -> 'checks' -> 'ownership'),
      'phone_in_waba', private.support_whatsapp_clean_check(v -> 'checks' -> 'phone_in_waba'),
      'subscription', private.support_whatsapp_clean_check(v -> 'checks' -> 'subscription'),
      'token', private.support_whatsapp_clean_check(v -> 'checks' -> 'token'),
      'app_secret', case when jsonb_typeof(v -> 'checks' -> 'app_secret' -> 'configured') = 'boolean'
        then jsonb_build_object('configured', v -> 'checks' -> 'app_secret' -> 'configured') end)));
  update public.support_whatsapp_config set meta_verification = e, meta_verified_at = now() where company_id = c.company_id;
  perform private.support_gmail_event(c.company_id, p_account, 'HEALTH_CHECK', 'Meta account verification recorded.',
    jsonb_build_object('checks', (select jsonb_object_agg(k.key, k.value ->> 'status') from jsonb_each(e -> 'checks') k where k.key <> 'app_secret')),
    'PROCESSED', null);
  return private.support_whatsapp_refresh(c.company_id, 'meta verification');
end;
$$;

revoke all on function public.support_whatsapp_verification_result(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.support_whatsapp_verification_result(uuid, jsonb) to service_role;

-- -----------------------------------------------------------------------------
-- 2. Preflight
-- -----------------------------------------------------------------------------
-- One Meta check as a preflight row part: result (OK / PENDING / BLOCKED), reason, detail, error code, time.
create or replace function private.support_whatsapp_meta_part(p_check jsonb, p_label text, p_ok_detail text)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case
    when p_check is null then jsonb_build_object('result', 'PENDING', 'reason', 'NOT_TESTED',
      'detail', p_label || ': not tested yet. Run Test connection.')
    when p_check ->> 'status' = 'VERIFIED' then jsonb_build_object('result', 'OK', 'reason', 'VERIFIED', 'detail', p_ok_detail, 'checked_at', p_check ->> 'checked_at')
    else jsonb_strip_nulls(jsonb_build_object('result', 'BLOCKED', 'reason', p_check ->> 'status', 'error_code', p_check -> 'error_code', 'checked_at', p_check ->> 'checked_at',
      'detail', p_label || ': ' || case p_check ->> 'status' when 'PERMISSION_DENIED' then 'permission denied — ' when 'INVALID_REQUEST' then 'invalid request — '
        when 'WRONG_ACCOUNT' then 'wrong account — ' else 'verification failed — ' end
        || coalesce(p_check ->> 'error_message', 'no detail from Meta') || coalesce(' ' || (p_check ->> 'hint'), '')
        || case when p_check ->> 'suggested_waba_id' is not null
             then format(' Meta lists this phone number under WhatsApp Business Account %s; check the configured id (nothing was changed).', p_check ->> 'suggested_waba_id') else '' end))
  end;
$$;

revoke all on function private.support_whatsapp_meta_part(jsonb, text, text) from public, anon, authenticated;

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
  ck       jsonb;
  v_ev_ok  boolean;
  v_cloud  boolean := c.number_path = 'CLOUD_API';
  checks   jsonb := '[]'::jsonb;
  v_status text;
  v_state  text := 'CONNECTED';
  v_block  jsonb := '[]'::jsonb;
  p        jsonb;
  x        jsonb;
  v_reg    boolean;
  v_member boolean;
  v_signed record;
  v_foreign record;
begin
  if c.company_id is null then
    return jsonb_build_object('status', 'NOT_CONFIGURED', 'setup_state', 'NOT_CONFIGURED', 'can_activate', false, 'checks', '[]'::jsonb,
      'blockers', jsonb_build_array('Save the WhatsApp settings first.'), 'eligibility', 'PENDING');
  end if;

  -- Evidence counts only for the ids configured now and in the version-2 format (older evidence = not tested).
  v_ev_ok := (ev ->> 'version') = '2' and ev ->> 'waba_id' is not distinct from c.waba_id and ev ->> 'phone_number_id' is not distinct from c.phone_number_id
             and ev ->> 'app_id' is not distinct from c.app_id;
  ck := case when v_ev_ok then coalesce(ev -> 'checks', '{}'::jsonb) else '{}'::jsonb end;

  -- Configuration
  checks := checks || jsonb_build_object('key', 'identifiers', 'label', 'Meta identifiers and Graph API version entered', 'mandatory', true, 'source', 'CONFIG', 'state', 'NOT_CONFIGURED',
    'result', case when c.waba_id is null or c.phone_number_id is null or c.display_phone_number is null or c.app_id is null or c.graph_api_version is null then 'PENDING' else 'OK' end,
    'detail', case when c.waba_id is null or c.phone_number_id is null or c.display_phone_number is null or c.app_id is null or c.graph_api_version is null
                   then 'Enter the WhatsApp Business Account id, phone number id, display number, Meta app id and Graph API version.'
                   else format('WABA %s, phone number id %s, app %s, Graph API %s.', c.waba_id, c.phone_number_id, c.app_id, c.graph_api_version) end);
  checks := checks || jsonb_build_object('key', 'usage', 'label', 'How the number is used today', 'mandatory', true, 'source', 'CONFIG', 'state', 'NUMBER_ELIGIBILITY_PENDING',
    'result', case when c.number_path = 'UNKNOWN' then 'PENDING' else 'OK' end,
    'detail', case c.number_path when 'UNKNOWN' then 'Choose how the support number is used today.'
      when 'CLOUD_API' then 'Already on the WhatsApp Business Platform / Cloud API (this WABA): no migration or coexistence onboarding is required.'
      when 'BSP' then 'On another provider: migration through Meta''s supported path is required.'
      when 'BUSINESS_APP_ONLY' then 'WhatsApp Business app only: migration to the Cloud API is required.'
      else 'Coexistence (WhatsApp Business app + Cloud API) through an approved partner.' end);
  checks := checks || jsonb_build_object('key', 'app_secret', 'label', 'App secret set for webhook signatures (WHATSAPP_APP_SECRET)', 'mandatory', true, 'source', 'CONFIG', 'state', 'WEBHOOK_PENDING',
    'result', case when ck -> 'app_secret' is null then 'PENDING' when (ck -> 'app_secret' ->> 'configured')::boolean then 'OK' else 'BLOCKED' end,
    'reason', case when ck -> 'app_secret' is null then 'NOT_TESTED' when (ck -> 'app_secret' ->> 'configured')::boolean then 'VERIFIED' else 'VERIFICATION_FAILED' end,
    'detail', case when ck -> 'app_secret' is null then 'App secret: not tested yet. Run Test connection.'
      when (ck -> 'app_secret' ->> 'configured')::boolean then 'WHATSAPP_APP_SECRET is set as an Edge Function secret (value never shown).'
      else 'WHATSAPP_APP_SECRET is not set as an Edge Function secret: signed webhooks cannot be verified. Set it to the Meta app secret (App settings → Basic).' end);

  -- Connection test (phone number details from Meta)
  checks := checks || jsonb_build_object('key', 'connection_test', 'label', 'Connection test passed', 'mandatory', true, 'source', 'TEST',
    'state', case when c.last_test_ok is false then 'ERROR' else 'NUMBER_ELIGIBILITY_PENDING' end,
    'result', case when c.last_test_ok is null then 'PENDING' when c.last_test_ok then 'OK' else 'FAILED' end,
    'reason', case when c.last_test_ok is null then 'NOT_TESTED' when c.last_test_ok then 'VERIFIED' else 'VERIFICATION_FAILED' end,
    'checked_at', c.last_test_at,
    'detail', case when c.last_test_ok is null then 'Connection test: not run yet. Run Test connection.' else coalesce(c.last_test_result, 'Connection test recorded.') end);

  -- Meta checks, each with its own result
  p := private.support_whatsapp_meta_part(ck -> 'phone_registration', 'Phone number registration',
    format('Meta: %s is %s on %s, quality %s.', coalesce(ck -> 'phone_registration' ->> 'display_phone_number', c.display_phone_number),
      ck -> 'phone_registration' ->> 'phone_status', coalesce(ck -> 'phone_registration' ->> 'platform_type', 'the Cloud API'),
      coalesce(ck -> 'phone_registration' ->> 'quality_rating', 'not reported')));
  checks := checks || (jsonb_build_object('key', 'phone_registration', 'label', 'Phone number registered and active (status CONNECTED, Cloud API, matching number)',
    'mandatory', true, 'source', 'META', 'state', 'NUMBER_ELIGIBILITY_PENDING') || p);
  p := private.support_whatsapp_meta_part(ck -> 'waba', 'WhatsApp Business Account',
    format('Meta: WhatsApp Business Account %s%s, review %s.', c.waba_id, coalesce(' "' || (ck -> 'waba' ->> 'waba_name') || '"', ''),
      coalesce(lower(ck -> 'waba' ->> 'account_review_status'), 'not reported')));
  checks := checks || (jsonb_build_object('key', 'waba', 'label', 'The configured id is a WhatsApp Business Account (name and status returned)',
    'mandatory', true, 'source', 'META', 'state', 'NUMBER_ELIGIBILITY_PENDING') || p);
  p := private.support_whatsapp_meta_part(ck -> 'phone_in_waba', 'Phone number under this WABA',
    format('Meta lists phone number id %s under WhatsApp Business Account %s (%s number(s)).', c.phone_number_id, c.waba_id, coalesce(ck -> 'phone_in_waba' ->> 'waba_phone_count', '?')));
  checks := checks || (jsonb_build_object('key', 'phone_in_waba', 'label', 'The phone number id belongs to the configured WhatsApp Business Account',
    'mandatory', true, 'source', 'META', 'state', 'NUMBER_ELIGIBILITY_PENDING') || p);
  -- Ownership: Meta's answer compared with the configured portfolio here.
  p := case
    when c.business_portfolio_id is null then jsonb_build_object('result', 'PENDING', 'reason', 'NOT_TESTED', 'detail', 'Enter the Meta business portfolio id.')
    when ck -> 'ownership' ->> 'status' = 'VERIFIED' and ck -> 'ownership' ->> 'owner_business_id' is distinct from c.business_portfolio_id then
      jsonb_build_object('result', 'BLOCKED', 'reason', 'WRONG_ACCOUNT', 'checked_at', ck -> 'ownership' ->> 'checked_at',
        'detail', format('Business portfolio: wrong account — Meta says WhatsApp Business Account %s is owned by portfolio %s%s, not the configured %s.', c.waba_id,
          ck -> 'ownership' ->> 'owner_business_id', coalesce(' (' || (ck -> 'ownership' ->> 'owner_business_name') || ')', ''), c.business_portfolio_id))
    else private.support_whatsapp_meta_part(ck -> 'ownership', 'Business portfolio',
      format('Meta: WhatsApp Business Account %s is owned by portfolio %s%s.', c.waba_id, c.business_portfolio_id, coalesce(' (' || (ck -> 'ownership' ->> 'owner_business_name') || ')', ''))) end;
  checks := checks || (jsonb_build_object('key', 'business_portfolio', 'label', 'The WhatsApp Business Account belongs to the configured business portfolio',
    'mandatory', true, 'source', 'META', 'state', 'NUMBER_ELIGIBILITY_PENDING') || p);

  -- Eligibility (derived for the Cloud API usage; manual evidence for the other usages)
  v_reg := ck -> 'phone_registration' ->> 'status' = 'VERIFIED';
  v_member := ck -> 'phone_in_waba' ->> 'status' = 'VERIFIED';
  if v_cloud then
    checks := checks || jsonb_build_object('key', 'cloud_api_eligibility', 'label', 'Number registered and active on the Cloud API under this WABA', 'mandatory', true,
      'source', 'META', 'derived', true, 'state', 'NUMBER_ELIGIBILITY_PENDING',
      'result', case when v_reg and v_member then 'OK' when ck -> 'phone_registration' is null or ck -> 'phone_in_waba' is null then 'PENDING' else 'BLOCKED' end,
      'reason', case when v_reg and v_member then 'VERIFIED' when ck -> 'phone_registration' is null or ck -> 'phone_in_waba' is null then 'NOT_TESTED' else 'VERIFICATION_FAILED' end,
      'detail', case when v_reg and v_member then 'Verified by Meta: registered (CONNECTED, Cloud API) and listed under this WhatsApp Business Account.'
        else 'Follows the two checks "Phone number registered" and "Phone number under this WABA" above.' end);
  else
    checks := checks || jsonb_build_object('key', 'cloud_api_eligibility', 'label', 'Meta confirmed the number can be registered on the Cloud API under this WABA', 'mandatory', true,
      'source', 'ADMIN', 'state', 'NUMBER_ELIGIBILITY_PENDING',
      'result', case when private.support_whatsapp_done(c, 'cloud_api_eligibility') then 'OK' else 'PENDING' end,
      'reason', case when private.support_whatsapp_done(c, 'cloud_api_eligibility') then 'VERIFIED' else 'NOT_TESTED' end,
      'detail', case when private.support_whatsapp_done(c, 'cloud_api_eligibility') then 'Confirmed in the checklist: ' || coalesce(c.checklist -> 'cloud_api_eligibility' ->> 'note', '')
        else 'Cloud API eligibility: confirm in the checklist with the evidence (Meta case or partner reference); Meta cannot verify a number before it is registered.' end);
  end if;
  checks := checks || jsonb_build_object('key', 'number_path_confirmed', 'label', 'Usage of the number confirmed', 'mandatory', true, 'derived', v_cloud, 'state', 'NUMBER_ELIGIBILITY_PENDING',
    'source', case when private.support_whatsapp_done(c, 'number_path_confirmed') then 'ADMIN' else 'META' end,
    'result', case when private.support_whatsapp_done(c, 'number_path_confirmed') or (v_cloud and v_reg and v_member) then 'OK' else 'PENDING' end,
    'reason', case when private.support_whatsapp_done(c, 'number_path_confirmed') or (v_cloud and v_reg and v_member) then 'VERIFIED' else 'NOT_TESTED' end,
    'detail', case when private.support_whatsapp_done(c, 'number_path_confirmed') then 'Confirmed in the checklist.'
      when v_cloud and v_reg and v_member then 'Verified by Meta: the number is on the Cloud API under this WABA, as selected.'
      when v_cloud then 'Follows the Meta checks above (or confirm the usage in the checklist).'
      else 'Usage: confirm in the checklist how the number is used today.' end);

  -- Conditional onboarding steps (only for the usages that need them)
  if c.number_path in ('BUSINESS_APP_ONLY', 'BSP') then
    checks := checks || jsonb_build_object('key', 'migration_completed', 'label', 'Migration completed through Meta''s supported path', 'mandatory', true, 'source', 'ADMIN', 'state', 'MIGRATION_REQUIRED',
      'result', case when private.support_whatsapp_done(c, 'migration_completed') then 'OK' else 'BLOCKED' end,
      'detail', case when private.support_whatsapp_done(c, 'migration_completed') then 'Migration: confirmed in the checklist.' else 'The number must first be migrated (not done by the ERP).' end);
  end if;
  if c.number_path = 'COEXISTENCE' then
    checks := checks || jsonb_build_object('key', 'coexistence_approved', 'label', 'Coexistence onboarding completed through an approved partner', 'mandatory', true, 'source', 'ADMIN', 'state', 'COEXISTENCE_PENDING',
      'result', case when private.support_whatsapp_done(c, 'coexistence_approved') then 'OK' else 'BLOCKED' end,
      'detail', case when private.support_whatsapp_done(c, 'coexistence_approved') then 'Coexistence: confirmed in the checklist.' else 'Coexistence onboarding is not confirmed.' end);
  end if;
  if c.number_path in ('BUSINESS_APP_ONLY', 'BSP', 'COEXISTENCE') then
    checks := checks || jsonb_build_object('key', 'previous_routing_retired', 'label', 'Previous routing (other provider / app) retired or agreed', 'mandatory', true, 'source', 'ADMIN',
      'state', case when c.number_path = 'COEXISTENCE' then 'COEXISTENCE_PENDING' else 'MIGRATION_REQUIRED' end,
      'result', case when private.support_whatsapp_done(c, 'previous_routing_retired') then 'OK' else 'BLOCKED' end,
      'detail', case when private.support_whatsapp_done(c, 'previous_routing_retired') then 'Previous routing: confirmed in the checklist.' else 'Confirm that messages are no longer routed elsewhere.' end);
  end if;

  -- Token: Meta's description; a checklist confirmation counts only when Meta could not describe the token.
  p := case
    when ck -> 'token' is not null and (ck -> 'token' ->> 'describable') = 'false' and ck -> 'token' ->> 'status' not in ('PERMISSION_DENIED', 'WRONG_ACCOUNT')
         and coalesce((ck -> 'token' ->> 'error_code')::int, 0) <> 190 and private.support_whatsapp_done(c, 'system_user_token') then
      jsonb_build_object('result', 'OK', 'reason', 'VERIFIED', 'source_override', 'ADMIN', 'checked_at', ck -> 'token' ->> 'checked_at',
        'detail', 'Access token: Meta did not describe it (' || coalesce(ck -> 'token' ->> 'error_message', 'no answer') || '); confirmed by an administrator in the checklist.')
    else private.support_whatsapp_meta_part(ck -> 'token', 'Access token',
      format('Verified by Meta: valid %s token, never expires, whatsapp_business_messaging and whatsapp_business_management for this WABA.', lower(coalesce(ck -> 'token' ->> 'token_type', 'system-user'))))
  end;
  checks := checks || (jsonb_build_object('key', 'access_token', 'label', 'Permanent system-user token with whatsapp_business_messaging and whatsapp_business_management',
    'mandatory', true, 'source', coalesce(p ->> 'source_override', 'META'), 'state', 'WEBHOOK_PENDING') || (p - 'source_override'));

  -- Webhook evidence, in levels
  p := case
    when ck -> 'subscription' is not null and ck -> 'subscription' ->> 'status' in ('VERIFICATION_FAILED', 'INVALID_REQUEST') and coalesce((ck -> 'subscription' ->> 'error_code')::int, 0) <> 190
         and ck -> 'waba' ->> 'status' = 'VERIFIED' and private.support_whatsapp_done(c, 'webhook_subscribed') then
      jsonb_build_object('result', 'OK', 'reason', 'VERIFIED', 'source_override', 'ADMIN', 'checked_at', ck -> 'subscription' ->> 'checked_at',
        'detail', 'App subscription: Meta did not list the subscribed apps (' || coalesce(ck -> 'subscription' ->> 'error_message', 'no answer') || '); confirmed by an administrator.')
    else private.support_whatsapp_meta_part(ck -> 'subscription', 'App subscription', format('Verified by Meta: app %s is subscribed to WhatsApp Business Account %s.', c.app_id, c.waba_id))
  end;
  checks := checks || (jsonb_build_object('key', 'webhook_subscription', 'label', 'The Meta app is subscribed to this WABA''s webhooks', 'mandatory', true,
    'source', coalesce(p ->> 'source_override', 'META'), 'state', 'WEBHOOK_PENDING') || (p - 'source_override'));
  checks := checks || jsonb_build_object('key', 'webhook_verified', 'label', 'Webhook callback verified (challenge)', 'mandatory', true, 'source', 'WEBHOOK', 'state', 'WEBHOOK_PENDING',
    'result', case when c.webhook_verified_at is not null then 'OK' else 'PENDING' end, 'reason', case when c.webhook_verified_at is not null then 'VERIFIED' else 'NOT_TESTED' end,
    'checked_at', c.webhook_verified_at,
    'detail', case when c.webhook_verified_at is not null then format('Challenge passed %s. (A challenge is not a signed event.)', to_char(c.webhook_verified_at at time zone 'Asia/Kolkata', 'DD Mon YYYY HH24:MI'))
      else 'Webhook challenge: not received yet. Verify the callback URL in the Meta app (WhatsApp → Configuration).' end);
  -- Every stored webhook event passed the X-Hub-Signature-256 check in whatsapp-webhook before it was stored.
  select max(received_at) as at, count(*) as n into v_signed from public.support_whatsapp_webhook_events w where w.company_id = c.company_id;
  checks := checks || jsonb_build_object('key', 'webhook_signed', 'label', 'Signed webhook POST received (signature checked with the app secret)', 'mandatory', true, 'source', 'WEBHOOK',
    'state', 'WEBHOOK_PENDING', 'result', case when v_signed.n > 0 then 'OK' else 'PENDING' end, 'reason', case when v_signed.n > 0 then 'VERIFIED' else 'NOT_TESTED' end,
    'checked_at', v_signed.at,
    'detail', case when v_signed.n > 0 then format('%s signed event(s) received, last %s.', v_signed.n, to_char(v_signed.at at time zone 'Asia/Kolkata', 'DD Mon YYYY HH24:MI'))
      else 'Signed webhook POST: none received yet. In the Meta app (WhatsApp → Configuration → Webhook fields → messages) use "Test", or send a WhatsApp message to the number.' end);
  -- Signed events Meta sends for THIS phone number under another WABA id prove the configured WABA id is wrong.
  select w.entry_id, w.received_at into v_foreign from public.support_whatsapp_webhook_events w
  where w.company_id = c.company_id and w.result = 'REJECTED' and w.received_at > now() - interval '30 days'
    and w.entry_id is distinct from c.waba_id and w.payload #>> '{metadata,phone_number_id}' = c.phone_number_id
  order by w.received_at desc limit 1;
  checks := checks || jsonb_build_object('key', 'webhook_account', 'label', 'Signed events arrive for this WhatsApp Business Account', 'source', 'WEBHOOK', 'state', 'NUMBER_ELIGIBILITY_PENDING',
    'mandatory', v_foreign.entry_id is not null and c.webhook_signed_event_at is null,
    'result', case when c.webhook_signed_event_at is not null then 'OK' when v_foreign.entry_id is not null then 'BLOCKED' else 'PENDING' end,
    'reason', case when c.webhook_signed_event_at is not null then 'VERIFIED' when v_foreign.entry_id is not null then 'WRONG_ACCOUNT' else 'NOT_TESTED' end,
    'checked_at', coalesce(c.webhook_signed_event_at, v_foreign.received_at),
    'detail', case when c.webhook_signed_event_at is not null then format('Signed event for WABA %s accepted %s.', c.waba_id, to_char(c.webhook_signed_event_at at time zone 'Asia/Kolkata', 'DD Mon YYYY HH24:MI'))
      when v_foreign.entry_id is not null then format('Webhook account: wrong account — Meta sent signed events for phone number id %s under WhatsApp Business Account %s (last %s), not the configured %s. Check the WhatsApp Business Account ID; nothing was changed.',
        c.phone_number_id, v_foreign.entry_id, to_char(v_foreign.received_at at time zone 'Asia/Kolkata', 'DD Mon YYYY HH24:MI'), c.waba_id)
      else 'No signed event for this WABA yet (recommended, not required): it arrives with the first message or status for the number.' end);

  -- Recommended (never block activation)
  checks := checks || jsonb_build_object('key', 'quality_rating', 'label', 'Phone quality rating', 'mandatory', false, 'source', 'META',
    'result', case when upper(coalesce(ck -> 'phone_registration' ->> 'quality_rating', ph ->> 'quality_rating', '')) = 'GREEN' then 'OK' else 'PENDING' end,
    'detail', coalesce('Quality: ' || coalesce(ck -> 'phone_registration' ->> 'quality_rating', ph ->> 'quality_rating') || '.', 'Quality: not reported yet.'));
  checks := checks || jsonb_build_object('key', 'templates_reviewed', 'label', 'Message templates for business-initiated messages approved', 'mandatory', false, 'source', 'ADMIN',
    'result', case when exists (select 1 from public.support_whatsapp_templates t where t.company_id = c.company_id and t.status = 'APPROVED') then 'OK' else 'PENDING' end,
    'detail', format('%s approved template(s) synchronised.', (select count(*) from public.support_whatsapp_templates t where t.company_id = c.company_id and t.status = 'APPROVED')));

  -- Outcome: the first mandatory check that is not OK decides the stored state; blockers are unique and never
  -- repeat a derived check whose reasons are already listed.
  for x in select value from jsonb_array_elements(checks) loop
    if (x ->> 'mandatory')::boolean and x ->> 'result' <> 'OK' then
      if v_state = 'CONNECTED' then v_state := x ->> 'state'; end if;
      if not coalesce((x ->> 'derived')::boolean, false) and not (v_block @> jsonb_build_array(x ->> 'detail')) then
        v_block := v_block || jsonb_build_array(x ->> 'detail');
      end if;
    end if;
  end loop;
  if c.last_test_ok is false then v_state := 'ERROR'; end if;
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
    'evidence_stale', ev ? 'checked_at' and not v_ev_ok,
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
