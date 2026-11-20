-- Rollback of 20261223090000_email_message_tools.
-- Drops the per-message functions and the starred_emails column (which emails inside a starred
-- conversation carry the star; the conversation's own star, folder and labels stay as they are).
-- No email, attachment or audit row is deleted.
drop function if exists public.support_email_list_attachments(uuid[]);
drop function if exists public.support_email_message_state(uuid);
drop function if exists public.support_email_message_action(uuid, text);
drop function if exists public.support_email_original_target(uuid);
alter table public.support_email_thread_state drop column if exists starred_emails;
