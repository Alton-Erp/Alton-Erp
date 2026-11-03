import type { ApprovalDocType } from '@/services/admin'

export const APPROVAL_DOC_LABELS: Record<string, string> = {
  STOCK_ADJUSTMENT: 'Stock adjustment', STOCK_COUNT: 'Physical count variance', OPENING_STOCK: 'Opening stock', PRODUCTION_ORDER: 'Production order',
  OUTSOURCING_ORDER: 'Outsourcing order', SALES_ORDER: 'Sales order confirmation', INVOICE: 'Invoice issue', CREDIT_NOTE: 'Credit note',
  DEBIT_NOTE: 'Debit note', PAYMENT_REVERSAL: 'Payment reversal', BOM: 'Bill of materials', PURCHASE_ORDER: 'Supplier purchase order',
}

/** What the existing module does once the request is approved (the approval itself never does it). */
export const APPROVAL_GATED_ACTION: Record<ApprovalDocType, string> = {
  STOCK_ADJUSTMENT: 'approving (posting) the adjustment', STOCK_COUNT: 'approving (posting) the count', OPENING_STOCK: 'approving (posting) the opening stock',
  PRODUCTION_ORDER: 'approving the production order', OUTSOURCING_ORDER: 'approving the outsourcing order', SALES_ORDER: 'confirming the sales order',
  INVOICE: 'issuing the invoice', CREDIT_NOTE: 'issuing the credit note', DEBIT_NOTE: 'issuing the debit note', PAYMENT_REVERSAL: 'reversing the receipt',
}

export const APPROVAL_DOC_TYPES = Object.keys(APPROVAL_GATED_ACTION) as ApprovalDocType[]
export const FINANCIAL_TYPES: ApprovalDocType[] = ['INVOICE', 'CREDIT_NOTE', 'DEBIT_NOTE', 'PAYMENT_REVERSAL', 'SALES_ORDER']

export const REQUEST_STATUS_TONE: Record<string, 'info' | 'success' | 'danger' | 'neutral' | 'warning'> = {
  PENDING_APPROVAL: 'warning', APPROVED: 'success', REJECTED: 'danger', CANCELLED: 'neutral',
}
