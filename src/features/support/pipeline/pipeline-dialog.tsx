import { Loader2 } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Field } from '@/features/support/support-components'
import { describeDataError } from '@/lib/errors'
import { savePipeline, type Pipeline } from '@/services/pipelines'

/** New pipeline (starts with the six default stages) or edit: name, description, default, active. */
export function PipelineDialog({ existing, canDelete, onClose, onSaved }: { existing: Pipeline | null; canDelete: boolean; onClose: () => void; onSaved: (id: string) => void }) {
  const [name, setName] = useState(existing?.name ?? '')
  const [description, setDescription] = useState(existing?.description ?? '')
  const [isDefault, setIsDefault] = useState(existing?.is_default ?? false)
  const [active, setActive] = useState(existing?.is_active ?? true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    if (!name.trim()) { setError('Enter the pipeline name.'); return }
    setBusy(true); setError(null)
    try {
      const r = await savePipeline(existing?.id ?? null, { name: name.trim(), description: description.trim() || null,
        ...(existing && isDefault && !existing.is_default ? { is_default: true } : {}), ...(existing && active !== existing.is_active ? { is_active: active } : {}) })
      onSaved(r.id)
    } catch (e) {
      setError(describeDataError(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-md" data-testid="pipeline-dialog">
        <DialogHeader><DialogTitle>{existing ? `Edit ${existing.name}` : 'New pipeline'}</DialogTitle>
          <DialogDescription>{existing ? 'Tickets stay in their stages.' : 'It starts with the six default stages; change them with Manage Stages.'}</DialogDescription></DialogHeader>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void submit() }} noValidate>
          <Field label="Pipeline name" htmlFor="pl-name"><Input id="pl-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus /></Field>
          <Field label="Description" htmlFor="pl-desc"><Textarea id="pl-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={500} /></Field>
          {existing && !existing.is_default && <label className="flex items-center gap-2 text-sm"><Checkbox checked={isDefault} onCheckedChange={(v) => setIsDefault(v === true)} />Default pipeline (new tickets go here)</label>}
          {existing && !existing.is_default && canDelete && <label className="flex items-center gap-2 text-sm"><Checkbox checked={active} onCheckedChange={(v) => setActive(v === true)} />Active</label>}
          {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
          <DialogFooter><Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={busy}>{busy && <Loader2 className="animate-spin" />}{existing ? 'Save' : 'Create pipeline'}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
