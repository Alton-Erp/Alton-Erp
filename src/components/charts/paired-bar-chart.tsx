import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'

import { formatNumber } from '@/lib/format'
import { AXIS_TICK, CHART_COLORS } from './chart-theme'
import { compactIndian } from './chart-layout'
import { ChartLegend } from './chart-legend'
import { ChartTooltip } from './chart-tooltip'

export interface PairedBarPoint {
  label: string
  a: number
  b: number
}

/**
 * Two series side by side per period (e.g. planned vs actual, in-house vs
 * outsourced). One unit of measure only; the caller never mixes units.
 */
export function PairedBarChart({
  data,
  aName,
  bName,
  aColor = '#9CA3AF',
  bColor = CHART_COLORS.single,
  stacked = false,
  valueFormatter = formatNumber,
  onSelect,
}: {
  data: PairedBarPoint[]
  aName: string
  bName: string
  aColor?: string
  bColor?: string
  stacked?: boolean
  valueFormatter?: (value: number) => string
  /** Opens the records behind a bar (index of the period, series a or b). */
  onSelect?: (index: number, series: 'a' | 'b') => void
}) {
  const pick = (series: 'a' | 'b') => (onSelect ? (_: unknown, index: number) => onSelect(index, series) : undefined)
  const cursor = onSelect ? { cursor: 'pointer' } : undefined
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 0, right: 12, bottom: 0, left: 0 }} barGap={2} barCategoryGap="20%">
        <CartesianGrid vertical={false} stroke={CHART_COLORS.grid} />
        <XAxis dataKey="label" tick={AXIS_TICK} axisLine={false} tickLine={false} minTickGap={16} interval="preserveStartEnd" />
        <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} width={60} tickFormatter={compactIndian} />
        <Tooltip cursor={{ fill: '#F3F4F6' }} content={<ChartTooltip valueFormatter={valueFormatter} />} />
        <Legend verticalAlign="top" align="left" height={32} content={<ChartLegend />} />
        <Bar dataKey="a" name={aName} fill={aColor} radius={stacked ? [0, 0, 0, 0] : [4, 4, 0, 0]} maxBarSize={28} stackId={stacked ? 's' : undefined}
          stroke={CHART_COLORS.surface} strokeWidth={stacked ? 1 : 0} isAnimationActive={false} onClick={pick('a')} style={cursor} />
        <Bar dataKey="b" name={bName} fill={bColor} radius={[4, 4, 0, 0]} maxBarSize={28} stackId={stacked ? 's' : undefined}
          stroke={CHART_COLORS.surface} strokeWidth={stacked ? 1 : 0} isAnimationActive={false} onClick={pick('b')} style={cursor} />
      </BarChart>
    </ResponsiveContainer>
  )
}
