import { Bar, BarChart, CartesianGrid, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'

import { AXIS_TICK, CHART_COLORS } from './chart-theme'
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
}

/** Single-series ranked bar chart with category labels on the axis and values at the bar end. */
export function HorizontalBarChart({
  data,
  seriesName,
  valueFormatter = String,
  labelWidth = 120,
}: HorizontalBarChartProps) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} layout="vertical" margin={{ top: 0, right: 56, bottom: 0, left: 0 }} barCategoryGap={6}>
        <CartesianGrid horizontal={false} stroke={CHART_COLORS.grid} />
        <XAxis type="number" hide domain={[0, 'dataMax']} />
        <YAxis
          type="category"
          dataKey="label"
          width={labelWidth}
          tick={AXIS_TICK}
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
        <Bar dataKey="value" name={seriesName} fill={CHART_COLORS.single} radius={[0, 4, 4, 0]} maxBarSize={22} isAnimationActive={false}>
          {data.map((d) => (
            <Cell key={d.label} fill={d.color ?? CHART_COLORS.single} />
          ))}
          <LabelList
            dataKey="value"
            position="right"
            className="tabular-nums"
            fill="#1F2937"
            fontSize={12}
            formatter={(v: unknown) => (typeof v === 'number' ? valueFormatter(v) : '')}
          />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}
