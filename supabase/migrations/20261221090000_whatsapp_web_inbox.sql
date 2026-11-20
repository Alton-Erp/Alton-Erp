-- =============================================================================
-- WhatsApp Web-style support screen (read side + personal list preferences).
--
-- Additive only. Nothing here changes how WhatsApp messages are received
-- (whatsapp-webhook / support_whatsapp_ingest / private.support_whatsapp_process),
-- sent (whatsapp-send-message / whatsapp-send-template / support_whatsapp_send_prepare
-- / _send_result) or how delivery statuses are applied
-- (private.support_whatsapp_apply_status). No existing row is updated.
--
--   support_conversation_prefs           pinned / muted / favourite, per user and conversation
--                                        (no app grants: read and written only through the functions)
--   public.support_whatsapp_inbox         WhatsApp conversation list with the views of support_inbox
--                                        plus UNREAD and FAVORITES, pinned first, the last WhatsApp
--                                        message's direction / status for the list ticks
--   public.support_conversation_pref_set  set your own pin / mute / favourite on a conversation
--   public.support_whatsapp_message_info  one message's delivery receipts exactly as Meta reported them
--                                        (support_whatsapp_statuses; never inferred)
--
-- "Muted" only changes how the conversation is shown in the list; ERP notifications
-- are not suppressed (they are created by the unified-support trigger, unchanged).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Personal conversation preferences
-- -----------------------------------------------------------------------------
create table if not exists public.support_conversation_prefs (
  company_id       uuid not null references public.companies (id) on delete restrict,
  conversation_id  uuid not null,
  user_id          uuid not null,
  pinned_at        timestamptz,
  muted            boolean not null default false,
  favorite         boolean not null default false,
  updated_at       timestamptz not null default now(),
  constraint support_conversation_prefs_pkey primary key (conversation_id, user_id),
  constraint support_conversation_prefs_conversation_fk foreign key (conversation_id, company_id)
    references public.support_conversations (id, company_id) on delete cascade
);
create index if not exists support_conversation_prefs_user_idx on public.support_conversation_prefs (company_id, user_id);

alter table public.support_conversation_prefs enable row level security;
revoke all on table public.support_conversation_prefs from anon, authenticated;
grant all on table public.support_conversation_prefs to service_role;

-- -----------------------------------------------------------------------------
-- 2. WhatsApp conversation list
-- -----------------------------------------------------------------------------
create or replace function public.support_whatsapp_inbox(p_view text default 'ALL', p_search text default null, p_limit integer default 30, p_offset integer default 0)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.view');
  v_view text := upper(coalesce(p_view, 'ALL'));
  v_term text := nullif(btrim(coalesce(p_search, '')), '');
  v_ph text := private.support_normalize_phone(p_search);
  v_uid uuid := auth.uid();
  v_me uuid := (select id from public.support_agents where company_id = v_company and user_id = auth.uid());
