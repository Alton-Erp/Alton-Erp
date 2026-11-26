import { Eye, Landmark, Plus, Wallet } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'

import { usePermissions } from '@/auth/use-permissions'
import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { formatBalance } from '@/features/accounting/accounting-model'
import { AccountingExport, AccountingNotice, SearchSelect } from '@/features/accounting/accounting-ui'
import {
  BANK_ACCOUNT_TYPES, BANK_ACCOUNT_TYPE_LABELS, emptyMoneyAccount, maskAccountNumber, moneyAccountErrors, moneyAccountForm, moneyAccountPayload,
  type BankAccountType, type BankLookups, type MoneyAccount, type MoneyAccountForm, type MoneyKind,
} from '@/features/accounting/bank-cash-model'
import { ActionDialog, type ActionRequest } from '@/features/production/action-dialog'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDate } from '@/lib/format'
import { fetchBankLookups, fetchMoneyAccounts, revealBankAccountNumber, saveMoneyAccount, setMoneyAccountActive } from '@/services/accounting'

/** Bank account master (kind BANK) or cash account master (kind CASH): each account maps to exactly one bank / cash ledger. */
export function MoneyAccountsPage({ kind }: { kind: MoneyKind }) {
  const { has } = usePermissions()
  const bank = kind === 'BANK'
  const canManage = has(bank ? 'bank_accounts.manage' : 'cash_accounts.manage')
  const [inactive, setInactive] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [edit, setEdit] = useState<MoneyAccount | 'new' | null>(null)
  const [action, setAction] = useState<ActionRequest | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [revealed, setRevealed] = useState<Record<string, string>>({})
  const list = useAsync(() => fetchMoneyAccounts(kind, inactive), [kind, inactive, refresh])
  const lookups = useAsync(() => fetchBankLookups(), [refresh])
  const done = (m: string) => { setAction(null); setEdit(null); setMessage(m); setRefresh((n) => n + 1) }
  const reveal = async (a: MoneyAccount) => {
    try { const n = await revealBankAccountNumber(a.id); setRevealed((r) => ({ ...r, [a.id]: n })) } catch (e) { setMessage(describeDataError(e)) }
  }
  const title = bank ? 'Bank Accounts' : 'Cash Accounts'
  const columns: DataTableColumn<MoneyAccount>[] = [
    { id: 'code', header: 'Account', sortValue: (a) => a.account_code, searchValue: (a) => `${a.account_code} ${a.account_name} ${a.bank_name ?? ''}`, cell: (a) => (
      <span className="text-sm"><span className="font-medium">{a.account_code}</span> {a.account_name}
        {bank && <span className="block text-xs text-muted-foreground">{a.bank_name}{a.branch_name ? `, ${a.branch_name}` : ''} · {BANK_ACCOUNT_TYPE_LABELS[a.bank_account_type!]}</span>}
        {!bank && a.custodian_name && <span className="block text-xs text-muted-foreground">Custodian: {a.custodian_name}</span>}</span>) },
    ...(bank ? [{ id: 'number', header: 'Account number', cell: (a: MoneyAccount) => (
      <span className="flex items-center gap-1 font-mono text-sm" data-testid="masked-number">{revealed[a.id] ?? a.account_number_masked}
        {canManage && !revealed[a.id] && <Button variant="ghost" size="icon" aria-label={`Show the full number of ${a.account_code}`} title="Show full number (recorded in the audit log)"
          onClick={() => void reveal(a)}><Eye /></Button>}</span>) },
      { id: 'ifsc', header: 'IFSC', cell: (a: MoneyAccount) => <span className="font-mono text-sm">{a.ifsc}</span> }] : []),
    { id: 'ledger', header: 'Ledger', cell: (a) => <Link className="text-sm text-primary hover:underline" to={`/accounts/general-ledger?account=${a.ledger_account_id}`}>{a.ledger_code} {a.ledger_name}</Link> },
    { id: 'balance', header: 'Book balance', align: 'right', cell: (a) => <span className="tabular-nums">{formatBalance(a.ledger_balance)}</span> },
    { id: 'policy', header: 'Negative balance', cell: (a) => <span className="text-xs">{a.allow_negative_balance ? 'Allowed' : 'Refused'}</span> },
    ...(bank ? [{ id: 'stmt', header: 'Statement', cell: (a: MoneyAccount) => <span className="text-xs">{a.last_statement_date ? `to ${formatDate(a.last_statement_date)}` : 'none imported'}
      {a.unmatched_statement_lines > 0 && <span className="block text-amber-700">{a.unmatched_statement_lines} unmatched</span>}</span> }] : []),
    { id: 'status', header: 'Status', cell: (a) => <StatusBadge label={a.is_active ? 'Active' : 'Inactive'} tone={a.is_active ? 'success' : 'neutral'} /> },
    { id: 'actions', header: '', align: 'right', cell: (a) => canManage ? (
      <span className="flex justify-end gap-1">
        <Button variant="ghost" size="sm" onClick={() => setEdit(a)}>Edit</Button>
        <Button variant="ghost" size="sm" onClick={() => setAction({ title: `${a.is_active ? 'Deactivate' : 'Activate'} ${a.account_code}`, confirmLabel: a.is_active ? 'Deactivate' : 'Activate',
          note: 'required', minLength: 3, description: a.is_active ? 'The account and its history stay; it can no longer be chosen for new transfers or payments.'
            : 'The account can be used again (its ledger must not be linked to another active account).',
          run: async (n) => { await setMoneyAccountActive(a.id, !a.is_active, n!); return `${a.account_code} ${a.is_active ? 'deactivated' : 'activated'}.` } })}>
          {a.is_active ? 'Deactivate' : 'Activate'}</Button>
      </span>) : null },
  ]
  return (
    <>
      <PageHeader title={title} breadcrumbs={[{ label: 'Accounts' }, { label: title }]}
        description={bank ? 'Company bank accounts, each linked to one bank ledger. Full account numbers are stored apart and shown only on request (audited).'
          : 'Cash accounts (main office, petty, factory…), each linked to one cash ledger. Payments that would take a cash account below zero are refused.'}
        actions={<>
          <AccountingExport title={title} fileStem={bank ? 'bank-accounts' : 'cash-accounts'} rows={list.data ?? []} columns={[
            { header: 'Code', value: (a) => a.account_code }, { header: 'Name', value: (a) => a.account_name }, { header: 'Bank', value: (a) => a.bank_name },
            { header: 'Account number (masked)', value: (a) => a.account_number_masked }, { header: 'IFSC', value: (a) => a.ifsc }, { header: 'Ledger', value: (a) => `${a.ledger_code} ${a.ledger_name}` },
            { header: 'Book balance', value: (a) => Number(a.ledger_balance) }, { header: 'Active', value: (a) => (a.is_active ? 'Yes' : 'No') }]} />
          {canManage && <Button onClick={() => setEdit('new')}><Plus /> New {bank ? 'bank' : 'cash'} account</Button>}
        </>} />
      <AccountingNotice>Book balances are the linked ledger's balance from posted vouchers.</AccountingNotice>
      {message && <p role="status" className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-800">{message}</p>}
      <DataTable columns={columns} data={list.data ?? []} getRowId={(a) => a.id} loading={list.loading} error={list.error ? new Error(describeDataError(list.error)) : null}
        onRetry={list.reload} toolbar={<label className="flex items-center gap-2 text-sm"><Checkbox checked={inactive} onCheckedChange={(v) => setInactive(v === true)} /> Show inactive</label>}
        emptyState={{ icon: bank ? Landmark : Wallet, title: `No ${bank ? 'bank' : 'cash'} accounts yet`, description: `Add the company's ${bank ? 'bank' : 'cash'} accounts and link each to its ledger.`,
          action: canManage ? <Button onClick={() => setEdit('new')}><Plus /> New {bank ? 'bank' : 'cash'} account</Button> : undefined }} />
      {edit && <MoneyAccountDialog kind={kind} account={edit === 'new' ? null : edit} lookups={lookups.data} onClose={() => setEdit(null)} onDone={done} />}
      <ActionDialog request={action} onClose={() => setAction(null)} onDone={done} />
    </>
  )
}

function MoneyAccountDialog({ kind, account, lookups, onClose, onDone }: { kind: MoneyKind; account: MoneyAccount | null; lookups: BankLookups | undefined; onClose: () => void; onDone: (m: string) => void }) {
  const [f, setF] = useState<MoneyAccountForm>(account ? moneyAccountForm(account) : emptyMoneyAccount(kind))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tried, setTried] = useState(false)
  const set = (p: Partial<MoneyAccountForm>) => setF((x) => ({ ...x, ...p }))
  const errors = moneyAccountErrors(f, !account)
  const bank = kind === 'BANK'
  const ledgers = (lookups?.ledgers ?? []).filter((l) => l.account_nature === kind && (!l.linked || l.id === account?.ledger_account_id))
  const save = async () => {
    setTried(true); if (errors.length) return
    setBusy(true); setError(null)
    try { const r = await saveMoneyAccount(account?.id ?? null, moneyAccountPayload(f), account?.row_version ?? null); onDone(`${r.account_code} saved.`) }
    catch (e) { setError(describeDataError(e)) } finally { setBusy(false) }
  }
  const field = (id: string, lbl: string, el: React.ReactNode, wide = false) => <div className={`space-y-1 ${wide ? 'sm:col-span-2' : ''}`}><Label htmlFor={id}>{lbl}</Label>{el}</div>
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader><DialogTitle>{account ? `Edit ${account.account_code}` : `New ${bank ? 'bank' : 'cash'} account`}</DialogTitle>
          <DialogDescription>{bank ? 'Never enter internet-banking passwords, PINs, OTPs or card details. The full account number is stored apart from the account and masked everywhere.'
            : 'Link a cash ledger from the Chart of Accounts (create it there first if needed).'}</DialogDescription></DialogHeader>
        <div className="grid max-h-[65vh] gap-3 overflow-y-auto sm:grid-cols-2">
          {field('ma-code', 'Code', <Input id="ma-code" value={f.account_code} maxLength={20} onChange={(e) => set({ account_code: e.target.value.toUpperCase() })} />)}
          {field('ma-name', 'Name', <Input id="ma-name" value={f.account_name} maxLength={120} onChange={(e) => set({ account_name: e.target.value })} />)}
          {field('ma-ledger', `Linked ${bank ? 'bank' : 'cash'} ledger`, <SearchSelect id="ma-ledger" value={f.ledger_account_id} placeholder="Select a ledger" loading={!lookups}
            options={ledgers.map((l) => ({ value: l.id, label: `${l.account_code} — ${l.account_name}` }))} onChange={(v) => set({ ledger_account_id: v })} />, true)}
          {bank && <>
            {field('ma-bank', 'Bank name', <Input id="ma-bank" value={f.bank_name} onChange={(e) => set({ bank_name: e.target.value })} />)}
            {field('ma-branch', 'Branch', <Input id="ma-branch" value={f.branch_name} onChange={(e) => set({ branch_name: e.target.value })} />)}
            {field('ma-holder', 'Account holder', <Input id="ma-holder" value={f.account_holder_name} onChange={(e) => set({ account_holder_name: e.target.value })} />, true)}
            {field('ma-number', account ? `Account number (blank keeps ${account.account_number_masked})` : 'Account number', <Input id="ma-number" autoComplete="off" value={f.account_number}
              onChange={(e) => set({ account_number: e.target.value })} />)}
            {field('ma-ifsc', 'IFSC', <Input id="ma-ifsc" value={f.ifsc} maxLength={11} onChange={(e) => set({ ifsc: e.target.value.toUpperCase() })} />)}
            {field('ma-type', 'Account type', <Select value={f.bank_account_type} onValueChange={(v) => set({ bank_account_type: v as BankAccountType, ...(account ? {} : { allow_negative_balance: v === 'CASH_CREDIT' || v === 'OVERDRAFT' }) })}>
              <SelectTrigger id="ma-type"><SelectValue /></SelectTrigger><SelectContent>{BANK_ACCOUNT_TYPES.map((t) => <SelectItem key={t} value={t}>{BANK_ACCOUNT_TYPE_LABELS[t]}</SelectItem>)}</SelectContent></Select>)}
            {f.account_number.trim() && <p className="self-end text-xs text-muted-foreground">Shown as {maskAccountNumber(f.account_number)}</p>}
          </>}
          {!bank && field('ma-custodian', 'Custodian (responsible person)', <SearchSelect id="ma-custodian" value={f.custodian_user_id} allowClear placeholder="Nobody assigned"
            options={(lookups?.users ?? []).map((u) => ({ value: u.id, label: u.full_name }))} onChange={(v) => set({ custodian_user_id: v })} />, true)}
          {field('ma-ob', 'Opening balance (reference only)', <Input id="ma-ob" inputMode="decimal" value={f.opening_balance} onChange={(e) => set({ opening_balance: e.target.value })} />)}
          {field('ma-obdate', 'Opening balance date', <Input id="ma-obdate" type="date" value={f.opening_balance_date} onChange={(e) => set({ opening_balance_date: e.target.value })} />)}
          {field('ma-obref', 'Opening balance reference', <Input id="ma-obref" value={f.opening_balance_reference} onChange={(e) => set({ opening_balance_reference: e.target.value })} />, true)}
          <label className="flex items-center gap-2 text-sm sm:col-span-2"><Checkbox checked={f.allow_negative_balance} onCheckedChange={(v) => set({ allow_negative_balance: v === true })} />
            Allow a negative balance (overdraft / cash credit). When off, postings that would take the book balance below zero are refused.</label>
          {field('ma-notes', 'Notes', <Textarea id="ma-notes" rows={2} value={f.notes} onChange={(e) => set({ notes: e.target.value })} />, true)}
          <p className="text-xs text-muted-foreground sm:col-span-2">The opening balance in the books comes from Accounts › Opening Balances; the figures here are a reference.</p>
        </div>
        {tried && errors.length > 0 && <ul role="alert" className="list-disc pl-5 text-sm text-red-700">{errors.map((e) => <li key={e}>{e}</li>)}</ul>}
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button><Button disabled={busy} onClick={() => void save()}>Save</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

