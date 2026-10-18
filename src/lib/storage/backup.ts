import { z } from 'zod'
import { nid } from '../id'
import { identifier, policyVersion, revision } from '../domain/common'
import { supportedPolicies, validateWorkspace, workspaceSchema, type Workspace } from '../domain/workspace'
import type { WorkspaceSnapshot, WorkspaceVersion } from './repository'

export const MAX_BACKUP_BYTES = 25 * 1024 * 1024
export const backupSchema = z.strictObject({
  format: z.literal('visual-language-workspace'), formatVersion: z.literal(1), dataSchemaVersion: z.literal(1),
  appVersion: z.string().min(1).max(100), exportId: identifier, exportedAt: z.iso.datetime(), workspaceId: identifier,
  snapshotRevision: revision, policyVersions: z.array(policyVersion).min(1).max(10), data: workspaceSchema,
})
export type WorkspaceBackup = z.infer<typeof backupSchema>
export type RestorePreview = { kind?: 'original'; backup: WorkspaceBackup; expected: WorkspaceVersion; counts: ReturnType<typeof counts>; warnings: string[] }
export function counts(state: Workspace) {
  return { topics: state.nodes.filter(n => n.type === 'root').length, nodes: state.nodes.length, cards: state.cards.length,
    attempts: state.attempts.length, sources: state.sources.length, pending: state.attempts.filter(a => a.status !== 'committed').length,
    drafts: state.drafts.length, events: state.events.length }
}
export function exportBackup(snapshot: WorkspaceSnapshot, now = Date.now()): WorkspaceBackup {
  // Strict schema reconstruction is the allowlist. Settings/auth/caches are not in this model.
  const data = validateWorkspace(snapshot.state)
  return backupSchema.parse({ format: 'visual-language-workspace', formatVersion: 1, dataSchemaVersion: 1, appVersion: '0.1.0',
    exportId: nid('export'), exportedAt: new Date(now).toISOString(), workspaceId: data.id,
    snapshotRevision: data.revision, policyVersions: [...supportedPolicies], data })
}
export function parseBackup(text: string): WorkspaceBackup {
  if (new TextEncoder().encode(text).byteLength > MAX_BACKUP_BYTES) throw new Error('Backup files must be 25 MiB or smaller.')
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new Error('The selected file is not valid JSON.') }
  const parsed = backupSchema.parse(value)
  parsed.data = validateWorkspace(parsed.data)
  if (parsed.workspaceId !== parsed.data.id || parsed.snapshotRevision !== parsed.data.revision) throw new Error('Backup identity or revision does not match its workspace.')
  if (new Set(parsed.policyVersions).size !== parsed.policyVersions.length) throw new Error('Duplicate policy versions in backup.')
  return parsed
}
export async function previewBackup(file: Pick<File, 'size' | 'text'>, expected: WorkspaceVersion): Promise<RestorePreview> {
  if (file.size > MAX_BACKUP_BYTES) throw new Error('Backup files must be 25 MiB or smaller.')
  const backup = parseBackup(await file.text())
  return { backup, expected: { ...expected }, counts: counts(backup.data), warnings: [
    'Replace, not merge: restoring an older backup can roll back your learning progress.',
    'The file contains private learning content and quiz answers. It is not encrypted.',
    'Credentials are not imported. Imported provider preferences require review before use.',
    'Pending lessons and answers remain saved. No network work will resume automatically.',
    ...(backup.data.demo?.enabled ? ['This is an isolated demo workspace with a simulated clock.'] : []),
  ] }
}
export function downloadBackup(backup: WorkspaceBackup) {
  const text = JSON.stringify(backup, null, 2)
  // Enforce our own import limit too; never offer an unrestorable oversized export.
  parseBackup(text)
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url; link.download = `visual-language-backup-${backup.data.demo?.enabled ? 'demo-' : ''}${backup.exportedAt.replace(/[:.]/g, '-')}.json`
  document.body.append(link); link.click(); link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}
