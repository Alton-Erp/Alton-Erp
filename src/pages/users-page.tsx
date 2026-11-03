import { Loader2, ShieldCheck, UserCheck, UserCog, UserPlus, Users, UserX } from 'lucide-react'
import { useState } from 'react'

import { ROLE_LABELS } from '@/auth/permissions'
import { useAuth } from '@/auth/use-auth'
import { usePermissions } from '@/auth/use-permissions'
import { PermissionGate } from '@/auth/permission-gate'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import { fetchCompanyUsers, inviteUser, setUserActive, updateUserRoles, type CompanyUser } from '@/services/users'
import type { RoleRow } from '@/types/database'

export default function UsersPage() {
  const { access, user } = useAuth()
  const { hasRole } = usePermissions()
  const companyId = access?.company?.id ?? ''
  const timezone = access?.company?.timezone
  const { data, loading, error, reload } = useAsync(() => fetchCompanyUsers(companyId), [companyId])

  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)
  const [roleTarget, setRoleTarget] = useState<CompanyUser | null>(null)
  const [activeTarget, setActiveTarget] = useState<CompanyUser | null>(null)
  const [inviteOpen, setInviteOpen] = useState(false)

  const roles = data?.roles ?? []
  const isSuperAdmin = hasRole('SUPER_ADMIN')

  const toggleActive = async (target: CompanyUser) => {
    setNotice(null)
    try {
      await setUserActive(target.id, !target.is_active)
      setNotice({ tone: 'success', text: `${target.full_name || target.email} was ${target.is_active ? 'deactivated' : 'activated'}.` })
      reload()
    } catch (err) {
      setNotice({ tone: 'error', text: describeDataError(err) })
    }
  }

  const columns: DataTableColumn<CompanyUser>[] = [
    {
      id: 'user',
      header: 'User',
      cell: (u) => (
        <div className="min-w-0">
          <p className="font-medium">
            {u.full_name || '—'}
            {u.id === user?.id && <span className="ml-1.5 text-xs font-normal text-muted-foreground">(you)</span>}
          </p>
          <p className="text-xs text-muted-foreground">{u.email}</p>
        </div>
      ),
      searchValue: (u) => `${u.full_name ?? ''} ${u.email}`,
    },
    {
      id: 'roles',
      header: 'Roles',
      cell: (u) =>
        u.roles.length === 0 ? (
          <span className="text-xs text-muted-foreground">No role</span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {u.roles.map((r) => (
              <StatusBadge key={r.assignmentId} label={ROLE_LABELS[r.code] ?? r.name} tone={r.code === 'SUPER_ADMIN' ? 'outsourced' : 'info'} />
            ))}
          </div>
        ),
      searchValue: (u) => u.roles.map((r) => r.name).join(' '),
    },
    {
      id: 'status',
      header: 'Status',
      cell: (u) => (u.is_active ? <StatusBadge label="Active" tone="success" /> : <StatusBadge label="Inactive" />),
    },
    { id: 'added', header: 'Added', cell: (u) => <span className="text-muted-foreground">{formatDateTime(u.created_at, timezone)}</span> },
    {
      id: 'actions',
      header: 'Actions',
      align: 'right',
      cell: (u) => {
        const self = u.id === user?.id
        const protectedSuper = u.roles.some((r) => r.code === 'SUPER_ADMIN') && !isSuperAdmin
        const disabledReason = self ? "You can't change your own access" : protectedSuper ? 'Only a Super Admin can change this account' : undefined
        return (
          <PermissionGate permission="users.manage">
            <div className="flex justify-end gap-1.5" title={disabledReason}>
              <Button variant="outline" size="sm" disabled={Boolean(disabledReason)} onClick={() => setRoleTarget(u)}>
                <UserCog />
                Roles
              </Button>
              <Button variant="outline" size="sm" disabled={Boolean(disabledReason)} onClick={() => setActiveTarget(u)}>
                {u.is_active ? <UserX /> : <UserCheck />}
                {u.is_active ? 'Deactivate' : 'Activate'}
              </Button>
            </div>
          </PermissionGate>
        )
      },
    },
  ]

  return (
    <>
      <PageHeader
        actions={
          <PermissionGate permission="users.manage">
            <Button onClick={() => setInviteOpen(true)} disabled={roles.length === 0}>
              <UserPlus />
              Invite User
            </Button>
          </PermissionGate>
        }
      />

      {notice && (
        <div
          role={notice.tone === 'error' ? 'alert' : 'status'}
          className={
            notice.tone === 'error'
              ? 'mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800'
              : 'mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-800'
          }
        >
          {notice.text}
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-3">
        <DataTable
          className="xl:col-span-2"
          title="Users"
          description={access?.company ? `Accounts in ${access.company.display_name}` : undefined}
          columns={columns}
          data={data?.users ?? []}
          getRowId={(u) => u.id}
          searchPlaceholder="Search name, email or role…"
          loading={loading}
          error={error ? new Error(describeDataError(error)) : null}
          onRetry={reload}
          emptyState={{
            icon: Users,
            title: 'No users found',
            description: 'Invite staff members to give them access. New accounts have no access until a role is assigned.',
          }}
        />

        <RolesCard roles={roles} loading={loading} />
      </div>

      {roleTarget && (
        <RolesDialog
          target={roleTarget}
          roles={roles}
          canGrantSuperAdmin={isSuperAdmin}
          onClose={() => setRoleTarget(null)}
          onSave={async (grantRoleIds, revokeAssignmentIds) => {
            await updateUserRoles({
              userId: roleTarget.id,
              companyId,
              actorId: user?.id ?? '',
              grantRoleIds,
              revokeAssignmentIds,
            })
            setNotice({ tone: 'success', text: `Roles updated for ${roleTarget.full_name || roleTarget.email}.` })
            setRoleTarget(null)
            reload()
          }}
        />
      )}

      <ConfirmDialog
        open={activeTarget !== null}
        onOpenChange={(open) => !open && setActiveTarget(null)}
        title={activeTarget?.is_active ? 'Deactivate this user?' : 'Activate this user?'}
        description={
          activeTarget?.is_active
            ? `${activeTarget.full_name || activeTarget.email} will immediately lose access to all ERP data. Their roles are kept so access can be restored later.`
            : `${activeTarget?.full_name || activeTarget?.email} will regain access according to their roles.`
        }
        confirmLabel={activeTarget?.is_active ? 'Deactivate' : 'Activate'}
        destructive={activeTarget?.is_active}
        onConfirm={() => activeTarget && void toggleActive(activeTarget)}
      />

      {inviteOpen && (
        <InviteDialog
          roles={roles}
          canGrantSuperAdmin={isSuperAdmin}
          onClose={() => setInviteOpen(false)}
          onInvited={(email) => {
            setInviteOpen(false)
            setNotice({ tone: 'success', text: `Invitation sent to ${email}.` })
            reload()
          }}
        />
      )}
    </>
  )
}

function RolesCard({ roles, loading }: { roles: RoleRow[]; loading: boolean }) {
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Roles</CardTitle>
          <CardDescription>Defined in the database; permissions are enforced by the server</CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading roles…</p>
        ) : (
          <ul className="space-y-3">
            {roles.map((role) => (
              <li key={role.id} className="flex gap-3">
                <ShieldCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <div>
                  <p className="text-sm font-medium">{role.name}</p>
                  {role.description && <p className="text-sm text-muted-foreground">{role.description}</p>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

function RoleCheckboxes({
  roles,
  selected,
  onToggle,
  canGrantSuperAdmin,
  idPrefix,
}: {
  roles: RoleRow[]
  selected: Set<string>
  onToggle: (roleId: string, checked: boolean) => void
  canGrantSuperAdmin: boolean
  idPrefix: string
}) {
  return (
    <fieldset className="space-y-2.5">
      <legend className="mb-2 text-sm font-medium">Roles</legend>
      {roles.map((role) => {
        const locked = role.code === 'SUPER_ADMIN' && !canGrantSuperAdmin
        const id = `${idPrefix}-${role.id}`
        return (
          <div key={role.id} className="flex items-start gap-2.5">
            <Checkbox
              id={id}
              checked={selected.has(role.id)}
              disabled={locked}
              onCheckedChange={(checked) => onToggle(role.id, checked === true)}
              className="mt-0.5"
            />
            <Label htmlFor={id} className="flex-col items-start gap-0.5 font-normal">
              <span className="font-medium">{role.name}</span>
              <span className="text-xs text-muted-foreground">
                {locked ? 'Only a Super Admin can grant this role.' : role.description}
              </span>
            </Label>
          </div>
        )
      })}
    </fieldset>
  )
}

function RolesDialog({
  target,
  roles,
  canGrantSuperAdmin,
  onClose,
  onSave,
}: {
  target: CompanyUser
  roles: RoleRow[]
  canGrantSuperAdmin: boolean
  onClose: () => void
  onSave: (grantRoleIds: string[], revokeAssignmentIds: string[]) => Promise<void>
}) {
  const [selected, setSelected] = useState(() => new Set(target.roles.map((r) => r.roleId)))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const current = new Set(target.roles.map((r) => r.roleId))
  const grants = [...selected].filter((id) => !current.has(id))
  const revokes = target.roles.filter((r) => !selected.has(r.roleId)).map((r) => r.assignmentId)
  const unchanged = grants.length === 0 && revokes.length === 0

  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Roles for {target.full_name || target.email}</DialogTitle>
          <DialogDescription>Changes take effect immediately and are recorded in the audit log.</DialogDescription>
        </DialogHeader>
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
        <RoleCheckboxes
          idPrefix="edit-role"
          roles={roles}
          selected={selected}
          canGrantSuperAdmin={canGrantSuperAdmin}
          onToggle={(roleId, checked) =>
            setSelected((prev) => {
              const next = new Set(prev)
              if (checked) next.add(roleId)
              else next.delete(roleId)
              return next
            })
          }
        />
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            disabled={unchanged || saving}
            onClick={async () => {
              setSaving(true)
              setError(null)
              try {
                await onSave(grants, revokes)
              } catch (err) {
                setError(describeDataError(err))
                setSaving(false)
              }
            }}
          >
            {saving && <Loader2 className="animate-spin" />}
            Save roles
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function InviteDialog({
  roles,
  canGrantSuperAdmin,
  onClose,
  onInvited,
}: {
  roles: RoleRow[]
  canGrantSuperAdmin: boolean
  onClose: () => void
  onInvited: (email: string) => void
}) {
  const [email, setEmail] = useState('')
  const [fullName, setFullName] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    setError(null)
    if (!EMAIL_RE.test(email.trim())) return setError('Enter a valid email address.')
    if (selected.size === 0) return setError('Select at least one role.')
    setSending(true)
    try {
      await inviteUser({
        email: email.trim(),
        fullName: fullName.trim(),
        roleCodes: roles.filter((r) => selected.has(r.id)).map((r) => r.code),
      })
      onInvited(email.trim())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The invitation could not be sent.')
      setSending(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !sending && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Invite User</DialogTitle>
          <DialogDescription>
            The user receives an email to set their password. They join your company with the roles selected below.
          </DialogDescription>
        </DialogHeader>
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
        <form
          id="invite-form"
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
          noValidate
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="invite-name">Full name</Label>
              <Input id="invite-name" value={fullName} onChange={(e) => setFullName(e.target.value)} maxLength={120} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="invite-email">Work email</Label>
              <Input id="invite-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
          </div>
          <RoleCheckboxes
            idPrefix="invite-role"
            roles={roles}
            selected={selected}
            canGrantSuperAdmin={canGrantSuperAdmin}
            onToggle={(roleId, checked) =>
              setSelected((prev) => {
                const next = new Set(prev)
                if (checked) next.add(roleId)
                else next.delete(roleId)
                return next
              })
            }
          />
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={sending}>
            Cancel
          </Button>
          <Button type="submit" form="invite-form" disabled={sending}>
            {sending && <Loader2 className="animate-spin" />}
            Send invitation
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
