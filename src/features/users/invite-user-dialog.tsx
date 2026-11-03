import { ArrowLeft, ChevronDown, ChevronUp, Loader2, Search, Send, ShieldAlert, X } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  EMPTY_INVITE,
  filterRoles,
  groupRoles,
  keyPermissions,
  moduleLabel,
  validateInvite,
  type CatalogRole,
  type InviteErrors,
  type InviteForm,
} from '@/features/users/invitation-model'
import { inviteUser, InviteServiceError, type InviteResult } from '@/services/users'

const NO_MANAGER = 'none'

export function InviteUserDialog({
  catalog,
  managers,
  onClose,
  onInvited,
}: {
  catalog: CatalogRole[]
  managers: { id: string; label: string }[]
  onClose: () => void
  onInvited: (result: InviteResult, form: InviteForm) => void
}) {
  const [form, setForm] = useState<InviteForm>(EMPTY_INVITE)
  const [errors, setErrors] = useState<InviteErrors>({})
  const [step, setStep] = useState<'form' | 'confirm'>('form')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  // One key per reviewed form: retrying the same send never creates a second invitation.
  const [requestKey, setRequestKey] = useState('')

  const byId = useMemo(() => new Map(catalog.map((r) => [r.id, r])), [catalog])
  const selectedRoles = form.roleIds.map((id) => byId.get(id)).filter((r): r is CatalogRole => Boolean(r))
  const set = <K extends keyof InviteForm>(key: K, value: InviteForm[K]) => setForm((f) => ({ ...f, [key]: value }))
  const toggleRole = (id: string, on: boolean) =>
    setForm((f) => ({ ...f, roleIds: on ? [...new Set([...f.roleIds, id])] : f.roleIds.filter((x) => x !== id) }))

  const review = () => {
    const found = validateInvite(form, catalog)
    setErrors(found)
    if (Object.keys(found).length > 0) return
    setRequestKey(crypto.randomUUID())
    setSendError(null)
    setStep('confirm')
  }

  const send = async () => {
    setSending(true)
    setSendError(null)
    try {
      const result = await inviteUser(form, requestKey)
      onInvited(result, form)
    } catch (err) {
      setSendError(err instanceof InviteServiceError ? err.message : 'The invitation could not be sent. No invitation was confirmed.')
      setSending(false)
    }
  }

  const manager = managers.find((m) => m.id === form.reportingManagerId)
  const permissionCount = new Set(selectedRoles.flatMap((r) => r.permissions.map((p) => p.code))).size

  return (
    <Dialog open onOpenChange={(open) => !open && !sending && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{step === 'form' ? 'Invite User' : 'Confirm invitation'}</DialogTitle>
          <DialogDescription>
            {step === 'form'
              ? 'The employee receives an e-mail to set a password and activate their account. Access is limited to the roles you select.'
              : 'Check the details. The invitation e-mail is sent when you confirm.'}
          </DialogDescription>
        </DialogHeader>

        {step === 'form' ? (
          <form
            id="invite-form"
            className="space-y-5"
            noValidate
            onSubmit={(e) => {
              e.preventDefault()
              review()
            }}
          >
            <section className="grid gap-4 sm:grid-cols-2" aria-label="Employee details">
              <Field id="invite-name" label="Full name" required error={errors.fullName}>
                <Input id="invite-name" value={form.fullName} maxLength={120} autoComplete="off" aria-invalid={Boolean(errors.fullName)}
                  onChange={(e) => set('fullName', e.target.value)} />
              </Field>
              <Field id="invite-email" label="Work email" required error={errors.email}>
                <Input id="invite-email" type="email" value={form.email} autoComplete="off" aria-invalid={Boolean(errors.email)}
                  onChange={(e) => set('email', e.target.value)} />
              </Field>
              <Field id="invite-employee-id" label="Employee ID">
                <Input id="invite-employee-id" value={form.employeeId} maxLength={120} onChange={(e) => set('employeeId', e.target.value)} />
              </Field>
              <Field id="invite-department" label="Department">
                <Input id="invite-department" value={form.department} maxLength={120} onChange={(e) => set('department', e.target.value)} />
              </Field>
              <Field id="invite-designation" label="Designation">
                <Input id="invite-designation" value={form.designation} maxLength={120} onChange={(e) => set('designation', e.target.value)} />
              </Field>
              <Field id="invite-manager" label="Reporting manager">
                <Select value={form.reportingManagerId || NO_MANAGER} onValueChange={(v) => set('reportingManagerId', v === NO_MANAGER ? '' : v)}>
                  <SelectTrigger id="invite-manager"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_MANAGER}>None</SelectItem>
                    {managers.map((m) => <SelectItem key={m.id} value={m.id}>{m.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </Field>
              {errors.details && <p className="text-sm text-red-700 sm:col-span-2">{errors.details}</p>}
            </section>

            <RolePicker catalog={catalog} selected={form.roleIds} onToggle={toggleRole} onClear={() => set('roleIds', [])} error={errors.roleIds} />
          </form>
        ) : (
          <div className="space-y-4 text-sm">
            {sendError && (
              <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-red-800">{sendError}</p>
            )}
            <dl className="grid gap-x-6 gap-y-2 rounded-lg border p-4 sm:grid-cols-2">
              <Summary label="Full name" value={form.fullName.trim()} />
              <Summary label="Work email" value={form.email.trim().toLowerCase()} />
              {form.employeeId.trim() && <Summary label="Employee ID" value={form.employeeId.trim()} />}
              {form.department.trim() && <Summary label="Department" value={form.department.trim()} />}
              {form.designation.trim() && <Summary label="Designation" value={form.designation.trim()} />}
              {manager && <Summary label="Reporting manager" value={manager.label} />}
            </dl>
            <div>
              <p className="mb-2 font-medium">Roles ({selectedRoles.length}) · {permissionCount} permissions in total</p>
              <ul className="space-y-1.5">
                {selectedRoles.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{r.name}</span>
                    <span className="text-xs text-muted-foreground">{r.category}</span>
                    {r.is_admin && <AdminBadge />}
                  </li>
                ))}
              </ul>
            </div>
            {selectedRoles.some((r) => r.is_admin) && (
              <p className="flex gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900">
                <ShieldAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
                This invitation includes an administrative role with access to users, settings or company-wide controls.
              </p>
            )}
            <p className="text-muted-foreground">
              The account stays inactive until the employee opens the link, sets a password and activates it. The link expires after the
              period set on the server (24 hours by default); you can resend or revoke it from the Invitations tab.
            </p>
          </div>
        )}

        <DialogFooter>
          {step === 'form' ? (
            <>
              <Button variant="outline" onClick={onClose}>Cancel</Button>
              <Button type="submit" form="invite-form">Review invitation</Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => setStep('form')} disabled={sending}>
                <ArrowLeft />
                Back
              </Button>
              <Button onClick={() => void send()} disabled={sending}>
                {sending ? <Loader2 className="animate-spin" /> : <Send />}
                {sending ? 'Sending…' : 'Send invitation'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Field({ id, label, required, error, children }: { id: string; label: string; required?: boolean; error?: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>
        {label}
        {required ? <span className="text-red-700" aria-hidden> *</span> : <span className="text-xs font-normal text-muted-foreground"> (optional)</span>}
      </Label>
      {children}
      {error && <p className="text-xs text-red-700">{error}</p>}
    </div>
  )
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium break-words">{value}</dd>
    </div>
  )
}

export function AdminBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-xs font-medium text-violet-700">
      <ShieldAlert aria-hidden className="size-3" />
      Admin
    </span>
  )
}

/** Searchable, categorised role cards. Used by the invite dialog and the role editor. */
export function RolePicker({
  catalog,
  selected,
  onToggle,
  onClear,
  error,
  idPrefix = 'invite-role',
}: {
  catalog: CatalogRole[]
  selected: string[]
  onToggle: (roleId: string, on: boolean) => void
  onClear: () => void
  error?: string
  idPrefix?: string
}) {
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const groups = groupRoles(filterRoles(catalog, query))
  const chosen = new Set(selected)
  const byId = new Map(catalog.map((r) => [r.id, r]))

  return (
    <section className="space-y-3" aria-label="Roles">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className="text-sm font-medium">Roles<span className="text-red-700" aria-hidden> *</span></p>
          <p className="text-xs text-muted-foreground">Select one or more. Access comes from each role’s permissions, not its name.</p>
        </div>
        <div className="relative w-full sm:w-64">
          <Search aria-hidden className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input aria-label="Search roles" placeholder="Search roles or modules…" className="pl-8" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
      </div>

      <div className="flex min-h-9 flex-wrap items-center gap-1.5 rounded-lg border border-dashed px-2.5 py-1.5" aria-live="polite">
        {selected.length === 0 ? (
          <span className="text-xs text-muted-foreground">No roles selected</span>
        ) : (
          <>
            <span className="text-xs text-muted-foreground">Selected ({selected.length}):</span>
            {selected.map((id) => (
              <span key={id} className="inline-flex items-center gap-1 rounded-full bg-primary/10 py-0.5 pr-1 pl-2 text-xs font-medium">
                {byId.get(id)?.name ?? 'Unknown role'}
                <button type="button" className="rounded-full p-0.5 hover:bg-primary/20" aria-label={`Remove ${byId.get(id)?.name ?? 'role'}`} onClick={() => onToggle(id, false)}>
                  <X className="size-3" />
                </button>
              </span>
            ))}
            <Button type="button" variant="ghost" size="sm" className="ml-auto h-7" onClick={onClear}>Clear selection</Button>
          </>
        )}
      </div>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}

      {groups.length === 0 && <p className="text-sm text-muted-foreground">No roles match “{query}”.</p>}
      {groups.map((group) => (
        <fieldset key={group.category} className="space-y-2">
          <legend className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{group.category}</legend>
          <div className="grid gap-2 md:grid-cols-2">
            {group.roles.map((role) => {
              const id = `${idPrefix}-${role.id}`
              const isOpen = expanded === role.id
              return (
                <div key={role.id} data-role-code={role.code}
                  className={`rounded-lg border p-3 ${chosen.has(role.id) ? 'border-primary bg-primary/5' : ''} ${role.assignable ? '' : 'opacity-70'}`}>
                  <div className="flex items-start gap-2.5">
                    <Checkbox id={id} className="mt-0.5" checked={chosen.has(role.id)} disabled={!role.assignable && !chosen.has(role.id)}
                      onCheckedChange={(c) => onToggle(role.id, c === true)} />
                    <div className="min-w-0 flex-1">
                      <Label htmlFor={id} className="flex flex-wrap items-center gap-1.5 font-medium">
                        {role.name}
                        {role.is_admin && <AdminBadge />}
                      </Label>
                      {role.description && <p className="mt-0.5 text-xs text-muted-foreground">{role.description}</p>}
                      {!role.assignable && <p className="mt-1 text-xs font-medium text-amber-800">Only a Super Admin can assign this role.</p>}
                      <p className="mt-1.5 text-xs"><span className="text-muted-foreground">Modules: </span>{role.modules.map(moduleLabel).join(', ') || '—'}</p>
                      <p className="mt-0.5 text-xs"><span className="text-muted-foreground">Key permissions: </span>{keyPermissions(role).join('; ') || '—'}</p>
                      <button type="button" className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                        aria-expanded={isOpen} onClick={() => setExpanded(isOpen ? null : role.id)}>
                        {isOpen ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
                        {isOpen ? 'Hide permissions' : `View permissions (${role.permissions.length})`}
                      </button>
                      {isOpen && (
                        <ul className="mt-1.5 max-h-48 space-y-0.5 overflow-y-auto rounded border bg-surface-muted p-2 text-xs">
                          {role.permissions.map((p) => (
                            <li key={p.code}><code className="text-[11px]">{p.code}</code>{p.description ? ` — ${p.description}` : ''}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </fieldset>
      ))}
    </section>
  )
}
