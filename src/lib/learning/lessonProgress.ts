import { lessonForSession, lessonView } from '../domain/lesson'
import type { Workspace } from '../domain/workspace'
import type { LearningSession } from '../domain/learning'
import { quizLevels, complexityLabels, scopeLabels, withPinyin, type LessonSettings } from '../domain/lessonPlan'
import { lessonCheckAnswers, lessonProgression } from './lessonPolicy'

export function lessonReadiness(state: Workspace, session: LearningSession) {
  const plan = lessonView(state, session)
  const teaching = Boolean(plan?.preparation?.lesson)
  const quiz = (phase: 'practice' | 'check') => state.drafts.find(d => d.kind === 'quiz' && d.sessionId === session.id && d.lessonPhase === phase && d.discardedAt === undefined)
  const practice = quiz('practice'), check = quiz('check')
  return { teaching, practice, check, ready: teaching && (plan?.activity === 'review' || plan?.quizOnly || practice?.status === 'validated') && check?.status === 'validated' }
}

/** First submitted answers remain the evidence, including skipped/unresolved slots. */
function checkRows(state: Workspace, session: LearningSession) {
  const answers = session.lessonAttempt?.completion?.answers ?? lessonCheckAnswers(state, session)
  return answers.map(a => ({ cardId: a.cardId, answered: !['skipped', 'unresolved'].includes(a.outcome),
    helped: a.outcome === 'helped', correct: a.outcome === 'correct', skipped: a.outcome === 'skipped' }))
}

export function reviewSettingsForCard(state: Workspace, cardId: string): LessonSettings | undefined {
  return state.sessions.filter(s => s.lessonAttempt?.interactionDay && lessonForSession(state, s)?.cardIds.includes(cardId) && lessonReadiness(state, s).ready)
    .sort((a, b) => b.createdAt - a.createdAt).map(s => lessonForSession(state, s)!.settings).at(0)
}

/** One progression policy serves history, awards and explicit growth suggestions. */
export function growthEvidence(state: Workspace, session: LearningSession) {
  const plan = lessonView(state, session)!
  const progress = lessonProgression(state, plan.id), ready = progress.level === 4
  const settings = plan.settings
  const proposed = settings.focus === 'characters'
    ? withPinyin(settings.quizLevel) ? { ...settings, quizLevel: settings.quizLevel === 'meaningPinyin' ? 'meaningHanzi' as const : 'responseHanzi' as const } : undefined
    : settings.focus === 'complexity'
      ? settings.complexity === 'connected' ? undefined : { ...settings, complexity: settings.complexity === 'phrases' ? 'simple' as const : 'connected' as const }
      : settings.scope === 'specialist' ? undefined : { ...settings, scope: settings.scope === 'everyday' ? 'topic' as const : 'specialist' as const }
  return { ready, ...progress,
    suggestion: ready ? proposed : undefined,
    next: ready ? proposed ? `You have reached Level 4 for this lesson. You could try ${settings.focus === 'characters' ? quizLevels[proposed.quizLevel] : settings.focus === 'complexity' ? complexityLabels[proposed.complexity] : scopeLabels[proposed.scope]}. Keep the other settings the same.` : 'You have reached Level 4 for this lesson. Try related material while keeping this level of support.'
      : `${progress.points}/10 points toward Level 4. Return for a scored review when it is ready; practice is always available.` }
}

export function lessonSummary(state: Workspace, session: LearningSession) {
  const plan = lessonView(state, session)
  if (!plan) return undefined
  const rows = checkRows(state, session)!
  const evidence = growthEvidence(state, session)
  const correct = rows.filter(r => r.correct).length, helped = rows.filter(r => r.helped).length
  const missed = [...new Set(rows.filter(r => !r.correct).map(r => state.items.find(i => i.id === state.cards.find(c => c.id === r.cardId)?.itemId)?.canonicalText).filter(Boolean))]
  return { total: rows.length, correct, helped, unanswered: rows.filter(r => !r.answered).length,
    skipped: rows.filter(r => r.skipped).length, missed, format: quizLevels[plan.settings.quizLevel],
    complexity: complexityLabels[plan.settings.complexity], scope: scopeLabels[plan.settings.scope], topic: plan.settings.topic,
    evidence, next: missed.length ? 'Revisit the phrases that needed support. You can try the lesson again whenever you’re ready.' : evidence.next,
  }
}

export function lessonStep(state: Workspace, session: LearningSession) {
  const plan = lessonView(state, session), step = plan?.steps[plan.stepIndex]
  return step ? { ...step, stage: step.phase } : undefined
}

export function lessonStepCount(state: Workspace, session: LearningSession) {
  return lessonView(state, session)?.steps.length ?? 0
}
