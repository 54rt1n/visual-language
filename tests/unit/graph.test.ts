import { describe, expect, it } from 'vitest'
import { effectiveConfiguration, primaryPath, validateGraph } from '../../src/lib/graph/contracts'
import { messagesFromGraph } from '../../src/lib/ai/context'
import { graphNodeSchema, type GraphEdge, type GraphNode } from '../../src/lib/domain/graph'
import { workspaceFixture } from './fixtures'

const node = (id: string, type: GraphNode['type'], data: unknown) => graphNodeSchema.parse({ id, type, data, rootId: 'root', position: { x: 0, y: 0 }, bookmarked: false, collapsed: false })
const edge = (source: string, target: string, kind: GraphEdge['data']['kind'] = 'conversation'): GraphEdge => ({ id: `${source}-${target}`, source, target, data: { kind } })
describe('graph contracts and context', () => {
  const root = workspaceFixture().nodes[0]!
  const user = node('u', 'user', { text: '你好' })
  const assistant = node('a', 'assistant', { text: '你好！', reasoning: '', state: 'complete', error: '', provider: 'fixture', model: 'fixture' })
  it('uses only conversation ancestry and rejects ambiguous parents/cycles', () => {
    const nodes = [root, user, assistant], edges = [edge('root', 'u'), edge('u', 'a')]
    expect(primaryPath('a', nodes, [...edges, edge('root', 'a', 'derived')]).map(n => n.id)).toEqual(['root', 'u', 'a'])
    expect(() => primaryPath('a', nodes, [...edges, edge('root', 'a')])).toThrow('two primary')
    expect(() => primaryPath('a', nodes, [edge('a', 'u'), edge('u', 'a')])).toThrow('cycle')
    expect(() => primaryPath('a', nodes, edges, 2)).toThrow('exceeds')
    expect(() => validateGraph(nodes, [edge('a', 'u'), edge('u', 'a')])).toThrow('cycle')
  })
  it('resolves the nearest attachment independently for each type including the trigger', () => {
    const far = node('far', 'systemConfig', { prompt: 'Far instruction' }), near = node('near', 'systemConfig', { prompt: 'Near instruction' })
    const model = node('model', 'modelConfig', { provider: 'featherless', model: 'fixture', temperature: 0.3, maxTokens: 500 })
    const nodes = [root, user, assistant, far, near, model]
    const edges = [edge('root', 'u'), edge('u', 'a'), edge('far', 'root', 'context'), edge('near', 'a', 'context'), edge('model', 'u', 'context')]
    validateGraph(nodes, edges)
    const resolved = effectiveConfiguration('a', nodes, edges)
    expect(resolved.systemConfig!.id).toBe('near'); expect(resolved.modelConfig!.id).toBe('model')
    expect(() => validateGraph(nodes, [...edges, edge('far', 'a', 'context')])).toThrow('conflicting')
  })
  it('bounds conversational content and excludes derived/context messages', () => {
    const nodes = [{ id: 'root', type: 'root', data: { name: 'Root' }, position: { x: 0, y: 0 } },
      { id: 'u', type: 'user', data: { text: '你'.repeat(20_000) }, position: { x: 0, y: 0 } },
      { id: 'other', type: 'user', data: { text: 'not ancestry' }, position: { x: 0, y: 0 } }]
    const messages = messagesFromGraph('u', nodes as Parameters<typeof messagesFromGraph>[1], [edge('root', 'u'), edge('other', 'u', 'context')])
    expect(messages).toHaveLength(2); expect(messages[1]!.content).toHaveLength(12_000)
    expect(JSON.stringify(messages)).not.toContain('not ancestry')
  })
})