begin
  if v_view not in ('ALL', 'UNREAD', 'FAVORITES', 'MINE', 'UNASSIGNED', 'OPEN', 'PENDING', 'RESOLVED') then
    raise exception 'Unknown WhatsApp inbox view %.', p_view using errcode = 'P0001';
  end if;
  return (
    with b as (
      select s.*, p.pinned_at, coalesce(p.muted, false) as muted, coalesce(p.favorite, false) as favorite
      from public.support_conversations s
      left join public.support_conversation_prefs p on p.conversation_id = s.id and p.user_id = v_uid
      where s.company_id = v_company and s.channel = 'WHATSAPP'
    ), f as (
      select b.* from b
      left join public.support_customers c on c.id = b.customer_id
      where case v_view
              when 'UNREAD' then b.unread_count > 0
              when 'FAVORITES' then b.favorite
              when 'MINE' then v_me is not null and b.assigned_agent_id = v_me
              when 'UNASSIGNED' then b.assigned_agent_id is null and b.status <> 'RESOLVED'
              when 'OPEN' then b.status = 'OPEN' when 'PENDING' then b.status = 'PENDING' when 'RESOLVED' then b.status = 'RESOLVED'
              else true end
        and (v_term is null
             or b.subject ilike '%' || v_term || '%' or b.contact_name ilike '%' || v_term || '%' or b.contact_email ilike '%' || v_term || '%'
             or c.display_name ilike '%' || v_term || '%' or c.customer_code ilike '%' || v_term || '%'
             or (v_ph is not null and (b.normalized_phone like '%' || v_ph || '%' or exists (select 1 from unnest(c.normalized_phones) n where n like '%' || v_ph || '%')))
             or exists (select 1 from public.support_tickets t where t.id = b.ticket_id and t.ticket_number ilike '%' || v_term || '%')
             or exists (select 1 from public.support_messages m where m.conversation_id = b.id and (m.body ilike '%' || v_term || '%' or m.email_subject ilike '%' || v_term || '%')))
    ), page as (
      select f.*, row_number() over (order by (f.pinned_at is not null) desc, f.pinned_at desc, f.last_activity_at desc, f.id) as rn
      from f
      order by rn
      limit least(greatest(coalesce(p_limit, 30), 1), 200) offset greatest(coalesce(p_offset, 0), 0)
    )
    select jsonb_build_object(
      'total', (select count(*) from f),
      'me', v_me,
      'rows', coalesce((select jsonb_agg(jsonb_build_object('id', g.id, 'channel', g.channel, 'subject', g.subject, 'status', g.status, 'priority', g.priority,
          'customer_id', g.customer_id,
          'customer_name', coalesce(c.display_name, g.contact_name, g.contact_phone, g.contact_email),
          'phone', coalesce(g.contact_phone, c.phones[1]), 'email', coalesce(g.contact_email, c.emails[1]),
          'last_message_preview', g.last_message_preview, 'last_activity_at', g.last_activity_at, 'unread_count', g.unread_count,
          'assigned_agent_id', g.assigned_agent_id, 'assigned_agent', a.display_name,
          'ticket_id', g.ticket_id, 'ticket_number', t.ticket_number,
          'tags', coalesce((select jsonb_agg(jsonb_build_object('id', tg.id, 'name', tg.name, 'color', tg.color) order by tg.name)
                            from public.support_conversation_tags ct join public.support_tags tg on tg.id = ct.tag_id where ct.conversation_id = g.id), '[]'::jsonb),
          'pinned', g.pinned_at is not null, 'muted', g.muted, 'favorite', g.favorite,
          'profile_name', th.profile_name, 'wa_id', th.wa_id,
          'window_open', th.last_inbound_at is not null and th.last_inbound_at > now() - interval '24 hours',
          'last_message', (select jsonb_build_object('direction', w.direction, 'status', w.status, 'type', w.msg_type)
                           from public.support_whatsapp_messages w where w.conversation_id = g.id
                           order by coalesce(w.wa_timestamp, w.created_at) desc, w.created_at desc limit 1))
        order by g.rn)
        from page g
        left join public.support_customers c on c.id = g.customer_id
        left join public.support_agents a on a.id = g.assigned_agent_id
        left join public.support_tickets t on t.id = g.ticket_id
        left join public.support_whatsapp_threads th on th.conversation_id = g.id), '[]'::jsonb),
      'counts', jsonb_build_object(
        'ALL', (select count(*) from b),
        'UNREAD', (select count(*) from b where unread_count > 0),
        'FAVORITES', (select count(*) from b where favorite),
        'MINE', (select count(*) from b where v_me is not null and assigned_agent_id = v_me),
        'UNASSIGNED', (select count(*) from b where assigned_agent_id is null and status <> 'RESOLVED'),
        'OPEN', (select count(*) from b where status = 'OPEN'),
        'PENDING', (select count(*) from b where status = 'PENDING'))
  ));
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. Pin / mute / favourite (the caller's own row only)
-- -----------------------------------------------------------------------------
create or replace function public.support_conversation_pref_set(p_conversation uuid, p_pinned boolean default null, p_muted boolean default null,
  p_favorite boolean default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.view');
  v_uid uuid := auth.uid();
  r public.support_conversation_prefs;
begin
  if v_uid is null then
    raise exception 'Sign in first.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.support_conversations where id = p_conversation and company_id = v_company) then
    raise exception 'Conversation not found.' using errcode = 'P0002';
  end if;
  -- Like WhatsApp: at most three pinned conversations per person.
  if p_pinned and (select count(*) from public.support_conversation_prefs
                   where company_id = v_company and user_id = v_uid and pinned_at is not null and conversation_id <> p_conversation) >= 3 then
    raise exception 'You can pin up to 3 conversations. Unpin one first.' using errcode = 'P0001';
  end if;
  insert into public.support_conversation_prefs as t (company_id, conversation_id, user_id, pinned_at, muted, favorite)
  values (v_company, p_conversation, v_uid, case when p_pinned then now() end, coalesce(p_muted, false), coalesce(p_favorite, false))
  on conflict (conversation_id, user_id) do update set
    pinned_at = case when p_pinned is null then t.pinned_at when p_pinned then coalesce(t.pinned_at, now()) end,
    muted = coalesce(p_muted, t.muted),
    favorite = coalesce(p_favorite, t.favorite),
    updated_at = now()
  returning * into r;
  return jsonb_build_object('pinned', r.pinned_at is not null, 'muted', r.muted, 'favorite', r.favorite);
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. Message info: the receipts Meta reported (sent / delivered / read / failed)
-- -----------------------------------------------------------------------------
create or replace function public.support_whatsapp_message_info(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.view');
  m public.support_whatsapp_messages;
begin
  select * into m from public.support_whatsapp_messages where id = p_id and company_id = v_company;
  if not found then
    return null;
  end if;
  return jsonb_build_object(
    'id', m.id, 'direction', m.direction, 'status', m.status, 'status_at', m.status_at, 'type', m.msg_type,
    'at', coalesce(m.wa_timestamp, m.created_at), 'created_at', m.created_at, 'accepted_by_meta', m.wa_message_id is not null,
    'template_name', m.template_name, 'error_code', m.error_code, 'error_title', m.error_title, 'error_detail', m.error_detail,
    'receipts', coalesce((select jsonb_agg(jsonb_build_object('status', s.status, 'at', s.status_at, 'error_code', s.error_code,
                            'error_title', s.error_title, 'error_detail', s.error_detail) order by s.status_at nulls last, s.created_at)
                          from public.support_whatsapp_statuses s
                          where m.direction = 'OUTBOUND' and m.wa_message_id is not null and s.company_id = v_company and s.wa_message_id = m.wa_message_id),
                         '[]'::jsonb));
end;
$$;

do $$
declare
  f text;
begin
  for f in select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in ('support_whatsapp_inbox', 'support_conversation_pref_set', 'support_whatsapp_message_info') loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. ERP reset allowlist (20261218090000 plus support_conversation_prefs)
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
