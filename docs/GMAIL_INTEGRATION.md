# Google Workspace Gmail — setup guide

Connects a shared Google Workspace mailbox (for example `support@yourcompany.com`) to **Support Centre → Emails**.
Mail is read and sent through the Gmail API with server-side OAuth 2.0. Neither Zoho nor browser automation is used,
and no mailbox password is involved.

- **Database:** `supabase/migrations/20261212090000_gmail_support.sql`, rollback `supabase/rollback/20261212090000_gmail_support_down.sql`.
- **Edge Functions:** `google-oauth-start`, `google-oauth-callback`, `google-gmail-sync`, `google-gmail-webhook`, `google-gmail-send`, `google-gmail-watch-renew`.
- **Tests:** `npm run test:db:gmail`, `tests/unit/gmail-functions.test.ts`, `tests/unit/support-gmail-model.test.ts`, and the UI smoke step "Support email (Gmail)".

Nothing below has been done for you. Every value comes from your own Google Cloud project and Supabase project.

---

## 1. Google Cloud project

1. In the Google Cloud console, create a project (or choose one) owned by your Google Workspace organisation.
2. **APIs & Services → Library:** enable the **Gmail API**.
3. To use push notifications, also enable the **Cloud Pub/Sub API**. Without push, the scheduled sync still picks up mail every few minutes.

## 2. OAuth consent screen

1. **APIs & Services → OAuth consent screen.** For a mailbox inside your own Workspace, choose user type **Internal**, so only your organisation's accounts can authorise.
2. Add these scopes:
   - `https://www.googleapis.com/auth/gmail.readonly` (read the mailbox);
   - `https://www.googleapis.com/auth/gmail.send` (send as the mailbox);
   - `https://www.googleapis.com/auth/gmail.modify`, **only** if you will turn on "Mirror read to the Gmail mailbox" in the ERP. It is off by default.
3. Google classifies `gmail.readonly` and `gmail.modify` as *restricted* and `gmail.send` as *sensitive*. Google's verification and security-assessment rules depend on how the app is published. Check Google's current policy for an Internal app before going live.
4. If your Workspace admin restricts third-party apps, trust this OAuth client in the Admin console: **Security → Access and data control → API controls**.

## 3. OAuth client

1. Go to **APIs & Services → Credentials → Create credentials → OAuth client ID**, application type **Web application**.
2. **Authorised redirect URI:** enter exactly this, with no trailing slash and no query:
   ```
   https://<project-ref>.supabase.co/functions/v1/google-oauth-callback
   ```
   The ERP shows this value under **Support → Settings → Email → Server configuration**.
3. Keep the **client ID** and **client secret** for step 5. They go only into Supabase Edge Function secrets, never into the app or the database.

## 4. Pub/Sub (optional push notifications)

1. Create a topic, for example `projects/<gcp-project-id>/topics/gmail-support`.
2. On the topic, grant **publish** rights to `gmail-api-push@system.gserviceaccount.com` (role *Pub/Sub Publisher*). If your organisation uses domain-restricted sharing, an exception is needed for this account.
3. Create a **push** subscription on the topic:
   - **Endpoint:**
     ```
     https://<project-ref>.supabase.co/functions/v1/google-gmail-webhook?token=<GMAIL_PUSH_TOKEN>
     ```
     `<GMAIL_PUSH_TOKEN>` is the random value you set as a secret in step 5.
   - **Acknowledgement deadline:** 60 seconds is recommended. A redelivered notification is recognised and ignored.
   - **Optional, recommended:** enable *authentication* with a service account and set an audience, for example the endpoint URL without the token. Then set `GMAIL_PUSH_AUDIENCE` and `GMAIL_PUSH_SERVICE_ACCOUNT` in step 5. The function then also verifies Google's signed token.
4. In the ERP, turn on **Push notifications** and enter the topic name `projects/<gcp-project-id>/topics/gmail-support`.

A notification contains only the mailbox address and a history number. The functions always fetch the mail itself from the Gmail API.

