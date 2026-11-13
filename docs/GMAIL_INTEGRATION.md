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
| `google-gmail-sync` | Every 5–10 minutes | Reads mailbox history and reconciles the last two days, so a missed or dropped notification never loses an email |
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
