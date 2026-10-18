import { z } from 'zod'
import { nid } from '../id'
import type { SourceSnapshot, Workspace } from '../domain/workspace'
import { isDue } from '../learning/leitner'

export const localSearchInputSchema = z.strictObject({ query: z.string().trim().min(1).max(300), rootId: z.string().max(200).optional(), cardId: z.string().max(200).optional() })
export type SearchFilters = { rootId?: string; cardId?: string; kind?: 'all' | 'conversation' | 'item' | 'feedback' | 'source' | 'lesson'; due?: 'all' | 'due' | 'new' | 'suspended'; limit?: number }
export type LocalSearchResult = { id: string; kind: Exclude<SearchFilters['kind'], 'all' | undefined>; title: string; snippet: string; nodeId?: string; rootId?: string; rootIds: string[]; itemId?: string; cardId?: string; attemptId?: string; sourceId?: string; box?: number; dueAt?: number | null; skill?: string; missingSource: boolean; score: number }
export function searchText(text: string) { return text.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase().replace(/\s+/g, ' ').trim() }
export function searchLearningHistory(state: Workspace, query: string, filters: SearchFilters = {}, now = Date.now()): LocalSearchResult[] {
  const terms = searchText(query).split(' ').filter(Boolean)
  if (!terms.length) return []
  const docs: LocalSearchResult[] = [], nodes = new Map(state.nodes.map(n => [n.id, n]))
  const cards = new Map(state.cards.map(c => [c.id, c])), items = new Map(state.items.map(i => [i.id, i]))
  const exercises = new Map(state.exercises.map(e => [e.id, e]))
  // Match feedbackMaterial's saved-example precedence without scanning every
  // draft for every attempt in a large history. No candidate/pending repair text.
  const repairedExamples = new Map<string, NonNullable<Workspace['drafts'][number]['workedExample']>>()
  for (const draft of state.drafts) if (draft.kind === 'feedback' && draft.status === 'validated' && draft.attemptId && draft.workedExample) repairedExamples.set(draft.attemptId, draft.workedExample)
  const derivedChunks = new Map<string, Workspace['nodes'][number]>(), sourceCards = new Map<string, Set<string>>()
  for (const node of state.nodes) if (node.type === 'chunk' && node.data.itemId && !derivedChunks.has(node.data.itemId)) derivedChunks.set(node.data.itemId, node)
  function linkSources(sourceIds: string[], cardIds: string[]) { for (const id of sourceIds) { const linked = sourceCards.get(id) ?? new Set<string>(); cardIds.forEach(card => linked.add(card)); sourceCards.set(id, linked) } }
  state.exercises.forEach(e => linkSources(e.sourceIds, [e.cardId]))
  state.drafts.forEach(d => linkSources(d.sourceIds, d.cardIds))
  const sourceLessons = new Map<string, { nodeId: string; rootId: string }[]>()
  for (const draft of state.drafts) if (draft.status === 'validated' && draft.discovery && draft.discoveryRequest) for (const id of draft.sourceIds) {
    sourceLessons.set(id, [...sourceLessons.get(id) ?? [], { nodeId: draft.discovery.nodeId, rootId: draft.discoveryRequest.rootId }])
  }
  function add(doc: Omit<LocalSearchResult, 'score' | 'missingSource'>, text: string) {
    const haystack = searchText(`${doc.title} ${text}`)
    if (!terms.every(term => haystack.includes(term))) return
    if (filters.kind && filters.kind !== 'all' && doc.kind !== filters.kind) return
    if (filters.rootId && !doc.rootIds.includes(filters.rootId)) return
    if (filters.cardId && doc.cardId !== filters.cardId) return
    const card = doc.cardId ? cards.get(doc.cardId) : undefined
    if (filters.due && filters.due !== 'all' && (!card || (filters.due === 'due' ? !isDue(card, now) : card.status !== filters.due))) return
    const position = searchText(text).indexOf(terms[0]!), start = Math.max(0, position - 60)
    docs.push({ ...doc, snippet: `${start ? '…' : ''}${text.slice(start, start + 380)}${text.length > start + 380 ? '…' : ''}`, missingSource: Boolean(doc.nodeId && !nodes.has(doc.nodeId)),
      score: (terms.every(t => searchText(doc.title).includes(t)) ? 20 : 0) + (card && isDue(card, now) ? 2 : 0) })
  }
  for (const node of state.nodes) if (node.type === 'user' || node.type === 'assistant' || node.type === 'chunk' || node.type === 'explanation') add({ id: `node:${node.id}`, kind: 'conversation', title: node.type === 'chunk' ? node.data.text : node.type === 'assistant' ? 'Zheng’s reply' : node.type === 'explanation' ? 'Zheng’s explanation' : 'Your message', snippet: '', nodeId: node.id, rootId: node.rootId, rootIds: [node.rootId] }, node.data.text + (node.type === 'chunk' ? ` ${node.data.pinyin} ${node.data.meaning}` : ''))
  for (const draft of state.drafts) if (draft.status === 'validated' && draft.discovery && draft.discoveryRequest) {
    const lesson = draft.discovery
    add({ id: `lesson:${draft.id}`, kind: 'lesson', title: lesson.title, snippet: '', nodeId: lesson.nodeId, rootId: draft.discoveryRequest.rootId, rootIds: [draft.discoveryRequest.rootId] },
      `${draft.discoveryRequest.publicTopic}\n${lesson.explanation}\n${lesson.passageHanzi}\n${lesson.passagePinyin}\n${lesson.passageMeaning}\n${lesson.phrases.map(p => `${p.hanzi} ${p.pinyin} ${p.meaning} ${p.explanation}`).join('\n')}${lesson.roleplay ? `\n${lesson.roleplay.situation} ${lesson.roleplay.objective}` : ''}`)
  }
  for (const card of state.cards) {
    const item = items.get(card.itemId)!
    const derived = derivedChunks.get(item.id)
    const nodeId = derived?.id ?? item.sourceNodeIds[0]
    add({ id: `card:${card.id}`, kind: 'item', title: `${item.canonicalText} · ${card.skill}`, snippet: '', nodeId, rootId: derived?.rootId ?? item.sourceRootIds[0], rootIds: item.sourceRootIds, itemId: item.id, cardId: card.id, box: card.box, dueAt: card.dueAt, skill: card.skill }, `${item.canonicalText} ${item.pinyin ?? ''} — ${item.meaning} (${item.senseKey})`)
  }
  for (const attempt of state.attempts) if (attempt.assessment) {
    const card = cards.get(attempt.cardId)!, item = items.get(card.itemId)!
    const example = repairedExamples.get(attempt.id) ?? attempt.assessment.workedExample ?? exercises.get(attempt.exerciseId)?.workedExample
    const exampleText = example ? `\nWorked teaching example:\n${example.hanzi}\n${example.pinyin}\n${example.meaning}\n${example.explanation}` : ''
    add({ id: `attempt:${attempt.id}`, kind: 'feedback', title: `${item.canonicalText} — ${attempt.assessment.grade} feedback`, snippet: '', nodeId: item.sourceNodeIds[0], rootId: item.sourceRootIds[0], rootIds: item.sourceRootIds, itemId: item.id, cardId: card.id, attemptId: attempt.id, box: card.box, dueAt: card.dueAt, skill: card.skill }, `${attempt.answer}\n${attempt.assessment.feedback}\n${attempt.assessment.correctedExample ?? ''}${exampleText}\n${attempt.assessment.criteria.map(c => c.evidence).join('\n')}`)
  }
  for (const source of state.sources) {
    const relatedLessons = sourceLessons.get(source.id) ?? []
    const lessonNode = relatedLessons.find(l => !filters.rootId || l.rootId === filters.rootId)
    const nodeId = source.nodeId ?? lessonNode?.nodeId, node = nodeId ? nodes.get(nodeId) : undefined
    const cardIds = [...new Set([
      ...(source.cardId ? [source.cardId] : []),
      ...sourceCards.get(source.id) ?? [],
    ])]
    for (const cardId of cardIds.length ? cardIds : [undefined]) {
      const card = cardId ? cards.get(cardId) : undefined, item = card ? items.get(card.itemId) : undefined
      const rootIds = [...new Set([...(node ? [node.rootId] : []), ...item?.sourceRootIds ?? [], ...relatedLessons.map(l => l.rootId)])]
      add({ id: `source:${source.id}${cardId ? `:card:${cardId}` : ''}`, kind: 'source', title: source.title, snippet: '', sourceId: source.id, nodeId,
        rootId: node?.rootId ?? item?.sourceRootIds[0], rootIds, cardId, box: card?.box, dueAt: card?.dueAt, skill: card?.skill }, source.excerpt)
    }
  }
  return docs.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, Math.min(filters.limit ?? 50, 100))
}

