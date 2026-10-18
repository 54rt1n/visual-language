import { discoveryProposalSchema, type DiscoveryProposal, type DiscoveryRequest } from '../../src/lib/domain/discovery'
import { lessonSettingsSchema, quizLevels, type LessonKind, type LessonSettings } from '../../src/lib/domain/lessonPlan'

export const CORPUS_VERSION = 'prepared-lessons-v1'
export { candidateModels, modelMatrix } from './model-matrix'
export const SOURCE_ID = 'authored-source'
export const sourceProvenance = 'Project-authored provisional snapshots. example.org is a fixture citation, not a retrieved webpage. Discovery/search quality is outside this evaluation.'
const phrase = (hanzi: string, meaning: string, explanation: string) => ({ hanzi, meaning, sense: meaning, explanation, exampleHanzi: `${hanzi}。`, exampleMeaning: meaning, sourceIds: [SOURCE_ID] })
type Base = { kind: LessonKind; settings: Omit<LessonSettings, 'quizLevel'>; objective: string; material: DiscoveryProposal; reviewerFocus: string[] }
const bases: Base[] = [
  { kind: 'topic', settings: { complexity: 'phrases', scope: 'everyday', focus: 'characters', topic: 'Courtesy' }, objective: 'Distinguish thanking someone from apologizing.',
    material: { title: 'Everyday courtesy', explanation: 'Authored conversation snapshot about thanks and apologies.', passageHanzi: '谢谢！对不起。', passageMeaning: 'Thank you! Sorry.', sourceIds: [SOURCE_ID], roleplay: null,
      phrases: [phrase('谢谢', 'thank you', 'Thank someone for help.'), phrase('对不起', 'sorry', 'Apologize for a mistake.')] },
    reviewerFocus: ['Thanks and apology are distinguished by communicative intent.', 'Fresh check situations require choosing an intent, not spotting a repeated answer.'] },
  { kind: 'scenario', settings: { complexity: 'simple', scope: 'topic', focus: 'complexity', topic: 'Ordering tea' }, objective: 'Order tea politely and request no sugar in a simulated café.',
    material: { title: 'Ordering tea', explanation: 'Authored café simulation; no real menu claims.', passageHanzi: '请给我一杯茶。不要加糖。', passageMeaning: 'Please give me a cup of tea. Do not add sugar.', sourceIds: [SOURCE_ID],
      roleplay: { situation: 'A simulated café order.', teacherRole: 'Server', learnerRole: 'Customer', openingHanzi: '您想喝什么？', openingMeaning: 'What would you like to drink?', objective: 'Order tea politely and request no sugar.' },
      phrases: [phrase('请给我一杯茶', 'please give me a cup of tea', '请 marks a polite request.'), phrase('不要加糖', 'do not add sugar', '不要 requests that the server not add something.')] },
    reviewerFocus: ['Roles remain server and customer.', 'Distractors contrast relevant order intentions without requiring untaught vocabulary.'] },
  { kind: 'reading', settings: { complexity: 'connected', scope: 'specialist', focus: 'specificity', topic: 'Recycling at an exhibition' }, objective: 'Understand instructions about sorting waste and recycling at an exhibition.',
    material: { title: 'An exhibition notice', explanation: 'Authored reading snapshot, not a current news claim.', passageHanzi: '展览结束后，请分类投放垃圾。纸张可以回收利用，所以请放进回收箱。', passageMeaning: 'After the exhibition, please sort the waste into the appropriate bins. Paper can be recycled, so please put it in the recycling bin.', sourceIds: [SOURCE_ID], roleplay: null,
      phrases: [phrase('分类投放', 'sort and put into the appropriate bins', 'The notice asks visitors to sort waste before placing it in bins.'), phrase('回收利用', 'recycle and reuse', 'The notice explains that paper can be used again through recycling.')] },
    reviewerFocus: ['Questions assess language comprehension rather than environmental trivia.', 'Connected language remains grounded in the supplied notice; check uses a changed reading situation.'] },
]
export type LessonCase = Base & { id: string; settings: LessonSettings; annotationStatus: 'project-authored-provisional'; rawRequest?: Pick<DiscoveryRequest, 'kind' | 'publicTopic'> }
export const lessonCases: LessonCase[] = bases.flatMap(base => (Object.keys(quizLevels) as Array<keyof typeof quizLevels>).map(quizLevel => ({ ...base, id: `${base.kind}-${quizLevel}`, settings: { ...base.settings, quizLevel }, annotationStatus: 'project-authored-provisional' })))
/** Raw entry is deliberately separate from authored-target generation cases. */
export const rawLessonCases: LessonCase[] = [{ ...lessonCases.find(c => c.id === 'topic-meaningPinyin')!,
  id: 'raw-topic-ordering-food', rawRequest: { kind: 'topic', publicTopic: 'Ordering Chinese food' },
  settings: { quizLevel: 'meaningPinyin', complexity: 'simple', scope: 'topic', focus: 'characters', topic: 'Ordering Chinese food' },
  objective: 'Learn useful Mandarin for ordering Chinese food.',
  reviewerFocus: ['The reviewed outline chooses a coherent useful scope from the broad request.',
    'Concrete planned content is actually taught and assessed in both quizzes; ID tags alone are insufficient.'],
}]
export function validateCorpus(cases = lessonCases) {
  if (!cases.length || new Set(cases.map(c => c.id)).size !== cases.length) throw new Error('Choose unique, nonempty lesson cases.')
  for (const entry of cases) {
    lessonSettingsSchema.parse(entry.settings); discoveryProposalSchema.parse(entry.material)
    if ((entry.kind === 'scenario') !== Boolean(entry.material.roleplay)) throw new Error('Scenario source mismatch.')
  }
  return { cases: cases.length, kinds: [...new Set(cases.map(c => c.kind))], formats: [...new Set(cases.map(c => c.settings.quizLevel))] }
}
