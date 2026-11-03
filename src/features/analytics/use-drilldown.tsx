import { useState } from 'react'

import { DrilldownDialog } from '@/features/analytics/drilldown'
import type { DrillSpec } from '@/services/analytics'

/** Opens a paged list of the source records behind a figure. */
export function useDrilldown() {
  const [spec, setSpec] = useState<DrillSpec | null>(null)
  return { open: setSpec, element: <DrilldownDialog spec={spec} onClose={() => setSpec(null)} /> }
}
