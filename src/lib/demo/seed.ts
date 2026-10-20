import { createWorkspace, validateWorkspace, type Workspace } from '../domain/workspace'
import type { Exercise, LeitnerCard } from '../domain/learning'
import { DAY, introduce, review } from '../learning/leitner'
import { deterministicAssessment } from '../learning/assessment'
import { completeWorkedExample } from '../teacher/feedback'
import { DEMO_ITEMS, DEMO_MODEL, DEMO_NOW, type DemoMaterial } from './material'
import { addDemoLesson } from './lessonMaterial'

export function rehearsalProposal(material: DemoMaterial, skill: LeitnerCard['skill'], practice = false): Omit<Exercise, 'id' | 'sessionId' | 'cardId' | 'cardRevision' | 'mode' | 'presentedAt'> {
  const meaning = skill === 'meaning'
  return { format: 'freeAnswer', prompt: meaning ? 'What does 请问 mean? Give a short English gloss using the wording you learned. This is a closed-answer rehearsal.' : practice ? material.corrective : material.prompt,
    expectedAnswer: meaning ? material.meaning : material.text, acceptedAlternatives: meaning ? ['excuse me'] : [],
    rubric: [{ id: 'saved-expression', required: true, description: 'Recall the saved expression under this closed, exact-answer rehearsal rubric; this is not open-ended semantic grading.' }], allowedAids: [],
    sourceNodeIds: [`${material.root}-reply`], sourceIds: [`${material.id}-source`], answerPolicy: 'exact', provider: 'fixture', model: DEMO_MODEL, promptVersion: 'prerecorded-demo-v1',
    workedExample: completeWorkedExample({ hanzi: material.example, meaning: material.translation, explanation: material.explanation }) }
}

/** Pure seeded history, built with the real policy transitions and validated as
 * a complete workspace. Nothing here is written to the normal learner database. */
