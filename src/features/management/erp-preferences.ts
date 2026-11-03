import { createContext, useContext } from 'react'

import { LOGO_SRC } from '@/components/layout/company-logo'
import type { ErpPreferences } from '@/services/management'

export interface PreferencesState {
  prefs: ErpPreferences | null
  reload: () => void
}

export const ErpPreferencesContext = createContext<PreferencesState>({ prefs: null, reload: () => {} })

/** ERP Settings that change how forms behave (defaults, units, reasons). Null until loaded. */
export const useErpPreferences = () => useContext(ErpPreferencesContext)

/** Logo printed on invoices, notes and purchase orders: the uploaded one, else the ALTON wordmark. */
export function useDocumentLogo(): string {
  return useContext(ErpPreferencesContext).prefs?.['company.logo_data_url'] || LOGO_SRC
}