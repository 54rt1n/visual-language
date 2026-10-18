import type { Workspace } from './workspace'

export type WorkspaceMode = 'normal' | 'demo'
export const WORKSPACE_DATABASES = { normal: 'visual-language-workspace-v1', demo: 'visual-language-demo-v1' } as const
export const modeOf = (state: Workspace): WorkspaceMode => state.demo?.enabled ? 'demo' : 'normal'
export function assertWorkspaceMode(mode: WorkspaceMode, state: Workspace) {
  if (modeOf(state) !== mode) throw new Error(mode === 'normal'
    ? 'This is a demo workspace. Open Demo & rehearsal and switch to the isolated demo before loading it. Normal learning data was not changed.'
    : 'This is a normal learning workspace. Leave demo mode before loading it. Demo time must never apply to real learner records.')
}
export const modeFromHash = (hash: string): WorkspaceMode => hash === '#demo' ? 'demo' : 'normal'
