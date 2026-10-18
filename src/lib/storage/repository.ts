import { openDB, type IDBPDatabase, type IDBPTransaction } from 'idb'
import { nid } from '../id'
import { sha256Hex } from '../crypto'
import { sameRecord } from '../domain/common'
import { validateLessonChanges, validateLessonActivityChanges } from '../domain/lesson'
import { collectionNames, createWorkspace, validateWorkspace, type CollectionName, type Workspace } from '../domain/workspace'
import { assertWorkspaceMode, WORKSPACE_DATABASES, type WorkspaceMode } from '../domain/workspaceMode'

const DATA_STORES = ['datasets', ...collectionNames] as const
const ALL_STORES = ['meta', ...DATA_STORES]
type Transaction = IDBPTransaction<unknown, string[], 'readwrite' | 'readonly'>
type WriteTransaction = IDBPTransaction<unknown, string[], 'readwrite'>
type Control = { id: 'control'; activeDatasetId: string; checkpointId: string | null; generation: number }
type StoredEntity = { datasetId: string; id: string; value: { id: string }; learnerId?: string; itemId?: string; skill?: string; status?: string; dueAt?: number; cardId?: string; occurredAt?: number }
export type WorkspaceVersion = { datasetId: string; revision: number; generation: number }
export type WorkspaceSnapshot = { state: Workspace; version: WorkspaceVersion; hasCheckpoint: boolean }
export class WorkspaceConflict extends Error { name = 'WorkspaceConflict' }
export type Mutation = { id: string; kind: string; at: number; intent: unknown }

async function fingerprint(value: unknown): Promise<string> {
  return sha256Hex(JSON.stringify(value))
}
function split(state: Workspace) {
  const metadata = Object.fromEntries(Object.entries(state).filter(([key]) => !(collectionNames as readonly string[]).includes(key)))
  return { metadata, collections: Object.fromEntries(collectionNames.map(name => [name, state[name]])) }
}
async function readDataset(tx: Transaction, datasetId: string): Promise<Workspace> {
  const header = await tx.objectStore('datasets').get(datasetId) as { id: string; metadata: Record<string, unknown>; order: Record<CollectionName, string[]> } | undefined
  if (!header) throw new Error('The saved workspace dataset is missing. No data was replaced.')
  const entries = await Promise.all(collectionNames.map(async name => {
    const records = await tx.objectStore(name).index('dataset').getAll(datasetId) as StoredEntity[]
    const byId = new Map(records.map(record => [record.id, record.value]))
    const order = header.order[name]
    if (!order || new Set(order).size !== records.length || order.length !== records.length || order.some(id => !byId.has(id))) throw new Error('Stored collection ordering is inconsistent.')
    return [name, order.map(id => byId.get(id)!)]
  }))
  return validateWorkspace({ ...header.metadata, ...Object.fromEntries(entries) })
}
async function writeDataset(tx: WriteTransaction, datasetId: string, state: Workspace, previous?: Workspace) {
  const { metadata } = split(state)
  const order = Object.fromEntries(collectionNames.map(name => [name, state[name].map(record => record.id)]))
  const writes: Promise<unknown>[] = []
  const enqueue = (write: () => Promise<unknown>) => writes.push(Promise.resolve().then(write))
  enqueue(() => tx.objectStore('datasets').put({ id: datasetId, metadata, order }))
  for (const name of collectionNames) {
    const before = new Map<string, { id: string }>((previous?.[name] ?? []).map(record => [record.id, record]))
    for (const value of state[name]) {
      const old = before.get(value.id)
      before.delete(value.id)
      if (old && sameRecord(old, value)) continue
      const record: StoredEntity = { datasetId, id: value.id, value }
      if (name === 'cards') {
        const card = value as Workspace['cards'][number]
        Object.assign(record, { learnerId: card.learnerId, itemId: card.itemId, skill: card.skill, status: card.status, ...(card.dueAt === null ? {} : { dueAt: card.dueAt }) })
      }
      if (name === 'events') { const event = value as Workspace['events'][number]; Object.assign(record, { cardId: event.cardId, occurredAt: event.occurredAt }) }
      enqueue(() => tx.objectStore(name).put(record))
    }
    for (const id of before.keys()) enqueue(() => tx.objectStore(name).delete([datasetId, id]))
  }
  await Promise.all(writes)
}
async function deleteDataset(tx: WriteTransaction, datasetId: string) {
  for (const name of collectionNames) {
    const keys = await tx.objectStore(name).index('dataset').getAllKeys(datasetId)
    await Promise.all(keys.map(key => tx.objectStore(name).delete(key)))
  }
  await tx.objectStore('datasets').delete(datasetId)
}
function verifyVersion(control: Control, state: Workspace, expected: WorkspaceVersion) {
  if (control.activeDatasetId !== expected.datasetId || control.generation !== expected.generation || state.revision !== expected.revision) throw new WorkspaceConflict('This workspace changed in another action or tab. Reload the saved state before trying again.')
}
function snapshot(control: Control, state: Workspace): WorkspaceSnapshot {
  return { state, version: { datasetId: control.activeDatasetId, generation: control.generation, revision: state.revision }, hasCheckpoint: Boolean(control.checkpointId) }
}

