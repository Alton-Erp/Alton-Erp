-- =============================================================================
-- Rollback of 20261130090000_opening_stock_lockdown.sql
--
-- Gives signed-in users direct access to the two older opening stock functions again
-- (as granted by 20261012090400 and 20261101090000) and removes the comments. Run it
-- BEFORE rolling back 20261129090000. No data is changed.
-- =============================================================================
grant execute on function public.inventory_submit_opening_stock(jsonb, text, text, text, uuid) to authenticated;
grant execute on function public.inventory_post_opening_stock(jsonb, text, text, text, uuid) to authenticated;
comment on function public.inventory_submit_opening_stock(jsonb, text, text, text, uuid) is null;
comment on function public.inventory_post_opening_stock(jsonb, text, text, text, uuid) is null;
