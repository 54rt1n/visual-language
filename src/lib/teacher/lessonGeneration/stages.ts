import { blindQuestionResultSchema, blindQuestionView } from '../../domain/blindQuestion'
import { visibleQuestionResultSchema, visibleQuestionView } from '../../domain/questionSolve'
import type { QuizQuestion } from '../../learning/quiz'
import { z } from 'zod'
import type { LessonKind, LessonSettings } from '../../domain/lessonPlan'
import { waypointLessonInputSchema, type WaypointLessonInput } from '../../domain/lessonGraph'
import { waypointQuestionSchema } from '../../learning/waypointQuestion'
import { waypointProposalSchema, graphReviewSchema, waypointReviewSchema } from '../lessonGraphTools'
import { questionDirectionsSchema, questionCoverageReviewSchema } from '../questionGapTools'
import { NEXT_WAYPOINT, REVIEW_WAYPOINT, REVIEW_GRAPH, proposeQuestionsInstructions, EVALUATE_COVERAGE,
  BLIND_QUESTION_INSTRUCTIONS, VISIBLE_QUESTION_INSTRUCTIONS, buildWaypointQuestionInstructions, verifyWaypointQuestionInstructions } from './prompts'

export const LESSON_WORKFLOW_VERSION = 'lesson-generation-v43'
export const LESSON_PROMPT_VERSION = 'lesson-guidance-v46'
export const lessonStageIds = ['groundLesson', 'planLesson', 'reviewLessonScope', 'prepareSource', 'reviewSource', 'buildWaypoint', 'reviseWaypoint', 'reviewWaypoint', 'reviewGraph',
  'proposeQuestions', 'buildQuestion', 'reviseQuestion', 'solveVisibleQuestion', 'reviewQuestion', 'solveEnglishQuestion', 'evaluateCoverage'] as const
export type LessonStageId = typeof lessonStageIds[number]
export type LessonStageContext = { kind: LessonKind; settings: LessonSettings; phase?: 'practice' | 'check' } & Record<string, unknown>
export type LessonStage<T extends z.ZodType> = {
  id: LessonStageId; toolName: string; description: string;
  schema: (context: LessonStageContext) => T;
  instructions: (context: LessonStageContext) => string;
  preparation?: boolean;
  nativeExamples?: Array<{ context: Record<string, unknown>; arguments: Record<string, unknown> }> | ((context: LessonStageContext) => Array<{ context: Record<string, unknown>; arguments: Record<string, unknown> }>);
  isolatedContext?: (context: LessonStageContext) => Record<string, unknown>;
}
const nominalCoverageExample = {
  context: { originalRequest: 'Learn greetings and thanks.',
    acceptedScope: { points: [{ id: 'hello', expression: '你好', purpose: 'Greet a visitor.' }, { id: 'thanks', expression: '谢谢', purpose: 'Thank someone for help.' }] },
    graph: { waypoints: [{ id: 'w1', cardIds: ['hello', 'thanks'], objective: 'Greet a visitor.', explanation: '你好 greets a person you meet.', exampleHanzi: '你好。', exampleMeaning: 'Hello.' }] } },
  arguments: { decision: 'revise', reason: 'The example and explanation teach only greeting. Keep the greeting link on w1 and teach thanking in a subsequent point.', waypointId: 'w1' },
}
const defineStage = <T extends z.ZodType>(stage: LessonStage<T>) => stage
const feedbackReviewExample = { context: {
  visibleQuestion: { prompt: '一个人\n\nWhat does this expression mean?', choices: [{ id: 'A', text: 'One person.' }, { id: 'B', text: 'Two people.' }, { id: 'C', text: 'One cup.' }, { id: 'D', text: 'Two cups.' }] },
  candidate: { stem: 'What does this expression mean?', passage: '一个人', answerA: 'One person.', answerB: 'Two people.', answerC: 'One cup.', answerD: 'Two cups.', correct: 'A', feedback: '个 is used for objects and never for people.' },
}, arguments: { decision: 'revise', reason: 'The key is correct, but the feedback is false: 个 also counts people, as in 一个人. Explain the quantity without inventing a restriction.' } }
function phase(context: LessonStageContext) {
  if (!context.phase) throw new Error('A question stage requires a practice or check phase.')
  return context.phase
}

