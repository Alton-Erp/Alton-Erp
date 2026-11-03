-- =============================================================================
-- Phase 10: configurable approval workflow engine
--
-- Model: an approval GATES an existing action; it never performs it.
--   * Administrators configure workflows per document type (optional amount
--     thresholds, 1-5 stages, approver roles and/or named users, required
--     approvals per stage, self-approval, rejection reason, escalation).
--     Workflows are inactive until switched on; nothing changes for document
--     types without an active workflow (existing module rules still apply).
--   * A request is created automatically when a document enters its module's
--     pending state, or submitted manually (e.g. a draft invoice, or a payment
--     reversal). It snapshots the workflow (version) and a fingerprint of the
--     document's relevant fields.
--   * Each stage needs N distinct approvers; a user decides a stage once, and
--     (by default) one user cannot approve two stages of the same request.
--   * At every decision the document is re-read: if it changed or left the
--     approvable state, the request is cancelled and must be resubmitted.
--   * The existing module action (approve / post / issue / reverse / confirm)
--     still runs through its own function with all its validations. A trigger
--     on the document table refuses that final transition while an active
--     workflow applies and no APPROVED request with a matching fingerprint
--     exists. The approval is consumed by that transition.
-- =============================================================================

create table if not exists public.approval_workflows (
  id                        uuid primary key default gen_random_uuid(),
  company_id                uuid not null references public.companies (id) on delete restrict,
  name                      text not null check (length(btrim(name)) between 3 and 120),
  description               text check (description is null or length(description) <= 1000),
  document_type             text not null check (document_type in ('STOCK_ADJUSTMENT', 'STOCK_COUNT', 'OPENING_STOCK', 'PRODUCTION_ORDER',
                              'OUTSOURCING_ORDER', 'SALES_ORDER', 'INVOICE', 'CREDIT_NOTE', 'DEBIT_NOTE', 'PAYMENT_REVERSAL')),
  min_amount                numeric(14,2) check (min_amount is null or min_amount >= 0),
  max_amount                numeric(14,2) check (max_amount is null or max_amount >= 0),
  allow_self_approval       boolean not null default false,
  distinct_stage_approvers  boolean not null default true,
  require_rejection_reason  boolean not null default true,
  escalate_after_hours      integer check (escalate_after_hours is null or escalate_after_hours between 1 and 720),
  escalate_to_role          text,
  is_active                 boolean not null default false,
  version                   integer not null default 1,
  created_by                uuid,
  created_at                timestamptz not null default now(),
  updated_by                uuid,
  updated_at                timestamptz not null default now(),
  constraint approval_workflows_name_unique unique (company_id, name),
  constraint approval_workflows_id_company_unique unique (id, company_id),
  constraint approval_workflows_amounts check (min_amount is null or max_amount is null or min_amount <= max_amount),
  constraint approval_workflows_escalation check ((escalate_after_hours is null) = (escalate_to_role is null)),
  constraint approval_workflows_no_financial_self_approval
    check (not (allow_self_approval and document_type in ('INVOICE', 'CREDIT_NOTE', 'DEBIT_NOTE', 'PAYMENT_REVERSAL', 'SALES_ORDER')))
);

create table if not exists public.approval_workflow_stages (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references public.companies (id) on delete restrict,
  workflow_id        uuid not null,
  stage_no           integer not null check (stage_no between 1 and 5),
  name               text not null check (length(btrim(name)) between 1 and 120),
  approver_roles     text[] not null default '{}',
  approver_user_ids  uuid[] not null default '{}',
  required_approvals integer not null default 1 check (required_approvals between 1 and 10),
  constraint approval_stages_unique unique (workflow_id, stage_no),
  constraint approval_stages_has_approvers check (cardinality(approver_roles) + cardinality(approver_user_ids) > 0),
  constraint approval_stages_workflow_fk foreign key (workflow_id, company_id) references public.approval_workflows (id, company_id) on delete cascade
);

