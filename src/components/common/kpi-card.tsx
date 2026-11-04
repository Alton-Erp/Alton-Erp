import { ArrowUpRight, type LucideIcon } from 'lucide-react'
import { Link } from 'react-router-dom'

import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'

export type KpiAccent = 'neutral' | 'manufacturing' | 'outsourced' | 'hybrid' | 'available' | 'pending' | 'shortage'

const ACCENT_CLASSES: Record<KpiAccent, string> = {
  neutral: 'bg-gray-100 text-gray-600',
  manufacturing: 'bg-blue-50 text-manufacturing',
  outsourced: 'bg-violet-50 text-outsourced',
  hybrid: 'bg-teal-50 text-hybrid',
  available: 'bg-green-50 text-available',
  pending: 'bg-amber-50 text-amber-600',
  shortage: 'bg-red-50 text-shortage',
}

interface KpiCardProps {
  label: string
  /** Pre-formatted value. `null` renders a dash for "no data yet". */
  value: string | null
  unit?: string
  hint?: string
  icon: LucideIcon
  accent?: KpiAccent
  className?: string
  /** Drill-down: the list of records behind the figure. Without it (or without permission) the card is not a link. */
  to?: string | null
  testId?: string
}

export function KpiCard({ label, value, unit, hint, icon: Icon, accent = 'neutral', className, to, testId }: KpiCardProps) {
  const link = to && value !== null ? to : null
  const body = (
    <>
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-medium text-muted-foreground">{label}</p>
        <span className={cn('flex size-9 shrink-0 items-center justify-center rounded-lg', ACCENT_CLASSES[accent])}>
          <Icon aria-hidden className="size-[18px]" />
        </span>
      </div>
      <div className="flex items-baseline gap-1.5">
        <span className="text-2xl font-semibold tracking-tight text-foreground tabular-nums">
          {value ?? '—'}
        </span>
        {unit && value !== null && <span className="text-sm text-muted-foreground">{unit}</span>}
      </div>
      {(hint || value === null) && (
        <p className="-mt-1 text-xs text-muted-foreground">{value === null ? (hint ? `No data yet · ${hint}` : 'No data yet') : hint}</p>
      )}
      {link && (
        <span className="-mt-1 inline-flex items-center gap-1 text-xs font-medium text-primary opacity-80 transition-opacity group-hover:opacity-100">
          View records <ArrowUpRight aria-hidden className="size-3.5 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
        </span>
      )}
    </>
  )
  if (!link) {
    return <Card className={cn('gap-3 p-5', className)} data-testid={testId}>{body}</Card>
  }
  return (
    <Link to={link} data-testid={testId} data-drill="kpi" aria-label={`${label}: ${value}${unit ? ` ${unit}` : ''} — view records`}
      className="group block rounded-xl outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
      <Card className={cn('h-full cursor-pointer gap-3 p-5 transition-all duration-150 group-hover:-translate-y-0.5 group-hover:border-primary/40 group-hover:shadow-md motion-reduce:transform-none', className)}>
        {body}
      </Card>
    </Link>
  )
}
