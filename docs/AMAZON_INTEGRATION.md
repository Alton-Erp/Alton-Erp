# Amazon Sales & Profit Intelligence — setup and operation

This module adds **Amazon Intelligence** to the ERP sidebar. It brings Amazon.in sales, fees, stock and Sponsored Products advertising data into the ERP, then works out contribution per product, the break-even and target ACoS, budget allocation, inventory risk and rule-based recommendations. Advertising changes need two people: one requests the change and a different person approves it.

The module works before any credentials exist:
- **Report import:** you can upload Amazon report files (CSV or Excel). The data is stored as live data marked `CSV`.
- **Demo data:** fictitious data you can load to preview the module. It is labelled `DEMO DATA` on every page, stored separately and can be removed.

A connection is shown as **connected** only after Amazon has accepted the credentials in a successful API call (**Test connection**).

## 1. What runs where

| Part | Location | Holds credentials? |
|---|---|---|
| Pages (`/amazon/...`) | Browser | No. It calls only the RPC functions and the two Edge Functions. |
| `amazon-spapi` Edge Function | Supabase | Yes, as Edge Function secrets. Read-only Selling Partner API sync. |
| `amazon-ads` Edge Function | Supabase | Yes, as Edge Function secrets. Ads API sync, and execution of **approved** changes. |
| Tables `amazon_*` | Postgres | No. RLS restricts reads to the user's company with `amazon.read`. Browsers have no write grant on these tables. |

Access tokens are kept only in the Edge Function's memory. They are never written to the database, logs or the browser, and error messages are redacted before they are stored.

## 2. Migrations

Apply these in order (`npx supabase db push`, or paste them into the SQL Editor). They only add objects: no ERP table is changed or dropped, and no existing policy is weakened.

| File | Contents |
|---|---|
| `20261020090000_amazon_core.sql` | Permissions and role grants. Settings (safe defaults: read-only, kill switch on). Connections. Listings (ERP product mapping, unit economics). Sync jobs and errors. Daily sales and fees, inventory snapshots, campaigns, ad groups, targets, and daily campaign / product / search-term facts. Validated idempotent ingest. Import, listing, mapping and settings functions. Service-role-only functions for the Edge Functions. |
| `20261020090100_amazon_analytics.sql` | Product performance, daily series, campaign performance and detail, search terms, data status. These are read-only and permission-checked. |
| `20261020090200_amazon_actions.sql` | Recommendations, budget plans and ad change requests (request, approve or reject, cancel, service claim and result). Demo data load and clear. |

### Permissions

| Permission | Granted to | Allows |
|---|---|---|
| `amazon.read` | Super Admin, Admin, Sales Manager, Accounts Manager, Inventory Manager, Management Viewer | View all Amazon pages and exports |
| `amazon.manage` | Super Admin, Admin, Sales Manager | Import files, map listings, edit costs and analysis settings, save recommendations and plans, load or clear demo data |
| `amazon_ads.request` | Super Admin, Admin, Sales Manager | Propose an advertising change |
| `amazon_ads.approve` | Super Admin, Admin | Approve, reject or execute changes; change automation mode, limits and the kill switch |
| `amazon_integration.manage` | Super Admin, Admin | Test connections, run syncs, resume waiting jobs |

## 3. Edge Functions and secrets

Deploy:

```bash
npx supabase functions deploy amazon-spapi
npx supabase functions deploy amazon-ads
```

Set the secrets in Dashboard → Edge Functions → Secrets, or with `npx supabase secrets set NAME=value`. **Check configuration** on the settings page shows which names are set. It never shows the values.

