import { z } from 'zod'
import { identifier, shortText, uniqueIds } from '../domain/common'
import { graphNodeSchema, positionSchema, type GraphNode } from '../domain/graph'
import { originalSrsSchema, originalVocabularySchema, originalWordSegmentSchema } from '../domain/original'
import { createWorkspace, validateWorkspace, type Workspace } from '../domain/workspace'
import { nid } from '../id'
import { containsHanzi } from '../mandarin/chineseParser'
import { counts, exportBackup, MAX_BACKUP_BYTES, parseBackup, type RestorePreview } from './backup'
import type { WorkspaceVersion } from './repository'
import { providerIds } from '../ai/providers'

// The owned original's graphService.loadGraph shape, plus an optional vocabulary
// table. Not a Dexie-export envelope, current backup, or arbitrary graph format.
const originalGraphSchema = z.strictObject({
  nodes: z.array(z.object({ id: identifier, type: z.enum(['root', 'user', 'assistant', 'mandarinChunk', 'modelConfig', 'system', 'vocabularyContext', 'learningConfig']),
    position: positionSchema, data: z.record(z.string(), z.unknown()), bookmarked: z.boolean().optional(), collapsed: z.boolean().optional(),
  })).min(1).max(12_000),
  edges: z.array(z.object({ id: identifier, source: identifier, target: identifier, type: z.enum(['default', 'derivedDataLink', 'annotationLink']).optional() })).max(30_000),
  vocabulary: z.array(originalVocabularySchema.strip()).max(10_000).optional(),
})
type OriginalNode = z.infer<typeof originalGraphSchema>['nodes'][number]
const configurationTypes = new Set(['modelConfig', 'system', 'vocabularyContext', 'learningConfig'])
const conversationTypes = new Set(['root', 'user', 'assistant'])
const nodeData = {
  root: z.object({ name: shortText(200).default('Imported conversation') }),
  user: z.object({ content: z.string().max(100_000) }),
  assistant: z.object({ content: z.string().max(100_000), reasoning: z.string().max(100_000).default(''), streaming: z.boolean().optional(), model: z.string().max(200).optional(), error: z.unknown().optional() }),
  mandarinChunk: z.object({ chunkText: shortText(1000), pinyin: z.string().max(2000).default(''), sourceNodeId: identifier,
    wordSegments: z.array(originalWordSegmentSchema.strip()).max(1000).optional() }),
  modelConfig: z.object({ provider: shortText(100), modelId: shortText(200), temperature: z.number().min(0).max(2).default(0.7), maxTokens: z.number().int().min(64).max(16000).default(1000) }),
  system: z.object({ content: shortText(8000) }),
  vocabularyContext: z.object({ terms: z.array(shortText(300)).max(100) }),
  learningConfig: z.object({ languageComplexity: z.enum(['beginner', 'intermediate', 'advanced', 'native']).default('intermediate'),
    pinyinDisplay: z.enum(['always', 'onHover', 'never']).default('always'), languageBalance: z.enum(['mostlyTarget', 'balanced', 'mostlyNative']).default('balanced') }),
}

export type OriginalImport = { state: Workspace; warnings: string[]; vocabularyCount: number; awaitingMeaning: number }

/** Pure, bounded and allowlisted. Never reads local keys, opens a database, or
 * performs a request. The caller must preview and explicitly confirm replacement.
 */
export function importOriginalGraph(text: string, now = Date.now()): OriginalImport {
  if (new TextEncoder().encode(text).byteLength > MAX_BACKUP_BYTES) throw new Error('Original-project files must be 25 MiB or smaller.')
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new Error('The original-project file is not valid JSON.') }
  try { return convert(originalGraphSchema.parse(value), now) }
  catch (cause) {
    if (cause instanceof z.ZodError) throw new Error(`Unsupported or invalid original-project data at ${cause.issues[0]?.path.join('.') || 'the document'}. Use the documented eight-node graph format; the current workspace and source file were not changed.`)
    throw cause
  }
}

