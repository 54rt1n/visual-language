/** Authored rehearsal fixtures, never claimed as live inference or web citations. */
export const DEMO_NOW = Date.UTC(2026, 8, 10, 12)
export const DEMO_MODEL = 'hackathon-seed-v1'
export const DEMO_ITEMS = [
  { id: 'demo-thanks', text: '谢谢', pinyin: 'xiè xie', meaning: 'thank you', root: 'demo-everyday', skill: 'recognition' as const,
    explanation: '谢谢 expresses thanks. Use it after someone helps you.', example: '谢谢你的帮助。', translation: 'Thank you for your help.',
    prompt: 'Write the two-character Mandarin expression meaning “thank you”.', corrective: 'A friend has helped you. Write the two-character expression of thanks.',
    choices: ['谢谢', '你好', '再见', '对不起'] },
  { id: 'demo-tea', text: '请给我一杯茶', pinyin: 'qǐng gěi wǒ yì bēi chá', meaning: 'please give me a cup of tea', root: 'demo-everyday', skill: 'production' as const,
    explanation: '请 makes the request polite. 一杯茶 is one cup of tea.', example: '请给我一杯茶。', translation: 'Please give me a cup of tea.',
    prompt: 'Use the saved six-character phrase to request a cup of tea politely. Write Hanzi only.', corrective: 'At a café, politely request one cup of tea using the six-character phrase you learned.',
    choices: ['请给我一杯茶', '请给我一杯水', '请给我一杯咖啡', '请给我一碗饭'] },
  { id: 'demo-metro', text: '地铁在哪里', pinyin: 'dì tiě zài nǎ lǐ', meaning: 'where is the subway', root: 'demo-travel', skill: 'production' as const,
    explanation: '在哪里 asks where something is. 地铁 means subway or metro.', example: '请问，地铁在哪里？', translation: 'Excuse me, where is the subway?',
    prompt: 'Write the five-character Mandarin question meaning “where is the subway”.', corrective: 'Ask where the subway is using the five-character question you learned.',
    choices: ['地铁在哪里', '车站在哪里', '洗手间在哪里', '饭店在哪里'] },
  { id: 'demo-excuse', text: '请问', pinyin: 'qǐng wèn', meaning: 'excuse me, may I ask', root: 'demo-travel', skill: 'meaning' as const,
    explanation: '请问 politely introduces a question. It is not an apology for wrongdoing.', example: '请问，车站在哪里？', translation: 'Excuse me, where is the station?',
    prompt: 'For this exact-answer rehearsal, give the saved English gloss of 请问: “excuse me, may I ask”.', corrective: 'Recall the saved English gloss of 请问. This rehearsal accepts “excuse me, may I ask” or “excuse me”.',
    choices: ['excuse me, may I ask', 'thank you', 'goodbye', 'I am sorry'] },
  { id: 'demo-goodbye', text: '再见', pinyin: 'zài jiàn', meaning: 'goodbye', root: 'demo-travel', skill: 'production' as const,
    explanation: '再见 is a common expression for saying goodbye.', example: '再见，明天见！', translation: 'Goodbye, see you tomorrow!',
    prompt: 'Write the two-character Mandarin expression meaning “goodbye”.', corrective: 'You are leaving after a visit. Write the two-character expression for goodbye.',
    choices: ['再见', '谢谢', '你好', '对不起'] },
] as const
export type DemoMaterial = typeof DEMO_ITEMS[number]
