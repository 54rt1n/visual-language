import { nid } from '../id'
import { timestamp } from '../domain/common'
import type { Workspace } from '../domain/workspace'
import type { WorkspaceRepository, WorkspaceSnapshot } from '../storage/repository'
import { DAY, isDue } from '../learning/leitner'
import { createDemoWorkspace } from './seed'
import { addDemoLesson } from './lessonMaterial'

export function requireDemo(state: Workspace) {
  if (!state.demo?.enabled) throw new Error('Demo controls cannot change normal learner data.')
  return state.demo
}
function pendingQuestion(state: Workspace, allowLessonPractice = false) {
  return state.sessions.some(s => s.status !== 'completed' && s.activeExerciseId && (!allowLessonPractice || s.lessonAttempt?.activity !== 'practice'))
}
function requireNoQuestion(state: Workspace, allowLessonPractice = false) {
  if (pendingQuestion(state, allowLessonPractice)) throw new Error('Finish, skip, or end the saved question before changing the demo clock or content mode. Its answer and eligibility stay frozen.')
}
export class DemoService {
  constructor(private repository: WorkspaceRepository) {}
  private assert(snapshot: WorkspaceSnapshot) {
    if (this.repository.mode !== 'demo') throw new Error('Demo controls require the isolated demo database.')
    return requireDemo(snapshot.state)
  }
  advance(snapshot: WorkspaceSnapshot, days: number) {
    const demo = this.assert(snapshot)
    if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error('Advance by 1 to 365 whole days.')
    const next = timestamp.parse(demo.now + days * DAY)
    return this.repository.mutate(snapshot.version, { id: nid('op'), kind: 'advance-demo-clock', at: demo.now, intent: { from: demo.now, to: next } }, state => {
      const clock = requireDemo(state); requireNoQuestion(state, true); clock.now = next
    })
  }
  setContentMode(snapshot: WorkspaceSnapshot, contentMode: 'live' | 'fixtures') {
    const demo = this.assert(snapshot)
    if (!['live', 'fixtures'].includes(contentMode)) throw new Error('Choose live or prerecorded demo content.')
    return this.repository.mutate(snapshot.version, { id: nid('op'), kind: 'demo-content-mode', at: demo.now, intent: { contentMode } }, state => {
      requireNoQuestion(state); requireDemo(state).contentMode = contentMode
    })
  }
  addSampleLesson(snapshot: WorkspaceSnapshot) {
    const demo = this.assert(snapshot)
    return this.repository.mutate(snapshot.version, { id: nid('op'), kind: 'add-demo-sample-lesson', at: demo.now, intent: {} }, state => {
      requireDemo(state); addDemoLesson(state)
    })
  }
  reset(snapshot: WorkspaceSnapshot) {
    this.assert(snapshot)
    // UI requires explicit replacement confirmation; the repository retains the
    // entire previous demo, including pending answers, as its recovery checkpoint.
    return this.repository.replace(snapshot.version, createDemoWorkspace())
  }
}
export function demoSummary(state: Workspace) {
  const demo = requireDemo(state)
  return { due: state.cards.filter(c => isDue(c, demo.now)).length, newCards: state.cards.filter(c => c.status === 'new').length,
    boxes: [1, 2, 3, 4, 5].map(box => state.cards.filter(c => c.status === 'active' && c.box === box).length),
    pendingQuestion: pendingQuestion(state), clockBlocked: pendingQuestion(state, true) }
}
