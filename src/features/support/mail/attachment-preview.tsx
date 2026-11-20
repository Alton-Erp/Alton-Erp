import {
  ChevronLeft, ChevronRight, Download, ExternalLink, Eye, File, FileArchive, FileImage, FileMusic, FileSpreadsheet, FileText, FileVideoCamera, Lock, Play, Presentation, X,
} from 'lucide-react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { useEffect, useState, type ReactNode } from 'react'

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { fileKind, KIND_LABEL, parseCsv, previewMode, shortName, type FileKind } from '@/features/support/mail/attachment-model'
import { batchedAttachmentUrl, signedAttachmentUrl } from '@/features/support/wa-web/media-urls'
import { describeDataError } from '@/lib/errors'
import { formatFileSize } from '@/lib/format'
import { cn } from '@/lib/utils'
import { attachmentDownloadUrl, type MailAttachment } from '@/services/email'

// Every file is reached through a 5-minute signed link of the private support bucket, created with the user's own
// session: the bucket's policies decide, and files marked sensitive arrive without a path (shown as restricted).

const KIND_ICON: Record<FileKind, { icon: typeof File; color: string }> = {
  image: { icon: FileImage, color: 'text-[#D93025]' }, pdf: { icon: FileText, color: 'text-[#D93025]' }, video: { icon: FileVideoCamera, color: 'text-[#D93025]' },
  audio: { icon: FileMusic, color: 'text-[#9334E6]' }, doc: { icon: FileText, color: 'text-[#1A73E8]' }, sheet: { icon: FileSpreadsheet, color: 'text-[#188038]' },
  csv: { icon: FileSpreadsheet, color: 'text-[#188038]' }, slides: { icon: Presentation, color: 'text-[#E37400]' }, zip: { icon: FileArchive, color: 'text-[#5F6368]' },
  text: { icon: FileText, color: 'text-[#5F6368]' }, other: { icon: File, color: 'text-[#5F6368]' },
}
export function FileKindIcon({ a, className }: { a: Pick<MailAttachment, 'file_name' | 'content_type'>; className?: string }) {
  const { icon: Icon, color } = KIND_ICON[fileKind(a.file_name, a.content_type)]
  return <Icon className={cn(color, className)} aria-hidden />
}
const typeLabel = (a: MailAttachment) => `${KIND_LABEL[fileKind(a.file_name, a.content_type)]}${a.size_bytes ? ` · ${formatFileSize(a.size_bytes)}` : ''}`

/** A signed link for an image or video thumbnail (null while loading or when the file cannot be read). */
function useThumb(a: MailAttachment, batched: boolean): string | null {
  const mode = previewMode(a.file_name, a.content_type, a.size_bytes)
  const path = !a.restricted && a.storage_path && (mode === 'image' || mode === 'video') ? a.storage_path : null
  const [url, setUrl] = useState<{ path: string; url: string } | null>(null)
  useEffect(() => {
    if (!path) return
    let live = true
    ;(batched ? batchedAttachmentUrl(path) : signedAttachmentUrl(path)).then((u) => { if (live) setUrl({ path, url: u }) }, () => {})
    return () => { live = false }
  }, [path, batched])
  return url && url.path === path ? url.url : null
}

async function downloadAttachment(a: MailAttachment) {
  const url = await attachmentDownloadUrl(a.storage_path!, a.file_name)
  const link = document.createElement('a')
  link.href = url
  link.rel = 'noopener'
  link.download = a.file_name
  document.body.appendChild(link)
  link.click()
  link.remove()
}

