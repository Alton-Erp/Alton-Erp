-- =============================================================================
-- Email workspace (Gmail-style mailbox) for the Support Centre email channel.
--
-- Additive only. Receiving (google-gmail-sync / support_gmail_ingest), sending
-- (google-gmail-send / support_gmail_send_prepare / _send_result) and the stored
-- emails are unchanged; no existing row is updated by this migration.
--
-- Mailbox state is kept in the ERP, for the shared support mailbox:
--   support_email_thread_state   per email conversation: starred, important, snoozed until,
--                                folder INBOX / ARCHIVE / SPAM / TRASH. Moving an email to
--                                Spam or Trash never deletes it (history is kept) and is not
--                                applied to the Gmail mailbox (the ERP only has read + send access).
-- Custom labels are the existing support tags (support_conversation_tags).
-- Drafts are the existing form drafts (erp_form_drafts, form key support.email): private to their author.
--
--   public.support_email_mailbox(p)              threads of a folder / label / search, counts, labels
--   public.support_email_mailbox_action(ids, a, p)  star, important, snooze, archive, spam, trash,
--                                                read / unread, labels (support.reply)
--
-- Threads in Archive or Snoozed return to the Inbox when the customer writes again
-- (computed when reading; nothing is moved in the background).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Mailbox state per email conversation
-- -----------------------------------------------------------------------------
create table if not exists public.support_email_thread_state (
  company_id       uuid not null references public.companies (id) on delete restrict,
  conversation_id  uuid primary key,
  starred          boolean not null default false,
  important        boolean not null default false,
  snoozed_until    timestamptz,
  snoozed_at       timestamptz,
  folder           text not null default 'INBOX' check (folder in ('INBOX', 'ARCHIVE', 'SPAM', 'TRASH')),
  folder_at        timestamptz not null default now(),
  updated_by       uuid,
  updated_at       timestamptz not null default now(),
  constraint support_email_thread_state_conversation_fk foreign key (conversation_id, company_id)
    references public.support_conversations (id, company_id) on delete cascade
);
create index if not exists support_email_thread_state_company_idx on public.support_email_thread_state (company_id, folder);

alter table public.support_email_thread_state enable row level security;
revoke all on table public.support_email_thread_state from anon, authenticated;
grant all on table public.support_email_thread_state to service_role;

