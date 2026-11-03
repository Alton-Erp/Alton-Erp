import { Check, Loader2, Play, ShieldAlert, Sparkles, X } from 'lucide-react'
import { useState } from 'react'

import { useAuth } from '@/auth/use-auth'
import { usePermissions } from '@/auth/use-permissions'
import { ErrorState } from '@/components/common/error-state'
import { FilterTabs } from '@/components/common/filter-tabs'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { AmazonToolbar, DemoBanner } from '@/features/amazon/amazon-ui'
import { ChangeRequestDialog, type ChangeTarget } from '@/features/amazon/change-dialog'
import { CONFIDENCE_TONE, money } from '@/features/amazon/format'
import { generateRecommendations } from '@/features/amazon/recommendations'
import { isEmptyDataset, useAmazonDataset, useAmazonView, type AmazonDataset } from '@/features/amazon/use-amazon'
import { SelectFilter } from '@/features/analytics/analytics-ui'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import {
  cancelChange, decideChange, EdgeUnavailableError, fetchCampaignDetail, fetchChangeRequests, fetchRecommendations, fetchSearchTerms, invokeAmazon, saveRecommendations,
  setRecommendationStatus, type ChangeRequest, type StoredRecommendation,
} from '@/services/amazon'

const IMPACT: Record<string, string> = {
  INCREASE_CONTRIBUTION: 'Increase contribution', REDUCE_WASTE: 'Reduce wasted spend', PROTECT_STOCK: 'Protect stock', GROW_SALES: 'Grow sales', IMPROVE_DATA: 'Improve data', NONE: '-',
}
const REQ_TONE: Record<ChangeRequest['status'], 'warning' | 'info' | 'neutral' | 'danger' | 'success'> = {
  PENDING_APPROVAL: 'warning', APPROVED: 'info', REJECTED: 'neutral', CANCELLED: 'neutral', EXECUTING: 'info', SUCCEEDED: 'success', FAILED: 'danger',
}
const show = (v: Record<string, unknown>) => Object.entries(v).map(([k, x]) => `${k.replace(/_/g, ' ')}: ${typeof x === 'number' && /budget|bid/.test(k) ? money(x, true) : String(x)}`).join(', ')

export default function AmazonRecommendationsPage() {
  const { view, setPreset, setRange, setMode, demo } = useAmazonView()
  const [tab, setTab] = useState<'recs' | 'changes'>('recs')
  const [refresh, setRefresh] = useState(0)
  const data = useAmazonDataset(view, { campaigns: true, refresh })
  return (
    <>
      <PageHeader />
      <AmazonToolbar view={view} setPreset={setPreset} setRange={setRange} setMode={setMode} loading={data.loading} onRefresh={() => setRefresh((n) => n + 1)} />
      <DemoBanner demo={demo} />
      <FilterTabs className="mb-4" label="Recommendations view" value={tab} onChange={setTab} options={[{ value: 'recs', label: 'Recommendations' }, { value: 'changes', label: 'Change approvals' }]} />
      {tab === 'recs' ? <RecommendationsTab dataset={data.data} loading={data.loading} error={data.error} demo={demo} from={view.from} to={view.to} refresh={refresh} />
        : <ChangesTab demo={demo} settings={data.data?.settings} refresh={refresh} />}
    </>
  )
}