create table if not exists public.approval_requests (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null references public.companies (id) on delete restrict,
  workflow_id          uuid not null,
  workflow_version     integer not null,
  workflow_snapshot    jsonb not null,
  document_type        text not null,
  document_id          uuid not null,
  document_reference   text not null,
  document_fingerprint text not null,
  amount               numeric(14,2),
  status               text not null default 'PENDING_APPROVAL' check (status in ('PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'CANCELLED')),
  current_stage        integer not null default 1,
  stage_started_at     timestamptz not null default now(),
  requested_by         uuid,
  requested_at         timestamptz not null default now(),
  request_comment      text check (request_comment is null or length(request_comment) <= 1000),
  decided_at           timestamptz,
  cancel_reason        text check (cancel_reason is null or length(cancel_reason) <= 500),
  consumed_at          timestamptz,
  consumed_by          uuid,
  updated_at           timestamptz not null default now(),
  constraint approval_requests_id_company_unique unique (id, company_id),
  constraint approval_requests_workflow_fk foreign key (workflow_id, company_id) references public.approval_workflows (id, company_id) on delete restrict
);

create unique index if not exists approval_requests_one_open on public.approval_requests (company_id, document_type, document_id) where status = 'PENDING_APPROVAL';
create index if not exists approval_requests_doc_idx on public.approval_requests (document_type, document_id, requested_at desc);
create index if not exists approval_requests_status_idx on public.approval_requests (company_id, status, requested_at desc);

create table if not exists public.approval_decisions (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null references public.companies (id) on delete restrict,
  request_id           uuid not null,
  stage_no             integer not null,
  approver_user_id     uuid not null,
  decision             text not null check (decision in ('APPROVE', 'REJECT')),
  comment              text check (comment is null or length(comment) <= 1000),
  document_fingerprint text not null,
  decided_at           timestamptz not null default now(),
  constraint approval_decisions_once unique (request_id, stage_no, approver_user_id),
  constraint approval_decisions_request_fk foreign key (request_id, company_id) references public.approval_requests (id, company_id) on delete restrict
);

create index if not exists approval_decisions_request_idx on public.approval_decisions (request_id, stage_no);

-- Decisions are immutable.
create or replace function private.prevent_approval_decision_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Approval decisions are append-only.' using errcode = '42501';
end;
$$;

drop trigger if exists approval_decisions_append_only on public.approval_decisions;
create trigger approval_decisions_append_only before update or delete on public.approval_decisions
  for each row execute function private.prevent_approval_decision_mutation();

alter table public.approval_workflows enable row level security;
alter table public.approval_workflow_stages enable row level security;
alter table public.approval_requests enable row level security;
alter table public.approval_decisions enable row level security;
revoke all on public.approval_workflows, public.approval_workflow_stages, public.approval_requests, public.approval_decisions from anon, authenticated;
grant select on public.approval_workflows, public.approval_workflow_stages, public.approval_requests, public.approval_decisions to authenticated;

drop policy if exists approval_workflows_select on public.approval_workflows;
create policy approval_workflows_select on public.approval_workflows for select to authenticated
  using (private.has_permission(company_id, 'approvals.read') or private.has_permission(company_id, 'approvals.manage'));
drop policy if exists approval_stages_select on public.approval_workflow_stages;
create policy approval_stages_select on public.approval_workflow_stages for select to authenticated
  using (private.has_permission(company_id, 'approvals.read') or private.has_permission(company_id, 'approvals.manage'));

-- Read permission of the module that owns a document type.
create or replace function private.approval_read_permission(p_type text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_type
    when 'STOCK_ADJUSTMENT' then 'inventory.read' when 'STOCK_COUNT' then 'inventory.read' when 'OPENING_STOCK' then 'inventory.read'
    when 'PRODUCTION_ORDER' then 'manufacturing.read' when 'OUTSOURCING_ORDER' then 'outsourcing.read' when 'SALES_ORDER' then 'sales_orders.read'
    when 'INVOICE' then 'invoices.read' when 'CREDIT_NOTE' then 'invoices.read' when 'DEBIT_NOTE' then 'invoices.read'
    when 'PAYMENT_REVERSAL' then 'payments.read' end;
$$;

-- Permission needed to submit a document for approval manually.
create or replace function private.approval_submit_permission(p_type text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_type
    when 'STOCK_ADJUSTMENT' then 'inventory.adjust' when 'STOCK_COUNT' then 'inventory_count.create' when 'OPENING_STOCK' then 'inventory_opening.create'
    when 'PRODUCTION_ORDER' then 'production_order.create' when 'OUTSOURCING_ORDER' then 'outsourcing_order.create'
    when 'SALES_ORDER' then 'sales_orders.create' when 'INVOICE' then 'invoices.create' when 'CREDIT_NOTE' then 'invoice_adjustments.create'
    when 'DEBIT_NOTE' then 'invoice_adjustments.create' when 'PAYMENT_REVERSAL' then 'payments.reverse' end;
$$;

drop policy if exists approval_requests_select on public.approval_requests;
create policy approval_requests_select on public.approval_requests for select to authenticated
  using (company_id = private.current_company_id() and (
    requested_by = auth.uid() or private.has_permission(company_id, 'approvals.manage')
    or (private.has_permission(company_id, 'approvals.read') and private.has_permission(company_id, private.approval_read_permission(document_type)))));
drop policy if exists approval_decisions_select on public.approval_decisions;
create policy approval_decisions_select on public.approval_decisions for select to authenticated
  using (exists (select 1 from public.approval_requests r where r.id = request_id));

-- -----------------------------------------------------------------------------
-- Document registry: reference, state, amount and fingerprint of a document.
-- state: PENDING (submittable / approvable), FINAL, OTHER, MISSING.
-- -----------------------------------------------------------------------------
create or replace function private.approval_document(p_company uuid, p_type text, p_id uuid)
returns table (reference text, status text, state text, amount numeric, fingerprint text, link text, owner_id uuid)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_type = 'STOCK_ADJUSTMENT' then
    return query select a.adjustment_number, a.status,
      case when a.status = 'PENDING_APPROVAL' then 'PENDING' when a.status in ('APPROVED', 'POSTED') then 'FINAL' else 'OTHER' end,
      case when a.unit_cost is not null and a.difference is not null then round(abs(a.difference) * a.unit_cost, 2) end,
      md5(concat_ws('|', a.adjustment_type, a.product_id, a.batch_id, a.location_id, a.source_type, a.target_source_type, a.counted_quantity,
        a.correction_quantity, a.reason_code, a.effective_date, a.unit_cost)),
      '/inventory/adjustments', a.requested_by
    from public.inventory_adjustments a where a.id = p_id and a.company_id = p_company;
  elsif p_type = 'STOCK_COUNT' then
    return query select c.count_number, c.status,
      case when c.status = 'SUBMITTED' then 'PENDING' when c.status = 'POSTED' then 'FINAL' else 'OTHER' end, null::numeric,
      md5(coalesce((select string_agg(concat_ws(':', l.id, l.counted_quantity, l.system_quantity), '|' order by l.id) from public.inventory_count_lines l where l.count_id = c.id), '')),
      '/inventory/counts/' || c.id, c.submitted_by
    from public.inventory_counts c where c.id = p_id and c.company_id = p_company;
  elsif p_type = 'OPENING_STOCK' then
    return query select o.document_number, o.status,
      case when o.status = 'PENDING_APPROVAL' then 'PENDING' when o.status = 'POSTED' then 'FINAL' else 'OTHER' end, null::numeric,
      md5(coalesce((select string_agg(concat_ws(':', l.id, l.product_id, l.location_id, l.quantity, l.unit_cost), '|' order by l.id)
                    from public.inventory_opening_lines l where l.opening_batch_id = o.id), '')),
      '/inventory/opening-stock', o.requested_by
    from public.inventory_opening_batches o where o.id = p_id and o.company_id = p_company;
  elsif p_type = 'PRODUCTION_ORDER' then
    return query select o.production_order_number, o.status,
      case when o.status = 'PENDING_APPROVAL' then 'PENDING' when o.status = 'APPROVED' then 'FINAL' else 'OTHER' end, null::numeric,
      md5(concat_ws('|', o.finished_product_id, o.bom_id, o.planned_quantity, o.source_warehouse_id, o.destination_warehouse_id, o.planned_start_date,
        o.target_completion_date, o.priority)),
      '/production/orders/' || o.id, coalesce(o.submitted_by, o.created_by)
    from public.production_orders o where o.id = p_id and o.company_id = p_company;
  elsif p_type = 'OUTSOURCING_ORDER' then
    return query select o.outsourcing_order_number, o.status,
      case when o.status = 'PENDING_APPROVAL' then 'PENDING' when o.status = 'APPROVED' then 'FINAL' else 'OTHER' end,
      case when o.unit_cost is not null then round(o.ordered_quantity * o.unit_cost, 2) end,
      md5(concat_ws('|', o.product_id, o.supplier_name, o.ordered_quantity, o.unit_cost, o.expected_return_date, o.destination_warehouse_id,
        (select string_agg(concat_ws(':', m.component_product_id, m.planned_quantity), '|' order by m.line_no) from public.outsourcing_order_materials m where m.outsourcing_order_id = o.id))),
      '/production/outsourcing/' || o.id, coalesce(o.submitted_by, o.created_by)
    from public.outsourcing_orders o where o.id = p_id and o.company_id = p_company;
  elsif p_type = 'SALES_ORDER' then
    return query select s.sales_order_number, s.order_status,
      case when s.order_status = 'PENDING_CONFIRMATION' then 'PENDING'
           when s.order_status in ('CONFIRMED', 'PARTIALLY_ALLOCATED', 'READY_FOR_FULFILMENT', 'IN_FULFILMENT', 'PARTIALLY_FULFILLED', 'FULFILLED') then 'FINAL'
           else 'OTHER' end,
      (select round(sum((l.quantity_ordered - l.quantity_cancelled) * l.unit_price_snapshot), 2) from public.sales_order_lines l where l.sales_order_id = s.id),
      md5(concat_ws('|', s.customer_key, s.warehouse_id, s.requested_delivery_date,
        (select string_agg(concat_ws(':', l.product_id, l.quantity_ordered, l.quantity_cancelled, l.unit_price_snapshot), '|' order by l.line_no) from public.sales_order_lines l where l.sales_order_id = s.id))),
      '/sales/order-details?so=' || s.id, s.created_by
    from public.sales_orders s where s.id = p_id and s.company_id = p_company;
  elsif p_type = 'INVOICE' then
    return query select coalesce(i.invoice_number, 'Draft ' || left(i.id::text, 8)), i.status,
      case when i.status in ('DRAFT', 'PENDING_APPROVAL') then 'PENDING' when i.status = 'ISSUED' then 'FINAL' else 'OTHER' end,
      i.grand_total,
      md5(concat_ws('|', i.customer_id, i.invoice_date, i.place_of_supply_state_code, i.supply_category, i.grand_total, i.taxable_subtotal,
        (select string_agg(concat_ws(':', l.id, l.quantity, l.unit_price, l.discount_amount, l.taxable_value, l.gst_rate), '|' order by l.line_no) from public.sales_invoice_lines l where l.invoice_id = i.id))),
      '/billing/invoices/' || i.id, coalesce(i.submitted_by, i.created_by)
    from public.sales_invoices i where i.id = p_id and i.company_id = p_company;
  elsif p_type in ('CREDIT_NOTE', 'DEBIT_NOTE') then
    return query select coalesce(n.note_number, 'Draft ' || left(n.id::text, 8)), n.status,
      case when n.status in ('DRAFT', 'PENDING_APPROVAL') then 'PENDING' when n.status = 'ISSUED' then 'FINAL' else 'OTHER' end,
      n.total_amount,
      md5(concat_ws('|', n.original_invoice_id, n.note_date, n.reason_code, n.total_amount,
        (select string_agg(concat_ws(':', l.invoice_line_id, l.quantity, l.taxable_amount), '|' order by l.line_no) from public.invoice_adjustment_note_lines l where l.note_id = n.id))),
      '/billing/notes/' || n.id, coalesce(n.submitted_by, n.created_by)
    from public.invoice_adjustment_notes n
    where n.id = p_id and n.company_id = p_company and n.note_type = case p_type when 'CREDIT_NOTE' then 'CREDIT' else 'DEBIT' end;
  elsif p_type = 'PAYMENT_REVERSAL' then
    return query select p.receipt_number, p.status,
      case when p.status = 'RECORDED' then 'PENDING' when p.status = 'REVERSED' then 'FINAL' else 'OTHER' end,
      p.amount_received,
      md5(concat_ws('|', p.customer_id, p.receipt_date, p.amount_received, p.payment_method, p.transaction_reference)),
      '/billing/payments?receipt=' || p.id, p.recorded_by
    from public.customer_payments p where p.id = p_id and p.company_id = p_company;
  end if;
end;
$$;

-- Active workflow that applies to a document (most specific threshold first).
create or replace function private.approval_workflow_for(p_company uuid, p_type text, p_amount numeric)
returns public.approval_workflows
language sql
stable
security definer
set search_path = ''
as $$
  select w.* from public.approval_workflows w
  where w.company_id = p_company and w.document_type = p_type and w.is_active
    and (w.min_amount is null or (p_amount is not null and p_amount >= w.min_amount))
    and (w.max_amount is null or (p_amount is not null and p_amount <= w.max_amount))
    and exists (select 1 from public.approval_workflow_stages s where s.workflow_id = w.id)
  order by w.min_amount desc nulls last, w.name
  limit 1;
$$;

create or replace function private.approval_snapshot(p_workflow public.approval_workflows)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('name', p_workflow.name, 'allow_self_approval', p_workflow.allow_self_approval,
    'distinct_stage_approvers', p_workflow.distinct_stage_approvers, 'require_rejection_reason', p_workflow.require_rejection_reason,
    'escalate_after_hours', p_workflow.escalate_after_hours, 'escalate_to_role', p_workflow.escalate_to_role,
    'stages', coalesce((select jsonb_agg(jsonb_build_object('stage_no', s.stage_no, 'name', s.name, 'approver_roles', s.approver_roles,
        'approver_user_ids', s.approver_user_ids, 'required_approvals', s.required_approvals) order by s.stage_no)
      from public.approval_workflow_stages s where s.workflow_id = p_workflow.id), '[]'::jsonb));
$$;

-- Users who may decide a stage (active, approvals.read, role or named user).
create or replace function private.approval_stage_users(p_company uuid, p_stage jsonb)
returns table (user_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select distinct p.id from public.profiles p
  where p.company_id = p_company and p.is_active
    and exists (select 1 from public.user_roles ur join public.role_permissions rp on rp.role_id = ur.role_id
                join public.permissions pm on pm.id = rp.permission_id and pm.code = 'approvals.read'
                where ur.user_id = p.id and ur.company_id = p_company)
    and (p.id::text in (select jsonb_array_elements_text(coalesce(p_stage -> 'approver_user_ids', '[]'::jsonb)))
         or exists (select 1 from public.user_roles ur join public.roles r on r.id = ur.role_id
                    where ur.user_id = p.id and ur.company_id = p_company
                      and r.code in (select jsonb_array_elements_text(coalesce(p_stage -> 'approver_roles', '[]'::jsonb)))));
$$;

create or replace function private.approval_notify_stage(p_request public.approval_requests)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_stage jsonb := (select s from jsonb_array_elements(p_request.workflow_snapshot -> 'stages') s where (s ->> 'stage_no')::int = p_request.current_stage);
  v_user  uuid;
begin
  for v_user in select user_id from private.approval_stage_users(p_request.company_id, v_stage) loop
    continue when v_user = p_request.requested_by and not coalesce((p_request.workflow_snapshot ->> 'allow_self_approval')::boolean, false);
    perform private.notify(p_request.company_id, v_user, 'APPROVAL_REQUESTED',
      'Approval needed: ' || replace(initcap(lower(p_request.document_type)), '_', ' ') || ' ' || p_request.document_reference,
      'Stage ' || p_request.current_stage || ' (' || coalesce(v_stage ->> 'name', '') || ') of "' || (p_request.workflow_snapshot ->> 'name') || '".'
        || coalesce(' Amount ' || to_char(p_request.amount, 'FM999,999,999,990.00') || '.', ''),
      'MEDIUM', 'APPROVAL_REQUEST', p_request.id::text, '/admin/approvals?request=' || p_request.id,
      'APPROVAL:' || p_request.id || ':' || p_request.current_stage);
  end loop;
end;
$$;

-- Creates a request for a document if an active workflow applies.
create or replace function private.approval_create_request(p_company uuid, p_type text, p_id uuid, p_comment text, p_requester uuid)
returns public.approval_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc record;
  v_wf  public.approval_workflows;
  v_req public.approval_requests;
begin
  select * into v_doc from private.approval_document(p_company, p_type, p_id);
  if not found or v_doc.state <> 'PENDING' then
    return null;
  end if;
  v_wf := private.approval_workflow_for(p_company, p_type, v_doc.amount);
  if v_wf.id is null then
    return null;
  end if;
  select * into v_req from public.approval_requests where company_id = p_company and document_type = p_type and document_id = p_id and status = 'PENDING_APPROVAL';
  if found then
    if v_req.document_fingerprint = v_doc.fingerprint then
      return v_req;
    end if;
    update public.approval_requests set status = 'CANCELLED', cancel_reason = 'Document changed; resubmitted', decided_at = now(), updated_at = now()
    where id = v_req.id;
  end if;
  update public.approval_requests set status = 'CANCELLED', cancel_reason = 'Superseded by a newer approval request', updated_at = now()
  where company_id = p_company and document_type = p_type and document_id = p_id and status = 'APPROVED' and consumed_at is null;
  insert into public.approval_requests (company_id, workflow_id, workflow_version, workflow_snapshot, document_type, document_id, document_reference,
    document_fingerprint, amount, requested_by, request_comment)
  values (p_company, v_wf.id, v_wf.version, private.approval_snapshot(v_wf), p_type, p_id, v_doc.reference, v_doc.fingerprint, v_doc.amount,
    p_requester, nullif(btrim(coalesce(p_comment, '')), ''))
  returning * into v_req;
  perform private.write_audit_log(p_company, 'approval.requested', 'approval_request', v_req.id::text,
    jsonb_build_object('module', 'approvals', 'result', 'success', 'document_type', p_type, 'document', v_doc.reference, 'workflow', v_wf.name,
      'workflow_version', v_wf.version, 'amount', v_doc.amount));
  perform private.approval_notify_stage(v_req);
  return v_req;
end;
$$;

-- Gate: called before a document makes its final transition.
create or replace function private.approval_gate(p_company uuid, p_type text, p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc record;
  v_wf  public.approval_workflows;
  v_req public.approval_requests;
begin
  select * into v_doc from private.approval_document(p_company, p_type, p_id);
  if not found then
    return;
  end if;
  v_wf := private.approval_workflow_for(p_company, p_type, v_doc.amount);
  if v_wf.id is null then
    return;
  end if;
  select * into v_req from public.approval_requests
  where company_id = p_company and document_type = p_type and document_id = p_id and status = 'APPROVED' and consumed_at is null
  order by (document_fingerprint = v_doc.fingerprint) desc, decided_at desc, requested_at desc limit 1;
  if not found then
    raise exception 'Approval required: % % needs approval under the workflow "%" before this step. Submit it in the Approval Inbox.',
      replace(initcap(lower(p_type)), '_', ' '), v_doc.reference, v_wf.name using errcode = 'P0001';
  end if;
  if v_req.document_fingerprint <> v_doc.fingerprint then
    raise exception '% % changed after it was approved. Resubmit it for approval.', replace(initcap(lower(p_type)), '_', ' '), v_doc.reference
      using errcode = 'P0001';
  end if;
  update public.approval_requests set consumed_at = now(), consumed_by = auth.uid(), updated_at = now() where id = v_req.id;
end;
$$;

-- Generic trigger on document tables.
-- TG_ARGV: [0] document type, [1] status column, [2] auto-request states (csv),
--          [3] pending states (csv), [4] final states (csv)
create or replace function private.approval_document_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_type    text := tg_argv[0];
  v_col     text := tg_argv[1];
  v_auto    text[] := string_to_array(tg_argv[2], ',');
  v_pending text[] := string_to_array(tg_argv[3], ',');
  v_final   text[] := string_to_array(tg_argv[4], ',');
  v_new     text := to_jsonb(new) ->> v_col;
  v_old     text := case when tg_op = 'UPDATE' then to_jsonb(old) ->> v_col end;
  v_id      uuid := (to_jsonb(new) ->> 'id')::uuid;
  v_company uuid := (to_jsonb(new) ->> 'company_id')::uuid;
begin
  if v_type in ('CREDIT_NOTE', 'DEBIT_NOTE') and (to_jsonb(new) ->> 'note_type') <> (case v_type when 'CREDIT_NOTE' then 'CREDIT' else 'DEBIT' end) then
    return new;
  end if;
  if tg_when = 'BEFORE' then
    if tg_op = 'UPDATE' and v_old = any (v_pending) and v_new = any (v_final) then
      perform private.approval_gate(v_company, v_type, v_id);
    end if;
    return new;
  end if;
  -- AFTER
  if v_new = any (v_auto) and (tg_op = 'INSERT' or v_old is distinct from v_new) then
    perform private.approval_create_request(v_company, v_type, v_id, null, auth.uid());
  elsif tg_op = 'UPDATE' and v_old = any (v_pending) and not (v_new = any (v_pending)) and not (v_new = any (v_final)) then
    update public.approval_requests set status = 'CANCELLED', decided_at = now(), updated_at = now(),
      cancel_reason = left('The document left the approval state (now ' || lower(replace(v_new, '_', ' ')) || ').', 500)
    where company_id = v_company and document_type = v_type and document_id = v_id and status = 'PENDING_APPROVAL';
  end if;
  return new;
end;
$$;

revoke all on function private.approval_read_permission(text) from public, anon, authenticated;
revoke all on function private.approval_submit_permission(text) from public, anon, authenticated;
revoke all on function private.approval_document(uuid, text, uuid) from public, anon, authenticated;
revoke all on function private.approval_workflow_for(uuid, text, numeric) from public, anon, authenticated;
revoke all on function private.approval_snapshot(public.approval_workflows) from public, anon, authenticated;
revoke all on function private.approval_stage_users(uuid, jsonb) from public, anon, authenticated;
revoke all on function private.approval_notify_stage(public.approval_requests) from public, anon, authenticated;
revoke all on function private.approval_create_request(uuid, text, uuid, text, uuid) from public, anon, authenticated;
revoke all on function private.approval_gate(uuid, text, uuid) from public, anon, authenticated;
revoke all on function private.approval_document_trigger() from public, anon, authenticated;
-- The RLS policy above calls approval_read_permission as the querying user.
grant execute on function private.approval_read_permission(text) to authenticated;

do $$
declare
  t record;
begin
  for t in select * from (values
    ('inventory_adjustments',      'STOCK_ADJUSTMENT', 'status',       'PENDING_APPROVAL',     'PENDING_APPROVAL',        'APPROVED,POSTED'),
    ('inventory_counts',           'STOCK_COUNT',      'status',       'SUBMITTED',            'SUBMITTED',               'POSTED'),
    ('inventory_opening_batches',  'OPENING_STOCK',    'status',       'PENDING_APPROVAL',     'PENDING_APPROVAL',        'POSTED'),
    ('production_orders',          'PRODUCTION_ORDER', 'status',       'PENDING_APPROVAL',     'PENDING_APPROVAL',        'APPROVED'),
    ('outsourcing_orders',         'OUTSOURCING_ORDER','status',       'PENDING_APPROVAL',     'PENDING_APPROVAL',        'APPROVED'),
    ('sales_orders',               'SALES_ORDER',      'order_status', 'PENDING_CONFIRMATION', 'PENDING_CONFIRMATION',    'CONFIRMED,PARTIALLY_ALLOCATED,READY_FOR_FULFILMENT,IN_FULFILMENT,PARTIALLY_FULFILLED,FULFILLED'),
    ('sales_invoices',             'INVOICE',          'status',       'PENDING_APPROVAL',     'DRAFT,PENDING_APPROVAL',  'ISSUED'),
    ('invoice_adjustment_notes',   'CREDIT_NOTE',      'status',       'PENDING_APPROVAL',     'DRAFT,PENDING_APPROVAL',  'ISSUED'),
    ('invoice_adjustment_notes',   'DEBIT_NOTE',       'status',       'PENDING_APPROVAL',     'DRAFT,PENDING_APPROVAL',  'ISSUED'),
    ('customer_payments',          'PAYMENT_REVERSAL', 'status',       '',                     'RECORDED',                'REVERSED')
  ) v(tbl, typ, col, auto, pending, final) loop
    execute format('drop trigger if exists %I on public.%I', 'approval_gate_' || lower(t.typ), t.tbl);
    execute format('create trigger %I before update on public.%I for each row execute function private.approval_document_trigger(%L, %L, %L, %L, %L)',
      'approval_gate_' || lower(t.typ), t.tbl, t.typ, t.col, t.auto, t.pending, t.final);
    execute format('drop trigger if exists %I on public.%I', 'approval_track_' || lower(t.typ), t.tbl);
    execute format('create trigger %I after insert or update on public.%I for each row execute function private.approval_document_trigger(%L, %L, %L, %L, %L)',
      'approval_track_' || lower(t.typ), t.tbl, t.typ, t.col, t.auto, t.pending, t.final);
  end loop;
end;
$$;

-- Sales orders and opening-stock documents are inserted before their lines, so
-- their automatic request is created when the transaction commits (deferred),
-- once the lines (amount and contents) exist. Later status changes are tracked
-- by the ordinary trigger.
create or replace function private.approval_deferred_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.approval_create_request(new.company_id, tg_argv[0], new.id, null, coalesce(auth.uid(), (to_jsonb(new) ->> tg_argv[1])::uuid));
  return null;
end;
$$;

revoke all on function private.approval_deferred_insert() from public, anon, authenticated;

drop trigger if exists approval_track_sales_order on public.sales_orders;
create trigger approval_track_sales_order after update on public.sales_orders
  for each row execute function private.approval_document_trigger('SALES_ORDER', 'order_status', 'PENDING_CONFIRMATION', 'PENDING_CONFIRMATION',
    'CONFIRMED,PARTIALLY_ALLOCATED,READY_FOR_FULFILMENT,IN_FULFILMENT,PARTIALLY_FULFILLED,FULFILLED');
drop trigger if exists approval_request_sales_order on public.sales_orders;
create constraint trigger approval_request_sales_order after insert on public.sales_orders deferrable initially deferred
  for each row execute function private.approval_deferred_insert('SALES_ORDER', 'created_by');

drop trigger if exists approval_track_opening_stock on public.inventory_opening_batches;
create trigger approval_track_opening_stock after update on public.inventory_opening_batches
  for each row execute function private.approval_document_trigger('OPENING_STOCK', 'status', 'PENDING_APPROVAL', 'PENDING_APPROVAL', 'POSTED');
drop trigger if exists approval_request_opening_stock on public.inventory_opening_batches;
create constraint trigger approval_request_opening_stock after insert on public.inventory_opening_batches deferrable initially deferred
  for each row execute function private.approval_deferred_insert('OPENING_STOCK', 'requested_by');
-- -----------------------------------------------------------------------------
-- Escalation (evaluated when notifications are refreshed; no scheduler)
-- -----------------------------------------------------------------------------
create or replace function private.approval_escalate(p_company uuid)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_req public.approval_requests;
  v_n   int := 0;
  v_user uuid;
begin
  for v_req in
    select * from public.approval_requests
    where company_id = p_company and status = 'PENDING_APPROVAL' and (workflow_snapshot ->> 'escalate_after_hours') is not null
      and stage_started_at < now() - make_interval(hours => (workflow_snapshot ->> 'escalate_after_hours')::int)
  loop
    for v_user in
      select distinct p.id from public.profiles p join public.user_roles ur on ur.user_id = p.id and ur.company_id = p_company
      join public.roles r on r.id = ur.role_id and r.code = v_req.workflow_snapshot ->> 'escalate_to_role'
      where p.company_id = p_company and p.is_active
    loop
      if private.notify(p_company, v_user, 'APPROVAL_ESCALATED', 'Approval overdue: ' || v_req.document_reference,
           'Stage ' || v_req.current_stage || ' of "' || (v_req.workflow_snapshot ->> 'name') || '" has waited more than '
             || (v_req.workflow_snapshot ->> 'escalate_after_hours') || ' hour(s).',
           'HIGH', 'APPROVAL_REQUEST', v_req.id::text, '/admin/approvals?request=' || v_req.id,
           'ESCALATE:' || v_req.id || ':' || v_req.current_stage) then
        v_n := v_n + 1;
      end if;
    end loop;
  end loop;
  return v_n;
end;
$$;

revoke all on function private.approval_escalate(uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Workflow configuration
-- -----------------------------------------------------------------------------
create or replace function public.approval_workflow_save(p_workflow jsonb, p_stages jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('approvals.manage');
  v_id      uuid := nullif(p_workflow ->> 'id', '')::uuid;
  v_wf      public.approval_workflows;
  v_stage   jsonb;
  v_no      int := 0;
  v_role    text;
  v_user    text;
begin
  if p_stages is null or jsonb_typeof(p_stages) <> 'array' or jsonb_array_length(p_stages) not between 1 and 5 then
    raise exception 'A workflow needs 1 to 5 stages.' using errcode = 'P0001';
  end if;
  if coalesce((p_workflow ->> 'allow_self_approval')::boolean, false)
     and coalesce(p_workflow ->> 'document_type', (select document_type from public.approval_workflows where id = v_id and company_id = v_company))
         in ('INVOICE', 'CREDIT_NOTE', 'DEBIT_NOTE', 'PAYMENT_REVERSAL', 'SALES_ORDER') then
    raise exception 'Self-approval cannot be allowed for financial documents.' using errcode = 'P0001';
  end if;
  if (p_workflow ->> 'escalate_to_role') is not null and not exists (select 1 from public.roles where code = p_workflow ->> 'escalate_to_role') then
    raise exception 'Unknown escalation role.' using errcode = 'P0001';
  end if;
  for v_stage in select value from jsonb_array_elements(p_stages) loop
    for v_role in select jsonb_array_elements_text(coalesce(v_stage -> 'approver_roles', '[]')) loop
      if not exists (select 1 from public.roles where code = v_role) then
        raise exception 'Unknown approver role %.', v_role using errcode = 'P0001';
      end if;
    end loop;
    for v_user in select jsonb_array_elements_text(coalesce(v_stage -> 'approver_user_ids', '[]')) loop
      if not exists (select 1 from public.profiles where id = v_user::uuid and company_id = v_company) then
        raise exception 'An approver is not a user of your company.' using errcode = 'P0001';
      end if;
    end loop;
  end loop;

  begin
    if v_id is null then
      insert into public.approval_workflows (company_id, name, description, document_type, min_amount, max_amount, allow_self_approval,
        distinct_stage_approvers, require_rejection_reason, escalate_after_hours, escalate_to_role, is_active, created_by, updated_by)
      values (v_company, btrim(p_workflow ->> 'name'), nullif(btrim(coalesce(p_workflow ->> 'description', '')), ''), p_workflow ->> 'document_type',
        nullif(p_workflow ->> 'min_amount', '')::numeric, nullif(p_workflow ->> 'max_amount', '')::numeric,
        coalesce((p_workflow ->> 'allow_self_approval')::boolean, false), coalesce((p_workflow ->> 'distinct_stage_approvers')::boolean, true),
        coalesce((p_workflow ->> 'require_rejection_reason')::boolean, true), nullif(p_workflow ->> 'escalate_after_hours', '')::int,
        nullif(p_workflow ->> 'escalate_to_role', ''), false, auth.uid(), auth.uid())
      returning * into v_wf;
    else
      select * into v_wf from public.approval_workflows where id = v_id and company_id = v_company for update;
      if not found then
        raise exception 'Workflow not found in your company.' using errcode = 'P0001';
      end if;
      update public.approval_workflows set name = btrim(p_workflow ->> 'name'), description = nullif(btrim(coalesce(p_workflow ->> 'description', '')), ''),
        document_type = p_workflow ->> 'document_type', min_amount = nullif(p_workflow ->> 'min_amount', '')::numeric,
        max_amount = nullif(p_workflow ->> 'max_amount', '')::numeric, allow_self_approval = coalesce((p_workflow ->> 'allow_self_approval')::boolean, false),
        distinct_stage_approvers = coalesce((p_workflow ->> 'distinct_stage_approvers')::boolean, true),
        require_rejection_reason = coalesce((p_workflow ->> 'require_rejection_reason')::boolean, true),
        escalate_after_hours = nullif(p_workflow ->> 'escalate_after_hours', '')::int, escalate_to_role = nullif(p_workflow ->> 'escalate_to_role', ''),
        version = version + 1, updated_by = auth.uid(), updated_at = now()
      where id = v_id returning * into v_wf;
      delete from public.approval_workflow_stages where workflow_id = v_id;
    end if;
  exception
    when unique_violation then raise exception 'A workflow with this name already exists.' using errcode = 'P0001';
    when check_violation then raise exception 'Check the workflow: name 3-120 characters, a supported document type, minimum not above maximum, escalation needs both hours and role.' using errcode = 'P0001';
    when invalid_text_representation then raise exception 'Amounts and hours must be numbers.' using errcode = 'P0001';
  end;
  for v_stage in select value from jsonb_array_elements(p_stages) loop
    v_no := v_no + 1;
    begin
      insert into public.approval_workflow_stages (company_id, workflow_id, stage_no, name, approver_roles, approver_user_ids, required_approvals)
      values (v_company, v_wf.id, v_no, coalesce(nullif(btrim(v_stage ->> 'name'), ''), 'Stage ' || v_no),
        array(select jsonb_array_elements_text(coalesce(v_stage -> 'approver_roles', '[]'))),
        array(select jsonb_array_elements_text(coalesce(v_stage -> 'approver_user_ids', '[]'))::uuid),
        coalesce((v_stage ->> 'required_approvals')::int, 1));
    exception when check_violation then
      raise exception 'Stage %: choose at least one approver role or user, and 1-10 required approvals.', v_no using errcode = 'P0001';
    end;
  end loop;
  perform private.write_audit_log(v_company, case when v_id is null then 'approval.workflow_created' else 'approval.workflow_updated' end,
    'approval_workflow', v_wf.id::text, jsonb_build_object('module', 'approvals', 'result', 'success', 'name', v_wf.name, 'document_type', v_wf.document_type,
      'version', v_wf.version, 'stages', jsonb_array_length(p_stages)));
  return jsonb_build_object('workflow_id', v_wf.id, 'version', v_wf.version);
end;
$$;

create or replace function public.approval_workflow_set_active(p_workflow_id uuid, p_active boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('approvals.manage');
  v_wf      public.approval_workflows;
begin
  update public.approval_workflows set is_active = coalesce(p_active, false), updated_by = auth.uid(), updated_at = now()
  where id = p_workflow_id and company_id = v_company returning * into v_wf;
  if not found then
    raise exception 'Workflow not found in your company.' using errcode = 'P0001';
  end if;
  perform private.write_audit_log(v_company, case when v_wf.is_active then 'approval.workflow_activated' else 'approval.workflow_deactivated' end,
    'approval_workflow', v_wf.id::text, jsonb_build_object('module', 'approvals', 'result', 'success', 'name', v_wf.name));
  return jsonb_build_object('workflow_id', v_wf.id, 'is_active', v_wf.is_active);
end;
$$;

-- -----------------------------------------------------------------------------
-- Requests and decisions
-- -----------------------------------------------------------------------------
create or replace function public.approval_request_submit(p_document_type text, p_document_id uuid, p_comment text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.current_company_id();
  v_doc     record;
  v_req     public.approval_requests;
begin
  if v_company is null or private.approval_submit_permission(p_document_type) is null
     or not private.has_permission(v_company, private.approval_submit_permission(p_document_type)) then
    raise exception 'You are not allowed to submit this document for approval (requires %).', coalesce(private.approval_submit_permission(p_document_type), 'a supported document type')
      using errcode = '42501';
  end if;
  select * into v_doc from private.approval_document(v_company, p_document_type, p_document_id);
  if not found then
    raise exception 'Document not found in your company.' using errcode = 'P0001';
  end if;
  if v_doc.state <> 'PENDING' then
    raise exception '% is % and cannot be submitted for approval.', v_doc.reference, lower(replace(v_doc.status, '_', ' ')) using errcode = 'P0001';
  end if;
  if private.approval_workflow_for(v_company, p_document_type, v_doc.amount) is null then
    return jsonb_build_object('status', 'NOT_REQUIRED', 'reference', v_doc.reference);
  end if;
  if length(coalesce(p_comment, '')) > 1000 then
    raise exception 'Comments are limited to 1000 characters.' using errcode = 'P0001';
  end if;
  v_req := private.approval_create_request(v_company, p_document_type, p_document_id, p_comment, auth.uid());
  return jsonb_build_object('status', v_req.status, 'request_id', v_req.id, 'reference', v_req.document_reference);
end;
$$;

create or replace function public.approval_decide(p_request_id uuid, p_decision text, p_comment text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('approvals.read');
  v_req     public.approval_requests;
  v_doc     record;
  v_stage   jsonb;
  v_text    text := nullif(btrim(coalesce(p_comment, '')), '');
  v_count   int;
  v_last    int;
begin
  if p_decision not in ('APPROVE', 'REJECT') then
    raise exception 'Decision must be APPROVE or REJECT.' using errcode = 'P0001';
  end if;
  select * into v_req from public.approval_requests where id = p_request_id and company_id = v_company for update;
  if not found then
    raise exception 'Approval request not found in your company.' using errcode = 'P0001';
  end if;
  if v_req.status <> 'PENDING_APPROVAL' then
    raise exception 'This request is already %.', lower(v_req.status) using errcode = 'P0001';
  end if;
  v_stage := (select s from jsonb_array_elements(v_req.workflow_snapshot -> 'stages') s where (s ->> 'stage_no')::int = v_req.current_stage);
  if not exists (select 1 from private.approval_stage_users(v_company, v_stage) u where u.user_id = auth.uid()) then
    raise exception 'You are not an approver for stage % of this request.', v_req.current_stage using errcode = '42501';
  end if;
  if v_req.requested_by = auth.uid() and not coalesce((v_req.workflow_snapshot ->> 'allow_self_approval')::boolean, false) then
    raise exception 'Segregation of duties: you submitted this request and cannot decide it.' using errcode = '42501';
  end if;
  if exists (select 1 from public.approval_decisions where request_id = v_req.id and approver_user_id = auth.uid() and stage_no = v_req.current_stage) then
    raise exception 'You have already decided this stage.' using errcode = 'P0001';
  end if;
  if coalesce((v_req.workflow_snapshot ->> 'distinct_stage_approvers')::boolean, true)
     and exists (select 1 from public.approval_decisions where request_id = v_req.id and approver_user_id = auth.uid()) then
    raise exception 'You already approved an earlier stage of this request; another approver must decide this stage.' using errcode = '42501';
  end if;
  if p_decision = 'REJECT' and coalesce((v_req.workflow_snapshot ->> 'require_rejection_reason')::boolean, true) and (v_text is null or length(v_text) < 5) then
    raise exception 'Enter the reason for rejecting (at least 5 characters).' using errcode = 'P0001';
  end if;
  if length(coalesce(v_text, '')) > 1000 then
    raise exception 'Comments are limited to 1000 characters.' using errcode = 'P0001';
  end if;

  -- Revalidate the document: unchanged and still awaiting this decision.
  select * into v_doc from private.approval_document(v_company, v_req.document_type, v_req.document_id);
  if not found or v_doc.state <> 'PENDING' or v_doc.fingerprint <> v_req.document_fingerprint then
    update public.approval_requests set status = 'CANCELLED', decided_at = now(), updated_at = now(),
      cancel_reason = case when not found then 'The document no longer exists.'
                           when v_doc.state <> 'PENDING' then left('The document is no longer awaiting approval (now ' || lower(replace(v_doc.status, '_', ' ')) || ').', 500)
                           else 'The document changed after it was submitted. Resubmit it for approval.' end
    where id = v_req.id;
    perform private.write_audit_log(v_company, 'approval.cancelled_stale', 'approval_request', v_req.id::text,
      jsonb_build_object('module', 'approvals', 'result', 'failure', 'document', v_req.document_reference));
    perform private.notify(v_company, v_req.requested_by, 'APPROVAL_CANCELLED', 'Approval request cancelled: ' || v_req.document_reference,
      'The document changed or left its approval state, so the request was cancelled. Resubmit it if approval is still needed.', 'MEDIUM',
      'APPROVAL_REQUEST', v_req.id::text, '/admin/approvals?request=' || v_req.id, 'APPROVAL_CANCELLED:' || v_req.id);
    return jsonb_build_object('status', 'CANCELLED', 'stale', true,
      'message', 'The document changed or is no longer awaiting approval. The request was cancelled; it must be resubmitted.');
  end if;

  insert into public.approval_decisions (company_id, request_id, stage_no, approver_user_id, decision, comment, document_fingerprint)
  values (v_company, v_req.id, v_req.current_stage, auth.uid(), p_decision, v_text, v_doc.fingerprint);
  perform private.write_audit_log(v_company, case p_decision when 'APPROVE' then 'approval.approved' else 'approval.rejected' end,
    'approval_request', v_req.id::text, jsonb_build_object('module', 'approvals', 'result', 'success', 'document_type', v_req.document_type,
      'document', v_req.document_reference, 'stage', v_req.current_stage, 'comment', left(coalesce(v_text, ''), 300)));

  if p_decision = 'REJECT' then
    update public.approval_requests set status = 'REJECTED', decided_at = now(), updated_at = now() where id = v_req.id;
    perform private.notify(v_company, v_req.requested_by, 'APPROVAL_REJECTED', 'Rejected: ' || v_req.document_reference,
      coalesce(v_text, 'No reason given.'), 'HIGH', 'APPROVAL_REQUEST', v_req.id::text, '/admin/approvals?request=' || v_req.id, 'APPROVAL_REJECTED:' || v_req.id);
    return jsonb_build_object('status', 'REJECTED');
  end if;

  select count(*) into v_count from public.approval_decisions where request_id = v_req.id and stage_no = v_req.current_stage and decision = 'APPROVE';
  if v_count < coalesce((v_stage ->> 'required_approvals')::int, 1) then
    return jsonb_build_object('status', 'PENDING_APPROVAL', 'stage', v_req.current_stage, 'approvals', v_count,
      'required', coalesce((v_stage ->> 'required_approvals')::int, 1));
  end if;
  v_last := jsonb_array_length(v_req.workflow_snapshot -> 'stages');
  if v_req.current_stage < v_last then
    update public.approval_requests set current_stage = current_stage + 1, stage_started_at = now(), updated_at = now() where id = v_req.id returning * into v_req;
    perform private.approval_notify_stage(v_req);
    return jsonb_build_object('status', 'PENDING_APPROVAL', 'stage', v_req.current_stage);
  end if;
  update public.approval_requests set status = 'APPROVED', decided_at = now(), updated_at = now() where id = v_req.id;
  perform private.notify(v_company, v_req.requested_by, 'APPROVAL_APPROVED', 'Approved: ' || v_req.document_reference,
    'All approval stages are complete. The document can now be processed in its module; its own checks still apply.', 'INFO',
    'APPROVAL_REQUEST', v_req.id::text, v_doc.link, 'APPROVAL_APPROVED:' || v_req.id);
  return jsonb_build_object('status', 'APPROVED');
end;
$$;

create or replace function public.approval_request_cancel(p_request_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.current_company_id();
  v_req     public.approval_requests;
begin
  select * into v_req from public.approval_requests where id = p_request_id and company_id = v_company for update;
  if not found then
    raise exception 'Approval request not found in your company.' using errcode = 'P0001';
  end if;
  if v_req.requested_by is distinct from auth.uid() and not private.has_permission(v_company, 'approvals.manage') then
    raise exception 'Only the requester or an approvals administrator can cancel this request.' using errcode = '42501';
  end if;
  if v_req.status <> 'PENDING_APPROVAL' then
    raise exception 'Only pending requests can be cancelled.' using errcode = 'P0001';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'Enter the reason for cancelling.' using errcode = 'P0001';
  end if;
  update public.approval_requests set status = 'CANCELLED', cancel_reason = left(btrim(p_reason), 500), decided_at = now(), updated_at = now()
  where id = v_req.id;
  perform private.write_audit_log(v_company, 'approval.cancelled', 'approval_request', v_req.id::text,
    jsonb_build_object('module', 'approvals', 'result', 'success', 'document', v_req.document_reference, 'reason', left(btrim(p_reason), 300)));
  return jsonb_build_object('status', 'CANCELLED');
end;
$$;

-- Approval state of a document for its own page.
create or replace function public.approval_document_status(p_document_type text, p_document_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.current_company_id();
  v_doc     record;
  v_wf      public.approval_workflows;
  v_req     public.approval_requests;
begin
  if v_company is null or private.approval_read_permission(p_document_type) is null
     or not private.has_permission(v_company, private.approval_read_permission(p_document_type)) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  select * into v_doc from private.approval_document(v_company, p_document_type, p_document_id);
  if not found then
    raise exception 'Document not found in your company.' using errcode = 'P0001';
  end if;
  v_wf := private.approval_workflow_for(v_company, p_document_type, v_doc.amount);
  select * into v_req from public.approval_requests where company_id = v_company and document_type = p_document_type and document_id = p_document_id
  order by requested_at desc limit 1;
  return jsonb_build_object(
    'status', case when v_wf.id is null then 'NOT_REQUIRED'
                   when v_req.id is null then 'DRAFT'
                   when v_req.status = 'APPROVED' and v_req.document_fingerprint <> v_doc.fingerprint and v_req.consumed_at is null then 'CHANGED_AFTER_APPROVAL'
                   else v_req.status end,
    'workflow', case when v_wf.id is not null then jsonb_build_object('id', v_wf.id, 'name', v_wf.name) end,
    'request_id', v_req.id, 'consumed', v_req.consumed_at is not null, 'document_state', v_doc.state);
end;
$$;

-- Inbox: engine requests the caller may see, plus documents awaiting the
-- caller's approval in modules without an engine workflow.
create or replace function public.approval_inbox(p_scope text default 'TO_DECIDE', p_limit int default 100)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('approvals.read');
  v_uid     uuid := auth.uid();
  v_reqs    jsonb;
  v_module  jsonb;
begin
  if p_scope not in ('TO_DECIDE', 'MINE', 'ALL') or p_limit not between 1 and 500 then
    raise exception 'Invalid inbox scope.' using errcode = 'P0001';
  end if;
  with r as (
    select q.*, (select s from jsonb_array_elements(q.workflow_snapshot -> 'stages') s where (s ->> 'stage_no')::int = q.current_stage) as stage,
      d.fingerprint as current_fingerprint, d.state as document_state, d.link
    from public.approval_requests q
    left join lateral private.approval_document(v_company, q.document_type, q.document_id) d on true
    where q.company_id = v_company
      and (q.requested_by = v_uid or private.has_permission(v_company, 'approvals.manage')
           or private.has_permission(v_company, private.approval_read_permission(q.document_type)))
  ),
  x as (
    select r.*, (r.status = 'PENDING_APPROVAL'
        and exists (select 1 from private.approval_stage_users(v_company, r.stage) u where u.user_id = v_uid)
        and (r.requested_by is distinct from v_uid or coalesce((r.workflow_snapshot ->> 'allow_self_approval')::boolean, false))
        and not exists (select 1 from public.approval_decisions dd where dd.request_id = r.id and dd.approver_user_id = v_uid
                        and (dd.stage_no = r.current_stage or coalesce((r.workflow_snapshot ->> 'distinct_stage_approvers')::boolean, true)))) as can_decide
    from r
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'document_type', x.document_type, 'document_id', x.document_id, 'reference', x.document_reference,
      'amount', x.amount, 'status', x.status, 'workflow', x.workflow_snapshot ->> 'name', 'workflow_version', x.workflow_version,
      'stage', x.current_stage, 'stages', jsonb_array_length(x.workflow_snapshot -> 'stages'), 'stage_name', x.stage ->> 'name',
      'required_approvals', x.stage -> 'required_approvals',
      'stage_approvals', (select count(*) from public.approval_decisions dd where dd.request_id = x.id and dd.stage_no = x.current_stage and dd.decision = 'APPROVE'),
      'requested_by', x.requested_by, 'requested_by_name', (select coalesce(p.full_name, p.email) from public.profiles p where p.id = x.requested_by),
      'requested_at', x.requested_at, 'comment', x.request_comment, 'decided_at', x.decided_at, 'cancel_reason', x.cancel_reason,
      'consumed_at', x.consumed_at, 'can_decide', x.can_decide, 'mine', x.requested_by = v_uid, 'link', x.link,
      'stale', x.status = 'PENDING_APPROVAL' and (x.current_fingerprint is distinct from x.document_fingerprint or x.document_state is distinct from 'PENDING'),
      'require_rejection_reason', coalesce((x.workflow_snapshot ->> 'require_rejection_reason')::boolean, true),
      'decisions', coalesce((select jsonb_agg(jsonb_build_object('stage', dd.stage_no, 'decision', dd.decision, 'comment', dd.comment, 'decided_at', dd.decided_at,
          'approver', (select coalesce(p.full_name, p.email) from public.profiles p where p.id = dd.approver_user_id)) order by dd.decided_at)
        from public.approval_decisions dd where dd.request_id = x.id), '[]'::jsonb))
      order by x.requested_at desc), '[]'::jsonb)
  into v_reqs
  from (select * from x where (p_scope = 'ALL') or (p_scope = 'MINE' and x.requested_by = v_uid) or (p_scope = 'TO_DECIDE' and x.can_decide)
        order by x.requested_at desc limit p_limit) x;

  -- Module approvals with no engine request (the module page decides them).
  select coalesce(jsonb_agg(m order by m ->> 'submitted_at'), '[]'::jsonb) into v_module from (
    select jsonb_build_object('document_type', 'STOCK_ADJUSTMENT', 'reference', a.adjustment_number, 'link', '/inventory/adjustments', 'submitted_at', a.requested_at,
      'mine', a.requested_by = v_uid, 'summary', lower(replace(a.reason_code, '_', ' '))) m
    from public.inventory_adjustments a where a.company_id = v_company and a.status = 'PENDING_APPROVAL' and private.has_permission(v_company, 'inventory.approve_adjustment')
      and not exists (select 1 from public.approval_requests q where q.document_id = a.id and q.status = 'PENDING_APPROVAL')
    union all
    select jsonb_build_object('document_type', 'STOCK_COUNT', 'reference', c.count_number, 'link', '/inventory/counts/' || c.id, 'submitted_at', c.submitted_at,
      'mine', c.submitted_by = v_uid, 'summary', 'count variance review')
    from public.inventory_counts c where c.company_id = v_company and c.status = 'SUBMITTED' and private.has_permission(v_company, 'inventory_count.approve')
      and not exists (select 1 from public.approval_requests q where q.document_id = c.id and q.status = 'PENDING_APPROVAL')
    union all
    select jsonb_build_object('document_type', 'OPENING_STOCK', 'reference', o.document_number, 'link', '/inventory/opening-stock', 'submitted_at', o.requested_at,
      'mine', o.requested_by = v_uid, 'summary', o.line_count || ' line(s)')
    from public.inventory_opening_batches o where o.company_id = v_company and o.status = 'PENDING_APPROVAL' and private.has_permission(v_company, 'inventory_opening.approve')
      and not exists (select 1 from public.approval_requests q where q.document_id = o.id and q.status = 'PENDING_APPROVAL')
    union all
    select jsonb_build_object('document_type', 'PRODUCTION_ORDER', 'reference', o.production_order_number, 'link', '/production/orders/' || o.id, 'submitted_at', o.submitted_at,
      'mine', o.submitted_by = v_uid, 'summary', trim_scale(o.planned_quantity) || ' ' || o.unit)
    from public.production_orders o where o.company_id = v_company and o.status = 'PENDING_APPROVAL' and private.has_permission(v_company, 'production_order.approve')
      and not exists (select 1 from public.approval_requests q where q.document_id = o.id and q.status = 'PENDING_APPROVAL')
    union all
    select jsonb_build_object('document_type', 'BOM', 'reference', b.bom_code || ' v' || b.version, 'link', '/production/boms/' || b.id, 'submitted_at', coalesce(b.submitted_at, b.updated_at),
      'mine', coalesce(b.submitted_by, b.created_by) = v_uid, 'summary', 'bill of materials')
    from public.boms b where b.company_id = v_company and b.status = 'PENDING_APPROVAL' and private.has_permission(v_company, 'production_bom.approve')
    union all
    select jsonb_build_object('document_type', 'OUTSOURCING_ORDER', 'reference', o.outsourcing_order_number, 'link', '/production/outsourcing/' || o.id, 'submitted_at', o.submitted_at,
      'mine', o.submitted_by = v_uid, 'summary', o.supplier_name)
    from public.outsourcing_orders o where o.company_id = v_company and o.status = 'PENDING_APPROVAL' and private.has_permission(v_company, 'outsourcing_order.approve')
      and not exists (select 1 from public.approval_requests q where q.document_id = o.id and q.status = 'PENDING_APPROVAL')
    union all
    select jsonb_build_object('document_type', 'INVOICE', 'reference', 'Draft · ' || i.customer_legal_name, 'link', '/billing/invoices/' || i.id, 'submitted_at', i.submitted_at,
      'mine', i.submitted_by = v_uid, 'summary', to_char(i.grand_total, 'FM999,999,999,990.00'))
    from public.sales_invoices i where i.company_id = v_company and i.status = 'PENDING_APPROVAL' and private.has_permission(v_company, 'invoices.approve')
      and not exists (select 1 from public.approval_requests q where q.document_id = i.id and q.status = 'PENDING_APPROVAL')
    union all
    select jsonb_build_object('document_type', n.note_type || '_NOTE', 'reference', 'Draft ' || lower(n.note_type) || ' note', 'link', '/billing/notes/' || n.id,
      'submitted_at', n.submitted_at, 'mine', n.submitted_by = v_uid, 'summary', to_char(n.total_amount, 'FM999,999,999,990.00'))
    from public.invoice_adjustment_notes n where n.company_id = v_company and n.status = 'PENDING_APPROVAL' and private.has_permission(v_company, 'invoices.approve')
      and not exists (select 1 from public.approval_requests q where q.document_id = n.id and q.status = 'PENDING_APPROVAL')
    limit 200
  ) y;

  return jsonb_build_object('requests', v_reqs, 'module_items', v_module, 'generated_at', now());
end;
$$;

revoke all on function public.approval_workflow_save(jsonb, jsonb) from public, anon;
revoke all on function public.approval_workflow_set_active(uuid, boolean) from public, anon;
revoke all on function public.approval_request_submit(text, uuid, text) from public, anon;
revoke all on function public.approval_decide(uuid, text, text) from public, anon;
revoke all on function public.approval_request_cancel(uuid, text) from public, anon;
revoke all on function public.approval_document_status(text, uuid) from public, anon;
revoke all on function public.approval_inbox(text, int) from public, anon;
grant execute on function public.approval_workflow_save(jsonb, jsonb), public.approval_workflow_set_active(uuid, boolean),
  public.approval_request_submit(text, uuid, text), public.approval_decide(uuid, text, text), public.approval_request_cancel(uuid, text),
  public.approval_document_status(text, uuid), public.approval_inbox(text, int) to authenticated;
