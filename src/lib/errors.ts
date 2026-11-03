/**
 * Converts Supabase/PostgREST/Auth/network errors into short, safe messages.
 * Never surfaces raw SQL or internal details to the user.
 */

interface ErrorLike {
  code?: string
  status?: number
  message?: string
  name?: string
}

function asErrorLike(error: unknown): ErrorLike {
  return typeof error === 'object' && error !== null ? (error as ErrorLike) : { message: String(error) }
}

export function isNetworkError(error: unknown): boolean {
  const e = asErrorLike(error)
  return (
    e.name === 'AuthRetryableFetchError' ||
    e.name === 'FunctionsFetchError' ||
    (e.name === 'TypeError' && /fetch|network/i.test(e.message ?? '')) ||
    /failed to fetch|network ?error|load failed/i.test(e.message ?? '')
  )
}

export function describeDataError(error: unknown): string {
  const e = asErrorLike(error)
  if (isNetworkError(error)) return 'Cannot reach the server. Check your internet connection and try again.'
  switch (e.code) {
    case 'P0001':
      // Raised by this project's own validation triggers with user-facing text.
      return e.message || 'The change was rejected by a business rule.'
    case '42501':
      // Messages raised by this project's functions (segregation of duties,
      // exception permissions) are user-facing; raw PostgreSQL privilege
      // errors are not shown.
      if (e.message && !/permission denied|row-level security|policy|^not permitted$/i.test(e.message)) return e.message
      return 'You do not have permission to perform this action.'
    case 'PGRST301':
    case 'PGRST303':
      return 'Your session has expired. Please sign in again.'
    case '23505':
      return 'A record with these details already exists.'
    case '23503':
      return 'This change refers to a record that does not exist or is not in your company.'
    case '23514':
    case '22023':
    case '22P02':
      return 'One or more values are invalid.'
    case 'PGRST116':
      return 'The record was not found or you do not have access to it.'
    case 'PGRST202':
    case '42883':
      return 'This screen needs a database update that has not been applied to the server yet. Ask your administrator to apply the latest migrations.'
    case '25006':
      return 'The server could not prepare this data (a read-only request tried to save defaults). Ask your administrator to apply the latest database update.'
    case '57014':
      return 'The server took too long to answer. Please try again.'
  }
  if (e.status === 401) return 'Your session has expired. Please sign in again.'
  if (e.status === 403) return 'You do not have permission to perform this action.'
  return 'Something went wrong. Please try again.'
}

/** Short reference shown to users so a failure can be matched with the logs (no database details). */
export function errorReference(error: unknown): string | null {
  const e = asErrorLike(error)
  if (isNetworkError(error)) return 'NETWORK'
  return e.code ?? (e.status ? `HTTP ${e.status}` : null)
}

/**
 * Logs a failed data operation for diagnosis: where (area / operation), the
 * Supabase / PostgreSQL error code, the database message, details / hint and
 * the request id when the server exposed it. Never logs credentials, tokens,
 * request bodies or headers.
 */
export function logDataError(where: { area: string; operation: string; requestId?: string | null }, error: unknown) {
  const e = asErrorLike(error) as ErrorLike & { details?: unknown; hint?: unknown }
  console.error(`[ALTON ERP] ${where.area}: ${where.operation} failed`, {
    code: e.code ?? null,
    status: e.status ?? null,
    message: typeof e.message === 'string' ? e.message.slice(0, 500) : null,
    details: typeof e.details === 'string' ? e.details.slice(0, 500) : null,
    hint: typeof e.hint === 'string' ? e.hint.slice(0, 300) : null,
    requestId: where.requestId ?? null,
  })
}

/** Product/category specific wording for unique-key violations. */
export function describeProductError(error: unknown): string {
  const e = asErrorLike(error)
  if (e.code === '23505') {
    const m = e.message ?? ''
    if (m.includes('products_company_sku_unique')) return 'A product with this SKU already exists (SKUs are not case-sensitive).'
    if (m.includes('products_company_barcode_unique')) return 'This barcode is already used by another product.'
    if (m.includes('products_company_ean_unique')) return 'This EAN is already used by another product in your company.'
    if (m.includes('product_categories_company_code_unique')) return 'A category with this code already exists.'
    if (m.includes('product_categories_company_name_unique')) return 'A category with this name already exists.'
  }
  if (e.code === '23514') {
    const m = e.message ?? ''
    if (m.includes('products_ean_format')) return 'The EAN is not valid: use 8 or 13 digits with a correct check digit.'
    if (m.includes('products_group_head_length')) return 'The group head must be 1 to 100 characters.'
    if (m.includes('products_minimum_cover_days_range')) return 'Minimum stock days must be from 0 to 3650.'
  }
  if (e.code === '23503') return 'The selected category is not valid for your company.'
  return describeDataError(error)
}

export function describeAuthError(error: unknown): string {
  const e = asErrorLike(error)
  if (isNetworkError(error)) return 'Cannot reach the sign-in service. Check your internet connection and try again.'
  const code = e.code ?? ''
  const msg = e.message ?? ''
  if (code === 'invalid_credentials' || /invalid login credentials/i.test(msg)) return 'Incorrect email or password.'
  if (code === 'email_not_confirmed' || /email not confirmed/i.test(msg)) {
    return 'Your email address has not been confirmed yet. Use the link in your invitation email.'
  }
  if (code === 'user_banned') return 'This account has been disabled. Contact your administrator.'
  if (code === 'over_request_rate_limit' || code === 'over_email_send_rate_limit' || e.status === 429) {
    return 'Too many attempts. Please wait a few minutes and try again.'
  }
  if (code === 'weak_password') return 'That password is too weak. Use at least 8 characters with a mix of letters and numbers.'
  if (code === 'same_password') return 'Choose a password different from your current one.'
  if (code === 'session_expired' || code === 'refresh_token_not_found') return 'Your session has expired. Please sign in again.'
  return 'Sign-in failed. Please try again.'
}
