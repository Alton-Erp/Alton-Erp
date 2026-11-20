import { Download, FileText, Loader2, MapPin, Music, Play } from 'lucide-react'
import { useEffect, useState } from 'react'

import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { openAttachment, signedAttachmentUrl } from '@/features/support/wa-web/media-urls'
import { mediaKind } from '@/features/support/wa-web/wa-web-model'
import { describeDataError } from '@/lib/errors'
import { formatFileSize } from '@/lib/format'
import { downloadWaMedia, type WaMessage } from '@/services/whatsapp'

function useSignedUrl(path: string | null | undefined, enabled: boolean) {
  const [state, setState] = useState<{ path: string; url: string | null; error: string | null } | null>(null)
  useEffect(() => {
    if (!path || !enabled) return
    let live = true
    signedAttachmentUrl(path).then((url) => { if (live) setState({ path, url, error: null }) }, (e) => { if (live) setState({ path, url: null, error: describeDataError(e) }) })
    return () => { live = false }
  }, [path, enabled])
  return state?.path === path ? state : null
}

/** Image / video / audio / document preview with open and download controls; download prompt for media still at Meta. */
export function MessageMedia({ m, onChanged }: { m: WaMessage; onChanged: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [zoom, setZoom] = useState(false)
  const a = m.attachment
  const kind = mediaKind(m)
  const viewable = Boolean(a && !a.restricted && a.storage_path)
  const inline = viewable && (kind === 'image' || kind === 'sticker' || kind === 'video' || kind === 'audio')
  const src = useSignedUrl(a?.storage_path, inline)

  if (m.type === 'location' && m.location) {
    const name = [m.location.name, m.location.address].filter(Boolean).join(', ') || 'Location'
    return (
      <a className="mb-1 flex items-center gap-2 rounded-md bg-black/5 px-3 py-2 text-sm hover:bg-black/10" target="_blank" rel="noopener noreferrer"
        href={`https://www.google.com/maps?q=${Number(m.location.latitude)},${Number(m.location.longitude)}`}>
        <MapPin className="size-5 shrink-0 text-[#EA0038]" /><span className="min-w-0"><span className="block truncate">{name}</span><span className="text-xs text-[#027EB5]">Open map</span></span>
      </a>
    )
  }
  if (a) {
    if (!viewable) return <p className="mb-1 rounded-md bg-black/5 px-3 py-2 text-xs text-[#667781]">{a.file_name} (restricted: needs support.manage_tickets)</p>
    const download = () => { setError(null); openAttachment(a.storage_path!).catch((e) => setError(describeDataError(e))) }
    if ((kind === 'image' || kind === 'sticker') && src?.url) {
      return (
        <>
          <button type="button" className="-mx-1 -mt-1 mb-1 block overflow-hidden rounded-md" onClick={() => setZoom(true)} aria-label={`View image ${a.file_name}`}>
            <img src={src.url} alt={a.file_name} loading="lazy" className={kind === 'sticker' ? 'size-32 object-contain' : 'max-h-80 w-full max-w-[330px] object-cover'} />
          </button>
          <Dialog open={zoom} onOpenChange={setZoom}>
            <DialogContent className="max-w-4xl bg-black/95 p-2">
              <DialogTitle className="sr-only">{a.file_name}</DialogTitle>
              <DialogDescription className="sr-only">Image sent in the WhatsApp conversation</DialogDescription>
              <img src={src.url} alt={a.file_name} className="max-h-[80vh] w-full object-contain" />
              <button type="button" onClick={download} className="mx-auto mt-2 flex items-center gap-1 text-sm text-white hover:underline"><Download className="size-4" />Open / download</button>
            </DialogContent>
          </Dialog>
        </>
      )
    }
    if (kind === 'video' && src?.url) return <video controls preload="metadata" src={src.url} className="-mx-1 -mt-1 mb-1 max-h-80 w-full max-w-[330px] rounded-md bg-black" aria-label={a.file_name} />
    if (kind === 'audio' && src?.url) {
      return <div className="mb-1 flex items-center gap-2"><Music className="size-5 shrink-0 text-[#54656F]" aria-hidden /><audio controls preload="metadata" src={src.url} className="h-10 max-w-[260px]" aria-label={a.file_name} /></div>
    }
    if (inline && !src) return <div className="mb-1 flex h-40 w-[260px] items-center justify-center rounded-md bg-black/5"><Loader2 className="size-5 animate-spin text-[#667781]" aria-label="Loading media" /></div>
    return (
      <div className="mb-1 flex min-w-[220px] items-center gap-3 rounded-md bg-black/5 px-3 py-2" data-testid="wa-attachment">
        {kind === 'video' ? <Play className="size-8 shrink-0 text-[#54656F]" /> : <FileText className="size-8 shrink-0 text-[#54656F]" />}
        <span className="min-w-0 flex-1"><span className="block truncate text-sm">{a.file_name}</span>
          <span className="text-xs text-[#667781]">{[a.size_bytes ? formatFileSize(a.size_bytes) : null, a.content_type?.split('/')[1]?.toUpperCase()].filter(Boolean).join(' · ')}</span>
          {(error || src?.error) && <span className="block text-xs text-red-700">{error ?? src?.error}</span>}</span>
        <button type="button" onClick={download} aria-label={`Download ${a.file_name}`} title="Open / download" className="rounded-full p-1.5 text-[#54656F] hover:bg-black/10"><Download className="size-5" /></button>
      </div>
    )
  }
  if (m.media_state === 'PENDING' || m.media_state === 'FAILED') {
    return (
      <div className="mb-1 flex flex-wrap items-center gap-2 rounded-md bg-black/5 px-3 py-2 text-xs text-[#667781]">
        <span>{m.media_state === 'PENDING' ? 'Media not downloaded yet.' : `Download failed: ${m.media_error ?? 'error'}.`}{m.media_filename ? ` ${m.media_filename}` : ''}</span>
        <button type="button" disabled={busy} className="inline-flex items-center gap-1 rounded-full bg-white px-2.5 py-1 font-medium text-[#008069] shadow-sm hover:bg-[#F0F2F5] disabled:opacity-50"
          onClick={() => { setBusy(true); setError(null); downloadWaMedia(m.id).then(onChanged, (e) => setError(e instanceof Error ? e.message : describeDataError(e))).finally(() => setBusy(false)) }}>
          {busy ? <Loader2 className="size-3 animate-spin" /> : <Download className="size-3" />} Download</button>
        {error && <span className="text-red-700">{error}</span>}
      </div>
    )
  }
  if (m.media_state === 'EXPIRED') return <p className="mb-1 text-xs italic text-[#667781]">Media no longer available at Meta (media ids expire after 7 days).</p>
  if (m.media_state === 'TOO_LARGE') return <p className="mb-1 text-xs italic text-[#667781]">Media larger than 25 MB was not stored.</p>
  if (m.media_state === 'BLOCKED') return <p className="mb-1 text-xs italic text-[#667781]">Executable file not stored.</p>
  return null
}
