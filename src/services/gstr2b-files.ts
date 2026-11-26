// Original GSTR-2B files (migration 20261231090600, Edge Function gst-2b-verify).
//
// Upload: the database validates the file (type, size, checksum, duplicates) and reserves a server-chosen path in the private
// gst-files bucket → the browser uploads the bytes (no overwrite) → the database checks the stored object → the Edge Function
// recomputes the SHA-256 from the stored bytes on the server, parses the rows and records them. Nothing is posted.
// Download: the database grants (and audits) a 5-minute read of the object; Storage then signs a short URL.
import { gstr2bFileKind, sha256OfFile, type Gstr2bImport } from '@/features/accounting/gstr2b-model'
import { requireSupabase } from '@/lib/supabase'
import { completeGstr2bUpload, gstr2bFileAccess, prepareGstr2bUpload } from '@/services/accounting'

export async function verifyGstr2bImport(importId: string): Promise<Gstr2bImport> {
  const { data, error } = await requireSupabase().functions.invoke('gst-2b-verify', { body: { import_id: importId } })
  if (error) {
    const ctx = (error as { context?: Response }).context
    let message = 'The GSTR-2B file could not be verified on the server.'
    if (ctx && typeof ctx.json === 'function') {
      if (ctx.status === 404) message = 'The gst-2b-verify Edge Function is not deployed on this Supabase project.'
      try { message = ((await ctx.clone().json()) as { error?: string }).error ?? message } catch { /* keep the default */ }
    }
    throw Object.assign(new Error(message), { code: 'P0001' })
  }
  return (data as { import: Gstr2bImport }).import
}

/** Prepare → upload → complete → server-side verification. Returns the import (VERIFIED, or REJECTED with the reason). */
export async function uploadGstr2bFile(file: File, returnPeriod: string): Promise<Gstr2bImport> {
  const kind = gstr2bFileKind(file.name)
  if (!kind) throw Object.assign(new Error('Only CSV or Excel (.xlsx) GSTR-2B files are accepted.'), { code: 'P0001' })
  const prep = await prepareGstr2bUpload({ file_name: file.name, mime_type: kind.mime, file_size: file.size, sha256: await sha256OfFile(file), return_period: returnPeriod })
  const { error } = await requireSupabase().storage.from(prep.bucket).upload(prep.storage_path, file, { contentType: kind.mime, upsert: false })
  if (error) throw error
  const done = await completeGstr2bUpload(prep.id)
  if (done.status !== 'UPLOADED') return done
  return verifyGstr2bImport(prep.id)
}

export async function gstr2bFileUrl(importId: string): Promise<{ url: string; fileName: string }> {
  const g = await gstr2bFileAccess(importId)
  const { data, error } = await requireSupabase().storage.from(g.bucket).createSignedUrl(g.storage_path, 120, { download: g.file_name })
  if (error || !data?.signedUrl) throw error ?? new Error('Could not create a download link.')
  return { url: data.signedUrl, fileName: g.file_name }
}
