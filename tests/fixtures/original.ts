/** Deterministic fixture shaped from the owned original's eight actual renderers.
 * Contains no real API response or credentials. */
export function originalFixture() {
  const node = (id: string, type: string, data: Record<string, unknown>, x: number, y = 0) => ({ id, type, data, position: { x, y }, bookmarked: id === 'answer', collapsed: false })
  const nodes = [
    node('topic', 'root', { name: 'Original tea lesson' }, 0),
    node('far-system', 'system', { content: 'Explain politely.' }, 100),
    node('model', 'modelConfig', { provider: 'deepseek', modelId: 'original-model', temperature: 0.6, maxTokens: 800, apiKey: 'OMIT-ORIGINAL-KEY', baseUrl: 'https://never-contact.example/v1' }, 200),
    node('learning', 'learningConfig', { languageComplexity: 'native', pinyinDisplay: 'onHover', languageBalance: 'mostlyTarget' }, 300),
    node('vocabulary', 'vocabularyContext', { terms: ['茶', '谢谢'] }, 400),
    node('question', 'user', { content: 'How do I ask for tea?' }, 500),
    node('answer', 'assistant', { content: '请给我一杯茶。', streaming: true, model: 'original-actual-model', error: { message: 'OMIT-RAW-ERROR-KEY' } }, 650),
    node('near-system', 'system', { content: 'Use a restaurant example.' }, 750),
    node('followup', 'user', { content: 'And how do I say thanks?' }, 850),
    node('reply', 'assistant', { content: '谢谢！', model: 'original-actual-model' }, 1000),
    node('mandarin', 'mandarinChunk', { chunkText: '谢谢', pinyin: 'xiè xie', sourceNodeId: 'reply', wordSegments: [{ text: '谢谢', startIndex: 0, endIndex: 2, pinyin: 'xiè xie' }] }, 1000, 250),
    node('other-topic', 'root', { name: 'Original travel lesson' }, 0, 700),
  ]
  const chain = ['topic', 'far-system', 'model', 'learning', 'vocabulary', 'question', 'answer', 'near-system', 'followup', 'reply']
  const edges = chain.slice(1).map((id, i) => ({ id: `edge-${i}`, source: chain[i]!, target: id, type: 'default' }))
  edges.push({ id: 'chunk-edge', source: 'reply', target: 'mandarin', type: 'derivedDataLink' })
  const vocabulary: Array<Record<string, unknown>> = [
    { id: 'thanks', term: '谢谢', definition: 'thank you', pinyin: 'xiè xie', sourceNodeIds: ['reply'], addedTimestamp: 1_700_000_000_000,
      masteryLevel: 'Confident', category: 'courtesy', lastSelfAssessmentTimestamp: 1_700_000_000_001, selfAssessmentCorrectCount: 20, selfAssessmentIncorrectCount: 2,
      reviewSchedule: { nextReviewTimestamp: 1_800_000_000_000, currentIntervalDays: 40, easeFactor: 2.5 } },
    { id: 'tea', term: '茶', addedTimestamp: 1_700_000_000_000, masteryLevel: 'Learning' },
  ]
  return { nodes, edges, vocabulary }
}
