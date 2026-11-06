// Product detail: the product image, where it comes from, and (for users who may edit products)
// upload / replace, a copy of the linked image into ERP storage, and a link change.

import { Download, ExternalLink, Loader2, Pencil, Upload } from 'lucide-react'
import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'

import { Button } from '@/components/ui/button'
import { ProductThumb } from '@/features/products/product-image'
import { useProductImages } from '@/features/products/product-image-hooks'
import { describeProductError } from '@/lib/errors'
import { PRODUCT_IMAGE_MAX_BYTES, PRODUCT_IMAGE_TYPES, uploadProductImage } from '@/services/products'
import type { ProductRow } from '@/types/database'

export function ProductImagePanel({ product, canEdit, onChanged }: {
  product: ProductRow
  canEdit: boolean
  onChanged: (notice: { tone: 'success' | 'error'; text: string }) => void
}) {
  const images = useProductImages([product])
  const src = images.get(product.id) ?? null
  const fileInput = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState<'upload' | 'copy' | null>(null)
  const link = product.image_url?.trim() || null

  const upload = async (file: File) => {
    if (!PRODUCT_IMAGE_TYPES.includes(file.type)) return onChanged({ tone: 'error', text: 'Use a JPEG, PNG or WebP image.' })
    if (file.size > PRODUCT_IMAGE_MAX_BYTES) return onChanged({ tone: 'error', text: 'Images must be 2 MB or smaller.' })
    setBusy('upload')
    try {
      await uploadProductImage(product, file)
      onChanged({ tone: 'success', text: 'Image uploaded.' })
    } catch (error) {
      onChanged({ tone: 'error', text: `The image could not be uploaded: ${error instanceof Error && !('code' in error) ? error.message : describeProductError(error)}` })
    } finally {
      setBusy(null)
    }
  }

  // The browser downloads the linked image (never a server), so only hosts that allow it work. The link is kept as the source.
  const copyLink = async () => {
    if (!link) return
    setBusy('copy')
    try {
      const response = await fetch(link, { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' })
      if (!response.ok) throw new Error(`the image host answered ${response.status}`)
      const blob = await response.blob()
      const type = PRODUCT_IMAGE_TYPES.includes(blob.type) ? blob.type : null
      if (!type) throw new Error('the link is not a JPEG, PNG or WebP image')
      if (blob.size > PRODUCT_IMAGE_MAX_BYTES) throw new Error('the image is larger than 2 MB')
      await uploadProductImage(product, new File([blob], 'linked-image', { type }))
      onChanged({ tone: 'success', text: 'A copy of the linked image is saved in ERP storage. The link is kept as its source.' })
    } catch (error) {
      const why = error instanceof TypeError ? 'the image host does not allow copying' : error instanceof Error && !('code' in error) ? error.message : describeProductError(error)
      onChanged({ tone: 'error', text: `The linked image could not be copied (${why}). The link is unchanged; download the image and upload it instead.` })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex w-44 shrink-0 flex-col gap-2" data-testid="product-image-panel">
      <ProductThumb size="lg" src={src} alt={product.product_name} source={link} className="w-44" />
      <p className="text-xs text-muted-foreground" data-testid="product-image-source">
        {product.product_image_path ? 'Uploaded image' : link ? 'From image link' : 'No image'}
      </p>
      {link && (
        <a href={link} target="_blank" rel="noopener noreferrer" title={link} data-testid="product-image-link"
          className="inline-flex items-center gap-1 truncate text-xs text-primary underline-offset-2 hover:underline">
          <ExternalLink aria-hidden className="size-3 shrink-0" /> <span className="truncate">{link}</span>
        </a>
      )}
      {canEdit && (
        <div className="flex flex-col items-start gap-1">
          <input ref={fileInput} type="file" accept={PRODUCT_IMAGE_TYPES.join(',')} className="hidden" data-testid="product-image-file"
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void upload(f) }} />
          <Button type="button" variant="outline" size="sm" disabled={busy !== null} onClick={() => fileInput.current?.click()}>
            {busy === 'upload' ? <Loader2 className="animate-spin" /> : <Upload />} {product.product_image_path ? 'Replace image' : 'Upload image'}
          </Button>
          {link && !product.product_image_path && (
            <Button type="button" variant="ghost" size="sm" disabled={busy !== null} onClick={() => void copyLink()} data-testid="copy-image-link"
              title="Downloads the linked image in your browser and keeps a copy in ERP storage (works only when the image host allows it)">
              {busy === 'copy' ? <Loader2 className="animate-spin" /> : <Download />} Save a copy in ERP
            </Button>
          )}
          <Button asChild variant="ghost" size="sm">
            <Link to={`/products/${product.id}/edit`}><Pencil /> {link ? 'Change image link' : 'Add image link'}</Link>
          </Button>
        </div>
      )}
    </div>
  )
}
