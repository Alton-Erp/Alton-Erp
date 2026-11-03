import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'

import { setImportDateOrder } from '@/features/production/production-v2-model'
import { setDatePattern } from '@/lib/format'
import { fetchErpPreferences, type ErpPreferences } from '@/services/management'

import { ErpPreferencesContext } from './erp-preferences'

/**
 * Loads the ERP Settings that change how the screens behave (date format,
 * import date order, form defaults, document logo) once per session. Without a
 * database connection, or if loading fails, the built-in defaults stay in use.
 */
export function ErpPreferencesProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<ErpPreferences | null>(null)
  const [version, setVersion] = useState(0)
  useEffect(() => {
    let live = true
    fetchErpPreferences()
      .then((p) => {
        if (!live || !p) return
        setDatePattern(p['general.date_format'])
        setImportDateOrder(p['import.date_order'])
        setPrefs(p)
      })
      .catch(() => { /* defaults stay in use */ })
    return () => { live = false }
  }, [version])
  const reload = useCallback(() => setVersion((n) => n + 1), [])
  const value = useMemo(() => ({ prefs, reload }), [prefs, reload])
  // Re-render the pages once if a non-default date format arrives (keyed on it).
  const pattern = prefs?.['general.date_format']
  return <ErpPreferencesContext.Provider value={value}><div key={!pattern || pattern === 'DD MMM YYYY' ? 'default' : pattern} className="contents">{children}</div></ErpPreferencesContext.Provider>
}