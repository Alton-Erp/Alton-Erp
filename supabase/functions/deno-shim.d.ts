// Type declarations used ONLY to type-check the Edge Functions with tsc
// (npm run typecheck:edge). Supabase runs them on Deno, which provides these.
declare namespace Deno {
  const env: { get(name: string): string | undefined }
  function serve(handler: (req: Request) => Response | Promise<Response>): void
}
