import { Loader2, QrCode } from 'lucide-react'
import { useEffect } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'

import { EmptyState } from '@/components/common/empty-state'
import { PageHeader } from '@/components/common/page-header'
import { Card, CardContent } from '@/components/ui/card'
import { parseScanPayload } from '@/features/admin/barcode'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { lookupCode } from '@/services/admin'

/**
 * Target of printed QR labels (/scan?c=P-<uuid>). The QR holds only a record id;
 * the user must be signed in, and the lookup applies their permissions.
 */
export default function ScanPage() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const raw = params.get('c') ?? ''
  const parsed = parseScanPayload(raw)
  const lookup = useAsync(() => (parsed ? lookupCode(`${parsed.kind}-${parsed.id}`) : Promise.resolve(null)), [raw])
  const match = lookup.data?.matches.length === 1 ? lookup.data.matches[0] : null

  useEffect(() => {
    if (match) navigate(match.link, { replace: true })
  }, [match, navigate])

  return (
    <>
      <PageHeader title="Scanned label" />
      <Card><CardContent className="p-6">
        {!parsed ? <EmptyState icon={QrCode} title="Unrecognised label" description="This link does not contain a valid label code." />
          : lookup.loading || match ? <p className="text-sm text-muted-foreground"><Loader2 className="inline size-4 animate-spin" /> Opening the record…</p>
            : lookup.error ? <EmptyState icon={QrCode} title="Could not look up the label" description={describeDataError(lookup.error)} />
              : <EmptyState icon={QrCode} title="Record not available" description="The record no longer exists, belongs to another company, or you do not have permission to view it." />}
        <p className="mt-4 text-center text-sm"><Link className="text-primary hover:underline" to="/admin/barcodes">Open Barcode & QR tools</Link></p>
      </CardContent></Card>
    </>
  )
}
