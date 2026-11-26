import { Loader2 } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import {
  CLASSIFICATION_LABELS, COST_CENTRE_POLICY_LABELS, NATURE_LABELS, USER_NATURES, type Account, type AccountGroup, type AccountNature, type CostCentrePolicy, type NormalBalance,
} from '@/features/accounting/accounting-model'
import { SearchSelect } from '@/features/accounting/accounting-ui'
import { describeDataError } from '@/lib/errors'
import { saveAccount, saveGroup, setCostCentrePolicy } from '@/services/accounting'

const groupOptions = (groups: AccountGroup[], excludeId?: string) =>
  groups.filter((g) => g.is_active && g.id !== excludeId).map((g) => ({ value: g.id, label: `${g.group_name}`, hint: `${g.group_code} · ${CLASSIFICATION_LABELS[g.classification]}` }))

/** Create or edit a ledger account. System accounts: only name, description and group (same classification). */
export function AccountDialog({ account, groups, onClose, onSaved }: {
  account: Account | null; groups: AccountGroup[]; onClose: () => void; onSaved: (message: string) => void
}) {
  const editing = Boolean(account)
  const [code, setCode] = useState(account?.account_code ?? '')
  const [name, setName] = useState(account?.account_name ?? '')
  const [groupId, setGroupId] = useState(account?.group_id ?? '')
  const [nature, setNature] = useState<AccountNature>(account?.account_nature ?? 'GENERAL')
  const [normal, setNormal] = useState<NormalBalance | ''>(account?.normal_balance ?? '')
  const [postable, setPostable] = useState(account?.is_postable ?? true)
  const [manual, setManual] = useState(account?.allow_manual_posting ?? true)
  const [description, setDescription] = useState(account?.description ?? '')
  const [policy, setPolicy] = useState<CostCentrePolicy>(account?.cost_centre_policy ?? 'OPTIONAL')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const system = Boolean(account?.is_system)
  const group = groups.find((g) => g.id === groupId)
  const valid = name.trim().length >= 2 && groupId && (editing || /^[A-Za-z0-9][A-Za-z0-9_.-]{0,19}$/.test(code.trim()))

  const submit = async () => {
    setBusy(true); setError(null)
    try {
      await saveAccount(account?.id ?? null, {
        account_code: code.trim().toUpperCase(), account_name: name.trim(), group_id: groupId, account_nature: nature,
        normal_balance: normal || null, is_postable: postable, allow_manual_posting: manual, description: description.trim() || null,
      }).then(async (r) => {
        // Phase 2: the cost-centre rule is saved by its own permission-checked RPC.
        if (!account?.is_control && policy !== (account?.cost_centre_policy ?? 'OPTIONAL')) await setCostCentrePolicy(r.id, policy)
        return r
      })
      onSaved(editing ? `Account ${account!.account_code} saved.` : `Account ${code.trim().toUpperCase()} created.`)
    } catch (e) { setError(describeDataError(e)) } finally { setBusy(false) }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? `Edit ${account!.account_code} ${account!.account_name}` : 'New ledger account'}</DialogTitle>
          <DialogDescription>{system ? 'System account used by automatic posting: you can rename it, describe it or move it within the same classification.'
            : 'The classification (asset, liability, capital, income or expense) comes from the group.'}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1"><Label htmlFor="ac-code">Account code</Label>
            <Input id="ac-code" value={code} disabled={editing} maxLength={20} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="e.g. 1210" /></div>
          <div className="space-y-1"><Label htmlFor="ac-name">Account name</Label>
            <Input id="ac-name" value={name} maxLength={150} onChange={(e) => setName(e.target.value)} placeholder="e.g. HDFC Current A/c" /></div>
          <div className="space-y-1 sm:col-span-2"><Label htmlFor="ac-group">Group</Label>
            <SearchSelect id="ac-group" value={groupId} onChange={setGroupId} options={groupOptions(groups)} placeholder="Select the account group" />
            {group && <p className="text-xs text-muted-foreground">Classification: {CLASSIFICATION_LABELS[group.classification]}</p>}</div>
          {!system && <>
            <div className="space-y-1"><Label htmlFor="ac-nature">Nature</Label>
              <Select value={nature} onValueChange={(v) => setNature(v as AccountNature)}>
                <SelectTrigger id="ac-nature"><SelectValue /></SelectTrigger>
                <SelectContent>{USER_NATURES.map((n) => <SelectItem key={n} value={n}>{NATURE_LABELS[n]}</SelectItem>)}</SelectContent>
              </Select></div>
            <div className="space-y-1"><Label htmlFor="ac-normal">Normal balance</Label>
              <Select value={normal || 'GROUP'} onValueChange={(v) => setNormal(v === 'GROUP' ? '' : (v as NormalBalance))}>
                <SelectTrigger id="ac-normal"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="GROUP">As the group{group ? ` (${group.normal_balance === 'DEBIT' ? 'Debit' : 'Credit'})` : ''}</SelectItem>
                  <SelectItem value="DEBIT">Debit</SelectItem><SelectItem value="CREDIT">Credit</SelectItem></SelectContent>
              </Select></div>
            <label className="flex items-center gap-2 text-sm"><Checkbox checked={postable} onCheckedChange={(v) => setPostable(v === true)} /> Accepts postings</label>
            <label className="flex items-center gap-2 text-sm"><Checkbox checked={manual} onCheckedChange={(v) => setManual(v === true)} /> Allowed in manual journals</label>
          </>}
          {!account?.is_control && <div className="space-y-1 sm:col-span-2"><Label htmlFor="ac-cc">Cost-centre allocation</Label>
            <Select value={policy} onValueChange={(v) => setPolicy(v as CostCentrePolicy)}><SelectTrigger id="ac-cc"><SelectValue /></SelectTrigger>
              <SelectContent>{(Object.keys(COST_CENTRE_POLICY_LABELS) as CostCentrePolicy[]).map((k) => <SelectItem key={k} value={k}>{COST_CENTRE_POLICY_LABELS[k]}</SelectItem>)}</SelectContent></Select>
            <p className="text-xs text-muted-foreground">Required: every posting needs a cost-centre split. Not applicable: splits are refused.</p></div>}
          <div className="space-y-1 sm:col-span-2"><Label htmlFor="ac-desc">Description</Label>
            <Textarea id="ac-desc" value={description} maxLength={500} rows={2} onChange={(e) => setDescription(e.target.value)} /></div>
        </div>
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={() => void submit()} disabled={busy || !valid}>{busy && <Loader2 className="animate-spin" />} Save account</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Create or edit an account group (always under a parent; top-level groups are fixed). */
export function GroupDialog({ group, groups, defaultParent, onClose, onSaved }: {
  group: AccountGroup | null; groups: AccountGroup[]; defaultParent?: string; onClose: () => void; onSaved: (message: string) => void
}) {
  const editing = Boolean(group)
  const [code, setCode] = useState(group?.group_code ?? '')
  const [name, setName] = useState(group?.group_name ?? '')
  const [parent, setParent] = useState(group?.parent_group_id ?? defaultParent ?? '')
  const [active, setActive] = useState(group?.is_active ?? true)
  const [description, setDescription] = useState(group?.description ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const valid = name.trim().length >= 2 && parent && (editing || /^[A-Za-z0-9][A-Za-z0-9_.-]{0,19}$/.test(code.trim()))
  const submit = async () => {
    setBusy(true); setError(null)
    try {
      await saveGroup(group?.id ?? null, { group_code: code.trim().toUpperCase(), group_name: name.trim(), parent_group_id: parent, is_active: active, description: description.trim() || null })
      onSaved(editing ? `Group ${group!.group_name} saved.` : `Group ${name.trim()} created.`)
    } catch (e) { setError(describeDataError(e)) } finally { setBusy(false) }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? `Edit group ${group!.group_name}` : 'New account group'}</DialogTitle>
          <DialogDescription>A sub-group always has its parent's classification. A group cannot be placed under one of its own sub-groups.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1"><Label htmlFor="gr-code">Group code</Label>
            <Input id="gr-code" value={code} disabled={editing} maxLength={20} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="e.g. EX.ADM" /></div>
          <div className="space-y-1"><Label htmlFor="gr-name">Group name</Label>
            <Input id="gr-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} /></div>
          <div className="space-y-1 sm:col-span-2"><Label htmlFor="gr-parent">Parent group</Label>
            <SearchSelect id="gr-parent" value={parent} onChange={setParent} options={groupOptions(groups, group?.id)} placeholder="Select the parent group" /></div>
          {editing && !group!.is_system && (
            <label className="flex items-center gap-2 text-sm sm:col-span-2"><Checkbox checked={active} onCheckedChange={(v) => setActive(v === true)} /> Active</label>
          )}
          <div className="space-y-1 sm:col-span-2"><Label htmlFor="gr-desc">Description</Label>
            <Textarea id="gr-desc" value={description} maxLength={500} rows={2} onChange={(e) => setDescription(e.target.value)} /></div>
        </div>
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={() => void submit()} disabled={busy || !valid}>{busy && <Loader2 className="animate-spin" />} Save group</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
