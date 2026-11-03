/**
 * User invitations (migration 20261116090000_user_invitations.sql and the
 * invite-user Edge Function). Pure helpers: role catalogue grouping and search,
 * form validation, and turning Edge Function failures into clear messages.
 * The server re-checks everything; nothing here grants access.
 */

export const ROLE_CATEGORIES = [
  'Administration',
  'Finance & Accounts',
  'Sales & Commercial',
  'Purchase & Procurement',
  'Inventory & Warehouse',
  'Production & Manufacturing',
  'Dispatch & Fulfilment',
  'Other',
] as const
export type RoleCategory = (typeof ROLE_CATEGORIES)[number]

export interface CatalogRole {
  id: string
  code: string
  name: string
  description: string | null
  category: string
  is_admin: boolean
  assignable: boolean
  modules: string[]
  permissions: { code: string; description: string | null }[]
}

export interface RoleCatalog {
  is_super_admin: boolean
  roles: CatalogRole[]
}

export type InvitationStatus = 'PENDING' | 'ACCEPTED' | 'EXPIRED' | 'REVOKED' | 'FAILED'
export type EmailStatus = 'SENDING' | 'SENT' | 'FAILED'

export interface InvitationRow {
  id: string
  email: string
  full_name: string
  employee_id: string | null
  department: string | null
  designation: string | null
  reporting_manager: string | null
  roles: { id: string; code: string; name: string }[] | null
  status: InvitationStatus
  email_status: EmailStatus
  email_error: string | null
  delivery_method: 'AUTH_INVITE' | 'PASSWORD_LINK'
  invited_at: string
  invited_by: string | null
  expires_at: string
  last_sent_at: string | null
  send_count: number
  accepted_at: string | null
  revoked_at: string | null
  revoked_by: string | null
  revoke_reason: string | null
  user_id: string | null
}

export interface MyInvitation {
  invitation_id: string
  company_name: string
  full_name: string
  email: string
  roles: string[] | null
  status: InvitationStatus
  expires_at: string
  support_email: string | null
}

/** Readable module names for the role cards. */
const MODULE_LABELS: Record<string, string> = {
  amazon: 'Amazon', amazon_integration: 'Amazon integration', analytics: 'Analytics', approvals: 'Approvals', audit_logs: 'Audit log',
  barcodes: 'Barcodes', billing: 'Billing', billing_settings: 'Billing settings', bom: 'BOM', companies: 'Company', customer_po: 'Customer POs',
  customers: 'Customers', dashboard: 'Dashboard', documents: 'Documents', fulfilment: 'Fulfilment', imports: 'Imports', inventory: 'Inventory',
  invoices: 'Invoices', notifications: 'Notifications', payments: 'Payments', products: 'Products', production: 'Production',
  purchase_orders: 'Purchase orders', purchasing: 'Purchasing', reports: 'Reports', sales: 'Sales', sales_orders: 'Sales orders',
  settings: 'Settings', suppliers: 'Suppliers', system: 'System', users: 'Users', warehouses: 'Warehouses',
}
export const moduleLabel = (m: string) => MODULE_LABELS[m] ?? m.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())

/** Permissions shown on the card: writes before reads, a few at most. */
export function keyPermissions(role: CatalogRole, max = 4): string[] {
  const writes = role.permissions.filter((p) => !p.code.endsWith('.read'))
  return (writes.length > 0 ? writes : role.permissions).slice(0, max).map((p) => p.description || p.code)
}

const norm = (s: string) => s.toLowerCase().normalize('NFKD')

export function filterRoles(roles: CatalogRole[], query: string): CatalogRole[] {
  const q = norm(query.trim())
  if (!q) return roles
  return roles.filter((r) =>
    [r.name, r.code, r.description ?? '', r.category, ...r.modules.map(moduleLabel), ...r.modules].some((v) => norm(v).includes(q)),
  )
}

/** Roles grouped in the fixed category order; unknown categories go to Other. */
export function groupRoles(roles: CatalogRole[]): { category: RoleCategory; roles: CatalogRole[] }[] {
  const known = new Set<string>(ROLE_CATEGORIES)
  return ROLE_CATEGORIES.map((category) => ({
    category,
    roles: roles
      .filter((r) => (known.has(r.category) ? r.category : 'Other') === category)
      .sort((a, b) => a.name.localeCompare(b.name)),
  })).filter((g) => g.roles.length > 0)
}

export interface InviteForm {
  fullName: string
  email: string
  employeeId: string
  department: string
  designation: string
  reportingManagerId: string
  roleIds: string[]
}

export const EMPTY_INVITE: InviteForm = { fullName: '', email: '', employeeId: '', department: '', designation: '', reportingManagerId: '', roleIds: [] }

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

export type InviteErrors = Partial<Record<'fullName' | 'email' | 'roleIds' | 'details', string>>

export function validateInvite(form: InviteForm, catalog: CatalogRole[]): InviteErrors {
  const errors: InviteErrors = {}
  const name = form.fullName.trim()
  if (name.length < 2) errors.fullName = 'Enter the employee’s full name.'
  else if (name.length > 120) errors.fullName = 'The name is too long (120 characters at most).'
  const email = form.email.trim()
  if (!email) errors.email = 'Enter the work e-mail address.'
  else if (!EMAIL_RE.test(email) || email.length > 254) errors.email = 'Enter a valid e-mail address.'
  if (form.roleIds.length === 0) errors.roleIds = 'Select at least one role.'
  else {
    const byId = new Map(catalog.map((r) => [r.id, r]))
    const blocked = form.roleIds.map((id) => byId.get(id)).filter((r) => !r || !r.assignable)
    if (blocked.length > 0) errors.roleIds = `You cannot assign: ${blocked.map((r) => r?.name ?? 'an unknown role').join(', ')}.`
  }
  if ([form.employeeId, form.department, form.designation].some((v) => v.trim().length > 120)) errors.details = 'Employee details are limited to 120 characters each.'
  return errors
}

