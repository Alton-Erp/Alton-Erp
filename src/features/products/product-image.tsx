// Product image thumbnails (links resolved by product-image-hooks.ts). Thumbnails load lazily, keep their aspect ratio on a neutral
// background, and fall back to a placeholder when there is no image or the host does not answer.
// A link that failed once is not requested again in this browser session.

import { ImageOff, ExternalLink } from 'lucide-react'
import { useState } from 'react'

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

const failed = new Set<string>()

// row = 48px, for list rows (fixed box, so nothing shifts while an image loads).
const SIZES = { xs: 'size-8', sm: 'size-10', row: 'size-12', md: 'size-16', lg: 'size-40' } as const

/**
 * A product thumbnail. Click opens a larger preview (unless `preview` is false). A missing or broken
 * image shows a placeholder; the page never breaks because an image host is down.
 */
export function ProductThumb({ src, alt, size = 'sm', preview = true, className, source }: {
  src: string | null | undefined
  alt: string
  size?: keyof typeof SIZES
  preview?: boolean
  className?: string
  /** The saved link, shown in the preview (the original source of the image). */
  source?: string | null
}) {
  const [brokenSrc, setBrokenSrc] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const broken = Boolean(src && (brokenSrc === src || failed.has(src)))
  const shown = src && !broken ? src : null
  const box = cn('relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted/60', SIZES[size], className)
  const image = shown ? (
    <img src={shown} alt={alt} loading="lazy" decoding="async" referrerPolicy="no-referrer" className="size-full object-contain"
      data-testid="product-thumb-img"
      onError={() => { failed.add(shown); setBrokenSrc(shown) }} />
  ) : (
    <ImageOff aria-hidden className={cn('text-muted-foreground/70', size === 'lg' ? 'size-8' : size === 'row' || size === 'md' ? 'size-5' : 'size-4')} data-testid="product-thumb-placeholder" />
  )
  if (!shown || !preview) {
    return <span className={box} data-testid="product-thumb" data-state={shown ? 'image' : src ? 'broken' : 'none'} title={src && broken ? 'The image could not be loaded' : undefined}>{image}</span>
  }
  return (
    <>
      <button type="button" className={cn(box, 'cursor-zoom-in focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring')}
        data-testid="product-thumb" data-state="image" aria-label={`Show a larger image of ${alt}`} onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(true) }}>
        {image}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-2xl" data-testid="product-image-preview">
          <DialogHeader><DialogTitle>{alt}</DialogTitle><DialogDescription>Product image</DialogDescription></DialogHeader>
          <div className="flex h-[60vh] max-h-[480px] items-center justify-center rounded-lg border bg-muted/60">
            <img src={shown} alt={alt} referrerPolicy="no-referrer" className="size-full object-contain" />
          </div>
          {(source ?? (shown.startsWith('http') && !shown.includes('/storage/v1/') ? shown : null)) && (
            <a href={source ?? shown} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 break-all text-xs text-primary underline-offset-2 hover:underline">
              <ExternalLink aria-hidden className="size-3 shrink-0" /> {source ?? shown}
            </a>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
