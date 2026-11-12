import { useState } from 'react'

import { ChartCard } from '@/components/common/chart-card'
import { Button } from '@/components/ui/button'
import { HorizontalBarChart } from './horizontal-bar-chart'
import { barCardHeight, rankTopN } from './chart-layout'

export interface RankedBarRow {
  label: string
  value: number
  /** Drill-down link of the row (also used when its bar is clicked). */
  href?: string | null
}

/**
 * Ranked horizontal bar chart in a card: largest first, the first `limit` rows with the rest
 * grouped into "Others" until "Show all" is chosen. The card grows with the rows (scrolling inside
 * past a maximum), and the table view always lists every row with its full name and value.
 */
export function RankedBarCard({
  title,
  description,
  rows,
  seriesName,
  valueFormatter,
  valueHeader,
  labelHeader,
  limit = 10,
  labelWidth = 170,
  emptyMessage,
  onOpen,
  drillHint,
  testId,
}: {
  title: string
  description?: string
  rows: RankedBarRow[]
  seriesName: string
  valueFormatter: (v: number) => string
  valueHeader: string
  labelHeader: string
  limit?: number
  labelWidth?: number
  emptyMessage?: string
  onOpen?: (href: string) => void
  drillHint?: string
  testId?: string
}) {
  const [showAll, setShowAll] = useState(false)
  const ranked = rankTopN(rows, showAll ? null : limit)
  const all = rankTopN(rows, null)
  const grouped = ranked.find((r) => r.others)
  const canExpand = rows.length > limit + 1
  const hrefOf = (i: number) => (i >= 0 ? rows[i]?.href ?? null : null)
  const clickable = Boolean(onOpen) && rows.some((r) => r.href)
  return (
    <div data-testid={testId} data-rows={rows.length} data-shown={ranked.length}>
      <ChartCard
        title={title}
        description={description}
        isEmpty={rows.length === 0}
        emptyMessage={emptyMessage}
        height={barCardHeight(ranked.length)}
        table={{ headers: [labelHeader, valueHeader], rows: all.map((r) => [r.label, valueFormatter(r.value)]), links: all.map((r) => hrefOf(r.index)) }}
        actions={canExpand ? (
          <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" aria-expanded={showAll} onClick={() => setShowAll((v) => !v)}>
            {showAll ? `Top ${limit}` : `Show all (${rows.length})`}
          </Button>
        ) : undefined}
        footnote={grouped ? `${grouped.members} smaller categories are added up in "Others"; choose Show all or the table view to see each one.` : undefined}
        drillHint={clickable ? drillHint : undefined}
      >
        <HorizontalBarChart
          seriesName={seriesName}
          labelWidth={labelWidth}
          valueFormatter={valueFormatter}
          data={ranked.map((r) => ({ label: r.label, value: r.value, color: r.others ? '#9CA3AF' : undefined }))}
          onSelect={clickable ? (i) => { const h = hrefOf(ranked[i]?.index ?? -1); if (h) onOpen?.(h) } : undefined}
        />
      </ChartCard>
    </div>
  )
}
