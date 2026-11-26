import { BookText, Plus } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'

import { usePermissions } from '@/auth/use-permissions'
import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { AccountDialog } from '@/features/accounting/account-dialogs'
import { CLASSIFICATIONS, CLASSIFICATION_LABELS, NATURE_LABELS, formatBalance, toPaise, type Account } from '@/features/accounting/accounting-model'
import { AccountingExport, AccountingNotice, SetupGate } from '@/features/accounting/accounting-ui'
import { useAccountingStatus } from '@/features/accounting/use-accounting-status'
import { ActionDialog, type ActionRequest } from '@/features/production/action-dialog'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { fetchChart, setAccountActive } from '@/services/accounting'

export default function LedgerAccountsPage() {
  const status = useAccountingStatus()
  return <SetupGate status={status}>{() => <Ledgers />}</SetupGate>
}

function Ledgers() {
  const { has } = usePermissions()
  const [classification, setClassification] = useState('all')
  const [state, setState] = useState('active')
  const [edit, setEdit] = useState<Account | 'new' | null>(null)
  const [action, setAction] = useState<ActionRequest | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const chart = useAsync(() => fetchChart(), [])
  const rows = (chart.data?.accounts ?? []).filter((a) => (classification === 'all' || a.classification === classification)
    && (state === 'all' || (state === 'active') === a.is_active))
  const manage = has('accounts.manage')
  const done = (m: string) => { setEdit(null); setAction(null); setMessage(m); chart.reload() }

  const columns: DataTableColumn<Account>[] = [
    { id: 'code', header: 'Code', searchValue: (a) => a.account_code, sortValue: (a) => a.account_code, cell: (a) => <span className="font-mono text-xs">{a.account_code}</span> },
    { id: 'name', header: 'Account', searchValue: (a) => `${a.account_name} ${a.group_name}`, sortValue: (a) => a.account_name, cell: (a) => (
      <span><Link className="font-medium text-primary hover:underline" to={`/accounts/general-ledger?account=${a.id}`}>{a.account_name}</Link>
        <span className="block text-xs text-muted-foreground">{a.group_name}</span></span>) },
    { id: 'class', header: 'Classification', sortValue: (a) => a.classification, cell: (a) => CLASSIFICATION_LABELS[a.classification] },
    { id: 'nature', header: 'Nature', cell: (a) => <span className="text-xs">{NATURE_LABELS[a.account_nature]}{a.requires_party ? ' · party-wise' : ''}</span> },
    { id: 'rules', header: 'Posting', cell: (a) => (
      <span className="flex flex-wrap gap-1">{a.is_system && <StatusBadge label="System" />}{!a.allow_manual_posting && <StatusBadge label="Automatic only" tone="warning" />}
        {!a.is_postable && <StatusBadge label="No postings" />}{!a.is_active && <StatusBadge label="Inactive" />}</span>) },
    { id: 'balance', header: 'Balance', align: 'right', sortValue: (a) => toPaise(a.balance), cell: (a) => <span className="tabular-nums">{formatBalance(a.balance)}</span> },
    ...(manage ? [{ id: 'actions', header: '', align: 'right' as const, cell: (a: Account) => (
      <span className="flex justify-end gap-1">
        <Button variant="ghost" size="sm" onClick={() => setEdit(a)}>Edit</Button>
        {!a.is_system && <Button variant="ghost" size="sm" onClick={() => setAction({
          title: `${a.is_active ? 'Deactivate' : 'Activate'} ${a.account_code} ${a.account_name}`,
          description: a.is_active ? 'Only accounts with a zero balance, no draft vouchers and no posting-rule mapping can be deactivated. Posted history is kept.'
            : 'The account can be used again on new vouchers.',
          confirmLabel: a.is_active ? 'Deactivate' : 'Activate', note: 'none', destructive: a.is_active,
          run: async () => { await setAccountActive(a.id, !a.is_active); return `${a.account_code} ${a.is_active ? 'deactivated' : 'activated'}.` },
        })}>{a.is_active ? 'Deactivate' : 'Activate'}</Button>}
      </span>) }] : []),
  ]

  return (
    <>
      <PageHeader actions={<>
        <AccountingExport title="Ledger accounts" fileStem="ledger-accounts" rows={rows} columns={[
          { header: 'Code', value: (a) => a.account_code }, { header: 'Account', value: (a) => a.account_name }, { header: 'Group', value: (a) => a.group_name },
          { header: 'Classification', value: (a) => CLASSIFICATION_LABELS[a.classification] }, { header: 'Nature', value: (a) => NATURE_LABELS[a.account_nature] },
          { header: 'Active', value: (a) => (a.is_active ? 'Yes' : 'No') }, { header: 'Balance (Dr + / Cr −)', value: (a) => Number(a.balance) },
        ]} />
        {manage && <Button onClick={() => setEdit('new')}><Plus /> New account</Button>}
      </>} />
      <AccountingNotice />
      {message && <p role="status" className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-800">{message}</p>}
      <DataTable columns={columns} data={rows} getRowId={(a) => a.id} loading={chart.loading} pageSize={50} searchPlaceholder="Search code, name or group…"
        error={chart.error ? new Error(describeDataError(chart.error)) : null} onRetry={chart.reload}
        toolbar={<div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1"><Label htmlFor="la-class">Classification</Label>
            <Select value={classification} onValueChange={setClassification}><SelectTrigger id="la-class" className="w-44"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="all">All</SelectItem>{CLASSIFICATIONS.map((c) => <SelectItem key={c} value={c}>{CLASSIFICATION_LABELS[c]}</SelectItem>)}</SelectContent></Select></div>
          <div className="space-y-1"><Label htmlFor="la-state">Status</Label>
            <Select value={state} onValueChange={setState}><SelectTrigger id="la-state" className="w-32"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="active">Active</SelectItem><SelectItem value="inactive">Inactive</SelectItem><SelectItem value="all">All</SelectItem></SelectContent></Select></div>
        </div>}
        emptyState={{ icon: BookText, title: 'No ledger accounts', description: 'Ledger accounts appear here once accounting is set up.' }} />
      {edit && <AccountDialog account={edit === 'new' ? null : edit} groups={chart.data?.groups ?? []} onClose={() => setEdit(null)} onSaved={done} />}
      <ActionDialog request={action} onClose={() => setAction(null)} onDone={done} />
    </>
  )
}
