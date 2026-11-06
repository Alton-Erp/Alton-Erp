// Product image links for display: the uploaded image (private storage, signed link) when there is one,
// otherwise the external image link. Signed links are cached for 50 minutes (they last 60).

import { useEffect, useState } from 'react'

import { fetchProductImageRefs, getProductImageUrls, type ProductImageRef } from '@/services/products'

const signed = new Map<string, { url: string; until: number }>()
const EMPTY = new Map<string, string | null>()

/** Resolves display links for products: signed link of the uploaded image, else the image link, else null. */
export async function resolveProductImages(refs: ProductImageRef[]): Promise<Map<string, string | null>> {
  const now = Date.now()
  const missing = [...new Set(refs.map((r) => r.product_image_path).filter((p): p is string => Boolean(p)))]
    .filter((p) => (signed.get(p)?.until ?? 0) <= now)
  if (missing.length > 0) {
    try {
      const urls = await getProductImageUrls(missing)
      for (const [path, url] of urls) signed.set(path, { url, until: now + 50 * 60 * 1000 })
    } catch {
      // Uploaded images unavailable: fall back to the links.
    }
  }
  const out = new Map<string, string | null>()
  for (const r of refs) {
    const upload = r.product_image_path ? signed.get(r.product_image_path)?.url : undefined
    out.set(r.id, upload ?? (r.image_url?.trim() || null))
  }
  return out
}

/** Display links for products already loaded with image_url / product_image_path (Product Master, detail page). */
export function useProductImages(refs: ProductImageRef[]): Map<string, string | null> {
  const key = JSON.stringify(refs.map((r) => [r.id, r.product_image_path ?? null, r.image_url ?? null]))
  const [state, setState] = useState<{ key: string; map: Map<string, string | null> }>({ key: '', map: EMPTY })
  useEffect(() => {
    let cancelled = false
    const list = (JSON.parse(key) as [string, string | null, string | null][]).map(([id, product_image_path, image_url]) => ({ id, product_image_path, image_url }))
    void resolveProductImages(list).then((map) => { if (!cancelled) setState({ key, map }) })
    return () => { cancelled = true }
  }, [key])
  return state.key === key ? state.map : EMPTY
}

/** Display links for product ids (purchase orders, goods receipts, stock lists): reads the image fields first. */
export function useProductImagesById(ids: (string | null | undefined)[]): Map<string, string | null> {
  const key = [...new Set(ids.filter((i): i is string => Boolean(i)))].sort().join(',')
  const [state, setState] = useState<{ key: string; map: Map<string, string | null> }>({ key: '', map: EMPTY })
  useEffect(() => {
    if (!key) return
    let cancelled = false
    fetchProductImageRefs(key.split(','))
      .then(resolveProductImages)
      .then((map) => { if (!cancelled) setState({ key, map }) })
      .catch(() => { if (!cancelled) setState({ key, map: EMPTY }) })
    return () => { cancelled = true }
  }, [key])
  return state.key === key ? state.map : EMPTY
}