## 5. Supabase Edge Function secrets

Set these with `npx supabase secrets set NAME=value`, or in the Supabase dashboard under Edge Functions → Secrets:

| Secret | Value |
|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` | The OAuth client ID from step 3 |
| `GOOGLE_OAUTH_CLIENT_SECRET` | The OAuth client secret from step 3 |
| `GOOGLE_OAUTH_REDIRECT_URI` | `https://<project-ref>.supabase.co/functions/v1/google-oauth-callback` (must match step 3 exactly) |
| `GOOGLE_TOKEN_ENCRYPTION_KEY` | 32 random bytes, base64: `openssl rand -base64 32`. Encrypts the stored refresh token (AES-256-GCM). If you change it, reconnect the mailbox. |
| `GOOGLE_APP_URL` | The https address of the ERP, for example `https://erp.yourcompany.com`. The browser returns there after authorising. |
| `GMAIL_PUSH_TOKEN` | A random value for the push endpoint URL: `openssl rand -hex 32` (push only) |
| `GMAIL_PUSH_AUDIENCE` | Optional: the audience configured on the push subscription |
| `GMAIL_PUSH_SERVICE_ACCOUNT` | Optional: the service account email of the push subscription |
| `GOOGLE_CRON_SECRET` | A random value the scheduler sends as the header `x-cron-secret` |
| `ALLOWED_ORIGINS` | The ERP origin(s), comma-separated (already used by other functions) |

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are provided by Supabase. The service-role key stays inside the functions.

## 6. Deploy (after review and approval)

Apply the migration your usual way; it is not pushed automatically. Then deploy the functions:

```
npx supabase functions deploy google-oauth-start
npx supabase functions deploy google-gmail-send
npx supabase functions deploy google-oauth-callback --no-verify-jwt
npx supabase functions deploy google-gmail-webhook --no-verify-jwt
npx supabase functions deploy google-gmail-sync --no-verify-jwt
npx supabase functions deploy google-gmail-watch-renew --no-verify-jwt
```

Why `--no-verify-jwt` is safe for each of these:
- **`google-oauth-callback`:** Google redirects the browser there, and the single-use OAuth state is the check.
- **`google-gmail-webhook`:** Pub/Sub cannot send a Supabase token, so the URL token (and optionally the Pub/Sub OIDC token) is checked instead.
- **`google-gmail-sync` and `google-gmail-watch-renew`:** they check either an administrator's token or the cron secret themselves.

## 7. Schedules

| Function | When | Why |
|---|---|---|
| `google-gmail-sync` | Every 2 minutes | One small batch: mailbox history, queued messages and attachments, a two-day reconciliation every 15 minutes. While work is left, batches continue by themselves; this schedule is the safety net when a batch chain stops |
| `google-gmail-watch-renew` | Daily | Gmail stops push unless `watch` is renewed at least every 7 days; Google recommends daily |

Each run is a `POST` with the header `x-cron-secret: <GOOGLE_CRON_SECRET>`, for example from `pg_cron` + `pg_net` or any scheduler:

```
curl -X POST https://<project-ref>.supabase.co/functions/v1/google-gmail-sync -H "x-cron-secret: <GOOGLE_CRON_SECRET>"
```

## 8. Connect in the ERP

1. Go to **Support → Settings → Email**. Under *Server configuration*, every required secret must show **Configured**.
2. Enter the shared mailbox address, sender name and signature, plus the push settings if used. Then **Save**. The status is **Setup Required**.
3. Click **Connect Google Workspace** and sign in **as the shared mailbox**. Another account is refused, and its tokens are revoked.
4. You return to the ERP, which shows **Connected**. The first sync stores the last *N* days of mail (default 7).
5. Use **Test connection**, send a test email to the mailbox, and check that it appears under **Support → Emails**.
6. Reply to it from the ERP. The status shows **Sent** only after Gmail returned the message id. **Pending** means Gmail did not confirm yet; the next sync confirms it. **Failed** means Gmail refused the message, and the reason is shown.