function convert(original: z.infer<typeof originalGraphSchema>, now: number): OriginalImport {
  const nodeIds = uniqueIds(original.nodes, 'original node')
  uniqueIds(original.edges, 'original edge'); uniqueIds(original.vocabulary ?? [], 'original vocabulary')
  const byId = new Map(original.nodes.map(n => [n.id, n])), roots = original.nodes.filter(n => n.type === 'root')
  if (!roots.length) throw new Error('The original graph needs a topic root. No data was changed.')
  const parents = new Map<string, { source: string; id: string }>(), derived = [] as typeof original.edges
  for (const edge of original.edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) throw new Error('An original edge references a missing node.')
    const source = byId.get(edge.source)!, target = byId.get(edge.target)!
    if (edge.type === 'annotationLink') throw new Error('Annotation links are not supported by this content importer. Keep the original file; no data was changed.')
    if (target.type === 'mandarinChunk') { derived.push(edge); continue }
    if (edge.type === 'derivedDataLink' || source.type === 'mandarinChunk' || target.type === 'root') throw new Error('The original graph contains an unsupported relationship.')
    if (parents.has(target.id)) throw new Error('The original graph has ambiguous primary parents. Resolve the branch in the original before importing.')
    parents.set(target.id, { source: source.id, id: edge.id })
  }
  // One precomputed parent map. Iterative walks are bounded, including configs.
  const paths = new Map<string, OriginalNode[]>()
  function path(id: string) {
    const cached = paths.get(id)
    if (cached) return cached
    const result: OriginalNode[] = [], seen = new Set<string>()
    let current: string | undefined = id
    while (current) {
      if (seen.has(current)) throw new Error('The original graph contains a cycle.')
      if (result.length >= 200) throw new Error('Original conversation ancestry exceeds 200 nodes.')
      const node = byId.get(current)
      if (!node) throw new Error('An original source references a missing node.')
      seen.add(current); result.push(node); current = parents.get(current)?.source
    }
    result.reverse(); paths.set(id, result); return result
  }
  const rootOf = new Map<string, string>()
  for (const node of original.nodes.filter(n => n.type !== 'mandarinChunk')) {
    const first = path(node.id)[0]!
    if (first.type === 'root') rootOf.set(node.id, first.id)
    else if (configurationTypes.has(node.type) && !parents.has(node.id) && !original.edges.some(e => e.source === node.id) && roots.length === 1) rootOf.set(node.id, roots[0]!.id)
    else throw new Error('An original conversation/configuration has no unambiguous topic root.')
  }
  const state = createWorkspace(now), learner = state.learners[0]!, warnings = [
    'Content import, not a learning backup: every created card is new, unintroduced box 1 with no due date. Original SRS values are provenance only.',
    'Message content, node IDs/positions, bookmarks and collapse are retained. Inline configuration is converted to nearest-per-kind attachments; relation IDs can change.',
    'Original word segments retain text, chunk-relative offsets and supplied pinyin. They are historical reading data, not verified lexical boundaries or learning progress.',
    'Editor decorations, transient selection, usage/error details and unrecognized node-data fields are not imported. Credentials and endpoints are never read from the file.',
    'All imported model settings require explicit review in Node tools. Unsupported original providers are labeled and held under Custom, with no endpoint or key imported.',
  ]
  state.name = 'Imported original workspace'; state.nodes = []; state.edges = []
  // Chunks must cite a retained conversation source; do not guess across topics.
  for (const node of original.nodes.filter(n => n.type === 'mandarinChunk')) {
    const data = nodeData.mandarinChunk.parse(node.data), source = byId.get(data.sourceNodeId)
    if (!source || !conversationTypes.has(source.type)) throw new Error('An original Mandarin chunk lacks its conversation source.')
    rootOf.set(node.id, rootOf.get(source.id)!)
    const incoming = derived.filter(e => e.target === node.id)
    if (incoming.some(e => e.source !== source.id)) throw new Error('An original chunk has conflicting source relationships.')
    if (!incoming.length) derived.push({ id: nid('edge'), source: source.id, target: node.id, type: 'derivedDataLink' })
  }
  for (const node of original.nodes) {
    let type: GraphNode['type'] = 'root', data: unknown
    switch (node.type) {
      case 'root': data = nodeData.root.parse(node.data); break
      case 'user': type = 'user'; data = { text: nodeData.user.parse(node.data).content }; break
      case 'assistant': {
        const d = nodeData.assistant.parse(node.data)
        type = 'assistant'; data = { text: d.content, reasoning: d.reasoning, provider: 'original', model: d.model ?? 'unknown',
          state: d.streaming ? 'interrupted' : d.error ? 'error' : 'complete', error: d.error ? 'Original request failed; raw provider error details were not imported.' : '' }; break
      }
      case 'mandarinChunk': { const d = nodeData.mandarinChunk.parse(node.data); type = 'chunk'; data = { text: d.chunkText, pinyin: d.pinyin, meaning: '', ...(d.wordSegments ? { originalWordSegments: d.wordSegments } : {}) }; break }
      case 'system': type = 'systemConfig'; data = { prompt: nodeData.system.parse(node.data).content }; break
      case 'vocabularyContext': type = 'vocabularyConfig'; data = { words: nodeData.vocabularyContext.parse(node.data).terms, instruction: '' }; break
      case 'modelConfig': {
        const d = nodeData.modelConfig.parse(node.data), provider = (providerIds as readonly string[]).includes(d.provider) ? d.provider : 'custom'
        type = 'modelConfig'; data = { provider, model: d.modelId, temperature: d.temperature, maxTokens: d.maxTokens, originalProvider: d.provider, requiresReview: true }; break
      }
      case 'learningConfig': {
        const d = nodeData.learningConfig.parse(node.data), { id: _id, ...defaults } = learner
        type = 'learningConfig'; data = { ...defaults, level: d.languageComplexity, languageBalance: d.languageBalance, pinyinDisplay: { always: 'always', onHover: 'onDemand', never: 'hidden' }[d.pinyinDisplay] }; break
      }
    }
    state.nodes.push(graphNodeSchema.parse({ id: node.id, rootId: rootOf.get(node.id), type, data, position: node.position, bookmarked: node.bookmarked ?? false, collapsed: node.collapsed ?? false }))
  }
  for (const node of original.nodes.filter(n => n.type === 'user' || n.type === 'assistant')) {
    const ancestors = path(node.id).slice(0, -1), nearest = new Map<string, string>()
    let parent: OriginalNode | undefined
    for (const ancestor of [...ancestors].reverse()) {
      if (conversationTypes.has(ancestor.type)) { parent = ancestor; break }
      if (!configurationTypes.has(ancestor.type)) throw new Error('Unsupported inline original node.')
      if (!nearest.has(ancestor.type)) nearest.set(ancestor.type, ancestor.id)
    }
    if (!parent) throw new Error('An imported message has no primary conversation parent.')
    state.edges.push({ id: parents.get(node.id)!.id, source: parent.id, target: node.id, data: { kind: 'conversation' } })
    for (const source of nearest.values()) state.edges.push({ id: nid('edge'), source, target: node.id, data: { kind: 'context' } })
  }
  state.edges.push(...derived.map(edge => ({ id: edge.id, source: edge.source, target: edge.target, data: { kind: 'derived' as const } })))

  let awaitingMeaning = 0, nonMandarin = 0, vocabularyRoot: string | undefined
  const itemIdentities = new Map<string, Workspace['items'][number]>()
  for (const entry of original.vocabulary ?? []) {
    const sourceIds = [...new Set(entry.sourceNodeIds ?? [])], sourceRoots = [...new Set(sourceIds.flatMap(id => rootOf.has(id) ? [rootOf.get(id)!] : []))]
    let rootId = sourceRoots[0]
    if (!rootId) {
      if (!vocabularyRoot) {
        vocabularyRoot = nid('root')
        state.nodes.push({ id: vocabularyRoot, rootId: vocabularyRoot, type: 'root', position: { x: 650 * roots.length, y: 0 }, bookmarked: false, collapsed: false, data: { name: 'Imported vocabulary' } })
      }
      rootId = vocabularyRoot
    }
    const meaning = entry.definition?.trim() ?? '', chunkId = nid('chunk')
    let itemId: string | undefined
    if (meaning && containsHanzi(entry.term)) {
      // Same term/sense maps to one new production card; every original entry and
      // its individual SRS metadata still survives on its imported vocabulary chunk.
      const senseKey = meaning.length <= 1000 ? meaning : `Original definition ${entry.id}: ${meaning.slice(0, 700)}`
      const identity = JSON.stringify([entry.term.normalize('NFC').trim(), meaning.normalize('NFC').trim().toLocaleLowerCase()])
      let item = itemIdentities.get(identity)
      if (!item) {
        item = { id: entry.id, language: 'zh', kind: 'phrase', canonicalText: entry.term, senseKey, meaning, ...(entry.pinyin ? { pinyin: entry.pinyin } : {}),
          sourceNodeIds: sourceIds, sourceRootIds: sourceRoots.length ? sourceRoots : [rootId], createdAt: entry.addedTimestamp, originalSrs: originalSrsSchema.strip().parse(entry) }
        itemIdentities.set(identity, item); state.items.push(item)
        state.cards.push({ id: nid('card'), itemId: item.id, learnerId: learner.id, skill: 'production', box: 1, status: 'new', policyVersion: 'leitner-v1', introducedAt: null, dueAt: null, lastTransitionAt: null, revision: 0 })
      } else { item.sourceNodeIds = [...new Set([...item.sourceNodeIds, ...sourceIds])]; item.sourceRootIds = [...new Set([...item.sourceRootIds, ...(sourceRoots.length ? sourceRoots : [rootId])])] }
      itemId = item.id
    } else if (!meaning) awaitingMeaning++
    else nonMandarin++
    const owner = state.nodes.find(n => n.id === rootId)!, siblingCount = state.nodes.filter(n => n.type === 'chunk' && n.rootId === rootId).length
    state.nodes.push({ id: chunkId, rootId, type: 'chunk', position: { x: owner.position.x + 350, y: owner.position.y + 170 * (siblingCount + 1) }, bookmarked: false, collapsed: false,
      data: { text: entry.term, pinyin: entry.pinyin ?? '', meaning: entry.definition ?? '', ...(itemId ? { itemId } : {}), originalVocabulary: entry } })
    const source = sourceIds.find(id => rootOf.get(id) === rootId) ?? rootId
    state.edges.push({ id: nid('edge'), source, target: chunkId, data: { kind: 'derived' } })
  }
  if (awaitingMeaning) warnings.push(`${awaitingMeaning} vocabulary entries have no definition. They are retained as unassessed chunks with their original metadata, not scheduled cards. Add a specific meaning with Save a word.`)
  if (nonMandarin) warnings.push(`${nonMandarin} defined entries contain no Hanzi. Their text and metadata remain unassessed chunks; no Mandarin production card was inferred.`)
  if (vocabularyRoot) warnings.push('Unlinked vocabulary was placed in a separate Imported vocabulary topic; no conversation source was invented.')
  if ((original.vocabulary?.length ?? 0) > state.items.length + awaitingMeaning + nonMandarin) warnings.push('Duplicate term/sense entries share one new card; their separate original vocabulary records remain on graph chunks.')
  state.view.activeRootId = roots[0]!.id; state.view.selectedNodeIds = [roots[0]!.id]
  return { state: validateWorkspace(state), warnings, vocabularyCount: original.vocabulary?.length ?? 0, awaitingMeaning }
}

export async function previewOriginalImport(file: Pick<File, 'size' | 'text'>, expected: WorkspaceVersion, now = Date.now()): Promise<RestorePreview> {
  if (file.size > MAX_BACKUP_BYTES) throw new Error('Original-project files must be 25 MiB or smaller.')
  const imported = importOriginalGraph(await file.text(), now)
  const backup = parseBackup(JSON.stringify(exportBackup({ state: imported.state, version: expected, hasCheckpoint: false }, now)))
  return { kind: 'original', expected: { ...expected }, backup, counts: counts(imported.state), warnings: [
    'Replace, not merge: the current workspace becomes one local recovery checkpoint. Download a backup first.',
    ...imported.warnings, 'Import is local and does not start teaching, introduce cards, or resume a paid request. Keep the original export as a separate archive.',
  ] }
}
