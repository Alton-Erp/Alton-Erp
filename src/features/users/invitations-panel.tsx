import { Ban, Eye, Loader2, MailWarning, RefreshCw, UserCog } from 'lucide-react'
import { useState } from 'react'

import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { FilterTabs } from '@/components/common/filter-tabs'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { canResend, canRevoke, STATUS_TONE, type InvitationRow, type InvitationStatus } from '@/features/users/invitation-model'
import { describeDataError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import { InviteServiceError, resendInvitation, revokeInvitation } from '@/services/users'

type Filter = 'ALL' | InvitationStatus
const LABEL: Record<InvitationStatus, string> = { PENDING: 'Pending', ACCEPTED: 'Accepted', EXPIRED: 'Expired', REVOKED: 'Revoked', FAILED: 'Failed' }
const EMAIL_LABEL = { SENDING: 'Sending', SENT: 'Sent', FAILED: 'Failed' } as const
const errorText = (err: unknown) => (err instanceof InviteServiceError ? err.message : describeDataError(err))

export function InvitationsPanel({
  rows,
  loading,
  error,
  onRetry,
  timezone,
  onChanged,
  onEditRoles,
}: {
  rows: InvitationRow[]
  loading: boolean
  error: unknown
  onRetry: () => void
  timezone?: string
  onChanged: (notice: { tone: 'success' | 'error'; text: string }) => void
  onEditRoles: (userId: string) => void
}) {
  const [filter, setFilter] = useState<Filter>('ALL')
  const [busy, setBusy] = useState<string | null>(null)
  const [details, setDetails] = useState<InvitationRow | null>(null)
  const [revoking, setRevoking] = useState<InvitationRow | null>(null)

  const count = (s: InvitationStatus) => rows.filter((r) => r.status === s).length
  const shown = filter === 'ALL' ? rows : rows.filter((r) => r.status === filter)

  const resend = async (inv: InvitationRow) => {
    setBusy(inv.id)
    try {
      const result = await resendInvitation(inv.id)
      onChanged({ tone: 'success', text: result.duplicate ? `The invitation to ${inv.email} was already resent.` : `Invitation resent to ${inv.email}. The new link replaces the old one.` })
    } catch (err) {
      onChanged({ tone: 'error', text: errorText(err) })
    } finally {
      setBusy(null)
    }
  }

  const columns: DataTableColumn<InvitationRow>[] = [
    {
      id: 'name', header: 'Employee Name',
      cell: (i) => (
        <div className="min-w-0">
          <p className="font-medium">{i.full_name}</p>
          {(i.designation || i.employee_id) && <p className="text-xs text-muted-foreground">{[i.designation, i.employee_id].filter(Boolean).join(' · ')}</p>}
        </div>
      ),
      searchValue: (i) => `${i.full_name} ${i.employee_id ?? ''} ${i.department ?? ''}`,
      sortValue: (i) => i.full_name,
    },
    { id: 'email', header: 'Email', cell: (i) => <span className="break-all">{i.email}</span>, searchValue: (i) => i.email },
    {
      id: 'roles', header: 'Assigned Roles',
      cell: (i) => <div className="flex flex-wrap gap-1">{(i.roles ?? []).map((r) => <StatusBadge key={r.id} label={r.name} tone="info" />)}</div>,
      searchValue: (i) => (i.roles ?? []).map((r) => r.name).join(' '),
    },
    { id: 'invited', header: 'Invitation Date', cell: (i) => <span className="text-muted-foreground">{formatDateTime(i.invited_at, timezone)}</span>, sortValue: (i) => i.invited_at },
    { id: 'by', header: 'Invited By', cell: (i) => i.invited_by ?? '—', searchValue: (i) => i.invited_by ?? '' },
    {
      id: 'expiry', header: 'Expiry',
      cell: (i) => <span className="text-muted-foreground">{i.status === 'ACCEPTED' ? '—' : formatDateTime(i.expires_at, timezone)}</span>,
      sortValue: (i) => i.expires_at,
    },
    { id: 'status', header: 'Invitation Status', cell: (i) => <StatusBadge label={LABEL[i.status]} tone={STATUS_TONE[i.status]} /> },
    {
      id: 'email_status', header: 'Email Status',
      cell: (i) => (
        <span title={i.email_error ?? undefined} className="inline-flex items-center gap-1">
          <StatusBadge label={EMAIL_LABEL[i.email_status]} tone={i.email_status === 'SENT' ? 'success' : i.email_status === 'FAILED' ? 'danger' : 'warning'} />
          {i.email_status === 'FAILED' && <MailWarning aria-label="Delivery error" className="size-4 text-red-700" />}
        </span>
      ),
    },
    {
      id: 'actions', header: 'Actions', align: 'right',
      cell: (i) => (
        <div className="flex justify-end gap-1.5">
          {canResend(i) && (
            <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void resend(i)}>
              {busy === i.id ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              Resend
            </Button>
          )}
          {canRevoke(i) && (
            <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => setRevoking(i)}>
              <Ban />
              Revoke
            </Button>
          )}
          {i.status === 'ACCEPTED' && i.user_id && (
            <Button variant="outline" size="sm" onClick={() => onEditRoles(i.user_id ?? '')}>
              <UserCog />
              Edit roles
            </Button>
          )}
          <Button variant="ghost" size="sm" aria-label={`View details for ${i.email}`} onClick={() => setDetails(i)}>
            <Eye />
            Details
          </Button>
        </div>
      ),
    },
  ]

  return (
    <>
      <DataTable
        title="Invitations"
        description="Every invitation sent from this company, with its activation and e-mail status"
        columns={columns}
        data={shown}
        getRowId={(i) => i.id}
        searchPlaceholder="Search name, e-mail or role…"
        loading={loading}
        error={error ? new Error(describeDataError(error)) : null}
        onRetry={onRetry}
        toolbar={
          <FilterTabs<Filter>
            label="Invitation status"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'ALL', label: 'All', count: rows.length },
              ...(['PENDING', 'ACCEPTED', 'EXPIRED', 'REVOKED', 'FAILED'] as const).map((s) => ({ value: s, label: LABEL[s], count: count(s) })),
            ]}
          />
        }
        emptyState={{ icon: MailWarning, title: rows.length === 0 ? 'No invitations yet' : 'No invitations match', description: 'Use Invite User to invite staff by e-mail.' }}
      />

      {details && <DetailsDialog inv={details} timezone={timezone} onClose={() => setDetails(null)} />}
      {revoking && (
        <RevokeDialog
          inv={revoking}
          onClose={() => setRevoking(null)}
          onRevoked={(text) => {
            setRevoking(null)
            onChanged({ tone: 'success', text })
          }}
        />
      )}
    </>
  )
}