**Disconnect** stops the push watch, revokes the token at Google and deletes it from the database. If Google does not confirm the revocation, the ERP says so: remove the app from the account's third-party access. If consent is revoked or the token expires, the status becomes **Reauthorization Required**. Use **Reconnect Google Workspace**.

## 9. How it behaves

- **Matching:** an incoming email is linked to a customer only when exactly one customer has the sender's address. Shared or unknown addresses are never merged automatically.
- **Threading:** by Gmail thread id, then by `In-Reply-To` / `References`. Replies keep the subject (`Re: …`) and send `In-Reply-To`, `References` and the Gmail `threadId`.
- **HTML:** sanitised on the server (allow-list) and shown only in a sandboxed frame without scripts or remote content. Images are not loaded.
- **Attachments, received:** stored in the private `support-attachments` bucket up to the configured size (default 10 MB). Executables and scripts are listed but never stored. Files open through 5-minute signed links.
- **Attachments, sent:** PDF, images, text, CSV and Office documents, up to 10 files and 10 MB in total. The type and size are checked in the browser, the database and the Edge Function.
- **Repeated clicks:** one request key per compose window, so a repeated click never sends twice. Sends are never retried automatically.
- **Push notifications:** deduplicated by the Pub/Sub message id. Administrators can **Replay** a notification; storing is idempotent.
- **Logs:** tokens, codes, state values, message bodies and addresses are never logged.

## 10. Limitations

- Not tested against a real Google Workspace or a hosted Supabase project. Everything was verified locally with PGlite and fake Google responses.
- Messages are sent through the Gmail `messages.send` JSON endpoint with a 10 MB attachment limit. Larger uploads (the `/upload` endpoint) are not implemented.
- Only mail in **Inbox** or **Sent** is stored. Mail that a Gmail filter archives straight away is not.
- When "mirror read" is off (the default), read / unread is tracked in the ERP only.
- Files uploaded in the compose window and then not sent stay in the private bucket's `outbox/` folder.
- The ERP's own `Message-ID` is used to confirm Pending sends. If Gmail ever rewrote it, such an email would stay Pending: check the mailbox's Sent folder.

## Email workspace (migration 20261222090000)

`/support/emails` works like an email client:

- **App rail:** Mail, Chat (WhatsApp) and Contacts (support customers). Calendar is shown disabled because the ERP has no calendar module.
- **Navigation:** Compose, the folders with counts, and Labels.
- **Search bar** with an advanced-search panel.
- **List:** select all, refresh, bulk actions and paging.
- **Reading view** with collapsible messages and the support details (ticket, status, priority, agent, customer and ERP customer, internal notes).
- **Floating compose window.**

It keeps the existing architecture:

- **Receiving:** `google-gmail-sync` / `support_gmail_ingest`, unchanged.
- **Sending:** `google-gmail-send`, unchanged except for formatting.
- **Messages:** `support_email_thread` and the stored emails. No new email table and no new Edge Function.

**Mailbox state lives in the ERP** (the connection is read + send only). Star, Important, Snooze, Archive, Spam, Trash
and read / unread are kept per conversation for the shared support mailbox. They are not applied to the Gmail mailbox,
and "Report spam" does not report to Google. When "mirror read" (gmail.modify) is enabled, marking read is mirrored
to Gmail, as before. Trash never deletes anything: support history is kept, and a thread can be moved back.
A thread that is archived or snoozed returns to the Inbox when the customer writes again, or when the snooze time passes.

| Folder | Shows |
|---|---|
| Inbox | received threads not archived, snoozed, spam or trash (unread count) |
| Starred / Important / Snoozed | flagged threads (outside Spam and Trash) |
| Sent | threads with an email sent from the mailbox |
| Drafts | your own drafts (existing form drafts, form key `support.email`; private to their author) |
| All mail | everything outside Spam and Trash |
| Spam / Trash | threads moved there in the ERP |
| Labels | the support tags (Support Settings → Tags), with unread counts |

