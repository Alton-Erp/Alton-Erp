-- Rollback of 20261227090000_support_pipelines.
--
-- Drops the pipelines, stages and the stage history, and the pipeline_id / stage_id columns of support_tickets.
-- Ticket statuses, history events, SLA and everything else stay as they are (STAGE_CHANGED events are kept;
-- the event type check is restored NOT VALID so they remain). Refused while stage history from real moves
-- exists unless   set app.support_pipelines_rollback_force = 'on';   is run in the same session.

do $$
begin
  if coalesce(current_setting('app.support_pipelines_rollback_force', true), '') <> 'on'
     and to_regclass('public.support_ticket_stage_history') is not null
     and exists (select 1 from public.support_ticket_stage_history where source <> 'MIGRATION' and source <> 'CREATED') then
    raise exception 'Tickets have been moved between pipeline stages. Export the stage history, then set app.support_pipelines_rollback_force = on to roll back.';
  end if;
end;
$$;

drop trigger if exists support_tickets_stage_before on public.support_tickets;
drop trigger if exists support_tickets_stage_after on public.support_tickets;
drop trigger if exists companies_support_pipeline on public.companies;

drop function if exists public.support_pipeline_report(uuid, date, date);
drop function if exists public.support_ticket_stage_info(uuid);
drop function if exists public.support_pipeline_board(jsonb);
drop function if exists public.support_pipeline_save_stages(uuid, jsonb, jsonb, text);
drop function if exists public.support_pipeline_save(uuid, jsonb);
drop function if exists public.support_pipelines_list();
drop function if exists public.support_ticket_move_stage(uuid, uuid, uuid, text);
drop function if exists private.support_ticket_move(uuid, uuid, text, text);
drop function if exists private.support_stage_json(public.support_pipeline_stages);
drop function if exists private.support_stages_stamp(uuid);

alter table public.support_tickets drop constraint if exists support_tickets_stage_fk;
alter table public.support_tickets drop constraint if exists support_tickets_pipeline_fk;
drop index if exists public.support_tickets_pipeline_stage_idx;
drop index if exists public.support_tickets_stage_idx;
alter table public.support_tickets drop column if exists stage_id;
alter table public.support_tickets drop column if exists pipeline_id;

drop table if exists public.support_ticket_stage_history;
drop table if exists public.support_pipeline_stages;
drop table if exists public.support_pipelines;

drop function if exists private.support_ticket_stage_before();
drop function if exists private.support_ticket_stage_after();
drop function if exists private.support_stage_for_status(uuid, text, uuid);
drop function if exists private.support_pipeline_company_defaults();
drop function if exists private.support_pipeline_ensure(uuid);
drop function if exists private.support_pipeline_add_stages(uuid, uuid);
drop function if exists private.support_pipeline_default_stages();
drop function if exists private.support_stage_history_immutable();

alter table public.support_ticket_events drop constraint if exists support_ticket_events_event_type_check;
alter table public.support_ticket_events add constraint support_ticket_events_event_type_check
  check (event_type in ('CREATED', 'STATUS_CHANGED', 'PRIORITY_CHANGED', 'ASSIGNED', 'UPDATED', 'MERGED', 'MERGED_INTO',
                        'REOPENED', 'NOTE_ADDED', 'ATTACHMENT_ADDED', 'CONVERSATION_LINKED', 'FIRST_RESPONSE', 'AUTOMATION', 'CSAT_RECORDED',
                        'SLA_WARNING', 'SLA_BREACHED', 'ESCALATED')) not valid;

delete from public.role_permissions where permission_id in (select id from public.permissions where resource = 'support_pipelines' or code = 'support_tickets.move_stage');
delete from public.permissions where resource = 'support_pipelines' or code = 'support_tickets.move_stage';

-- support_ticket_create_v2 of 20261226090000.
-- Create a ticket with its custom field values and products in one transaction (the existing
-- support_ticket_create does the ticket itself: number, SLA, automation, notifications).
create or replace function public.support_ticket_create_v2(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.manage_tickets');
  r jsonb;
  s record;
  v_products jsonb := p -> 'products';
  v_has_products boolean := jsonb_typeof(p -> 'products') = 'array' and jsonb_array_length(p -> 'products') > 0;
  v_missing text[] := '{}';
  v_values text[];
begin
  -- Standard fields the administrator made required on the form.
  for s in select f.standard_key, f.label from private.support_ticket_layout(v_company) l join private.support_ticket_standard_fields() f on f.standard_key = l.standard_key
           where l.is_visible and f.required_editable and l.is_required_override loop
    if (s.standard_key = 'products' and not v_has_products)
       or (s.standard_key = 'assigned_agent' and nullif(p ->> 'assigned_agent_id', '') is null)
       or (s.standard_key in ('category', 'subcategory', 'department', 'description') and nullif(btrim(coalesce(p ->> s.standard_key, '')), '') is null) then
      v_missing := v_missing || s.label;
    end if;
  end loop;
  if cardinality(v_missing) > 0 then
    raise exception 'Fill in the required fields: %.', array_to_string(v_missing, ', ') using errcode = 'P0001';
  end if;
  if v_has_products and not (private.has_permission(v_company, 'support_ticket_products.manage') and private.has_permission(v_company, 'products.read')) then
    raise exception 'You are not allowed to add products to tickets (requires support_ticket_products.manage and products.read).' using errcode = '42501';
  end if;
  r := public.support_ticket_create(p - 'custom_fields' - 'products' - 'allow_archived_products');
  v_values := private.support_ticket_values_apply(v_company, (r ->> 'id')::uuid, coalesce(p -> 'custom_fields', '{}'::jsonb), true);
  if v_has_products then
    perform private.support_ticket_products_apply(v_company, (r ->> 'id')::uuid, v_products, coalesce((p ->> 'allow_archived_products')::boolean, false));
  end if;
  return r || jsonb_build_object('custom_fields', cardinality(v_values), 'products', case when v_has_products then jsonb_array_length(v_products) else 0 end);
end;
$$;


-- ERP reset allowlist of 20261226090000.
create or replace function private.erp_reset_tables()
returns table (ord int, table_name text, category text, label text)
language sql
stable
set search_path = ''
as $$
  select * from (values
    (-3, 'support_call_signals', 'Support Centre', 'Realtime call signals'),
    (0, 'support_ticket_field_values', 'Support Centre', 'Custom ticket field values'),
    (0, 'support_ticket_products', 'Support Centre', 'Products on support tickets'),
    (0, 'support_ticket_field_layout', 'Support Centre', 'New Ticket form layout'),
    (1, 'support_ticket_field_definitions', 'Support Centre', 'Custom ticket fields'),
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
    (0, 'support_email_sync_queue', 'Support Centre', 'Email sync queue'),
    (1, 'support_email_sync_jobs', 'Support Centre', 'Email full re-sync jobs'),
    (0, 'support_email_sync_state', 'Support Centre', 'Email sync lock and progress'),
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
