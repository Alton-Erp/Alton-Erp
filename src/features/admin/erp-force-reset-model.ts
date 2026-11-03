// Pure helpers for the force reset (no imports, unit-tested). The server
// enforces every rule again; these only decide what the screen shows.
//
// Since 20261113 the force reset deletes directly: no environment approval,
// backup record, password or typed confirmation (Super Admin permission only).

export const FORCE_SUCCESS_MESSAGE =
  'Force reset completed and verified. All business data of this company was deleted, including posted stock, issued invoices and payments. Users, roles, settings and the audit log were kept.'

export interface ForceGateSource {
  gates?: { authorized?: boolean; plan_reviewed?: boolean }
  can_execute?: boolean
  blockers?: unknown[]
  delete_total?: number
}

export interface GateRow {
  key: 'authorized' | 'plan' | 'data'
  label: string
  ok: boolean
  detail: string
}

/** The checks shown in the preview. */
export function forceGates(p: ForceGateSource | null | undefined): GateRow[] {
  const g = p?.gates ?? {}
  return [
    {
      key: 'authorized', label: 'Super Admin with reset permission', ok: g.authorized === true,
      detail: g.authorized ? 'Checked by the database for your account.' : 'Run the preview to check.',
    },
    {
      key: 'plan', label: 'Every table can be deleted safely', ok: g.plan_reviewed === true,
      detail: g.plan_reviewed ? 'No unknown tables or blocking references.' : `${p?.blockers?.length ?? 0} schema problem(s) listed below.`,
    },
    {
      key: 'data', label: 'Records to delete', ok: (p?.delete_total ?? 0) > 0,
      detail: `${(p?.delete_total ?? 0).toLocaleString('en-IN')} records.`,
    },
  ]
}

/** Whether the server reported that the reset can run (preview). The button itself is always available. */
export const canStartForceReset = (p: ForceGateSource | null | undefined): boolean => !!p && p.can_execute === true

/** Success only when the database completed the FORCE reset and verified it inside the transaction. */
export const isVerifiedForceSuccess = (
  r: { status?: string; mode?: string; verification?: Record<string, unknown> } | null | undefined,
): boolean => !!r && r.status === 'COMPLETED' && r.mode === 'FORCE' && r.verification?.purge_tables_empty === true
