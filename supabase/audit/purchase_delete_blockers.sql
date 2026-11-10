-- =============================================================================
-- Purchase & GRN permanent delete: why is each draft / cancelled purchase order kept?
--
-- READ-ONLY. Run in the Supabase SQL editor of ALTON V2 (srpeewjutlyruympdznc).
-- It only selects; it changes nothing and works with or without migration 20261126090000.
-- One row per draft or cancelled purchase order, with every dependency that keeps it.
-- An order with no reason in the last column is eligible.
-- =============================================================================
select
  c.display_name                                                 as company,
  o.po_number,
  o.status,
  o.revision,
  o.created_at::date                                             as created,
  -- Goods receipts on the order (posted, or posted and reversed)
  (select string_agg(r.receipt_number || ' (' || r.status || ')', ', ' order by r.receipt_number)
     from public.goods_receipts r where r.purchase_order_id = o.id)                        as goods_receipts,
  -- Stock movements recorded against the order
  (select count(*) from public.inventory_transactions t
     where t.company_id = o.company_id and (t.document_id = o.id or t.reference_id = o.id)) as stock_movements,
  (select count(*) from public.product_purchase_cost_events e where e.purchase_order_id = o.id) as cost_history_rows,
  (select count(*) from public.documents d where d.related_entity_type = 'SUPPLIER_PO' and d.related_entity_id = o.id) as attachments,
  (select count(*) from public.approval_requests a where a.document_id = o.id and a.status = 'PENDING_APPROVAL') as pending_approvals,
  exists (select 1 from public.purchase_order_events e where e.purchase_order_id = o.id
            and e.to_status in ('APPROVED', 'SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED')) as was_opened_before,
  (select count(*) from public.erp_form_drafts f where f.record_id = o.id)                as form_drafts_deleted_with_it,
  concat_ws('; ',
    case when exists (select 1 from public.goods_receipts r where r.purchase_order_id = o.id and r.status = 'POSTED') then 'posted goods receipt' end,
    case when exists (select 1 from public.goods_receipts r where r.purchase_order_id = o.id and r.status = 'REVERSED') then 'goods receipt posted and reversed' end,
    case when exists (select 1 from public.inventory_transactions t where t.company_id = o.company_id and (t.document_id = o.id or t.reference_id = o.id)) then 'stock movements' end,
    case when exists (select 1 from public.product_purchase_cost_events e where e.purchase_order_id = o.id) then 'purchase cost history' end,
    case when exists (select 1 from public.documents d where d.related_entity_type = 'SUPPLIER_PO' and d.related_entity_id = o.id) then 'attachment' end,
    case when exists (select 1 from public.approval_requests a where a.document_id = o.id and a.status = 'PENDING_APPROVAL') then 'pending approval' end,
    case when o.status = 'DRAFT' and (o.revision > 0 or exists (select 1 from public.purchase_order_events e where e.purchase_order_id = o.id
              and e.to_status in ('APPROVED', 'SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED'))) then 'draft amended after it was opened' end
  )                                                              as kept_because
from public.purchase_orders o
join public.companies c on c.id = o.company_id
where o.status in ('DRAFT', 'CANCELLED')
order by c.display_name, o.po_number;
