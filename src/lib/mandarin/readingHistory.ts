import type { ReadingNote } from '../domain/reading'
import type { SavedDraft, Workspace } from '../domain/workspace'
import { sha256Hex } from '../crypto'
import { searchText } from '../search/searchService'
import { isReadingNode } from './captureSource'

export type ReadingDraft = SavedDraft & { kind: 'reading'; reading: ReadingNote }
export type ReadingHistoryGroup = { id: string; latest: ReadingDraft; versions: ReadingDraft[]; match: ReadingDraft }

/** Frozen reading material is still help while an independent question is pending. */
export function readingConcealed(state: Workspace) {
  return state.exercises.some(e => e.mode === 'dueReview' && state.sessions.some(s => s.activeExerciseId === e.id && s.status !== 'completed') && !state.events.some(event => event.exerciseId === e.id && event.kind === 'review'))
}

/** Pure projection: keep source occurrences and learner/language/level histories separate. */
export function readingHistory(state: Workspace): ReadingHistoryGroup[] {
  if (readingConcealed(state)) return []
  const groups = new Map<string, ReadingDraft[]>()
  for (const draft of state.drafts) {
    if (draft.kind !== 'reading' || draft.status !== 'validated' || !draft.reading || draft.reading.learnerId !== state.activeLearnerId) continue
    const r = draft.reading
    const identity = JSON.stringify([r.nodeId, r.sourceHash, r.start, r.end, r.learnerId, r.level, r.explanationLanguage])
    const versions = groups.get(identity) ?? []
    versions.push(draft as ReadingDraft); groups.set(identity, versions)
  }
  return [...groups.values()].map(versions => {
    versions.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
    return { id: versions.at(-1)!.id, latest: versions[0]!, versions, match: versions[0]! }
  }).sort((a, b) => b.latest.createdAt - a.latest.createdAt || b.latest.id.localeCompare(a.latest.id))
}

/** Search all retained versions. A result can explicitly open an older match. */
export function searchReadingHistory(groups: ReadingHistoryGroup[], query: string): ReadingHistoryGroup[] {
  const terms = searchText(query.slice(0, 300)).split(' ').filter(Boolean)
  if (!terms.length) return groups
  return groups.flatMap(group => {
    const match = group.versions.find(draft => {
      const r = draft.reading
      const text = searchText([r.text, r.pinyin, r.pronunciation?.pinyin ?? '', r.meaning, r.explanation, r.pronunciation?.note ?? '', r.context, r.sentenceMeaning].join('\n'))
      return terms.every(term => text.includes(term))
    })
    return match ? [{ ...group, match }] : []
  })
}

/** Never assert that an old frozen sentence describes the current graph text. */
export async function readingSourceStatus(state: Workspace, draft: ReadingDraft) {
  const node = state.nodes.find(n => n.id === draft.reading.nodeId)
  if (!isReadingNode(node)) return { kind: 'missing' as const }
  const r = draft.reading, hash = await sha256Hex(node.data.text)
  const root = state.nodes.find(n => n.id === node.rootId)
  return { kind: hash === r.sourceHash && node.data.text.slice(r.start, r.end) === r.text ? 'unchanged' as const : 'changed' as const,
    nodeId: node.id, topic: root?.type === 'root' ? root.data.name : 'Saved topic' }
}
