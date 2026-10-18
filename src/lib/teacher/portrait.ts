import manifest from '../../../public/avatars/zheng/manifest.json'

export const portraitStates = ['attentive', 'welcome', 'thinking', 'encouraging', 'gentleCorrection'] as const
export type PortraitState = typeof portraitStates[number]
export function portraitState(value: unknown): PortraitState {
  return portraitStates.some(state => state === value) ? value as PortraitState : 'attentive'
}
export function portraitFile(value: unknown) { return `avatars/zheng/${manifest.states[portraitState(value)].file}` }
export function teacherExpression(input: { pending: boolean; failed?: boolean; committed?: boolean; disputed?: boolean; grade?: string; welcoming?: boolean }): PortraitState {
  if (input.pending) return 'thinking'
  if (input.failed || input.disputed) return 'attentive'
  if (input.committed && input.grade === 'correct') return 'encouraging'
  if (input.committed && input.grade === 'incorrect') return 'gentleCorrection'
  return input.welcoming ? 'welcome' : 'attentive'
}
export function availablePortrait(requested: unknown, failed: readonly PortraitState[]) {
  const desired = portraitState(requested)
  return !failed.includes(desired) ? desired : !failed.includes('attentive') ? 'attentive' : undefined
}
