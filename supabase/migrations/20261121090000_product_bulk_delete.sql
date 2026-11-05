-- =============================================================================
-- Product Master: bulk delete of never-used (duplicate) products
--
-- Requested for Product Master → Missing Information: select products, see which are
-- duplicates, and permanently delete only products that were never used.
--
--   public.product_duplicate_hints(ids)        same name / barcode or EAN / model number / description
--                                              (caller's rights, RLS applies)
--   public.product_bulk_delete_preview(ids)    what would be deleted and what is protected, and why
--   public.product_bulk_delete(ids, phrase, reason, archive_blocked, request_id)
--
-- Safety (all enforced here, in the database):
--   * Super Admin of the caller's own company only; the company comes from the profile, never
--     from the request. Ids of other companies are reported as not found and never touched.
--   * A product is deleted only when nothing refers to it. The references are read from the
--     catalogue at run time, so tables added later are covered too:
--       - every foreign key to products (orders, invoices, purchase orders, BOMs, production,
--         outsourcing, stock batches, counts, adjustments, opening stock, customer codes …)
--       - every product id column without a foreign key (stock ledger, balances, reservations,
--         goods receipts, dispatches, returns, production / outsourcing movements …)
--       - product id arrays (stock counts, customer PO match candidates)
--       - snapshots of the product's versions (stock ledger, production, BOM lines)
--     Only the product's own version history and its stock alerts are deleted with it.
--   * The typed phrase DELETE PRODUCTS and a reason are required.
--   * One transaction: every eligible product is deleted, or (on any error) none is.
--     Protected products can be archived instead (optional, per product, existing rules apply:
--     a product with stock on hand cannot be archived).
--   * Every deleted or archived product is written to audit_logs (id, SKU, name, reason, user,
--     time) together with a summary row; refused attempts are audited too.
--   * The version history guard accepts the deletes only for rows registered for this call
--     (private.dept_purge_allows session of 20261119090000).
--
-- No table changes. Rollback: supabase/rollback/20261121090000_product_bulk_delete_down.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Where products are referenced (read from the catalogue at run time)
-- -----------------------------------------------------------------------------
create or replace function private.product_reference_sources()
returns table (table_name text, column_name text, kind text, label text)
language sql
stable
security definer
set search_path = ''
as $$
  with fks as (
    select cl.relname::text t, a.attname::text c
    from pg_constraint con
    join pg_class cl on cl.oid = con.conrelid join pg_namespace n on n.oid = cl.relnamespace
    join pg_attribute a on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
    where con.contype = 'f' and con.confrelid = 'public.products'::regclass and n.nspname = 'public'
      and cardinality(con.conkey) = 1 and cl.relname <> 'product_versions'
  ), cols as (
    select c.table_name::text t, c.column_name::text c, c.data_type::text dt, c.udt_name::text udt
    from information_schema.columns c
    join information_schema.tables tb on tb.table_schema = c.table_schema and tb.table_name = c.table_name and tb.table_type = 'BASE TABLE'
    where c.table_schema = 'public'
      -- Deleted with the product (own history and derived alerts) or the product itself.
      and c.table_name not in ('products', 'product_versions', 'inventory_alerts')
  ), found as (
    select t, c, 'fk' kind from fks
    union
    select t, c, 'column' from cols
    where udt = 'uuid' and (c = 'product_id' or c like '%\_product\_id' escape '\')
      and (t, c) not in (select t, c from fks)
    union
    select t, c, 'array' from cols
    where dt = 'ARRAY' and udt = '_uuid' and (c = 'product_ids' or c like '%\_product\_ids' escape '\')
    union
    select t, c, 'version' from cols
    where udt = 'uuid' and (c = 'product_version_id' or c = 'component_version_id' or c like '%\_product\_version\_id' escape '\')
  )
  select f.t, f.c, f.kind,
    case f.t
      when 'sales_order_lines' then 'Sales orders'
      when 'sales_invoice_lines' then 'Sales invoices'
      when 'purchase_order_lines' then 'Purchase orders'
      when 'goods_receipt_lines' then 'Goods receipts'
      when 'inventory_transactions' then 'Stock ledger entries'
      when 'inventory_balances' then 'Stock balances'
      when 'inventory_batches' then 'Stock batches'
      when 'stock_reservations' then 'Stock reservations'
      when 'inventory_adjustments' then 'Stock adjustments'
      when 'inventory_count_lines' then 'Stock counts'
      when 'inventory_counts' then 'Stock counts'
      when 'inventory_opening_lines' then 'Opening stock'
      when 'boms' then 'BOMs (as the finished product)'
      when 'bom_items' then 'BOM components'
      when 'production_orders' then 'Production orders'
      when 'production_order_materials' then 'Production order materials'
      when 'production_material_consumption' then 'Production material issues'
      when 'production_output_receipts' then 'Production output'
      when 'outsourcing_orders' then 'Outsourcing orders'
      when 'outsourcing_order_materials' then 'Outsourcing materials'
      when 'outsourcing_material_movements' then 'Outsourcing material movements'
      when 'outsourcing_receipts' then 'Outsourcing receipts'
      when 'fulfilment_lines' then 'Dispatches'
      when 'customer_return_lines' then 'Customer returns'
      when 'customer_purchase_order_lines' then 'Customer purchase orders'
      when 'customer_product_codes' then 'Customer product codes'
      when 'amazon_listings' then 'Amazon listings'
      else initcap(replace(f.t, '_', ' '))
    end
  from found f;
$$;
revoke all on function private.product_reference_sources() from public, anon, authenticated;

-- Every reference to these products (of any company), one row per product and source.
create or replace function private.product_references(p_ids uuid[])
returns table (product_id uuid, label text, ref_table text, n bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  s record;
begin
  for s in select * from private.product_reference_sources() order by 1, 2 loop
    if s.kind in ('fk', 'column') then
      return query execute format(
        'select c.%1$I, %2$L::text, %3$L::text, count(*) from public.%3$I c where c.%1$I = any ($1) group by 1', s.column_name, s.label, s.table_name)
        using p_ids;
    elsif s.kind = 'array' then
      return query execute format(
        'select u, %2$L::text, %3$L::text, count(*) from public.%3$I c cross join lateral unnest(c.%1$I) u where c.%1$I && $1 and u = any ($1) group by 1',
        s.column_name, s.label, s.table_name)
        using p_ids;
    else
      return query execute format(
        'select v.product_id, %2$L::text, %3$L::text, count(*) from public.%3$I c join public.product_versions v on v.id = c.%1$I
         where v.product_id = any ($1) group by 1', s.column_name, s.label || ' (earlier versions)', s.table_name)
        using p_ids;
    end if;
  end loop;
end;
$$;
revoke all on function private.product_references(uuid[]) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 2. Shared checks
-- -----------------------------------------------------------------------------
-- Company of an active Super Admin caller (from the profile; never from the request).
create or replace function private.product_bulk_delete_company()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor   uuid := auth.uid();
  v_company uuid;
begin
  if v_actor is null then
    raise exception 'Not authenticated.' using errcode = '42501';
  end if;
  select p.company_id into v_company
  from public.profiles p join public.companies c on c.id = p.company_id
  where p.id = v_actor and p.is_active and c.is_active;
  if v_company is null or not private.user_has_role(v_actor, v_company, 'SUPER_ADMIN') then
    raise exception 'Only a Super Admin can delete products.' using errcode = '42501';
  end if;
  return v_company;
end;
$$;
revoke all on function private.product_bulk_delete_company() from public, anon, authenticated;

-- Every requested id: the product (own company only), its references, and whether it can be deleted or archived.
create or replace function private.product_bulk_delete_check(p_company uuid, p_ids uuid[])
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with req as (select distinct u id from unnest(coalesce(p_ids, '{}')) u where u is not null),
  own as (
    select p.* from public.products p join req on req.id = p.id where p.company_id = p_company
  ),
  refs as (
    select r.product_id, jsonb_agg(jsonb_build_object('label', r.label, 'table', r.ref_table, 'count', r.n) order by r.label) blockers
    from private.product_references(array(select id from own)) r group by 1
  ),
  rows as (
    select jsonb_build_object(
      'id', p.id, 'sku', p.sku, 'product_name', p.product_name, 'category', c.name,
      'standard_manufacturing_cost', p.standard_manufacturing_cost, 'mrp', p.mrp, 'hsn_code', p.hsn_code, 'gst_rate', p.gst_rate,
      'status', p.status, 'archived', p.archived_at is not null,
      'deletable', refs.blockers is null,
      'blockers', coalesce(refs.blockers, '[]'::jsonb),
      'has_stock', exists (select 1 from public.inventory_balances b where b.product_id = p.id and (b.on_hand <> 0 or b.reserved <> 0)),
      'can_archive', refs.blockers is not null and p.archived_at is null
        and not exists (select 1 from public.inventory_balances b where b.product_id = p.id and (b.on_hand <> 0 or b.reserved <> 0))
    ) j, p.sku
    from own p left join public.product_categories c on c.id = p.category_id left join refs on refs.product_id = p.id
  )
  select jsonb_build_object(
    'products', coalesce((select jsonb_agg(j order by sku) from rows), '[]'::jsonb),
    'not_found', coalesce((select jsonb_agg(req.id) from req where req.id not in (select id from own)), '[]'::jsonb),
    'deletable', (select count(*) from rows where (j ->> 'deletable')::boolean),
    'blocked', (select count(*) from rows where not (j ->> 'deletable')::boolean));
$$;
revoke all on function private.product_bulk_delete_check(uuid, uuid[]) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 3. Public functions (RPC)
-- -----------------------------------------------------------------------------
-- Duplicate indicators for these products, within the caller's company (runs with the caller's rights).
create or replace function public.product_duplicate_hints(p_ids uuid[])
returns table (product_id uuid, kind text, matches bigint, match_skus text[])
language sql
stable
security invoker
set search_path = ''
as $$
  with norm as (
    select p.id, p.company_id, p.sku,
      nullif(lower(regexp_replace(btrim(p.product_name), '\s+', ' ', 'g')), '') name_k,
      nullif(btrim(p.barcode), '') barcode_k,
      nullif(btrim(p.ean), '') ean_k,
      nullif(lower(regexp_replace(coalesce(p.model_number, ''), '[^[:alnum:]]+', '', 'g')), '') model_k,
      case when length(regexp_replace(coalesce(p.description, ''), '[^[:alnum:]]+', '', 'g')) >= 10
           then lower(regexp_replace(p.description, '[^[:alnum:]]+', '', 'g')) end desc_k
    from public.products p
  ), mine as (select * from norm where id = any (coalesce(p_ids, '{}')))
  select m.id, k.kind, count(o.id), (array_agg(o.sku order by o.sku))[1:5]
  from mine m
  cross join lateral (values ('name', m.name_k), ('barcode', coalesce(m.barcode_k, '')), ('ean', coalesce(m.ean_k, '')), ('model', m.model_k), ('description', m.desc_k)) k(kind, v)
  join norm o on o.company_id = m.company_id and o.id <> m.id and k.v is not null and k.v <> ''
    and k.v = case k.kind when 'name' then o.name_k when 'barcode' then coalesce(o.barcode_k, '') when 'ean' then coalesce(o.ean_k, '')
                          when 'model' then o.model_k else o.desc_k end
  group by m.id, k.kind;
$$;
revoke all on function public.product_duplicate_hints(uuid[]) from public, anon;
grant execute on function public.product_duplicate_hints(uuid[]) to authenticated;

-- What a bulk delete would do (nothing is changed).
create or replace function public.product_bulk_delete_preview(p_ids uuid[])
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor   uuid := auth.uid();
  v_company uuid := private.product_bulk_delete_company();
begin
  if v_actor is null or coalesce(cardinality(p_ids), 0) = 0 then
    raise exception 'Select at least one product.' using errcode = '22023';
  end if;
  if cardinality(p_ids) > 1000 then
    raise exception 'Select at most 1000 products at a time.' using errcode = '22023';
  end if;
  return private.product_bulk_delete_check(v_company, p_ids);
end;
$$;
revoke all on function public.product_bulk_delete_preview(uuid[]) from public, anon;
grant execute on function public.product_bulk_delete_preview(uuid[]) to authenticated;

-- Deletes the never-used products among p_ids in one transaction; protected ones are kept
-- (and archived instead when p_archive_blocked). Returns what happened to every product.
create or replace function public.product_bulk_delete(p_ids uuid[], p_confirmation text, p_reason text,
  p_archive_blocked boolean default false, p_request_id uuid default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor    uuid := auth.uid();
  v_company  uuid := private.product_bulk_delete_company();
  v_reason   text := btrim(coalesce(p_reason, ''));
  v_request  uuid := coalesce(p_request_id, gen_random_uuid());
  v_check    jsonb;
  v_ids      uuid[];
  v_deleted  jsonb := '[]'::jsonb;
  v_blocked  jsonb := '[]'::jsonb;
  v_failed   jsonb := '[]'::jsonb;
  v_session  uuid;
  v_n        bigint;
  v_status   text := 'COMPLETED';
  v_error    text;
  v_deny     text;
  r          jsonb;
  v_archived boolean;
  v_arch_err text;
begin
  if coalesce(cardinality(p_ids), 0) = 0 then
    v_deny := 'Select at least one product.';
  elsif cardinality(p_ids) > 1000 then
    v_deny := 'Select at most 1000 products at a time.';
  elsif p_confirmation is distinct from 'DELETE PRODUCTS' then
    v_deny := 'Type DELETE PRODUCTS to confirm.';
  elsif length(v_reason) < 3 then
    v_deny := 'Enter the reason for deleting these products.';
  end if;
  if v_deny is not null then
    insert into public.audit_logs (company_id, actor_user_id, action, resource_type, request_id, metadata)
    values (v_company, v_actor, 'products.bulk_delete_denied', 'product', v_request::text,
            jsonb_build_object('reason', v_deny, 'selected', coalesce(cardinality(p_ids), 0)));
    return jsonb_build_object('status', 'DENIED', 'error', v_deny);
  end if;

  -- One bulk delete per company at a time; the selected products cannot change meanwhile.
  perform pg_advisory_xact_lock(hashtextextended('product_bulk_delete:' || v_company::text, 0));
  perform 1 from public.products where company_id = v_company and id = any (p_ids) for update;

  -- Decided now, not from the preview: a product used since the preview is protected.
  v_check := private.product_bulk_delete_check(v_company, p_ids);
  select coalesce(array_agg((x ->> 'id')::uuid), '{}') into v_ids
  from jsonb_array_elements(v_check -> 'products') x where (x ->> 'deletable')::boolean;

  begin
    if cardinality(v_ids) > 0 then
      -- The version history guard accepts deletes only for rows registered for this call.
      insert into private.dept_purge_sessions (company_id, actor, request_id, txid)
      values (v_company, v_actor, v_request, txid_current()) returning id into v_session;
      insert into private.dept_purge_rows (session_id, table_name, row_key)
      select v_session, 'product_versions', v.id::text from public.product_versions v where v.company_id = v_company and v.product_id = any (v_ids);
      perform set_config('app.dept_purge', v_session::text, true);

      delete from public.inventory_alerts where company_id = v_company and product_id = any (v_ids);
      delete from public.erp_form_drafts where company_id = v_company and record_id = any (v_ids);
      delete from public.product_versions where company_id = v_company and product_id = any (v_ids);
      delete from public.products where company_id = v_company and id = any (v_ids);
      get diagnostics v_n = row_count;
      if v_n <> cardinality(v_ids) then
        raise exception 'expected to delete % products, deleted %', cardinality(v_ids), v_n;
      end if;

      perform set_config('app.dept_purge', '', true);
      delete from private.dept_purge_sessions where id = v_session;
    end if;

    for r in select x from jsonb_array_elements(v_check -> 'products') x loop
      if (r ->> 'deletable')::boolean then
        v_deleted := v_deleted || jsonb_build_array(r - 'blockers' - 'deletable' - 'can_archive' - 'has_stock');
        insert into public.audit_logs (company_id, actor_user_id, action, resource_type, resource_id, request_id, metadata)
        values (v_company, v_actor, 'products.bulk_deleted', 'product', r ->> 'id', v_request::text,
                jsonb_build_object('sku', r ->> 'sku', 'product_name', r ->> 'product_name', 'category', r ->> 'category', 'reason', v_reason));
      else
        v_archived := false;
        v_arch_err := null;
        if p_archive_blocked and (r ->> 'archived')::boolean is false then
          begin
            update public.products set status = 'INACTIVE', archived_at = now(),
              change_reason = left('Archived instead of deleted (linked to transactions): ' || v_reason, 500)
            where company_id = v_company and id = (r ->> 'id')::uuid;
            v_archived := true;
            insert into public.audit_logs (company_id, actor_user_id, action, resource_type, resource_id, request_id, metadata)
            values (v_company, v_actor, 'products.bulk_archived', 'product', r ->> 'id', v_request::text,
                    jsonb_build_object('sku', r ->> 'sku', 'product_name', r ->> 'product_name', 'reason', v_reason));
          exception when others then
            v_arch_err := sqlerrm;
          end;
        end if;
        v_blocked := v_blocked || jsonb_build_array(r || jsonb_build_object('archived_now', v_archived, 'archive_error', v_arch_err));
      end if;
    end loop;
  exception when others then
    -- Nothing of this attempt is kept: no product deleted, none archived.
    perform set_config('app.dept_purge', '', true);
    v_status := 'FAILED';
    v_error := left(sqlerrm, 1000);
    v_deleted := '[]'::jsonb;
    v_blocked := '[]'::jsonb;
    select coalesce(jsonb_agg(jsonb_build_object('id', x ->> 'id', 'sku', x ->> 'sku', 'product_name', x ->> 'product_name',
                     'reason', 'Not deleted: the operation failed and was rolled back (' || v_error || ').')), '[]'::jsonb)
      into v_failed from jsonb_array_elements(v_check -> 'products') x;
  end;

  insert into public.audit_logs (company_id, actor_user_id, action, resource_type, request_id, metadata)
  values (v_company, v_actor, case when v_status = 'COMPLETED' then 'products.bulk_delete' else 'products.bulk_delete_failed' end, 'product', v_request::text,
          jsonb_build_object('reason', v_reason, 'selected', cardinality(p_ids), 'deleted', jsonb_array_length(v_deleted),
            'protected', jsonb_array_length(v_blocked), 'archived', (select count(*) from jsonb_array_elements(v_blocked) b where (b ->> 'archived_now')::boolean),
            'not_found', jsonb_array_length(v_check -> 'not_found'), 'error', v_error,
            'deleted_ids', (select coalesce(jsonb_agg(d -> 'id'), '[]'::jsonb) from (select d from jsonb_array_elements(v_deleted) d limit 150) z)));

  return jsonb_build_object('status', v_status, 'error', v_error, 'request_id', v_request,
    'deleted', v_deleted, 'blocked', v_blocked, 'failed', v_failed, 'not_found', v_check -> 'not_found');
end;
$$;
revoke all on function public.product_bulk_delete(uuid[], text, text, boolean, uuid) from public, anon;
grant execute on function public.product_bulk_delete(uuid[], text, text, boolean, uuid) to authenticated;