/** All writers share one IndexedDB transaction scope, even when Web Locks is absent.
 * Revision + dataset-generation checks reject stale tabs after any restore/rollback.
 * No network, localStorage access, or asynchronous application work runs in mutations.
 */
export class WorkspaceRepository {
  private db: IDBPDatabase
  private channel?: BroadcastChannel
  private listeners = new Set<(reason: 'changed' | 'replaced' | 'versionchange') => void>()
  readonly deviceId: string
  private constructor(db: IDBPDatabase, name: string, deviceId: string, broadcast: boolean, readonly mode: WorkspaceMode) {
    this.db = db; this.deviceId = deviceId
    if (broadcast && typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel(`${name}:changes`)
      this.channel.onmessage = event => { if (['changed', 'replaced'].includes(event.data)) this.emit(event.data, false) }
    }
  }
  static async open(options: { name?: string; initial?: () => Workspace; broadcast?: boolean; mode?: WorkspaceMode } = {}) {
    const mode = options.mode ?? 'normal', name = options.name ?? WORKSPACE_DATABASES[mode]
    if (Object.values(WORKSPACE_DATABASES).some(value => value === name) && name !== WORKSPACE_DATABASES[mode]) throw new Error('The workspace database does not match the selected mode.')
    let repository: WorkspaceRepository | undefined
    const db = await openDB(name, 1, {
      upgrade(database) {
        database.createObjectStore('meta', { keyPath: 'id' })
        database.createObjectStore('datasets', { keyPath: 'id' })
        for (const storeName of collectionNames) {
          const store = database.createObjectStore(storeName, { keyPath: ['datasetId', 'id'] })
          store.createIndex('dataset', 'datasetId')
          if (storeName === 'cards') {
            store.createIndex('learner-status-due', ['datasetId', 'learnerId', 'status', 'dueAt'])
            store.createIndex('learner-item-skill', ['datasetId', 'learnerId', 'itemId', 'skill'], { unique: true })
          }
          if (storeName === 'events') store.createIndex('card-time', ['datasetId', 'cardId', 'occurredAt'])
        }
      },
      blocking() { repository?.emit('versionchange', false); db.close() },
      terminated() { repository?.emit('versionchange', false) },
    })
    const tx = db.transaction(ALL_STORES, 'readwrite')
    try {
      const device = await tx.objectStore('meta').get('device') as { value: string } | undefined
      const deviceId = device?.value ?? nid('device')
      if (!device) await tx.objectStore('meta').put({ id: 'device', value: deviceId })
      const control = await tx.objectStore('meta').get('control') as Control | undefined
      if (!control) {
        // The callback may reject malformed legacy content; never replace it with defaults.
        const initial = validateWorkspace(options.initial ? options.initial() : createWorkspace())
        assertWorkspaceMode(mode, initial)
        const datasetId = nid('dataset')
        await writeDataset(tx, datasetId, initial)
        await readDataset(tx, datasetId)
        await tx.objectStore('meta').put({ id: 'control', activeDatasetId: datasetId, checkpointId: null, generation: 0 } satisfies Control)
      } else assertWorkspaceMode(mode, await readDataset(tx, control.activeDatasetId))
      await tx.done
      repository = new WorkspaceRepository(db, name, deviceId, options.broadcast !== false, mode)
      return repository
    } catch (error) { try { tx.abort() } catch { /* already aborted */ }; await tx.done.catch(() => {}); db.close(); throw error }
  }
  subscribe(listener: (reason: 'changed' | 'replaced' | 'versionchange') => void) { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  private emit(reason: 'changed' | 'replaced' | 'versionchange', broadcast = true) {
    if (broadcast) { this.channel?.postMessage(reason); return }
    for (const listener of this.listeners) listener(reason)
  }
  close() { this.channel?.close(); this.db.close(); this.listeners.clear() }
  async snapshot(): Promise<WorkspaceSnapshot> {
    const tx = this.db.transaction(ALL_STORES, 'readonly')
    try {
      const control = await tx.objectStore('meta').get('control') as Control
      const state = await readDataset(tx, control.activeDatasetId)
      assertWorkspaceMode(this.mode, state)
      await tx.done
      return snapshot(control, state)
    } catch (error) { await tx.done.catch(() => {}); throw error }
  }
  async mutate(expected: WorkspaceVersion, operation: Mutation, change: (state: Workspace) => void): Promise<WorkspaceSnapshot> {
    const signature = await fingerprint([operation.kind, operation.intent])
    const tx = this.db.transaction(ALL_STORES, 'readwrite')
    try {
      const control = await tx.objectStore('meta').get('control') as Control
      const before = await readDataset(tx, control.activeDatasetId)
      assertWorkspaceMode(this.mode, before)
      const existing = before.operations.find(op => op.id === operation.id)
      // A restored dataset is a new write authority, even if it contains an old operation ID.
      if (control.activeDatasetId !== expected.datasetId || control.generation !== expected.generation) throw new WorkspaceConflict('The workspace was replaced. Reload before editing.')
      if (existing) {
        if (existing.kind !== operation.kind || existing.fingerprint !== signature) throw new WorkspaceConflict('An operation ID was reused for a different action.')
        await tx.done
        return snapshot(control, before)
      }
      verifyVersion(control, before, expected)
      const state = structuredClone(before)
      const result: unknown = change(state)
      if (result && typeof result === 'object' && 'then' in result) throw new Error('Workspace mutations must be synchronous.')
      state.revision = before.revision + 1
      state.operations.push({ id: operation.id, kind: operation.kind, deviceId: this.deviceId, baseRevision: before.revision, occurredAt: operation.at, fingerprint: signature })
      const validated = validateWorkspace(state)
      validateLessonChanges(before.lessons, validated.lessons)
      validateLessonActivityChanges(before.sessions, validated.sessions)
      assertWorkspaceMode(this.mode, validated)
      await writeDataset(tx, control.activeDatasetId, validated, before)
      await tx.done
      this.emit('changed')
      return snapshot(control, validated)
    } catch (error) { try { tx.abort() } catch { /* completed */ }; await tx.done.catch(() => {}); throw error }
  }
  /** Call only after preview and explicit replace confirmation. Validation has no external effects. */
  async replace(expected: WorkspaceVersion, imported: Workspace): Promise<WorkspaceSnapshot> {
    const validated = validateWorkspace(imported)
    assertWorkspaceMode(this.mode, validated)
    const tx = this.db.transaction(ALL_STORES, 'readwrite')
    try {
      const control = await tx.objectStore('meta').get('control') as Control
      verifyVersion(control, await readDataset(tx, control.activeDatasetId), expected)
      const datasetId = nid('dataset')
      await writeDataset(tx, datasetId, validated)
      const staged = await readDataset(tx, datasetId)
      const next: Control = { ...control, activeDatasetId: datasetId, checkpointId: control.activeDatasetId, generation: control.generation + 1 }
      await tx.objectStore('meta').put(next)
      // Only after staging/read-back succeeds; quota/transaction failure rolls back everything.
      if (control.checkpointId) await deleteDataset(tx, control.checkpointId)
      await tx.done
      this.emit('replaced')
      return snapshot(next, staged)
    } catch (error) { try { tx.abort() } catch { /* completed */ }; await tx.done.catch(() => {}); throw error }
  }
  async rollback(expected: WorkspaceVersion): Promise<WorkspaceSnapshot> {
    const tx = this.db.transaction(ALL_STORES, 'readwrite')
    try {
      const control = await tx.objectStore('meta').get('control') as Control
      verifyVersion(control, await readDataset(tx, control.activeDatasetId), expected)
      if (!control.checkpointId) throw new Error('No local recovery checkpoint is available.')
      const state = await readDataset(tx, control.checkpointId)
      assertWorkspaceMode(this.mode, state)
      const next: Control = { ...control, activeDatasetId: control.checkpointId, checkpointId: control.activeDatasetId, generation: control.generation + 1 }
      await tx.objectStore('meta').put(next); await tx.done
      this.emit('replaced')
      return snapshot(next, state)
    } catch (error) { try { tx.abort() } catch { /* completed */ }; await tx.done.catch(() => {}); throw error }
  }
}