function RecommendationsTab({ dataset, loading, error, demo, from, to, refresh }: { dataset?: AmazonDataset; loading: boolean; error: unknown; demo: boolean; from: string; to: string; refresh: number }) {
  const { has } = usePermissions()
  const [reload, setReload] = useState(0)
  const recs = useAsync(() => fetchRecommendations(demo), [demo, refresh, reload])
  const [status, setStatus] = useState<string | null>('OPEN')
  const [conf, setConf] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [dismissing, setDismissing] = useState<StoredRecommendation | null>(null)
  const [proposal, setProposal] = useState<{ rec: StoredRecommendation; target: ChangeTarget } | null>(null)

  const generate = async () => {
    if (!dataset) return
    setBusy(true); setErr(null); setMessage(null)
    try {
      const terms = await fetchSearchTerms(from, to, demo, { limit: 5000 })
      const out = generateRecommendations({ from, to, today: dataset.today, settings: dataset.settings, products: dataset.products, campaigns: dataset.campaigns,
        searchTerms: terms.rows, dataStatus: dataset.status, demo })
      const r = await saveRecommendations(out.items, demo)
      setWarnings(out.warnings)
      setMessage(`${r.saved} recommendation(s) generated for ${from} to ${to}${r.superseded ? `; ${r.superseded} older one(s) superseded` : ''}.`)
      setReload((n) => n + 1)
    } catch (e) { setErr(describeDataError(e)) } finally { setBusy(false) }
  }
  const setRecStatus = async (r: StoredRecommendation, s: 'ACCEPTED' | 'DISMISSED' | 'OPEN', note?: string) => {
    setErr(null)
    try { await setRecommendationStatus(r.id, s, note); setDismissing(null); setReload((n) => n + 1) } catch (e) { setErr(describeDataError(e)) }
  }
  const propose = async (r: StoredRecommendation) => {
    const ch = r.financial.change
    if (!ch) return
    setErr(null)
    try {
      const det = await fetchCampaignDetail(ch.campaign_id, r.period_from, r.period_to, demo)
      setProposal({ rec: r, target: { campaignId: det.campaign.campaign_id, campaignName: det.campaign.name, dailyBudget: det.campaign.daily_budget, state: det.campaign.state,
        targets: det.targets, adGroups: det.ad_groups.map((g) => ({ ad_group_id: g.ad_group_id, name: g.name })) } })
    } catch (e) { setErr(describeDataError(e)) }
  }

  const list = (recs.data ?? []).filter((r) => (!status || r.status === status) && (!conf || r.confidence === conf))
  return (
    <div className="space-y-4">
      <Card><CardContent className="flex flex-wrap items-end gap-3 p-4 text-sm">
        <SelectFilter id="rec-status" label="Status" value={status} onChange={setStatus}
          options={['OPEN', 'ACCEPTED', 'DISMISSED', 'EXECUTED', 'SUPERSEDED'].map((s) => ({ value: s, label: s.toLowerCase() }))} />
        <SelectFilter id="rec-conf" label="Confidence" value={conf} onChange={setConf} options={['HIGH', 'MEDIUM', 'LOW'].map((s) => ({ value: s, label: s.toLowerCase() }))} />
        {has('amazon.manage') && <Button className="ml-auto" disabled={busy || loading || !dataset || isEmptyDataset(dataset)} onClick={() => void generate()}>
          {busy ? <Loader2 className="animate-spin" /> : <Sparkles />} Analyse {from} to {to}</Button>}
        <p className="basis-full text-xs text-muted-foreground">Transparent rules (no black box): each item shows its evidence, calculation, confidence and missing data. Thresholds are set in API Integration Settings.
          Recommendations never change campaigns; a proposed change needs approval by a second person.</p>
      </CardContent></Card>
      {message && <p role="status" className="rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-800">{message}</p>}
      {warnings.length > 0 && <ul className="list-disc rounded-lg border border-amber-300 bg-amber-50 py-2.5 pr-4 pl-8 text-sm text-amber-900">{warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
      {(err || Boolean(error)) && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800">{err ?? describeDataError(error)}</p>}
      {recs.loading && !recs.data ? <LoadingState variant="table" rows={6} /> : recs.error ? <ErrorState message={describeDataError(recs.error)} onRetry={recs.reload} />
        : !list.length ? <Card><CardContent className="p-6 text-sm text-muted-foreground">No recommendations{status ? ` with status ${status.toLowerCase()}` : ''}. {has('amazon.manage') ? 'Run the analysis for the selected period.' : ''}</CardContent></Card>
          : list.map((r) => (
            <Card key={r.id}><CardContent className="space-y-2 p-4 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-semibold">{r.title}</p>
                <StatusBadge label={`${r.confidence} confidence`} tone={CONFIDENCE_TONE[r.confidence]} />
                <StatusBadge label={IMPACT[r.impact_direction] ?? r.impact_direction} tone="info" />
                <StatusBadge label={r.status.toLowerCase()} tone={r.status === 'OPEN' ? 'warning' : 'neutral'} />
                <span className="ml-auto text-xs text-muted-foreground">{r.entity_label} · {r.period_from} to {r.period_to} · {r.rule_code}</span>
              </div>
              <p><span className="font-medium">Issue:</span> {r.issue}</p>
              <p><span className="font-medium">Proposed action:</span> {r.proposed_action}</p>
              <p className="text-muted-foreground"><span className="font-medium text-foreground">Calculation:</span> {r.financial.calculation}</p>
              {Object.keys(r.evidence).length > 0 && <p className="text-xs text-muted-foreground">Evidence: {Object.entries(r.evidence).map(([k, v]) => `${k.replace(/_/g, ' ')} ${v ?? 'n/a'}`).join(' · ')}</p>}
              {r.inventory_impact && <p className="text-xs">Stock: {r.inventory_impact}</p>}
              {r.missing_info.length > 0 && <p className="text-xs text-amber-800">Missing: {r.missing_info.join('; ')}</p>}
              {r.status_note && <p className="text-xs text-muted-foreground">Note: {r.status_note}</p>}
              <div className="flex flex-wrap gap-2 pt-1">
                {r.status === 'OPEN' && has('amazon.manage') && <>
                  <Button size="sm" variant="outline" onClick={() => void setRecStatus(r, 'ACCEPTED')}><Check /> Accept</Button>
                  <Button size="sm" variant="outline" onClick={() => setDismissing(r)}><X /> Dismiss</Button></>}
                {r.status === 'DISMISSED' && has('amazon.manage') && <Button size="sm" variant="ghost" onClick={() => void setRecStatus(r, 'OPEN')}>Reopen</Button>}
                {(r.status === 'OPEN' || r.status === 'ACCEPTED') && r.financial.change && has('amazon_ads.request') && !demo &&
                  <Button size="sm" onClick={() => void propose(r)}>Propose change for approval</Button>}
                {r.financial.change && demo && <span className="text-xs text-muted-foreground">Demo campaigns cannot be changed.</span>}
              </div>
            </CardContent></Card>
          ))}
      {dismissing && <DismissDialog onClose={() => setDismissing(null)} onConfirm={(note) => void setRecStatus(dismissing, 'DISMISSED', note)} />}
      {proposal && dataset && <ChangeRequestDialog target={proposal.target} settings={dataset.settings} initial={proposal.rec.financial.change} recommendationId={proposal.rec.id}
        reason={`${proposal.rec.title}. ${proposal.rec.financial.calculation}`} onClose={() => setProposal(null)}
        onDone={(m) => { setProposal(null); setMessage(m); void setRecStatus(proposal.rec, 'ACCEPTED') }} />}
    </div>
  )
}

function DismissDialog({ onClose, onConfirm }: { onClose: () => void; onConfirm: (note: string) => void }) {
  const [note, setNote] = useState('')
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent><DialogHeader><DialogTitle>Dismiss recommendation</DialogTitle><DialogDescription>The reason is kept with the recommendation and in the audit log.</DialogDescription></DialogHeader>
        <Textarea aria-label="Reason" rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button><Button disabled={note.trim().length < 3} onClick={() => onConfirm(note.trim())}>Dismiss</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ChangesTab({ demo, settings, refresh }: { demo: boolean; settings?: AmazonDataset['settings']; refresh: number }) {
  const { has } = usePermissions()
  const { user } = useAuth()
  const [reload, setReload] = useState(0)
  const reqs = useAsync(() => fetchChangeRequests(demo), [demo, refresh, reload])
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [deciding, setDeciding] = useState<{ req: ChangeRequest; action: 'APPROVE' | 'REJECT' | 'CANCEL' } | null>(null)
  const run = async (id: string, fn: () => Promise<string>) => {
    setBusy(id); setErr(null); setMessage(null)
    try { setMessage(await fn()); setReload((n) => n + 1) } catch (e) { setErr(e instanceof EdgeUnavailableError ? e.message : describeDataError(e)); setReload((n) => n + 1) } finally { setBusy(null) }
  }
  const execute = (r: ChangeRequest) => run(r.id, async () => {
    // A non-2xx answer (refused, or Amazon did not confirm) throws and is shown as an error; the request is then FAILED or unchanged.
    const res = await invokeAmazon<{ ok: boolean; status: string; request_id?: string | null; error?: string | null }>('amazon-ads', { action: 'execute_change', id: r.id })
    return res.ok ? `Amazon confirmed the change${res.request_id ? ` (request ${res.request_id})` : ''}.` : `Amazon did not confirm the change: ${res.error ?? res.status}.`
  })
  const canExecute = settings && settings.automation_mode === 'APPROVAL_REQUIRED' && !settings.kill_switch
  return (
    <div className="space-y-4">
      <Card><CardContent className="flex flex-wrap items-center gap-2 p-4 text-sm">
        <ShieldAlert className="size-4 text-muted-foreground" />
        <span>Automation: <strong>{settings?.automation_mode === 'APPROVAL_REQUIRED' ? 'approval required' : 'read-only'}</strong></span>
        <StatusBadge label={settings?.kill_switch ? 'Kill switch ON — no changes can be sent' : 'Kill switch off'} tone={settings?.kill_switch ? 'danger' : 'success'} />
        <span className="text-muted-foreground">Limits: daily budget {money(settings?.max_daily_budget ?? null) ?? 'none'}, monthly {money(settings?.max_monthly_budget ?? null) ?? 'none'}, bid {money(settings?.max_bid ?? null, true) ?? 'none'},
          change ≤ {settings?.max_budget_change_pct}% budget / {settings?.max_bid_change_pct}% bid.</span>
        <p className="basis-full text-xs text-muted-foreground">Flow: request → approval by a different person (limits and current value re-checked) → explicit execution through the Ads API. A change is shown as done only after Amazon confirms it.</p>
      </CardContent></Card>
      {message && <p role="status" className="rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-800">{message}</p>}
      {err && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800">{err}</p>}
      {reqs.loading && !reqs.data ? <LoadingState variant="table" rows={5} /> : reqs.error ? <ErrorState message={describeDataError(reqs.error)} onRetry={reqs.reload} />
        : !(reqs.data ?? []).length ? <Card><CardContent className="p-6 text-sm text-muted-foreground">No change requests.</CardContent></Card>
          : (reqs.data ?? []).map((r) => {
            const own = r.requested_by === user?.id
            return (
              <Card key={r.id}><CardContent className="space-y-1.5 p-4 text-sm">
                <div className="flex flex-wrap items-center gap-2"><p className="font-semibold">{r.change_type.replace(/_/g, ' ').toLowerCase()} — {r.entity_label}</p>
                  <StatusBadge label={r.status.replace(/_/g, ' ').toLowerCase()} tone={REQ_TONE[r.status]} />
                  <span className="ml-auto text-xs text-muted-foreground">Requested {formatDateTime(r.requested_at)}{own ? ' by you' : ''}</span></div>
                <p>From <strong>{show(r.old_value)}</strong> to <strong>{show(r.proposed_value)}</strong></p>
                <p className="text-muted-foreground">Reason: {r.reason}{r.expected_impact ? ` · Expected: ${r.expected_impact}` : ''}</p>
                {r.decided_at && <p className="text-xs text-muted-foreground">Decision {formatDateTime(r.decided_at)}{r.decision_note ? `: ${r.decision_note}` : ''}</p>}
                {r.executed_at && <p className="text-xs">Executed {formatDateTime(r.executed_at)}{r.api_request_id ? ` · Amazon request id ${r.api_request_id}` : ''}</p>}
                {r.error_message && <p className="text-xs text-shortage">Error: {r.error_message}</p>}
                {r.rollback_instructions && <p className="text-xs text-muted-foreground">Rollback: {r.rollback_instructions}</p>}
                <div className="flex flex-wrap gap-2 pt-1">
                  {r.status === 'PENDING_APPROVAL' && has('amazon_ads.approve') && !own && <>
                    <Button size="sm" disabled={busy === r.id} onClick={() => setDeciding({ req: r, action: 'APPROVE' })}><Check /> Approve</Button>
                    <Button size="sm" variant="outline" disabled={busy === r.id} onClick={() => setDeciding({ req: r, action: 'REJECT' })}><X /> Reject</Button></>}
                  {r.status === 'PENDING_APPROVAL' && own && <span className="text-xs text-muted-foreground">Waiting for another approver.</span>}
                  {(r.status === 'PENDING_APPROVAL' || r.status === 'APPROVED') && (own || has('amazon_ads.approve')) &&
                    <Button size="sm" variant="ghost" disabled={busy === r.id} onClick={() => setDeciding({ req: r, action: 'CANCEL' })}>Cancel request</Button>}
                  {r.status === 'APPROVED' && has('amazon_ads.approve') && (
                    <Button size="sm" disabled={busy === r.id || !canExecute || r.is_demo} title={!canExecute ? 'Set automation to approval-required and turn the kill switch off first' : undefined}
                      onClick={() => void execute(r)}>{busy === r.id ? <Loader2 className="animate-spin" /> : <Play />} Send to Amazon</Button>)}
                </div>
              </CardContent></Card>
            )
          })}
      {deciding && <DecisionDialog action={deciding.action} onClose={() => setDeciding(null)} onConfirm={(note) => {
        const { req, action } = deciding
        setDeciding(null)
        void run(req.id, async () => {
          if (action === 'CANCEL') { await cancelChange(req.id, note || 'Cancelled'); return 'Request cancelled.' }
          const res = await decideChange(req.id, action, note || null)
          return res.stale ? 'The current value on Amazon changed since the request: it was cancelled. Create a new request.' : action === 'APPROVE' ? 'Approved. It can now be sent to Amazon.' : 'Rejected.'
        })
      }} />}
    </div>
  )
}

function DecisionDialog({ action, onClose, onConfirm }: { action: 'APPROVE' | 'REJECT' | 'CANCEL'; onClose: () => void; onConfirm: (note: string) => void }) {
  const [note, setNote] = useState('')
  const title = action === 'APPROVE' ? 'Approve change' : action === 'REJECT' ? 'Reject change' : 'Cancel request'
  const needsNote = action !== 'APPROVE'
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent><DialogHeader><DialogTitle>{title}</DialogTitle>
        <DialogDescription>{action === 'APPROVE' ? 'Limits and the current value are re-checked now. Approval does not send anything to Amazon.' : 'Give a short reason.'}</DialogDescription></DialogHeader>
        <Textarea aria-label="Note" rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} placeholder={needsNote ? 'Reason' : 'Optional note'} />
        <DialogFooter><Button variant="outline" onClick={onClose}>Back</Button><Button disabled={needsNote && note.trim().length < 3} onClick={() => onConfirm(note.trim())}>{title}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
