import { cn } from '@/lib/utils'

export interface FilterOption<T extends string> {
  value: T
  label: string
  count?: number
}

interface FilterTabsProps<T extends string> {
  options: FilterOption<T>[]
  value: T
  onChange: (value: T) => void
  label: string
  className?: string
}

/** Compact segmented control for switching between a few mutually exclusive filters. */
export function FilterTabs<T extends string>({ options, value, onChange, label, className }: FilterTabsProps<T>) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn('inline-flex max-w-full overflow-x-auto rounded-lg bg-surface-muted p-0.5', className)}
    >
      {options.map((option) => {
        const active = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={cn(
              'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-3 text-sm font-medium whitespace-nowrap transition-colors',
              active ? 'bg-background text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {option.label}
            {option.count !== undefined && (
              <span
                className={cn(
                  'rounded px-1.5 text-xs tabular-nums',
                  active ? 'bg-accent text-accent-foreground' : 'bg-gray-200/70 text-muted-foreground',
                )}
              >
                {option.count}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
