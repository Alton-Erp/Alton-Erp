-- Rollback of 20261212090000_gmail_support.sql: removes the Gmail tables, functions and attachment columns, the
-- Gmail event-log rows and event types, and restores support_message_add of 20261210090000 and the ERP reset
-- allowlist of 20261211090000. Email messages already on conversation timelines (support_messages) and files in
-- the support-attachments bucket stay. The encrypted refresh token is deleted with its table: revoke the app's
-- access in the Google Admin console as well.

drop function if exists public.support_email_config_get();
drop function if exists public.support_email_config_save(jsonb);
drop function if exists public.support_email_admin_check();
drop function if exists public.support_email_template_save(uuid, jsonb);
drop function if exists public.support_email_compose_context();
drop function if exists public.support_email_templates_list();
drop function if exists public.support_gmail_oauth_begin(text);
drop function if exists public.support_gmail_oauth_consume(text);
drop function if exists public.support_gmail_oauth_failed(uuid, text);
drop function if exists public.support_gmail_connect(uuid, uuid, text, text, text, integer, text[], text);
drop function if exists public.support_gmail_credentials(uuid);
drop function if exists public.support_gmail_runtime(uuid);
drop function if exists public.support_gmail_accounts();
drop function if exists public.support_gmail_disconnected(uuid, text, boolean, uuid);
drop function if exists public.support_gmail_reauth_required(uuid, text);
drop function if exists public.support_gmail_sync_state(uuid, text, boolean, text, text, jsonb);
drop function if exists public.support_gmail_watch_state(uuid, boolean, text, text, boolean);
drop function if exists public.support_gmail_push(text, text, text, jsonb);
drop function if exists public.support_gmail_event_done(uuid, text, text);
drop function if exists public.support_gmail_replay(uuid);
drop function if exists public.support_gmail_known(uuid, text[]);
drop function if exists public.support_gmail_ingest(uuid, jsonb);
drop function if exists public.support_gmail_attachment_result(uuid, text, boolean, text, text, text, bigint, text);
drop function if exists public.support_gmail_send_prepare(jsonb);
drop function if exists public.support_gmail_send_result(uuid, text, text, text, text, integer);
drop function if exists public.support_gmail_mark_read_targets(uuid);
drop function if exists public.support_gmail_marked_read(uuid, text[]);
drop function if exists public.support_email_thread(uuid);
drop function if exists public.support_email_html(uuid);
drop function if exists private.support_gmail_scopes(boolean);
drop function if exists private.support_email_list(jsonb, text);
drop function if exists private.support_email_base_subject(text);
drop function if exists private.support_email_references(text, text);
drop function if exists private.support_gmail_event(uuid, uuid, text, text, jsonb, text, text, text, uuid);
drop function if exists private.support_gmail_health(uuid, text, text);

drop table if exists public.support_email_messages;
drop table if exists public.support_email_templates;
drop table if exists public.support_email_credentials;
drop table if exists public.support_oauth_states;
drop table if exists public.support_email_config;

alter table public.support_attachments drop column if exists email_part_id;
alter table public.support_attachments drop column if exists email_content_id;
alter table public.support_attachments drop column if exists email_inline;

delete from public.support_integration_events where event_type in ('OAUTH', 'MAIL_SYNC', 'WATCH', 'SEND')
  or event_key like 'gmail-push:%' or (event_type = 'REPLAY' and details ? 'history_id');
-- Without the connector the Gmail account can no longer be connected.
update public.support_channel_accounts set status = 'NOT_CONNECTED', status_detail = 'Gmail integration removed.', connected_at = null
where channel = 'EMAIL' and provider = 'Google Workspace (Gmail API)' and status <> 'NOT_CONNECTED';
alter table public.support_integration_events drop constraint if exists support_integration_events_event_type_check;
alter table public.support_integration_events add constraint support_integration_events_event_type_check
  check (event_type in ('ACCOUNT_CREATED', 'ACCOUNT_UPDATED', 'HEALTH_CHECK', 'WEBHOOK', 'DELIVERY', 'ERROR', 'CLICK_TO_CALL', 'CDR_SYNC', 'RECORDING_SYNC', 'REPLAY', 'DISCONNECTED', 'REJECTED'));

-- support_message_add as defined by 20261210090000_support_centre.

