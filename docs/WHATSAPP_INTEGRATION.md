# WhatsApp (Meta Cloud API) — onboarding guide for the administrator

This guide connects the support number to **Support Centre → WhatsApp** through Meta's official WhatsApp Business
Platform Cloud API. Zoho Bigin is not used for sending, receiving, storing or routing messages. WhatsApp Web
automation, QR sessions and unofficial libraries are not used either.

- **Database:** `supabase/migrations/20261213090000_whatsapp_cloud.sql`, rollback `supabase/rollback/20261213090000_whatsapp_cloud_down.sql`.
- **Edge Functions:** `whatsapp-webhook`, `whatsapp-webhook-verify`, `whatsapp-send-message`, `whatsapp-send-template`, `whatsapp-media-download`, `whatsapp-sync-status`.
- **Tests:** `npm run test:db:whatsapp`, `tests/unit/whatsapp-functions.test.ts`, `tests/unit/support-whatsapp-model.test.ts`, and the UI smoke step "Support WhatsApp".

> **The ERP never disconnects, deletes, migrates or re-registers the live 1800 number.** Every step below that
> touches the number is done by you, in Meta's tools or with Meta / a Meta partner, after you have confirmed it is safe.

---

## 0. Preflight: what the ERP can and cannot know

What the codebase shows:
- There is no WhatsApp connector, no Meta Graph API code and no Zoho Bigin code in this ERP.
- Before this change, the Support Centre had only a generic "WhatsApp" channel record, and replies were refused while it was not connected.
- How the 1800 number is registered today **cannot be read from code**. You must confirm it in Meta Business Suite / WhatsApp Manager and with Zoho.

Choose one of these under **Support → Settings → WhatsApp → "How is the support number used today?"**:

| Situation | What it means | What has to happen before the ERP can use it |
|---|---|---|
| **WhatsApp Business app only** | The number is used in the phone app | Meta's docs say an existing WhatsApp number must first be deleted from the app, **or** onboarded through a partner that supports Business-app onboarding (coexistence). Deleting loses the app chat history, and the number can't go back to the app unless it's deregistered from Cloud API. |
| **Through a Business Solution Provider** (for example the current Zoho Bigin connection) | The number is registered on the WhatsApp Business Platform under the provider's setup | The number has to be moved to **your** WhatsApp Business Account through Meta's supported migration (with the provider / Meta), and routing through Bigin retired. |
| **Supported coexistence** | Business app + Cloud API at the same time | Must be onboarded through an approved Meta partner. Meta's documented requirements include WhatsApp Business app 2.24.17+, a 24-hour history-sync window, 20 messages/second fixed throughput, and windows opened only by messages after onboarding. |
| **Already on Cloud API (this WABA)** | Registered on Cloud API in your own WhatsApp Business Account | Confirm the ids and run the test. |

The setup state shown in the ERP follows from your confirmations:
**Not Configured → Number Eligibility Pending → Migration Required / Coexistence Pending → Webhook Pending → Connected** (or **Error**).

The **Switch on** button stays disabled until the state is **Connected**, which needs all of:
1. **Ids entered:** every Meta id and the Graph API version.
2. **Checklist confirmed:** the required checklist items, each with evidence (a Meta case / partner reference and date) where asked.
3. **Connection test passed:** Meta reports the number as `CONNECTED`, on platform `CLOUD_API`, with the configured display number. The test is read-only.
4. **Webhook verified:** the verification challenge passed with your verify token.
5. **Signed event received:** at least one correctly signed webhook event for this WhatsApp Business Account and phone number arrived.

Before it is switched on, incoming events are stored and **held**, not turned into conversations, and nothing can be sent.

## 1. Meta prerequisites (done by you)

1. A **Meta Business Portfolio** (Business Manager) that owns the **WhatsApp Business Account (WABA)**.
2. A **Meta app** (type Business) with the WhatsApp product, connected to that WABA. Note its **App ID** and **App secret** (App settings → Basic).
3. The phone number registered on the Cloud API in that WABA, after the migration / coexistence path from step 0. Note its **Phone Number ID** and display number (WhatsApp Manager → Phone numbers).
4. A **system user** in the Business Portfolio:
   - with the app and WABA assigned;
   - with a **permanent access token** holding `whatsapp_business_messaging` and `whatsapp_business_management`.
5. **Message templates** for business-initiated messages, approved in WhatsApp Manager.

## 2. Supabase Edge Function secrets

Set these with `npx supabase secrets set NAME=value`. The ERP shows only whether each is set, never its value.

| Secret | Value |
|---|---|
| `WHATSAPP_ACCESS_TOKEN` | The permanent system-user token |
| `WHATSAPP_APP_SECRET` | The Meta app secret (used to verify `X-Hub-Signature-256` on every webhook) |
| `WHATSAPP_VERIFY_TOKEN` | A random value you choose (`openssl rand -hex 32`); the same value goes into the Meta webhook settings |
| `WHATSAPP_CRON_SECRET` | A random value for the scheduler |
| `ALLOWED_ORIGINS` | The ERP origin(s) (already used by other functions) |

