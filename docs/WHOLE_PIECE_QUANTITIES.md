# Whole-piece (PCS) quantities

Migration: `supabase/migrations/20261029090000_whole_piece_quantities.sql`
Read-only audit (run before deploying): `supabase/audit/whole_piece_quantity_audit.sql`
Rollback (manual only): `supabase/rollback/20261029090000_whole_piece_quantities_down.sql`
Tests: `supabase/tests/whole_piece_verification.sql` (118 checks), `tests/unit/whole-units.test.ts`, `npm run test:db:rollback`

## Root cause

A BOM line stores "`quantity_required` per `output_quantity` finished units". Planning computed

```
quantity_required / output_quantity x planned quantity   (rounded UP to 3 decimals)
```

and nothing looked at the unit. With BOM-000001 v3 entered as "2 A1 / 1 A2 / 1 A3 per 70 ALD", 10 ALD became
2 / 70 x 10 = **0.286 PCS** of A1 and 1 / 70 x 10 = **0.143 PCS** of A2 and A3. These figures match the screen
exactly, so this ratio is the most likely data. Confirm it with the audit; it was not visible from here.

The fraction did not stay on screen. It was snapshotted into the production order's material plan, reserved, and
issued. The stock ledger accepted any quantity with up to 3 decimals for every unit, so fractional issues
(and any fractional receipts or adjustments) left balances such as 78.571 PCS. The frontend only displayed what
the database held.

There are no unit-conversion factors, seed data or frontend calculations involved: BOM units must equal the
inventory unit, and no seed data contains these items.

## Policy

| Area | Rule |
|---|---|
| Whole-piece units | PCS, NOS, SET, PAIR and aliases (`private.whole_unit_codes()`, mirrored in `src/features/inventory/whole-units.ts`). Every other unit keeps 3 decimals. |
| BOM | Ratio kept as "N pieces per M finished units". For whole-piece items both N and M must be whole when the BOM is **submitted or approved** (drafts may hold a fraction while being corrected). "1 washer per 2 units" = component 1, output 2. |
| Planning / procurement | `quantity_required x planned x (100 + wastage%) / (100 x output_quantity)`. **Wastage is applied before rounding**, then rounded **up** to the next whole piece. The theoretical requirement (3 dp) and the wastage are still returned and shown, labelled as theoretical. |
| Execution | Production order quantity, material plan, issue, output (good / rejected / scrap), outsourcing ordered / dispatched / returned / received / accepted / rejected / consumed, reservations, purchase order goods lines, goods receipts, adjustments, counts and every stock-ledger posting must be whole for whole-piece items. |
| Enforcement | Database triggers (`*_whole_pieces`) on every table above and on `inventory_transactions`, so no RPC can bypass them. The React forms validate the same rule by text (no float comparison). |
| History | Never changed. Existing fractions are reported and reconciled through the existing approved adjustment workflow. |

Example (ALD, BOM 2 / 1 / 1 per 70): 10 ALD → A1 **1**, A2 **1**, A3 **1** (theoretical 0.286 / 0.143 / 0.143);
70 → 2 / 1 / 1; 71 → 3 / 2 / 2; 140 → 4 / 2 / 2.

If the BOM really meant "2 per ALD", the stored BOM is wrong (output 70 instead of 1) and must be corrected with a
new version. The system cannot tell which is intended, so it does not guess. The audit lists every such ratio as
`THEORETICAL_RATIO` for review.

## Reconciling existing fractional data

1. Run `supabase/audit/whole_piece_quantity_audit.sql` in the SQL Editor (read only) and export the result.
   After deployment the same report is in the app at **Inventory → Whole-piece audit** (`/inventory/whole-piece-audit`),
   for users with `inventory_reconciliation.run` or `audit_logs.read`.
2. **Fractional stock balance (`STOCK_BALANCE`):** count the item physically. Request a stock adjustment
   (Inventory → Stock Adjustments, type *Quantity*, reason *Count variance*) to the whole number counted.
   The request records the system quantity (before) and the counted quantity (after). A second user with
   `inventory.approve_adjustment` approves it (separation of duties), which posts one fractional ADJUSTMENT entry.
   The ledger allows a fractional adjustment only when it leaves the balance whole, so a fraction can be removed
   but never created. A physical count document works the same way.
3. **Wrong fractional posting:** if a posting itself was wrong, an exact reversal (`inventory_reverse_transaction`)
   is allowed.
4. **Open reservation with a fraction:** release it (Stock Reservations, or *Release reservations* on the order).
5. **Order planned with a fraction (`INVALID_PLAN`):** reservation is refused with an explanation. Cancel the order
   (release its reservations) and create it again; the new plan is calculated in whole pieces. Orders with posted
   issues need those issues reversed first (existing rule).
6. **BOM `NEEDS_CORRECTION`:** create a new version with whole pieces per batch.
7. Re-run the audit. `LEDGER_ENTRY` rows remain as history (`INVALID_PHYSICAL` for the original posting,
   `ADJUSTMENT_HISTORY` / `REVERSED_HISTORY` for the corrections). They are never edited.

Until reconciled, integer movements from a fractional balance are allowed, and the remaining fraction stays visible.
Reservations only take whole pieces (48.714 → 48). Screens flag the value with a "fraction" marker and a banner;
the value is never rounded or hidden.

## Production deployment (no staging project)

Nothing here runs automatically; every step is manual.

1. **Before:** take a backup. On Supabase Pro this is Database → Backups or point-in-time recovery; otherwise run
   `supabase db dump`. Note the time.
2. **Audit first (read only):** run `supabase/audit/whole_piece_quantity_audit.sql` in the SQL Editor and save the CSV.
   This is the list of records needing reconciliation; it shows exactly which BOM ratio produced 0.286.
3. **Check pending migrations:** `supabase migration list`. If the supplier and purchase order migrations
   (`20261021…`, `20261022…`, `20261023…`) are not yet on production, they deploy together with this one.
   This migration does not depend on them; it skips purchase tables that do not exist.
4. **Apply:** `supabase db push` (review the list it prints before confirming). The migration only creates or
   replaces functions and adds triggers. It alters no table and changes no data.
5. **Verify on production:** paste `supabase/tests/whole_piece_verification.sql` into the SQL Editor. It must end with
   `WHOLE_PIECE_VERIFICATION_RESULT passed=118 failed=0`. The error is intentional: it rolls back all of its own test
   data (companies WPA / WPB). The check comparing the standalone script is skipped there (it reports "skipped").
   To simulate historical fractions, the suite briefly disables two guards inside its own transaction. That
   locks the stock ledger and material-plan tables for the few seconds it runs, so run it at a quiet time.
6. **Deploy the frontend** build.
7. **Reconcile** the audit findings as described above, with approvals in the app.

## Rollback / recovery

- **Code only:** run `supabase/rollback/20261029090000_whole_piece_quantities_down.sql` in the SQL Editor. It restores
  the previous four functions verbatim and drops the guards and audit functions. It changes no data (proven by
  `npm run test:db:rollback`, which also re-applies the migration afterwards). After a rollback, fractional PCS
  quantities are accepted again. Redeploy the previous frontend build too.
- **Data:** the migration writes no data. Reconciliation adjustments are ordinary approved ledger postings. To undo
  one, reverse its transaction (Stock Movements → reverse); do not restore a backup for that.
- **Re-applying** the migration after a rollback is safe (create-or-replace / drop-if-exists only).
