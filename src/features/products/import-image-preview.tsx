// Excel import preview of image links: what the file does to each product's image, with both images to inspect.

import { AlertTriangle, CheckCircle2, ImageIcon, ImageOff, RefreshCw } from 'lucide-react'
import { useMemo, useState } from 'react'

import { KpiCard } from '@/components/common/kpi-card'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { IMAGE_STATUS_LABELS, summarizeImages, type ImageImportStatus, type ImportRowResult } from '@/features/products/product-import'
import { ProductThumb } from '@/features/products/product-image'
import { useProductImagesById } from '@/features/products/product-image-hooks'
import { formatNumber } from '@/lib/format'
import { cn } from '@/lib/utils'

const STATUS_STYLE: Record<ImageImportStatus, string> = {
  new: 'bg-emerald-100 text-emerald-900',
  changed: 'bg-blue-100 text-blue-900',
  unchanged: 'bg-slate-100 text-slate-700',
  invalid: 'bg-red-100 text-red-800',
  blank: 'bg-slate-100 text-slate-600',
  'not-selected': 'bg-slate-100 text-slate-600',
}

const STEP = 100

export function ImportImagePreview({ results, identifier, keyLabel }: {
  results: ImportRowResult[]
  /** The value used to find the product (SKU, EAN …) for a row. */
  identifier: (r: ImportRowResult) => string
  keyLabel: string
}) {
  const s = summarizeImages(results)
  const rows = useMemo(() => results.filter((r) => r.image), [results])
  const [shown, setShown] = useState(STEP)
  // Uploaded images of existing products (shown instead of their link).
  const uploaded = useProductImagesById(rows.filter((r) => r.image?.uploaded).map((r) => r.productId))
  if (!s.mapped) return null
  return (
    <Card data-testid="import-images">
      <CardHeader>
        <div>
          <CardTitle className="flex items-center gap-2"><ImageIcon aria-hidden className="size-4" /> Image links</CardTitle>
          <CardDescription>
            Click an image to inspect it before importing. A blank cell never removes an image; an invalid link is not saved (the rest of the row still is).
            The image link is never used to find products.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-5" data-testid="image-summary">
          <KpiCard label="Images to add" value={formatNumber(s.add)} icon={CheckCircle2} accent="available" />
          <KpiCard label="Images to update" value={formatNumber(s.update)} icon={RefreshCw} accent="manufacturing" />
          <KpiCard label="Images unchanged" value={formatNumber(s.unchanged)} icon={ImageIcon} />
          <KpiCard label="Invalid image links" value={formatNumber(s.invalid)} icon={AlertTriangle} accent="shortage" />
          <KpiCard label="Blank image links skipped" value={formatNumber(s.blank)} icon={ImageOff} hint={s.notSelected ? `${formatNumber(s.notSelected)} not selected to modify` : undefined} />
        </div>
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-14">Row</TableHead>
                <TableHead>{keyLabel}</TableHead>
                <TableHead>Product Name</TableHead>
                <TableHead>Existing image</TableHead>
                <TableHead>New image</TableHead>
                <TableHead>Image status</TableHead>
                <TableHead>Image Link selected</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.slice(0, shown).map((r) => {
                const img = r.image!
                const existingSrc = (img.uploaded && r.productId ? uploaded.get(r.productId) : null) ?? img.current
                return (
                  <TableRow key={r.rowNumber} data-testid="image-row" data-row={r.rowNumber} data-status={img.status}>
                    <TableCell className="tabular-nums text-muted-foreground">{r.rowNumber}</TableCell>
                    <TableCell className="font-medium">{identifier(r) || <span className="text-muted-foreground">—</span>}</TableCell>
                    <TableCell className="max-w-56 whitespace-normal">{r.productName || '—'}</TableCell>
                    <TableCell>
                      {r.productId ? (
                        <span className="flex items-center gap-2">
                          <ProductThumb src={existingSrc} alt={`${r.productName} (existing)`} source={img.current} />
                          {img.uploaded && <span className="text-[11px] text-muted-foreground">Uploaded image</span>}
                        </span>
                      ) : <span className="text-xs text-muted-foreground">New product</span>}
                    </TableCell>
                    <TableCell>
                      {img.incoming && img.status !== 'invalid' ? (
                        <span className="flex items-center gap-2" data-testid="image-new">
                          <ProductThumb src={img.incoming} alt={`${r.productName} (new)`} source={img.incoming} />
                          <a href={img.incoming} target="_blank" rel="noopener noreferrer" className="max-w-48 truncate text-[11px] text-primary hover:underline" title={img.incoming}>
                            {img.incoming}
                          </a>
                        </span>
                      ) : img.incoming ? (
                        <span className="block max-w-56 break-all text-[11px] text-red-700" title={img.problem}>{img.incoming}</span>
                      ) : <span className="text-xs text-muted-foreground">Blank</span>}
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      <span className={cn('inline-block rounded px-1.5 py-0.5 text-xs font-medium', STATUS_STYLE[img.status])} data-testid="image-status">
                        {IMAGE_STATUS_LABELS[img.status]}
                      </span>
                      {img.problem && <p className="mt-1 max-w-56 text-[11px] text-red-700">{img.problem}</p>}
                    </TableCell>
                    <TableCell>{img.selected ? 'Yes' : 'No — image kept'}</TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
        {rows.length > shown && (
          <Button variant="outline" size="sm" onClick={() => setShown((n) => n + STEP)}>
            Show {formatNumber(Math.min(STEP, rows.length - shown))} more of {formatNumber(rows.length - shown)}
          </Button>
        )}
      </CardContent>
    </Card>
  )
}
