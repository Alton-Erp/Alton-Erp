/** Products on a support ticket (Product Master selector): pure helpers shared by the New Ticket form and the ticket page. */

export interface PickedProduct { product_id: string; sku: string; product_name: string; quantity: string; archived?: boolean; detail?: string | null }

/** Identifiers shown under a product: product code (model number), barcode, EAN. */
export const productDetail = (p: { model_number: string | null; barcode: string | null; ean: string | null }) =>
  [p.model_number && `Code ${p.model_number}`, p.barcode && `Barcode ${p.barcode}`, p.ean && `EAN ${p.ean}`].filter(Boolean).join(' · ') || null

/** Quantity check used before saving (the database repeats it). */
export const quantityError = (q: string) => (/^\d{1,9}(\.\d{1,3})?$/.test(q.trim()) && Number(q) > 0 ? null : 'Quantity must be more than 0 (at most 3 decimals).')
