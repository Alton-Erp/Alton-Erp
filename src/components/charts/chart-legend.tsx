interface LegendEntry {
  value?: unknown
  color?: string
}

/** Compact legend rendered by Recharts via `content={<ChartLegend />}`. Text stays in ink color. */
export function ChartLegend({ payload }: { payload?: ReadonlyArray<LegendEntry> }) {
  if (!payload?.length) return null
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 pb-2 text-xs text-muted-foreground">
      {payload.map((entry, i) => (
        <li key={i} className="flex items-center gap-1.5">
          <span aria-hidden className="size-2.5 rounded-sm" style={{ backgroundColor: entry.color }} />
          {String(entry.value ?? '')}
        </li>
      ))}
    </ul>
  )
}
