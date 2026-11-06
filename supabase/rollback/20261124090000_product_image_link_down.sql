-- Rollback of 20261124090000_product_image_link.sql
--
-- Removes the image-link validation, normalisation and audit triggers and
-- restores private.product_version_attrs of 20261118090000 (still leaving out a kept
-- image_url, so kept links never create product versions). Uploaded images
-- (product_image_path) are not touched.
--
-- The column products.image_url and its links are KEPT by default, so no data
-- is lost; the app without this feature simply ignores it. To remove the links
-- as well, run the optional block at the end (this deletes every saved link).

begin;

drop trigger if exists products_image_link_audit on public.products;
drop trigger if exists products_image_url_normalise on public.products;
drop function if exists private.audit_product_image_link();
drop function if exists private.product_image_url_normalise();

alter table public.products drop constraint if exists products_image_url_check;
drop function if exists private.product_image_url_valid(text);

do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'products' and column_name = 'image_url') then
    revoke insert (image_url), update (image_url) on public.products from authenticated;
  end if;
end;
$$;

create or replace function private.product_version_attrs(p public.products)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select to_jsonb(p) - array['id', 'company_id', 'created_at', 'created_by', 'updated_at', 'updated_by', 'change_reason',
                             'has_bom', 'product_image_path', 'image_url', 'archived_at', 'archived_by'];
$$;

revoke all on function private.product_version_attrs(public.products) from public, anon, authenticated;

commit;

-- Optional, deletes every saved image link (run only if the links are not needed):
-- begin;
-- create or replace function private.product_version_attrs(p public.products)
-- returns jsonb language sql immutable set search_path = '' as $$
--   select to_jsonb(p) - array['id', 'company_id', 'created_at', 'created_by', 'updated_at', 'updated_by', 'change_reason',
--                              'has_bom', 'product_image_path', 'archived_at', 'archived_by'];
-- $$;
-- alter table public.products drop column if exists image_url;
-- commit;
