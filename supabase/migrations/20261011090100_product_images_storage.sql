-- =============================================================================
-- Phase 3: product image storage
--
-- Private bucket `product-images`. Object names must be
--   <company_id>/<product_id>/<file>
-- Access is decided by the company folder:
--   read  -> products.read in that company
--   write -> products.create or products.update in that company
-- Images are served to the app with short-lived signed URLs (bucket is private).
-- =============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('product-images', 'product-images', false, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

-- Safe uuid parse for folder names (malformed names simply match nothing).
create or replace function private.try_uuid(p_value text)
returns uuid
language plpgsql
immutable
set search_path = ''
as $$
begin
  return p_value::uuid;
exception when others then
  return null;
end;
$$;

revoke all on function private.try_uuid(text) from public, anon;
grant execute on function private.try_uuid(text) to authenticated;

-- Company that owns an object path, only if the path also names a product of
-- that company (prevents writing into arbitrary folders).
create or replace function private.product_image_company(p_name text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.company_id
  from public.products p
  where p.company_id = private.try_uuid(split_part(p_name, '/', 1))
    and p.id = private.try_uuid(split_part(p_name, '/', 2))
    and split_part(p_name, '/', 3) <> ''
    and split_part(p_name, '/', 4) = '';
$$;

revoke all on function private.product_image_company(text) from public, anon;
grant execute on function private.product_image_company(text) to authenticated;

drop policy if exists product_images_select on storage.objects;
create policy product_images_select on storage.objects
  for select to authenticated
  using (bucket_id = 'product-images'
         and private.has_permission(private.product_image_company(name), 'products.read'));

drop policy if exists product_images_insert on storage.objects;
create policy product_images_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'product-images'
              and (private.has_permission(private.product_image_company(name), 'products.create')
                   or private.has_permission(private.product_image_company(name), 'products.update')));

drop policy if exists product_images_update on storage.objects;
create policy product_images_update on storage.objects
  for update to authenticated
  using (bucket_id = 'product-images'
         and private.has_permission(private.product_image_company(name), 'products.update'))
  with check (bucket_id = 'product-images'
              and private.has_permission(private.product_image_company(name), 'products.update'));

drop policy if exists product_images_delete on storage.objects;
create policy product_images_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'product-images'
         and private.has_permission(private.product_image_company(name), 'products.update'));
