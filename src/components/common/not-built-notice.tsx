import { Info } from 'lucide-react'

/** Page-level notice for a module that has no backend in this build (see NavItem.notImplemented). */
export function NotBuiltNotice({ module }: { module: string }) {
  return (
    <div role="note" className="mb-4 flex items-start gap-2.5 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
      <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
      <p>
        <span className="font-semibold">{module} is not built in this version of the ERP.</span> This page is a layout preview only: no records are stored
        or shown, and the form cannot be saved.
      </p>
    </div>
  )
}
