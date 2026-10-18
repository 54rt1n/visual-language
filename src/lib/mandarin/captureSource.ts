import type { GraphNode } from '../domain/graph'

export function isReadingNode(node: GraphNode | undefined): node is Extract<GraphNode, { type: 'assistant' | 'chunk' }> {
  return node?.type === 'assistant' || node?.type === 'chunk'
}

export type ReadingSourceGuard = { nodeId: string; sourceText: string; start: number; end: number }
export function readingSourceMatches(node: GraphNode | undefined, selectedText: string, guard: ReadingSourceGuard) {
  return Boolean(node && node.id === guard.nodeId && 'text' in node.data && node.data.text === guard.sourceText &&
    Number.isInteger(guard.start) && Number.isInteger(guard.end) && guard.start >= 0 && guard.end > guard.start && guard.end <= guard.sourceText.length &&
    guard.sourceText.slice(guard.start, guard.end) === selectedText)
}
