import { primaryPath } from '../graph/contracts'
import type { Edge } from '@xyflow/svelte'
import type { ChatMessage } from '../types/graph'
import { unusableReplyReason } from './replyQuality'

export const CONVERSATION_OUTPUT_CONTRACT = `Output only Mandarin Chinese written in Hanzi, with ordinary Chinese punctuation. Do not output pinyin, romanization, Latin letters, English or other-language translations, Arabic numerals, or pronunciation guides. Write quantities with Chinese characters. The application provides pinyin separately.`

export const SYSTEM_PROMPT = `You are Zheng, a Mandarin tutor on a visual conversation graph.
Keep replies short (4–6 sentences) and appropriate for the learner's level and goal.
Stay in the role of a patient tutor. Do not mention being an AI unless asked.
${CONVERSATION_OUTPUT_CONTRACT}`

export function messagesFromGraph(
  triggerId: string,
  nodes: Array<{ id: string; type?: string; data: Record<string, unknown> }>,
  edges: Edge[],
  systemPrompt = SYSTEM_PROMPT,
): ChatMessage[] {
  const path = primaryPath(triggerId, nodes, edges).slice(-40)

  const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt }]

  let remaining = 12_000
  const history: ChatMessage[] = []
  for (const node of path.reverse()) {
    if (node.type === 'user') {
      const text = typeof node.data.text === 'string' ? node.data.text.trim().slice(-remaining) : ''
      if (text) { history.push({ role: 'user', content: text }); remaining -= text.length }
    }
    if (node.type === 'assistant') {
      // Keep bad/legacy output in the graph and backup, but do not teach the next
      // generation to continue an obvious loop. Useful interrupted text remains.
      if (typeof node.data.text === 'string' && unusableReplyReason(node.data.text, true)) continue
      const text = typeof node.data.text === 'string' ? node.data.text.trim().slice(-remaining) : ''
      if (text) { history.push({ role: 'assistant', content: text }); remaining -= text.length }
    }
    if (remaining <= 0) break
  }
  return [...messages, ...history.reverse()]
}
