import { FlaskConical } from 'lucide-react'

import { cn } from '@/lib/utils'

/** Page-level banner shown whenever any widget on the page renders development sample data. */
export function SampleDataNotice({ className }: { className?: string }) {
  return (
    <div
      role="note"
      className={cn(
        'flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900',
        className,
      )}
    >
      <FlaskConical aria-hidden className="mt-0.5 size-4 shrink-0" />
      <p>
        <span className="font-semibold">Development sample data.</span> Figures, products and customers
        shown here are illustrative placeholders for building the interface — they are not Alton company
        records. Live data will appear once the database is connected.
      </p>
    </div>
  )
}

/** Small inline marker for an individual widget that shows sample data. */
export function SampleTag({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-amber-800 uppercase',
        className,
      )}
      title="Development sample data — not real company records"
    >
      Sample
    </span>
  )
}