export function createDemoWorkspace(): Workspace {
  const state = createWorkspace(DEMO_NOW - 12 * DAY), learner = state.learners[0]!
  state.name = 'Demo · Mandarin'; state.demo = { enabled: true, now: DEMO_NOW, contentMode: 'fixtures' }
  learner.goal = 'Order tea politely, ask for directions, and use everyday courtesy.'
  state.nodes = []; state.edges = []
  for (const [index, root] of ['demo-everyday', 'demo-travel'].entries()) {
    state.nodes.push({ id: root, rootId: root, type: 'root', position: { x: index * 1400, y: 0 }, bookmarked: false, collapsed: false, data: { name: index ? 'DEMO · Getting around' : 'DEMO · Everyday Mandarin' } },
      { id: `${root}-question`, rootId: root, type: 'user', position: { x: index * 1400, y: 170 }, bookmarked: false, collapsed: false, data: { text: index ? 'Help me find the subway and say goodbye.' : 'Help me order tea politely and thank someone.' } },
      { id: `${root}-reply`, rootId: root, type: 'assistant', position: { x: index * 1400, y: 360 }, bookmarked: true, collapsed: false,
        data: { text: DEMO_ITEMS.filter(m => m.root === root).map(m => `${m.text} — ${m.meaning}.\n${m.explanation}`).join('\n\n'), reasoning: '', state: 'complete', error: '', provider: 'fixture', model: DEMO_MODEL } })
    state.edges.push({ id: `${root}-question-edge`, source: root, target: `${root}-question`, data: { kind: 'conversation' } }, { id: `${root}-reply-edge`, source: `${root}-question`, target: `${root}-reply`, data: { kind: 'conversation' } })
  }
  for (const [index, material] of DEMO_ITEMS.entries()) {
    state.items.push({ id: material.id, language: 'zh', kind: 'phrase', canonicalText: material.text, meaning: material.meaning, senseKey: material.meaning, pinyin: material.pinyin,
      sourceNodeIds: [`${material.root}-reply`], sourceRootIds: [material.root], createdAt: state.createdAt })
    state.sources.push({ id: `${material.id}-source`, kind: 'local', title: `Prerecorded demo: ${material.meaning}`, excerpt: `${material.text} (${material.pinyin}) — ${material.meaning}. ${material.explanation}`, retrievedAt: state.createdAt, nodeId: `${material.root}-reply`, cardId: `${material.id}-card` })
    const root = state.nodes.find(n => n.id === material.root)!
    state.nodes.push({ id: `${material.id}-chunk`, rootId: material.root, type: 'chunk', position: { x: root.position.x + 400, y: 360 + index * 200 }, bookmarked: false, collapsed: false,
      data: { text: material.text, pinyin: material.pinyin, meaning: material.meaning, itemId: material.id } })
    state.edges.push({ id: `${material.id}-derived`, source: `${material.root}-reply`, target: `${material.id}-chunk`, data: { kind: 'derived' } })
    let card: LeitnerCard = { id: `${material.id}-card`, learnerId: learner.id, itemId: material.id, skill: material.skill, box: 1, status: 'new', policyVersion: 'leitner-v1', introducedAt: null, dueAt: null, lastTransitionAt: null, revision: 0 }
    const start = material.id === 'demo-thanks' || material.id === 'demo-metro' ? DEMO_NOW - 2 * DAY : DEMO_NOW - 12 * DAY
    if (material.id !== 'demo-goodbye') {
      const before = card; card = introduce(card, start)
      state.events.push({ id: `${card.id}-introduced`, cardId: card.id, kind: 'introduced', occurredAt: start, policyVersion: 'leitner-v1', before, after: card })
      const days = material.id === 'demo-tea' ? [1, 2, 5] : material.id === 'demo-metro' ? [1] : material.id === 'demo-excuse' ? [1, 4, 11] : []
      for (const [i, day] of days.entries()) {
        const at = start + day * DAY, wrong = material.id === 'demo-tea' && i === 0, before = card
        const exerciseId = `${card.id}-seed-exercise-${i}`, attemptId = `${card.id}-seed-attempt-${i}`, sessionId = `${card.id}-seed-session-${i}`
        const exercise: Exercise = { ...rehearsalProposal(material, card.skill), id: exerciseId, sessionId, cardId: card.id, cardRevision: card.revision, mode: 'dueReview', presentedAt: at }
        const answer = wrong ? '我要咖啡' : exercise.expectedAnswer, assessment = deterministicAssessment(exercise, answer)!
        if (wrong) assessment.feedback = 'Prerecorded prior mistake: coffee was requested instead of tea. The saved phrase politely asks for one cup of tea.'
        card = review(card, wrong ? 'notRecalled' : 'recalled', at, true)
        state.sessions.push({ id: sessionId, learnerId: learner.id, rootId: material.root, createdAt: at, updatedAt: at, status: 'completed', selectedCardIds: [card.id], completedCardIds: [card.id], skippedCardIds: [], introducedItemIds: [], activeExerciseId: null, maxReviewCards: 10, maxNewItems: 3, goal: 'Prerecorded policy-valid rehearsal history, not learner achievement.' })
        state.exercises.push(exercise); state.attempts.push({ id: attemptId, exerciseId, cardId: card.id, submittedAt: at, answer, helpUsed: false, status: 'committed', assessment, assessmentSource: 'deterministic' })
        state.events.push({ id: `${card.id}-seed-event-${i}`, cardId: card.id, exerciseId, attemptId, kind: 'review', outcome: wrong ? 'notRecalled' : 'recalled', occurredAt: at, policyVersion: 'leitner-v1', before, after: card })
        if (wrong) {
          state.nodes.push({ id: 'demo-prior-mistake', rootId: material.root, type: 'exercise', position: { x: root.position.x + 820, y: 400 }, bookmarked: true, collapsed: false, data: { exerciseId } })
          state.edges.push({ id: 'demo-prior-mistake-edge', source: `${material.root}-reply`, target: 'demo-prior-mistake', data: { kind: 'derived' } })
        }
      }
    }
    state.cards.push(card)
  }
  state.view.activeRootId = 'demo-everyday'; state.view.selectedNodeIds = ['demo-everyday']; state.view.viewport = { x: 320, y: 180, zoom: 0.65 }
  addDemoLesson(state)
  return validateWorkspace(state)
}