function DetailsDialog({ inv, timezone, onClose }: { inv: InvitationRow; timezone?: string; onClose: () => void }) {
  const rows: [string, string | null | undefined][] = [
    ['Employee', inv.full_name], ['E-mail', inv.email], ['Employee ID', inv.employee_id], ['Department', inv.department],
    ['Designation', inv.designation], ['Reporting manager', inv.reporting_manager],
    ['Roles', (inv.roles ?? []).map((r) => r.name).join(', ')], ['Status', LABEL[inv.status]],
    ['E-mail status', `${EMAIL_LABEL[inv.email_status]}${inv.email_error ? ` — ${inv.email_error}` : ''}`],
    ['Delivery', inv.delivery_method === 'PASSWORD_LINK' ? 'Password link to an existing account' : 'Supabase Auth invitation'],
    ['Invited', `${formatDateTime(inv.invited_at, timezone)} by ${inv.invited_by ?? '—'}`],
    ['Times sent', String(inv.send_count)], ['Last sent', inv.last_sent_at ? formatDateTime(inv.last_sent_at, timezone) : null],
    ['Expires', formatDateTime(inv.expires_at, timezone)], ['Accepted', inv.accepted_at ? formatDateTime(inv.accepted_at, timezone) : null],
    ['Revoked', inv.revoked_at ? `${formatDateTime(inv.revoked_at, timezone)} by ${inv.revoked_by ?? '—'}` : null], ['Revoke reason', inv.revoke_reason],
  ]
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Invitation details</DialogTitle>
          <DialogDescription>Invitation links are never stored or shown; use Resend to send a new one.</DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
          {rows.filter(([, v]) => v).map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="break-words">{v}</dd>
            </div>
          ))}
        </dl>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function RevokeDialog({ inv, onClose, onRevoked }: { inv: InvitationRow; onClose: () => void; onRevoked: (text: string) => void }) {
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async () => {
    if (reason.trim().length < 3) return setError('Give a short reason (at least 3 characters).')
    setSaving(true)
    setError(null)
    try {
      await revokeInvitation(inv.id, reason)
      onRevoked(`The invitation to ${inv.email} was revoked. The link no longer works.`)
    } catch (err) {
      setError(errorText(err))
      setSaving(false)
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && !saving && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Revoke invitation?</DialogTitle>
          <DialogDescription>
            {inv.full_name} ({inv.email}) will not be able to activate the account. Roles prepared for them are removed. This is recorded in the audit log.
          </DialogDescription>
        </DialogHeader>
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
        <div className="space-y-1.5">
          <Label htmlFor="revoke-reason">Reason</Label>
          <Textarea id="revoke-reason" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button variant="destructive" onClick={() => void submit()} disabled={saving}>
            {saving && <Loader2 className="animate-spin" />}
            Revoke invitation
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
