import { createLessonPlan, type LessonSettings, type QuizLevel } from '../../src/lib/domain/lessonPlan'
import { presentQuizQuestion, quizDraftSchema, type QuizQuestion } from '../../src/lib/learning/quiz'
import { mandarinPinyin } from '../../src/lib/mandarin/chineseParser'
import type { QuizContentReview } from '../../src/lib/teacher/contracts'
import type { priorQuizQuestions } from '../../src/lib/teacher/lessonPrompts'

type Criterion = Exclude<keyof QuizContentReview['questions'][number], 'cardId' | 'evidence'>
type Seed = { hanzi: string; meaning: string; alternatives: Array<[string, string]>; stem?: string; complexity?: LessonSettings['complexity']; level?: QuizLevel }
function input(seed: Seed) {
  const level = seed.level ?? 'meaningHanzi', english = level.startsWith('meaning')
  const settings: LessonSettings = { quizLevel: level, complexity: seed.complexity ?? 'phrases', scope: 'everyday', focus: 'complexity', topic: 'Everyday communication' }
  const choices = [[seed.hanzi, seed.meaning], ...seed.alternatives]
  const question: QuizQuestion = {
    cardId: 'target-1', stem: seed.stem ?? 'What does the expression mean?', ...(english ? { passage: seed.hanzi } : {}),
    options: choices.map((pair, i) => ({ id: `choice-${i + 1}`, text: pair[english ? 1 : 0]! })), correctOptionId: 'choice-1',
    explanation: `The expression means “${seed.meaning}”.`, objective: 'Recognize the meaning of the taught expression.',
    distractorFeedback: seed.alternatives.map((pair, i) => ({ optionId: `choice-${i + 2}`, explanation: `This choice means “${pair[1]}”, which differs from the expression being tested.` })),
    sourceIds: ['source-1'], workedExample: { hanzi: seed.hanzi, meaning: seed.meaning, explanation: `Use this expression to convey “${seed.meaning}”.` },
  }
  const plan = createLessonPlan(['target-1'], settings, english ? 'topic' : 'scenario')
  return {
    generationMode: 'reviewLessonQuiz', phase: 'practice' as 'practice' | 'check', objective: question.objective,
    lessonPlan: plan, quiz: { title: 'Practice', questions: [presentQuizQuestion(question, level)] },
    sources: [{ id: 'source-1', kind: 'local', title: 'Authored lesson vocabulary', excerpt: choices.map(p => `${p[0]} — ${p[1]}`).join('\n') }],
    targets: [{ cardId: 'target-1', hanzi: seed.hanzi, pinyin: mandarinPinyin(seed.hanzi), meaning: seed.meaning, sense: seed.meaning, skill: 'recognition', level: settings.complexity === 'connected' ? 'intermediate' : 'beginner', explanationLanguage: 'English' }],
    lessonGuidance: { overview: 'Recognize these expressions.', introductions: choices.map(p => ({ exampleHanzi: p[0], exampleMeaning: p[1], explanation: `The expression means “${p[1]}”.` })) },
    practiceQuiz: undefined as ReturnType<typeof priorQuizQuestions>,
  }
}
export type ReviewInput = ReturnType<typeof input>
export type ReviewCase = { id: string; split: 'calibration' | 'regression' | 'holdout' | 'replay'; expected: 'accept' | 'reject'; mustFail?: { cardId: string; criterion: Criterion }; rationale: string; input: ReviewInput }
const thanks = input({ hanzi: '谢谢。', meaning: 'Thank you.', alternatives: [['对不起。', 'Sorry.'], ['你好。', 'Hello.'], ['再见。', 'Goodbye.']] })
// Matched controls for observed invented-event failures. A neutral setting does
// not establish a preceding action; explicitly hypothetical teaching is allowed.
const neutralThanks = structuredClone(thanks)
neutralThanks.quiz.questions[0]!.stem = 'At a reception desk, a visitor says this. What does the expression mean?'
const hypotheticalThanks = structuredClone(neutralThanks)
hypotheticalThanks.quiz.questions[0]!.explanation = 'This expresses thanks. For example, you could say it after someone helps you.'
const water = input({ hanzi: '我想喝水。', meaning: 'I want to drink water.', complexity: 'simple', level: 'meaningPinyin', alternatives: [['我想喝茶。', 'I want to drink tea.'], ['我不想喝水。', 'I do not want to drink water.'], ['我想吃饭。', 'I want to eat.']] })
const sugar = input({ hanzi: '不要加糖。', meaning: 'Do not add sugar.', complexity: 'simple', level: 'responsePinyin', stem: 'You want your tea without sugar. Which reply says that?', alternatives: [['请加糖。', 'Please add sugar.'], ['请给我一杯茶。', 'Please give me a cup of tea.'], ['谢谢，再见。', 'Thank you, goodbye.']] })
const rain = input({ hanzi: '下雨了，所以我带伞。', meaning: 'It is raining, so I am bringing an umbrella.', complexity: 'connected', alternatives: [['下雨了，所以我不出门。', 'It is raining, so I am not going out.'], ['天晴了，所以我不带伞。', 'It is sunny, so I am not bringing an umbrella.'], ['下雨了，所以我关窗。', 'It is raining, so I am closing the window.']] })
const greeting = input({ hanzi: '你好。', meaning: 'Hello.', alternatives: [['谢谢。', 'Thank you.'], ['再见。', 'Goodbye.'], ['对不起。', 'Sorry.']] })
const ticket = input({ hanzi: '请给我一张票。', meaning: 'Please give me one ticket.', complexity: 'simple', level: 'responseHanzi', stem: 'You want to ask for one ticket. Which reply asks for that?', alternatives: [['请给我两张票。', 'Please give me two tickets.'], ['我不要票。', 'I do not want a ticket.'], ['谢谢，再见。', 'Thank you, goodbye.']] })
const quiet = input({ hanzi: '请保持安静。', meaning: 'Please keep quiet.', complexity: 'simple', level: 'meaningPinyin', alternatives: [['请勿拍照。', 'Please do not take photos.'], ['请在这里等。', 'Please wait here.'], ['请关门。', 'Please close the door.']] })
const library = input({ hanzi: '这里是图书馆，所以请保持安静。', meaning: 'This is a library, so please keep quiet.', complexity: 'connected', alternatives: [['这里是餐厅，所以请排队。', 'This is a restaurant, so please queue.'], ['图书馆关门了，所以请明天来。', 'The library is closed, so please come tomorrow.'], ['这里有座位，所以请坐下。', 'There is a seat here, so please sit down.']] })
function entry(id: string, split: ReviewCase['split'], base: ReviewInput, rationale: string, mutate?: (value: ReviewInput) => void, mustFail?: Criterion): ReviewCase {
  const value = structuredClone(base); mutate?.(value)
  return { id, split, expected: mutate ? 'reject' : 'accept', ...(mustFail ? { mustFail: { cardId: value.quiz.questions[0]!.cardId, criterion: mustFail } } : {}), rationale, input: value }
}
// New calibration pairs reproduce observed failure classes without provider IDs
// or expected labels in the request. They are authored examples, not live output.
const tea = input({ hanzi: '请给我一杯茶。', meaning: 'Please give me a cup of tea.', complexity: 'simple', level: 'responseHanzi', stem: 'You are the customer at a café. Which reply politely orders one cup of tea?', alternatives: [['请给我一杯咖啡。', 'Please give me a cup of coffee.'], ['我不要茶。', 'I do not want tea.'], ['谢谢，再见。', 'Thank you, goodbye.']] })
function combine(first: ReviewInput, second: ReviewInput): ReviewInput {
  const a = structuredClone(first), b = structuredClone(second)
  b.quiz.questions[0]!.cardId = 'target-2'; b.quiz.questions[0]!.sourceIds = ['source-2']
  b.targets[0]!.cardId = 'target-2'; b.sources[0]!.id = 'source-2'
  a.quiz.questions.push(...b.quiz.questions); a.targets.push(...b.targets); a.sources.push(...b.sources)
  a.lessonGuidance.introductions.push(...b.lessonGuidance.introductions)
  a.lessonPlan = createLessonPlan(a.targets.map(t => t.cardId), a.lessonPlan.settings, 'scenario')
  a.objective = 'Order a drink and specify a preference.'
  return a
}
const teaAndSugar = combine(tea, { ...sugar, quiz: { ...sugar.quiz, questions: sugar.quiz.questions.map(q => presentQuizQuestion(q, 'responseHanzi')) } })
const paper = input({ hanzi: '纸张可以回收利用。', meaning: 'Paper can be recycled and reused.', complexity: 'connected', alternatives: [['纸张不能回收利用。', 'Paper cannot be recycled and reused.'], ['请把纸张带走。', 'Please take the paper away.'], ['请把纸张交给工作人员。', 'Please give the paper to a staff member.']] })
paper.lessonPlan = createLessonPlan(['target-1'], paper.lessonPlan.settings, 'reading')
paper.sources[0] = { id: 'source-1', kind: 'local', title: 'Exhibition notice', excerpt: '纸张可以回收利用，所以请放进回收箱。 — Paper can be recycled and reused, so please put it in the recycling bin. 回收利用 means recycle and reuse.' }
paper.targets[0]!.hanzi = '回收利用'; paper.targets[0]!.pinyin = mandarinPinyin('回收利用'); paper.targets[0]!.meaning = paper.targets[0]!.sense = 'recycle and reuse'
paper.quiz.questions[0]!.stem = 'What does the notice say about paper?'

