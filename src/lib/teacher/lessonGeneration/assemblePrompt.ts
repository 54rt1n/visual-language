import type { ChatMessage, ToolDefinition } from '../../ai/types'
import { toolPrompt } from '../toolPrompt'
import { LEARNER_REQUEST, REPAIR_EXPLANATION, WAYPOINT_RULES, waypointLessonInstructions, waypointAssessmentInstructions } from './prompts'
import type { LessonStageContext } from './stages'
import type { LessonTaskPlacement, NativeLessonExample } from './modelProfiles'

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
  const lessonGuidance = isolatedContext || options.preparation ? '' : `${WAYPOINT_RULES}\n${waypointLessonInstructions(context.kind)}\n`
  const currentTask = `${isolatedContext || options.preparation ? '' : `${waypointAssessmentInstructions(context.settings)}\n`}${task}`
  const system = `${prompt.description}\n\n${LEARNER_REQUEST}\n${lessonGuidance}${taskPlacement === 'system' ? currentTask : ''}`
    // Isolated solvers use the offered tool description/footer for protocol.
    // Arbitrary profile guidance may contain semantic examples or answer clues.
    + (!isolatedContext && modelGuidance ? `\n\nModel guidance:\n${modelGuidance}` : '')
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
    const projected: Record<string, unknown> = { learnerRequest: LEARNER_REQUEST, ...(isolatedContext ?? { ...context, generationMode: tool.name }),
      ...(nativeSubmissionIssue ? { nativeSubmissionIssue } : {}),
      ...(correctedCandidate === undefined ? {} : { candidateSubmission: correctedCandidate }) }
    if (taskPlacement === 'user_context_tail') {
      // Reserve this app-owned field and append it even if input carried the key.
      delete projected.currentTask
      projected.currentTask = currentTask
    }
    return { role: 'user', content: JSON.stringify(projected) + footer }
  }
  const examples: ChatMessage[] = !isolatedContext && dialect === 'native'
    ? (options.nativeExamples ?? []).flatMap((example, index): ChatMessage[] => {
      const id = `lesson-example-${index + 1}`
      return [{ role: 'user', content: JSON.stringify(example.context) },
        { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: tool.name, arguments: JSON.stringify(example.arguments) } }] },
        { role: 'tool', tool_call_id: id, content: 'Worked example recorded.' }]
    }) : []
  const prefix: ChatMessage[] = [{ role: 'system', content: system }, ...examples]
  return { messages: [...prefix, project()], project, prefix }
}
