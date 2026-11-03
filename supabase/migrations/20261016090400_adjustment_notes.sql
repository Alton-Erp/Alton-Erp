-- =============================================================================
-- Phase 8: credit notes, debit notes, invoice balances and statements
--
--   invoice_adjustment_notes       credit / debit notes against an issued invoice
--   invoice_adjustment_note_lines  per invoice line: quantity (credit only),
--                                  taxable amount and tax at the invoice line's
--                                  rate and the invoice's tax treatment
--
-- Notes never touch inventory. Returned goods go through Customer Returns; a
-- credit note line may reference the return line, and the credited quantity
-- per return line can never exceed what was received.
-- Live notes (draft, pending approval, issued) count against the creditable
-- value / quantity of an invoice line, so the same amount or quantity cannot
-- be credited twice. Issued notes are immutable; drafts are discarded.
-- =============================================================================

create table if not exists public.invoice_adjustment_notes (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null references public.companies (id) on delete restrict,
  note_number          text,
  numbering_scope      text,
  financial_year       text,
  note_type            text not null check (note_type in ('CREDIT', 'DEBIT')),
  customer_id          uuid not null,
  original_invoice_id  uuid not null,
  note_date            date not null,
  reason_code          text not null check (reason_code in ('SALES_RETURN', 'QUALITY_ISSUE', 'PRICE_CORRECTION', 'SHORT_SUPPLY', 'COMMERCIAL_ADJUSTMENT',
                         'ADDITIONAL_CHARGE', 'OTHER')),
  reason               text not null check (length(btrim(reason)) between 3 and 1000),
  supporting_reference text check (supporting_reference is null or length(supporting_reference) <= 200),
  customer_return_id   uuid,
  tax_treatment        text not null,
  taxable_amount       numeric(16,2) not null default 0 check (taxable_amount >= 0),
  cgst_amount          numeric(16,2) not null default 0,
  sgst_amount          numeric(16,2) not null default 0,
  igst_amount          numeric(16,2) not null default 0,
  total_amount         numeric(16,2) not null default 0 check (total_amount >= 0),
  status               text not null default 'DRAFT' check (status in ('DRAFT', 'PENDING_APPROVAL', 'ISSUED', 'CANCELLED', 'DISCARDED')),
  tax_review_note      text,
  tax_review_by        uuid,
  tax_review_at        timestamptz,
  submitted_by         uuid,
  submitted_at         timestamptz,
  issued_by            uuid,
  issued_at            timestamptz,
  cancelled_by         uuid,
  cancelled_at         timestamptz,
  cancellation_reason  text,
  created_by           uuid,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint adjustment_notes_id_company_unique unique (id, company_id),
  constraint adjustment_notes_invoice_fk foreign key (original_invoice_id, company_id) references public.sales_invoices (id, company_id) on delete restrict,
  constraint adjustment_notes_customer_fk foreign key (customer_id, company_id) references public.customers (id, company_id) on delete restrict,
  constraint adjustment_notes_return_fk foreign key (customer_return_id, company_id) references public.customer_returns (id, company_id) on delete restrict,
  constraint adjustment_notes_issued_state check ((status in ('ISSUED', 'CANCELLED')) = (note_number is not null and issued_at is not null)),
  constraint adjustment_notes_totals check (total_amount = taxable_amount + cgst_amount + sgst_amount + igst_amount)
);

create unique index if not exists adjustment_notes_number_unique on public.invoice_adjustment_notes (company_id, note_number) where note_number is not null;
create index if not exists adjustment_notes_invoice_idx on public.invoice_adjustment_notes (original_invoice_id);
create index if not exists adjustment_notes_date_idx on public.invoice_adjustment_notes (company_id, note_date desc);

create table if not exists public.invoice_adjustment_note_lines (
  id                      uuid primary key default gen_random_uuid(),
  company_id              uuid not null references public.companies (id) on delete restrict,
  note_id                 uuid not null,
  line_no                 integer not null check (line_no > 0),
  invoice_line_id         uuid not null,
  customer_return_line_id uuid,
  description             text not null,
  hsn_sac                 text,
  quantity                numeric(14,3) check (quantity is null or quantity > 0),
  taxable_amount          numeric(16,2) not null check (taxable_amount > 0),
  gst_rate                numeric(5,2),
  cgst_amount             numeric(16,2) not null default 0,
  sgst_amount             numeric(16,2) not null default 0,
  igst_amount             numeric(16,2) not null default 0,
  line_total              numeric(16,2) not null default 0,
  created_at              timestamptz not null default now(),
  constraint adjustment_note_lines_unique unique (note_id, line_no),
  constraint adjustment_note_lines_note_fk foreign key (note_id, company_id) references public.invoice_adjustment_notes (id, company_id) on delete restrict,
  constraint adjustment_note_lines_invoice_line_fk foreign key (invoice_line_id, company_id) references public.sales_invoice_lines (id, company_id) on delete restrict,
  constraint adjustment_note_lines_total check (line_total = taxable_amount + cgst_amount + sgst_amount + igst_amount)
);

