-- =============================================================================
-- Product image links (Excel "Image Link" column, Product Master form)
--
-- Inspected before this migration:
--   * products.product_image_path (20261011090000) holds an UPLOADED image: an
--     object in the private storage bucket `product-images`, named
--     <company_id>/<product_id>/<file>; the products trigger refuses any other
--     value, so it cannot hold an external URL. It stays as it is.
--   * Images are not part of product versions (product_image_path is excluded
--     in private.product_version_attrs, 20261118090000).
--
-- This migration adds products.image_url: the original external image link
-- (http / https), kept exactly as entered. The app shows the uploaded image
-- when there is one, otherwise the link. The database never downloads the
-- link (no server-side fetching), so a link cannot reach internal services.
--
--   * Validation: http or https, a host name, no spaces, no user name /
--     password, no localhost / private network addresses, at most 2048 chars.
--   * Same access as the other product fields: column grants for insert /
--     update, row security of products unchanged (company + products.create /
--     products.update).
--   * Audit: every change writes product.image_link_changed with the previous
--     and new link (the generic product.updated entry also lists the field).
--   * Versions: like the uploaded image, the link is not a versioned
--     attribute, so changing only the image creates no new product version.
--
-- Nothing existing is changed: the column starts empty for every product.
-- Rollback: supabase/rollback/20261124090000_product_image_link_down.sql
-- =============================================================================

create or replace function private.product_image_url_valid(p_url text)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_host text;
begin
  if p_url is null then
    return true;
  end if;
  if length(p_url) > 2048 or p_url ~ '[[:space:]]' then
    return false;
  end if;
  -- scheme://host[:port][/?#...]; no user info (an @ before the path).
  if p_url !~* '^https?://[^/?#@]+([/?#].*)?$' then
    return false;
  end if;
  v_host := lower(substring(p_url from '^[A-Za-z]+://([^/?#]+)'));
  v_host := regexp_replace(v_host, ':[0-9]*$', '');
  if v_host = '' or v_host ~ '^\[' then
    return false; -- IPv6 literals are not accepted
  end if;
  if v_host in ('localhost', '0.0.0.0') or v_host ~ '\.(localhost|local|internal|lan|home)$' then
    return false;
  end if;
  if v_host ~ '^(127|10|0)\.' or v_host ~ '^169\.254\.' or v_host ~ '^192\.168\.' or v_host ~ '^172\.(1[6-9]|2[0-9]|3[01])\.' then
    return false;
  end if;
  return true;
end;
$$;

revoke all on function private.product_image_url_valid(text) from public, anon;
grant execute on function private.product_image_url_valid(text) to authenticated;

alter table public.products add column if not exists image_url text;

alter table public.products drop constraint if exists products_image_url_check;
alter table public.products add constraint products_image_url_check
  check (private.product_image_url_valid(image_url));

comment on column public.products.image_url is
  'Original external image link (http/https), kept as entered. Shown when no image is uploaded (product_image_path). Never fetched by the database.';

grant insert (image_url) on public.products to authenticated;
grant update (image_url) on public.products to authenticated;

-- Blank becomes null; surrounding spaces are removed.
create or replace function private.product_image_url_normalise()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.image_url := nullif(btrim(coalesce(new.image_url, '')), '');
  return new;
end;
$$;

revoke all on function private.product_image_url_normalise() from public, anon, authenticated;

drop trigger if exists products_image_url_normalise on public.products;
create trigger products_image_url_normalise before insert or update of image_url on public.products
  for each row execute function private.product_image_url_normalise();

-- Audit: the previous and new link of every change.
create or replace function private.audit_product_image_link()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.image_url is not null then
      perform private.write_audit_log(new.company_id, 'product.image_link_changed', 'product', new.id::text,
        jsonb_build_object('sku', new.sku, 'from', null, 'to', new.image_url));
    end if;
  elsif new.image_url is distinct from old.image_url then
    perform private.write_audit_log(new.company_id, 'product.image_link_changed', 'product', new.id::text,
      jsonb_build_object('sku', new.sku, 'from', old.image_url, 'to', new.image_url));
  end if;
  return null;
end;
$$;

revoke all on function private.audit_product_image_link() from public, anon, authenticated;

drop trigger if exists products_image_link_audit on public.products;
create trigger products_image_link_audit after insert or update of image_url on public.products
  for each row execute function private.audit_product_image_link();

-- Versions: images are not versioned attributes (as for product_image_path).
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
