import type { Node } from '@xyflow/svelte'

export type RootData = { name: string }
export type UserData = { text: string }
export type AssistantData = {
  text: string
  reasoning: string
  streaming: boolean
  error: string
  state?: 'complete' | 'interrupted' | 'error'
  provider?: string
  model?: string
  editedAt?: number
  regeneratedFrom?: string
}

export type RootNodeType = Node<RootData, 'root'>
export type UserNodeType = Node<UserData, 'user'>
export type AssistantNodeType = Node<AssistantData, 'assistant'>
export type AppNode = RootNodeType | UserNodeType | AssistantNodeType

export type { ChatMessage } from '../ai/types'
