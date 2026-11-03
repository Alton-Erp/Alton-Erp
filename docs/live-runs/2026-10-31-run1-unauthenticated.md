# Live integration results — 2026-10-31T11:44:48.607Z

Hosted project `srpeewjutlyruympdznc`. Run tag `2610311144`. Workflows: not run.

**26 passed · 1 failed · 2 blocked · 1 not run**

## 1. Connection to the V2 project

| Status | Check | Detail |
|---|---|---|
| PASS | frontend .env.local points to the V2 project srpeewjutlyruympdznc | project srpeewjutlyruympdznc |
| PASS | not the original Alton ERP project | srpeewjutlyruympdznc |
| PASS | browser key is a publishable key (no secret or service-role key in the frontend) | sb_publishable_… |
| PASS | Auth service answers | email sign-in on |
| FAIL | public sign-up is disabled (recommended before go-live) | disable_signup=false |

## 2. Anonymous access (RLS and grants)

| Status | Check | Detail |
|---|---|---|
| PASS | anonymous cannot read companies | 42501 permission denied for table companies |
| PASS | anonymous cannot read profiles | 42501 permission denied for table profiles |
| PASS | anonymous cannot read user_roles | 42501 permission denied for table user_roles |
| PASS | anonymous cannot read products | 42501 permission denied for table products |
| PASS | anonymous cannot read inventory_balances | 42501 permission denied for table inventory_balances |
| PASS | anonymous cannot read inventory_transactions | 42501 permission denied for table inventory_transactions |
| PASS | anonymous cannot read purchase_orders | 42501 permission denied for table purchase_orders |
| PASS | anonymous cannot read goods_receipts | 42501 permission denied for table goods_receipts |
| PASS | anonymous cannot read production_orders | 42501 permission denied for table production_orders |
| PASS | anonymous cannot read sales_orders | 42501 permission denied for table sales_orders |
| PASS | anonymous cannot read sales_invoices | 42501 permission denied for table sales_invoices |
| PASS | anonymous cannot read customer_payments | 42501 permission denied for table customer_payments |
| PASS | anonymous cannot read parties | 42501 permission denied for table parties |
| PASS | anonymous cannot read audit_logs | 42501 permission denied for table audit_logs |
| PASS | anonymous cannot read company_settings | 42501 permission denied for table company_settings |
| PASS | anonymous cannot read notifications | 42501 permission denied for table notifications |
| PASS | anonymous cannot call get_my_access | 42501 permission denied for function get_my_access |
| PASS | anonymous cannot call management_overview | 42501 permission denied for function management_overview |
| PASS | anonymous cannot call inventory_overview | 42501 permission denied for function inventory_overview |
| PASS | anonymous cannot call erp_settings_get | 42501 permission denied for function erp_settings_get |
| PASS | anonymous cannot call erp_report | 42501 permission denied for function erp_report |
| PASS | anonymous cannot list private documents |  |

## 3. Super Admin on the real company (read-only)

| Status | Check | Detail |
|---|---|---|
| BLOCKED | Super Admin sign-in | LIVE_SUPERADMIN_EMAIL / LIVE_SUPERADMIN_PASSWORD not set in .env.live |

## 4. Roles, permissions and company isolation (test companies)

| Status | Check | Detail |
|---|---|---|
| BLOCKED | test accounts | STAGING_EMAIL_PREFIX / STAGING_EMAIL_DOMAIN / STAGING_TEST_PASSWORD not set in .env.live (run the staging seed first) |

## 5. Business workflows (test company STG-A)

| Status | Check | Detail |
|---|---|---|
| NOT RUN | workflows | run with --workflows (writes test records into STG-A only) |
