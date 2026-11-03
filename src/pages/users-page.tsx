import { Loader2, ShieldCheck, UserCheck, UserCog, UserPlus, Users, UserX } from 'lucide-react'
import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import { ROLE_LABELS } from '@/auth/permissions'
import { useAuth } from '@/auth/use-auth'
import { usePermissions } from '@/auth/use-permissions'
import { PermissionGate } from '@/auth/permission-gate'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { FilterTabs } from '@/components/common/filter-tabs'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { groupRoles, type CatalogRole } from '@/features/users/invitation-model'
import { InvitationsPanel } from '@/features/users/invitations-panel'
import { AdminBadge, InviteUserDialog, RolePicker } from '@/features/users/invite-user-dialog'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import { fetchCompanyUsers, fetchInvitations, fetchRoleCatalog, setUserActive, updateUserRoles, type CompanyUser } from '@/services/users'

type Tab = 'users' | 'invitations'

export default function UsersPage() {
  const { access, user } = useAuth()
  const { hasRole } = usePermissions()
  const companyId = access?.company?.id ?? ''
  const timezone = access?.company?.timezone
  const { data, loading, error, reload } = useAsync(() => fetchCompanyUsers(companyId), [companyId])
  const catalog = useAsync(fetchRoleCatalog, [companyId])
  const invitations = useAsync(fetchInvitations, [companyId])
  const [params, setParams] = useSearchParams()
  const tab: Tab = params.get('tab') === 'invitations' ? 'invitations' : 'users'

  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)
  const [roleTarget, setRoleTarget] = useState<CompanyUser | null>(null)
  const [activeTarget, setActiveTarget] = useState<CompanyUser | null>(null)
  const [inviteOpen, setInviteOpen] = useState(false)

  const catalogRoles = catalog.data?.roles ?? []
  const isSuperAdmin = hasRole('SUPER_ADMIN')
  const reloadAll = () => {
    reload()
    invitations.reload()
  }
  const setTab = (next: Tab) => {
    const p = new URLSearchParams(params)
    if (next === 'users') p.delete('tab')
    else p.set('tab', next)
    setParams(p, { replace: true })
  }

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
              <Button variant="outline" size="sm" disabled={Boolean(disabledReason) || catalogRoles.length === 0} onClick={() => setRoleTarget(u)}>
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

  const pendingCount = (invitations.data ?? []).filter((i) => i.status === 'PENDING').length
  const managers = (data?.users ?? []).filter((u) => u.is_active).map((u) => ({ id: u.id, label: u.full_name ? `${u.full_name} (${u.email})` : u.email }))

  return (
    <>
      <PageHeader
        actions={
          <PermissionGate permission="users.manage">
            <Button onClick={() => setInviteOpen(true)} disabled={catalogRoles.length === 0}>
              {catalog.loading ? <Loader2 className="animate-spin" /> : <UserPlus />}
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
      {catalog.error && (
        <div role="alert" className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900">
          The role catalogue could not be loaded ({describeDataError(catalog.error)}). If this is a new deployment, apply migration
          20261116090000_user_invitations.sql.
        </div>
      )}

      <FilterTabs<Tab>
        className="mb-4"
        label="User management view"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'users', label: 'Users', count: data?.users.length },
          { value: 'invitations', label: 'Invitations', count: invitations.data ? pendingCount : undefined },
        ]}
      />

      {tab === 'users' ? (
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
              description: 'Invite staff members to give them access. New accounts have no access until they accept the invitation.',
            }}
          />

          <RolesCard roles={catalogRoles} loading={catalog.loading} />
        </div>
      ) : (
        <InvitationsPanel
          rows={invitations.data ?? []}
          loading={invitations.loading}
          error={invitations.error}
          onRetry={invitations.reload}
          timezone={timezone}
          onChanged={(n) => {
            setNotice(n)
            reloadAll()
          }}
          onEditRoles={(userId) => {
            const target = data?.users.find((u) => u.id === userId)
            if (target) setRoleTarget(target)
            else setNotice({ tone: 'error', text: 'This user is no longer in your company.' })
          }}
        />
      )}

      {roleTarget && (
        <RolesDialog
          target={roleTarget}
          catalog={catalogRoles}
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
            reloadAll()
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
        <InviteUserDialog
          catalog={catalogRoles}
          managers={managers}
          onClose={() => setInviteOpen(false)}
          onInvited={(result) => {
            setInviteOpen(false)
            setNotice({
              tone: 'success',
              text: result.duplicate
                ? `This invitation to ${result.email} was already sent; nothing new was sent.`
                : result.delivery === 'PASSWORD_LINK'
                  ? `${result.email} already has an account. A password-setup link was sent; they join your company after activating.`
                  : `Invitation sent to ${result.email}. They join your company after opening the link and setting a password.`,
            })
            reloadAll()
            setTab('invitations')
          }}
        />
      )}
    </>
  )
}

function RolesCard({ roles, loading }: { roles: CatalogRole[]; loading: boolean }) {
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
          <div className="space-y-4">
            {groupRoles(roles).map((g) => (
              <div key={g.category}>
                <p className="mb-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{g.category}</p>
                <ul className="space-y-2.5">
                  {g.roles.map((role) => (
                    <li key={role.id} className="flex gap-3">
                      <ShieldCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                      <div>
                        <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                          {role.name}
                          {role.is_admin && <AdminBadge />}
                        </p>
                        {role.description && <p className="text-sm text-muted-foreground">{role.description}</p>}
                        <p className="text-xs text-muted-foreground">{role.permissions.length} permissions</p>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function RolesDialog({
  target,
  catalog,
  onClose,
  onSave,
}: {
  target: CompanyUser
  catalog: CatalogRole[]
  onClose: () => void
  onSave: (grantRoleIds: string[], revokeAssignmentIds: string[]) => Promise<void>
}) {
  const [selected, setSelected] = useState(() => target.roles.map((r) => r.roleId))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const current = new Set(target.roles.map((r) => r.roleId))
  const chosen = new Set(selected)
  const grants = selected.filter((id) => !current.has(id))
  const revokes = target.roles.filter((r) => !chosen.has(r.roleId)).map((r) => r.assignmentId)
  const unchanged = grants.length === 0 && revokes.length === 0

  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Roles for {target.full_name || target.email}</DialogTitle>
          <DialogDescription>Changes take effect immediately and are recorded in the audit log.</DialogDescription>
        </DialogHeader>
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
        <RolePicker
          idPrefix="edit-role"
          catalog={catalog}
          selected={selected}
          onToggle={(roleId, on) => setSelected((prev) => (on ? [...new Set([...prev, roleId])] : prev.filter((x) => x !== roleId)))}
          onClear={() => setSelected([])}
        />
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            disabled={unchanged || saving || selected.length === 0}
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