/** Body for the invite-user Edge Function. Company and inviter are never sent; the server derives them. */
export function inviteRequestBody(form: InviteForm, idempotencyKey: string) {
  const details: Record<string, string> = {}
  if (form.employeeId.trim()) details.employee_id = form.employeeId.trim()
  if (form.department.trim()) details.department = form.department.trim()
  if (form.designation.trim()) details.designation = form.designation.trim()
  if (form.reportingManagerId) details.reporting_manager_id = form.reportingManagerId
  return {
    action: 'invite' as const,
    email: form.email.trim().toLowerCase(),
    full_name: form.fullName.trim().replace(/\s+/g, ' '),
    role_ids: [...new Set(form.roleIds)],
    details,
    idempotency_key: idempotencyKey,
  }
}

export const INVITE_NOT_DEPLOYED =
  'The invitation service is not deployed on this Supabase project. Deploy the invite-user Edge Function (see docs/SUPABASE_SETUP.md). No invitation was sent.'
export const INVITE_NETWORK =
  'The invitation service could not be reached (network problem). Check your connection and try again; it is safe to retry. No invitation was confirmed.'

/** A user-facing message for an Edge Function failure. Never reports success. */
export function describeInviteFailure(status: number, body: { code?: unknown; error?: unknown } | null): { code: string; message: string } {
  const code = typeof body?.code === 'string' ? body.code : ''
  const server = typeof body?.error === 'string' && body.error.trim() ? body.error.trim() : ''
  if (status === 0) return { code: 'NETWORK', message: INVITE_NETWORK }
  if (status === 404 && !code) return { code: 'NOT_DEPLOYED', message: INVITE_NOT_DEPLOYED }
  if (status === 401) return { code: code || 'UNAUTHORIZED', message: 'Your session has expired. Sign in again, then retry. No invitation was sent.' }
  if (status === 403) return { code: code || 'FORBIDDEN', message: server || 'You do not have permission to invite users or assign these roles. No invitation was sent.' }
  if (status === 409) return { code: code || 'DUPLICATE', message: server || 'An invitation or account already exists for this e-mail. No invitation was sent.' }
  if (status === 429) return { code: 'RATE_LIMITED', message: server || 'Too many invitations in a short time. Wait a while and try again.' }
  if (status === 502 || code === 'EMAIL_FAILED') return { code: 'EMAIL_FAILED', message: server || 'The invitation e-mail could not be sent. Check the e-mail settings and use Resend.' }
  if (status === 400) return { code: code || 'VALIDATION', message: server || 'Some details are invalid. Check the form and try again.' }
  if (code === 'NOT_CONFIGURED') return { code, message: 'The invitation service is deployed but not configured (missing Supabase secrets). No invitation was sent.' }
  return { code: code || 'SERVER_ERROR', message: server || 'The invitation could not be processed. No invitation was confirmed; check the Invitations list before retrying.' }
}

export type InvitationLink =
  | { kind: 'token_hash'; tokenHash: string; type: 'invite' | 'recovery' | 'magiclink' | 'email' }
  | { kind: 'tokens'; accessToken: string; refreshToken: string }
  | { kind: 'error'; message: string }
  | { kind: 'none' }

/**
 * Reads an invitation link. The recommended e-mail template links to
 * /accept-invitation?token_hash=…&type=invite (verified in the browser with
 * verifyOtp, works with PKCE and in any browser); Supabase's default
 * {{ .ConfirmationURL }} redirects with #access_token=…&refresh_token=…
 * (implicit grant), which the PKCE client ignores, so the page sets that session itself.
 */
export function parseInvitationLink(search: string, hash: string): InvitationLink {
  const q = new URLSearchParams(search)
  const h = new URLSearchParams(hash.replace(/^#/, ''))
  const error = q.get('error_description') ?? h.get('error_description')
  if (error) return { kind: 'error', message: error.replace(/\+/g, ' ') }
  const tokenHash = q.get('token_hash')
  const type = q.get('type') ?? 'invite'
  if (tokenHash && /^[\w-]{6,}$/.test(tokenHash) && ['invite', 'recovery', 'magiclink', 'email'].includes(type)) {
    return { kind: 'token_hash', tokenHash, type: type as 'invite' }
  }
  const accessToken = h.get('access_token')
  const refreshToken = h.get('refresh_token')
  if (accessToken && refreshToken) return { kind: 'tokens', accessToken, refreshToken }
  return { kind: 'none' }
}

export const STATUS_TONE: Record<InvitationStatus, 'warning' | 'success' | 'neutral' | 'danger'> = {
  PENDING: 'warning', ACCEPTED: 'success', EXPIRED: 'neutral', REVOKED: 'neutral', FAILED: 'danger',
}

export const canResend = (i: InvitationRow) => i.status === 'PENDING' || i.status === 'EXPIRED' || i.status === 'FAILED'
export const canRevoke = (i: InvitationRow) => i.status === 'PENDING' || i.status === 'EXPIRED' || i.status === 'FAILED'
