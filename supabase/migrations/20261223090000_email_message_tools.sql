-- =============================================================================
-- Email workspace, per-message tools (on top of 20261222090000_email_mailbox).
--
-- Additive only: one column on the mailbox state table and five functions. No email, attachment,
-- conversation or label row is changed by this migration; receiving and sending are unchanged.
--
--   support_email_thread_state.starred_emails   the emails starred inside a starred conversation
--                                                (the conversation is starred while one of them is)
--   public.support_email_list_attachments(ids)   attachment chips for the visible list rows
--                                                (same visibility rule as support_email_thread)
--   public.support_email_message_state(conv)     which emails of a conversation are starred
--   public.support_email_message_action(e, a)    STAR / UNSTAR one email; REPORT_SPAM / REPORT_PHISHING
--                                                (recorded per email, the conversation moves to Spam
--                                                in the ERP; nothing is reported to Google)
--   public.support_email_original_target(e)      for google-gmail-send (action original): the Gmail
--                                                message to read for "Show original" / "Download original"
-- =============================================================================

alter table public.support_email_thread_state add column if not exists starred_emails uuid[] not null default '{}';

-- -----------------------------------------------------------------------------
-- 1. Attachments of the list rows (support.view). Inline images are left out, as in the thread.
--    Sensitive files keep their name but no storage path unless the user may see them.
-- -----------------------------------------------------------------------------
create or replace function public.support_email_list_attachments(p_ids uuid[])
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.view');
  v_sensitive boolean := private.has_permission(v_company, 'support.manage_tickets');
begin
  if cardinality(coalesce(p_ids, '{}')) > 100 then
    raise exception 'At most 100 conversations at a time.' using errcode = 'P0001';
  end if;
  return coalesce((
    select jsonb_object_agg(c.id, jsonb_build_object('count', c.n, 'items', c.items))
    from (
      select s.id,
             (select count(*) from public.support_email_messages m join public.support_attachments a on a.message_id = m.message_id
               where m.conversation_id = s.id and m.company_id = v_company and not coalesce(a.email_inline, false)) as n,
             coalesce((select jsonb_agg(x.j order by x.at desc, x.created_at) from (
                 select jsonb_build_object('id', a.id, 'email_id', m.id, 'file_name', a.file_name, 'content_type', a.content_type, 'size_bytes', a.size_bytes,
                          'storage_path', case when v_sensitive or not a.is_sensitive then a.storage_path end,
                          'restricted', a.is_sensitive and not v_sensitive) as j,
                        coalesce(m.internal_date, m.created_at) as at, a.created_at
                 from public.support_email_messages m join public.support_attachments a on a.message_id = m.message_id
                 where m.conversation_id = s.id and m.company_id = v_company and not coalesce(a.email_inline, false)
                 order by coalesce(m.internal_date, m.created_at) desc, a.created_at limit 8) x), '[]'::jsonb) as items
      from public.support_conversations s
      where s.id = any (p_ids) and s.company_id = v_company and s.channel = 'EMAIL'
    ) c where c.n > 0), '{}'::jsonb);
end;
$$;