/** Chip under a list row: icon or small thumbnail, the shortened name (full name and type in the tooltip). */
export function AttachmentChip({ a, onOpen }: { a: MailAttachment; onOpen: () => void }) {
  const thumb = useThumb(a, true)
  const image = previewMode(a.file_name, a.content_type, a.size_bytes) === 'image'
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" onClick={(e) => { e.stopPropagation(); onOpen() }} data-testid="mail-attachment-chip" aria-label={`${a.file_name} (${typeLabel(a)})`}
          className="inline-flex h-8 max-w-[200px] shrink-0 items-center gap-1.5 rounded-full border border-[#DADCE0] bg-white px-2.5 text-xs text-[#3C4043] hover:bg-[#F1F3F4] focus-visible:outline-2 focus-visible:outline-[#0B57D0]">
          {a.restricted ? <Lock className="size-4 shrink-0 text-[#5F6368]" />
            : thumb && image ? <img src={thumb} alt="" className="size-4 shrink-0 rounded-sm object-cover" />
            : <FileKindIcon a={a} className="size-4 shrink-0" />}
          <span className="truncate font-medium">{shortName(a.file_name, 22)}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent>{a.file_name} · {typeLabel(a)}{a.restricted ? ' · restricted' : ''}</TooltipContent>
    </Tooltip>
  )
}

/** Card below an email: a thumbnail (image, first frame of a video) or the file type; Preview and Download on hover or focus. */
export function AttachmentTile({ a, onPreview }: { a: MailAttachment; onPreview: () => void }) {
  const thumb = useThumb(a, false)
  const mode = previewMode(a.file_name, a.content_type, a.size_bytes)
  const [error, setError] = useState<string | null>(null)
  if (a.restricted || !a.storage_path) {
    return <span className="inline-flex h-[120px] w-[180px] flex-col items-center justify-center gap-2 rounded-lg border border-[#E0E3E7] px-3 text-center text-xs text-[#5F6368]" data-testid="email-attachment-restricted">
      <Lock className="size-6" /><span className="line-clamp-2 break-all">{a.file_name}</span><span>Restricted</span></span>
  }
  const download = () => { setError(null); downloadAttachment(a).catch((e) => setError(describeDataError(e))) }
  return (
    <div className="group/att relative flex h-[120px] w-[180px] flex-col overflow-hidden rounded-lg border border-[#E0E3E7] bg-[#F8FAFD] hover:shadow-md" data-testid="email-attachment" title={a.file_name}>
      <button type="button" onClick={onPreview} className="flex min-h-0 flex-1 items-center justify-center overflow-hidden" aria-label={`Preview ${a.file_name}`}>
        {thumb && mode === 'image' ? <img src={thumb} alt={a.file_name} loading="lazy" className="size-full object-cover" />
          : thumb && mode === 'video' ? <span className="relative size-full"><video src={`${thumb}#t=0.5`} preload="metadata" muted playsInline className="size-full object-cover" aria-hidden />
            <span className="absolute inset-0 flex items-center justify-center"><span className="flex size-9 items-center justify-center rounded-full bg-black/60 text-white"><Play className="size-4 fill-white" /></span></span></span>
          : <FileKindIcon a={a} className="size-10" />}
      </button>
      <span className="flex items-center gap-1.5 border-t border-[#E0E3E7] bg-white px-2 py-1.5 text-xs">
        <FileKindIcon a={a} className="size-4 shrink-0" />
        <span className="min-w-0 flex-1"><span className="block truncate font-medium text-[#1F1F1F]">{a.file_name}</span>
          <span className="text-[#5F6368]">{typeLabel(a)}</span></span>
      </span>
      <span className="absolute inset-x-0 top-0 hidden justify-end gap-1 bg-gradient-to-b from-black/50 to-transparent p-1.5 group-focus-within/att:flex group-hover/att:flex">
        <button type="button" onClick={onPreview} aria-label={`Preview ${a.file_name}`} title="Preview" data-testid="email-attachment-preview"
          className="inline-flex size-8 items-center justify-center rounded-full bg-white/90 text-[#1F1F1F] hover:bg-white"><Eye className="size-4" /></button>
        <button type="button" onClick={download} aria-label={`Download ${a.file_name}`} title="Download" data-testid="email-attachment-download"
          className="inline-flex size-8 items-center justify-center rounded-full bg-white/90 text-[#1F1F1F] hover:bg-white"><Download className="size-4" /></button>
      </span>
      {error && <span role="alert" className="absolute inset-x-0 bottom-0 bg-red-50 px-2 py-1 text-[11px] text-red-700">{error}</span>}
    </div>
  )
}

