import type { LucideIcon } from 'lucide-react'

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
}

export function KpiCard({ label, value, unit, hint, icon: Icon, accent = 'neutral', className }: KpiCardProps) {
  return (
    <Card className={cn('gap-3 p-5', className)}>
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
    </Card>
  )
}
