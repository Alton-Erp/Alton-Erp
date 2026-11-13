import { BookOpen, Loader2, Pencil, Plus, Search } from 'lucide-react'
import { useEffect, useState } from 'react'

import { EmptyState } from '@/components/common/empty-state'
import { ErrorState } from '@/components/common/error-state'
import { FilterTabs } from '@/components/common/filter-tabs'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { Field } from '@/features/support/support-components'
import { useSupportPermissions } from '@/features/support/use-support-permissions'
import { splitList } from '@/features/support/support-model'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import { fetchKbArticles, saveKbArticle, type KbArticle } from '@/services/support'

type StatusFilter = 'PUBLISHED' | 'DRAFT' | 'ARCHIVED' | 'ALL'
const STATUS_TONE = { PUBLISHED: 'success', DRAFT: 'warning', ARCHIVED: 'neutral' } as const

/** /support/knowledge-base — answers and procedures for agents. Editing needs support.manage_settings. */
export default function SupportKnowledgeBasePage() {
  const perms = useSupportPermissions()
  const [status, setStatus] = useState<StatusFilter>('PUBLISHED')
  const [search, setSearch] = useState('')
  const [term, setTerm] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [open, setOpen] = useState<KbArticle | 'new' | null>(null)
  const [selected, setSelected] = useState<KbArticle | null>(null)
  useEffect(() => { const t = setTimeout(() => setTerm(search), 300); return () => clearTimeout(t) }, [search])
  const list = useAsync(() => fetchKbArticles(term, status === 'ALL' ? null : status), [term, status, refresh])
  const statusOptions: { value: StatusFilter; label: string }[] = perms.settings
    ? [{ value: 'PUBLISHED', label: 'Published' }, { value: 'DRAFT', label: 'Drafts' }, { value: 'ARCHIVED', label: 'Archived' }, { value: 'ALL', label: 'All' }]
    : [{ value: 'PUBLISHED', label: 'Published' }, { value: 'ALL', label: 'All' }]
  return (
    <>
      <PageHeader actions={perms.settings && <Button onClick={() => setOpen('new')}><Plus /> New article</Button>} />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <FilterTabs<StatusFilter> label="Article status" value={status} onChange={setStatus} options={statusOptions} />
        <div className="relative min-w-64 flex-1">
          <Search aria-hidden className="absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
          <Input aria-label="Search articles" className="pl-8" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search titles, text and categories" />
        </div>
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Card className="gap-0 p-0">
          {list.loading && !list.data ? <LoadingState rows={6} />
            : list.error ? <ErrorState message={describeDataError(list.error)} onRetry={list.reload} />
            : !list.data || list.data.length === 0 ? <EmptyState icon={BookOpen} title={term ? 'No article matches' : 'No articles yet'}
                description={perms.settings ? 'Write the answers agents need most often.' : 'Articles written by your support administrators appear here.'} />
            : <ul className="divide-y">{list.data.map((a) => (
                <li key={a.id}><button type="button" className="w-full px-4 py-3 text-left hover:bg-muted/60" onClick={() => setSelected(a)} aria-current={selected?.id === a.id ? 'true' : undefined}>
                  <div className="flex items-center justify-between gap-2"><span className="font-medium">{a.title}</span><StatusBadge label={a.status.toLowerCase()} tone={STATUS_TONE[a.status]} /></div>
                  <p className="text-xs text-muted-foreground">{[a.category, ...a.tags].filter(Boolean).join(' · ') || 'Uncategorised'} · updated {formatDateTime(a.updated_at)}</p>
                </button></li>
              ))}</ul>}
        </Card>
        <Card>
          {selected ? (
            <>
              <CardHeader className="flex flex-row items-start justify-between gap-2"><CardTitle>{selected.title}</CardTitle>
                {perms.settings && <Button size="sm" variant="outline" onClick={() => setOpen(selected)}><Pencil /> Edit</Button>}</CardHeader>
              <CardContent><p className="text-sm whitespace-pre-wrap">{selected.body}</p></CardContent>
            </>
          ) : <EmptyState icon={BookOpen} title="Select an article" description="Its text appears here." />}
        </Card>
      </div>
      {open && <ArticleDialog article={open} onOpenChange={(o) => { if (!o) setOpen(null) }} onSaved={(a) => { setRefresh((n) => n + 1); setSelected(a) }} />}
    </>
  )
}

function ArticleDialog({ article, onOpenChange, onSaved }: { article: KbArticle | 'new'; onOpenChange: (o: boolean) => void; onSaved: (a: KbArticle) => void }) {
  const existing = article !== 'new' ? article : null
  const [v, setV] = useState<{ title: string; body: string; category: string; tags: string; status: string }>(() => existing
    ? { title: existing.title, body: existing.body, category: existing.category ?? '', tags: existing.tags.join(', '), status: existing.status }
    : { title: '', body: '', category: '', tags: '', status: 'DRAFT' })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const save = async () => {
    if (v.title.trim().length < 3) { setError('Enter a title (at least 3 characters).'); return }
    if (!v.body.trim()) { setError('Enter the article text.'); return }
    setBusy(true); setError(null)
    try {
      const p = { title: v.title.trim(), body: v.body.trim(), category: v.category.trim() || null, tags: splitList(v.tags), status: v.status }
      const id = await saveKbArticle(existing?.id ?? null, p)
      onSaved({ id, ...p, category: p.category, status: p.status as KbArticle['status'], updated_at: new Date().toISOString() })
      onOpenChange(false)
    } catch (e) { setError(describeDataError(e)) } finally { setBusy(false) }
  }
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV((x) => ({ ...x, [k]: e.target.value }))
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>{existing ? 'Edit article' : 'New article'}</DialogTitle><DialogDescription>Only published articles are listed by default for agents.</DialogDescription></DialogHeader>
        <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); void save() }} noValidate>
          <Field label="Title" htmlFor="kb-title" className="sm:col-span-2"><Input id="kb-title" value={v.title} onChange={set('title')} maxLength={200} /></Field>
          <Field label="Category" htmlFor="kb-category"><Input id="kb-category" value={v.category} onChange={set('category')} maxLength={80} /></Field>
          <Field label="Status" htmlFor="kb-status">
            <Select value={v.status} onValueChange={(s) => setV((x) => ({ ...x, status: s }))}>
              <SelectTrigger id="kb-status"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="DRAFT">Draft</SelectItem><SelectItem value="PUBLISHED">Published</SelectItem><SelectItem value="ARCHIVED">Archived</SelectItem></SelectContent>
            </Select>
          </Field>
          <Field label="Tags" htmlFor="kb-tags" hint="Separate with commas." className="sm:col-span-2"><Input id="kb-tags" value={v.tags} onChange={set('tags')} /></Field>
          <Field label="Text" htmlFor="kb-body" className="sm:col-span-2"><Textarea id="kb-body" value={v.body} onChange={set('body')} rows={12} maxLength={50000} /></Field>
          {error && <p role="alert" className="text-sm text-red-700 sm:col-span-2">{error}</p>}
          <DialogFooter className="sm:col-span-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={busy}>{busy && <Loader2 className="animate-spin" />}Save article</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

