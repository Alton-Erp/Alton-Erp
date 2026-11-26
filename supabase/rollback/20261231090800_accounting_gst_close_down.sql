-- Rollback of 20261231090800_accounting_gst_close (Phase 5, Gate E).
--
-- Gate E adds no tables and no records: it restores the Gate D period transition exactly (CLOSE without the close controls) and drops
-- the readiness / report functions. Close events already written keep their recorded controls (period history is append-only).
-- Refused while the Gate D return functions it depends on are missing (roll back in reverse order: Gate E before Gate D).

do $$
begin
  if to_regprocedure('private.gst_gstr1(public.gst_return_periods)') is null then
    raise exception 'Gate D functions are missing; this rollback must run before 20261231090700_accounting_gst_returns_down.sql.';
  end if;
end;
$$;

-- Function as 20261231090700 left it.
create or replace function public.gst_period_transition(p_period_id uuid, p_action text, p_reason text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_action  text := upper(coalesce(p_action, ''));
  v_company uuid := private.require_any_permission(case v_action when 'APPROVE' then array['gst_returns.approve'] when 'CLOSE' then array['gst_periods.close']
                      when 'REOPEN' then array['gst_periods.reopen'] else array['gst_returns.prepare'] end);
  p         public.gst_return_periods := private.gst_period_lock(v_company, p_period_id);
  v_from    text := p.status;
  v_block   jsonb;
  v_snap    uuid;
  v_ver     integer;
  v_cfg     public.gst_config_versions;
  v_totals  jsonb;
  v_data    jsonb;
begin
  if v_action = 'START_REVIEW' and p.status = 'OPEN' then
    update public.gst_return_periods set status = 'UNDER_REVIEW', updated_at = now(), row_version = row_version + 1 where id = p.id returning * into p;
    perform private.gst_period_event(p, 'REVIEW_STARTED', v_from, p_reason);
  elsif v_action = 'READY' and p.status = 'UNDER_REVIEW' then
    select jsonb_agg(x) into v_block from jsonb_array_elements(private.gst_period_checklist(p)) x where (x ->> 'blocking')::boolean and (x ->> 'count')::int > 0;
    if v_block is not null then
      raise exception '%', v_block -> 0 ->> 'message' using errcode = 'P0001', detail = v_block::text;
    end if;
    update public.gst_return_periods set status = 'READY_FOR_APPROVAL', prepared_by = auth.uid(), prepared_at = now(), updated_at = now(), row_version = row_version + 1
    where id = p.id returning * into p;
    perform private.gst_period_event(p, 'READY', v_from, p_reason);
  elsif v_action = 'RETURN' and p.status = 'READY_FOR_APPROVAL' then
    if length(btrim(coalesce(p_reason, ''))) < 5 then
      raise exception 'A reason of at least 5 characters is required.' using errcode = '22023';
    end if;
    update public.gst_return_periods set status = 'UNDER_REVIEW', prepared_by = null, prepared_at = null, updated_at = now(), row_version = row_version + 1
    where id = p.id returning * into p;
    perform private.gst_period_event(p, 'RETURNED', v_from, p_reason);
  elsif v_action = 'APPROVE' and p.status = 'READY_FOR_APPROVAL' then
    if p.prepared_by = auth.uid() then
      raise exception 'Maker-checker: the person who prepared the period cannot approve it.' using errcode = '42501';
    end if;
    select jsonb_agg(x) into v_block from jsonb_array_elements(private.gst_period_checklist(p)) x where (x ->> 'blocking')::boolean and (x ->> 'count')::int > 0;
    if v_block is not null then
      raise exception '%', v_block -> 0 ->> 'message' using errcode = 'P0001', detail = v_block::text;
    end if;
    v_cfg := private.gst_config_on(v_company, p.period_end);
    select coalesce(max(version_no), 0) + 1 into v_ver from public.gst_period_snapshots where period_id = p.id;
    select jsonb_build_object(
        'outward', jsonb_build_object('documents', count(*) filter (where source_kind = 'SALES_INVOICE'),
          'taxable', coalesce(sum((amounts ->> 'taxable')::numeric) filter (where source_kind = 'SALES_INVOICE'), 0),
          'cgst', coalesce(sum((amounts ->> 'cgst')::numeric) filter (where source_kind = 'SALES_INVOICE'), 0),
          'sgst', coalesce(sum((amounts ->> 'sgst')::numeric) filter (where source_kind = 'SALES_INVOICE'), 0),
          'igst', coalesce(sum((amounts ->> 'igst')::numeric) filter (where source_kind = 'SALES_INVOICE'), 0)),
        'credit_notes', jsonb_build_object('documents', count(*) filter (where source_kind = 'CREDIT_NOTE'),
          'taxable', coalesce(sum((amounts ->> 'taxable')::numeric) filter (where source_kind = 'CREDIT_NOTE'), 0),
          'tax', coalesce(sum((amounts ->> 'cgst')::numeric + (amounts ->> 'sgst')::numeric + (amounts ->> 'igst')::numeric) filter (where source_kind = 'CREDIT_NOTE'), 0)),
        'debit_notes', jsonb_build_object('documents', count(*) filter (where source_kind = 'DEBIT_NOTE'),
          'taxable', coalesce(sum((amounts ->> 'taxable')::numeric) filter (where source_kind = 'DEBIT_NOTE'), 0),
          'tax', coalesce(sum((amounts ->> 'cgst')::numeric + (amounts ->> 'sgst')::numeric + (amounts ->> 'igst')::numeric) filter (where source_kind = 'DEBIT_NOTE'), 0)),
        'inward', jsonb_build_object('documents', count(*) filter (where source_kind = 'PURCHASE_INVOICE'),
          'taxable', coalesce(sum((amounts ->> 'taxable')::numeric) filter (where source_kind = 'PURCHASE_INVOICE'), 0),
          'tax', coalesce(sum((amounts ->> 'cgst')::numeric + (amounts ->> 'sgst')::numeric + (amounts ->> 'igst')::numeric + (amounts ->> 'cess')::numeric)
                   filter (where source_kind = 'PURCHASE_INVOICE'), 0),
          'rcm_tax', coalesce(sum((amounts ->> 'cgst')::numeric + (amounts ->> 'sgst')::numeric + (amounts ->> 'igst')::numeric + (amounts ->> 'cess')::numeric)
                   filter (where source_kind = 'PURCHASE_INVOICE' and (amounts ->> 'reverse_charge')::boolean), 0)),
        'itc', jsonb_build_object(
          'eligible', coalesce(sum((amounts ->> 'eligible_cgst')::numeric + (amounts ->> 'eligible_sgst')::numeric + (amounts ->> 'eligible_igst')::numeric
                   + (amounts ->> 'eligible_cess')::numeric) filter (where source_kind = 'ITC_DECISION'), 0),
          'ineligible', coalesce(sum((amounts ->> 'ineligible')::numeric) filter (where source_kind = 'ITC_DECISION'), 0),
          'reversed', coalesce(sum((amounts ->> 'cgst')::numeric + (amounts ->> 'sgst')::numeric + (amounts ->> 'igst')::numeric + (amounts ->> 'cess')::numeric)
                   filter (where source_kind = 'ITC_ADJUSTMENT' and amounts ->> 'kind' = 'REVERSAL'), 0),
          'reclaimed', coalesce(sum((amounts ->> 'cgst')::numeric + (amounts ->> 'sgst')::numeric + (amounts ->> 'igst')::numeric + (amounts ->> 'cess')::numeric)
                   filter (where source_kind = 'ITC_ADJUSTMENT' and amounts ->> 'kind' = 'RECLAIM'), 0)))
      into v_totals
    from private.gst_period_documents(v_company, p.period_start, p.period_end);
    v_data := jsonb_build_object('period', p.period_code, 'from', p.period_start, 'to', p.period_end, 'frequency', p.frequency,
      'registration', (select gstin from public.gst_registrations where id = p.registration_id), 'config_version', v_cfg.version_no,
      'adjustments', coalesce((select jsonb_agg(to_jsonb(a) - 'company_id' order by a.prepared_at) from public.gst_return_adjustments a where a.period_id = p.id and a.status = 'APPROVED'), '[]'::jsonb),
      'amendments_resolved', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'source_kind', e.source_kind, 'source_id', e.source_id,
        'resolution', e.resolution, 'reason', e.resolution_reason)) from public.gst_amendment_exceptions e where e.assigned_period_id = p.id and e.status = 'RESOLVED'), '[]'::jsonb),
      'liability', private.gst_liability(p),
      -- Gate D: the GSTR-1 / GSTR-3B working is stored in the snapshot; an approved period is never recalculated.
      'returns', jsonb_build_object('GSTR1', private.gst_gstr1(p), 'GSTR3B', private.gst_gstr3b(p)));
    v_snap := gen_random_uuid();
    insert into public.gst_period_snapshots (id, company_id, period_id, version_no, config_version_id, data, totals, snapshot_hash, prepared_by, approved_by)
    values (v_snap, v_company, p.id, v_ver, v_cfg.id, v_data, v_totals,
      private.gst_hash(jsonb_build_object('data', v_data, 'totals', v_totals, 'documents',
        (select jsonb_agg(jsonb_build_array(d.source_kind, d.source_id, private.gst_hash(d.content)) order by d.source_kind, d.source_id)
         from private.gst_period_documents(v_company, p.period_start, p.period_end) d))), p.prepared_by, auth.uid());
    insert into public.gst_snapshot_documents (company_id, snapshot_id, source_kind, source_id, document_no, document_date, content_hash, amounts)
    select v_company, v_snap, d.source_kind, d.source_id, d.document_no, d.document_date, private.gst_hash(d.content), d.amounts
    from private.gst_period_documents(v_company, p.period_start, p.period_end) d;
    insert into public.gst_period_current_snapshot (period_id, company_id, snapshot_id) values (p.id, v_company, v_snap)
    on conflict (period_id) do update set snapshot_id = excluded.snapshot_id, set_at = now();
    update public.gst_return_periods set status = 'APPROVED', approved_by = auth.uid(), approved_at = now(), updated_at = now(), row_version = row_version + 1
    where id = p.id returning * into p;
    perform private.gst_period_event(p, 'SNAPSHOT', v_from, null, jsonb_build_object('snapshot_id', v_snap, 'version', v_ver));
    perform private.gst_period_event(p, 'APPROVED', v_from, p_reason, jsonb_build_object('snapshot_id', v_snap));
  elsif v_action = 'CLOSE' and p.status = 'APPROVED' then
    if p.prepared_by = auth.uid() then
      raise exception 'Maker-checker: the person who prepared the period cannot close it.' using errcode = '42501';
    end if;
    update public.gst_return_periods set status = 'CLOSED', closed_by = auth.uid(), closed_at = now(), updated_at = now(), row_version = row_version + 1
    where id = p.id returning * into p;
    perform private.gst_period_event(p, 'CLOSED', v_from, p_reason);
  elsif v_action = 'REOPEN' and p.status in ('APPROVED', 'CLOSED') then
    -- Gate D: a return recorded as filed on the GST portal is not reopened here; amend it in a later return (or void a wrong filing record).
    if exists (select 1 from public.gst_return_filings f where f.period_id = p.id and f.status = 'RECORDED') then
      raise exception 'A return of % is recorded as filed; amend it in a later return, or void a wrong filing record first.', p.period_code using errcode = 'P0001';
    end if;
    if length(btrim(coalesce(p_reason, ''))) < 10 then
      raise exception 'Reopening needs a reason of at least 10 characters.' using errcode = '22023';
    end if;
    -- The approved snapshot stays exactly as it is; a later approval adds version n+1 and moves the pointer.
    update public.gst_return_periods set status = 'OPEN', prepared_by = null, prepared_at = null, approved_by = null, approved_at = null, closed_by = null, closed_at = null,
      updated_at = now(), row_version = row_version + 1 where id = p.id returning * into p;
    perform private.gst_period_event(p, 'REOPENED', v_from, p_reason);
  else
    raise exception 'Action % is not possible while the period is %.', lower(v_action), lower(replace(p.status, '_', ' ')) using errcode = 'P0001';
  end if;
  return private.gst_period_json(p.id);
end;
$$;

drop function if exists public.gst_period_readiness(uuid);
drop function if exists public.gst_control_report(text, jsonb);
drop function if exists private.gst_period_lifecycle(public.gst_return_periods);
drop function if exists private.gst_close_controls(public.gst_return_periods);
drop function if exists private.gst_months(date, date);
drop function if exists private.gst_disclaimer();
