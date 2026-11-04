import { Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts'

import { ChartLegend } from './chart-legend'
import { ChartTooltip } from './chart-tooltip'

export interface DonutDatum { label: string; value: number; color: string }

/** Share of a whole (e.g. stock value by product type). Use only for values that add up (one unit or money). */
export function DonutChart({ data, seriesName, valueFormatter = String, onSelect }: {
  data: DonutDatum[]; seriesName: string; valueFormatter?: (v: number) => string
  /** Opens the records behind a segment. */
  onSelect?: (index: number) => void
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <PieChart>
        <Tooltip content={<ChartTooltip valueFormatter={valueFormatter} colorFor={(e) => (e.payload as DonutDatum | undefined)?.color ?? '#2563EB'} />} />
        <Pie data={data} dataKey="value" nameKey="label" name={seriesName} innerRadius="55%" outerRadius="85%" paddingAngle={1} isAnimationActive={false}
          onClick={onSelect ? (_: unknown, index: number) => onSelect(index) : undefined} style={onSelect ? { cursor: 'pointer' } : undefined}>
          {data.map((d) => <Cell key={d.label} fill={d.color} />)}
        </Pie>
        <Legend content={<ChartLegend />} verticalAlign="bottom" />
      </PieChart>
    </ResponsiveContainer>
  )
}
