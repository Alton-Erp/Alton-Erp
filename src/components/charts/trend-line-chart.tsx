import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'

import { formatNumber } from '@/lib/format'
import { AXIS_TICK, CHART_COLORS } from './chart-theme'
import { ChartTooltip } from './chart-tooltip'

/** Single-series trend (the card title names the series, so no legend). */
export function TrendLineChart({
  data,
  seriesName,
  valueFormatter = formatNumber,
}: {
  data: { label: string; value: number }[]
  seriesName: string
  valueFormatter?: (value: number) => string
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
        <CartesianGrid vertical={false} stroke={CHART_COLORS.grid} />
        <XAxis dataKey="label" tick={AXIS_TICK} axisLine={false} tickLine={false} minTickGap={24} />
        <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} width={48} tickFormatter={formatNumber} />
        <Tooltip cursor={{ stroke: CHART_COLORS.axis, strokeDasharray: '3 3' }} content={<ChartTooltip valueFormatter={valueFormatter} />} />
        <Line type="monotone" dataKey="value" name={seriesName} stroke={CHART_COLORS.single} strokeWidth={2}
          dot={data.length === 1 ? { r: 4 } : false} activeDot={{ r: 4, stroke: CHART_COLORS.surface, strokeWidth: 2 }} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  )
}
