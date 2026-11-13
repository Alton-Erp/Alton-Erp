# Support Centre — implementation reference

How the Alton ERP Support Centre is built: one native data model for phone (Acefone / Servetel), email (Google
Workspace Gmail) and WhatsApp (Meta Cloud API). Setup steps are in [SUPPORT_INTEGRATION_SETUP.md](SUPPORT_INTEGRATION_SETUP.md).

Status: **implemented and verified locally only.** Nothing is deployed, no migration is applied to a hosted database,
and no provider account has been connected.

## 1. Migrations (apply in order; each has a rollback in `supabase/rollback/`)

| Migration | Adds |
|---|---|
| `20261210090000_support_centre` | Core model: customers, conversations, messages, tickets, notes, attachments, tags, SLA policies, automation rules, channel accounts, integration events, knowledge base, audit; `support.*` permissions; private `support-attachments` bucket |
| `20261211090000_acefone_telephony` | Phone settings, agent lines, calls, call events; webhook ingestion; click-to-call; call records; recordings |
| `20261212090000_gmail_support` | Email settings, encrypted OAuth credentials, OAuth states, email messages, templates; ingestion, sending, push and watch state |
| `20261213090000_whatsapp_cloud` | WhatsApp settings and onboarding state, raw webhook events, templates, threads, messages, statuses; window and template rules |
| `20261214090000_support_unified` | Unified inbound trigger, ticket rules, business calendar and holidays, escalation levels, assignment rules, escalation history, SLA monitor, notifications, unified reports, integration health |

The ERP reset allowlist covers every support table (125 tables in the standard reset, 132 in the force reset).

## 2. Unified conversation engine

Each provider stores its traffic in `support_conversations` and `support_messages`:
- every row keeps the provider's original id (Acefone call id / ref id / uuid, Gmail message and thread ids, WhatsApp message id);
- each id has a unique index, so a retried webhook or a re-synchronised message can never be inserted twice.

After an inbound provider message or call is stored, the trigger `support_messages_on_inbound` runs the common steps for all channels:
1. **Integration event:** record an `INBOUND` integration event (provider, external id, conversation), keyed by the message id.
2. **Notification:** a WhatsApp message, an email, a missed call or a customer reply notifies the assigned agent, or everyone with `support.reply`.
3. **Reopen:** reopen a resolved or closed ticket when the customer replies (if that rule is on).
4. **Ticket rules:** apply the ticket rules (§3). One ticket per conversation.
5. **Failure handling:** if any step fails, the provider message is still kept and an `ERROR` event is logged for the health dashboard.

Steps done by each provider before the trigger runs:
- **Customer identification:** a customer is linked only on exactly one match, by phone or email. Shared or unknown contacts are never merged.
- **Conversation update:** find or create the conversation, update `last_activity_at` and the unread count.

Incoming calls notify agents while ringing (`support_calls_incoming_notify`).

## 3. Ticket automation (`support_ticket_rules`; Support → Settings → Ticket rules)

| Rule | Default |
|---|---|
| Ticket for every new customer conversation, or only when an agent creates one | Agent request only |
| Ticket for missed calls (priority configurable) | Off |
| Ticket for emails whose subject (optionally text) contains a keyword | Off |
| Ticket for WhatsApp messages containing a keyword | Off |
| Reopen a resolved ticket when the customer replies | On |
| Escalate breached tickets of chosen priorities (default urgent) | Off |

**Assignment rules** (`support_assignment_rules`) set the agent and/or department of new tickets without an agent. The first match by channel and priority wins.

## 4. SLA

- **Policies:** `support_sla_policies` holds the first-response and resolution targets for each priority.
- **Business calendar:** `support_business_calendar` (working days, hours, time zone; off = 24×7) and `support_holidays`. Due dates are calculated in business minutes by `private.support_business_add` and `private.support_business_minutes`.
- **Customer waiting-time exclusion:** while a ticket is `WAITING_CUSTOMER`, the clock is paused (`sla_paused_at`). The paused business minutes are added to the due dates on resume (`sla_paused_minutes`).
- **Monitor:** `public.support_sla_run()` (service role; schedule every 5 minutes) records, each at most once per ticket, target and level:
  - an SLA warning (configurable %, default 80);
  - a breach;
  - escalation levels (`support_sla_escalation_levels`: after N minutes, reassign, department, raise priority, notify).
  These go into `support_ticket_escalations`, with ticket events and notifications. Administrators can run it from the SLA tab.
- **Display:** the ticket page shows remaining or overdue time for first response and resolution, the paused time and the escalation history (`support_ticket_sla`).

