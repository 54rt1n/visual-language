import type { WorkspaceState } from '../state/workspace.svelte'
import type { WorkspaceSnapshot } from '../storage/repository'
import type { TeacherHost } from './teacherService'
import type { Clock } from '../learning/leitner'

export function workspaceClock(workspace: WorkspaceState): Clock {
  return { now: () => workspace.mode === 'demo' && workspace.snapshot?.state.demo?.enabled ? workspace.snapshot.state.demo.now : Date.now() }
}
export function teacherHost(workspace: WorkspaceState, onChanged: (snapshot: WorkspaceSnapshot) => void): TeacherHost {
  return {
    current() { if (!workspace.snapshot) throw new Error('The workspace is not open.'); return workspace.snapshot },
    async apply(command) { const next = await workspace.apply(command); onChanged(next); return next },
  }
}
