# Dashboard drill-down

Every figure on the ERP's dashboards opens the records behind it. The records page shows the same number as the card, because both use one shared rule.

## How it works

| Piece | File |
|---|---|
| Filter rules (conditions), applied to the server query, to rows from database functions, and turned into SQL for the test | [drill-conditions.ts](../src/features/drilldown/drill-conditions.ts) |
| The 87 figures: dashboard, rule, source list, permission, measure, and the dashboard field it matches | [drill-registry.ts](../src/features/drilldown/drill-registry.ts) |
| Columns, record links and module list per source | [drill-columns.ts](../src/features/drilldown/drill-columns.ts) |
| Links from dashboards (hidden without permission); dashboard period and filters kept in the address | [use-drill.ts](../src/features/drilldown/use-drill.ts) |
| Records page `/drilldown/:figure` | [drilldown-page.tsx](../src/pages/drilldown-page.tsx), [drilldown.ts](../src/services/drilldown.ts) |
| Product Master opened from a figure (banner, Clear filters) | [products-page.tsx](../src/pages/products-page.tsx), [drill-banner.tsx](../src/features/drilldown/drill-banner.tsx) |
| Clickable cards and charts | [kpi-card.tsx](../src/components/common/kpi-card.tsx), [chart-card.tsx](../src/components/common/chart-card.tsx), `src/components/charts/*` (`onSelect`) |

- **Product Master figures** open the existing Product Master list with the rule applied. All other figures open the generic records page.
- **The records page** is filtered, counted, searched, sorted and paged on the server, through the same views and RLS as the module lists. It also has:
  - column choice, Excel export (up to 20,000 rows) and Print / PDF;
  - refresh, plus loading, empty and error states;
  - a breadcrumb back to the dashboard with the same period and filters;
  - links to the original record and to the module's own list.
- **Statuses the database computes** come from the existing database functions, filtered with the same rules: sales order status (`sales_orders_v2_list`), party balances (`ledger_parties`), and shortage lists (`production_dashboard`, `sales_dashboard`).
- **Charts** open the records of the bar, segment or point clicked: a period bucket (clipped to the dashboard period, as the database counts it), a month, a supplier, a category, a warehouse or a stock status. The chart's table view has the same links, for keyboard users.
- **Dashboard filters** stay in the address bar (period, customer, status, payment), so browser Back returns to the same view.

No database migration, view, function or index was added.

## Data accuracy

`npm run test:db:drilldown` ([drilldown-consistency-check.mjs](../tests/db/drilldown-consistency-check.mjs)) runs the whole business flow on a local database, then checks all 87 figures:

- It compares each dashboard function's number with the count or total of that figure's records. It runs as the signed-in user, so RLS applies.
- It covers each unit, chart bucket, supplier, category, warehouse and stock-health group, and the sales and invoice dashboards with their filters set.
- It checks a second, empty company too: it sees no figures and no records.
- Result: 439 checks pass. The run fails if any figure is never compared.

## Coverage

| Dashboard | Clickable figures | Charts and lists |
|---|---|---|
| Management (/) | 9 / 9 | sales booked, production output, stock movement, stock by source, invoiced vs collected, purchases ordered vs received; alerts and lists already linked |
| Product | 8 / 8 | lists: View all (without BOM, recently added, low stock) |
| Inventory Overview | 8 / 8 | category, source, movement trend, stock health, warehouse |
| Purchase | 7 / 7 | top suppliers; overdue list: View all |
| GRN | 7 / 7 | recent items: View all |
| Production | 9 / 9 | shortages: View all and links to each material |
| Sales | 12 / 12 | shortages: View all; "Production Required" opens Production Planning (worked out per order line, so not a record count) |
| Invoice | 13 / 13 | monthly trend (invoiced → invoices, received → payments) |
| Ledger | 6 / 6 | outstanding balances: View all |

## Not done, and why

- **Departments without a dashboard in V2:** Admin, HR / Employees, Customer, Supplier, and separate Warehouse and Finance dashboards. They were not invented.
  - Customers, suppliers and balances are covered by the Ledger dashboard.
  - Warehouse stock is covered by the Inventory Overview; GRNs by the GRN dashboard; finance figures by the Invoice and Ledger dashboards.
  - V2 has no HR or attendance data.
- **Figures from the request that are not shown on any dashboard** (for example versioned products, e-invoice and e-way bill counts, TDS) were not added. They would need new dashboard calculations.
- **Click logging:** the security log accepts a fixed list of events in the database. Recording drill-down clicks needs a reviewed migration, so it was not added.
- **Product Master's own summary cards** (on the list page) are not links. The Product Dashboard figures are.
- **Totals on the records page:** money and quantity totals are added up for up to 10,000 records; above that, the page shows the count and points to the Excel export.

## Before release (live check, not done)

1. **Product-type filters.** "Finished goods produced", "Raw materials consumed" and "Components consumed" filter through the related product with a PostgREST join on a view (`product:products!product_id!inner(product_type)`). PostgREST infers this relationship from the base table, which works in recent versions, but it has not been checked against the hosted API. Open these three figures once on the hosted ERP.
2. On the hosted ERP, open a few figures per dashboard and compare the card with the record count.