**Search** understands `from:`, `to:` (cc included), `subject:`, `has:attachment`, `is:unread`, `is:read`,
`after:` and `before:`. Dates can be written as 2026-11-20, 2026/11/20 or 20/11/2026, and are read in the company
timezone. Any other words search subject, text, sender and recipients. Filtering runs on the server.

**Formatting:** the editor offers bold, italic, underline, links (http, https, mailto) and bulleted or numbered lists.
The browser never sends HTML. It sends a small markup (`**bold**`, `*italic*`, `++underline++`, `[text](url)`,
`- ` / `1. ` lists) with `format: "markdown"`. `google-gmail-send` then escapes everything and adds a `text/html`
part (`multipart/alternative`; the `text/plain` part has the markers removed). Without formatting the email is plain
text, exactly as before. The ERP's own copy of a formatted email shows the markup.

**Forwarding** creates a new email. The original's attachments are copied into the new email's upload folder, under
the same type and size checks as files you attach yourself.

**Migration 20261222090000** (additive; rollback in `supabase/rollback/`):

- table `support_email_thread_state`, with no app grants. It is in the ERP reset allowlist, which now has 131 tables (forced reset: 138).
- `public.support_email_mailbox(p)` (support.view, read-only).
- `public.support_email_mailbox_action(ids, action, p)` (support.reply; at most 200 threads; audited per thread).
- registry line `support.email` for drafts.

Until the migration is applied, the screen shows the unified inbox's email conversations, without folders, stars or
labels. **Deploy** the migration first, then `google-gmail-send` (for formatted emails), then the frontend.
Checks: `npm run test:db:email-mailbox`, `tests/unit/email-workspace.test.ts`, and the smoke steps "Support email (Gmail)" and "Email workspace".

## Attachments and per-email tools (migration 20261223090000)

**Attachments**

- **List rows** show up to three chips under the subject, plus "+N": an icon or a small thumbnail, a shortened name, and the full name, type and size on hover. Clicking a chip opens the preview without opening the thread.
- **In a thread**, each email shows its files as cards: images and videos with a thumbnail, other files with a type icon, and Preview / Download.
- **The viewer** (Escape closes it; arrow keys or buttons move between files) shows:
  - images: JPG, PNG, WEBP, GIF;
  - PDFs, in the browser's own viewer;
  - MP4, WebM and MOV video;
  - CSV as a table and text files as text, up to 2 MB.
- **Other files** (DOC/DOCX, XLS/XLSX, ZIP, HEIC, …) offer Download.
- **Links:** every file is reached through a 5-minute signed link of the private support bucket, created with the user's own session. The bucket's policies apply, and sensitive files appear as "Restricted" without a link, as in the thread. Nothing is uploaded or copied to render a conversation.

**Thread layout**

