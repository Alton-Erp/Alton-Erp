-- =============================================================================
-- Append-only audit log.
-- Rows are written by trusted triggers and SECURITY DEFINER functions only.
-- Never store passwords, tokens, keys or unnecessary personal data in metadata.
-- =============================================================================

create table if not exists public.audit_logs (
  id              uuid primary key default gen_random_uuid(),
  -- Null only for events that precede company assignment (e.g. user provisioned).
  company_id      uuid references public.companies (id) on delete restrict,
  -- No foreign key: history must survive user deletion. Null for system events.
  actor_user_id   uuid,
  action          text not null check (action ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)+$' and length(action) <= 100),
  resource_type   text not null check (resource_type ~ '^[a-z][a-z_]*$' and length(resource_type) <= 60),
  resource_id     text check (resource_id is null or length(resource_id) <= 200),
  event_timestamp timestamptz not null default now(),
  request_id      text check (request_id is null or length(request_id) <= 200),
  metadata        jsonb not null default '{}'::jsonb
                  check (jsonb_typeof(metadata) = 'object' and pg_column_size(metadata) <= 8192)
);

comment on table public.audit_logs is 'Append-only security and business audit trail. Not writable by clients.';

create index if not exists audit_logs_company_time_idx on public.audit_logs (company_id, event_timestamp desc);
create index if not exists audit_logs_actor_idx on public.audit_logs (actor_user_id, event_timestamp desc);
create index if not exists audit_logs_resource_idx on public.audit_logs (resource_type, resource_id);

-- Append-only for everyone, including service_role. A database owner can only
-- change history by explicitly disabling this trigger, which is itself visible
-- in the database logs.
create or replace function private.prevent_audit_log_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'audit_logs is append-only' using errcode = '42501';
end;
$$;

revoke all on function private.prevent_audit_log_mutation() from public, anon, authenticated;

drop trigger if exists audit_logs_append_only on public.audit_logs;
create trigger audit_logs_append_only
  before update or delete on public.audit_logs
  for each row execute function private.prevent_audit_log_mutation();

drop trigger if exists audit_logs_no_truncate on public.audit_logs;
create trigger audit_logs_no_truncate
  before truncate on public.audit_logs
  for each statement execute function private.prevent_audit_log_mutation();

-- Internal writer used by triggers and trusted functions.
create or replace function private.write_audit_log(
  p_company_id    uuid,
  p_action        text,
  p_resource_type text,
  p_resource_id   text,
  p_metadata      jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.audit_logs (company_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (p_company_id, auth.uid(), p_action, p_resource_type, p_resource_id, coalesce(p_metadata, '{}'::jsonb));
end;
$$;

revoke all on function private.write_audit_log(uuid, text, text, text, jsonb) from public, anon, authenticated;
