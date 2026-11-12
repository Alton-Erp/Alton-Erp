import { Bar, BarChart, CartesianGrid, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'

import { AXIS_TICK, CHART_COLORS } from './chart-theme'
import { BAR_ROW_HEIGHT, barChartHeight, labelChars, truncateLabel, valueLabelMargin } from './chart-layout'
import { ChartTooltip } from './chart-tooltip'

export interface HorizontalBarDatum {
  label: string
  value: number
  /** Optional per-bar color (e.g. status colors). Defaults to the single-series blue. */
  color?: string
}

interface HorizontalBarChartProps {
  data: HorizontalBarDatum[]
  seriesName: string
  valueFormatter?: (value: number) => string
  labelWidth?: number
  /** Opens the records behind a bar. */
  onSelect?: (index: number) => void
}

/** Category label on the axis: truncated with an ellipsis, the full name in a native tooltip. */
function CategoryTick({ x, y, payload, maxChars }: { x?: number; y?: number; payload?: { value?: unknown }; maxChars: number }) {
  const full = String(payload?.value ?? '')
  return (
    <text x={x} y={y} dy={4} textAnchor="end" fill={AXIS_TICK.fill} fontSize={AXIS_TICK.fontSize} data-full-label={full}>
      <title>{full}</title>
      {truncateLabel(full, maxChars)}
    </text>
  )
}

/**
 * Single-series ranked bar chart with category labels on the axis and values at the bar end.
 * Each bar gets a fixed row height: with more rows than fit, the chart grows and scrolls inside
 * its card instead of squeezing labels on top of one another.
 */
export function HorizontalBarChart({
  data,
  seriesName,
  valueFormatter = String,
  labelWidth = 120,
  onSelect,
}: HorizontalBarChartProps) {
  const needed = barChartHeight(data.length)
  const right = valueLabelMargin(data.map((d) => valueFormatter(d.value)))
  const maxChars = labelChars(labelWidth)
  return (
    <div className="h-full overflow-y-auto overflow-x-hidden" data-chart="horizontal-bar" data-rows={data.length}>
      <div style={{ height: needed, minHeight: '100%' }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} layout="vertical" margin={{ top: 4, right, bottom: 4, left: 0 }} barCategoryGap={Math.round(BAR_ROW_HEIGHT * 0.25)}>
            <CartesianGrid horizontal={false} stroke={CHART_COLORS.grid} />
            <XAxis type="number" hide domain={[0, 'dataMax']} />
            <YAxis
              type="category"
              dataKey="label"
              width={labelWidth}
              tick={<CategoryTick maxChars={maxChars} />}
              axisLine={false}
              tickLine={false}
              interval={0}
            />
            <Tooltip
              cursor={{ fill: '#F3F4F6' }}
              content={
                <ChartTooltip
                  valueFormatter={valueFormatter}
                  colorFor={(entry) => (entry.payload as HorizontalBarDatum | undefined)?.color ?? CHART_COLORS.single}
                />
              }
            />
            <Bar dataKey="value" name={seriesName} fill={CHART_COLORS.single} radius={[0, 4, 4, 0]} maxBarSize={22} isAnimationActive={false}
              onClick={onSelect ? (_: unknown, index: number) => onSelect(index) : undefined} style={onSelect ? { cursor: 'pointer' } : undefined}>
              {data.map((d, i) => (
                <Cell key={`${d.label}-${i}`} fill={d.color ?? CHART_COLORS.single} />
              ))}
              <LabelList
                dataKey="value"
                position="right"
                offset={6}
                className="tabular-nums"
                fill="#1F2937"
                fontSize={12}
                formatter={(v: unknown) => (typeof v === 'number' ? valueFormatter(v) : '')}
              />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
