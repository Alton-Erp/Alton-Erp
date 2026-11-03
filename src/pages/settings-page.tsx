import { Loader2, RotateCcw, Save } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'

import { useAuth } from '@/auth/use-auth'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import {
  fetchCompanySettings,
  saveCompanySetting,
  updateCompany,
  type CompanySettingsData,
  type CompanyUpdate,
} from '@/services/company'

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

const SETTING_INVOICE_PREFIX = 'invoice.prefix'
const SETTING_FY_START = 'finance.fy_start_month'
const SETTING_SOD = 'inventory.segregation_of_duties'
const SETTING_EXPIRY_DAYS = 'inventory.expiry_warning_days'

interface FormState {
  legal_name: string
  display_name: string
  gstin: string
  legal_address: string
  state: string
  country: string
  timezone: string
  invoicePrefix: string
  fyStartMonth: string
  segregation: string
  expiryDays: string
}

function toForm(data: CompanySettingsData): FormState {
  const setting = (key: string) => data.settings.find((s) => s.setting_key === key)?.setting_value
  const prefix = setting(SETTING_INVOICE_PREFIX)
  const fy = setting(SETTING_FY_START)
  const sod = setting(SETTING_SOD)
  const expiry = setting(SETTING_EXPIRY_DAYS)
  return {
    legal_name: data.company.legal_name,
    display_name: data.company.display_name,
    gstin: data.company.gstin ?? '',
    legal_address: data.company.legal_address ?? '',
    state: data.company.state ?? '',
    country: data.company.country ?? '',
    timezone: data.company.timezone,
    invoicePrefix: typeof prefix === 'string' ? prefix : '',
    fyStartMonth: typeof fy === 'number' && fy >= 1 && fy <= 12 ? String(fy) : '4',
    // Defaults match the database policy (V2 single-operator): segregation OFF, 30 days.
    segregation: sod === true ? 'on' : 'off',
    expiryDays: typeof expiry === 'number' ? String(expiry) : '30',
  }
}

const TIMEZONES: string[] = (() => {
  try {
    return Intl.supportedValuesOf('timeZone')
  } catch {
    return ['Asia/Kolkata', 'UTC']
  }
})()

export default function SettingsPage() {
  const { access, reloadAccess } = useAuth()
  const companyId = access?.company?.id ?? ''
  const { data, loading, error, reload } = useAsync(() => fetchCompanySettings(companyId), [companyId])
  const [justSaved, setJustSaved] = useState(false)

  if (loading && !data) {
    return (
      <>
        <PageHeader />
        <LoadingState label="Loading settings…" />
      </>
    )
  }
  if (error || !data) {
    return (
      <>
        <PageHeader />
        <Card>
          <ErrorState message={error ? describeDataError(error) : 'Settings could not be loaded.'} onRetry={reload} />
        </Card>
      </>
    )
  }
  // Remount the form whenever fresh data arrives so it starts from saved values.
  return (
    <SettingsForm
      key={data.company.updated_at + data.settings.map((s) => s.updated_at).join()}
      data={data}
      justSaved={justSaved}
      onSaved={() => {
        setJustSaved(true)
        reload()
        reloadAccess()
      }}
    />
  )
}

