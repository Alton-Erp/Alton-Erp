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
export const openAttachment = (path: string) => signedAttachmentUrl(path).then((u) => { window.open(u, '_blank', 'noopener') })