-- -----------------------------------------------------------------------------
-- 2. Starred emails of one conversation (support.view)
-- -----------------------------------------------------------------------------
create or replace function public.support_email_message_state(p_conversation uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.view');
begin
  if not exists (select 1 from public.support_conversations where id = p_conversation and company_id = v_company and channel = 'EMAIL') then
    raise exception 'Email conversation not found in your company.' using errcode = 'P0001';
  end if;
  return coalesce((select jsonb_build_object('starred', st.starred, 'starred_emails', to_jsonb(case when st.starred then st.starred_emails else '{}'::uuid[] end))
                   from public.support_email_thread_state st where st.conversation_id = p_conversation),
                  jsonb_build_object('starred', false, 'starred_emails', '[]'::jsonb));
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. Actions on one email (support.reply)
--    STAR / UNSTAR      the email; the conversation is starred while at least one email is.
--                       Starring inside an unstarred conversation starts a new set (stale stars are dropped).
--    REPORT_SPAM /      recorded in the audit log for this email; its conversation moves to Spam
--    REPORT_PHISHING    (the ERP mailbox only: Gmail and Google are not told).
-- -----------------------------------------------------------------------------
create or replace function public.support_email_message_action(p_email uuid, p_action text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.reply');
  v_action text := upper(coalesce(p_action, ''));
  m record;
  st public.support_email_thread_state;
begin
  if v_action not in ('STAR', 'UNSTAR', 'REPORT_SPAM', 'REPORT_PHISHING') then
    raise exception 'Unknown email action %.', p_action using errcode = 'P0001';
  end if;
  select e.id, e.conversation_id, e.rfc_message_id, e.from_address into m
  from public.support_email_messages e join public.support_conversations s on s.id = e.conversation_id and s.company_id = e.company_id
  where e.id = p_email and e.company_id = v_company and s.channel = 'EMAIL';
  if not found then
    raise exception 'Email not found in your company.' using errcode = 'P0001';
  end if;

  insert into public.support_email_thread_state (company_id, conversation_id, updated_by)
  values (v_company, m.conversation_id, auth.uid()) on conflict (conversation_id) do nothing;
  select * into st from public.support_email_thread_state where conversation_id = m.conversation_id for update;

  if v_action = 'STAR' then
    update public.support_email_thread_state set
      starred_emails = case when starred then array(select distinct x from unnest(array_append(starred_emails, m.id)) x) else array[m.id] end,
      starred = true, updated_by = auth.uid(), updated_at = now()
    where conversation_id = m.conversation_id;
  elsif v_action = 'UNSTAR' then
    update public.support_email_thread_state set
      starred_emails = array_remove(starred_emails, m.id),
      starred = cardinality(array_remove(starred_emails, m.id)) > 0 and starred,
      updated_by = auth.uid(), updated_at = now()
    where conversation_id = m.conversation_id;
  else
    update public.support_email_thread_state set
      folder = 'SPAM', folder_at = now(), snoozed_until = null, updated_by = auth.uid(), updated_at = now()
    where conversation_id = m.conversation_id;
  end if;

  perform private.support_audit(v_company, 'email.message_' || lower(v_action), 'support_email_messages', m.id::text,
    jsonb_strip_nulls(jsonb_build_object('conversation_id', m.conversation_id, 'rfc_message_id', m.rfc_message_id,
      'from', case when v_action like 'REPORT_%' then m.from_address end)));
  select * into st from public.support_email_thread_state where conversation_id = m.conversation_id;
  return jsonb_build_object('action', v_action, 'email_id', m.id, 'conversation_id', m.conversation_id, 'starred', st.starred,
    'starred_emails', to_jsonb(st.starred_emails), 'folder', st.folder);
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. "Show original" / "Download original" (support.view; read by google-gmail-send with the caller's JWT)
--    The full message includes its attachments, so it is offered only to users who may open all of them.
-- -----------------------------------------------------------------------------
create or replace function public.support_email_original_target(p_email uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.view');
  v_sensitive boolean := private.has_permission(v_company, 'support.manage_tickets');
  m public.support_email_messages;
  c public.support_email_config;
begin
  select * into m from public.support_email_messages where id = p_email and company_id = v_company;
  if not found then
    raise exception 'Email not found in your company.' using errcode = 'P0001';
  end if;
  select * into c from public.support_email_config where company_id = v_company;
  return jsonb_build_object(
    'account_id', case when c.is_enabled then c.channel_account_id end,
    'gmail_message_id', m.gmail_message_id,
    'raw_allowed', v_sensitive or not exists (select 1 from public.support_attachments a where a.message_id = m.message_id and a.is_sensitive),
    'subject', m.subject);
end;
$$;

do $$
declare
  f text;
begin
  for f in select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in ('support_email_list_attachments', 'support_email_message_state', 'support_email_message_action',
             'support_email_original_target') loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;