function SettingsForm({ data, justSaved, onSaved }: { data: CompanySettingsData; justSaved: boolean; onSaved: () => void }) {
  const initial = useMemo(() => toForm(data), [data])
  const [form, setForm] = useState<FormState>(initial)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(
    justSaved ? { tone: 'success', text: 'Settings saved.' } : null,
  )

  const dirty = (Object.keys(initial) as (keyof FormState)[]).some((k) => form[k] !== initial[k])
  const gstin = form.gstin.trim().toUpperCase()
  const gstinError = gstin && !GSTIN_RE.test(gstin) ? 'GSTIN must be a valid 15-character GSTIN.' : null
  const expiryError = !/^\d{1,3}$/.test(form.expiryDays) || Number(form.expiryDays) > 365 ? 'Enter 0 to 365 days.' : null
  const nameError = form.legal_name.trim().length < 2 || form.display_name.trim().length < 2 ? 'Names must have at least 2 characters.' : null

  const set = (key: keyof FormState) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value }))

  const save = async () => {
    if (gstinError || nameError || expiryError) return
    setSaving(true)
    setNotice(null)
    try {
      const changes: CompanyUpdate = {}
      const text = (v: string) => (v.trim() === '' ? null : v.trim())
      if (form.legal_name !== initial.legal_name) changes.legal_name = form.legal_name.trim()
      if (form.display_name !== initial.display_name) changes.display_name = form.display_name.trim()
      if (form.gstin !== initial.gstin) changes.gstin = gstin || null
      if (form.legal_address !== initial.legal_address) changes.legal_address = text(form.legal_address)
      if (form.state !== initial.state) changes.state = text(form.state)
      if (form.country !== initial.country) changes.country = text(form.country)
      if (form.timezone !== initial.timezone) changes.timezone = form.timezone
      await updateCompany(data.company.id, changes)

      const existing = (key: string) => data.settings.find((s) => s.setting_key === key)
      if (form.invoicePrefix !== initial.invoicePrefix) {
        await saveCompanySetting(data.company.id, SETTING_INVOICE_PREFIX, form.invoicePrefix.trim(), existing(SETTING_INVOICE_PREFIX))
      }
      if (form.fyStartMonth !== initial.fyStartMonth) {
        await saveCompanySetting(data.company.id, SETTING_FY_START, Number(form.fyStartMonth), existing(SETTING_FY_START))
      }
      if (form.segregation !== initial.segregation) {
        await saveCompanySetting(data.company.id, SETTING_SOD, form.segregation === 'on', existing(SETTING_SOD))
      }
      if (form.expiryDays !== initial.expiryDays) {
        await saveCompanySetting(data.company.id, SETTING_EXPIRY_DAYS, Number(form.expiryDays), existing(SETTING_EXPIRY_DAYS))
      }
      onSaved()
    } catch (err) {
      setNotice({ tone: 'error', text: describeDataError(err) })
      setSaving(false)
    }
  }

  return (
    <>
      <PageHeader
        actions={
          <>
            <Button variant="outline" disabled={!dirty || saving} onClick={() => setConfirmDiscard(true)}>
              <RotateCcw />
              Discard changes
            </Button>
            <Button disabled={!dirty || saving || Boolean(gstinError || nameError || expiryError)} onClick={() => void save()}>
              {saving ? <Loader2 className="animate-spin" /> : <Save />}
              Save changes
            </Button>
          </>
        }
      />

      {notice && (
        <div
          role={notice.tone === 'error' ? 'alert' : 'status'}
          className={
            notice.tone === 'error'
              ? 'mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800'
              : 'mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-800'
          }
        >
          {notice.text}
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-3">
        <Section title="Company Profile" description="Appears on invoices and documents. Enter verified legal details only." className="xl:col-span-2">
          <Field label="Legal name" htmlFor="s-legal" full>
            <Input id="s-legal" value={form.legal_name} onChange={set('legal_name')} maxLength={200} />
          </Field>
          <Field label="Display name" htmlFor="s-display" full>
            <Input id="s-display" value={form.display_name} onChange={set('display_name')} maxLength={200} />
          </Field>
          <Field label="GSTIN" htmlFor="s-gstin" error={gstinError}>
            <Input
              id="s-gstin"
              value={form.gstin}
              onChange={(e) => setForm((f) => ({ ...f, gstin: e.target.value.toUpperCase() }))}
              placeholder="Not configured"
              maxLength={15}
              aria-invalid={Boolean(gstinError)}
            />
          </Field>
          <Field label="Company code" htmlFor="s-code">
            <Input id="s-code" value={data.company.company_code} readOnly className="bg-surface-muted" />
          </Field>
          <Field label="State" htmlFor="s-state">
            <Input id="s-state" value={form.state} onChange={set('state')} maxLength={100} />
          </Field>
          <Field label="Country" htmlFor="s-country">
            <Input id="s-country" value={form.country} onChange={set('country')} maxLength={100} />
          </Field>
          <Field label="Registered address" htmlFor="s-address" full>
            <Textarea id="s-address" value={form.legal_address} onChange={set('legal_address')} rows={3} maxLength={1000} />
          </Field>
          {nameError && <p className="text-xs text-shortage sm:col-span-2">{nameError}</p>}
        </Section>

        <Section title="Preferences" description="Defaults used across modules">
          <Field label="Timezone" htmlFor="s-tz" full>
            <Select value={form.timezone} onValueChange={(v) => setForm((f) => ({ ...f, timezone: v }))}>
              <SelectTrigger id="s-tz">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-72">
                {TIMEZONES.map((tz) => (
                  <SelectItem key={tz} value={tz}>
                    {tz}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Currency" htmlFor="s-currency" full>
            <Input id="s-currency" value={data.company.currency_code} readOnly className="bg-surface-muted" />
          </Field>
          <Field label="Financial year starts in" htmlFor="s-fy" full>
            <Select value={form.fyStartMonth} onValueChange={(v) => setForm((f) => ({ ...f, fyStartMonth: v }))}>
              <SelectTrigger id="s-fy">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MONTHS.map((m, i) => (
                  <SelectItem key={m} value={String(i + 1)}>
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Invoice number prefix" htmlFor="s-prefix" full>
            <Input id="s-prefix" value={form.invoicePrefix} onChange={set('invoicePrefix')} placeholder="e.g. INV/" maxLength={20} />
          </Field>
          <p className="text-xs text-muted-foreground sm:col-span-2">
            Last updated {formatDateTime(data.company.updated_at, data.company.timezone)}
          </p>
        </Section>
        <Section title="Inventory policy" description="Applied by the database to inventory approvals and alerts" className="xl:col-span-3">
          <Field label="Segregation of duties" htmlFor="s-sod">
            <Select value={form.segregation} onValueChange={(v) => setForm((f) => ({ ...f, segregation: v }))}>
              <SelectTrigger id="s-sod">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="off">Off: one person can create and post everything (single operator, default)</SelectItem>
                <SelectItem value="on">On: a second user must approve purchase orders, BOMs, production orders and stock changes</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Batch expiry warning (days)" htmlFor="s-expiry" error={expiryError}>
            <Input id="s-expiry" inputMode="numeric" value={form.expiryDays} onChange={set('expiryDays')} maxLength={3} />
          </Field>
          <p className="text-xs text-muted-foreground sm:col-span-2">Negative stock is never allowed. Changes are recorded in the audit log.</p>
        </Section>
      </div>

      <ConfirmDialog
        open={confirmDiscard}
        onOpenChange={setConfirmDiscard}
        title="Discard unsaved changes?"
        description="All fields will be reset to the last saved values."
        confirmLabel="Discard"
        destructive
        onConfirm={() => setForm(initial)}
      />
    </>
  )
}

function Section({ title, description, className, children }: { title: string; description: string; className?: string; children: ReactNode }) {
  return (
    <Card className={className}>
      <CardHeader>
        <div>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-2">{children}</CardContent>
    </Card>
  )
}

function Field({ label, htmlFor, full, error, children }: { label: string; htmlFor: string; full?: boolean; error?: string | null; children: ReactNode }) {
  return (
    <div className={full ? 'space-y-1.5 sm:col-span-2' : 'space-y-1.5'}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {error && <p className="text-xs text-shortage">{error}</p>}
    </div>
  )
}