// Fresh holdout: freeze before running the next reviewer candidate. Do not use
// these outcomes to tune a prompt and still report them as untouched evidence.
const noodles = input({ hanzi: '请给我一碗面。', meaning: 'Please give me a bowl of noodles.', complexity: 'simple', level: 'responsePinyin', stem: 'You are ordering one bowl of noodles. Which reply politely asks for it?', alternatives: [['请给我一碗饭。', 'Please give me a bowl of rice.'], ['我不要面。', 'I do not want noodles.'], ['谢谢，再见。', 'Thank you, goodbye.']] })
const borrow = input({ hanzi: '这本书可以外借。', meaning: 'This book may be borrowed.', complexity: 'simple', alternatives: [['这本书不能外借。', 'This book may not be borrowed.'], ['请在这里看书。', 'Please read here.'], ['图书馆今天关门。', 'The library is closed today.']] })
borrow.lessonPlan = createLessonPlan(['target-1'], borrow.lessonPlan.settings, 'reading')
borrow.sources[0] = { id: 'source-1', kind: 'local', title: 'Notice attached to a book', excerpt: '这本书可以外借。 — This book may be borrowed. 外借 means to lend out for use away from the library.' }
borrow.quiz.questions[0]!.stem = 'What does the notice attached to this book say?'
const tomorrow = input({ hanzi: '明天见。', meaning: 'See you tomorrow.', level: 'meaningPinyin', alternatives: [['早上好。', 'Good morning.'], ['谢谢。', 'Thank you.'], ['对不起。', 'Sorry.']] })
const twoTargets = combine(noodles, input({ hanzi: '不要加辣椒。', meaning: 'Do not add chili pepper.', complexity: 'simple', level: 'responsePinyin', stem: 'You want your noodles without chili pepper. Which reply requests that?', alternatives: [['请加辣椒。', 'Please add chili pepper.'], ['请给我一碗面。', 'Please give me a bowl of noodles.'], ['谢谢，再见。', 'Thank you, goodbye.']] }))
export const reviewCases: ReviewCase[] = [
  entry('courtesy-phrase-valid', 'calibration', thanks, 'One taught expression, faithful translation and a unique meaning.'),
  entry('drink-simple-valid', 'calibration', water, 'One taught clause; pinyin is app-derived.'),
  entry('sugar-reply-valid', 'calibration', sugar, 'The only reply that declines sugar is the taught negative request.'),
  entry('rain-connected-valid', 'calibration', rain, 'Two causally linked clauses are appropriate at connected complexity.'),
  entry('courtesy-narrative-too-hard', 'calibration', thanks, 'The full passage contains several untaught actions, not a familiar phrase.', v => {
    v.quiz.questions[0]!.passage = '朋友把咖啡递给你，你接过杯子以后说：“谢谢！”'
  }, 'levelAppropriate'),
  entry('sugar-referent-changed', 'calibration', sugar, 'A request not to add sugar does not literally decline honey.', v => {
    v.quiz.questions[0]!.stem = 'The server offers to add honey to your tea. Which reply refuses the honey?'
  }, 'oneCorrectAnswer'),
  entry('courtesy-invented-origin', 'calibration', thanks, 'The source gives meanings, not character origins.', v => {
    v.quiz.questions[0]!.workedExample!.explanation = 'The character was invented as a picture of someone handing over a present, which is why this expression means thank you.'
  }, 'sourceSupported'),
  entry('drink-english-answer-leak', 'calibration', water, 'The stem translates the answer; Mandarin understanding is unnecessary.', v => {
    v.quiz.questions[0]!.stem = 'The speaker says they want to drink water. Which English option gives that meaning?'
  }, 'answerHidden'),
  entry('greeting-phrase-valid', 'regression', greeting, 'A short greeting is within phrase complexity.'),
  entry('ticket-reply-valid', 'regression', ticket, 'One vs two tickets and refusal distinguish the options.'),
  entry('library-simple-valid', 'regression', quiet, 'One short instruction is appropriate at simple complexity.'),
  entry('library-connected-valid', 'regression', library, 'The taught reason and request form two linked clauses.'),
  entry('greeting-narrative-too-hard', 'regression', greeting, 'An embedded greeting does not make the whole untaught narrative phrase-level.', v => {
    v.quiz.questions[0]!.passage = '你走进办公室，看到同事正在整理文件，于是向他挥手说：“你好！”'
  }, 'levelAppropriate'),
  entry('ticket-two-valid-replies', 'regression', ticket, 'Two identical requests with and without thanks both satisfy the stem.', v => {
    v.quiz.questions[0]!.options[1]!.text = '请给我一张票，谢谢。'
    v.quiz.questions[0]!.distractorFeedback[0]!.explanation = 'This adds thanks, but the expected reply omits thanks.'
  }, 'oneCorrectAnswer'),
  entry('library-wrong-translation', 'regression', quiet, 'The worked-example translation contradicts the supplied source.', v => {
    v.quiz.questions[0]!.workedExample!.meaning = 'Please speak loudly.'
  }, 'sourceSupported'),
  entry('library-check-repeats-practice', 'regression', library, 'A check duplicates the entire practice question, so it does not test transfer.', v => {
    v.phase = 'check'; v.practiceQuiz = structuredClone(v.quiz)
  }, 'lessonAligned'),
  entry('tea-natural-options-valid', 'calibration', tea, 'Natural wrong replies express a different order or intention.'),
  entry('tea-misleading-role-feedback', 'calibration', tea, 'The added pronoun does not establish that the customer is handing tea to the server.', v => {
    v.quiz.questions[0]!.options[1]!.text = '请给你一杯茶。'
    v.quiz.questions[0]!.distractorFeedback[0]!.explanation = '给你 means give you, so you would be handing tea to the server instead of ordering it.'
  }, 'sourceSupported'),
  entry('cafe-two-targets-valid', 'calibration', teaAndSugar, 'Each target has its own correct key, literal contrasts and accurate feedback.'),
  { ...entry('cafe-second-feedback-wrong', 'calibration', teaAndSugar, 'Only the second question mistranslates its sugar option as honey.', v => {
    v.quiz.questions[1]!.distractorFeedback[0]!.explanation = '请加糖 means please add honey, so it asks for honey.'
  }, 'sourceSupported'), mustFail: { cardId: 'target-2', criterion: 'sourceSupported' } },
  entry('paper-source-valid', 'calibration', paper, 'The stimulus and example retain the material named in the notice.'),
  entry('paper-new-material-claim', 'calibration', paper, 'The feedback attributes a plastic-bottle claim to a paper-only notice.', v => {
    v.quiz.questions[0]!.workedExample = { hanzi: '塑料瓶可以回收利用。', meaning: 'Plastic bottles can be recycled and reused.', explanation: 'This exhibition notice specifically says plastic bottles can be recycled.' }
  }, 'sourceSupported'),
  entry('noodles-reply-valid', 'holdout', noodles, 'A natural quantity-specific order has one supported reply.'),
  entry('noodles-two-correct-replies', 'holdout', noodles, 'Both versions place the same order; adding thanks does not make a reply wrong.', v => {
    const q = v.quiz.questions[0]!
    q.options[1]!.text = '请给我一碗面，谢谢。'; q.options[1]!.pinyin = mandarinPinyin(q.options[1]!.text)
    q.distractorFeedback[0]!.explanation = 'The expected answer does not include thanks.'
  }, 'oneCorrectAnswer'),
  entry('borrow-source-valid', 'holdout', borrow, 'A notice about one book supports that book-specific interpretation.'),
  entry('borrow-unsupported-magazines', 'holdout', borrow, 'A claim about every magazine is falsely attributed to a notice attached to one book.', v => {
    v.quiz.questions[0]!.workedExample = { hanzi: '这里的杂志都可以外借。', meaning: 'All the magazines here may be borrowed.', explanation: 'The notice confirms that all magazines in this library may be borrowed.' }
  }, 'sourceSupported'),
  entry('tomorrow-pinyin-valid', 'holdout', tomorrow, 'Pronunciation and translation match the brief farewell.'),
  entry('tomorrow-wrong-tone', 'holdout', tomorrow, 'The displayed third tone for 见 conflicts with its fourth-tone pronunciation here.', v => {
    v.quiz.questions[0]!.passagePinyin = 'míng tiān jiǎn 。'
  }, 'sourceSupported'),
  entry('noodles-two-targets-valid', 'holdout', twoTargets, 'Two separate requests retain their own option meanings.'),
  { ...entry('noodles-second-feedback-wrong', 'holdout', twoTargets, 'The second question incorrectly translates its request to add chili pepper as a request to omit it.', v => {
    v.quiz.questions[1]!.distractorFeedback[0]!.explanation = '请加辣椒 means do not add chili pepper, so this is another way to state your preference.'
  }, 'sourceSupported'), mustFail: { cardId: 'target-2', criterion: 'sourceSupported' } },
  entry('courtesy-neutral-context-valid', 'regression', neutralThanks, 'A neutral place and role do not add events to the faithful meaning or feedback.'),
  entry('courtesy-hypothetical-feedback-valid', 'regression', hypotheticalThanks, 'An explicitly hypothetical example illustrates use without claiming it happened in the question.'),
  entry('courtesy-invented-event-key', 'regression', neutralThanks, 'The key invents a returned wallet; neither the visible question nor the expression establishes that event.', v => {
    v.quiz.questions[0]!.options[0]!.text = 'Thank you for returning my lost wallet.'
  }, 'oneCorrectAnswer'),
  entry('courtesy-invented-event-feedback', 'regression', neutralThanks, 'The feedback asserts that the receptionist returned a lost wallet, but no such event is given.', v => {
    v.quiz.questions[0]!.explanation = 'The visitor is thanking the receptionist for returning their lost wallet.'
  }, 'sourceSupported'),
]

export function validateReviewCorpus(cases = reviewCases) {
  if (!cases.length || new Set(cases.map(c => c.id)).size !== cases.length) throw new Error('Choose unique review cases.')
  for (const c of cases) {
    quizDraftSchema.parse(c.input.quiz)
    if (c.expected === 'reject' && !c.mustFail) throw new Error('Every negative case needs a specific expected defect.')
    if (c.mustFail && !c.input.quiz.questions.some(q => q.cardId === c.mustFail!.cardId)) throw new Error('Expected defect must name a question in the quiz.')
  }
  return { cases: cases.length, positives: cases.filter(c => c.expected === 'accept').length, negatives: cases.filter(c => c.expected === 'reject').length }
}
