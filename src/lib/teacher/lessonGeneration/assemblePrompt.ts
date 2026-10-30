import type { ChatMessage, ToolDefinition } from '../../ai/types'
import { toolPrompt } from '../toolPrompt'
import { LEARNER_REQUEST, REPAIR_EXPLANATION, WAYPOINT_RULES, waypointLessonInstructions, waypointAssessmentInstructions } from './prompts'
import type { LessonStageContext } from './stages'
import type { LessonTaskPlacement, NativeLessonExample } from './modelProfiles'
import { preparationEvidence, preparationSettings } from './preparationPrompt'

type LessonPromptOptions = {
  modelGuidance?: string
  dialect?: 'native' | 'qwen_xml'
  isolatedContext?: Record<string, unknown>
  taskPlacement?: LessonTaskPlacement
  preparation?: boolean
  nativeExamples?: NativeLessonExample[]
}

/** Descriptions first, projected evidence next, schema-derived hint last. */
export function assembleLessonPrompt(tool: ToolDefinition['function'], context: LessonStageContext, task: string, options: LessonPromptOptions = {}) {
  const { modelGuidance = '', dialect = 'native', isolatedContext, taskPlacement = 'system' } = options
  const prompt = toolPrompt(tool, dialect)
  const readableQuiz = !isolatedContext && ['list_missing_questions', 'build_question_answers', 'revise_question_answers', 'verify_correct_question', 'evaluate_question_coverage'].includes(tool.name) && dialect === 'native'
  const lessonGuidance = isolatedContext || options.preparation ? '' : `${WAYPOINT_RULES}\n${waypointLessonInstructions(context.kind)}\n`
  const currentTask = `${isolatedContext || options.preparation ? '' : `${waypointAssessmentInstructions(context.settings)}\n`}${task}`
  const examples = !isolatedContext && dialect === 'native'
    ? (options.nativeExamples ?? []).map((example, index) =>
      `Example ${index + 1} (reference material)\nInput: ${JSON.stringify(example.context)}\n${tool.name} arguments: ${JSON.stringify(example.arguments)}`).join('\n\n') : ''
  const system = `${prompt.description}\n\n${LEARNER_REQUEST}\n${lessonGuidance}${!readableQuiz && taskPlacement === 'system' && (!options.preparation || dialect === 'qwen_xml') ? currentTask : ''}`
    // Isolated solvers use the offered tool description/footer for protocol.
    // Arbitrary profile guidance may contain semantic examples or answer clues.
    + (!isolatedContext && modelGuidance ? `\n\nModel guidance:\n${modelGuidance}` : '')
    + (examples ? `\n\nWorked examples for this operation:\n${examples}` : '')
  const project = (nativeSubmissionIssue?: string, candidateSubmission?: unknown): ChatMessage => {
    // Target diagnostic verbosity only; authoring and protocol repairs keep their original instructions.
    const candidate = candidateSubmission && typeof candidateSubmission === 'object'
      ? candidateSubmission as Record<string, unknown> : undefined
    const properties = tool.parameters.properties as Record<string, { type?: string; maxLength?: number }> | undefined
    const overlongFields = nativeSubmissionIssue ? ['reason', 'assessment'].filter(field => {
      const value = candidate?.[field], limit = properties?.[field]?.maxLength
      return typeof value === 'string' && typeof limit === 'number' && value.length > limit
    }) : []
    const correctedCandidate = overlongFields.length
      ? Object.fromEntries(Object.entries(candidate!).filter(([field]) => !overlongFields.includes(field))) : candidateSubmission
    const footer = overlongFields.length
      ? prompt.footer.replace('\n\nTool call:\n', `\n\nTool call:\n${REPAIR_EXPLANATION}\n`) : prompt.footer
    const projected: Record<string, unknown> = { ...(!options.preparation ? { learnerRequest: LEARNER_REQUEST } : {}), ...(isolatedContext ?? { ...context, generationMode: tool.name }),
      ...(nativeSubmissionIssue ? { nativeSubmissionIssue } : {}),
      ...(correctedCandidate === undefined ? {} : { candidateSubmission: correctedCandidate }) }
    if (taskPlacement === 'user_context_tail' && !readableQuiz) {
      // Reserve this app-owned field and append it even if input carried the key.
      delete projected.currentTask
      projected.currentTask = currentTask
    }
    return { role: 'user', content: readableQuiz
      ? `Current lesson\n\n${preparationEvidence(projected)}\n\nCurrent task: ${nativeSubmissionIssue
        ? `Correct the rejected candidateSubmission. ${nativeSubmissionIssue}\nPreserve its valid fields and submit the complete corrected arguments through ${tool.name}.`
        : currentTask}${footer}`
      : options.preparation
      ? `Current lesson\n\n${preparationEvidence({ ...projected, settings: preparationSettings(context.settings) })}\n\nCurrent task: ${currentTask}${footer}`
      : JSON.stringify(projected) + footer }
  }
  const prefix: ChatMessage[] = [{ role: 'system', content: system }]
  return { messages: [...prefix, project()], project, prefix }
}
