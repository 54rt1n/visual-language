import { createWorkspace } from '../../src/lib/domain/workspace'
import type { Exercise, LeitnerCard } from '../../src/lib/domain/learning'
import { DAY } from '../../src/lib/learning/leitner'

export const NOW = Date.UTC(2026, 8, 10, 12)
export const newCard = (overrides: Partial<LeitnerCard> = {}): LeitnerCard => ({ id: 'card', learnerId: 'learner', itemId: 'item', skill: 'production', box: 1,
  status: 'new', introducedAt: null, dueAt: null, lastTransitionAt: null, revision: 0, policyVersion: 'leitner-v1', ...overrides })
export const activeCard = (overrides: Partial<LeitnerCard> = {}): LeitnerCard => newCard({ status: 'active', introducedAt: NOW - DAY, dueAt: NOW, lastTransitionAt: NOW - DAY, revision: 1, ...overrides })
export function workspaceFixture() {
  const state = createWorkspace(NOW)
  state.id = 'workspace'; state.activeLearnerId = 'learner'; state.learners[0]!.id = 'learner'
  state.nodes[0]!.id = 'root'; state.nodes[0]!.rootId = 'root'; state.view.activeRootId = 'root'
  return state
}
export const exerciseProposal = (overrides: Partial<Exercise> = {}) => ({
  format: 'freeAnswer' as const, prompt: 'Write “thank you” in Mandarin.', expectedAnswer: '谢谢', acceptedAlternatives: ['謝謝'],
  rubric: [{ id: 'meaning', description: 'Express thanks using an explicitly accepted Hanzi form.', required: true }], allowedAids: [],
  sourceNodeIds: [], sourceIds: [], answerPolicy: 'exact' as const, promptVersion: 'fixture-v1', provider: 'fixture', model: 'fixture', ...overrides,
})
