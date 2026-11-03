import { CalendarDays } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { DATE_RANGE_PRESETS, createCustomRange, describeRange, getPresetRange } from '@/lib/date-range'
import { parseIsoDate, toIsoDate } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { DateRangeValue } from '@/types'

interface DateRangeFilterProps {
  value: DateRangeValue
  onChange: (value: DateRangeValue) => void
  className?: string
  /** Defaults to Today / This Month / This Year / Custom. */
  presets?: typeof DATE_RANGE_PRESETS
}

/** Segmented preset picker with a custom range popover. */
export function DateRangeFilter({ value, onChange, className, presets = DATE_RANGE_PRESETS }: DateRangeFilterProps) {
  const [customOpen, setCustomOpen] = useState(false)
  const [draftFrom, setDraftFrom] = useState(toIsoDate(value.from))
  const [draftTo, setDraftTo] = useState(toIsoDate(value.to))
  const [today] = useState(() => toIsoDate(new Date()))
  const draftInvalid = !draftFrom || !draftTo || draftFrom > draftTo

  const openCustom = (open: boolean) => {
    if (open) {
      setDraftFrom(toIsoDate(value.from))
      setDraftTo(toIsoDate(value.to))
    }
    setCustomOpen(open)
  }

  const applyCustom = () => {
    if (draftInvalid) return
    onChange(createCustomRange(parseIsoDate(draftFrom), parseIsoDate(draftTo)))
    setCustomOpen(false)
  }

  return (
    <div className={cn('flex flex-col items-start gap-1.5 lg:items-end', className)}>
      <div role="group" aria-label="Date range" className="inline-flex flex-wrap rounded-lg border bg-background p-0.5 shadow-xs">
        {presets.map((preset) => {
          const active = value.preset === preset.value
          const classes = cn(
            'inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors',
            active ? 'bg-primary text-primary-foreground shadow-xs' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
          )

          if (preset.value === 'custom') {
            return (
              <Popover key={preset.value} open={customOpen} onOpenChange={openCustom}>
                <PopoverTrigger asChild>
                  <button type="button" className={classes} aria-pressed={active}>
                    <CalendarDays aria-hidden className="size-3.5" />
                    {preset.label}
                  </button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-80">
                  <form
                    className="space-y-4"
                    onSubmit={(e) => {
                      e.preventDefault()
                      applyCustom()
                    }}
                  >
                    <div>
                      <p className="text-sm font-semibold">Custom date range</p>
                      <p className="text-xs text-muted-foreground">Choose a start and end date.</p>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <Label htmlFor="range-from">From</Label>
                        <Input
                          id="range-from"
                          type="date"
                          value={draftFrom}
                          max={today}
                          onChange={(e) => setDraftFrom(e.target.value)}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="range-to">To</Label>
                        <Input
                          id="range-to"
                          type="date"
                          value={draftTo}
                          max={today}
                          onChange={(e) => setDraftTo(e.target.value)}
                        />
                      </div>
                    </div>
                    {draftInvalid && draftFrom && draftTo && (
                      <p className="text-xs text-shortage">The start date must be on or before the end date.</p>
                    )}
                    <div className="flex justify-end gap-2">
                      <Button type="button" variant="outline" size="sm" onClick={() => setCustomOpen(false)}>
                        Cancel
                      </Button>
                      <Button type="submit" size="sm" disabled={draftInvalid}>
                        Apply
                      </Button>
                    </div>
                  </form>
                </PopoverContent>
              </Popover>
            )
          }

          return (
            <button
              key={preset.value}
              type="button"
              className={classes}
              aria-pressed={active}
              onClick={() => onChange(getPresetRange(preset.value as Exclude<typeof preset.value, 'custom'>))}
            >
              {preset.label}
            </button>
          )
        })}
      </div>
      <p className="text-xs text-muted-foreground">
        Showing: <span className="font-medium text-foreground">{describeRange(value)}</span>
      </p>
    </div>
  )
}
