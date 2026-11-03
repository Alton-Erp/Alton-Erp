/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string
  /** Publishable (browser-safe) key. Never a service-role or secret key. */
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string
  /** Legacy name for the anon public key (used by some hosts, e.g. Bolt.new). */
  readonly VITE_SUPABASE_ANON_KEY?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