create index if not exists adjustment_note_lines_note_idx on public.invoice_adjustment_note_lines (note_id);
create index if not exists adjustment_note_lines_invoice_line_idx on public.invoice_adjustment_note_lines (invoice_line_id);
create index if not exists adjustment_note_lines_return_line_idx on public.invoice_adjustment_note_lines (customer_return_line_id);

drop trigger if exists adjustment_notes_set_updated_at on public.invoice_adjustment_notes;
create trigger adjustment_notes_set_updated_at before update on public.invoice_adjustment_notes for each row execute function private.set_updated_at();

create or replace function private.guard_note_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  if tg_table_name = 'invoice_adjustment_notes' then
    if tg_op = 'DELETE' then
      raise exception 'Credit and debit notes are never deleted.' using errcode = 'P0001';
    end if;
    if old.status in ('CANCELLED', 'DISCARDED') then
      raise exception 'A % note cannot be changed.', lower(old.status) using errcode = 'P0001';
    end if;
    if old.status = 'ISSUED' and (new.status <> 'CANCELLED'
       or (to_jsonb(new) - array['status', 'cancelled_by', 'cancelled_at', 'cancellation_reason', 'updated_at'])
          is distinct from (to_jsonb(old) - array['status', 'cancelled_by', 'cancelled_at', 'cancellation_reason', 'updated_at'])) then
      raise exception 'Issued note % cannot be edited; issue a new note instead.', old.note_number using errcode = 'P0001';
    end if;
    return new;
  end if;
  select status into v_status from public.invoice_adjustment_notes where id = coalesce(new.note_id, old.note_id);
  if v_status is null or v_status not in ('DRAFT', 'PENDING_APPROVAL') then
    raise exception 'Lines of a % note cannot be changed.', lower(coalesce(v_status, 'unknown')) using errcode = 'P0001';
  end if;
  return coalesce(new, old);
end;
$$;

revoke all on function private.guard_note_change() from public, anon, authenticated;

drop trigger if exists adjustment_notes_guard on public.invoice_adjustment_notes;
create trigger adjustment_notes_guard before update or delete on public.invoice_adjustment_notes for each row execute function private.guard_note_change();
drop trigger if exists adjustment_note_lines_guard on public.invoice_adjustment_note_lines;
create trigger adjustment_note_lines_guard before insert or update or delete on public.invoice_adjustment_note_lines for each row execute function private.guard_note_change();

do $$
declare
  t text;
begin
  foreach t in array array['invoice_adjustment_notes', 'invoice_adjustment_note_lines'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant all on table public.%I to service_role', t);
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format('create policy %I on public.%I for select to authenticated using (private.has_permission(company_id, %L) or private.has_permission(company_id, %L))',
      t || '_select', t, 'invoices.read', 'payments.read');
  end loop;
end;
$$;

-- Live (draft / pending / issued) credited value and quantity of an invoice line.
create or replace function private.invoice_line_noted(p_invoice_line uuid, p_type text, p_exclude_note uuid default null)
returns table (taxable numeric, quantity numeric)
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(l.taxable_amount), 0), coalesce(sum(l.quantity), 0)
  from public.invoice_adjustment_note_lines l join public.invoice_adjustment_notes n on n.id = l.note_id
  where l.invoice_line_id = p_invoice_line and n.note_type = p_type and n.status in ('DRAFT', 'PENDING_APPROVAL', 'ISSUED')
    and (p_exclude_note is null or n.id <> p_exclude_note);
$$;

revoke all on function private.invoice_line_noted(uuid, text, uuid) from public, anon, authenticated;

