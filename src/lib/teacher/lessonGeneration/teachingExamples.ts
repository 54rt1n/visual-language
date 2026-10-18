import { englishAnswers, type LessonSettings } from '../../domain/lessonSettings'

/** Small complete examples use unrelated, explicitly taught material. */
export function questionTeachingExample(settings: LessonSettings, phase: 'practice' | 'check') {
  const english = englishAnswers(settings.quizLevel), check = phase === 'check'
  const input = {
    settings: { ...settings, topic: 'Asking for a drink' }, phase,
    targets: [{ cardId: 'demo-request', hanzi: '请给我', meaning: 'Please give me…' }, { cardId: 'demo-tea', hanzi: '茶', meaning: 'Tea.' }],
    gap: { waypointIds: ['w1'], cardId: 'demo-request', intent: 'Ask for a drink politely.' },
    target: { cardId: 'demo-request', hanzi: '请给我', meaning: 'Please give me…' },
    waypoints: [{ id: 'w1', objective: 'Ask for a drink', explanation: 'Use 请给我… to ask for something politely. 水 means water and 茶 means tea. 我不要… means I do not want…; 谢谢 means thank you.',
      cardIds: ['demo-request', 'demo-tea'], exampleHanzi: '请给我水。', exampleMeaning: 'Please give me water.' }],
    sourceMaterial: { passageHanzi: '请给我水。请给我茶。我不要水。我不要茶。谢谢。', passageMeaning: 'Please give me water. Please give me tea. I do not want water. I do not want tea. Thank you.' },
    currentQuestions: [],
    ...(check ? { practiceQuestions: [{ stem: english ? 'What does this request mean?' : 'Ask for water politely.', ...(english ? { passage: '请给我水。' } : {}) }] } : {}),
  }
  const answers = english
    ? check ? ['Please give me tea.', 'Please give me water.', 'I do not want tea.', 'Thank you.'] : ['Please give me water.', 'Please give me tea.', 'I do not want water.', 'Thank you.']
    : check ? ['请给我茶。', '请给我水。', '我不要茶。', '谢谢。'] : ['请给我水。', '请给我茶。', '我不要水。', '谢谢。']
  const args = {
    stem: english ? check ? 'What is the person asking for?' : 'What does this request mean?' : check ? 'Ask for tea politely.' : 'Ask for water politely.',
    ...(english ? { passage: check ? '请给我茶。' : '请给我水。' } : {}),
    answerA: answers[0], answerB: answers[1], answerC: answers[2], answerD: answers[3], correct: 'A',
    feedback: `请给我… asks for something politely. ${check ? '茶 is tea; 水 is water.' : '水 is water; 茶 is tea.'}`,
  }
  return { input, arguments: args }
}

export function questionAuthoringExample(settings: LessonSettings, phase: 'practice' | 'check') {
  const example = questionTeachingExample(settings, phase)
  return `Worked teaching example (separate material):\n${JSON.stringify(example.input)}\nComplete question arguments:\n${JSON.stringify(example.arguments)}`
}

export const WAYPOINT_TEACHING_EXAMPLE = `Worked teaching examples (separate material):
Input: {"targets":[{"cardId":"demo-hello","hanzi":"你好","meaning":"Hello."}],"sources":[{"id":"demo-source","excerpt":"你好。再见。"}],"graph":{"waypoints":[]},"nextWaypointId":"w1"}
Complete waypoint arguments: {"cardIds":["demo-hello"],"dependsOn":[],"objective":"Say hello","explanation":"Say 你好 when you meet someone. 再见 means goodbye.","exampleHanzi":"你好。","exampleMeaning":"Hello.","sourceIds":["demo-source"]}
Input: {"targets":[{"cardId":"demo-menu","hanzi":"菜单","meaning":"Menu."},{"cardId":"demo-request","hanzi":"请给我菜单","meaning":"Please give me the menu."}],"sources":[{"id":"demo-source","excerpt":"请给我菜单。"}],"graph":{"waypoints":[]},"nextWaypointId":"w1"}
Complete waypoint arguments: {"cardIds":["demo-menu","demo-request"],"dependsOn":[],"objective":"Get a menu","explanation":"菜单 means menu. Use 请给我… to ask for something politely.","exampleHanzi":"请给我菜单。","exampleMeaning":"Please give me the menu.","sourceIds":["demo-source"]}`

export const GRAPH_REVIEW_EXAMPLES = `For accept, add or reject, submit decision and reason. For revise, also supply the existing waypointId that needs replacement. The application assigns IDs to new points.

Worked example input: {"objective":"Recognize greetings and thanks.","targets":[{"cardId":"demo-hello","hanzi":"你好","meaning":"Hello."},{"cardId":"demo-thanks","hanzi":"谢谢","meaning":"Thank you."}],"graph":{"waypoints":[{"id":"w1","cardIds":["demo-hello"],"objective":"Recognize a greeting.","exampleHanzi":"你好。","exampleMeaning":"Hello."}]}}
Complete submission arguments: {"decision":"add","reason":"The greeting is taught; a teaching point for 谢谢 is still needed."}

Worked example input: {"objective":"Recognize a greeting.","targets":[{"cardId":"demo-hello","hanzi":"你好","meaning":"Hello."}],"graph":{"waypoints":[{"id":"w1","cardIds":["demo-hello"],"objective":"Recognize a greeting.","exampleHanzi":"你好。","exampleMeaning":"Goodbye."}]}}
Complete submission arguments: {"decision":"revise","reason":"Correct w1's translation of 你好 to Hello.","waypointId":"w1"}

Worked example input: {"objective":"Choose and order a meal.","graph":{"waypoints":[{"id":"w1","cardIds":["order"],"dependsOn":[],"objective":"Order a dish","exampleHanzi":"我要这个。","exampleMeaning":"I want this one."},{"id":"w2","cardIds":["menu"],"dependsOn":[],"objective":"Get a menu","exampleHanzi":"请给我菜单。","exampleMeaning":"Please give me the menu."}]}}
Complete submission arguments: {"decision":"revise","reason":"Get the menu before ordering from it. Revise w1 to depend on w2 so the lesson teaches the actions in a useful sequence.","waypointId":"w1"}`