-- -----------------------------------------------------------------------------
-- 2. Threads of a folder, label or search
-- -----------------------------------------------------------------------------
-- p: folder INBOX | STARRED | SNOOZED | SENT | IMPORTANT | ALL | SPAM | TRASH | LABEL, label (tag id),
--    q (any field), from, to, subject, words (message text), after / before (dates, inclusive),
--    has_attachment (bool), unread (bool), limit (1-100), offset.
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
             a.last_at, a.last_in, a.has_in, a.has_out, a.n,
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
               max(m.created_at) filter (where m.direction = 'INBOUND') as in_stored,
               bool_or(m.direction = 'INBOUND') as has_in, bool_or(m.direction = 'OUTBOUND') as has_out, count(*) as n
        from public.support_email_messages m where m.conversation_id = s.id and m.duplicate_of is null
      ) a on a.n > 0
      left join public.support_email_thread_state st on st.conversation_id = s.id
      where s.company_id = v_company and s.channel = 'EMAIL'
    ), f as (
      select t.* from t
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
      select f.*, row_number() over (order by f.last_at desc, f.id) as rn from f
      order by rn limit v_limit offset v_offset
    )
    select jsonb_build_object(
      'total', (select count(*) from f),
      'rows', coalesce((select jsonb_agg(jsonb_build_object(
          'id', g.id, 'last_at', g.last_at, 'message_count', g.n, 'unread_count', g.unread_count,
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

-- -----------------------------------------------------------------------------
-- 3. Mailbox actions on several threads at once
-- -----------------------------------------------------------------------------
create or replace function public.support_email_mailbox_action(p_ids uuid[], p_action text, p jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.reply');
  v_action text := upper(coalesce(p_action, ''));
  v_ids uuid[] := (select coalesce(array_agg(distinct x), '{}') from unnest(coalesce(p_ids, '{}')) x where x is not null);
  v_until timestamptz;
  v_label uuid;
  v_id uuid;
begin
  if v_action not in ('STAR', 'UNSTAR', 'IMPORTANT', 'NOT_IMPORTANT', 'SNOOZE', 'UNSNOOZE', 'ARCHIVE', 'INBOX', 'SPAM', 'TRASH',
                      'MARK_READ', 'MARK_UNREAD', 'LABEL_ADD', 'LABEL_REMOVE') then
    raise exception 'Unknown mailbox action %.', p_action using errcode = 'P0001';
  end if;
  if cardinality(v_ids) = 0 then
    raise exception 'Select at least one email.' using errcode = 'P0001';
  end if;
  if cardinality(v_ids) > 200 then
    raise exception 'At most 200 emails at a time.' using errcode = 'P0001';
  end if;
  if exists (select 1 from unnest(v_ids) x where not exists (
               select 1 from public.support_conversations s where s.id = x and s.company_id = v_company and s.channel = 'EMAIL')) then
    raise exception 'Email conversation not found in your company.' using errcode = 'P0001';
  end if;
  if v_action = 'SNOOZE' then
    begin
      v_until := (p ->> 'until')::timestamptz;
    exception when others then
      v_until := null;
    end;
    if v_until is null or v_until <= now() or v_until > now() + interval '1 year' then
      raise exception 'Choose a snooze time in the future (at most one year ahead).' using errcode = 'P0001';
    end if;
  end if;
  if v_action in ('LABEL_ADD', 'LABEL_REMOVE') then
    begin
      v_label := (p ->> 'label')::uuid;
    exception when others then
      v_label := null;
    end;
    if v_label is null or not exists (select 1 from public.support_tags where id = v_label and company_id = v_company) then
      raise exception 'Label not found in your company.' using errcode = 'P0001';
    end if;
  end if;

  if v_action in ('MARK_READ', 'MARK_UNREAD') then
    -- The same unread counter the unified inbox uses; Gmail's own UNREAD label is not changed here.
    update public.support_conversations set unread_count = case when v_action = 'MARK_READ' then 0 else greatest(unread_count, 1) end
    where id = any (v_ids) and company_id = v_company;
  elsif v_action = 'LABEL_ADD' then
    insert into public.support_conversation_tags (company_id, conversation_id, tag_id, created_by)
    select v_company, x, v_label, auth.uid() from unnest(v_ids) x on conflict do nothing;
  elsif v_action = 'LABEL_REMOVE' then
    delete from public.support_conversation_tags where conversation_id = any (v_ids) and tag_id = v_label;
  else
    insert into public.support_email_thread_state as st (company_id, conversation_id, updated_by)
    select v_company, x, auth.uid() from unnest(v_ids) x
    on conflict (conversation_id) do nothing;
    update public.support_email_thread_state st set
      starred = case v_action when 'STAR' then true when 'UNSTAR' then false else st.starred end,
      important = case v_action when 'IMPORTANT' then true when 'NOT_IMPORTANT' then false else st.important end,
      snoozed_until = case v_action when 'SNOOZE' then v_until when 'UNSNOOZE' then null
                                    when 'ARCHIVE' then null when 'SPAM' then null when 'TRASH' then null else st.snoozed_until end,
      snoozed_at = case v_action when 'SNOOZE' then now() when 'UNSNOOZE' then null else st.snoozed_at end,
      folder = case v_action when 'ARCHIVE' then 'ARCHIVE' when 'INBOX' then 'INBOX' when 'SPAM' then 'SPAM' when 'TRASH' then 'TRASH' else st.folder end,
      folder_at = case when v_action in ('ARCHIVE', 'INBOX', 'SPAM', 'TRASH') then now() else st.folder_at end,
      updated_by = auth.uid(), updated_at = now()
    where st.conversation_id = any (v_ids) and st.company_id = v_company;
  end if;
  foreach v_id in array v_ids loop
    perform private.support_audit(v_company, 'email.mailbox_' || lower(v_action), 'conversations', v_id::text,
      jsonb_strip_nulls(jsonb_build_object('until', v_until, 'label', v_label)));
  end loop;
  return jsonb_build_object('updated', cardinality(v_ids), 'action', v_action);
end;
$$;

do $$
declare
  f text;
begin
  for f in select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in ('support_email_mailbox', 'support_email_mailbox_action') loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. Email drafts use the existing form drafts (20261117090000 registry plus support.email)
-- -----------------------------------------------------------------------------
create or replace function private.erp_form_draft_registry()
returns table (form_key text, module text, feature text, permissions text[])
language sql
immutable
set search_path = ''
as $$
  select * from (values
    ('product.form',        'Product Master',      'Add / edit product',        array['products.create', 'products.update']),
    ('bom.editor',          'Production',          'Bill of materials',         array['production_bom.create', 'production_bom.update']),
    ('production.order',    'Production',          'Production order',          array['production_order.create', 'production_order.update']),
    ('purchase.order',      'Purchase',            'Supplier purchase order',   array['purchase_order.create', 'purchase_order.update']),
    ('purchase.receipt',    'Purchase',            'Goods receipt (GRN)',       array['purchase_receipt.create']),
    ('sales.order',         'Sales',               'Sales order',               array['sales_orders.create', 'sales_orders.update']),
    ('billing.invoice',     'Finance & GST',       'Sales invoice',             array['invoices.create']),
    ('billing.payment',     'Finance & GST',       'Customer payment',          array['payments.manage']),
    ('ledger.party',        'Ledger',              'Customer / supplier',       array['customers.manage', 'suppliers.manage']),
    ('inventory.opening',   'Inventory',           'Opening stock',             array['inventory_opening.create']),
    ('users.invite',        'Users & Roles',       'Invite user',               array['users.manage']),
    ('support.email',       'Support Centre',      'Email draft',               array['support.reply'])
  ) t (form_key, module, feature, permissions);
$$;

revoke all on function private.erp_form_draft_registry() from public, anon;

-- -----------------------------------------------------------------------------
-- 5. ERP reset allowlist (20261221090000 plus support_email_thread_state)
-- -----------------------------------------------------------------------------
create or replace function private.erp_reset_tables()
returns table (ord int, table_name text, category text, label text)
language sql
stable
set search_path = ''
as $$
  select * from (values
    (-3, 'support_call_signals', 'Support Centre', 'Realtime call signals'),
    (-2, 'support_call_events', 'Support Centre', 'Call status history'),
    (2, 'support_ticket_escalations', 'Support Centre', 'SLA warnings, breaches and escalations'),
    (3, 'support_ticket_rules', 'Support Centre', 'Ticket automation rules'),
    (3, 'support_business_calendar', 'Support Centre', 'Business hours'),
    (3, 'support_holidays', 'Support Centre', 'Holidays'),
    (3, 'support_sla_escalation_levels', 'Support Centre', 'SLA escalation levels'),
    (3, 'support_assignment_rules', 'Support Centre', 'Ticket assignment rules'),
    (0, 'support_whatsapp_messages', 'Support Centre', 'WhatsApp messages'),
    (0, 'support_whatsapp_statuses', 'Support Centre', 'WhatsApp delivery statuses'),
    (1, 'support_whatsapp_threads', 'Support Centre', 'WhatsApp contacts per conversation'),
    (3, 'support_whatsapp_templates', 'Support Centre', 'WhatsApp templates (from Meta)'),
    (3, 'support_whatsapp_webhook_events', 'Support Centre', 'WhatsApp webhook events'),
    (3, 'support_whatsapp_config', 'Support Centre', 'WhatsApp settings'),
    (0, 'support_email_messages', 'Support Centre', 'Email messages (Gmail)'),
    (1, 'support_email_templates', 'Support Centre', 'Email templates'),
    (3, 'support_email_config', 'Support Centre', 'Email settings'),
    (3, 'support_email_credentials', 'Support Centre', 'Email connection (encrypted)'),
    (3, 'support_oauth_states', 'Support Centre', 'Email authorisation requests'),
    (-1, 'support_calls', 'Support Centre', 'Phone calls'),
    (3, 'support_phone_agents', 'Support Centre', 'Phone agent lines'),
    (3, 'support_phone_config', 'Support Centre', 'Phone settings'),
    (0, 'support_attachments', 'Support Centre', 'Support attachments'),
    (0, 'support_audit_logs', 'Support Centre', 'Support activity log'),
    (0, 'support_automation_rules', 'Support Centre', 'Support automation rules'),
    (0, 'support_conversation_tags', 'Support Centre', 'Support conversation tags'),
    (0, 'support_conversation_prefs', 'Support Centre', 'Pinned / muted / favourite conversations'),
    (0, 'support_email_thread_state', 'Support Centre', 'Email starred / snoozed / folder state'),
    (0, 'support_integration_events', 'Support Centre', 'Support integration events'),
    (-3, 'support_internal_notes', 'Support Centre', 'Support internal notes'),
    (0, 'support_kb_articles', 'Support Centre', 'Knowledge base articles'),
    (0, 'support_ticket_events', 'Support Centre', 'Support ticket history'),
    (1, 'support_messages', 'Support Centre', 'Support messages and calls'),
    (1, 'support_tags', 'Support Centre', 'Support tags'),
    (2, 'support_conversations', 'Support Centre', 'Support conversations'),
    (3, 'support_tickets', 'Support Centre', 'Support tickets'),
    (4, 'support_agents', 'Support Centre', 'Support agents'),
    (4, 'support_channel_accounts', 'Support Centre', 'Support channel accounts'),
    (4, 'support_customers', 'Support Centre', 'Support customers'),
    (4, 'support_sla_policies', 'Support Centre', 'Support SLA policies'),
    (0, 'amazon_ad_change_requests', 'Amazon', 'Amazon ad change requests'),
    (0, 'amazon_ad_groups', 'Amazon', 'Amazon ad groups'),
    (0, 'amazon_ad_product_daily', 'Amazon', 'Amazon advertised-product daily data'),
    (0, 'amazon_budget_plans', 'Amazon', 'Amazon budget plans'),
    (0, 'amazon_campaign_daily', 'Amazon', 'Amazon campaign daily data'),
    (0, 'amazon_campaigns', 'Amazon', 'Amazon campaigns'),
    (0, 'amazon_inventory_snapshots', 'Amazon', 'Amazon inventory snapshots'),
    (0, 'amazon_listings', 'Amazon', 'Amazon listings'),
    (0, 'amazon_search_term_daily', 'Amazon', 'Amazon search-term daily data'),
    (0, 'amazon_sku_daily', 'Amazon', 'Amazon SKU daily sales'),
    (0, 'amazon_sync_errors', 'Amazon', 'Amazon sync errors'),
    (0, 'amazon_targets', 'Amazon', 'Amazon targets'),
    (0, 'approval_decisions', 'Approvals, notifications & imports', 'Approval decisions'),
    (0, 'billing_events', 'Billing & receivables', 'Billing history'),
    (0, 'bom_items', 'Production & BOMs', 'BOM components'),
    (0, 'bom_template_items', 'Production & BOMs', 'BOM template components'),
    (0, 'bom_cost_snapshots', 'Production & BOMs', 'BOM cost calculations'),
    (0, 'bom_change_batch_lines', 'Production & BOMs', 'Bulk BOM change lines'),
    (0, 'bom_change_approvals', 'Production & BOMs', 'Bulk BOM change approvals and history'),
    (0, 'customer_po_allocation_runs', 'Customer purchase orders', 'Customer PO allocation runs'),
    (0, 'customer_po_analysis_snapshots', 'Customer purchase orders', 'Customer PO analysis snapshots'),
    (0, 'customer_po_events', 'Customer purchase orders', 'Customer PO history'),
    (0, 'customer_po_shortage_notes', 'Customer purchase orders', 'Customer PO shortage notes'),
    (0, 'customer_product_codes', 'Customers & suppliers', 'Customer product codes'),
    (0, 'customer_return_lines', 'Sales & fulfilment', 'Customer return lines'),
    (0, 'delivery_events', 'Sales & fulfilment', 'Delivery history'),
    (0, 'erp_form_drafts', 'Approvals, notifications & imports', 'Unsaved form drafts'),
    (0, 'goods_receipt_lines', 'Supplier purchasing', 'Goods receipt lines'),
    (0, 'import_job_rows', 'Approvals, notifications & imports', 'Import rows'),
    (0, 'inventory_adjustments', 'Inventory', 'Stock adjustments'),
    (0, 'inventory_alerts', 'Inventory', 'Stock alerts'),
    (0, 'inventory_balances', 'Inventory', 'Stock balances'),
    (0, 'inventory_count_lines', 'Inventory', 'Stock count lines'),
    (0, 'inventory_opening_lines', 'Inventory', 'Opening stock lines'),
    (0, 'inventory_requests', 'Inventory', 'Stock operation requests'),
    (0, 'invoice_adjustment_note_lines', 'Billing & receivables', 'Credit / debit note lines'),
    (0, 'invoice_payment_allocations', 'Billing & receivables', 'Payment allocations'),
    (0, 'notifications', 'Approvals, notifications & imports', 'Notifications'),
    (0, 'outsourcing_material_movements', 'Outsourcing', 'Outsourcing material movements'),
    (0, 'outsourcing_order_events', 'Outsourcing', 'Outsourcing history'),
    (0, 'product_last_purchase_costs', 'Supplier purchasing', 'Last purchase costs'),
    (0, 'product_purchase_cost_events', 'Supplier purchasing', 'Purchase cost history'),
    (0, 'product_cost_history', 'Products & catalogue', 'Product cost history'),
    (0, 'product_cost_profiles', 'Products & catalogue', 'Product cost sources'),
    (0, 'production_material_consumption', 'Production & BOMs', 'Material issues'),
    (0, 'production_order_events', 'Production & BOMs', 'Production history'),
    (0, 'production_order_requests', 'Production & BOMs', 'Production order request ids'),
    (0, 'production_output_receipts', 'Production & BOMs', 'Production output'),
    (0, 'purchase_document_refs', 'Supplier purchasing', 'Supplier invoice / challan references'),
    (0, 'purchase_order_amendments', 'Supplier purchasing', 'Purchase order amendments'),
    (0, 'purchase_order_events', 'Supplier purchasing', 'Purchase order history'),
    (0, 'purchase_order_import_refs', 'Supplier purchasing', 'Purchase order import references'),
    (0, 'sales_invoice_dispatch_allocations', 'Billing & receivables', 'Invoice dispatch allocations'),
    (0, 'sales_order_events', 'Sales & fulfilment', 'Sales order history'),
    (1, 'amazon_recommendations', 'Amazon', 'Amazon recommendations'),
    (1, 'amazon_sync_jobs', 'Amazon', 'Amazon sync jobs'),
    (1, 'approval_requests', 'Approvals, notifications & imports', 'Approval requests'),
    (1, 'bom_templates', 'Production & BOMs', 'BOM templates'),
    (1, 'bom_change_batches', 'Production & BOMs', 'Bulk BOM change batches'),
    (1, 'customer_payments', 'Billing & receivables', 'Customer payments'),
    (1, 'supplier_payments', 'Customers & suppliers', 'Supplier payments'),
    (1, 'goods_receipts', 'Supplier purchasing', 'Goods receipts'),
    (1, 'import_jobs', 'Approvals, notifications & imports', 'Import jobs'),
    (1, 'inventory_counts', 'Inventory', 'Stock counts'),
    (1, 'inventory_opening_batches', 'Inventory', 'Opening stock documents'),
    (1, 'invoice_adjustment_notes', 'Billing & receivables', 'Credit / debit notes'),
    (1, 'outsourcing_order_materials', 'Outsourcing', 'Outsourcing material plans'),
    (1, 'outsourcing_receipts', 'Outsourcing', 'Outsourcing receipts'),
    (1, 'production_order_materials', 'Production & BOMs', 'Production material plans'),
    (1, 'purchase_order_lines', 'Supplier purchasing', 'Purchase order lines'),
    (1, 'sales_invoice_lines', 'Billing & receivables', 'Invoice lines'),
    (2, 'customer_returns', 'Sales & fulfilment', 'Customer returns'),
    (2, 'parties', 'Customers & suppliers', 'Ledger parties'),
    (2, 'fulfilment_lines', 'Sales & fulfilment', 'Fulfilment lines'),
    (2, 'outsourcing_orders', 'Outsourcing', 'Outsourcing orders'),
    (2, 'production_orders', 'Production & BOMs', 'Production orders'),
    (2, 'purchase_orders', 'Supplier purchasing', 'Supplier purchase orders'),
    (2, 'sales_invoices', 'Billing & receivables', 'Sales invoices'),
    (3, 'boms', 'Production & BOMs', 'Bills of materials'),
    (3, 'fulfilments', 'Sales & fulfilment', 'Fulfilments and dispatches'),
    (3, 'inventory_transactions', 'Inventory', 'Stock ledger'),
    (3, 'production_order_revisions', 'Production & BOMs', 'Production order revisions'),
    (3, 'sales_order_lines', 'Sales & fulfilment', 'Sales order lines'),
    (3, 'stock_reservations', 'Inventory', 'Stock reservations'),
    (3, 'suppliers', 'Customers & suppliers', 'Suppliers'),
    (4, 'customer_purchase_order_lines', 'Customer purchase orders', 'Customer PO lines'),
    (4, 'inventory_batches', 'Inventory', 'Stock batches / lots'),
    (4, 'sales_orders', 'Sales & fulfilment', 'Sales orders'),
    (5, 'customer_purchase_orders', 'Customer purchase orders', 'Customer purchase orders'),
    (6, 'customer_po_import_batches', 'Customer purchase orders', 'Customer PO import batches'),
    (6, 'customers', 'Customers & suppliers', 'Customers')
  ) t (ord, table_name, category, label)
  union all
  select 0, 'demo_presentation_data', 'Demo data', 'Demo presentation data'
  where exists (select 1 from pg_catalog.pg_attribute a
                where a.attrelid = to_regclass('public.demo_presentation_data') and a.attname = 'company_id' and not a.attisdropped);
$$;

revoke all on function private.erp_reset_tables() from public, anon, authenticated;