## 5. Notifications (existing ERP notification centre)

They are sent through `private.notify` / `private.notify_permission`: deduplicated, and they respect user preferences.

| Type | When |
|---|---|
| `SUPPORT_WHATSAPP_RECEIVED` | New WhatsApp message (no earlier reply in the conversation) |
| `SUPPORT_EMAIL_RECEIVED` | New email (no earlier reply in the conversation) |
| `SUPPORT_CALL_INCOMING` | Inbound call starts ringing |
| `SUPPORT_CALL_MISSED` | Missed call |
| `SUPPORT_TICKET_ASSIGNED` | Ticket assigned or reassigned |
| `SUPPORT_CUSTOMER_REPLY` | Customer replies to an answered conversation or a ticket; ticket reopened |
| `SUPPORT_SLA_WARNING` | SLA warning threshold reached |
| `SUPPORT_SLA_BREACH` | SLA breached or escalated |

## 6. Reports (`support_reports_unified`, `support.view_reports`)

Reports are filtered by date range, with a CSV per section. CSV cells that start with `= + - @` are escaped so spreadsheets don't run them as formulas.

- channel-wise incoming volume;
- call answer and missed rates, average talk time;
- email and WhatsApp response time (customer turn → next reply: average, median, % within 1 hour);
- ticket volume and closure rate;
- agent workload;
- SLA compliance and escalations;
- customer satisfaction.

## 7. Integration health (`support_integration_health`, `support.manage_integrations`)

Support → Settings → Integration health shows, for each provider:
- connection status, and when a real provider API test or authorisation last succeeded;
- last synchronisation, last webhook and last successful outbound action;
- failed events in the last 7 days and the retry queue;
- expired credentials and the latest errors;
- a **Test connection** button that runs the provider's real API test on the server.

**Connected is never derived by the app:**
- **Acefone** becomes Connected only through a successful connection test.
- **Gmail** becomes Connected through the OAuth exchange plus a Gmail API call.
- **WhatsApp** becomes Connected only after the Meta test, webhook verification and the explicit switch-on.

## 8. Security

- **RLS on every support table:**
  - the app gets SELECT only, scoped by company and `support.*` permission;
  - all writes go through `SECURITY DEFINER` functions with a fixed `search_path`;
  - nothing is granted to anon.
- **Server-only data:** credentials, OAuth states and raw WhatsApp webhooks have no app grants at all. Provider and scheduler functions are service-role only.
- **Company isolation is tested:** a full administrator of another company reads 0 rows of every readable support table. The record functions refuse other companies' ids. Storage objects are readable only through attachment rows of your company.
- **Webhook authentication:**
  - Acefone: secret URL token, plus an optional IP allowlist;
  - Gmail Pub/Sub: URL token, plus optional OIDC verification;
  - WhatsApp: `X-Hub-Signature-256` HMAC with the app secret, plus the verify-token challenge.
- **Replay and duplicates:** event keys, Pub/Sub message ids, WhatsApp change hashes and unique provider ids.
- **Outbound rate limits per user:** calls 10/min, email 20/min, WhatsApp 30/min. There are also inbound webhook limits.
- **Secrets:**
  - they live only in Edge Function secrets; the Gmail refresh token is stored AES-256-GCM-encrypted;
  - settings pages show yes/no only;
  - a unit test scans the code and the built bundle for credentials, service-role use in the browser, tokens in browser storage, and unsafe logging.

## 9. Tests

| Command | Covers |
|---|---|
| `npm run test:db:support` | Core model, permissions, matching, SLA basics |
| `npm run test:db:acefone` | Call webhooks, duplicates, status order, click-to-call, records, recordings, rollback |
| `npm run test:db:gmail` | OAuth state, credentials, ingest, threading, attachments, send outcomes, push, replay, rollback |
| `npm run test:db:whatsapp` | Setup state machine, webhooks, statuses, window and templates, media, token expiry, rollback |
| `npm run test:db:unified` | All three providers through one engine, duplicates, notifications, ticket rules, reopen, assignment, business-hours SLA, pause, warnings / breaches / escalations, reports, health, downtime, token expiry, RLS / RBAC / company isolation / storage, rollback |
| `npm run test:unit` | Edge Function handlers with fake providers (Acefone, Google, Meta), sanitiser, MIME, crypto, signatures, model helpers, secrets scan |
| `npm run test:ui` | Browser smoke steps for the Support Centre, phone, email, WhatsApp and unified settings / reports |

Mocked in those tests: every provider API (Acefone, Google OAuth / Gmail / Pub/Sub, Meta Graph API), Supabase Storage and Edge Function deployment.