- Earlier emails are compact cards. Two or more in a row fold into a round count, which you click to show them.
- Unread emails, the last email, and an email opened from a link are expanded.
- Expand all / Collapse all is in the toolbar.
- A quoted earlier reply ("On … wrote:", Outlook's headers, trailing "> " lines) sits behind a "…" button. In the formatted view, the quoted blocks that mail programs mark are hidden the same way. A forwarded message is never hidden.

**Each open email** has Star, Reply and a ⋮ menu: Reply, Reply all, Forward, Print, Download message, Show original, Copy link to this email, Formatted / Plain text, Message details, Mark as unread, Add / Remove star, Report spam, Report phishing and Move to Trash.

- **Star** marks that email. The conversation is starred while one of its emails is.
- **Report spam / phishing** records the single email in the audit log. The whole conversation then moves to Spam in the ERP; Google is not told.
- **Move to Trash** moves the whole conversation, because single emails cannot be removed from one; nothing is deleted.
- Both of those ask for confirmation first.
- **Mark as unread** returns to the list, as Gmail does.
- **Show original / Download message** read Gmail's copy through `google-gmail-send` (action `original`, gmail.readonly, read-only):
  - the headers, with the SPF / DKIM / DMARC verdicts;
  - or the whole `.eml`, at most 20 MB, only for users allowed to open all of its attachments.
  - They are offered once Gmail has the email (sent and synced).
- **Emoji reactions** are not offered: the connected mailbox cannot send Gmail's reaction format.

**Migration 20261223090000** (additive; rollback in `supabase/rollback/`):

- column `support_email_thread_state.starred_emails`;
- `support_email_list_attachments(ids)` (support.view, read-only, at most 100 conversations);
- `support_email_message_state(conversation)` (support.view, read-only);
- `support_email_message_action(email, action)` (support.reply; STAR, UNSTAR, REPORT_SPAM, REPORT_PHISHING; audited);
- `support_email_original_target(email)` (support.view, read-only; used by `google-gmail-send`).

There is no new table, so the reset allowlist is unchanged. Before this migration the list keeps the paperclip, the star stays on the conversation, and "Report phishing" is not offered.

**Deploy** 20261222090000, then 20261223090000, then `google-gmail-send`, then the frontend.

Checks: `npm run test:db:email-message-tools`, `tests/unit/email-workspace.test.ts` and `tests/unit/gmail-functions.test.ts`, and the smoke step "Email message tools".

## Resumable mailbox sync (migration 20261224090000)

**Why.** `google-gmail-sync` used to do everything in one invocation:
- list up to 2,000 message ids;
- fetch up to 300 messages (`format=full`) one after another;
- download, decode and upload every attachment of each;
- then reconcile.

Supabase stops an Edge Function that exceeds its memory, wall-clock or CPU-time limit (CPU time is about 2 s per request). The caller then gets HTTP 546. A large first sync or full re-sync could not finish, and the work it had done was not saved as progress.

**Now, each invocation is one small batch under a database lock per mailbox:**

1. **Queue message ids.**
   - **History:** since the checkpoint (up to 4 pages). The checkpoint moves only past ids already saved in `support_email_sync_queue`, in the same transaction.
   - **A full re-sync's discovery:** up to 4 pages of 500 ids. The page token is saved after each page, and an expired token restarts discovery without queuing anything twice.
   - **A two-day reconciliation:** every 15 minutes.
2. **Fetch up to 12 queued messages and store each one.** Storing is idempotent by Gmail message id. Attachment parts are recorded as pending; small parts that came inside the message are stored at once.
3. **Download up to 4 attachments, within 15 MB.** A single larger file is still downloaded on its own. A failed part is retried with backoff and gives up after 5 attempts, with the reason shown.

**Limits and stopping.**
- A batch stops starting new work after 30 s, or after about 1.2 s of measured parsing and decoding. Each Gmail request times out after 15 s.
- It answers with counts and `more: true` when work is left.
- Adjust the limits with the optional settings `GMAIL_SYNC_BATCH_SIZE`, `GMAIL_SYNC_ATTACHMENTS`, `GMAIL_SYNC_ATTACHMENT_MB`, `GMAIL_SYNC_TIME_BUDGET_MS`, `GMAIL_SYNC_CPU_BUDGET_MS` and `GMAIL_SYNC_LOCK_TTL_SECONDS`.

**Background continuation.**
- When a batch leaves work and made progress, it sends a request to `google-gmail-sync` itself (`action: continue`, with `x-cron-secret`), at most 400 batches in a row.
- The scheduled run every 2 minutes picks up anything left: after a worker failure (HTTP 546), a network error, or a broken chain.
- The browser is never involved: Support Settings → Email only shows progress, polled from `support_email_sync_status`.

**Failure behaviour.**
- **Overlapping runs:** a scheduled run, a push notification and an administrator's click never overlap. The second one is told the mailbox is busy, and a Full re-sync asked for meanwhile starts with the next batch.
- **A worker that dies:** it keeps the lock until the lock expires (120 s). The next run then takes over.
- **A worker that wakes up later:** it is refused (lock lost) and changes nothing.
- **Failed messages:** a message Gmail keeps refusing is retried with backoff (1, 2, 4, 8 minutes). After 5 attempts it is shown as failed; **Retry** on the settings screen puts failed messages and attachments back.

**Data:**
- **New tables**, all with no app grants: `support_email_sync_state` (lock, checkpoint, last batch), `support_email_sync_jobs` (full re-syncs) and `support_email_sync_queue`.
- **Reset allowlist:** now 134 tables (forced reset: 141).
- **Unchanged:** no email, attachment, credential or mailbox-state row is changed or deleted, and ingest, sending and OAuth are unchanged.
- **Checkpoint mirroring:** the checkpoint is mirrored to `support_email_config.last_history_id` at the end of a run (or every 10 minutes), so the config is not rewritten (and audited) on every batch.

**Deploy order:**
1. Apply the migration `20261224090000_gmail_sync_jobs`.
2. Deploy `google-gmail-sync` and `google-gmail-webhook` (both `--no-verify-jwt`, as before).
3. Change the schedule to every 2 minutes.
4. Deploy the frontend.

The functions need `GOOGLE_CRON_SECRET`, which is already set for the scheduler. Rollback: `supabase/rollback/20261224090000_gmail_sync_jobs_down.sql` and the previous function versions.

Checks:
- `npm run test:db:gmail-sync` runs the real engine on the real SQL, against a simulated Gmail and faults: 500 and 2,000-message mailboxes, a worker killed mid-batch, expired history and page tokens, and partial attachment failures.
- Unit tests: `tests/unit/gmail-functions.test.ts` and `tests/unit/email-sync-progress.test.ts`.
- Smoke step: "Email sync progress".

## Automatic sync and live updates (migration 20261225090000)

**The schedule is in the database.** The migration creates a `pg_cron` job, `alton-gmail-sync`, that runs every 2 minutes. Each run POSTs `{ "action": "sync" }` to `google-gmail-sync` through `pg_net`, with the `x-cron-secret` header.
- The secret and the project URL are read from **Supabase Vault** at run time, so neither is ever stored in a migration.
- After applying the migration, add both once in the SQL editor:

```
select vault.create_secret('https://<project-ref>.supabase.co', 'alton_project_url');
select vault.create_secret('<GOOGLE_CRON_SECRET>', 'alton_gmail_cron_secret');
```

- Support Settings → Email shows whether the job is scheduled and the secrets are present (never their values). The SQL check is `select public.support_gmail_schedule_status();` as an administrator, or `select * from cron.job_run_details order by start_time desc limit 5;`.
- If an external scheduler already calls `google-gmail-sync`, remove it: overlapping calls are harmless (the mailbox lock answers "busy"), but they are unnecessary.
- Sync now and Full re-sync remain available as fallbacks.

**Live updates in the app.** One loop in the app shell keeps the sidebar badges and the WhatsApp, Emails and Calls screens current.
- **Realtime:** it subscribes to `support_conversations`, `support_whatsapp_messages` and `support_call_signals`. The migration adds the first two to the `supabase_realtime` publication. RLS applies, so only users with `support.view` of the company receive changes.
- **Summary:** each change reads the small `support_live_summary()` result: counts plus change stamps.
- **Fallback poll:** every 3 seconds while the tab is visible, paused while it is hidden, and immediate when the user returns.
- **Screens:** a screen reloads its list or thread in place when its stamp moves. The selected conversation, open email, compose text and reading position are kept.

**Badges:**
- **WhatsApp:** conversations with unread messages.
- **Emails:** unread received emails in the Inbox. Archived, snoozed, spam, trash and sent mail are excluded.
- **Calls:** missed incoming calls that were not answered or called back later, whose conversation is not resolved, and that nobody marked handled. Use Calls → **Mark all handled**, or **Mark handled** on a call.
