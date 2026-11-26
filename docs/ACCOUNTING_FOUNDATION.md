# Alton Accounts — Phase 0: accounting foundation

Status: **local implementation, not deployed.** Migrations:
`supabase/migrations/20261231090000_accounting_foundation.sql` and
`supabase/migrations/20261231090100_accounting_auto_posting.sql`, each with a matching
`supabase/rollback/*_down.sql`.

This document is the architecture and schema plan written before the migrations, kept up to date
with what was built. Phases 1–6 (manual journal screen, cost-centre allocations and budgets,
purchase invoices, bank and cash, GST accounting, fixed assets) are **not** part of Phase 0.

## 1. Repository audit (what exists and is reused)

| Area | Existing object | How accounting uses it |
|---|---|---|
| Company isolation | `companies`, `profiles.company_id`, `private.current_company_id()` | every accounting table has `company_id`; composite `(id, company_id)` foreign keys stop cross-company references |
| RBAC | `permissions` (`resource.action`), `role_permissions`, `private.has_permission`, `private.require_permission` | 12 new permissions, granted with the existing matrix pattern; every RPC calls `require_permission` |
| Audit | `audit_logs` (append-only), `private.write_audit_log` | every accounting write is audited |
| Financial year | `private.financial_year(date, start_month)` (billing) | voucher numbering and periods (`2026-27`) |
| Company date | `private.company_today(company)` | future-date checks, reversal dates |
| Parties | `parties` (customer / supplier link, opening balance) | party on Debtors / Creditors lines; opening-balance reconciliation |
| Sales | `sales_invoices` (ISSUED / CANCELLED), `invoice_adjustment_notes` (CREDIT / DEBIT, ISSUED / CANCELLED), `customer_payments` (RECORDED / REVERSED) | automatic posting sources (read only) |
| Purchasing | `goods_receipts` (POSTED / REVERSED), payable value `private.goods_receipt_value`, `supplier_payments` (RECORDED / REVERSED) | automatic posting sources (read only) |
| Inventory | `inventory_transactions` type `OPENING_STOCK` (qty × unit cost) | inventory opening reconciliation (read only) |
| Reset | `private.erp_reset_tables`, `erp_reset_kept_tables`, `erp_force_reset_tables`, `private.erp_force_purge_allows` | accounting tables registered; guards honour the force-purge exemption |
| Single operator | segregation of duties OFF by default (`20261101090000`) | accounting SoD is a setting, default off |

Nothing accounting-related existed: no chart of accounts, vouchers, periods, posting or reports.
The finance analytics page says "operational billing only — not accounting results" and stays so.

Pre-existing repository issue found during the audit (not changed): migration `20261215090000`
(Acefone softphone, table `support_call_signals`) is referenced by later migrations, the reset
allowlist, the frontend and tests, but is missing from this checkout. The ERP-reset suites fail
because of it with or without accounting.

## 2. Architecture

```
 source documents (unchanged)          accounting (new)
 ───────────────────────────           ─────────────────────────────────────────────
 sales_invoices / notes / receipts ─┐
 goods_receipts / supplier_payments ┼─ scan (read) ─► accounting_posting_events ─► engine ─► accounting_vouchers
                                    │                  (idempotent queue)          │          accounting_voucher_lines
 parties / inventory opening ───────┴─ reconcile ─► accounting_opening_balance_*  ─┘                │
                                                                                                    ▼
                                         reports: trial balance, general ledger, day book, register
```

* **No triggers on operational tables.** Business workflows are not changed and can never fail
  because of accounting. Automatic posting *reads* the source tables (scan) and queues one event
  per source document and action (`POST` / `REVERSE`), unique per company, source and action.
* **One posting engine.** Manual, automatic, opening and reversal vouchers all go through
  `private.accounting_post_voucher`: lock, validate, number, transition with a token, audit.
* **Drafts never count.** Reports read only vouchers in status `POSTED` or `REVERSED` (a reversed
  voucher and its reversal both stay in the books and cancel out).

## 3. Schema (13 new public tables, 1 private table)