-- Validates every line of a note against the (locked) original invoice.
create or replace function private.note_issues(p_note uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_n      public.invoice_adjustment_notes;
  v_inv    public.sales_invoices;
  v_issues jsonb := '[]'::jsonb;
  v_l      record;
  v_c      record;
  v_d      record;
  v_rl     public.customer_return_lines;
  v_ret    numeric;
begin
  select * into v_n from public.invoice_adjustment_notes where id = p_note;
  select * into v_inv from public.sales_invoices where id = v_n.original_invoice_id;
  if v_inv.status <> 'ISSUED' then
    v_issues := v_issues || jsonb_build_object('severity', 'BLOCK', 'message', 'The original invoice is not issued (or has been cancelled).');
  end if;
  if v_n.note_date < v_inv.invoice_date or v_n.note_date > private.company_today(v_n.company_id) then
    v_issues := v_issues || jsonb_build_object('severity', 'BLOCK', 'message', 'The note date must be between the invoice date and today.');
  end if;
  if not exists (select 1 from public.invoice_adjustment_note_lines where note_id = p_note) then
    v_issues := v_issues || jsonb_build_object('severity', 'BLOCK', 'message', 'The note has no lines.');
  end if;
  for v_l in select nl.*, il.taxable_value as inv_taxable, il.quantity as inv_quantity, il.fulfilment_line_id, il.line_no as inv_line_no, il.sku
             from public.invoice_adjustment_note_lines nl join public.sales_invoice_lines il on il.id = nl.invoice_line_id where nl.note_id = p_note order by nl.line_no loop
    if v_n.note_type = 'CREDIT' then
      select * into v_c from private.invoice_line_noted(v_l.invoice_line_id, 'CREDIT', p_note);
      select * into v_d from private.invoice_line_noted(v_l.invoice_line_id, 'DEBIT', p_note);
      if v_l.taxable_amount > v_l.inv_taxable - v_c.taxable + v_d.taxable then
        v_issues := v_issues || jsonb_build_object('severity', 'BLOCK', 'message', format('Invoice line %s (%s): at most %s can still be credited (taxable value).',
          v_l.inv_line_no, coalesce(v_l.sku, v_l.description), v_l.inv_taxable - v_c.taxable + v_d.taxable));
      end if;
      if v_l.quantity is not null and v_l.quantity > v_l.inv_quantity - v_c.quantity then
        v_issues := v_issues || jsonb_build_object('severity', 'BLOCK', 'message', format('Invoice line %s (%s): at most %s units can still be credited.',
          v_l.inv_line_no, coalesce(v_l.sku, v_l.description), trim_scale(v_l.inv_quantity - v_c.quantity)));
      end if;
    end if;
    if v_l.customer_return_line_id is not null then
      select * into v_rl from public.customer_return_lines where id = v_l.customer_return_line_id;
      if not found or v_rl.fulfilment_line_id is distinct from v_l.fulfilment_line_id then
        v_issues := v_issues || jsonb_build_object('severity', 'BLOCK', 'message', format('Line %s: the return line is not from this invoice line''s dispatch.', v_l.line_no));
      else
        select coalesce(sum(x.quantity), 0) into v_ret from public.invoice_adjustment_note_lines x join public.invoice_adjustment_notes n on n.id = x.note_id
        where x.customer_return_line_id = v_rl.id and n.status in ('DRAFT', 'PENDING_APPROVAL', 'ISSUED') and n.id <> p_note;
        if coalesce(v_l.quantity, 0) + v_ret > v_rl.quantity_received then
          v_issues := v_issues || jsonb_build_object('severity', 'BLOCK', 'message', format('Line %s: only %s of the return was received and not yet credited.',
            v_l.line_no, v_rl.quantity_received - v_ret));
        end if;
      end if;
    end if;
  end loop;
  if v_n.reason_code in ('PRICE_CORRECTION', 'COMMERCIAL_ADJUSTMENT', 'OTHER', 'ADDITIONAL_CHARGE') then
    v_issues := v_issues || jsonb_build_object('severity', 'REVIEW', 'message', 'GST treatment of this adjustment needs an authorised tax review before issue.');
  end if;
  return v_issues;
end;
$$;

revoke all on function private.note_issues(uuid) from public, anon, authenticated;

create or replace function private.note_recalculate(p_note uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n   public.invoice_adjustment_notes;
  v_inv public.sales_invoices;
begin
  select * into v_n from public.invoice_adjustment_notes where id = p_note;
  select * into v_inv from public.sales_invoices where id = v_n.original_invoice_id;
  update public.invoice_adjustment_note_lines l set cgst_amount = x.half, sgst_amount = x.half, igst_amount = x.full,
    line_total = l.taxable_amount + 2 * x.half + x.full
  from (
    select id,
      case when v_inv.supply_category = 'TAXABLE' and v_inv.tax_treatment = 'INTRA_STATE' then round(taxable_amount * coalesce(gst_rate, 0) / 2 / 100, 2) else 0 end as half,
      case when v_inv.supply_category = 'TAXABLE' and v_inv.tax_treatment = 'INTER_STATE' then round(taxable_amount * coalesce(gst_rate, 0) / 100, 2) else 0 end as full
    from public.invoice_adjustment_note_lines where note_id = p_note
  ) x
  where l.id = x.id;
  update public.invoice_adjustment_notes n set taxable_amount = t.taxable, cgst_amount = t.cgst, sgst_amount = t.sgst, igst_amount = t.igst,
    total_amount = t.taxable + t.cgst + t.sgst + t.igst, tax_treatment = v_inv.tax_treatment
  from (select coalesce(sum(taxable_amount), 0) taxable, coalesce(sum(cgst_amount), 0) cgst, coalesce(sum(sgst_amount), 0) sgst, coalesce(sum(igst_amount), 0) igst
        from public.invoice_adjustment_note_lines where note_id = p_note) t
  where n.id = p_note;
end;
$$;

revoke all on function private.note_recalculate(uuid) from public, anon, authenticated;

-- p_header: {note_date, reason_code, reason, supporting_reference, customer_return_id}
-- p_lines:  [{invoice_line_id, quantity?, taxable_amount?, customer_return_line_id?}]
--           credit with quantity only -> taxable = quantity x the line's net taxable unit value
create or replace function public.adjustment_note_create(p_invoice_id uuid, p_type text, p_header jsonb, p_lines jsonb, p_idempotency_key uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company  uuid := private.require_permission('invoice_adjustments.create');
  v_previous jsonb;
  v_inv      public.sales_invoices;
  v_note     public.invoice_adjustment_notes;
  v_entry    jsonb;
  v_il       public.sales_invoice_lines;
  v_qty      numeric;
  v_taxable  numeric;
  v_no       int := 0;
  v_reason   text := upper(coalesce(p_header ->> 'reason_code', ''));
  v_issues   jsonb;
begin
  v_previous := private.idempotency_begin(v_company, p_idempotency_key, 'adjustment_note_create');
  if v_previous is not null then return v_previous; end if;
  if p_type not in ('CREDIT', 'DEBIT') then
    raise exception 'Note type must be CREDIT or DEBIT.' using errcode = 'P0001';
  end if;
  v_inv := private.lock_invoice(v_company, p_invoice_id);
  if v_inv.status <> 'ISSUED' then
    raise exception 'Notes can only be raised against an issued invoice.' using errcode = 'P0001';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Add at least one line.' using errcode = 'P0001';
  end if;
  if p_type = 'CREDIT' and v_reason = 'ADDITIONAL_CHARGE' or p_type = 'DEBIT' and v_reason in ('SALES_RETURN', 'SHORT_SUPPLY', 'QUALITY_ISSUE') then
    raise exception 'Reason % does not fit a % note.', lower(replace(v_reason, '_', ' ')), lower(p_type) using errcode = 'P0001';
  end if;
  if (p_header ->> 'customer_return_id') is not null and not exists (
    select 1 from public.customer_returns r join public.sales_invoice_lines il on il.invoice_id = v_inv.id
    join public.customer_return_lines rl on rl.return_id = r.id and rl.fulfilment_line_id = il.fulfilment_line_id
    where r.id = (p_header ->> 'customer_return_id')::uuid and r.company_id = v_company) then
    raise exception 'The return does not relate to this invoice.' using errcode = 'P0001';
  end if;

  begin
    insert into public.invoice_adjustment_notes (company_id, note_type, customer_id, original_invoice_id, note_date, reason_code, reason, supporting_reference,
      customer_return_id, tax_treatment, created_by)
    values (v_company, p_type, v_inv.customer_id, v_inv.id, coalesce(nullif(p_header ->> 'note_date', '')::date, private.company_today(v_company)), v_reason,
      btrim(coalesce(p_header ->> 'reason', '')), nullif(btrim(coalesce(p_header ->> 'supporting_reference', '')), ''),
      nullif(p_header ->> 'customer_return_id', '')::uuid, v_inv.tax_treatment, auth.uid())
    returning * into v_note;
  exception when check_violation then
    raise exception 'Choose a reason and describe it (at least 3 characters).' using errcode = 'P0001';
  when invalid_datetime_format or datetime_field_overflow then
    raise exception 'Enter a valid note date.' using errcode = 'P0001';
  end;

  for v_entry in select value from jsonb_array_elements(p_lines) loop
    select * into v_il from public.sales_invoice_lines where id = (v_entry ->> 'invoice_line_id')::uuid and invoice_id = v_inv.id;
    if not found then
      raise exception 'A note line does not belong to the invoice.' using errcode = 'P0001';
    end if;
    begin
      v_qty := nullif(v_entry ->> 'quantity', '')::numeric;
      v_taxable := nullif(v_entry ->> 'taxable_amount', '')::numeric;
    exception when others then
      raise exception 'Quantities and amounts must be numbers.' using errcode = 'P0001';
    end;
    if p_type = 'DEBIT' and v_qty is not null then
      raise exception 'Debit notes adjust value only (no quantity).' using errcode = 'P0001';
    end if;
    if v_qty is not null and (v_qty <= 0 or v_qty <> round(v_qty, 3)) then
      raise exception 'Line quantities must be greater than zero (up to 3 decimals).' using errcode = 'P0001';
    end if;
    if v_taxable is null and v_qty is not null then
      v_taxable := round(v_qty * v_il.taxable_value / v_il.quantity, 2);
    end if;
    if v_taxable is null or v_taxable <= 0 or v_taxable <> round(v_taxable, 2) then
      raise exception 'Invoice line %: enter a taxable amount greater than zero (2 decimals) or a quantity.', v_il.line_no using errcode = 'P0001';
    end if;
    v_no := v_no + 1;
    -- Tax is added by note_recalculate below; the line total starts at the taxable amount.
    insert into public.invoice_adjustment_note_lines (company_id, note_id, line_no, invoice_line_id, customer_return_line_id, description, hsn_sac, quantity, taxable_amount,
      gst_rate, line_total)
    values (v_company, v_note.id, v_no, v_il.id, nullif(v_entry ->> 'customer_return_line_id', '')::uuid, v_il.description, v_il.hsn_sac, v_qty, v_taxable, v_il.gst_rate, v_taxable);
  end loop;

  perform private.note_recalculate(v_note.id);
  v_issues := private.note_issues(v_note.id);
  if exists (select 1 from jsonb_array_elements(v_issues) i where i ->> 'severity' = 'BLOCK') then
    raise exception '%', (select string_agg(i ->> 'message', ' ') from jsonb_array_elements(v_issues) i where i ->> 'severity' = 'BLOCK') using errcode = 'P0001';
  end if;
  perform private.log_billing_event(v_company, 'NOTE', v_note.id, v_inv.id, 'DRAFT_CREATED', null, 'DRAFT', v_note.reason,
    jsonb_build_object('note_type', p_type, 'invoice_number', v_inv.invoice_number, 'lines', v_no));
  return private.idempotency_finish(v_company, p_idempotency_key, jsonb_build_object('note_id', v_note.id, 'issues', v_issues));
end;
$$;

-- SUBMIT | RETURN_TO_DRAFT | ACK_TAX_REVIEW | DISCARD | CANCEL
create or replace function public.adjustment_note_action(p_note_id uuid, p_action text, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid;
  v_n       public.invoice_adjustment_notes;
  v_text    text := nullif(btrim(coalesce(p_note, '')), '');
  v_to      text;
begin
  v_company := case p_action
    when 'SUBMIT' then private.require_permission('invoice_adjustments.create')
    when 'RETURN_TO_DRAFT' then private.require_any_permission(array['invoice_adjustments.create', 'invoices.approve'])
    when 'ACK_TAX_REVIEW' then private.require_permission('invoices.approve')
    when 'DISCARD' then private.require_permission('invoice_adjustments.create')
    when 'CANCEL' then private.require_permission('invoice_adjustments.issue')
  end;
  if v_company is null then
    raise exception 'Unknown action %.', p_action using errcode = 'P0001';
  end if;
  select * into v_n from public.invoice_adjustment_notes where id = p_note_id and company_id = v_company;
  if not found then
    raise exception 'Note not found in your company.' using errcode = 'P0001';
  end if;
  perform 1 from public.sales_invoices where id = v_n.original_invoice_id for update;
  select * into v_n from public.invoice_adjustment_notes where id = p_note_id for update;
  v_to := v_n.status;
  if p_action = 'SUBMIT' then
    if v_n.status <> 'DRAFT' then raise exception 'Only drafts can be submitted.' using errcode = 'P0001'; end if;
    v_to := 'PENDING_APPROVAL';
    update public.invoice_adjustment_notes set status = v_to, submitted_by = auth.uid(), submitted_at = now() where id = v_n.id;
  elsif p_action = 'RETURN_TO_DRAFT' then
    if v_n.status <> 'PENDING_APPROVAL' then raise exception 'Only notes pending approval can be returned to draft.' using errcode = 'P0001'; end if;
    v_to := 'DRAFT';
    update public.invoice_adjustment_notes set status = v_to, submitted_by = null, submitted_at = null where id = v_n.id;
  elsif p_action = 'ACK_TAX_REVIEW' then
    if v_n.status not in ('DRAFT', 'PENDING_APPROVAL') then raise exception 'Tax review is acknowledged before issue.' using errcode = 'P0001'; end if;
    if v_text is null or length(v_text) < 5 then raise exception 'Record the tax review conclusion.' using errcode = 'P0001'; end if;
    update public.invoice_adjustment_notes set tax_review_note = left(v_text, 1000), tax_review_by = auth.uid(), tax_review_at = now() where id = v_n.id;
  elsif p_action = 'DISCARD' then
    if v_n.status not in ('DRAFT', 'PENDING_APPROVAL') then raise exception 'Only drafts can be discarded; issued notes are cancelled.' using errcode = 'P0001'; end if;
    v_to := 'DISCARDED';
    update public.invoice_adjustment_notes set status = v_to where id = v_n.id;
  else
    if v_n.status <> 'ISSUED' then raise exception 'Only issued notes can be cancelled.' using errcode = 'P0001'; end if;
    if v_text is null or length(v_text) < 5 then raise exception 'Enter the reason for cancelling the note.' using errcode = 'P0001'; end if;
    if v_n.note_type = 'DEBIT' and private.invoice_balance(v_n.original_invoice_id) - v_n.total_amount < 0 then
      raise exception 'Cancelling this debit note would leave the invoice over-allocated. Reverse payment allocations first.' using errcode = 'P0001';
    end if;
    v_to := 'CANCELLED';
    update public.invoice_adjustment_notes set status = v_to, cancelled_by = auth.uid(), cancelled_at = now(), cancellation_reason = left(v_text, 1000) where id = v_n.id;
  end if;
  perform private.log_billing_event(v_company, 'NOTE', v_n.id, v_n.original_invoice_id, p_action, v_n.status, v_to, v_text, jsonb_build_object('note_number', v_n.note_number));
  return jsonb_build_object('status', v_to);
end;
$$;

create or replace function public.adjustment_note_issue(p_note_id uuid, p_idempotency_key uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company  uuid := private.require_permission('invoice_adjustments.issue');
  v_previous jsonb;
  v_n        public.invoice_adjustment_notes;
  v_s        public.invoice_settings;
  v_issues   jsonb;
  v_number   jsonb;
begin
  v_previous := private.idempotency_begin(v_company, p_idempotency_key, 'adjustment_note_issue');
  if v_previous is not null then return v_previous; end if;
  select * into v_n from public.invoice_adjustment_notes where id = p_note_id and company_id = v_company;
  if not found then
    raise exception 'Note not found in your company.' using errcode = 'P0001';
  end if;
  perform 1 from public.sales_invoices where id = v_n.original_invoice_id for update;
  select * into v_n from public.invoice_adjustment_notes where id = p_note_id for update;
  v_s := private.billing_settings(v_company);
  if v_s.require_approval then
    if v_n.status <> 'PENDING_APPROVAL' then
      raise exception 'Company policy requires approval: submit the note first.' using errcode = 'P0001';
    end if;
    perform private.require_permission('invoices.approve');
    if v_n.submitted_by = auth.uid() then
      raise exception 'Segregation of duties: the person who submitted the note cannot approve and issue it.' using errcode = '42501';
    end if;
  elsif v_n.status not in ('DRAFT', 'PENDING_APPROVAL') then
    raise exception 'Note is already %.', lower(v_n.status) using errcode = 'P0001';
  end if;
  perform private.note_recalculate(v_n.id);
  select * into v_n from public.invoice_adjustment_notes where id = p_note_id;
  v_issues := private.note_issues(v_n.id);
  if exists (select 1 from jsonb_array_elements(v_issues) i where i ->> 'severity' = 'BLOCK') then
    raise exception 'The note cannot be issued: %', (select string_agg(i ->> 'message', ' ') from jsonb_array_elements(v_issues) i where i ->> 'severity' = 'BLOCK')
      using errcode = 'P0001';
  end if;
  if exists (select 1 from jsonb_array_elements(v_issues) i where i ->> 'severity' = 'REVIEW') and v_n.tax_review_at is null then
    raise exception 'Tax review required before issue: %', (select string_agg(i ->> 'message', ' ') from jsonb_array_elements(v_issues) i where i ->> 'severity' = 'REVIEW')
      using errcode = 'P0001';
  end if;
  v_number := private.next_billing_number(v_company, case when v_n.note_type = 'CREDIT' then 'CREDIT_NOTE' else 'DEBIT_NOTE' end, v_n.note_date);
  update public.invoice_adjustment_notes set status = 'ISSUED', note_number = v_number ->> 'number', numbering_scope = v_number ->> 'scope',
    financial_year = v_number ->> 'financial_year', issued_by = auth.uid(), issued_at = now()
  where id = v_n.id;
  perform private.log_billing_event(v_company, 'NOTE', v_n.id, v_n.original_invoice_id, 'ISSUED', v_n.status, 'ISSUED', null,
    jsonb_build_object('note_number', v_number ->> 'number', 'note_type', v_n.note_type, 'total', v_n.total_amount));
  return private.idempotency_finish(v_company, p_idempotency_key, jsonb_build_object('note_id', v_n.id, 'note_number', v_number ->> 'number', 'total', v_n.total_amount));
end;
$$;

create or replace function public.adjustment_note_validate(p_note_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('invoices.read');
begin
  if not exists (select 1 from public.invoice_adjustment_notes where id = p_note_id and company_id = v_company) then
    raise exception 'Note not found in your company.' using errcode = 'P0001';
  end if;
  return private.note_issues(p_note_id);
end;
$$;

-- -----------------------------------------------------------------------------
-- Views with derived balances (security_invoker: RLS applies)
-- -----------------------------------------------------------------------------
create or replace view public.sales_invoice_list
with (security_invoker = true) as
select i.*, x.credited, x.debited, x.paid,
  case when i.status = 'ISSUED' then i.grand_total - x.credited + x.debited - x.paid end as balance_due,
  case when i.status <> 'ISSUED' then null
       when i.grand_total - x.credited + x.debited - x.paid <= 0 then 'PAID'
       when x.paid > 0 then 'PARTIALLY_PAID' else 'UNPAID' end as payment_status,
  case when i.status <> 'ISSUED' then i.status
       when i.grand_total - x.credited + x.debited - x.paid <= 0 then 'PAID'
       when i.due_date < private.so_today() then 'OVERDUE'
       when x.paid > 0 then 'PARTIALLY_PAID' else 'ISSUED' end as display_status,
  case when i.status = 'ISSUED' and i.grand_total - x.credited + x.debited - x.paid > 0 and i.due_date < private.so_today()
       then private.so_today() - i.due_date end as days_overdue,
  (select count(*) from public.sales_invoice_lines l where l.invoice_id = i.id)::int as line_count
from public.sales_invoices i
cross join lateral (
  select
    coalesce((select sum(n.total_amount) from public.invoice_adjustment_notes n where n.original_invoice_id = i.id and n.status = 'ISSUED' and n.note_type = 'CREDIT'), 0) as credited,
    coalesce((select sum(n.total_amount) from public.invoice_adjustment_notes n where n.original_invoice_id = i.id and n.status = 'ISSUED' and n.note_type = 'DEBIT'), 0) as debited,
    coalesce((select sum(a.allocated_amount) from public.invoice_payment_allocations a where a.invoice_id = i.id and a.status = 'ACTIVE'), 0) as paid
) x;

create or replace view public.adjustment_note_list
with (security_invoker = true) as
select n.*, i.invoice_number, i.invoice_date, i.grand_total as invoice_total, coalesce(c.legal_name, c.customer_name) as customer_name, c.customer_code,
  r.return_number,
  (select count(*) from public.invoice_adjustment_note_lines l where l.note_id = n.id)::int as line_count
from public.invoice_adjustment_notes n
join public.sales_invoices i on i.id = n.original_invoice_id
join public.customers c on c.id = n.customer_id
left join public.customer_returns r on r.id = n.customer_return_id;

revoke all on public.sales_invoice_list, public.adjustment_note_list from anon, authenticated;
grant select on public.sales_invoice_list, public.adjustment_note_list to authenticated;

-- -----------------------------------------------------------------------------
-- Customer statement (running balance)
-- -----------------------------------------------------------------------------
create or replace function public.billing_customer_statement(p_customer_id uuid, p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_any_permission(array['billing_reports.read', 'invoices.read', 'payments.read']);
  v_c       public.customers;
  v_opening numeric;
  v_entries jsonb;
begin
  select * into v_c from public.customers where id = p_customer_id and company_id = v_company;
  if not found then
    raise exception 'Customer not found in your company.' using errcode = 'P0001';
  end if;
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'Choose a valid period.' using errcode = 'P0001';
  end if;
  with stmt (entry_date, sort_at, document, description, debit, credit) as (
  select invoice_date, issued_at, invoice_number, 'Invoice' || coalesce(' · ' || order_references, ''), grand_total, 0::numeric
  from public.sales_invoices where customer_id = v_c.id and status in ('ISSUED', 'CANCELLED')
  union all
  select (cancelled_at at time zone private.company_tz(v_company))::date, cancelled_at, invoice_number, 'Invoice cancelled: ' || coalesce(cancellation_reason, ''), 0, grand_total
  from public.sales_invoices where customer_id = v_c.id and status = 'CANCELLED'
  union all
  select n.note_date, n.issued_at, n.note_number, case when n.note_type = 'CREDIT' then 'Credit note' else 'Debit note' end || ' against ' || i.invoice_number,
    case when n.note_type = 'DEBIT' then n.total_amount else 0 end, case when n.note_type = 'CREDIT' then n.total_amount else 0 end
  from public.invoice_adjustment_notes n join public.sales_invoices i on i.id = n.original_invoice_id
  where n.customer_id = v_c.id and n.status in ('ISSUED', 'CANCELLED')
  union all
  select (n.cancelled_at at time zone private.company_tz(v_company))::date, n.cancelled_at, n.note_number, 'Note cancelled',
    case when n.note_type = 'CREDIT' then n.total_amount else 0 end, case when n.note_type = 'DEBIT' then n.total_amount else 0 end
  from public.invoice_adjustment_notes n where n.customer_id = v_c.id and n.status = 'CANCELLED'
  union all
  select receipt_date, created_at, receipt_number, 'Payment received (' || lower(replace(payment_method, '_', ' ')) || coalesce(', ref ' || transaction_reference, '') || ')', 0, amount_received
  from public.customer_payments where customer_id = v_c.id
  union all
  select (reversed_at at time zone private.company_tz(v_company))::date, reversed_at, receipt_number, 'Receipt reversed: ' || coalesce(reversal_reason, ''), amount_received, 0
  from public.customer_payments where customer_id = v_c.id and status = 'REVERSED'
  )
  select coalesce(sum(debit - credit) filter (where entry_date < p_from), 0),
    coalesce((select jsonb_agg(jsonb_build_object('date', s.entry_date, 'document', s.document, 'description', s.description, 'debit', s.debit, 'credit', s.credit,
        'balance', s.running) order by s.entry_date, s.sort_at)
      from (select t.*, sum(t.debit - t.credit) over (order by t.entry_date, t.sort_at rows unbounded preceding) as running from stmt t) s
      where s.entry_date between p_from and p_to), '[]'::jsonb)
    into v_opening, v_entries
  from stmt;
  return jsonb_build_object(
    'customer', jsonb_build_object('id', v_c.id, 'customer_code', v_c.customer_code, 'name', coalesce(v_c.legal_name, v_c.customer_name), 'billing_address', v_c.billing_address,
      'gstin', v_c.gstin),
    'company', (select jsonb_build_object('legal_name', legal_name, 'legal_address', legal_address, 'gstin', gstin) from public.companies where id = v_company),
    'from', p_from, 'to', p_to, 'opening_balance', v_opening, 'entries', v_entries,
    'closing_balance', coalesce((select (e ->> 'balance')::numeric from jsonb_array_elements(v_entries) with ordinality x(e, n) order by n desc limit 1), v_opening),
    'unallocated_receipts', (select coalesce(sum(amount_received - private.payment_allocated(id)), 0) from public.customer_payments where customer_id = v_c.id and status = 'RECORDED'),
    'generated_at', now());
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.adjustment_note_create(uuid, text, jsonb, jsonb, uuid)', 'public.adjustment_note_action(uuid, text, text)',
    'public.adjustment_note_issue(uuid, uuid)', 'public.adjustment_note_validate(uuid)', 'public.billing_customer_statement(uuid, date, date)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;
