# Support Centre — integration setup

The administrator's checklist to take the Support Centre live. The provider guides have the details:
[Gmail](GMAIL_INTEGRATION.md), [WhatsApp](WHATSAPP_INTEGRATION.md); for Acefone see §3 below.
The architecture is described in [SUPPORT_IMPLEMENTATION.md](SUPPORT_IMPLEMENTATION.md).

> Nothing here is done automatically. Apply migrations, set secrets, deploy functions and change provider accounts
> only after review and approval. The live 1800 number and existing Zoho Bigin setup are never changed by the ERP.

## 1. Database

Apply, in order, with your usual reviewed process (not `db push` from a laptop):
`20261210090000_support_centre`, `20261211090000_acefone_telephony`, `20261212090000_gmail_support`,
`20261213090000_whatsapp_cloud`, `20261214090000_support_unified`.

Then grant the `support.*` permissions to the right roles (Users & Roles) and create the support agents
(Support → Settings → Agents).

## 2. Schedules (pg_cron + pg_net, or any scheduler)

| What | Frequency | Call |
|---|---|---|
| SLA monitor | every 5 min | `select public.support_sla_run();` (pg_cron, runs in the database) |
| Acefone call records | every 15 min | `POST /functions/v1/acefone-sync-cdr`, header `x-cron-secret: <ACEFONE_CRON_SECRET>` |
| Acefone recordings (if enabled) | hourly | `POST /functions/v1/acefone-recording-sync`, same header |
| Gmail sync / reconciliation | every 5–10 min | `POST /functions/v1/google-gmail-sync`, header `x-cron-secret: <GOOGLE_CRON_SECRET>` |
| Gmail push watch renewal | daily | `POST /functions/v1/google-gmail-watch-renew`, same header |
| WhatsApp media download | every 1–5 min | `POST /functions/v1/whatsapp-media-download`, header `x-cron-secret: <WHATSAPP_CRON_SECRET>` |
| WhatsApp status / templates / payload clean-up | hourly | `POST /functions/v1/whatsapp-sync-status`, same header |

## 3. Acefone / Servetel (phone)

1. Ask Acefone support to enable API access and webhooks on the account.
2. Generate the **API token**. If you will use "customer first" calling, also generate the **Click-to-Call Support API key**; it is a separate credential.
3. Confirm with Acefone which API host your account uses, how call-record API calls are authenticated, whether recordings may be downloaded and for how long they are kept, and their webhook source IPs.
4. Set the secrets `ACEFONE_API_TOKEN`, `ACEFONE_C2C_SUPPORT_API_KEY` (Support mode only), `ACEFONE_WEBHOOK_SECRET` (random) and `ACEFONE_CRON_SECRET` (random).
5. Deploy:
   - `acefone-click-to-call` normally;
   - `acefone-webhook --no-verify-jwt`;
   - `acefone-sync-cdr --no-verify-jwt`;
   - `acefone-recording-sync --no-verify-jwt`.
6. In Support → Settings → Phone:
   - enter the toll-free number and host, and map agent lines;
   - create one Acefone webhook per trigger (POST, JSON) with the URLs shown there;
   - run **Test connection** (the status becomes Connected only when it passes).

## 4. Google Workspace (email)

Follow [GMAIL_INTEGRATION.md](GMAIL_INTEGRATION.md):
1. **Google Cloud project:** enable the Gmail API (plus Pub/Sub for push notifications).
2. **Consent screen:** Internal, with the `gmail.readonly` and `gmail.send` scopes.
3. **OAuth client:** a "Web application" client with the redirect URI `…/functions/v1/google-oauth-callback`.
4. **Pub/Sub (optional):** a topic with publish rights for `gmail-api-push@system.gserviceaccount.com`, and a push subscription to `…/google-gmail-webhook?token=<GMAIL_PUSH_TOKEN>`.
5. **Secrets:** `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI`, `GOOGLE_TOKEN_ENCRYPTION_KEY`, `GOOGLE_APP_URL`, `GMAIL_PUSH_TOKEN`, `GOOGLE_CRON_SECRET`. Optionally also `GMAIL_PUSH_AUDIENCE` and `GMAIL_PUSH_SERVICE_ACCOUNT`.
6. **In the ERP:** Support → Settings → Email → **Connect Google Workspace**, signed in as the shared mailbox.

## 5. Meta WhatsApp Cloud API

Follow [WHATSAPP_INTEGRATION.md](WHATSAPP_INTEGRATION.md). First confirm how the 1800 number is used today. If it is used through Zoho Bigin (a provider) or the Business app, Meta's migration or coexistence path is required before Cloud API use.

Then:
1. Business Portfolio, WABA, Meta app, and a system user with a permanent token.
2. Secrets: `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_CRON_SECRET`.
3. Webhook callback: `…/whatsapp-webhook?account=<id>`.
4. In Support → Settings → WhatsApp: the checklist, the Test connection, then **Switch on**.

## 6. Support behaviour

In Support → Settings:
- **Ticket rules:** which events create tickets; reopen on reply; escalation of breached tickets; assignment rules.
- **SLA policies:** targets per priority; business hours and holidays; escalation levels; a manual SLA check.
- **Integration health:** status of all three providers and a Test connection for each.

## 7. Go-live checks

Do each of these on a test record first:
1. **Calls:** call the toll-free number. The incoming-call panel appears. Hang up unanswered → a missed-call notification (and a ticket, if that rule is on).
2. **Email:** send an email to the support mailbox. It appears in Emails. Reply from the ERP → the status shows **Sent** only after Gmail accepts it.
3. **WhatsApp:** send a WhatsApp message. It appears in WhatsApp. Reply within 24 hours → Pending, then Sent / Delivered / Read from Meta's status updates.
4. **Integration health:** Connected for each provider, the last webhook updated, no failed events.
5. **SLA:** let a test ticket pass its first-response target. The SLA monitor warns and then records the breach and any escalation.
6. **Reports:** reports show the test traffic for today, and each CSV downloads.

## 8. What still needs external accounts or approvals

- Acefone: API and webhook enablement, the token and Support API key, the host, the recording policy, and webhook IPs.
- Google: the Cloud project, OAuth client, consent screen (restricted Gmail scope; follow Google's current policy for Internal apps), Pub/Sub, and Workspace admin trust for the app.
- Meta: Business Portfolio and WABA, app review / permissions, the system-user token, approved templates, and **the 1800 number's migration or coexistence approval**.
- Supabase: secrets, function deployment, migrations and schedules, applied by you after review.
