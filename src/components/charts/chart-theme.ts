import type { Tone } from '@/config/status'

/*
 * Chart colors as literal hex values (SVG presentation attributes do not
 * reliably resolve CSS variables). Keep in sync with the tokens in index.css.
 *
 * Series pairs were checked with a colour-vision-deficiency validator:
 *   in-house #2563EB vs outsourced #A78BFA  → passes (brand violet #8B5CF6 does not)
 *   inward   #2563EB vs outward    #0D9488  → passes
 */
export const CHART_COLORS = {
  inHouse: '#2563EB',
  outsourced: '#A78BFA',
  inward: '#2563EB',
  outward: '#0D9488',
  single: '#2563EB',
  grid: '#E5E7EB',
  axis: '#6B7280',
  surface: '#FFFFFF',
} as const

export const TONE_FILL: Record<Tone, string> = {
  neutral: '#9CA3AF',
  info: '#2563EB',
  outsourced: '#8B5CF6',
  success: '#16A34A',
  warning: '#F59E0B',
  danger: '#DC2626',
}

export const AXIS_TICK = { fill: CHART_COLORS.axis, fontSize: 12 } as const
