import { Download, FileText, Loader2, Paperclip, Upload } from 'lucide-react'
import { useState } from 'react'

import { usePermissions } from '@/auth/use-permissions'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { extensionOf, fileSignatureMatches, MIME_BY_EXTENSION } from '@/features/admin/barcode'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import { documentSignedUrl, fetchDocuments, fetchUploadRules, uploadDocument, type DocEntityType } from '@/services/admin'

const DOC_TYPES: Record<string, string> = {
  PURCHASE_ORDER: 'Purchase order', INVOICE_COPY: 'Supplier invoice', DELIVERY_PROOF: 'Delivery challan / proof', QUALITY_REPORT: 'Quality / inspection report',
  CERTIFICATE: 'Certificate', SUPPLIER_DOCUMENT: 'Supplier document', PHOTO: 'Photo', OTHER: 'Other',
}
const size = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`)

/**
 * Attachments of one record (purchase order, goods receipt, …), stored with the
 * existing documents module: private storage, versions, 60-second links.
 */
export function RecordDocuments({ entityType, entityId, defaultType = 'OTHER', title = 'Attachments' }: {
  entityType: DocEntityType
  entityId: string
  defaultType?: string
  title?: string
}) {
  const { has } = usePermissions()
  const [refresh, setRefresh] = useState(0)
  const docs = useAsync(() => (has('documents.read') ? fetchDocuments({ search: '', entityType, entityId, documentType: null, includeArchived: false }, 0, 50) : Promise.resolve({ rows: [], total: 0 })), [entityType, entityId, refresh])
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!has('documents.read')) return null

  const open = async (versionId: string | null) => {
    if (!versionId) return
    setError(null)
    try {
      const r = await documentSignedUrl(versionId, false)
      window.open(r.url, '_blank', 'noopener,noreferrer')
    } catch (e) { setError(describeDataError(e)) }
  }

  return (
    <Card>
      <CardHeader>
        <div><CardTitle className="flex items-center gap-2"><Paperclip className="size-4" /> {title}</CardTitle>
          <CardDescription>Supplier invoices, challans, inspection reports and photos.</CardDescription></div>
        {has('documents.upload') && <Button size="sm" variant="outline" onClick={() => setUploading(true)}><Upload /> Attach file</Button>}
      </CardHeader>
      <CardContent>
        {error && <p role="alert" className="mb-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
        {docs.loading && !docs.data ? <p className="text-sm text-muted-foreground">Loading…</p>
          : !docs.data?.rows.length ? <p className="text-sm text-muted-foreground">No attachments yet.</p>
          : (
            <ul className="space-y-2 text-sm">
              {docs.data.rows.map((d) => (
                <li key={d.id} className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-2"><FileText className="size-4 shrink-0 text-muted-foreground" />
                    <span className="truncate"><span className="font-medium">{d.title}</span>
                      <span className="block text-xs text-muted-foreground">{DOC_TYPES[d.document_type] ?? d.document_type} · {d.original_filename}{d.file_size ? ` · ${size(d.file_size)}` : ''} · {formatDateTime(d.updated_at)}</span></span></span>
                  <Button size="sm" variant="ghost" onClick={() => void open(d.current_version_id)}><Download /> Open</Button>
                </li>
              ))}
            </ul>
          )}
      </CardContent>
      {uploading && <AttachDialog entityType={entityType} entityId={entityId} defaultType={defaultType} onClose={() => setUploading(false)} onDone={() => { setUploading(false); setRefresh((n) => n + 1) }} />}
    </Card>
  )
}

function AttachDialog({ entityType, entityId, defaultType, onClose, onDone }: { entityType: DocEntityType; entityId: string; defaultType: string; onClose: () => void; onDone: () => void }) {
  const rules = useAsync(fetchUploadRules, [])
  const [docType, setDocType] = useState(defaultType)
  const [title, setTitle] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    setError(null)
    if (!rules.data) return setError('Upload rules could not be loaded.')
    if (!file) return setError('Choose a file.')
    const ext = extensionOf(file.name)
    if (!ext || !rules.data.extensions.includes(ext)) return setError(`Files of type .${ext || '?'} are not allowed. Allowed: ${rules.data.extensions.join(', ')}.`)
    if (file.size === 0 || file.size > rules.data.max_bytes) return setError(`The file must be between 1 byte and ${size(rules.data.max_bytes)}.`)
    if (!fileSignatureMatches(ext, new Uint8Array(await file.slice(0, 16).arrayBuffer()))) return setError(`The file content does not look like a .${ext} file.`)
    setBusy(true)
    try {
      await uploadDocument({ entityType, entityId, documentType: docType, title: title.trim() || file.name, description: null, file, mime: MIME_BY_EXTENSION[ext] })
      onDone()
    } catch (e) { setError(describeDataError(e)); setBusy(false) }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>Attach a file</DialogTitle>
          <DialogDescription>Stored privately with this record.{rules.data ? ` Up to ${size(rules.data.max_bytes)}; ${rules.data.extensions.join(', ')}.` : ''}</DialogDescription></DialogHeader>
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
        <div className="space-y-3">
          <div className="space-y-1"><Label htmlFor="ad-type">Type</Label>
            <Select value={docType} onValueChange={setDocType}><SelectTrigger id="ad-type"><SelectValue /></SelectTrigger>
              <SelectContent>{Object.entries(DOC_TYPES).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}</SelectContent></Select></div>
          <div className="space-y-1"><Label htmlFor="ad-title">Title (optional)</Label><Input id="ad-title" maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Defaults to the file name" /></div>
          <div className="space-y-1"><Label htmlFor="ad-file">File</Label><Input id="ad-file" type="file" accept={rules.data?.extensions.map((e) => `.${e}`).join(',')} onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></div>
        </div>
        <DialogFooter><Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button disabled={busy || rules.loading} onClick={() => void submit()}>{busy ? <Loader2 className="animate-spin" /> : <Upload />} Attach</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
