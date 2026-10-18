import { nid } from '../id'
import { WorkspaceConflict, WorkspaceRepository, type WorkspaceSnapshot } from '../storage/repository'
import { initialWorkspaceFromStorage } from '../storage/migration'
import type { Workspace } from '../domain/workspace'
import { createDemoWorkspace } from '../demo/seed'
import type { WorkspaceMode } from '../domain/workspaceMode'
import type { LearningCalendar } from '../domain/learningCalendar'
import { resolveLearningCalendar } from '../learning/learningCalendar'
import { sameRecord } from '../domain/common'

/** UI writes serialize locally; IndexedDB revisions guard other tabs. Failed drafts stay in the UI. */
export class WorkspaceState {
  constructor(readonly mode: WorkspaceMode = 'normal') {}
  snapshot = $state.raw<WorkspaceSnapshot | null>(null)
  learningCalendar = $state.raw<LearningCalendar | null>(null)
  learningNow = $state(Date.now())
  status = $state<'loading' | 'saved' | 'saving' | 'error' | 'conflict'>('loading')
  error = $state('')
  repository: WorkspaceRepository | null = null
  private tail: Promise<unknown> = Promise.resolve()
  private externalChanges = 0
  private calendarPolicySave?: Promise<void>
  private unsubscribe?: () => void
  private onExternalChange?: () => void

  now() { return this.mode === 'demo' && this.snapshot?.state.demo?.enabled ? this.snapshot.state.demo.now : Date.now() }
  private projectLearningCalendar() {
    this.learningNow = this.now()
    const state = this.snapshot?.state
    const learner = state?.learners.find(l => l.id === state.activeLearnerId)
    const calendar = learner ? resolveLearningCalendar(learner.learningCalendar, this.learningNow, Intl.DateTimeFormat().resolvedOptions().timeZone) : null
    if (!sameRecord(calendar, this.learningCalendar)) this.learningCalendar = calendar
  }
  refreshLearningCalendar(): Promise<void> {
    this.projectLearningCalendar()
    const state = this.snapshot?.state, browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone
    const learner = state?.learners.find(l => l.id === state.activeLearnerId)
    if (this.calendarPolicySave) return this.calendarPolicySave
    if (!learner || (learner.learningCalendar.pending?.timeZone ?? learner.learningCalendar.timeZone) === browserZone) return Promise.resolve()
    // Observing a new zone is a preference change, not a rollover write. Save
    // it once so its future boundary survives closing the app or another tab.
    const work = this.apply((snapshot, repository) => {
      const current = snapshot.state.learners.find(l => l.id === snapshot.state.activeLearnerId)!
      if ((current.learningCalendar.pending?.timeZone ?? current.learningCalendar.timeZone) === browserZone) return Promise.resolve(snapshot)
      const at = this.now(), calendar = resolveLearningCalendar(current.learningCalendar, at, browserZone)
      return repository.mutate(snapshot.version, { id: nid('op'), kind: 'observe-learning-time-zone', intent: { timeZone: browserZone }, at }, state => {
        state.learners.find(l => l.id === state.activeLearnerId)!.learningCalendar = calendar
      })
    }).then(() => {}).finally(() => { this.calendarPolicySave = undefined })
    this.calendarPolicySave = work
    void work.catch(() => {}) // apply retains a visible storage/conflict error.
    return work
  }

  async open(onExternalChange: () => void) {
    this.onExternalChange = onExternalChange
    try {
      this.repository = await WorkspaceRepository.open({ mode: this.mode, initial: this.mode === 'demo' ? createDemoWorkspace : () => initialWorkspaceFromStorage() })
      this.snapshot = await this.repository.snapshot()
      await this.refreshLearningCalendar()
      this.status = 'saved'
      this.unsubscribe = this.repository.subscribe(reason => {
        this.externalChanges++
        this.status = 'conflict'
        this.error = reason === 'versionchange' ? 'The database version changed. Reload this tab before editing.' : 'Another tab changed the workspace. Your current draft remains visible; reload saved state before editing.'
        this.onExternalChange?.()
      })
    } catch (error) {
      this.status = 'error'; this.error = `Local data could not be opened. Existing records were not overwritten. ${error instanceof Error ? error.message : 'Storage is unavailable.'}`
      throw error
    }
  }
  async apply(command: (snapshot: WorkspaceSnapshot, repository: WorkspaceRepository) => Promise<WorkspaceSnapshot>) {
    const work = async () => {
      if (!this.repository || !this.snapshot) throw new Error('The local workspace is not open.')
      if (this.status === 'conflict') throw new WorkspaceConflict(this.error)
      this.projectLearningCalendar()
      this.status = 'saving'
      const externalAtStart = this.externalChanges
      try {
        const next = await command(this.snapshot, this.repository)
        this.snapshot = next
        this.projectLearningCalendar()
        if (externalAtStart !== this.externalChanges) { this.status = 'conflict'; throw new WorkspaceConflict('Another tab changed the workspace while saving. Reload the saved state before continuing.') }
        this.status = 'saved'; this.error = ''
        return next
      } catch (error) {
        this.status = error instanceof WorkspaceConflict ? 'conflict' : 'error'
        this.error = error instanceof Error ? error.message : 'The save failed. Your draft is still in memory.'
        throw error
      }
    }
    const promise = this.tail.then(work, work)
    this.tail = promise.catch(() => {})
    return promise
  }
  mutate(kind: string, intent: unknown, change: (state: Workspace) => void) {
    return this.apply((snapshot, repository) => repository.mutate(snapshot.version, { id: nid('op'), kind, intent, at: this.mode === 'demo' && snapshot.state.demo?.enabled ? snapshot.state.demo.now : Date.now() }, change))
  }
  async flush() {
    await this.tail
    if (this.status === 'error' || this.status === 'conflict') throw new Error(this.error)
    if (!this.repository) throw new Error('Local storage is unavailable.')
    return this.repository.snapshot()
  }
  async reload() {
    await this.tail
    if (!this.repository) throw new Error('Reload the application to retry opening storage.')
    this.snapshot = await this.repository.snapshot(); this.status = 'saved'; this.error = ''
    await this.refreshLearningCalendar()
    return this.snapshot
  }
  close() { this.unsubscribe?.(); this.repository?.close() }
}
