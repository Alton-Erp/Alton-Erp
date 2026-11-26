# ERP search — Product Master, BOM, Inventory, Production, Outsourcing

Migration `supabase/migrations/20261231090900_erp_search.sql` (rollback `supabase/rollback/20261231090900_erp_search_down.sql`),
client rule `src/lib/search.ts`.

## The rule (same in the browser and in the database)

1. The text is normalised: leading/trailing spaces removed, runs of spaces / tabs collapsed, case ignored, at most 200 characters,
   at most 8 distinct words of 60 characters each.
2. **Every word must occur — at the start, in the middle or at the end — in at least one searchable field of the record, or of a
   related record.** Word order does not matter.
3. An empty search matches everything (the normal list is shown).
4. `%`, `_` and `\` typed by the user are matched literally; quotes, commas, dots and parentheses in SKUs are safe.

So `ALTON Premium Ceramic Wash Basin White` is found by `ALTON`, `Premium`, `Ceramic`, `Wash`, `Basin`, `White`, `mic`, `eram`,
`asin`, `basin white`, `white basin`, `   alton    basin  `.

Why multi-word means "every word" (AND), not "any word" (OR): every extra word narrows the list, which is what users expect
when they type more. The whole phrase is also accepted as typed (so a free-format SKU such as `WC 200 #A` matches exactly).

| Where | Implementation |
| --- | --- |
| Browser lists (`DataTable`) | `matchesSearch` over the columns' search values |
| PostgREST list queries | `searchFilter(text, fields, extra?)` → one `or=(…)` logic tree: the phrase in any field, or `and(or(word 1 in some field), or(word 2 …))` |
| SQL | `private.search_patterns(text)` + `private.search_match(haystack, patterns)` |

## Related-record search (server-side RPCs)

Security INVOKER functions, so the caller's row-level security, company and permissions apply exactly as on the list views.
Each returns the matching rows of the existing list view as one JSON array (every view column, so pages keep their row type), filtered by `p_status` (null = all; `ACTIVE` = not archived for BOMs; `OPEN` = not completed / cancelled for orders; otherwise that status), in list order. They return `jsonb` rather than `setof <view>` deliberately: a function typed by a view's row type would block later migrations from dropping and re-creating the view. Granted to
`authenticated` only (not `anon`, `public` or `service_role`). Result cap: 2,000 by default, at most 5,000.

| RPC | Searches |
| --- | --- |
| `bom_search(search, status, limit)` | BOM code, `v<version>`, status, notes; finished product (SKU, name, barcode, EAN, description, brand, model, supplier model, category…); **every component** (SKU, name, barcode, EAN, description, model, supplier model) |
| `production_order_search(search, status, limit)` | Order number, status, priority, BOM code / version, product SKU / name (and snapshots), warehouses, notes; **component materials**; output receipts, batches, locations; material issue batches, ledger numbers, locations |
| `outsourcing_order_search(search, status, limit)` | Order number, type, status; **vendor** name and the vendor master's code / legal / display name; vendor reference, reference number; product; BOM; warehouse / external location; **materials**; receipts (number, challan / supplier document number, batch, ledger number); material movements |

Each record appears once, however many related rows match.

Existing database searches moved to the rule (each redefined from its latest text; the rollback restores it verbatim):
`inventory_stock_position` (Inventory overview), `bom_component_search` (BOM component picker), `bom_bulk_current_boms`
(bulk BOM changes — now also by component) and the product part of `global_search` (header search).

## Indexes

Substring search cannot use B-tree indexes. Where the `pg_trgm` extension is available (Supabase), the migration creates it
(schema `extensions`) and multi-column GIN trigram indexes:

| Index | Columns |
| --- | --- |
| `products_search_trgm` | sku, product_name, barcode, ean, description, brand, model_number, supplier_model_number, hsn_code |
| `boms_search_trgm` | bom_code |
| `production_orders_search_trgm` | production_order_number, product_sku_snapshot, product_name_snapshot |
| `outsourcing_orders_search_trgm` | outsourcing_order_number, supplier_name, supplier_reference, reference_number |
| `inventory_transactions_search_trgm` | transaction_number, reference_number |
| `inventory_batches_search_trgm` | batch_number |
| `suppliers_search_trgm` | supplier_code, legal_name, display_name |

Where `pg_trgm` is not available the migration skips the indexes with a notice, and search still works with plain ILIKE.
Measured (`npm run test:db:erp-search`, 20,000 extra products, local machine): PostgreSQL 17 with pg_trgm — global
search 321 ms, BOM related search 13 ms, stock position search 391 ms, list-style substring filter 16 ms, trigram index used
by the planner. PGlite (no pg_trgm) — 1.5 s / 8 ms / 1.6 s / 34 ms.

## Search boxes (UX)

- Server searches are debounced 300 ms (pickers 250 ms) and use the normalised text, so `basin  white` and `basin white` do
  not send two requests; the same text is never sent twice in a row.
- Outdated responses are ignored (`useAsync` and the pickers cancel earlier loads).
- The loaded rows stay visible during a server search; a spinner replaces the search icon.
- Escape or the × button clears the search; the typed text is kept while results load; the no-results message explains
  the rule.
- Product Master starts from a `?q=` search in the address (links from other pages); page filters, sorting and paging are unchanged.

## Per-page audit

