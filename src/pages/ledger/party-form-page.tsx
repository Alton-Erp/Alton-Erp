import { Info, Loader2, Save } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'

import { usePermissions } from '@/auth/use-permissions'
import { ErrorState } from '@/components/common/error-state'
import { FormDraftBar } from '@/components/common/form-draft-bar'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { EMPTY_PARTY, partyToForm, validateParty, type PartyFormValues, type PartyRow } from '@/features/ledger/ledger-model'
import { DuplicatePanel, PartyFields } from '@/features/ledger/party-form'
import { useAsync } from '@/hooks/use-async'
import { usePersistentFormDraft } from '@/hooks/use-persistent-form-draft'
import { useRequestKey } from '@/hooks/use-request-key'
import { describeDataError } from '@/lib/errors'
import { fetchParty, saveParty, type DuplicateParty } from '@/services/ledger'

/** /ledger/new and /ledger/:partyId/edit */
export default function PartyFormPage() {
  const { partyId } = useParams()
  const party = useAsync(() => (partyId ? fetchParty(partyId) : Promise.resolve(null)), [partyId])
  const crumbs = [{ label: 'Master Data' }, { label: 'Ledger (Parties)', to: '/ledger' }, { label: partyId ? 'Edit' : 'Add party' }]
  if (party.loading && !party.data) return <LoadingState label="Loading…" />
  if (party.error) return (<><PageHeader title="Party" breadcrumbs={crumbs} /><Card><ErrorState message={describeDataError(party.error)} onRetry={party.reload} /></Card></>)
  return <PartyForm key={partyId ?? 'new'} existing={party.data ?? null} />
}

function PartyForm({ existing }: { existing: PartyRow | null }) {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  // /ledger/new?type=CUSTOMER|SUPPLIER|BOTH (quick actions) preselects the party type.
  const presetType = ['CUSTOMER', 'SUPPLIER', 'BOTH'].includes(params.get('type') ?? '') ? (params.get('type') as PartyFormValues['party_type']) : null
  const [values, setValues] = useState<PartyFormValues>(existing ? partyToForm(existing) : presetType ? { ...EMPTY_PARTY, party_type: presetType } : EMPTY_PARTY)
  const [submitted, setSubmitted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [duplicates, setDuplicates] = useState<DuplicateParty[] | null>(null)
  const { key, renew } = useRequestKey()
  const { has } = usePermissions()
  // Auto-saved working copy: restored when the user comes back to this form.
  const draft = usePersistentFormDraft({
    formKey: 'ledger.party', recordId: existing?.party_id ?? null, scope: existing ? '' : (presetType ?? ''),
    baseVersion: existing?.updated_at ?? null,
    enabled: has('customers.manage') || has('suppliers.manage'),
    value: values,
    onRestore: (d) => { setValues((v) => ({ ...v, ...d })); setDuplicates(null) },
  })
  const validation = validateParty(values)
  const errors = submitted ? validation.errors : {}
  // A role the party had and no longer has after saving (it is deactivated, never deleted).
  const had = (r: 'CUSTOMER' | 'SUPPLIER') => existing !== null && (existing.party_type === r || existing.party_type === 'BOTH')
  const keeps = (r: 'CUSTOMER' | 'SUPPLIER') => values.party_type === r || values.party_type === 'BOTH'
  const removedRole = !values.party_type ? null : had('CUSTOMER') && !keeps('CUSTOMER') ? 'customer' : had('SUPPLIER') && !keeps('SUPPLIER') ? 'supplier' : null

  const save = async (confirm: boolean) => {
    setSubmitted(true)
    setError(null)
    if (!validation.payload) return
    setBusy(true)
    try {
      const r = await saveParty(existing?.party_id ?? null, validation.payload, confirm, existing ? null : key)
      if (!r.ok) {
        setDuplicates(r.duplicates)
        renew()
        window.scrollTo({ top: 0, behavior: 'smooth' })
        return
      }
      void draft.markSubmitted()
      navigate(`/ledger/${r.party_id}`, { replace: true, state: { message: `${r.party_code} ${existing ? 'updated' : 'created'}.` } })
    } catch (e) {
      setError(describeDataError(e))
      renew()
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PageHeader
        title={existing ? `Edit ${existing.party_name}` : 'Add party'}
        description={existing ? `${existing.party_code} · changes apply to its customer and supplier records together.` : 'A customer, a supplier or both. Only the name and type are required.'}
        breadcrumbs={[{ label: 'Master Data' }, { label: 'Ledger (Parties)', to: '/ledger' }, { label: existing ? existing.party_code : 'Add party' }]}
      />
      <FormDraftBar draft={draft} />
      <form noValidate onSubmit={(e) => { e.preventDefault(); void save(false) }} className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-4">
          {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800">{error}</p>}
          {duplicates && duplicates.length > 0 && (
            <DuplicatePanel duplicates={duplicates} busy={busy} onUse={(d) => navigate(`/ledger/${d.party_id}`)} onSaveAnyway={() => void save(true)} />
          )}
          {removedRole && (
            <p className="flex gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900">
              <Info className="mt-0.5 size-4 shrink-0" />
              The {removedRole} role will be deactivated, not deleted: its orders, invoices and payments stay in the history, and it can be added back later.
            </p>
          )}
          <Card>
            <CardHeader><div><CardTitle>Party details</CardTitle><CardDescription>Shared by the customer and supplier records of this party.</CardDescription></div></CardHeader>
            <CardContent>
              <PartyFields values={values} onChange={(v) => { setValues(v); setDuplicates(null) }} errors={errors} />
            </CardContent>
          </Card>
        </div>
        <aside className="space-y-4 xl:sticky xl:top-24 xl:self-start">
          {submitted && !validation.payload && (
            <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-800">Please correct the highlighted fields ({Object.keys(validation.errors).length}).</p>
          )}
          <Card>
            <CardHeader><div><CardTitle>Recommendations</CardTitle><CardDescription>Suggestions only — they never block saving.</CardDescription></div></CardHeader>
            <CardContent>
              {validation.warnings.length === 0 ? <p className="text-sm text-muted-foreground">No recommendations.</p> : (
                <ul className="space-y-2 text-sm">{validation.warnings.map((w) => <li key={w} className="flex gap-2"><span aria-hidden className="mt-1.5 size-1.5 shrink-0 rounded-full bg-pending" />{w}</li>)}</ul>
              )}
            </CardContent>
          </Card>
          <div className="flex flex-col gap-2">
            <Button type="submit" disabled={busy}>{busy ? <Loader2 className="animate-spin" /> : <Save />} {existing ? 'Save changes' : 'Save party'}</Button>
            <Button type="button" variant="outline" asChild><Link to={existing ? `/ledger/${existing.party_id}` : '/ledger'}>Cancel</Link></Button>
          </div>
        </aside>
      </form>
    </>
  )
}
