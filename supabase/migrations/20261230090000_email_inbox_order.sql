-- =============================================================================
-- Email Inbox order: a sent reply no longer moves a conversation to the top
--
-- Cause: support_email_mailbox (20261222090000) ordered every folder by last_at = the newest message of the
-- conversation in either direction, so replying to an older received email put the conversation first in the Inbox
-- as if new mail had arrived. Sending itself was correct (same Gmail thread, In-Reply-To / References, stored once,
-- unread count untouched); only the list's sort key was wrong.
--
-- Now each folder has its own sort time (returned as sort_at, with last_in_at / last_out_at / last_at):
--   Inbox = latest received email; Sent = latest sent email; Starred, Snoozed, Important, All Mail, Labels, Spam,
--   Trash = latest activity in either direction (unchanged). Ties keep the previous order.
-- Only this read-only function is redefined: no table, row, timestamp, checkpoint or unread count changes.
-- Rollback: supabase/rollback/20261230090000_email_inbox_order_down.sql
-- =============================================================================

create or replace function public.support_email_mailbox(p jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.view');
  v_folder text := upper(coalesce(nullif(p ->> 'folder', ''), 'INBOX'));
  v_label uuid;
  v_q text := nullif(btrim(coalesce(p ->> 'q', '')), '');
  v_from text := nullif(btrim(coalesce(p ->> 'from', '')), '');
  v_to text := nullif(btrim(coalesce(p ->> 'to', '')), '');
  v_subject text := nullif(btrim(coalesce(p ->> 'subject', '')), '');
  v_words text := nullif(btrim(coalesce(p ->> 'words', '')), '');
  v_after date;
  v_before date;
  v_att boolean := case when p ? 'has_attachment' and jsonb_typeof(p -> 'has_attachment') = 'boolean' then (p ->> 'has_attachment')::boolean end;
  v_unread boolean := case when p ? 'unread' and jsonb_typeof(p -> 'unread') = 'boolean' then (p ->> 'unread')::boolean end;
  v_limit integer := least(greatest(coalesce(nullif(p ->> 'limit', '')::integer, 50), 1), 100);
  v_offset integer := greatest(coalesce(nullif(p ->> 'offset', '')::integer, 0), 0);
  v_tz text := coalesce((select nullif(timezone, '') from public.companies where id = v_company), 'UTC');
begin
  if v_folder not in ('INBOX', 'STARRED', 'SNOOZED', 'SENT', 'IMPORTANT', 'ALL', 'SPAM', 'TRASH', 'LABEL') then
    raise exception 'Unknown mail folder %.', p ->> 'folder' using errcode = 'P0001';
  end if;
  if v_folder = 'LABEL' then
    begin
      v_label := (p ->> 'label')::uuid;
    exception when others then
      raise exception 'Choose a label.' using errcode = 'P0001';
    end;
  end if;
  if coalesce(p ->> 'after', '') !~ '^(\d{4}-\d{2}-\d{2})?$' or coalesce(p ->> 'before', '') !~ '^(\d{4}-\d{2}-\d{2})?$' then
    raise exception 'Dates must look like 2026-11-20.' using errcode = 'P0001';
  end if;
  begin
    v_after := nullif(p ->> 'after', '')::date;
    v_before := nullif(p ->> 'before', '')::date;
  exception when others then
    raise exception 'Dates must look like 2026-11-20.' using errcode = 'P0001';
  end;
  -- Length limits keep LIKE patterns cheap.
  if greatest(length(v_q), length(v_from), length(v_to), length(v_subject), length(v_words)) > 200 then
    raise exception 'Search terms can have at most 200 characters.' using errcode = 'P0001';
  end if;

  return (
    with t as (
      select s.id, s.unread_count, s.customer_id, s.ticket_id, s.assigned_agent_id, s.status, s.priority,
             a.last_at, a.last_in, a.last_out, a.has_in, a.has_out, a.n,
             coalesce(st.starred, false) as starred, coalesce(st.important, false) as important,
             -- "The customer wrote again" = an email received by the ERP after the action (stored time, not the sender's date).
             case when st.snoozed_until > now() and (a.in_stored is null or a.in_stored <= st.snoozed_at) then st.snoozed_until end as snoozed_until,
             case when st.folder in ('SPAM', 'TRASH') then st.folder
                  when st.folder = 'ARCHIVE' and (a.in_stored is null or a.in_stored <= st.folder_at) then 'ARCHIVE'
                  else 'INBOX' end as folder
      from public.support_conversations s
      join lateral (
        select max(coalesce(m.internal_date, m.created_at)) as last_at,
               max(coalesce(m.internal_date, m.created_at)) filter (where m.direction = 'INBOUND') as last_in,
               max(coalesce(m.internal_date, m.created_at)) filter (where m.direction = 'OUTBOUND') as last_out,
               max(m.created_at) filter (where m.direction = 'INBOUND') as in_stored,
               bool_or(m.direction = 'INBOUND') as has_in, bool_or(m.direction = 'OUTBOUND') as has_out, count(*) as n
        from public.support_email_messages m where m.conversation_id = s.id and m.duplicate_of is null
      ) a on a.n > 0
      left join public.support_email_thread_state st on st.conversation_id = s.id
      where s.company_id = v_company and s.channel = 'EMAIL'
    ), f as (
      select t.*, case v_folder when 'INBOX' then t.last_in when 'SENT' then t.last_out else t.last_at end as sort_at from t
      where case v_folder
              when 'INBOX' then t.folder = 'INBOX' and t.snoozed_until is null and t.has_in
              when 'STARRED' then t.starred and t.folder not in ('SPAM', 'TRASH')
              when 'SNOOZED' then t.snoozed_until is not null and t.folder not in ('SPAM', 'TRASH')
              when 'IMPORTANT' then t.important and t.folder not in ('SPAM', 'TRASH')
              when 'SENT' then t.has_out and t.folder not in ('SPAM', 'TRASH')
              when 'ALL' then t.folder not in ('SPAM', 'TRASH')
              when 'LABEL' then t.folder not in ('SPAM', 'TRASH')
                                and exists (select 1 from public.support_conversation_tags ct where ct.conversation_id = t.id and ct.tag_id = v_label)
              else t.folder = v_folder end
        and (v_unread is null or (t.unread_count > 0) = v_unread)
        and (v_att is null or v_att = exists (select 1 from public.support_email_messages m join public.support_attachments x on x.message_id = m.message_id
                                              where m.conversation_id = t.id and not coalesce(x.email_inline, false)))
        and (v_after is null or exists (select 1 from public.support_email_messages m where m.conversation_id = t.id
                                        and (coalesce(m.internal_date, m.created_at) at time zone v_tz)::date >= v_after))
        and (v_before is null or exists (select 1 from public.support_email_messages m where m.conversation_id = t.id
                                         and (coalesce(m.internal_date, m.created_at) at time zone v_tz)::date <= v_before))
        and (v_from is null or exists (select 1 from public.support_email_messages m where m.conversation_id = t.id
                                       and (m.from_address ilike '%' || v_from || '%' or m.from_name ilike '%' || v_from || '%')))
        and (v_to is null or exists (select 1 from public.support_email_messages m where m.conversation_id = t.id
                                     and (m.to_addresses::text ilike '%' || v_to || '%' or m.cc_addresses::text ilike '%' || v_to || '%')))
        and (v_subject is null or exists (select 1 from public.support_email_messages m where m.conversation_id = t.id and m.subject ilike '%' || v_subject || '%'))
        and (v_words is null or exists (select 1 from public.support_email_messages m where m.conversation_id = t.id
                                        and (m.body_text ilike '%' || v_words || '%' or m.subject ilike '%' || v_words || '%')))
        and (v_q is null or exists (select 1 from public.support_email_messages m where m.conversation_id = t.id
                                    and (m.subject ilike '%' || v_q || '%' or m.body_text ilike '%' || v_q || '%' or m.from_address ilike '%' || v_q || '%'
                                         or m.from_name ilike '%' || v_q || '%' or m.to_addresses::text ilike '%' || v_q || '%' or m.cc_addresses::text ilike '%' || v_q || '%')))
    ), page as (
      select f.*, row_number() over (order by f.sort_at desc nulls last, f.last_at desc, f.id) as rn from f
      order by rn limit v_limit offset v_offset
    )
    select jsonb_build_object(
      'total', (select count(*) from f),
      'rows', coalesce((select jsonb_agg(jsonb_build_object(
          'id', g.id, 'last_at', g.last_at, 'sort_at', g.sort_at, 'last_in_at', g.last_in, 'last_out_at', g.last_out, 'message_count', g.n, 'unread_count', g.unread_count,
          'starred', g.starred, 'important', g.important, 'snoozed_until', g.snoozed_until, 'folder', g.folder,
          'subject', l.subject, 'snippet', left(regexp_replace(coalesce(l.body_text, ''), '\s+', ' ', 'g'), 200),
          'last_direction', l.direction, 'last_send_state', l.send_state,
          'from_name', fi.from_name, 'from_address', fi.from_address,
          'to', l.to_addresses,
          'senders', (select coalesce(jsonb_agg(x.who order by x.at), '[]'::jsonb) from (
                        select distinct on (coalesce(m.from_name, m.from_address)) coalesce(nullif(m.from_name, ''), m.from_address) as who,
                               coalesce(m.internal_date, m.created_at) as at, m.direction
                        from public.support_email_messages m where m.conversation_id = g.id and m.duplicate_of is null and m.direction = 'INBOUND'
                        order by coalesce(m.from_name, m.from_address), coalesce(m.internal_date, m.created_at)) x),
          'has_attachment', exists (select 1 from public.support_email_messages m join public.support_attachments x on x.message_id = m.message_id
                                    where m.conversation_id = g.id and not coalesce(x.email_inline, false)),
          'labels', coalesce((select jsonb_agg(jsonb_build_object('id', tg.id, 'name', tg.name, 'color', tg.color) order by tg.name)
                              from public.support_conversation_tags ct join public.support_tags tg on tg.id = ct.tag_id where ct.conversation_id = g.id), '[]'::jsonb),
          'customer_name', c.display_name, 'ticket_id', g.ticket_id, 'ticket_number', tk.ticket_number, 'assigned_agent', ag.display_name, 'status', g.status)
        order by g.rn)
        from page g
        left join lateral (select m.subject, m.body_text, m.direction, m.send_state, m.to_addresses from public.support_email_messages m
                           where m.conversation_id = g.id and m.duplicate_of is null order by coalesce(m.internal_date, m.created_at) desc, m.created_at desc limit 1) l on true
        left join lateral (select m.from_name, m.from_address from public.support_email_messages m
                           where m.conversation_id = g.id and m.duplicate_of is null and m.direction = 'INBOUND'
                           order by coalesce(m.internal_date, m.created_at) desc limit 1) fi on true
        left join public.support_customers c on c.id = g.customer_id
        left join public.support_tickets tk on tk.id = g.ticket_id
        left join public.support_agents ag on ag.id = g.assigned_agent_id), '[]'::jsonb),
      'counts', jsonb_build_object(
        'INBOX', (select count(*) from t where t.folder = 'INBOX' and t.snoozed_until is null and t.has_in and t.unread_count > 0),
        'INBOX_TOTAL', (select count(*) from t where t.folder = 'INBOX' and t.snoozed_until is null and t.has_in),
        'STARRED', (select count(*) from t where t.starred and t.folder not in ('SPAM', 'TRASH')),
        'SNOOZED', (select count(*) from t where t.snoozed_until is not null and t.folder not in ('SPAM', 'TRASH')),
        'IMPORTANT', (select count(*) from t where t.important and t.folder not in ('SPAM', 'TRASH') and t.unread_count > 0),
        'SPAM', (select count(*) from t where t.folder = 'SPAM' and t.unread_count > 0),
        'TRASH', (select count(*) from t where t.folder = 'TRASH')),
      'labels', coalesce((select jsonb_agg(jsonb_build_object('id', tg.id, 'name', tg.name, 'color', tg.color,
          'unread', (select count(*) from t join public.support_conversation_tags ct on ct.conversation_id = t.id
                     where ct.tag_id = tg.id and t.unread_count > 0 and t.folder not in ('SPAM', 'TRASH'))) order by lower(tg.name))
        from public.support_tags tg where tg.company_id = v_company), '[]'::jsonb)
  ));
end;
$$;
revoke all on function public.support_email_mailbox(jsonb) from public, anon;
grant execute on function public.support_email_mailbox(jsonb) to authenticated;
