interface TooltipEntry {
  name?: string | number
  value?: unknown
  color?: string
  payload?: unknown
}

interface ChartTooltipProps {
  // Injected by Recharts when passed as `content={<ChartTooltip />}`.
  active?: boolean
  payload?: ReadonlyArray<TooltipEntry>
  label?: string | number
  valueFormatter?: (value: number) => string
  /** Overrides the color swatch per entry (e.g. per-bar status colors). */
  colorFor?: (entry: TooltipEntry) => string | undefined
}

export function ChartTooltip({ active, payload, label, valueFormatter = String, colorFor }: ChartTooltipProps) {
  if (!active || !payload?.length) return null
  return (
    <div className="min-w-36 rounded-lg border bg-popover px-3 py-2 text-xs shadow-lg">
      {label !== undefined && label !== '' && <p className="mb-1.5 font-medium text-foreground">{label}</p>}
      <ul className="space-y-1">
        {payload.map((entry, i) => (
          <li key={i} className="flex items-center gap-2">
            <span
              aria-hidden
              className="size-2.5 shrink-0 rounded-sm"
              style={{ backgroundColor: colorFor?.(entry) ?? entry.color }}
            />
            <span className="text-muted-foreground">{entry.name}</span>
            <span className="ml-auto pl-3 font-medium text-foreground tabular-nums">
              {typeof entry.value === 'number' ? valueFormatter(entry.value) : String(entry.value ?? '')}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