function TextPreview({ url, csv }: { url: string; csv: boolean }) {
  const [text, setText] = useState<{ url: string; text: string | null; error: string | null } | null>(null)
  useEffect(() => {
    let live = true
    fetch(url).then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`)))).then(
      (t) => { if (live) setText({ url, text: t, error: null }) }, (e) => { if (live) setText({ url, text: null, error: describeDataError(e) }) })
    return () => { live = false }
  }, [url])
  if (!text || text.url !== url) return <p className="text-sm text-white/80">Loading…</p>
  if (text.error) return <p className="text-sm text-red-200" role="alert">{text.error}</p>
  if (csv) {
    const { rows, truncated } = parseCsv(text.text ?? '')
    return (
      <div className="max-h-full max-w-full overflow-auto rounded bg-white text-xs text-[#1F1F1F]" data-testid="attachment-preview-table">
        <table className="border-collapse"><tbody>{rows.map((r, i) => <tr key={i} className={i === 0 ? 'bg-[#F1F3F4] font-medium' : ''}>
          {r.map((c, j) => <td key={j} className="border border-[#E0E3E7] px-2 py-1 whitespace-nowrap">{c}</td>)}</tr>)}</tbody></table>
        {truncated && <p className="p-2 text-[#5F6368]">First 200 rows shown; download the file for the rest.</p>}
      </div>
    )
  }
  return <pre className="max-h-full max-w-full overflow-auto rounded bg-white p-4 text-xs whitespace-pre-wrap text-[#1F1F1F]">{text.text}</pre>
}

function PreviewBody({ a, onDownload }: { a: MailAttachment; onDownload: () => void }) {
  const mode = previewMode(a.file_name, a.content_type, a.size_bytes)
  const [state, setState] = useState<{ id: string; url: string | null; error: string | null; failed: boolean } | null>(null)
  const ok = !a.restricted && Boolean(a.storage_path)
  useEffect(() => {
    if (!ok || !mode) return
    let live = true
    signedAttachmentUrl(a.storage_path!).then((u) => { if (live) setState({ id: a.id, url: u, error: null, failed: false }) },
      (e) => { if (live) setState({ id: a.id, url: null, error: describeDataError(e), failed: false }) })
    return () => { live = false }
  }, [a.id, a.storage_path, ok, mode])
  const fallback = (title: string, note: ReactNode) => (
    <div className="flex flex-col items-center gap-3 rounded-xl bg-white px-10 py-8 text-center text-[#1F1F1F]" data-testid="attachment-preview-none">
      <FileKindIcon a={a} className="size-14" /><p className="text-base font-medium">{title}</p><p className="max-w-sm text-sm text-[#5F6368]">{note}</p>
      {ok && <button type="button" onClick={onDownload} className="inline-flex items-center gap-2 rounded-full bg-[#0B57D0] px-5 py-2 text-sm font-medium text-white hover:bg-[#0B57D0]/90"><Download className="size-4" />Download</button>}
    </div>
  )
  if (!ok) return fallback('Restricted file', 'You do not have permission to open this attachment.')
  if (!mode) return fallback('No preview available', `${KIND_LABEL[fileKind(a.file_name, a.content_type)]} files cannot be shown here. Download the file to open it.`)
  const s = state?.id === a.id ? state : null
  if (!s) return <p className="text-sm text-white/80">Loading…</p>
  if (s.error || !s.url) return fallback('Could not open the file', s.error ?? 'Try again.')
  if (s.failed) return fallback('This browser cannot play this file', 'Download it to open it in another application.')
  if (mode === 'image') return <img src={s.url} alt={a.file_name} className="max-h-full max-w-full object-contain" data-testid="attachment-preview-image" />
  if (mode === 'pdf') return <iframe src={s.url} title={a.file_name} className="size-full rounded bg-white" data-testid="attachment-preview-pdf" />
  if (mode === 'video') return <video src={s.url} controls autoPlay playsInline className="max-h-full max-w-full" onError={() => setState({ ...s, failed: true })} data-testid="attachment-preview-video" />
  if (mode === 'audio') return <audio src={s.url} controls autoPlay onError={() => setState({ ...s, failed: true })} />
  return <TextPreview url={s.url} csv={fileKind(a.file_name, a.content_type) === 'csv'} />
}

/** Full-screen viewer for the attachments of one email or one list row: previous / next (arrow keys), download, Escape closes. */
export function AttachmentPreview({ items, index, onIndex, onClose }: { items: MailAttachment[]; index: number | null; onIndex: (i: number) => void; onClose: () => void }) {
  const a = index !== null ? items[index] ?? null : null
  const [error, setError] = useState<string | null>(null)
  const go = (d: number) => { if (index !== null && items.length > 1) { setError(null); onIndex((index + d + items.length) % items.length) } }
  const download = () => { if (a) { setError(null); downloadAttachment(a).catch((e) => setError(describeDataError(e))) } }
  const openTab = () => { if (a?.storage_path) signedAttachmentUrl(a.storage_path).then((u) => window.open(u, '_blank', 'noopener'), (e) => setError(describeDataError(e))) }
  const ok = a && !a.restricted && a.storage_path
  const btn = 'inline-flex size-10 items-center justify-center rounded-full text-white hover:bg-white/15 focus-visible:outline-2 focus-visible:outline-white'
  return (
    <DialogPrimitive.Root open={a !== null} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/85" />
        <DialogPrimitive.Content className="fixed inset-0 z-50 flex flex-col outline-none" data-testid="attachment-preview" aria-describedby={undefined}
          onKeyDown={(e) => { if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1) } else if (e.key === 'ArrowRight') { e.preventDefault(); go(1) } }}>
          {a && <>
            <header className="flex h-14 shrink-0 items-center gap-3 px-3 text-white">
              <DialogPrimitive.Close className={btn} aria-label="Close preview" data-testid="attachment-preview-close"><X className="size-5" /></DialogPrimitive.Close>
              <FileKindIcon a={a} className="size-5 shrink-0 brightness-150" />
              <div className="min-w-0 flex-1">
                <DialogPrimitive.Title className="truncate text-sm font-medium" title={a.file_name}>{a.file_name}</DialogPrimitive.Title>
                <p className="text-xs text-white/70">{typeLabel(a)}{items.length > 1 ? ` · ${index! + 1} of ${items.length}` : ''}</p>
              </div>
              {ok && <>
                <button type="button" className={btn} onClick={openTab} aria-label="Open in a new tab" title="Open in a new tab"><ExternalLink className="size-5" /></button>
                <button type="button" className={btn} onClick={download} aria-label="Download" title="Download" data-testid="attachment-preview-download"><Download className="size-5" /></button>
              </>}
            </header>
            {error && <p role="alert" className="mx-auto mb-2 rounded bg-red-50 px-3 py-1 text-xs text-red-700">{error}</p>}
            <div className="relative flex min-h-0 flex-1 items-center justify-center px-14 pb-6" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
              <PreviewBody key={a.id} a={a} onDownload={download} />
              {items.length > 1 && <>
                <button type="button" className={cn(btn, 'absolute top-1/2 left-2 -translate-y-1/2 bg-black/40')} onClick={() => go(-1)} aria-label="Previous attachment" data-testid="attachment-preview-prev"><ChevronLeft className="size-6" /></button>
                <button type="button" className={cn(btn, 'absolute top-1/2 right-2 -translate-y-1/2 bg-black/40')} onClick={() => go(1)} aria-label="Next attachment" data-testid="attachment-preview-next"><ChevronRight className="size-6" /></button>
              </>}
            </div>
          </>}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