/** Explicit operations, shared across every lesson kind and model profile. */
export const lessonStages = {
  buildWaypoint: defineStage({ id: 'buildWaypoint', toolName: 'add_lesson_waypoint',
    description: 'Submit one complete teaching point for the next waypoint ID.',
    schema: () => waypointProposalSchema, instructions: () => NEXT_WAYPOINT }),
  reviseWaypoint: defineStage({ id: 'reviseWaypoint', toolName: 'revise_lesson_waypoint',
    description: 'Replace one candidate teaching point after review.',
    schema: () => waypointProposalSchema, instructions: () => NEXT_WAYPOINT }),
  reviewWaypoint: defineStage({ id: 'reviewWaypoint', toolName: 'verify_lesson_waypoint',
    description: 'Evaluate one candidate waypoint against the current lesson graph.',
    schema: () => waypointReviewSchema, instructions: () => REVIEW_WAYPOINT,
    nativeExamples: c => (c.acceptedScope || (c.sourceMaterial as WaypointLessonInput['sourceMaterial'])?.scope) ? [{ context: { ...nominalCoverageExample.context, candidate: nominalCoverageExample.context.graph.waypoints[0] }, arguments: { decision: 'revise', reason: nominalCoverageExample.arguments.reason } }] : [] }),
  reviewGraph: defineStage({ id: 'reviewGraph', toolName: 'verify_lesson_graph',
    description: 'Evaluate the current lesson for readiness; identify only one remaining issue.',
    schema: c => {
      const ids = (c.graph as { waypoints: Array<{ id: string }> }).waypoints.map(w => w.id)
      const decisions: Array<z.infer<typeof graphReviewSchema>['decision']> = Array.isArray(c.missingTeachingPoints) && c.missingTeachingPoints.length
        ? ids.length < 9 ? ['add', 'revise', 'reject'] : ['revise', 'reject'] : ['accept', 'add', 'revise', 'reject']
      return graphReviewSchema.extend({
        decision: z.enum(decisions as [typeof decisions[number], ...typeof decisions[number][]]),
        waypointId: (ids.length ? z.enum(ids as [string, ...string[]]) : z.never()).optional()
        .describe('The existing point to revise; supply this field with a revise verdict.') })
    }, instructions: () => REVIEW_GRAPH, nativeExamples: c => (c.acceptedScope || (c.sourceMaterial as WaypointLessonInput['sourceMaterial'])?.scope) ? [nominalCoverageExample] : [] }),
  proposeQuestions: defineStage({ id: 'proposeQuestions', toolName: 'list_missing_questions',
    description: 'Choose one remaining learning point and propose a few question ideas.',
    schema: c => questionDirectionsSchema.extend({
      waypointId: z.enum(c.remainingWaypointIds as [string, ...string[]]),
      cardId: z.enum(waypointLessonInputSchema.shape.targets.parse(c.targets).map(t => t.cardId) as [string, ...string[]]),
    }), instructions: c => proposeQuestionsInstructions(c.settings, phase(c)) }),
  buildQuestion: defineStage({ id: 'buildQuestion', toolName: 'build_question_answers',
    description: 'Write one question, four choices, key and feedback for the selected learning point.',
    schema: c => waypointQuestionSchema(c.settings),
    instructions: c => buildWaypointQuestionInstructions(c.settings, phase(c)) }),
  reviseQuestion: defineStage({ id: 'reviseQuestion', toolName: 'revise_question_answers',
    description: 'Revise only this Q/A group from its review issue.',
    schema: c => waypointQuestionSchema(c.settings),
    instructions: c => `${buildWaypointQuestionInstructions(c.settings, phase(c))}\nCorrect candidateToRevise according to revision. Preserve the selected gap and target. Return only the complete question fields; selection is already fixed.` }),
  solveVisibleQuestion: defineStage({ id: 'solveVisibleQuestion', toolName: 'solve_visible_question',
    description: 'Identify every defensible choice from one visible multiple-choice question.',
    schema: () => visibleQuestionResultSchema, instructions: () => VISIBLE_QUESTION_INSTRUCTIONS,
    isolatedContext: c => visibleQuestionView(c.question as QuizQuestion) }),
  reviewQuestion: defineStage({ id: 'reviewQuestion', toolName: 'verify_correct_question',
    description: 'Evaluate one candidate question; return only a verdict and reason.',
    schema: () => waypointReviewSchema, instructions: c => verifyWaypointQuestionInstructions(c.settings, phase(c)),
    nativeExamples: [feedbackReviewExample] }),
  solveEnglishQuestion: defineStage({ id: 'solveEnglishQuestion', toolName: 'solve_english_question',
    description: 'Record what the English-only question determines, without the hidden expression or key.',
    schema: () => blindQuestionResultSchema, instructions: () => BLIND_QUESTION_INSTRUCTIONS,
    isolatedContext: c => blindQuestionView(c.candidate as Parameters<typeof blindQuestionView>[0]) }),
  evaluateCoverage: defineStage({ id: 'evaluateCoverage', toolName: 'evaluate_question_coverage',
    description: 'Record understandings actually tested by one reviewed question before acceptance.',
    schema: c => {
      const ids = c.recognitionEligibleWaypointIds as string[] | undefined
      const targets = c.eligibleTargetIds as string[] | undefined
      return questionCoverageReviewSchema.extend({
        waypointIds: ids ? z.array(ids.length ? z.enum(ids as [string, ...string[]]) : z.string()).max(ids.length).describe('Eligible waypoint IDs whose understanding is actually tested.') : questionCoverageReviewSchema.shape.waypointIds,
        cardIds: targets ? z.array(targets.length ? z.enum(targets as [string, ...string[]]) : z.string()).max(targets.length).describe('Planned target IDs whose language is actually needed to answer this question. Eligibility is necessary, not sufficient.') : questionCoverageReviewSchema.shape.cardIds,
      })
    }, instructions: () => EVALUATE_COVERAGE }),
} satisfies Partial<Record<LessonStageId, LessonStage<z.ZodType>>>