create or replace function public.support_message_add(p_conversation uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.reply');
  s public.support_conversations;
  v_mode text := upper(coalesce(p ->> 'mode', ''));
  v_body text := private.support_text(p, 'body', 20000);
  v_direction text := upper(coalesce(p ->> 'direction', 'OUTBOUND'));
  v_call text := upper(nullif(p ->> 'call_status', ''));
  v_at timestamptz := coalesce(nullif(p ->> 'occurred_at', '')::timestamptz, now());
  v_kind text;
  v_health text;
  v_id uuid;
begin
  select * into s from public.support_conversations where id = p_conversation and company_id = v_company for update;
  if not found then
    raise exception 'Conversation not found in your company.' using errcode = 'P0001';
  end if;
  v_kind := case s.channel when 'PHONE' then 'CALL' when 'EMAIL' then 'EMAIL' else 'MESSAGE' end;
  if v_at > now() + interval '5 minutes' then
    raise exception 'The time cannot be in the future.' using errcode = 'P0001';
  end if;
  if v_mode = 'REPLY' then
    if v_kind = 'CALL' then
      raise exception 'Calls cannot be sent as a reply; log the call instead.' using errcode = 'P0001';
    end if;
    v_health := private.support_channel_health(v_company, s.channel);
    if v_health <> 'CONNECTED' then
      raise exception 'Cannot reply through % : the channel is %. Log the reply instead if it was sent elsewhere.',
        initcap(lower(s.channel)), replace(lower(v_health), '_', ' ') using errcode = 'P0001';
    end if;
    if v_body is null then
      raise exception 'Enter the reply.' using errcode = 'P0001';
    end if;
    insert into public.support_messages (company_id, conversation_id, kind, direction, source, body, email_subject, delivery_status, author_user_id, occurred_at)
    values (v_company, s.id, v_kind, 'OUTBOUND', 'CHANNEL', v_body, case when v_kind = 'EMAIL' then coalesce(private.support_text(p, 'email_subject', 300), 'Re: ' || coalesce(s.subject, '')) end,
            'QUEUED', auth.uid(), now())
    returning id into v_id;
    v_direction := 'OUTBOUND';
  elsif v_mode = 'LOG' then
    if v_direction not in ('INBOUND', 'OUTBOUND') then
      raise exception 'Direction must be inbound or outbound.' using errcode = 'P0001';
    end if;
    if v_kind = 'CALL' and coalesce(v_call, '') not in ('ANSWERED', 'MISSED', 'VOICEMAIL', 'FAILED') then
      raise exception 'Choose the call result: answered, missed, voicemail or failed.' using errcode = 'P0001';
    end if;
    if v_kind <> 'CALL' and v_body is null then
      raise exception 'Enter the message.' using errcode = 'P0001';
    end if;
    insert into public.support_messages (company_id, conversation_id, kind, direction, source, body, email_subject, call_status, call_duration_seconds, author_user_id, occurred_at)
    values (v_company, s.id, v_kind, v_direction, 'MANUAL', v_body, case when v_kind = 'EMAIL' then private.support_text(p, 'email_subject', 300) end,
            case when v_kind = 'CALL' then v_call end, case when v_kind = 'CALL' then nullif(p ->> 'call_duration_seconds', '')::integer end, auth.uid(), v_at)
    returning id into v_id;
  else
    raise exception 'Unknown message mode %.', p ->> 'mode' using errcode = 'P0001';
  end if;
  perform private.support_touch_conversation(s.id, coalesce(v_body, initcap(lower(coalesce(v_call, ''))) || ' call'), v_at, 0);
  if v_direction = 'OUTBOUND' then
    perform private.support_mark_first_response(s.id, v_at);
    update public.support_conversations set unread_count = 0, status = case when status = 'RESOLVED' then status else 'PENDING' end where id = s.id;
  else
    update public.support_conversations set status = 'OPEN' where id = s.id;
  end if;
  return jsonb_build_object('id', v_id, 'delivery_status', (select delivery_status from public.support_messages where id = v_id));
end;
$$;


-- ERP reset allowlist as defined by 20261211090000_acefone_telephony.

create or replace function private.erp_reset_tables()
returns table (ord int, table_name text, category text, label text)
language sql
stable
set search_path = ''
as $$
  select * from (values
    (-2, 'support_call_events', 'Support Centre', 'Call status history'),
    (-1, 'support_calls', 'Support Centre', 'Phone calls'),
    (3, 'support_phone_agents', 'Support Centre', 'Phone agent lines'),
    (3, 'support_phone_config', 'Support Centre', 'Phone settings'),
    (0, 'support_attachments', 'Support Centre', 'Support attachments'),
    (0, 'support_audit_logs', 'Support Centre', 'Support activity log'),
    (0, 'support_automation_rules', 'Support Centre', 'Support automation rules'),
    (0, 'support_conversation_tags', 'Support Centre', 'Support conversation tags'),
    (0, 'support_integration_events', 'Support Centre', 'Support integration events'),
    (0, 'support_internal_notes', 'Support Centre', 'Support internal notes'),
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