| Secret | Function | Value |
|---|---|---|
| `AMAZON_COMPANY_CODE` | both | `company_code` of the ERP company that owns this Amazon account. Callers from other companies are refused. |
| `AMAZON_SPAPI_LWA_CLIENT_ID` | amazon-spapi | LWA client id of your SP-API app |
| `AMAZON_SPAPI_LWA_CLIENT_SECRET` | amazon-spapi | LWA client secret |
| `AMAZON_SPAPI_REFRESH_TOKEN` | amazon-spapi | Refresh token from self-authorisation |
| `AMAZON_SPAPI_REGION` | amazon-spapi | `EU` (Amazon.in is served by the EU endpoint) |
| `AMAZON_SPAPI_MARKETPLACE_IDS` | amazon-spapi | `A21TJRUUN4KGV` (Amazon.in) |
| `AMAZON_SPAPI_SANDBOX` | amazon-spapi | Optional. `true` uses the SP-API sandbox. |
| `AMAZON_TIMEZONE_OFFSET_MINUTES` | amazon-spapi | Optional. Default is `330` (India). |
| `AMAZON_ADS_CLIENT_ID` | amazon-ads | LWA client id approved for the Ads API |
| `AMAZON_ADS_CLIENT_SECRET` | amazon-ads | LWA client secret |
| `AMAZON_ADS_REFRESH_TOKEN` | amazon-ads | Refresh token from the Ads OAuth consent |
| `AMAZON_ADS_REGION` | amazon-ads | `EU` (Amazon.in advertisers) |
| `AMAZON_ADS_PROFILE_ID` | amazon-ads | Advertising profile id for Amazon.in. To find it, run Test connection once without it. |
| `ALLOWED_ORIGINS` | both | Already used by `invite-user`: comma-separated app origins |

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are injected by Supabase. Do not add them to the frontend.

## 4. Amazon authorisation steps

### Selling Partner API (seller account)
1. In Seller Central (Amazon.in), open **Apps & Services → Develop Apps** and complete the developer profile as a *private developer* (your own account only).
2. Create an app client for the **SP-API**. Select these roles:
   - **Product Listing:** listings report
   - **Amazon Fulfillment:** FBA inventory
   - **Finance and Accounting:** settlement fees and refunds
   - **Brand Analytics:** Sales & Traffic report. Amazon may require Brand Registry for this role.
3. Copy the LWA client id and client secret. Choose **Authorize** on the app to self-authorise it and get a refresh token.
4. Set the `AMAZON_SPAPI_*` and `AMAZON_COMPANY_CODE` secrets, then deploy `amazon-spapi`.
5. In **Amazon Intelligence → API Integration Settings**, choose **Test connection**. The card shows **connected** only when Amazon confirms the marketplace participation. Each role is then probed and listed as passed or failed.

### Amazon Ads API
1. Create a **Login with Amazon** security profile and apply for **Amazon Ads API** access (advertising.amazon.com/API). Approval is required before the API answers.
2. Complete the OAuth consent with scope `advertising::campaign_management` and exchange the code for a refresh token.
3. Set the `AMAZON_ADS_*` and `AMAZON_COMPANY_CODE` secrets without `AMAZON_ADS_PROFILE_ID`, deploy `amazon-ads` and choose **Test connection**. The available profiles are listed.
4. Set `AMAZON_ADS_PROFILE_ID` to the Amazon.in profile and test again. The card then shows **connected**.

### Disconnecting
Revoke the app in Seller Central (Apps & Services → Manage Your Apps) or in your Amazon Ads account. Then delete the secrets. Stored data stays until you delete it; the next test marks the connection as an error.

## 5. Synchronisation

| Button | API | Range per run | Stored as |
|---|---|---|---|
| Sales & traffic | SP-API `GET_SALES_AND_TRAFFIC_REPORT` (daily, by child ASIN) | 1–7 days | `amazon_sku_daily` sales columns |
| Settlement fees | SP-API Finances (financial events) | 1–7 days | `amazon_sku_daily` fee and refund columns |
| Listings | SP-API `GET_MERCHANT_LISTINGS_ALL_DATA` | current | `amazon_listings` |
| FBA inventory | SP-API FBA Inventory summaries | current | `amazon_inventory_snapshots` |
| Campaigns & keywords | Ads API v3 list endpoints | current | campaigns, ad groups, targets |
| Performance reports | Ads API v3 reports: campaigns, advertised products, search terms | 1–31 days | daily campaign / product / search-term tables |

How a sync behaves:
- **Retries and errors:** each request retries with backoff on 429 and 5xx responses and follows pagination tokens. Every API error goes to Sync History with its HTTP status and a redacted message.
- **Duplicate requests:** each run has a request id, so a double click or retry is ignored.
- **Re-syncing a period:** rows are upserted on their natural keys. Re-syncing updates rows and never duplicates them.
- **Slow reports:** reports that Amazon is still generating after about 45 seconds leave the job **WAITING_REPORT**. Resume it from **Sync History**.
- **Recent data:** advertising data for the last days can still change through attribution, so re-sync recent periods.

No sync is scheduled automatically. To schedule one, call the Edge Functions from a scheduler (for example `pg_cron` with `pg_net`, or an external cron) as a user with `amazon_integration.manage`.

