// Supabase Edge Function: gst-2b-verify (JWT required). Rules in handler.ts and migration 20261231090600.
//
// Deploy:  npx supabase functions deploy gst-2b-verify
// Secrets: ALLOWED_ORIGINS   https://<erp-origin> (comma-separated)
// SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are injected by Supabase.
// Excel files are read with SheetJS (the same version as the web app, from the SheetJS CDN).

import { createClient } from 'npm:@supabase/supabase-js@2'

import { handle, type AdminClient, type CallerClient, type Sheet } from './handler.ts'

const XLSX_URL = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs'
interface SheetJs {
  read(data: Uint8Array, opts: Record<string, unknown>): { SheetNames: string[]; Sheets: Record<string, unknown> }
  utils: { sheet_to_json(sheet: unknown, opts: Record<string, unknown>): unknown[][] }
}

const url = Deno.env.get('SUPABASE_URL') ?? ''
const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const options = { auth: { persistSession: false, autoRefreshToken: false } }

async function readWorkbook(bytes: Uint8Array): Promise<Sheet[]> {
  const XLSX = (await import(XLSX_URL)) as SheetJs
  const wb = XLSX.read(bytes, { type: 'array', dense: true, cellDates: false, WTF: true })
  return wb.SheetNames.map((name) => ({
    name,
    rows: XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, defval: '', blankrows: true, dateNF: 'dd-mm-yyyy' })
      .map((r) => r.map((c) => (c === null || c === undefined ? '' : String(c)))),
  }))
}

function admin(): AdminClient {
  const client = createClient(url, serviceKey, options)
  const rpc = client as unknown as Pick<AdminClient, 'rpc'>
  return {
    rpc: (fn, args) => rpc.rpc(fn, args),
    download: async (bucket, path) => {
      const { data, error } = await client.storage.from(bucket).download(path)
      if (error || !data) return { bytes: null, error: error?.message ?? 'not found' }
      return { bytes: new Uint8Array(await data.arrayBuffer()), error: null }
    },
  }
}

Deno.serve((req) => handle(req, {
  allowedOrigins: (Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').map((o) => o.trim()).filter(Boolean),
  configured: Boolean(url && anonKey && serviceKey),
  caller: (authHeader) => createClient(url, anonKey, { ...options, global: { headers: { Authorization: authHeader } } }) as unknown as CallerClient,
  admin,
  readWorkbook,
}))
