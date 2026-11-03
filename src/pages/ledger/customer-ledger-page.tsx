import LedgerPage from '@/pages/ledger-page'

/** /ledger/customers — the ledger list limited to customers (and parties that are both). */
export default function CustomerLedgerPage() {
  return <LedgerPage scope="CUSTOMER" />
}