export function historySources(state: Workspace, query: string, filters: SearchFilters = {}, now = Date.now()): SourceSnapshot[] {
  return searchLearningHistory(state, query, { ...filters, limit: 3 }, now).map<SourceSnapshot>(result => {
    if (result.sourceId) {
      const source = state.sources.find(s => s.id === result.sourceId)!
      return { ...source, excerpt: source.excerpt.slice(0, 500) }
    }
    const excerpt = result.snippet.slice(0, 500)
    const existing = state.sources.find(s => s.kind === 'local' && s.nodeId === result.nodeId && s.cardId === result.cardId && s.excerpt === excerpt)
    return existing ?? { id: nid('source'), kind: 'local', title: result.title.slice(0, 200), excerpt, retrievedAt: now,
      ...(result.nodeId ? { nodeId: result.nodeId } : {}), ...(result.cardId ? { cardId: result.cardId } : {}), ...(result.kind === 'lesson' ? { adapted: true } : {}) }
  }).filter((source, index, list) => list.findIndex(other => other.id === source.id) === index)
}

/** Text-only highlighting; no HTML parsing of imported/retrieved content. */
export function highlightParts(text: string, query: string): { text: string; match: boolean }[] {
  const terms = searchText(query).split(' ').filter(Boolean)
  if (!terms.length) return [{ text, match: false }]
  let folded = ''
  const starts: number[] = [], ends: number[] = []
  let offset = 0
  for (const character of text) {
    const value = character.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase()
    for (let i = 0; i < value.length; i++) { starts.push(offset); ends.push(offset + character.length) }
    folded += value; offset += character.length
  }
  const ranges: [number, number][] = []
  for (const term of terms) {
    let start = 0, index: number
    while ((index = folded.indexOf(term, start)) !== -1) { ranges.push([starts[index]!, ends[index + term.length - 1]!]); start = index + term.length }
  }
  ranges.sort((a, b) => a[0] - b[0])
  const merged: [number, number][] = []
  for (const range of ranges) { const previous = merged.at(-1); if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1]); else merged.push([...range]) }
  const parts: { text: string; match: boolean }[] = []
  let cursor = 0
  for (const [start, end] of merged) { if (start > cursor) parts.push({ text: text.slice(cursor, start), match: false }); parts.push({ text: text.slice(start, end), match: true }); cursor = end }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), match: false })
  return parts
}
