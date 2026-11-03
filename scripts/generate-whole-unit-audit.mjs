// Regenerates supabase/audit/whole_piece_quantity_audit.sql from the migration.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { AUDIT_SCRIPT, MIGRATION, buildAuditScript } from './lib/whole-unit-audit.mjs'

const root = path.resolve(import.meta.dirname, '..')
const sql = await readFile(path.join(root, MIGRATION), 'utf8')
await mkdir(path.join(root, path.dirname(AUDIT_SCRIPT)), { recursive: true })
await writeFile(path.join(root, AUDIT_SCRIPT), buildAuditScript(sql))
console.log(`Wrote ${AUDIT_SCRIPT}`)
