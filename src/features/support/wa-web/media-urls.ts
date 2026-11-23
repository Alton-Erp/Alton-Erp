import { attachmentUrls } from '@/services/email'
import { attachmentUrl } from '@/services/support'

// Signed URLs live 5 minutes (attachmentUrl); reuse them for 4 so polling does not ask for new ones every few seconds.
const urls = new Map<string, { url: string; until: number }>()
export async function signedAttachmentUrl(path: string): Promise<string> {
  const hit = urls.get(path)
  if (hit && hit.until > Date.now()) return hit.url
  const url = await attachmentUrl(path)
  urls.set(path, { url, until: Date.now() + 240_000 })
  return url
}
/** Drops a cached link (it stopped working, e.g. expired while a viewer stayed open) so the next call signs a new one. */
export const forgetAttachmentUrl = (path: string) => { urls.delete(path) }
export const openAttachment = (path: string) => signedAttachmentUrl(path).then((u) => { window.open(u, '_blank', 'noopener') })

// Thumbnails asked for in the same render are signed together (one storage request for a whole page of the email list).
let queue: { path: string; resolve: (u: string) => void; reject: (e: unknown) => void }[] = []
export function batchedAttachmentUrl(path: string): Promise<string> {
  const hit = urls.get(path)
  if (hit && hit.until > Date.now()) return Promise.resolve(hit.url)
  return new Promise((resolve, reject) => {
    queue.push({ path, resolve, reject })
    if (queue.length > 1) return
    setTimeout(() => {
      const batch = queue
      queue = []
      attachmentUrls([...new Set(batch.map((b) => b.path))]).then((got) => {
        for (const b of batch) {
          const url = got[b.path]
          if (url) { urls.set(b.path, { url, until: Date.now() + 240_000 }); b.resolve(url) } else b.reject(new Error('Not available.'))
        }
      }, (e) => batch.forEach((b) => b.reject(e)))
    }, 0)
  })
}