| Table | Purpose / key rules |
|---|---|
| `accounting_settings` | one row per company: books start date, FY start month (default 4 = April–March), currency `INR` (fixed), future-date and back-date rules, segregation of duties, retry limit |
| `accounting_periods` | monthly periods per FY; `OPEN`, `CLOSED`, `REOPENED`; posting allowed only in open/reopened periods |
| `account_groups` | hierarchy (parent in same company, no cycles), classification ASSET / LIABILITY / EQUITY / INCOME / EXPENSE inherited from the root, normal balance, system flag |
| `accounts` | ledger accounts: code, name, group, classification (= group's), normal balance, nature (GENERAL, CASH, BANK, RECEIVABLE_CONTROL, PAYABLE_CONTROL, TAX, INVENTORY, …), `is_postable`, `allow_manual_posting`, `requires_party`, system / control flags, active |
| `accounting_cost_centres` | master only (code, name, description, parent, active). Allocations and budgets are Phase 2 |
| `accounting_voucher_types` | JV, SAL, RCT, PMT, CRN, DBN, PUR, OPN, REV; prefix; manual allowed? |
| `accounting_voucher_sequences` | (company, type, FY) → last number; row-locked upsert = transaction-safe, gapless for posted vouchers |
| `accounting_vouchers` | header: type, number (assigned at posting), FY, date, reference, narration, status DRAFT / POSTED / REVERSED / DISCARDED, source (MANUAL / AUTO / OPENING / REVERSAL), source document, posting event, `reversal_of_voucher_id` (unique), totals, row version |
| `accounting_voucher_lines` | account, optional party, debit **or** credit (NUMERIC(18,2), > 0), line narration |
| `accounting_posting_rules` | rule key (+ match value, e.g. payment method) → account. Payment methods are **never** mapped by default |
| `accounting_posting_events` | queue: source, action, date, amount, status PENDING / POSTED / FAILED / NEEDS_ACCOUNT_MAPPING / SKIPPED / DISMISSED, attempts, error code and text, voucher |
| `accounting_opening_balance_batches` | DRAFT / APPROVED / POSTED / DISCARDED, reconciliation snapshot and acknowledgements, voucher |
| `accounting_opening_balance_lines` | account, party, category, debit or credit |
| `private.accounting_transition_tokens` | transaction-bound tokens (not reachable through the API) |

Money is `numeric(18,2)` everywhere; no floating point is used.

## 4. Security design

* RLS on every table; `select` only for active members of the company with the read permission.
  **No insert / update / delete grant** to `anon`, `authenticated` or `service_role` on any
  accounting table. All writes are `SECURITY DEFINER` RPCs that derive the company from the caller.
* **Transaction-bound security token.** A voucher's status can change only when the trusted engine
  has created a token row in `private.accounting_transition_tokens` for the voucher, the purpose and
  the current transaction (`txid_current()`) and set the matching `app.accounting_token`. The guard
  trigger checks both. Tokens are deleted before the function returns. Direct SQL (including
  `service_role` or a stolen session) cannot post, reverse, discard or edit posted rows.
* **Immutability.** Posted / reversed vouchers and their lines cannot be updated or deleted; the only
  allowed change is POSTED → REVERSED with a token. Lines can change only while the voucher is a
  DRAFT. Deletes are refused except inside a reviewed force-reset purge
  (`private.erp_force_purge_allows`).
* Service role: has no table privileges and the RPCs need `auth.uid()`, so it cannot post.

## 5. Posting rules (automatic events)

| Event | Debit | Credit |
|---|---|---|
| Sales invoice ISSUED | Debtors (party) = grand total; Round-off if negative | Sales = taxable subtotal; Output CGST / SGST / IGST; Round-off if positive |
| Customer receipt RECORDED | mapped account for the payment method | Debtors (party) |
| Credit note ISSUED | Sales Returns = taxable; Output CGST / SGST / IGST | Debtors (party) = total |
| Debit note ISSUED | Debtors (party) = total | Sales = taxable; Output GST |
| Supplier payment RECORDED | Creditors (party) | mapped account for the payment method |
| Goods receipt POSTED | Purchases = net; GST Input Pending Verification = GST | Creditors (party) = ERP payable (`goods_receipt_value`) |
| Invoice / note CANCELLED, receipt / payment / GRN REVERSED | linked reversal voucher of the original, dated on the cancellation date |

Net / GST split of a receipt line: PO lines `round(payable × taxable_value / line_total, 2)`, direct
lines `round(payable × 100 / (100 + gst_rate), 2)`; GST = payable − net (so the voucher balances to
the paisa). GST is never treated as eligible ITC.

Not posted: drafts, pending, discarded, documents dated before the books start date, non-INR
documents (`UNSUPPORTED_CURRENCY`), zero-value documents (SKIPPED), direct receipts without a supplier
(no ERP payable; SKIPPED). A missing rule or a missing payment-method account → `NEEDS_ACCOUNT_MAPPING`
(never guessed). Other errors (closed period, inactive account) → `FAILED`, retried up to the
configured limit, then manual retry or dismissal with a reason. The cancellation of a document that
pre-dates the books start date is flagged `FAILED / PRE_BOOKS_SOURCE` for a manual correction.

## 6. Opening balances

DRAFT batch (manual lines or CSV/XLSX import) → reconcile → APPROVED → POSTED (one OPN voucher dated
the books start date; one posted batch per company). Checks:

1. balanced (debit = credit) — never acknowledgeable;
2. every Debtors / Creditors line has a party; no party twice on the same account;
3. Debtors control per party = ERP party opening receivable; Creditors per party = ERP opening payable;
4. inventory accounts = valuation of posted ERP opening stock (`OPENING_STOCK` qty × unit cost;
   unvalued lines reported).

A failed check 2–4 blocks approval unless the approver acknowledges it with a reason (kept on the
batch and in the audit log). "Prefill from ERP parties" adds party lines explicitly; nothing is
created automatically and ERP opening records are never changed.

## 7. Permissions

`accounts.read`, `accounts.manage`, `vouchers.read`, `vouchers.create`, `vouchers.post`,
`vouchers.reverse`, `accounting_opening.import`, `accounting_opening.approve`,
`accounting_period.close`, `accounting_reports.read`, `accounting_settings.manage`,
`accounting_posting.manage`.

Matrix: Accounts Manager — all; Administrator — read permissions and settings; Management Viewer —
`accounts.read`, `vouchers.read`, `accounting_reports.read`; Super Admin — all (existing rule).

## 8. Reset

Kept by the standard reset (configuration, like products and number series): settings, periods,
groups, accounts, cost centres, voucher types, sequences, posting rules. Resettable: vouchers, lines,
events, opening batches and lines. Posted vouchers carry delete guards, so the standard reset stops
while they exist (existing safeguard); the force reset purges them through the reviewed exemption.
All 13 tables are purged by the force reset.

## 8a. RPC inventory

All `SECURITY DEFINER`, `search_path = ''`, company from the caller, granted to `authenticated`
only (revoked from `public`, `anon`, `service_role`).

| Area | RPC (permission) |
|---|---|
| Set-up | `accounting_status` (any accounting permission), `accounting_initialize`, `accounting_settings_save` (`accounting_settings.manage`) |
| Periods | `accounting_periods` (read), `accounting_period_generate`, `accounting_period_set_status` (`accounting_period.close`) |
| Chart | `accounting_chart`, `accounting_accounts`, `accounting_parties`, `accounting_cost_centres` (read); `accounting_group_save`, `accounting_account_save`, `accounting_account_set_active`, `accounting_cost_centre_save` (`accounts.manage`) |
| Posting rules | `accounting_posting_rules` (read), `accounting_posting_rule_save` (`accounting_settings.manage`) |
| Vouchers | `accounting_voucher_create`, `_update`, `_line_save`, `_line_delete`, `_discard` (`vouchers.create`); `_validate`, `_get`, `_list` (read); `_post` (`vouchers.post`); `_reverse` (`vouchers.reverse`) |
| Reports | `accounting_trial_balance`, `accounting_general_ledger`, `accounting_day_book`, `accounting_dashboard` (`accounting_reports.read`) |
| Opening | `accounting_opening_batches`, `_batch_get` (read); `_batch_create`, `_lines_replace`, `_prefill_parties`, `_discard` (`accounting_opening.import`); `_approve`, `_reopen`, `_post` (`accounting_opening.approve`) |
| Automatic posting | `accounting_posting_events` (read); `accounting_posting_scan`, `_run`, `_retry`, `_dismiss` (`accounting_posting.manage`) |

Read-only RPCs are `STABLE` and are tested inside a `READ ONLY` transaction (PostgREST runs them so).

Retry control: only real failures count as attempts (an event waiting for an account mapping does
not); after `auto_posting_max_attempts` failures an event waits for a manual Retry (which restarts
the counter) or Dismiss (reason required). Posting runs take a per-company advisory lock; a second
concurrent run is told another run is in progress.

## 9. Screens (`/accounts/...`)

Accounting Dashboard, Chart of Accounts, Ledger Accounts, Voucher Register, Trial Balance, General
Ledger, Day Book, Opening Balances, Accounting Settings (books, periods, posting rules, cost
centres), Posting Monitor. Every page states that figures come from posted accounting vouchers and
are separate from operational billing analytics.

## 10. Tests

| Command | What it covers |
|---|---|
| `npm run test:db:accounting` | 117 checks on PGlite: set-up, chart, vouchers, validation, numbering, immutability and token forgery, direct-write and service-role refusal, RLS and company isolation, periods, reversal, automatic posting (idempotency, mapping, retries, dismissal, reversals, ERP ledger reconciliation), opening balances, reports, reset registries, rollback / re-apply |
| `ACCOUNTING_PG_URL=… ACCOUNTING_PG_MODULE=… npm run test:db:accounting` | the same on a real, empty, disposable PostgreSQL (verified on 17.12, the production major version) plus 6 true two-connection concurrency checks |
| `node --test tests/unit/accounting.test.ts` | frontend model, import parser, navigation / permission wiring, every RPC the screens call exists and is granted correctly |
| `npm run test:ui` | step "Accounts: every page renders …" (mock API) |

## 11. Limitations (Phase 0)

* Automatic posting runs on demand (Posting Monitor "Run posting now"); there is no scheduler yet.
* No year-end closing of income / expense into reserves; the trial balance carries them forward.
* Manual journal entry screen, cost-centre allocations, purchase invoices, bank reconciliation, GST
  returns and fixed assets are later phases (the RPCs for manual vouchers already exist).
* GST on goods receipts is parked in "GST Input Pending Verification"; it is never treated as ITC.
* A document cancelled before it was posted is skipped on both sides (net zero), so period-wise
  balances can differ from the operational document dates in that one case.

## 12. Phase 1 — Manual Journal Vouchers (no new migration)

Phase 1 is built entirely on the Phase 0 voucher RPCs; no table, RPC, numbering or posting function was
added or changed. Screens:

| Route | Permission | What it does |
|---|---|---|
| `/accounts/journals/new` (Journal Entry) | `vouchers.create` | date, automatic number (assigned on posting), reference, narration, any number of debit / credit lines with a searchable account picker (control accounts are not offered), optional line narration, live total debit / credit / difference and Balanced / Unbalanced; Save draft, Validate, Post (confirmation required, `vouchers.post`), Discard draft |
| `/accounts/journals/:id/edit` | `vouchers.create` | reopens a manual JV draft; posted / reversed / discarded journals cannot be edited |
| `/accounts/journals` (Journal Register) | `vouchers.read` | filters: date range, voucher number, account, status, created by; view, edit draft, reverse posted journals (reason required, `vouchers.reverse`); Excel / CSV export |
| `/accounts/vouchers/:id` (details) | `vouchers.read` | lines, totals, reversal links, audit history; Edit draft / Post / Discard / Reverse |

Posted journals reach the Trial Balance, General Ledger and Day Book through the Phase 0 report RPCs
(posted and reversed vouchers only); drafts and discarded journals never do.

Concurrency: posting locks the voucher row and re-checks its status; a draft edited from two places
is protected by its row version (the second save is told to reload). Both are tested on PostgreSQL 17
with two connections.

Not in Phase 1: a cost centre per line (the Phase 0 lines have no cost-centre column; allocations are
Phase 2), party lines (control accounts are posted automatically only), a duplicate-submission key for
"Save draft" (a double-submitted draft is a harmless extra draft that can be discarded).

## 13. Phase 2 — Cost Centre Management

Migration `20261231090200_accounting_cost_centres.sql`, rollback `20261231090200_accounting_cost_centres_down.sql`.

| Area | What changed |
|---|---|
| Cost centre master | `accounting_cost_centres` gains `cost_centre_type` (Department, Production, Service, Sales, Administration, Warehouse, Project, Branch, Other) and `effective_from` / `effective_to`. Hierarchy changes are serialized per company (no cycles, even concurrently); a parent with active sub-centres cannot be deactivated; only a never-used centre can be deleted |
| Allocation rule | `accounts.cost_centre_policy` REQUIRED / OPTIONAL / NOT_APPLICABLE (default OPTIONAL; control accounts always NOT_APPLICABLE) |
| Allocations | `accounting_cost_allocations`: a voucher line split over one or more cost centres (`allocations: [{cost_centre_id, amount}]` on each line). Amounts > 0, at most 2 decimals, one row per centre per line, the split equals the line exactly, centre active and inside its effective dates on the voucher date. Changeable only while the voucher is a draft (guard trigger); a reversal copies the allocations onto the opposite lines |
| Automatic postings | no cost centre is ever guessed (no ERP document carries reliable department data); an automatic posting to a REQUIRED account fails in the Posting Monitor with the reason |
| Budgets | `accounting_budgets` (versioned; DRAFT → APPROVED → SUPERSEDED, or CANCELLED; one approved version per year), `accounting_budget_lines` (annual + 12 months, months always add up to the annual), `accounting_budget_history` (append-only). CSV / XLSX import with row-numbered errors; budgets never create vouchers |
| Reports | `accounting_cost_centre_summary`, `_ledger`, `_profitability`, `accounting_budget_vs_actual`; cost-centre filter on the general ledger (allocated share), day book and voucher register. Allocations are analysis only, so company-wide debit / credit totals and the trial balance are unchanged; unallocated income and expense are shown apart and allocated + unallocated = company totals |
| Permissions | `accounting_budgets.read`, `.manage`, `.approve`; cost centres keep `accounts.read` / `accounts.manage` |
| Screens | `/accounts/cost-centres`, `/accounts/cost-centres/budgets`, `/accounts/cost-centres/reports`; Journal Entry gets a per-line cost-centre split; Ledger Accounts gets the allocation rule |

Phase 0 functions extended by this migration (create / update / line save / line delete / validate / reverse /
voucher JSON / account lists / voucher list) are generated from the Phase 0 text with marked changes; the
rollback restores them exactly (tested by comparing every accounting function, column, constraint, reset
entry and permission before and after).

Limitations: budgets are expenditure- and income-account based; partial months are budgeted as whole months
in the summary; the trial balance has no cost-centre breakdown (it would not balance) — use the summary and
the cost-centre general ledger instead.

## 14. Phase 3 — Supplier (Purchase) Invoice Accounting

Migration `20261231090300_accounting_purchase_invoices.sql`, rollback `20261231090300_accounting_purchase_invoices_down.sql`.
Screens under Purchase & GRN: `/purchases/invoices` (register), `/purchases/invoices/new`, `/purchases/invoices/:id`,
`/purchases/invoices/:id/edit`, `/purchases/invoices/matching` (GRN matching) and `/purchases/invoices/reconciliation` (reports).

### 14.1 No duplicate payable — how a matched invoice posts

A posted goods receipt has already put the payable in the books (Phase 0 automatic posting: Dr Purchases net, Dr GST input
pending / Cr Creditors = the ERP payable). A supplier invoice matched to that receipt therefore posts **only the
differences** against the receipt's share for the invoiced quantity:

| Line | Posted by the invoice |
|---|---|
| Receipt (GRN) line | Receipt share for the quantity = `round(receipt net × cumulative qty / accepted, 2)`, minus what earlier posted invoices took (so partial invoices add up to the receipt exactly). Dr / Cr **Purchase Price Variance** = invoice taxable − receipt net share; Dr / Cr **GST input pending** = invoice GST − receipt GST share; Cr / Dr **Creditors (party)** = the sum of the two. Equal prices and rates → no voucher at all |
| Direct line (service, expense, freight…) | Dr the chosen expense ledger (with its cost-centre split), Dr GST input pending / Cr Creditors (party) |
| Reverse charge (direct lines only) | Dr expense, Dr GST input pending / Cr GST payable under reverse charge, Cr Creditors (taxable only) |
| Round-off | Dr / Cr Round Off, included in Creditors |

Every posted invoice stores a reconciliation: `receipt share + Creditors posted by the invoice = invoice total`. The tests
check that, once a supplier's receipts are fully invoiced, its Creditors balance equals the sum of its invoice totals, and
that no Purchases line is ever posted for a matched line.

### 14.2 Workflow and controls

DRAFT → SUBMITTED → APPROVED → POSTED → (REVERSED). DRAFT / SUBMITTED / APPROVED → CANCELLED. SUBMITTED / APPROVED → DRAFT
(returned, with a reason). All writes go through SECURITY DEFINER RPCs. The five new tables are select-only (RLS,
`purchase_invoices.read`), with no grants to anon or service_role.

- **Duplicates**: supplier invoice numbers are unique per supplier after normalisation (case, spaces and separators are
  ignored). Cancelled and reversed invoices are excluded (enforced by a database index).
- **Matching**: receipt lines are locked `FOR UPDATE` while an invoice is saved or posted. Quantities on draft, submitted,
  approved and posted invoices are reserved, so two invoices can never take the same remaining quantity (tested on
  PostgreSQL 17.12 with two sessions). A receipt line can appear only once per invoice. These cannot be invoiced past
  submission: a receipt of another supplier, a reversed receipt, or a receipt not yet posted to the accounts.
- **Receipt lock**: a goods receipt matched to a live invoice cannot be reversed (guard trigger `goods_receipts_invoice_lock`;
  the purchasing functions themselves are unchanged). Cancel or reverse the invoice first.
- **Tolerances**: `pi_price_tolerance_percent` and `pi_amount_tolerance` in Accounting Settings (default 0). A price or
  GST-rate difference outside them makes the invoice an EXCEPTION. It can be approved only with explicit acceptance and a
  reason of at least 10 characters.
- **Totals**: the database recomputes taxes from the rate and treatment. Intra-state, CGST = SGST =
  round(taxable × rate / 200, 2); inter-state, IGST = round(taxable × rate / 100, 2). Exempt, nil-rated and non-GST supplies
  carry no GST. The supplier's printed total is required and must equal the calculated total.
- **Cost centres**: direct lines only. REQUIRED accounts need a split; NOT_APPLICABLE accounts refuse one; the split must
  equal the taxable value. No split is ever assumed. Receipt lines carry none, because the receipt posting has none.
- **Segregation of duties** (a setting): the person who entered an invoice cannot approve it.
- **Immutability**: a posted invoice can change only its GST-verification and reversal fields. Lines and splits change only
  while it is a draft. History is append-only. Payment allocations can only be reversed.

### 14.3 GST verification (input tax credit)

The GST of a posted invoice sits in *GST input pending verification*. A user with `purchase_invoices.verify_gst` records
the result with a reason. ELIGIBLE also requires three checks: invoice verified, goods / services received, GSTIN valid.

- ELIGIBLE → Dr Input CGST / SGST / IGST / Cess, Cr GST pending (a separate PIN voucher, source `PURCHASE_INVOICE_GST`).
- INELIGIBLE → Dr Ineligible Input GST (expense), Cr GST pending.

There is **no GST portal or GSTR-2B integration**: the verification records what the user checked. Reversing the invoice
also reverses its GST voucher.

### 14.4 Supplier payments

Existing supplier payments (from the Ledger) are allocated to posted invoices through `supplier_payment_allocations`. An
allocation can never exceed the payment's unallocated amount or the invoice's outstanding amount, must be for the same
supplier, and is serialized on the payment row (tested concurrently). The payment's own voucher (Dr Creditors / Cr bank) is
unchanged: an allocation is only a sub-ledger link. A reversed payment automatically stops counting. An invoice with active
allocations cannot be reversed. No bank account is assumed.

### 14.5 Reports (`purchase_invoice_report`)

- Purchase register and supplier invoice register.
- GRN vs invoice: accepted / invoiced / uninvoiced quantity, receipt share and the difference posted.
- Supplier outstanding.
- AP ageing, with the supplier's Creditors ledger balance alongside.
- GST pending verification, with the ledger balance.
- ITC summary (ledger balances).
- Price variance.
- Cost-centre purchase expense, from posted vouchers, with un-split expense shown separately.

Each screen labels its figures as operational or accounting.

### 14.6 Permissions, seeding, registries, rollback

| Permission | Accounts Manager | Purchase Manager | Admin / Management Viewer | Super Admin |
|---|---|---|---|---|
| `purchase_invoices.read` | ✓ | ✓ | ✓ | ✓ |
| `purchase_invoices.create` | ✓ | ✓ | | ✓ |
| `.approve`, `.post`, `.reverse`, `.verify_gst` | ✓ | | | ✓ |

Payment allocation uses the existing `supplier_payment.manage` permission. Entry lookups (`purchase_invoice_lookups`) give a
Purchase Manager the suppliers, postable non-control ledgers and cost centres without needing `accounts.read`.

- **Seeded per company** (skipped where the code, name or system key already exists):
  - ledgers 1520–1523 Input CGST / SGST / IGST / Cess, 2240 GST Payable under Reverse Charge, 5150 Purchase Price Variance and
    5910 Ineligible Input GST;
  - their posting rules;
  - the PIN voucher type (automatic only).
- **Reset registries**: the standard reset gains 5 tables (158 in total); the force reset gains 5 (173).
- **Attachments**: documents entity `PURCHASE_INVOICE`, read with `purchase_invoices.read`.
- **Rollback**: refused while invoices or allocations exist (override with
  `app.accounting_purchase_invoice_rollback_force = on`). It restores every redefined function exactly and keeps the seeded
  ledgers, because they may carry postings.

### 14.7 Debit notes and purchase returns — proposal (not implemented)

The repository has **no supplier debit-note or purchase-return workflow**. The existing `DEBIT_NOTE` is the customer-side
billing note, and GRN rejections are recorded at receipt but never returned through a document. Per the brief, this phase
does not invent one. Proposed additive design:

1. `supplier_debit_notes` with lines (types PURCHASE_RETURN with goods, PRICE_REDUCTION, GST_CORRECTION), linked to a
   posted supplier invoice and, for returns, to receipt lines. Same DRAFT → APPROVED → POSTED → REVERSED workflow and RPC
   pattern as invoices.
2. A purchase return issues stock through the existing inventory functions (inventory module, not accounting) and posts
   Dr Creditors / Cr Purchases (or Price Variance) / Cr GST input pending or the verified input ledgers. Returned
   quantities are capped at invoiced minus already-returned, under the same row locks.
3. Outstanding = invoice total − payments − posted debit notes; ageing and the reports are extended to match.
4. Permissions `supplier_debit_notes.*`, plus registries, rollback and tests as in this phase.

### 14.8 Limitations

- INR only; one supplier per invoice.
- Reverse-charge invoices take direct lines only.
- Matched lines keep the receipt's quantity unit.
- The tolerance is company-wide, not per supplier or item.
- Invoices against receipts dated before the books start use the opening balances as the receipt side.
- No GSTR-2B reconciliation.
- TDS on supplier invoices is not handled (future phase).

## 15. Phase 4 — Bank & Cash Management

Migration `20261231090400_accounting_bank_cash.sql`, rollback `20261231090400_accounting_bank_cash_down.sql`.
Screens: `/accounts/bank-accounts`, `/accounts/cash-accounts`, `/accounts/bank-book`, `/accounts/cash-book`, `/accounts/transfers`,
`/accounts/payment-accounts`, `/accounts/bank-reconciliation`, `/accounts/bank-reconciliation/import`, `/accounts/bank-reconciliation/reports`,
and a "Bank / cash account per payment" card in Accounting Settings › Posting rules.

### 15.1 Audit findings that shaped the design

- `customer_payments` and `supplier_payments` store a payment method (`BANK_TRANSFER`, `UPI`, `CHEQUE`, `CASH`, `CARD`, `DEMAND_DRAFT`, `OTHER`), a date and
  references (`transaction_reference` / `bank_reference`; `reference`), but **no bank account**. NEFT, RTGS and IMPS are all `BANK_TRANSFER`.
- Before Phase 4 the bank / cash ledger of a payment came only from the payment-method rule (`RECEIPT_ACCOUNT` / `SUPPLIER_PAYMENT_ACCOUNT`).
- Neither payment table was changed. The per-payment account is held apart (`bank_payment_assignments`), and the automatic posting
  (`private.accounting_build_event`, redefined from its latest text) uses it.

### 15.2 Tables

| Table | Purpose | Reset |
|---|---|---|
| `bank_cash_accounts` | Bank (kind BANK) and cash (kind CASH) accounts. Each is linked to exactly one active BANK / CASH-nature ledger, with a masked number, a fingerprint (sha256 of IFSC + number) for duplicate detection, a custodian, a negative-balance policy and opening-balance reference fields | kept (master) |
| `bank_account_numbers` | Full account numbers. No grant to any API role; read only through `bank_account_reveal_number` (needs `bank_accounts.manage`, audited) | kept |
| `bank_payment_method_policies` | Methods whose account must be chosen payment by payment | kept |
| `bank_payment_assignments` | The verified account of one receipt / payment, with a reason. Replaceable only until the payment is posted | records |
| `bank_transfers` | Transfers (DRAFT → POSTED → REVERSED, or CANCELLED) | records |
| `bank_statement_imports`, `bank_statement_files`, `bank_statement_lines` | Import batches (user, time, counts, row report, column mapping), the original file (≤ 5 MB, no API grant, downloaded through an audited RPC) and the lines (immutable evidence) | records |
| `bank_reconciliation_matches`, `bank_reconciliation_match_items` | Matches (AUTO / MANUAL / ADJUSTMENT). A manual match needs a reason; a match can only be reversed, with a reason | records |
| `bank_reconciliations` | Saved reconciliation statements: COMPLETED (difference zero) or ACCEPTED_DIFFERENCE (an approver's documented reason) | records |

Seeded voucher types (automatic only): `CTR` (contra, for transfers) and `BNK` (bank adjustment). The standard reset now lists
166 tables (8 new resettable); the force reset lists 184 (all 11 new tables).

### 15.3 Payment account mapping

The bank / cash ledger of a receipt or payment is resolved in this order:

1. its **assignment** (Accounts › Payment accounts: the account and how it was verified);
2. if its method is ticked "choose per payment" (Accounting Settings), it **waits** in NEEDS_ACCOUNT_MAPPING with a clear
   message;
3. otherwise the existing **payment-method rule**.

The first bank account is never assumed. A posted payment is never rewritten: assignment is refused once its voucher exists,
and a wrong ledger is corrected with a journal voucher. Unmapped payments stay visibly unmapped. Each payment still has exactly
one automatic voucher (the Phase 0 database index).

Cheques post to the chosen bank account like other bank payments. Their clearance is never inferred from the payment status: an
issued cheque stays an **outstanding cheque** until it is matched to the bank statement.

### 15.4 Balance policy (database-enforced)

An AFTER UPDATE trigger on `accounting_vouchers` fires when a voucher is posted. For each credited ledger that belongs to an
active account with `allow_negative_balance = false`:

- it locks the account row, so concurrent postings queue;
- it refuses the posting if the ledger's running balance would go below zero on the voucher date or any later date.

This covers transfers, cash payments posted by the automatic posting run (the event then fails with the reason), bank
adjustments and manual journals.

Defaults: cash accounts, and current / savings bank accounts, refuse a negative balance. Cash-credit and overdraft accounts
allow one. The policy can be changed on the account, and the change is audited. Tested with two concurrent sessions on
PostgreSQL 17.12.

### 15.5 Transfers

One CTR voucher per transfer (source AUTO `BANK_TRANSFER`, unique):

- the transfer itself: Dr destination ledger / Cr source ledger;
- charges, if any: Dr a chosen expense ledger / Cr source.

Transfers never touch income or expense apart from those charges. Rules:

- The two accounts must be different, active and of this company.
- Posting locks the transfer row, so a second post is refused.
- Posted transfers are immutable (guard trigger).
- Reversal posts a linked REV voucher.

### 15.6 Statement import

The screen reads the file and the user maps the columns:

- **CSV** files are read as text, so dates like 05/11/26 follow the chosen date format.
- **Excel** files are read with the existing spreadsheet library.
- Indian digit grouping, ₹, brackets and Dr / Cr suffixes are understood.

The database then validates every row:

- dates and 2-decimal amounts;
- exactly one of debit and credit filled.

Duplicates are detected by:

- a repeated bank transaction ID; or
- a key built from date, signed amount, reference, description, running balance and the row's occurrence number in the file.

Re-importing a file therefore imports nothing, while genuinely repeated rows in one statement are kept (and flagged). Preview
runs the same checks without writing. Failed rows are reported with their spreadsheet row numbers. Statement lines never
create vouchers.

### 15.7 Matching and reconciliation

Amounts are signed alike on both sides: a deposit or bank debit is positive.

**Matching**

- Matches can be one-to-one, one-to-many, many-to-one or many-to-many, as long as both sides are exactly equal.
- **Partial** amounts are supported. Each item takes part of a line, and a line can never be matched beyond its remaining amount.
- Lines are marked UNMATCHED, PARTIALLY_MATCHED or MATCHED.
- All matching of one bank ledger is serialized by a transaction advisory lock (tested concurrently).
- Auto-match confirms only "confident" one-to-one proposals: the same amount within the date tolerance, unique both ways (or
  unique by reference).
- Manual matches need a reason. Unmatching keeps the match as REVERSED.

**Charges and interest**

- A statement line can be turned into a BNK voucher (one per line):
  - a withdrawal: Dr the chosen expense ledger / Cr the bank ledger;
  - a deposit: Dr the bank ledger / Cr the chosen income ledger.
- This needs `bank_reconciliation.approve` and goes through the voucher engine, so periods, cost-centre rules and the balance
  policy all apply.
- If an unmatched ledger entry of the same amount exists near the line's date, a reason is required.
- The voucher is matched to its statement line automatically.

**Reconciliation statement (as of a date)**

- Matches count from their effective date (the later of the two sides' dates).
- Adjusted bank balance = statement balance + deposits in transit − outstanding payments / cheques.
- Adjusted book balance = ledger balance + bank credits not in the books − bank debits not in the books.
- The difference must be zero for COMPLETED. Otherwise an approver may save ACCEPTED_DIFFERENCE with a reason of at least 10
  characters.
- Open items are classified: deposit in transit, outstanding cheque, payment not yet on the statement, transfer pending,
  reversal, bank credit / debit not in the books, and charges / interest awaiting accounting.

### 15.8 Permissions

| Permission | Accounts Manager | Admin / Management Viewer | Super Admin |
|---|---|---|---|
| `bank_accounts.read`, `cash_accounts.read`, `bank_reconciliation.read` | ✓ | ✓ | ✓ |
| `bank_accounts.manage`, `cash_accounts.manage`, `bank_reconciliation.manage`, `bank_reconciliation.approve`, `bank_transfers.create`, `bank_transfers.post` | ✓ | | ✓ |

Assigning a payment's account needs `bank_accounts.manage` or `accounting_posting.manage`. Setting the per-method policy needs
`accounting_settings.manage`.

All 30 RPCs are SECURITY DEFINER and company-scoped, granted to signed-in users only. The tables are select-only through RLS;
the account fingerprint column is not granted at all.

### 15.9 Limitations

- INR only. Statement import is for bank accounts (not cash).
- Payment methods are the ERP's existing list: NEFT, RTGS and IMPS are all `BANK_TRANSFER`, and the reference distinguishes them.
- Card settlement accounts are just bank accounts. There is no merchant-settlement netting.
- There is no automatic bank feed. Statements are imported files.
- Opening balances of bank / cash ledgers come from Opening Balances; the master's opening fields are a reference only.
- Full account numbers are protected by access control and auditing, not by application-level encryption (no key-management
  service is configured).
- Cheque clearing uses the reconciliation status. There is no separate cheques-in-clearing ledger.

## 16. Phase 5 — GST accounting & compliance (Gate B: database and backend)

Migration `20261231090500_accounting_gst.sql`, rollback `20261231090500_accounting_gst_down.sql`. The GSTR-2B import, file storage
and server-side checksum verification come in Gate C (`20261231090600`). Screens come in Gates C–E.

### 16.1 Scope and principles

- **One GST registration per company.** Its GSTIN must equal `companies.gstin`, and it is never created automatically.
- **Nothing in Phase 5 posts from return preparation or imports.** Every accounting effect (ITC decisions and adjustments, GST
  payments, set-off) goes through the voucher engine, using the new automatic-only `GST` voucher type.
- **GST return periods do not lock vouchers.** The existing accounting periods keep that role.
- **Maker ≠ checker is enforced in the database for:**
  - configuration approval;
  - period approval and close;
  - return adjustments;
  - amendment resolutions;
  - partial-ITC decisions;
  - ITC reversals and reclaims;
  - GST payment posting;
  - set-off posting.

  It does not depend on the optional segregation-of-duties setting.

### 16.2 Tables (20)

| Group | Tables |
|---|---|
| Configuration (kept by the standard reset) | `gst_registrations`, `gst_registration_frequencies` (append-only), `gst_config_versions`, `gst_hsn_rates` |
| Return periods | `gst_return_periods`, `gst_period_events` (append-only), `gst_period_snapshots` and `gst_snapshot_documents` (insert-only), `gst_period_current_snapshot` (pointer), `gst_amendment_exceptions`, `gst_return_adjustments` |
| Sales | `gst_sales_document_details` (exactly one of `sales_invoice_id` / `adjustment_note_id`, composite company foreign keys), `gst_sales_document_detail_history` (append-only) |
| ITC | `gst_itc_decisions` (append-only history), `gst_itc_adjustments` |
| Payments | `gst_challans`, `gst_challan_heads`, `gst_challan_payments`, `gst_set_offs`, `gst_set_off_lines`, `gst_set_off_events` (append-only) |

New ledgers, created only when there is no conflict:
- 1524 GST Electronic Cash Ledger;
- 5920 GST Interest;
- 5930 GST Late Fee & Penalty.

New posting-rule keys: `GST_ELECTRONIC_CASH`, `GST_INTEREST`, `GST_LATE_FEE`.

**Ledger safety.** The ledger set-up reuses only an exact match. A clash on code, system key, name or nature raises an
actionable error and creates or alters nothing. An existing compatible ledger can be mapped to the rule instead.

### 16.3 Safeguards

**Configuration**
- Validated before submission (rates, B2C threshold, due days, units, set-off matrix, order, RCM cash-only, challan formats,
  section map). Invalid or incomplete versions can't be submitted, so they are never approved.
- Approval runs under a per-company advisory lock:
  - a new version must start after every approved one;
  - it must not start inside an approved or closed period;
  - the previous version becomes SUPERSEDED with `effective_to` set to the day before, keeping its payload and approval history.
- A trigger refuses any two approved or superseded versions with overlapping ranges.

**Return periods**
- Monthly or quarterly; quarterly periods start on a financial-year quarter.
- An overlap trigger runs under a per-registration advisory lock, alongside a unique start date and a shape check.
- Dates, frequency and registration are frozen.
- Frequency history is append-only and never changes existing periods.

**Snapshots**
- Approval inserts a snapshot: totals, approved adjustments, resolved amendments, the liability summary, the config version and
  a SHA-256 hash.
- Each document gets a row with its content hash.
- Snapshots are never updated or deleted. Reopening (Super Admin, reason ≥ 10 characters) and approving again inserts version
  n+1 and moves the pointer.

**Amendments**
- `gst_amendments_scan` compares approved and closed periods with the current documents and records:
  - CHANGED;
  - CANCELLED;
  - REVERSED;
  - LATE_DOCUMENT.
- Each exception is assigned to the first later open period, or held as PENDING_ASSIGNMENT until such a period is created.
- Unresolved exceptions block READY.

### 16.4 ITC

**Phase 3 one-step verification** (`purchase_invoice_verify_gst`) gives the same vouchers and results as before. It now writes
to the shared decision history.

**New maker-checker workflow** (`gst_itc_action`):
- review stages (under review, on hold);
- partial-ITC proposals, validated separately for CGST, SGST, IGST and cess against the GST pending, with checks required for
  any eligible amount;
- approval, rejection and decision reversal.

**Reversals and reclaims** (`gst_itc_adjustment`):
- limited to the net eligible / ineligible amount;
- reversed newest first.

**Purchase-invoice reversal order:** adjustments (newest first), then the decision, then the posting. Every voucher is reversed
exactly once. It is refused while an adjustment is a draft, or when ITC has already been used in a set-off.

### 16.5 Payments and set-off

**Challans:**
- CPIN is unique per registration.
- Payment attempts are kept (initiated, failed, success).
- At most one successful payment per challan, and the CIN is unique.
- Formats are checked against the configuration.
- Posting a payment: Dr Electronic Cash / Cr the Phase 4 bank ledger, so it appears in the bank book and reconciliation.

**Set-off:**
- Drafts, then posting by a different user.
- Posting refuses:
  - a second posted set-off for the period;
  - a pairing the matrix doesn't allow;
  - cash from another head;
  - RCM paid from credit when cash-only is configured;
  - using more liability, credit or cash than is available;
  - a negative electronic cash balance.
- A posted set-off can be reversed, after which a new draft can be posted.
- Its history is append-only.

### 16.6 Not in Gate B

GSTR-2B import and matching, registers, GSTR-1 / GSTR-3B preparation, screens and exports. Gates C–E.

## 17. Phase 5 — GSTR-2B import and reconciliation (Gate C)

Migration `20261231090600_accounting_gst_2b.sql`, rollback `20261231090600_accounting_gst_2b_down.sql`, Edge Function
`supabase/functions/gst-2b-verify`, screen **Accounts › GSTR-2B Matching** (`/accounts/gst/gstr-2b`).

The GSTR-2B file is the Excel (.xlsx) or CSV file the user downloads from the GST portal. There is no GST portal, GSTN or JSON
integration. Importing and matching never post a voucher and never approve ITC.

### 17.1 Safeguards added to Gate B

**ITC maker-checker for every decision.**
- `purchase_invoice_verify_gst` (Phase 3 screen) now only *proposes* a full ELIGIBLE or INELIGIBLE decision. Its validations are
  unchanged: the three checks for eligible credit and a reason of 10+ characters.
- Another user approves or rejects the proposal through `gst_itc_action` (APPROVE / REJECT). The proposer is refused.
- On approval, a first full decision keeps the Phase 3 voucher identity (`PIN`, source `PURCHASE_INVOICE_GST`) and the same
  accounting lines. Partial decisions keep the `GST` voucher type.
- The decision history records PROPOSED (maker) and DECIDED (checker). There is no other path to an ITC decision.

**Qualified set-off credit.** Credit available for a period, per head, is:
- input credit accrued up to the period end (input-ledger movements dated on or before it, with set-off vouchers and their
  reversals excluded),
- less credit used by *posted* set-offs of the registration (reversed set-offs are excluded),
- never more than the current input-ledger balance, and never below zero.

The unqualified ledger balance is never used. `gst_liability_summary` also shows:
- `credit_detail` per head: accrued, used, ledger and available;
- `open`: the current-period liability less posted set-offs of the period;
- `previous_outstanding`: the same for earlier periods, with warnings.

Set-off posting checks the qualified credit.

### 17.2 Upload and server-side verification

1. `gst_2b_upload_prepare` (permission `gst_reconciliation.manage`) checks:
   - the file type: `.csv` → `text/csv`, `.xlsx` → the OOXML type;
   - the size: 1 byte to 10 MB;
   - the declared SHA-256 and the return period (YYYY-MM).

   It refuses a file whose SHA-256 is already live in another import (duplicate file, enforced by a unique index). It then
   reserves the server-chosen path `<company>/gstr2b/<import id>.<ext>` in the private bucket `gst-files`.
2. The browser uploads with `upsert: false`. The storage insert policy allows only the uploader's own pending path, within one
   hour. There are no update or delete policies, so the original file is immutable through the API.
3. `gst_2b_upload_complete` checks the stored object's size and type.
4. The Edge Function `gst-2b-verify` works as follows:
   - It calls `gst_2b_verify_target` with the user's JWT. This checks permission and company, and issues a one-time token valid
     for 10 minutes.
   - It downloads the object with the service role and computes SHA-256 from the stored bytes (WebCrypto).
   - It rejects a checksum or size mismatch, a corrupted or wrong-format file (ZIP / OLE / UTF-8 sniffing) and a file with no
     GSTR-2B rows.
   - It reads the B2B, B2BA, B2B-CDNR and B2B-CDNRA sheets, including the portal's multi-row merged headers. It keeps every row's
     original cells.
   - It records the result through `gst_2b_verify_record`, which is service-role only and needs the token.
5. The database validates every row:
   - GSTIN format, and that it is not the company's own GSTIN;
   - the date, and amounts with at most 2 decimals (numeric only);
   - document type, amendments, reverse charge and ITC availability;
   - no IGST together with CGST / SGST.

   It flags duplicates within the file.
6. **Preview** (`gst_2b_import_get`): what a commit would add (new, amendment, changed, already imported), with the rows, errors
   and original cells.
7. **Commit** (`gst_2b_import_commit`):
   - It needs the server verification, and an explicit acknowledgement when some rows have errors (only valid rows are imported).
   - It runs under a per-registration lock.
   - Each valid row becomes a supplier document identified by registration, supplier GSTIN, type, normalised number and financial
     year:
     - a row identical to an earlier version is recognised as already imported;
     - B2BA / CDNRA rows add an AMENDMENT version;
     - other differences add a CHANGED version.
   - A new version supersedes a pending proposal. An approved match is kept but flagged for review (history `DOCUMENT_CHANGED`).

### 17.3 Matching

| Item | Rules |
|---|---|
| Auto proposals (`gst_2b_auto_match`) | Matches by supplier GSTIN and normalised invoice number to a posted invoice that has no active match. It only proposes. |
| Outcomes | EXACT; PARTIAL (every difference within the tolerance, default 1.00, configuration key `gstr2b_match_tolerance`); DATE_MISMATCH; TAXABLE_MISMATCH; TAX_MISMATCH; NUMBER_MISMATCH; GSTIN_MISMATCH. Every difference is recorded. |
| Manual match (`gst_2b_match_manual`) | Needs a reason of 10+ characters. Supplier credit / debit notes are never matched to invoices; they stay open as exceptions. |
| Approval / rejection (`gst_2b_match_decide`, `gst_reconciliation.approve`) | Never by the proposer (also a check constraint). A non-exact outcome needs a note. Only the document's current version can be approved. |
| Reversal (`gst_2b_match_reverse`) | Needs a reason of 10+ characters. |
| Active matches | At most one per document and one per invoice (unique indexes), so concurrent matching is safe. |
| History | `gst_2b_match_history` is append-only. Matches, versions and rows are never edited or deleted (guards). |
| Reports (`gst_2b_report`) | Summary, documents, missing in books (with candidate invoices), missing in GSTR-2B, supplier credit / debit notes, duplicates, amendments, match exceptions, history. |
| Download (`gst_2b_file_access`) | An audited 5-minute grant lets the reader create a signed URL. Without a grant, nobody can read the object. |
| ITC view | `gst_itc_get` shows the GSTR-2B evidence: match, outcome, return period, ITC availability, changed version. It never decides ITC. |

### 17.4 Tables (7)

| Table | Kind |
|---|---|
| `gst_2b_imports` | File details and the computed checksum are frozen; status only moves forward. |
| `gst_2b_lines` | Insert-only; the commit outcome is set once. |
| `gst_2b_documents` | Identity is frozen. |
| `gst_2b_document_versions` | Insert-only. |
| `gst_2b_matches` | Proposal frozen; status transitions only. |
| `gst_2b_match_history` | Append-only. |
| `gst_file_access_grants` | Insert-only. |

All seven are in the standard reset (190 tables). They are purged children-first by the force reset, which also removes the
company's `gst-files` objects.

### 17.5 Not in Gate C

GSTR-1 / GSTR-3B preparation, registers and exports (Gates D–E).

## 18. Phase 5 — GST return preparation (Gate D)

Migration `20261231090700_accounting_gst_returns.sql`, rollback `20261231090700_accounting_gst_returns_down.sql`, screen
**Accounts › GST Returns** (`/accounts/gst/returns`).

**What it produces.** Working data for preparing GSTR-1 and GSTR-3B on the GST portal:
- sales, purchase and reverse-charge registers;
- the GST liability dashboard;
- payment, challan and set-off views;
- tax-head summaries and reconciliation with the accounting ledgers;
- exception lists;
- Excel / CSV working files and printable reports.

**What it never does.**
- It never files a return; there is no GSTN or portal integration.
- It never posts a voucher.
- It never recalculates a document. Every figure is read from what is already stored:
  - issued sales invoices and customer notes;
  - posted supplier invoices;
  - the approved ITC decision history and ITC adjustments;
  - posted set-offs;
  - the ledgers.

### 18.1 Value layers
| Status | Meaning |
|---|---|
| Calculated | Live, from the documents of the period. |
| Manually adjusted | Live, with *approved* return adjustments (maker-checker, Gate B) applied. Calculated and adjusted figures are shown side by side; draft adjustments are listed, never applied. |
| Approved | From the period's approved snapshot. Approval stores the GSTR-1 and GSTR-3B working in the insert-only snapshot. An approved or closed period is never recalculated. Later changes appear as "live differs" and as amendment exceptions of a later period. |
| Filed (recorded) | A user recorded the ARN and date after filing on the portal (`gst_return_filing`, permission `gst_returns.approve`). It is only allowed for an approved period with the working in its snapshot. Records are insert-only; a wrong one is voided with a reason. A period with a filing record cannot be reopened. |

### 18.2 GSTR-1
- **Sections:** B2B, SEZ with / without payment, deemed exports, B2CL, B2CS, exports with / without payment, CDNR, CDNUR and nil / exempt / non-GST.
- **Classification:** from the invoice's supply category, customer registration, GSTIN, tax treatment and invoice value. The B2CL threshold comes from the configuration approved at the period end. A reviewed section override wins.
- **Notes:** customer notes follow their original invoice. Credit notes are negative.
- **HSN summary:** split B2B / B2C, with the UQC from the configuration.
- **Documents issued:** per series, with the cancelled count.
- **Excluded documents:** drafts, pending, cancelled and pro-forma documents are excluded and counted.

### 18.3 GSTR-3B
- **3.1:** (a)–(e) from the same classification, net of notes; reverse-charge inward supplies from posted RCM supplier invoices.
- **3.2:** inter-state supplies to unregistered persons, by place of supply.
- **4 ITC:**
  - availed (4(A)(3) reverse charge, 4(A)(5) other), reversals and reversed decisions (4(B)(2)), ineligible (4(D)(2)) and net ITC;
  - all by voucher date, from the decision history.
  - GSTR-2B match status is shown as evidence only.
- **5:** exempt, nil-rated and non-GST inward supplies.
- **6.1:**
  - payable per return, with the ledger liability beside it;
  - paid through ITC by credit head, paid in cash, interest and late fee — all from posted set-offs;
  - the open balance.

### 18.4 Credit: historical and current (Gate C review item 3)
`private.gst_credit_position` gives, per head:
- **Accrued by the period end:** set-off vouchers excluded.
- **Used through the period:** posted set-offs of this and earlier periods.
- **Available at the period end:** the historical position. Later set-offs never change it.
- **Cumulative headroom:** the smallest "accrued less used" at this or any later period end.
- **Ledger balance:** the current position.
- **Available for a set-off:** the minimum of the historical position, the headroom and the ledger, never below zero.

Approved snapshots keep the position as it was at approval. The tests cover October, November and December with later utilisation
and a reversal.

### 18.5 Match tolerance (Gate C review item 4)
- The optional configuration key `gstr2b_match_tolerance` (0–100, at most 2 decimals; default 1.00) is validated, and is versioned with
  the configuration.
- Every GSTR-2B match records the configuration version whose tolerance it applied. The screen shows the tolerance on every match.
- A match within tolerance is PARTIAL, never EXACT.
- Every match needs approval by another user, and a non-exact match needs a note.

### 18.6 Reconciliation and exceptions
**Reconciliation, per head:**
- output tax per documents vs the output ledger;
- ITC per decisions vs the input ledger;
- RCM, set-off by credit and by cash, the open liability, and credit at the period end vs now;
- vouchers on the GST ledgers that no GST document explains (for example manual journals).

**Exceptions:**
- missing or invalid GSTIN, missing place of supply, missing HSN / SAC, unmapped UQC;
- invalid classification (IGST on an intra-state supply, CGST / SGST on an inter-state supply, an unresolved tax treatment, GST on an exempt supply, a place of supply that disagrees with the treatment);
- missing export details;
- unposted or draft source documents;
- missing supplier GSTIN;
- ITC pending or proposed;
- ITC availed without an approved GSTR-2B match.

### 18.7 Outstanding before production (tracked, not done here)
1. Test the private bucket, policies, grants, expiry, immutability and isolation in a separate non-production Supabase project.
2. Run `gst-2b-verify` in the real Supabase Edge Function runtime with real CSV / XLSX files.
3. The intermittent UI smoke timeouts in the BOM and Product Master columns steps are tracked separately. They are unrelated to accounting and are not modified.

## 19. Phase 5 — GST period close, reconciliation reports, exports and QA (Gate E)

Migration `20261231090800_accounting_gst_close.sql`, rollback `20261231090800_accounting_gst_close_down.sql`. Screen: **Accounts › GST Returns**,
tabs **Period close** and **Control reports**.

### 19.1 Why a migration and what it contains
Close controls must be enforced by the database. A check that only the screen ran could be bypassed by calling the RPC directly. The
migration therefore adds:
- no new tables;
- `private.gst_close_controls`, `private.gst_period_lifecycle`, `private.gst_months` and `private.gst_disclaimer`;
- the read-only RPCs `gst_period_readiness(period)` and `gst_control_report(report, filters)`;
- a redefinition of `gst_period_transition`, changing only its CLOSE branch.

It reuses every Phase 3–5 table and function as the source of truth.

The rollback:
- restores the Gate D `gst_period_transition` exactly and drops the new functions;
- is refused if the Gate D functions are already gone, so it must run before the Gate D rollback;
- has no Gate E records to protect, because Gate E creates none. CLOSED events already written keep their recorded controls, since period history is append-only.

### 19.2 Period lifecycle and close
**Lifecycle displayed:** Open → In review → Ready for approval → Approved → Closed, plus Filed (a recorded ARN) and Reopened (from the period
events).

**Mandatory blockers** (all must pass before CLOSE):
- no approved snapshot with the return working;
- unmapped GST posting rules;
- draft return adjustments;
- unresolved amendment exceptions;
- ITC proposals awaiting approval;
- GSTR-2B matches of the period awaiting approval;
- draft set-offs;
- successful GST payments not posted.

**Warnings** (never treated as passed):
- source errors (GSTIN, place of supply, HSN, classification);
- missing documents (unposted or draft sources, GSTR-2B missing in books);
- ITC pending verification;
- GSTR-2B differences;
- ledger differences;
- unexplained GST vouchers;
- open liability;
- live differences (late documents).

**Closing rules:**
- Closing with open warnings needs an acknowledgement reason of at least 10 characters.
- The CLOSED event stores the reason, the previous and new status, every control with its result, and the acknowledged warnings. It is also audit-logged.
- Closing is never done by the preparer and needs `gst_periods.close`.

**Snapshots and reopening:**
- Approved and closed periods always show their snapshot.
- Reopening is unchanged from Gate B: Super Admin only (`gst_periods.reopen`), with a reason.
- A period with a filing record is never reopened.

### 19.3 The ten reports (`gst_control_report`, permission `gst.read`)
| # | Report | Sources |
|---|---|---|
| 1 | Tax liability | Issued invoices and notes, output ledgers, GSTR-1 / GSTR-3B (calculated, adjusted, snapshot), approved adjustments |
| 2 | Input tax credit | Posted supplier invoices by ITC status (pending, proposed, eligible, partially eligible, ineligible), ITC events (availed, reversed decisions, reversals, reclaims), input / pending / ineligible ledgers, GSTR-3B section 4 |
| 3 | GSTR-2B | Documents by category (exact, partial, non-exact, unapproved, missing in books, supplier notes), each with the tolerance and configuration version applied; reversed / rejected / superseded matches, amendments, duplicates, missing in GSTR-2B |
| 4 | Reverse charge | Direct RCM supplier invoices, RCM payable ledger, RCM set-offs, ITC on RCM invoices (receipt-matched RCM is not supported) |
| 5 | GST cash ledger | Challans and payment attempts (only successful, posted payments counted), bank voucher lines (masked account numbers), electronic cash ledger |
| 6 | GST credit ledger | Opening + accrual − utilisation = closing as of the period end; reversals and reclaims; current available credit |
| 7 | GST vouchers | Vouchers on GST ledgers with source documents, posting events, reversal links and flags (unexplained, duplicate source); documents without a voucher; posting problems |
| 8 | Completeness and exceptions | Return exceptions and unresolved GSTR-2B supplier notes, by severity |
| 9 | GSTR-1 vs GSTR-3B | Domestic, zero-rated and nil / exempt lines per head: calculated, adjusted and snapshot values, differences and explanations |
| 10 | Period close and audit | Lifecycle, registration, snapshots and hashes, history, adjustments, filing records (including voided), set-offs, payment of tax, close controls, exceptions, late documents |

**Filtering and permissions:**
- Every report accepts a return period or a date range, except report 10, which needs a period.
- A date range shows live, calculated values without snapshots.
- Report 5 additionally needs `gst_payments.create` or `gst_payments.post`, so Admin and Management Viewer cannot open it.

**Read-only guarantee:** every report runs in a READ ONLY transaction, and none creates, posts or changes anything.

### 19.4 Exports and print
**Header on every export and print view:**
- company and GSTIN;
- financial year and tax period;
- generation time and configuration version;
- snapshot reference (version and SHA-256);
- value status (calculated / adjusted / approved / filed);
- the disclaimer: *"Prepared by Alton ERP for review and working purposes. This document is not proof of filing with the GST Portal. The taxpayer must independently verify and file the return on the official GST Portal."*

**Formats:**
- **Excel:** one named sheet per table; amounts as numbers in the INR format `#,##,##0.00` with negatives in red.
- **CSV:** one per table, with the header lines and 2-decimal amounts; formula-like text is neutralised.
- **Print:** inside the app's `print-area`, A4 landscape, "Page n of m" and a footer note; screen controls are hidden. This also fixes the Gate D print buttons, which printed blank under the app's global print rule.

Exporting never changes any record.

### 19.5 Permissions reviewed
| Action | Permission |
|---|---|
| View reports | `gst.read` |
| Prepare and review | `gst_returns.prepare` |
| Approve returns and record filings | `gst_returns.approve` |
| Close | `gst_periods.close` |
| Reopen | `gst_periods.reopen` (Super Admin only) |
| Payment details | `gst_payments.create` / `gst_payments.post` |

No permission was widened. Bank account numbers are only ever shown masked.

### 19.6 Integrity safeguards (tested)
- Approved snapshots are immutable, and closed periods are read from them.
- Late documents appear as live differences.
- Historical credit is exact as of the period end, and later set-offs never change a snapshot.
- Every match records its configuration tolerance; a non-exact match is never labelled exact.
- A GSTR-2B match neither makes ITC eligible nor creates a decision.
- Reports, readiness checks and return views change nothing (fingerprint test) and post no vouchers.

### 19.7 Outstanding integration tests (need a separate non-production Supabase project; never production credentials)
**Real Supabase Storage:**
- upload;
- cross-user and cross-company denial;
- download-grant expiry;
- no overwrite;
- no unauthorised delete;
- force-reset cleanup limited to the company's objects.

**Real Deno / Supabase Edge runtime (`gst-2b-verify`):**
- valid CSV and XLSX;
- merged headers;
- wrong checksum;
- malformed, oversized and wrong-type files;
- unauthorised requests;
- duplicate imports.

### 19.8 Production-readiness register (requirements, not permission to deploy)
1. Real Supabase Storage tests (19.7).
2. Real Edge Function runtime tests (19.7).
3. Encryption of restricted bank account numbers with a separately managed key before real bank details are stored.
4. Review of the bank negative-balance protection for overdraft and cash-credit accounts and backdated transactions.
5. Independent validation of GSTR-1 / GSTR-3B outputs against the official GST Portal.
6. Review of ITC timing (by voucher date), reversals and reclaims.
7. Review of GST permissions and the Super Admin reopening restriction.
8. Final regression and security review.

### 19.9 Known limitations
- Credit notes against export invoices are reported in 3.1(a) / CDNUR, not netted against 3.1(b).
- Reverse charge is supported on direct supplier invoices only.
- Reading reports is not audit-logged, because reports must run in read-only transactions. Sensitive actions (close, reopen, filing records, adjustments, matches, uploads, downloads) are.

### 19.10 Baseline failures (pre-existing, tracked separately)
- 5 unit-test failures (Acefone / CRLF).
- Intermittent UI smoke steps: Support Workspace layout, BOM, Product Master columns.
- Filtered-run "Password reset" UI failures.
- ERP reset suite cannot complete (missing Acefone `support_call_signals`).
- 2 force-reset failures.
- 7 standalone SQL / DB scripts.