## 3. Deploy (after review and approval)

Apply the migration your usual way; it is not pushed automatically. Then deploy the functions:

```
npx supabase functions deploy whatsapp-send-message
npx supabase functions deploy whatsapp-send-template
npx supabase functions deploy whatsapp-webhook --no-verify-jwt
npx supabase functions deploy whatsapp-webhook-verify --no-verify-jwt
npx supabase functions deploy whatsapp-media-download --no-verify-jwt
npx supabase functions deploy whatsapp-sync-status --no-verify-jwt
```

Why `--no-verify-jwt` is safe for each of these:
- **`whatsapp-webhook`:** Meta cannot send a Supabase token, so the app-secret signature and the verify token are checked instead.
- **`whatsapp-webhook-verify`:** serves Meta's verification challenge (checked against the verify token); its admin check verifies the caller's token itself.
- **`whatsapp-media-download` and `whatsapp-sync-status`:** they check a token or the cron secret themselves.

Schedules (any scheduler, e.g. `pg_cron` + `pg_net`), each sent with the header `x-cron-secret: <WHATSAPP_CRON_SECRET>`:
- `POST …/functions/v1/whatsapp-media-download` every 1–5 minutes (downloads received media; webhook media ids expire after 7 days);
- `POST …/functions/v1/whatsapp-sync-status` hourly (connection test, template catalogue, and removal of raw webhook payloads after 30 days).

## 4. Configure in the ERP — Support → Settings → WhatsApp

1. Choose how the number is used today (step 0). Enter:
   - Business Portfolio ID, WhatsApp Business Account ID, Phone Number ID, display number and App ID;
   - the **Graph API version**: pick a supported version from Meta's Graph API changelog (v27.0 was the latest on 13 Nov 2026). The ERP never defaults or hard-codes a version.
2. **Save**, then **Test connection** (read-only).
3. Work through the **Onboarding checklist** and confirm each item when it is true, with the evidence note.
4. **Webhook**, in Meta app → WhatsApp → Configuration:
   - callback URL = the one shown in the ERP: `https://<project-ref>.supabase.co/functions/v1/whatsapp-webhook?account=<id>`;
   - verify token = `WHATSAPP_VERIFY_TOKEN`;
   - **Verify and save**, then subscribe the **messages** field (and optionally `message_template_status_update`).
   - **Check webhook subscription** in the ERP reads `GET /{WABA-ID}/subscribed_apps` and changes nothing.
5. Send a test event from the Meta webhook page, or a WhatsApp message to the number. The ERP records the signed event.
6. **Synchronise templates.** When the state is **Connected**, click **Switch on**. Held events can then be replayed from the event log.

## 5. How it behaves

- **Incoming messages:**
  - Text, image, document, audio, video, sticker, location, interactive replies and button replies are received; reactions and contacts are recorded as text; unsupported types are recorded with Meta's error.
  - Each message is stored once (unique WhatsApp message id).
  - Contacts are matched by phone number, or by the business-scoped user id when Meta omits the phone (users with usernames).
  - A customer is linked only when exactly one customer has that number.
- **Statuses:**
  - Sent / delivered / read / failed come only from Meta's status webhooks.
  - A request Meta accepted shows **Pending** until then.
  - Statuses never move backwards. Failed shows Meta's error code and details.
- **24-hour customer service window:**
  - Free-form text, images and documents are allowed only within 24 hours of the customer's last message.
  - Otherwise, and for new conversations, only **APPROVED** templates synchronised from Meta can be sent, with every placeholder filled.
  - Templates needing media headers or URL-button parameters are refused instead of being sent incomplete.
- **Sending:**
  - One request key per send, so repeated clicks send once; sends are never retried automatically.
  - A timeout or Meta 5xx shows "Pending — not confirmed".
  - Error 190 (expired or invalid token) puts the integration into **Error** and switches it off until the token is replaced and the test passes.
- **Media:**
  - Downloaded asynchronously through Meta's authenticated media endpoint, only from Meta media hosts (no redirects followed), into the private `support-attachments` bucket.
  - Limits: up to 25 MB; executables blocked; checksum checked when Meta supplies one.
  - Opened through 5-minute signed links; recordings and sensitive files keep their role rules.
- **Privacy:**
  - Raw webhook payloads are stored in a table the app cannot read, and removed after 30 days. The event log in Settings shows no message content.
  - Tokens, secrets and message bodies are never logged.

## 6. Limitations

- Not tested against Meta or a hosted Supabase project. Everything was verified locally with PGlite and fake Graph API responses.
- Field names for some media, interactive and unsupported webhook types follow Meta's documentation as far as it could be confirmed. Verify with Meta's test events before switching on.
- Outbound media: JPEG / PNG images (5 MB) and PDF / text / Office documents (25 MB, the storage bucket limit). Audio, video and stickers are received but not sent.
- Templates with media headers or dynamic URL buttons are not sent from the ERP.
- If Meta never confirms a request (timeout), the message stays "Pending — not confirmed". Check WhatsApp Manager before sending again.
