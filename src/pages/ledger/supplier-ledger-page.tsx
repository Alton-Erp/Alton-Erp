import LedgerPage from '@/pages/ledger-page'

/** /ledger/suppliers — the ledger list limited to suppliers (and parties that are both). */
export default function SupplierLedgerPage() {
  return <LedgerPage scope="SUPPLIER" />
}
