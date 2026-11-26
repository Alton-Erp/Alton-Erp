import { useAsync } from '@/hooks/use-async'
import { fetchAccountingStatus } from '@/services/accounting'

/** Loads the accounting set-up state; Accounts pages render <SetupGate> until the books start date is set. */
export function useAccountingStatus() {
  return useAsync(() => fetchAccountingStatus(), [])
}

export type AccountingStatusState = ReturnType<typeof useAccountingStatus>