| Page | Before | Fields searched now | Limitation found | Fix | Verified by |
| --- | --- | --- | --- | --- | --- |
| Product Master (`/products`) | Server, one phrase in 9 fields | SKU, name, barcode, EAN, model, brand, supplier model, supplier product name, group head, description, HSN, type, source, unit, category name / code, dimensions (numbers) | Phrase only: `basin white` did not find "… Basin White" if words were apart; description / category not searched | `searchFilter` with `PRODUCT_SEARCH_FIELDS` + category / dimension extras | unit `erp-search.test.ts`; smoke "ERP search 2", "search and sort" |
| Product categories | DataTable, one substring per column | Name, code (column values) | Phrase per column | DataTable word rule | unit (DataTable rule) |
| BOM list (`/production/boms`) | Newest 2,000 BOMs, filtered in the browser, phrase per column | BOM code, version, status, notes, finished product, all components | No component search; BOMs beyond the 2,000 loaded rows not found | `bom_search` RPC (server) + DataTable `onQueryChange` / `serverQuery` | DB `erp-search-check`; smoke "ERP search 1" |
| BOM editor component / product pickers | Server, phrase in 5 fields, 200 ms debounce | SKU, name, barcode, EAN, model, supplier model, brand, description | Phrase only; description / brand not searched | `searchFilter`; 250 ms normalised debounce | unit; DB (`bom_component_search`) |
| Bulk BOM changes (current BOMs, component search) | SQL phrase on SKU / name / BOM code | + components | Phrase only, no component | `bom_bulk_current_boms` / `bom_component_search` on the rule | DB `erp-search-check`, `bom-bulk-check` |
| Stock register (`/inventory/stock-register`) | Server, phrase in SKU / name / barcode | SKU, name, barcode, brand, model, category, type, source | Phrase only, few fields | `searchFilter` with `REGISTER_SEARCH_FIELDS` | unit (service scan); smoke stock steps |
| Stock by location | Server, phrase in SKU / name / barcode / batch | + category, warehouse code / name, location code / name, source | Phrase only; warehouse / bin not searchable | `DETAIL_SEARCH_FIELDS` | as above |
| Stock movements | Server, phrase in SKU / name / transaction / batch | + reference number, warehouse, location, counterpart, transaction type, reason | Phrase only; document references / bins not searchable | `MOVEMENT_SEARCH_FIELDS` | as above |
| Inventory overview (stock position) | SQL phrase on SKU / name / barcode / supplier model | All product fields + category | Phrase only | `inventory_stock_position` on the rule | DB `erp-search-check` |
| Product pickers (opening stock, production entry, reports, adjustments) | Server, unquoted phrase in SKU / name / barcode | SKU, name, barcode, EAN, model, supplier model, brand, description | Phrase only; punctuation was stripped from the search | `PICKER_PRODUCT_FIELDS`, quoted values, normalised debounce | unit |
| Reservations, low-stock alerts, adjustments, whole-piece audit | DataTable phrase per column | Column values | Phrase per column | DataTable word rule | unit |
| Production orders | Newest 2,000 orders, browser phrase per column | Number, product, BOM, warehouses, components, batches, receipts | Orders beyond 2,000 not found; no component / batch search | `production_order_search` RPC | DB; smoke |
| Material consumption | Period rows (3,000), browser | + server: order number, SKU, name, batch, warehouse, location, ledger number, status, source | Rows beyond the 3,000 loaded not found | `CONSUMPTION_SEARCH_FIELDS` server filter | unit; smoke |
| Finished goods receipts | Period rows (3,000), browser | receipt, order, SKU, name, batch, location, warehouse, ledger number, quality, status | as above | `OUTPUT_SEARCH_FIELDS` | unit; smoke |
| Production planning / reports | DataTable; lot search phrase | Column values; lots by batch or product (SKU, name, barcode, EAN) | Phrase only | DataTable rule; `searchLots` via `searchFilter` | unit |
| Outsourcing orders (route removed in V2; code kept) | Newest 2,000, browser | Number, vendor name / code, references, product, materials, challans, batches | No vendor-code / material / challan search | `outsourcing_order_search` RPC | DB |
| Outsourced receipts (route removed in V2; code kept) | Period rows, browser | receipt, order, vendor, SKU, name, batch, challan, location, status | Rows beyond loaded not found | `OUTSOURCING_RECEIPT_SEARCH_FIELDS` | unit |
| Header global search | SQL phrase on SKU / name / HSN / barcode | All product fields + category (products part) | Phrase only | `global_search` products part on the rule | DB |

## Tests

- `npm run test:unit` → `tests/unit/erp-search.test.ts` (normalisation, the required examples, server filter = client rule, escaping, filter shape).
- `npm run test:db:erp-search` → `tests/db/erp-search-check.mjs` (PGlite; or `ERP_SEARCH_PG_URL` + `ERP_SEARCH_PG_MODULE` against an
  empty disposable PostgreSQL): rule, related-record search, no duplicates, status filter / limit / order / row shape, no dependency on the views, existing searches, company isolation,
  permissions, anon refusal, security invoker, hostile input, 20,000-row timing, trigram plan, rollback and re-apply.
- `npm run test:ui` → "ERP search 1" / "ERP search 2".

## Remaining limitations

- Matching is substring, not fuzzy: a misspelt word (`basn`) does not match.
- Without `pg_trgm` (local PGlite) substring search scans rows; with it, the GIN indexes keep it fast.
- Related-record RPCs return at most 5,000 records (default 2,000); paging past that needs a narrower search.
- Outsourcing orders store the vendor as a name; the vendor master's code is found when its legal or display name equals that name.
