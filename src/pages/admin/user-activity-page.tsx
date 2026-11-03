import { Loader2, LogOut, ShieldAlert, UserCheck, Users, UserX } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'

import { ROLE_LABELS } from '@/auth/permissions'
import { useAuth } from '@/auth/use-auth'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import { fetchUserActivity, fetchUserActivityDetail, revokeSessions, type UserActivity } from '@/services/admin'
import { setUserActive } from '@/services/users'

const roleLabel = (r: string) => ROLE_LABELS[r as keyof typeof ROLE_LABELS] ?? r
const actionLabel = (a: string) => a.replace(/[._]/g, ' ')

function Detail({ user, isSelf, onChanged }: { user: UserActivity; isSelf: boolean; onChanged: (m: string) => void }) {
  const detail = useAsync(() => fetchUserActivityDetail(user.user_id), [user.user_id])
  const [toggle, setToggle] = useState(false)
  const [revoking, setRevoking] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const signIn = user.auth_last_sign_in_at ?? null

  const revoke = async () => {
    setBusy(true); setError(null)
    try {
      const r = await revokeSessions(user.user_id, reason.trim())
      setRevoking(false)
      onChanged(r.revoked ? `${r.sessions ?? 0} session(s) of ${user.name} ended. Their current access token stays valid until it expires (normally within an hour); deactivating the user blocks access immediately.`
        : `Sessions could not be revoked: ${r.reason ?? 'not supported by this server'}. Deactivate the user to block access.`)
    } catch (e) { setError(describeDataError(e)) } finally { setBusy(false) }
  }

  return (
    <Card>
      <CardHeader><div><CardTitle>{user.name}</CardTitle><CardDescription>{user.email} · {user.roles.map(roleLabel).join(', ') || 'no role'}</CardDescription></div></CardHeader>
      <CardContent className="space-y-4 text-sm">
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-red-800">{error}</p>}
        <dl className="grid gap-2 sm:grid-cols-2">
          <div><dt className="text-xs text-muted-foreground">Status</dt><dd>{user.is_active ? 'Active' : 'Inactive'}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Last sign-in (Supabase Auth)</dt><dd>{signIn ? formatDateTime(signIn) : 'Not available'}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Last recorded action</dt><dd>{user.last_activity_at ? formatDateTime(user.last_activity_at) : 'None recorded'}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Last 30 days</dt><dd>{user.actions_30d} actions · {user.denied_30d} denied</dd></div>
        </dl>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" disabled={isSelf} title={isSelf ? 'You cannot deactivate yourself' : undefined} onClick={() => setToggle(true)}>{user.is_active ? <UserX /> : <UserCheck />} {user.is_active ? 'Deactivate' : 'Activate'}</Button>
          <Button variant="outline" size="sm" onClick={() => { setReason(''); setRevoking(true) }}><LogOut /> End sessions</Button>
          <Button variant="ghost" size="sm" asChild><Link to="/users">Change roles in Users</Link></Button>
        </div>
        {detail.loading ? <LoadingState variant="table" rows={3} /> : detail.error ? <ErrorState message={describeDataError(detail.error)} onRetry={detail.reload} /> : detail.data && <>
          <div><p className="mb-1 text-xs font-semibold text-muted-foreground uppercase">Security events</p>
            {!detail.data.security_events.length ? <p className="text-muted-foreground">None recorded.</p> : (
              <ul className="space-y-0.5">{detail.data.security_events.map((e, i) => <li key={i}><ShieldAlert className="inline size-3 text-amber-700" /> {formatDateTime(e.at)} — {actionLabel(e.action)}{e.by ? ` (by ${e.by})` : ''}</li>)}</ul>)}</div>
          <div><p className="mb-1 text-xs font-semibold text-muted-foreground uppercase">Recent actions</p>
            {!detail.data.actions.length ? <p className="text-muted-foreground">None recorded.</p> : (
              <ul className="max-h-72 space-y-0.5 overflow-y-auto">{detail.data.actions.map((a, i) => <li key={i} className="text-xs">{formatDateTime(a.at)} — {actionLabel(a.action)} <span className="text-muted-foreground">{a.resource_type}</span></li>)}</ul>)}</div>
        </>}
        <p className="text-xs text-muted-foreground">Passwords, tokens and other sign-in secrets are never shown. Activity comes from the audit log.</p>
      </CardContent>
      <ConfirmDialog open={toggle} onOpenChange={setToggle} title={user.is_active ? `Deactivate ${user.name}?` : `Activate ${user.name}?`} destructive={user.is_active}
        confirmLabel={user.is_active ? 'Deactivate' : 'Activate'}
        description={user.is_active ? 'They lose access to company data immediately. The last active Super Admin cannot be deactivated.' : 'They regain access with their existing roles.'}
        onConfirm={() => { setToggle(false); setUserActive(user.user_id, !user.is_active).then(() => onChanged(`${user.name} ${user.is_active ? 'deactivated' : 'activated'}.`), (e) => setError(describeDataError(e))) }} />
      {revoking && (
        <Dialog open onOpenChange={(o) => !o && !busy && setRevoking(false)}>
          <DialogContent>
            <DialogHeader><DialogTitle>End all sessions of {user.name}?</DialogTitle>
              <DialogDescription>Signs them out on every device when their access token next refreshes. It does not change their password or roles.</DialogDescription></DialogHeader>
            <div className="space-y-1"><Label htmlFor="ua-reason">Reason</Label><Textarea id="ua-reason" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} /></div>
            <DialogFooter><Button variant="outline" disabled={busy} onClick={() => setRevoking(false)}>Cancel</Button>
              <Button variant="destructive" disabled={busy || reason.trim().length < 3} onClick={() => void revoke()}>{busy && <Loader2 className="animate-spin" />} End sessions</Button></DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </Card>
  )
}

export default function UserActivityPage() {
  const { user: me } = useAuth()
  const [refresh, setRefresh] = useState(0)
  const list = useAsync(fetchUserActivity, [refresh])
  const [selected, setSelected] = useState<string | null>(null)
  const [term, setTerm] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const users = (list.data?.users ?? []).filter((u) => !term.trim() || `${u.name} ${u.email}`.toLowerCase().includes(term.trim().toLowerCase()))
  const current = list.data?.users.find((u) => u.user_id === selected) ?? null
  return (
    <>
      <PageHeader />
      {message && <p role="status" className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-800">{message}</p>}
      <div className="grid gap-6 xl:grid-cols-5">
        <Card className="xl:col-span-3"><CardContent className="space-y-3 p-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-56 flex-1 space-y-1"><Label htmlFor="ua-search">Search</Label><Input id="ua-search" value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Name or email" /></div>
            {list.data && !list.data.auth_sign_in_available && <p className="pb-2 text-xs text-muted-foreground">Sign-in times are not available from this server; only recorded actions are shown.</p>}
          </div>
          {list.loading && !list.data ? <LoadingState variant="table" rows={6} /> : list.error ? <ErrorState message={describeDataError(list.error)} onRetry={list.reload} />
            : !users.length ? <EmptyState icon={Users} title="No users" description="No users match." /> : (
              <div className="overflow-x-auto rounded-lg border">
                <table className="w-full text-sm">
                  <thead className="bg-surface-muted/50 text-left text-xs text-muted-foreground"><tr><th className="px-3 py-2">User</th><th className="px-3 py-2">Roles</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Last sign-in</th><th className="px-3 py-2">Last action</th><th className="px-3 py-2 text-right">30-day actions</th><th className="px-3 py-2 text-right">Denied</th></tr></thead>
                  <tbody className="divide-y">{users.map((u) => (
                    <tr key={u.user_id} className={`cursor-pointer hover:bg-surface-muted/40 ${u.user_id === selected ? 'bg-primary/5' : ''}`} onClick={() => setSelected(u.user_id)}>
                      <td className="px-3 py-2"><button type="button" className="text-left font-medium text-primary hover:underline" onClick={() => setSelected(u.user_id)}>{u.name}</button><div className="text-xs text-muted-foreground">{u.email}</div></td>
                      <td className="px-3 py-2 text-xs">{u.roles.map(roleLabel).join(', ') || '—'}</td>
                      <td className="px-3 py-2"><StatusBadge label={u.is_active ? 'Active' : 'Inactive'} tone={u.is_active ? 'success' : 'neutral'} /></td>
                      <td className="px-3 py-2 text-xs">{u.auth_last_sign_in_at ? formatDateTime(u.auth_last_sign_in_at) : '—'}</td>
                      <td className="px-3 py-2 text-xs">{u.last_activity_at ? formatDateTime(u.last_activity_at) : '—'}</td>
                      <td className="px-3 py-2 text-right">{u.actions_30d}</td>
                      <td className={`px-3 py-2 text-right ${u.denied_30d ? 'font-medium text-shortage' : ''}`}>{u.denied_30d}</td>
                    </tr>))}</tbody>
                </table>
              </div>
            )}
        </CardContent></Card>
        <div className="xl:col-span-2">
          {current ? <Detail key={current.user_id} user={current} isSelf={current.user_id === me?.id} onChanged={(m) => { setMessage(m); setRefresh((n) => n + 1) }} />
            : <Card><CardContent className="p-6"><EmptyState icon={Users} title="Select a user" description="See their recent actions and security events, and manage access." /></CardContent></Card>}
        </div>
      </div>
    </>
  )
}
