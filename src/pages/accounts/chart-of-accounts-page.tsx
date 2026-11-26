import { ChevronDown, ChevronRight, FolderTree, Plus } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

import { usePermissions } from '@/auth/use-permissions'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { AccountDialog, GroupDialog } from '@/features/accounting/account-dialogs'
import {
  CLASSIFICATION_LABELS, NATURE_LABELS, buildGroupTree, formatBalance, type Account, type AccountGroup, type GroupNode,
} from '@/features/accounting/accounting-model'
import { AccountingExport, AccountingNotice, SetupGate } from '@/features/accounting/accounting-ui'
import { useAccountingStatus } from '@/features/accounting/use-accounting-status'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { cn } from '@/lib/utils'
import { fetchChart } from '@/services/accounting'

export default function ChartOfAccountsPage() {
  const status = useAccountingStatus()
  return <SetupGate status={status}>{() => <Chart />}</SetupGate>
}

function Chart() {
  const { has } = usePermissions()
  const chart = useAsync(() => fetchChart(), [])
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [message, setMessage] = useState<string | null>(null)
  const [editAccount, setEditAccount] = useState<Account | null | 'new'>(null)
  const [editGroup, setEditGroup] = useState<{ group: AccountGroup | null; parent?: string } | null>(null)
  const tree = useMemo(() => buildGroupTree(chart.data?.groups ?? [], chart.data?.accounts ?? []), [chart.data])
  const manage = has('accounts.manage')
  const done = (m: string) => { setEditAccount(null); setEditGroup(null); setMessage(m); chart.reload() }
  const toggle = (id: string) => setCollapsed((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })

  const renderNode = (node: GroupNode, depth: number) => {
    const open = !collapsed.has(node.group.id)
    return (
      <li key={node.group.id}>
        <div className={cn('flex items-center gap-2 rounded px-2 py-1.5 hover:bg-muted/50', !node.group.is_active && 'opacity-60')} style={{ paddingLeft: depth * 18 + 8 }}>
          <button type="button" className="text-muted-foreground" aria-label={open ? 'Collapse' : 'Expand'} onClick={() => toggle(node.group.id)}>
            {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
          </button>
          <span className={cn('font-medium', depth === 0 && 'uppercase tracking-wide')}>{node.group.group_name}</span>
          <span className="text-xs text-muted-foreground">{node.group.group_code}</span>
          {depth === 0 && <StatusBadge label={CLASSIFICATION_LABELS[node.group.classification]} tone="info" />}
          {!node.group.is_active && <StatusBadge label="Inactive" />}
          <span className="ml-auto tabular-nums text-sm">{formatBalance(node.balance)}</span>
          {manage && (
            <span className="flex gap-1">
              <Button variant="ghost" size="sm" onClick={() => setEditGroup({ group: null, parent: node.group.id })}>+ Group</Button>
              {depth > 0 && <Button variant="ghost" size="sm" onClick={() => setEditGroup({ group: node.group })}>Edit</Button>}
            </span>
          )}
        </div>
        {open && (
          <ul>
            {node.children.map((c) => renderNode(c, depth + 1))}
            {node.accounts.map((a) => (
              <li key={a.id} className={cn('flex items-center gap-2 px-2 py-1 text-sm hover:bg-muted/30', !a.is_active && 'opacity-60')} style={{ paddingLeft: (depth + 1) * 18 + 30 }}>
                <span className="w-16 shrink-0 font-mono text-xs text-muted-foreground">{a.account_code}</span>
                <Link className="text-primary hover:underline" to={`/accounts/general-ledger?account=${a.id}`}>{a.account_name}</Link>
                {a.account_nature !== 'GENERAL' && <span className="text-xs text-muted-foreground">{NATURE_LABELS[a.account_nature]}</span>}
                {a.is_system && <StatusBadge label="System" />}
                {!a.allow_manual_posting && <StatusBadge label="Automatic only" tone="warning" />}
                {!a.is_postable && <StatusBadge label="No postings" />}
                {!a.is_active && <StatusBadge label="Inactive" />}
                <span className="ml-auto tabular-nums">{formatBalance(a.balance)}</span>
                {manage && <Button variant="ghost" size="sm" onClick={() => setEditAccount(a)}>Edit</Button>}
              </li>
            ))}
          </ul>
        )}
      </li>
    )
  }

  return (
    <>
      <PageHeader actions={<>
        <AccountingExport title="Chart of accounts" fileStem="chart-of-accounts" rows={chart.data?.accounts ?? []} columns={[
          { header: 'Code', value: (a) => a.account_code }, { header: 'Account', value: (a) => a.account_name }, { header: 'Group', value: (a) => a.group_name },
          { header: 'Classification', value: (a) => CLASSIFICATION_LABELS[a.classification] }, { header: 'Nature', value: (a) => NATURE_LABELS[a.account_nature] },
          { header: 'Normal balance', value: (a) => a.normal_balance }, { header: 'Active', value: (a) => (a.is_active ? 'Yes' : 'No') },
          { header: 'Balance (Dr + / Cr −)', value: (a) => Number(a.balance) },
        ]} />
        {manage && <Button onClick={() => setEditAccount('new')}><Plus /> New account</Button>}
      </>} />
      <AccountingNotice />
      {message && <p role="status" className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-800">{message}</p>}
      {chart.loading ? <LoadingState variant="table" /> : chart.error ? <ErrorState message={describeDataError(chart.error)} onRetry={chart.reload} />
        : !tree.length ? <EmptyState icon={FolderTree} title="No account groups" />
          : <Card><CardContent className="p-2"><ul className="text-sm">{tree.map((n) => renderNode(n, 0))}</ul></CardContent></Card>}
      {editAccount && <AccountDialog account={editAccount === 'new' ? null : editAccount} groups={chart.data?.groups ?? []} onClose={() => setEditAccount(null)} onSaved={done} />}
      {editGroup && <GroupDialog group={editGroup.group} defaultParent={editGroup.parent} groups={chart.data?.groups ?? []} onClose={() => setEditGroup(null)} onSaved={done} />}
    </>
  )
}