### Report import (no credentials needed)
**API Integration Settings → Import Amazon report files** accepts these files:
- Business Report (by child item, one day per file: choose the date)
- Sponsored Products campaign, advertised product and search term reports (daily, with a Date column)
- FBA inventory report

The import validates every row. Rejected rows are reported with their row number; nothing else is written.

## 6. Calculations (one implementation: `src/features/amazon/metrics.ts`)

**Sales and costs**
- **Net sales:** ordered sales minus refunds and promotions, converted to ex-GST. The GST rate comes from the listing override or the ERP product.
- **Product cost:** the listing override, otherwise the ERP `standard_cost`. If there is neither, the value is shown as **Unavailable**, never 0.
- **Amazon fees:** actual settlement fees where they have been synced. For other days, estimates from the listing fee settings are used and labelled.

**Contribution and ACoS targets**
- **Contribution before ads** = net sales − product cost − Amazon fees − shipping − other variable costs. **After ads** subtracts ad spend.
- **Break-even ACoS** = contribution before ads ÷ ordered sales.
- **Target ACoS** = break-even ACoS − desired contribution. The desired contribution is set per unit on the listing, or as the company target %.
- **Max CPC** = maximum ad cost per order × conversion. With few clicks, a conservative (Wilson lower-bound) conversion is used.

**Budget planner**
- **Model:** diminishing returns, sales ∝ spend^0.6 (range 0.4–0.8), fitted to each product's own history.
- **Allocation:** budget goes to the product where the next rupee returns the most. It stops at break-even ACoS (profit priority) or target ACoS (growth priority), and at the stock limits.
- **Low data:** products with too little data keep their minimum budget and get no forecast.
- The planner never claims placement, ranking, sales or profit.

**Search terms and stock**
- **Search terms:** volume, organic rank and competitor data are not available from these APIs and are not estimated.
- **Replenishment:** a quantity is suggested only when a lead time is set for the listing.

## 7. Advertising changes (approval required)

1. The module starts in **READ_ONLY** mode with the **kill switch ON**. Nothing can be sent to Amazon.
2. A user with `amazon_ads.request` proposes one change: daily budget, campaign state, keyword / target bid, or negative keyword. The server reads the current value from the last sync and checks the limits: max daily / monthly budget, max bid, and max % change per request.
3. A **different** user with `amazon_ads.approve` approves it. If the value on Amazon changed since the request, the request is cancelled instead.
4. Before anything can be executed, an approver switches the mode to **APPROVAL_REQUIRED** and turns the kill switch off. Every kill-switch change is audited.
5. **Send to Amazon** checks again: mode, kill switch, Ads connection, limits, current value, and not demo. Then it calls the Ads API. The request is marked **SUCCEEDED** only when Amazon confirms, and the Amazon request id is stored. Otherwise it is **FAILED** with the error. The result is notified, audited and kept with rollback instructions.

## 8. Demo data

**API Integration Settings → Demo data** creates 8 fictitious products (`DEMO-…`), sales, fees, stock and 5 campaigns. The data is kept apart from everything real:
- It is flagged `is_demo` and sourced `DEMO`, and appears only when the **Data** selector is set to *Demo data*.
- It is never mapped to ERP products and never written to ERP stock, orders or invoices.
- Demo change requests are refused at execution.
- **Remove demo data** deletes only demo rows.

## 9. Tests

| Command | Covers |
|---|---|
| `npm run test:unit` | Formulas, allocator, recommendation rules, report parsing, LWA / SP-API / Ads clients (retry, pagination, redaction), search-term classification |
| `npm run test:db` | `supabase/tests/amazon_verification.sql`: RLS and company isolation, permissions, idempotent imports, mapping guard, ex-GST and cost sources, demo separation and clean-up, the change approval flow, service functions not callable from browsers |
| `npm run build:smoke && npm run test:ui` | Every Amazon page in live (empty) and demo mode, recommendation generation, the "not configured" test result, labelled CSV export, viewer denied |

## 10. Known limits of this version
- Only Sponsored Products is synced. Sponsored Brands / Display, placement reports, Buy Box, reviews and listing-quality scores are not.
- Returned units are not credited back to product cost, so contribution is conservative.
- Credential-dependent behaviour is covered by tests against mocked Amazon responses only. It has not run against the live APIs: Amazon's real responses, role approvals, report availability and rate limits must be confirmed with your credentials.
