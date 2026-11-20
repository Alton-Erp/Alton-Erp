// Background continuation of a mailbox sync (no Deno / npm imports; unit-tested in tests/unit/gmail-functions.test.ts).
//
// When a batch leaves work, the next batch is a new request to google-gmail-sync ({ action: 'continue' }) with the
// scheduler secret: a fresh worker with its own resource limits. The request is sent in the background (the Edge
// Runtime's waitUntil keeps this worker alive until it is answered — one batch later, since each batch answers
// before starting the next). If it is lost (network, worker limit), the scheduled run continues from the stored progress.

import { fetchWithTimeout, log } from './google.ts'

export function makeContinuation(o: {
  supabaseUrl: string | undefined; cronSecret: string | null; fetch: typeof fetch; waitUntil?: (p: Promise<unknown>) => void
}): ((account: string, depth: number) => void) | undefined {
  if (!o.supabaseUrl || !o.cronSecret) return undefined
  const url = `${o.supabaseUrl.replace(/\/+$/, '')}/functions/v1/google-gmail-sync`
  const secret = o.cronSecret
  return (account, depth) => {
    const p = fetchWithTimeout(o.fetch, url, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-cron-secret': secret }, body: JSON.stringify({ action: 'continue', account, depth }),
    }, 140000).then(async (r) => {
      if (!r.ok) log('gmail-sync', 'warn', 'continuation refused; the scheduled run continues', { account, depth, status: r.status })
      await r.body?.cancel()
    }, () => log('gmail-sync', 'warn', 'continuation not delivered; the scheduled run continues', { account, depth }))
    if (o.waitUntil) o.waitUntil(p)
  }
}
