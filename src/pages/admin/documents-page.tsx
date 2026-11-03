import { Archive, Download, Eye, FileText, Loader2, Upload } from 'lucide-react'
import { useState } from 'react'

import { usePermissions } from '@/auth/use-permissions'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { PaginationBar } from '@/components/common/pagination-bar'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { extensionOf, fileSignatureMatches, MIME_BY_EXTENSION } from '@/features/admin/barcode'
import { useAsync } from '@/hooks/use-async'
import { useDebouncedValue } from '@/hooks/use-debounced-value'
import { describeDataError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import {
  archiveDocument, documentSignedUrl, fetchDocuments, fetchDocumentVersions, fetchUploadRules, searchDocumentEntities, uploadDocument,
  type DocEntityType, type DocumentRow,
} from '@/services/admin'

const ENTITY_LABELS: Record<DocEntityType, string> = {
  PRODUCT: 'Product', BATCH: 'Batch / lot', WAREHOUSE: 'Warehouse', PRODUCTION_ORDER: 'Production order', OUTSOURCING_ORDER: 'Outsourcing order',
  CUSTOMER_PO: 'Customer purchase order', SALES_ORDER: 'Sales order', DISPATCH: 'Dispatch / consignment', INVOICE: 'Invoice', ADJUSTMENT_NOTE: 'Credit / debit note',
  CUSTOMER: 'Customer', COMPANY: 'Company', SUPPLIER_PO: 'Supplier purchase order', GOODS_RECEIPT: 'Goods receipt (GRN)',
}
const DOC_TYPES: Record<string, string> = {
  INVOICE_COPY: 'Invoice copy', PURCHASE_ORDER: 'Purchase order', DELIVERY_PROOF: 'Proof of delivery', QUALITY_REPORT: 'Quality report', CERTIFICATE: 'Certificate',
  CONTRACT: 'Contract', KYC: 'KYC document', SUPPLIER_DOCUMENT: 'Supplier document', DRAWING: 'Drawing', PHOTO: 'Photo', OTHER: 'Other',
}
const size = (n: number | null) => (n === null ? '—' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`)

async function checkFile(file: File, rules: { max_bytes: number; extensions: string[] }): Promise<{ mime: string } | string> {
  const ext = extensionOf(file.name)
  if (!ext || !rules.extensions.includes(ext)) return `Files of type .${ext || '?'} are not allowed. Allowed: ${rules.extensions.join(', ')}.`
  if (file.size === 0) return 'The file is empty.'
  if (file.size > rules.max_bytes) return `The file is ${size(file.size)}; the limit is ${size(rules.max_bytes)}.`
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer())
  if (!fileSignatureMatches(ext, head)) return `The file content does not look like a .${ext} file. It may be renamed or damaged.`
  return { mime: MIME_BY_EXTENSION[ext] }
}

function UploadDialog({ revisionOf, onClose, onDone }: { revisionOf: DocumentRow | null; onClose: () => void; onDone: (m: string) => void }) {
  const rules = useAsync(fetchUploadRules, [])
  const [entityType, setEntityType] = useState<DocEntityType>('PRODUCT')
  const [term, setTerm] = useState('')
  const search = useDebouncedValue(term, 300)
  const entities = useAsync(() => (revisionOf ? Promise.resolve([]) : searchDocumentEntities(entityType, search)), [entityType, search, revisionOf])
  const [entity, setEntity] = useState<{ id: string; reference: string } | null>(null)
  const [docType, setDocType] = useState('OTHER')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [note, setNote] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    setError(null)
    if (!rules.data) return setError('Upload rules could not be loaded.')
    if (!revisionOf && !entity) return setError('Choose the record this document belongs to.')
    if (!revisionOf && !title.trim()) return setError('Enter a title.')
    if (revisionOf && note.trim().length < 3) return setError('Describe what changed in this revision.')
    if (!file) return setError('Choose a file.')
    const checked = await checkFile(file, rules.data)
    if (typeof checked === 'string') return setError(checked)
    setBusy(true)
    try {
      const r = await uploadDocument({
        entityType: revisionOf?.related_entity_type ?? entityType, entityId: revisionOf?.related_entity_id ?? entity!.id, documentType: revisionOf?.document_type ?? docType,
        title: revisionOf?.title ?? title.trim(), description: description.trim() || null, file, mime: checked.mime, documentId: revisionOf?.id ?? null, changeNote: revisionOf ? note.trim() : null,
      })
      onDone(revisionOf ? `Version ${r.version} of “${revisionOf.title}” uploaded. Earlier versions are kept.` : 'Document uploaded.')
    } catch (e) { setError(describeDataError(e)) } finally { setBusy(false) }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader><DialogTitle>{revisionOf ? `New version of “${revisionOf.title}”` : 'Upload document'}</DialogTitle>
          <DialogDescription>Stored privately; only people allowed to see the related record can open it, through a link valid for 60 seconds.
            {rules.data ? ` Up to ${size(rules.data.max_bytes)}; ${rules.data.extensions.join(', ')}.` : ''}</DialogDescription></DialogHeader>
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
        <div className="space-y-3">
          {!revisionOf && <>
            <div className="space-y-1"><Label htmlFor="du-etype">Related to</Label>
              <Select value={entityType} onValueChange={(v) => { setEntityType(v as DocEntityType); setEntity(null) }}><SelectTrigger id="du-etype"><SelectValue /></SelectTrigger>
                <SelectContent>{(Object.keys(ENTITY_LABELS) as DocEntityType[]).map((t) => <SelectItem key={t} value={t}>{ENTITY_LABELS[t]}</SelectItem>)}</SelectContent></Select></div>
            {entityType !== 'COMPANY' && <div className="space-y-1"><Label htmlFor="du-esearch">Find the record</Label><Input id="du-esearch" value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Number, SKU or name" /></div>}
            <div className="max-h-40 overflow-y-auto rounded-lg border">
              {entities.loading ? <p className="p-2 text-sm text-muted-foreground">Searching…</p> : !entities.data?.length ? <p className="p-2 text-sm text-muted-foreground">No records found (or you cannot attach documents to them).</p>
                : entities.data.map((e) => <label key={e.id} className="flex items-center gap-2 border-b px-3 py-1.5 text-sm last:border-0"><input type="radio" name="du-entity" checked={entity?.id === e.id} onChange={() => setEntity(e)} /> {e.reference}</label>)}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1"><Label htmlFor="du-type">Document type</Label>
                <Select value={docType} onValueChange={setDocType}><SelectTrigger id="du-type"><SelectValue /></SelectTrigger>
                  <SelectContent>{Object.entries(DOC_TYPES).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}</SelectContent></Select></div>
              <div className="space-y-1"><Label htmlFor="du-title">Title</Label><Input id="du-title" maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} /></div>
            </div>
            <div className="space-y-1"><Label htmlFor="du-desc">Description (optional)</Label><Textarea id="du-desc" rows={2} maxLength={1000} value={description} onChange={(e) => setDescription(e.target.value)} /></div>
          </>}
          {revisionOf && <div className="space-y-1"><Label htmlFor="du-note">What changed</Label><Textarea id="du-note" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} /></div>}
          <div className="space-y-1"><Label htmlFor="du-file">File</Label><Input id="du-file" type="file" accept={rules.data?.extensions.map((e) => `.${e}`).join(',')} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            {file && <p className="text-xs text-muted-foreground">{file.name} · {size(file.size)}</p>}</div>
        </div>
        <DialogFooter><Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button><Button disabled={busy || rules.loading} onClick={() => void submit()}>{busy ? <Loader2 className="animate-spin" /> : <Upload />} Upload</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function DetailDialog({ doc, onClose, onRevise, onArchive, canUpload, canManage }: {
  doc: DocumentRow; onClose: () => void; onRevise: () => void; onArchive: () => void; canUpload: boolean; canManage: boolean
}) {
  const versions = useAsync(() => fetchDocumentVersions(doc.id), [doc.id])
  const [preview, setPreview] = useState<{ url: string; mime: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const open = async (versionId: string, download: boolean) => {
    setBusy(versionId); setError(null)
    try {
      const r = await documentSignedUrl(versionId, download)
      if (download) window.location.assign(r.url)
      // PDFs open in the browser's own viewer in a new tab (the link expires after 60 seconds)
      else if (r.mime === 'application/pdf') window.open(r.url, '_blank', 'noopener,noreferrer')
      else setPreview({ url: r.url, mime: r.mime })
    } catch (e) { setError(describeDataError(e)) } finally { setBusy(null) }
  }
  const previewable = (mime: string) => mime === 'application/pdf' || mime.startsWith('image/')
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader><DialogTitle>{doc.title}</DialogTitle>
          <DialogDescription>{DOC_TYPES[doc.document_type]} · {ENTITY_LABELS[doc.related_entity_type]} {doc.related_reference}{doc.description ? ` · ${doc.description}` : ''}</DialogDescription></DialogHeader>
        {doc.status === 'ARCHIVED' && <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">Archived {doc.archived_at ? formatDateTime(doc.archived_at) : ''}: {doc.archive_reason}</p>}
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
        {versions.loading ? <LoadingState variant="table" rows={2} /> : versions.error ? <ErrorState message={describeDataError(versions.error)} onRetry={versions.reload} /> : (
          <ul className="divide-y rounded-lg border text-sm">{(versions.data ?? []).map((v) => (
            <li key={v.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
              <span className="font-medium">v{v.version}</span><span>{v.original_filename}</span><span className="text-muted-foreground">{size(v.file_size)} · {v.uploaded_at ? formatDateTime(v.uploaded_at) : ''}</span>
              {v.change_note && <span className="w-full text-xs text-muted-foreground">{v.change_note}</span>}
              <span className="ml-auto flex gap-1">
                {previewable(v.mime_type) && <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void open(v.id, false)}><Eye /> Preview</Button>}
                <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void open(v.id, true)}>{busy === v.id ? <Loader2 className="animate-spin" /> : <Download />} Download</Button>
              </span>
            </li>))}</ul>
        )}
        {preview && <img src={preview.url} alt={doc.title} className="max-h-[60vh] w-full rounded-lg border object-contain" />}
        <DialogFooter>
          {doc.status === 'ACTIVE' && canManage && <Button variant="outline" className="text-shortage" onClick={onArchive}><Archive /> Archive</Button>}
          {doc.status === 'ACTIVE' && canUpload && <Button variant="outline" onClick={onRevise}><Upload /> Upload new version</Button>}
          <Button onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default function DocumentsPage() {
  const { has } = usePermissions()
  const [term, setTerm] = useState('')
  const search = useDebouncedValue(term, 300)
  const [entityType, setEntityType] = useState('all')
  const [docType, setDocType] = useState('all')
  const [archived, setArchived] = useState(false)
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(20)
  const [refresh, setRefresh] = useState(0)
  const list = useAsync(() => fetchDocuments({ search, entityType: entityType === 'all' ? null : (entityType as DocEntityType), entityId: null, documentType: docType === 'all' ? null : docType, includeArchived: archived }, page, pageSize),
    [search, entityType, docType, archived, page, pageSize, refresh])
  const [uploading, setUploading] = useState<DocumentRow | 'new' | null>(null)
  const [detail, setDetail] = useState<DocumentRow | null>(null)
  const [archiving, setArchiving] = useState<DocumentRow | null>(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const done = (m: string) => { setMessage(m); setError(null); setRefresh((n) => n + 1) }

  return (
    <>
      <PageHeader actions={has('documents.upload') && <Button onClick={() => setUploading('new')}><Upload /> Upload document</Button>} />
      {message && <p role="status" className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-800">{message}</p>}
      {error && <p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800">{error}</p>}
      <Card><CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-56 flex-1 space-y-1"><Label htmlFor="dc-search">Search</Label><Input id="dc-search" placeholder="Title, file name or record" value={term} onChange={(e) => { setTerm(e.target.value); setPage(0) }} /></div>
          <div className="space-y-1"><Label htmlFor="dc-entity">Related to</Label>
            <Select value={entityType} onValueChange={(v) => { setEntityType(v); setPage(0) }}><SelectTrigger id="dc-entity" className="w-52"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="all">Any record</SelectItem>{Object.entries(ENTITY_LABELS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}</SelectContent></Select></div>
          <div className="space-y-1"><Label htmlFor="dc-type">Type</Label>
            <Select value={docType} onValueChange={(v) => { setDocType(v); setPage(0) }}><SelectTrigger id="dc-type" className="w-44"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="all">All types</SelectItem>{Object.entries(DOC_TYPES).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}</SelectContent></Select></div>
          <label className="flex items-center gap-2 pb-2 text-sm"><Checkbox checked={archived} onCheckedChange={(v) => { setArchived(v === true); setPage(0) }} /> Include archived</label>
        </div>
        {list.loading && !list.data ? <LoadingState variant="table" rows={6} /> : list.error ? <ErrorState message={describeDataError(list.error)} onRetry={list.reload} />
          : !list.data?.rows.length ? <EmptyState icon={FileText} title="No documents" description="Documents you upload against products, orders, invoices and other records appear here." /> : (
            <>
              <div className="overflow-x-auto rounded-lg border">
                <table className="w-full text-sm">
                  <thead className="bg-surface-muted/50 text-left text-xs text-muted-foreground"><tr><th className="px-3 py-2">Title</th><th className="px-3 py-2">Type</th><th className="px-3 py-2">Related record</th><th className="px-3 py-2">File</th><th className="px-3 py-2">Updated</th><th /></tr></thead>
                  <tbody className="divide-y">{list.data.rows.map((d) => (
                    <tr key={d.id}>
                      <td className="px-3 py-2 font-medium">{d.title}{d.status === 'ARCHIVED' && <> <StatusBadge label="Archived" tone="neutral" /></>}</td>
                      <td className="px-3 py-2">{DOC_TYPES[d.document_type] ?? d.document_type}</td>
                      <td className="px-3 py-2">{ENTITY_LABELS[d.related_entity_type]} {d.related_reference}</td>
                      <td className="px-3 py-2 text-xs">{d.original_filename ?? 'upload incomplete'} · {size(d.file_size)}{d.version_count > 1 ? ` · ${d.version_count} versions` : ''}</td>
                      <td className="px-3 py-2 text-xs">{formatDateTime(d.updated_at)}</td>
                      <td className="px-3 py-2"><Button size="sm" variant="outline" onClick={() => setDetail(d)}>Open</Button></td>
                    </tr>))}</tbody>
                </table>
              </div>
              <PaginationBar page={page} pageSize={pageSize} total={list.data.total} onPageChange={setPage} onPageSizeChange={(n) => { setPageSize(n); setPage(0) }} disabled={list.loading} />
            </>
          )}
      </CardContent></Card>

      {uploading && <UploadDialog revisionOf={uploading === 'new' ? null : uploading} onClose={() => setUploading(null)} onDone={(m) => { setUploading(null); done(m) }} />}
      {detail && <DetailDialog doc={detail} canUpload={has('documents.upload')} canManage={has('documents.manage')} onClose={() => setDetail(null)}
        onRevise={() => { setUploading(detail); setDetail(null) }} onArchive={() => { setReason(''); setArchiving(detail); setDetail(null) }} />}
      {archiving && (
        <Dialog open onOpenChange={(o) => !o && !busy && setArchiving(null)}>
          <DialogContent>
            <DialogHeader><DialogTitle>Archive “{archiving.title}”?</DialogTitle><DialogDescription>The document and all its versions are kept for the record but hidden from normal lists. Files are never deleted.</DialogDescription></DialogHeader>
            {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
            <div className="space-y-1"><Label htmlFor="dc-reason">Reason</Label><Textarea id="dc-reason" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} /></div>
            <DialogFooter><Button variant="outline" disabled={busy} onClick={() => setArchiving(null)}>Cancel</Button>
              <Button variant="destructive" disabled={busy || reason.trim().length < 3} onClick={() => { setBusy(true); archiveDocument(archiving.id, reason.trim()).then(() => { setArchiving(null); done('Document archived.') }, (e) => setError(describeDataError(e))).finally(() => setBusy(false)) }}>Archive</Button></DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  )
}
