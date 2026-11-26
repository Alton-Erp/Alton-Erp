-- Rollback of 20261231090100_accounting_auto_posting.
--
-- Removes the automatic posting engine (scan, run, retry, dismiss, monitor). The tables of
-- 20261231090000 stay, including accounting_posting_events and every voucher already posted:
-- nothing is deleted. No business table was changed by the migration, so nothing is restored
-- there. Run this BEFORE 20261231090000_accounting_foundation_down.sql.

drop function if exists public.accounting_posting_events(jsonb);
drop function if exists public.accounting_posting_dismiss(uuid, text);
drop function if exists public.accounting_posting_retry(uuid);
drop function if exists public.accounting_posting_run(integer);
drop function if exists public.accounting_posting_scan();
drop function if exists private.accounting_process_event(uuid);
drop function if exists private.accounting_scan(uuid);
drop function if exists private.accounting_source_reversal_reason(text, uuid);
drop function if exists private.accounting_build_event(public.accounting_posting_events);
drop function if exists private.accounting_rule_label(text, text);
drop function if exists private.accounting_rule_account(uuid, text, text);
