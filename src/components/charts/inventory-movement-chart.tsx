import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'

import { formatNumber } from '@/lib/format'
import { AXIS_TICK, CHART_COLORS } from './chart-theme'
import { ChartLegend } from './chart-legend'
import { ChartTooltip } from './chart-tooltip'

export interface MovementPoint {
  label: string
  inward: number
  outward: number
}

/** Stock inward vs outward quantity over the selected period (one unit of measure). */
export function InventoryMovementChart({ data }: { data: MovementPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} margin={{ top: 0, right: 12, bottom: 0, left: 0 }}>
        <CartesianGrid vertical={false} stroke={CHART_COLORS.grid} />
        <XAxis dataKey="label" tick={AXIS_TICK} axisLine={false} tickLine={false} minTickGap={24} />
        <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} width={48} tickFormatter={formatNumber} />
        <Tooltip
          cursor={{ stroke: CHART_COLORS.axis, strokeDasharray: '3 3' }}
          content={<ChartTooltip valueFormatter={formatNumber} />}
        />
        <Legend verticalAlign="top" align="left" height={32} content={<ChartLegend />} />
        <Line
          type="monotone"
          dataKey="inward"
          name="Inward"
          stroke={CHART_COLORS.inward}
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 4, stroke: CHART_COLORS.surface, strokeWidth: 2 }}
          isAnimationActive={false}
        />
        <Line
          type="monotone"
          dataKey="outward"
          name="Outward"
          stroke={CHART_COLORS.outward}
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 4, stroke: CHART_COLORS.surface, strokeWidth: 2 }}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  )
}
