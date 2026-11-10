-- =============================================================================
-- Opening stock: no way around the Product Master Cost
--
-- 20261129090000 added inventory_submit_opening_stock_at_cost and
-- inventory_post_opening_stock_at_cost, which set every line's unit cost from the
-- Product Master Cost on the server. The older functions below accept any unit cost,
-- so they are no longer callable by application users (anon / authenticated, and
-- PUBLIC). They stay in place, unchanged, for internal use:
--   * the *_at_cost functions are SECURITY DEFINER (owned by the migration owner) and
--     call them with the owner's rights, so submission, duplicate protection,
--     approval, posting, stock ledger, valuation and audit behave exactly as before;
--   * inventory_review_opening_stock (approval of a staged document) is unchanged and
--     still callable: it posts the lines as staged, i.e. at the Product Master Cost;
--   * service_role (server-side Supabase key, never in the browser) keeps its access.
--
-- No data is changed. Posted opening stock and every other record stay as they are.
-- Rollback: supabase/rollback/20261130090000_opening_stock_lockdown_down.sql
-- =============================================================================

revoke execute on function public.inventory_submit_opening_stock(jsonb, text, text, text, uuid) from public, anon, authenticated;
revoke execute on function public.inventory_post_opening_stock(jsonb, text, text, text, uuid) from public, anon, authenticated;

comment on function public.inventory_submit_opening_stock(jsonb, text, text, text, uuid) is
  'Internal since 20261130090000: called by inventory_submit_opening_stock_at_cost (unit cost = Product Master Cost). Not callable by application users.';
comment on function public.inventory_post_opening_stock(jsonb, text, text, text, uuid) is
  'Internal since 20261130090000: called by inventory_post_opening_stock_at_cost (unit cost = Product Master Cost). Not callable by application users.';
