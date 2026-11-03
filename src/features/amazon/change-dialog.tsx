import { Loader2 } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import type { AmazonSettings } from '@/features/amazon/analysis'
import { money } from '@/features/amazon/format'
import type { SuggestedChange } from '@/features/amazon/recommendations'
import { describeDataError } from '@/lib/errors'
import { requestChange } from '@/services/amazon'

export interface ChangeTarget {
  campaignId: string
  campaignName: string
  dailyBudget: number | null
  state: string
  targets: { target_id: string; expression: string; match_type: string | null; bid: number | null; ad_group_id: string | null; target_type: string }[]
  adGroups: { ad_group_id: string; name: string }[]
}

/**
 * Proposes ONE change for approval. Nothing is sent to Amazon from here: the
 * request needs approval by a different person, then explicit execution, and
 * the server re-checks limits and the current value at every step.
 */
export function ChangeRequestDialog({ target, settings, initial, recommendationId, reason: initialReason, onClose, onDone }: {
  target: ChangeTarget
  settings: AmazonSettings
  initial?: SuggestedChange | null
  recommendationId?: string | null
  reason?: string
  onClose: () => void
  onDone: (message: string) => void
}) {
  const [type, setType] = useState<SuggestedChange['change_type']>(initial?.change_type ?? 'CAMPAIGN_BUDGET')
  const [budget, setBudget] = useState(String(initial?.daily_budget ?? target.dailyBudget ?? ''))
  const [state, setState] = useState(initial?.state ?? (target.state === 'ENABLED' ? 'PAUSED' : 'ENABLED'))
  const [targetId, setTargetId] = useState(initial?.target_id ?? target.targets.find((t) => t.target_type === 'KEYWORD')?.target_id ?? '')
  const [bid, setBid] = useState(String(initial?.bid ?? ''))
  const [keyword, setKeyword] = useState(initial?.keyword ?? '')
  const [adGroup, setAdGroup] = useState(initial?.ad_group_id ?? target.adGroups[0]?.ad_group_id ?? '')
  const [reason, setReason] = useState(initialReason ?? '')
  const [impact, setImpact] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const selectedTarget = target.targets.find((t) => t.target_id === targetId)

  const submit = async () => {
    setError(null)
    if (reason.trim().length < 5) return setError('Explain the reason (at least 5 characters).')
    const change: Record<string, unknown> = { change_type: type, campaign_id: target.campaignId, reason: reason.trim(), expected_impact: impact.trim() || null, recommendation_id: recommendationId ?? null }
    if (type === 'CAMPAIGN_BUDGET') change.daily_budget = Number(budget)
    if (type === 'CAMPAIGN_STATE') change.state = state
    if (type === 'TARGET_BID') Object.assign(change, { target_id: targetId, bid: Number(bid) })
    if (type === 'NEGATIVE_KEYWORD') Object.assign(change, { keyword, match_type: 'NEGATIVE_EXACT', ad_group_id: adGroup })
    setBusy(true)
    try {
      await requestChange(change)
      onDone('Change request submitted for approval. Nothing has been sent to Amazon.')
    } catch (e) {
      setError(describeDataError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader><DialogTitle>Propose an advertising change</DialogTitle>
          <DialogDescription>{target.campaignName}. A different person with approval rights must approve it, and execution is refused while automation is read-only or the kill switch is on.</DialogDescription></DialogHeader>
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
        <div className="space-y-3 text-sm">
          <div className="space-y-1"><Label htmlFor="cr-type">Change</Label>
            <Select value={type} onValueChange={(v) => setType(v as SuggestedChange['change_type'])}><SelectTrigger id="cr-type"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="CAMPAIGN_BUDGET">Daily budget</SelectItem><SelectItem value="CAMPAIGN_STATE">Campaign state</SelectItem>
                <SelectItem value="TARGET_BID" disabled={!target.targets.some((t) => t.bid !== null)}>Keyword / target bid</SelectItem><SelectItem value="NEGATIVE_KEYWORD">Negative keyword</SelectItem></SelectContent></Select></div>
          {type === 'CAMPAIGN_BUDGET' && <div className="space-y-1"><Label htmlFor="cr-budget">New daily budget (current {money(target.dailyBudget, true) ?? 'unknown'})</Label>
            <Input id="cr-budget" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} />
            <p className="text-xs text-muted-foreground">Limits: max daily {money(settings.max_daily_budget) ?? 'not set'}, max monthly {money(settings.max_monthly_budget) ?? 'not set'}, max change {settings.max_budget_change_pct}% per request.</p></div>}
          {type === 'CAMPAIGN_STATE' && <div className="space-y-1"><Label htmlFor="cr-state">New state (current {target.state})</Label>
            <Select value={state} onValueChange={setState}><SelectTrigger id="cr-state"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="ENABLED">Enabled</SelectItem><SelectItem value="PAUSED">Paused</SelectItem></SelectContent></Select></div>}
          {type === 'TARGET_BID' && <>
            <div className="space-y-1"><Label htmlFor="cr-target">Keyword / target</Label>
              <Select value={targetId} onValueChange={setTargetId}><SelectTrigger id="cr-target"><SelectValue placeholder="Choose" /></SelectTrigger>
                <SelectContent className="max-h-72">{target.targets.filter((t) => t.bid !== null).map((t) => <SelectItem key={t.target_id} value={t.target_id}>{t.expression} {t.match_type ? `(${t.match_type})` : ''} — bid {money(t.bid, true)}</SelectItem>)}</SelectContent></Select></div>
            <div className="space-y-1"><Label htmlFor="cr-bid">New bid (current {money(selectedTarget?.bid ?? null, true) ?? 'unknown'})</Label><Input id="cr-bid" inputMode="decimal" value={bid} onChange={(e) => setBid(e.target.value)} />
              <p className="text-xs text-muted-foreground">Limits: max bid {money(settings.max_bid, true) ?? 'not set'}, max change {settings.max_bid_change_pct}% per request.</p></div>
          </>}
          {type === 'NEGATIVE_KEYWORD' && <>
            <div className="space-y-1"><Label htmlFor="cr-kw">Negative keyword (exact)</Label><Input id="cr-kw" maxLength={80} value={keyword} onChange={(e) => setKeyword(e.target.value)} /></div>
            <div className="space-y-1"><Label htmlFor="cr-ag">Ad group</Label>
              <Select value={adGroup} onValueChange={setAdGroup}><SelectTrigger id="cr-ag"><SelectValue placeholder="Choose" /></SelectTrigger>
                <SelectContent>{target.adGroups.map((g) => <SelectItem key={g.ad_group_id} value={g.ad_group_id}>{g.name}</SelectItem>)}</SelectContent></Select></div>
            <p className="text-xs text-muted-foreground">Review relevance first: a negative keyword stops the campaign showing for that search term.</p>
          </>}
          <div className="space-y-1"><Label htmlFor="cr-reason">Reason (shown to the approver)</Label><Textarea id="cr-reason" rows={3} maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="cr-impact">Expected impact (optional)</Label><Input id="cr-impact" maxLength={500} value={impact} onChange={(e) => setImpact(e.target.value)} placeholder="Direction and evidence, not a promise" /></div>
        </div>
        <DialogFooter><Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button><Button disabled={busy} onClick={() => void submit()}>{busy && <Loader2 className="animate-spin" />} Submit for approval</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
