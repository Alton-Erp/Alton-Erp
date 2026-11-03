import { Bar, BarChart, CartesianGrid, Cell, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'

import { AXIS_TICK, CHART_COLORS, TONE_FILL } from '@/components/charts/chart-theme'
import { ChartTooltip } from '@/components/charts/chart-tooltip'

/** Horizontal bars that may be negative (e.g. contribution after advertising): green above zero, red below. */
export function SignedBarChart({ data, seriesName, valueFormatter = String, labelWidth = 130 }: {
  data: { label: string; value: number }[]
  seriesName: string
  valueFormatter?: (v: number) => string
  labelWidth?: number
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} layout="vertical" margin={{ top: 0, right: 24, bottom: 0, left: 0 }} barCategoryGap={6}>
        <CartesianGrid horizontal={false} stroke={CHART_COLORS.grid} />
        <XAxis type="number" tick={AXIS_TICK} axisLine={false} tickLine={false} tickFormatter={(v: number) => valueFormatter(v)} />
        <YAxis type="category" dataKey="label" width={labelWidth} tick={AXIS_TICK} axisLine={false} tickLine={false} />
        <ReferenceLine x={0} stroke={CHART_COLORS.axis} />
        <Tooltip cursor={{ fill: 'rgba(0,0,0,0.04)' }} content={<ChartTooltip valueFormatter={valueFormatter} />} />
        <Bar dataKey="value" name={seriesName} radius={[0, 4, 4, 0]} maxBarSize={18}>
          {data.map((d) => <Cell key={d.label} fill={d.value < 0 ? TONE_FILL.danger : TONE_FILL.success} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}
