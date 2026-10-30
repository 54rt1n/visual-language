export type ToolCall = {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[]; reasoning_content?: string }
  | { role: 'tool'; content: string; tool_call_id: string }

export type ToolDefinition = {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}
export type ToolChoice = 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } }
export type TokenUsage = { promptTokens: number; completionTokens: number; totalTokens: number }
export type ChatResult = { content: string; reasoning: string; toolCalls: ToolCall[]; finishReason: string; model: string; usage?: TokenUsage;
  toolProtocol?: { representation: 'native' | 'qwen_xml'; rawContent?: string; normalizations?: string[] } }
export type ProviderStreamError = { message?: string; type?: string; code?: string; param?: string }
export type ResponseDiagnostic = {
  httpStatus?: number; requestId?: string; finishReason?: string; terminalReceived: boolean;
  contentCharacters: number; reasoningCharacters: number; nativeToolCalls: number;
  parserStatus: 'pending' | 'complete' | 'failed';
  usage?: TokenUsage;
  nativeShape?: { eventIndex: number; deltaType: string; toolCallsType: string };
}
export type StreamHandlers = {
  onModel?: (model: string) => void
  onContent?: (chunk: string) => void
  onReasoning?: (chunk: string) => void
  onHeartbeat?: () => void
  /** Optional bounded diagnostic; the user-facing thrown error remains generic. */
  onProviderError?: (error: ProviderStreamError) => void
  onDiagnostic?: (diagnostic: ResponseDiagnostic) => void
  /** Evaluation-only native wire evidence; callers must bound any retained events. */
  onWireEvent?: (event: unknown) => void
  signal?: AbortSignal
}
export type ChatOptions = {
  /** Local input/output accounting, excluded from provider payloads. */
  contextBudget?: import('./contextBudget').ContextBudgetEvidence;
  /** Local evaluation provenance; never serialized into a provider request. */
  generationTrace?: {
    workflowVersion: string; promptVersion: string;
    lessonDefinition: { kind: string; version: string };
    modelProfile: { id: string; version: string; hash: string };
    stage: string; settings: { maxTokens: number; temperature: number; reasoning: 'on' | 'off' };
    taskPlacement?: 'system' | 'user_context_tail';
    attempt?: { submission: number; request: number };
    protocol?: { toolResponseDialect: 'native' | 'qwen_xml'; toolChoice?: 'auto' | 'required'; normalizeParameterNameQuotes?: boolean; allowAssistantPrefix?: boolean; normalizeFunctionOpening?: boolean };
  };
  /** Featherless template reasoning; omitted requests keep ordinary chat concise. */
  featherlessThinking?: boolean;
  /** Optional reasoning intent for providers with an explicit reasoning control. */
  reasoningEnabled?: boolean;
  baseUrl: string
  apiKey: string
  model: string
  /** Explicit wire dialect; never inferred from a model name or credential. */
  compatibility?: import('./providers').ProviderCompatibility
  messages: ChatMessage[]
  tools?: ToolDefinition[]
  toolChoice?: ToolChoice
  /** Native lesson stages accept one submission per response. */
  parallelToolCalls?: boolean
  maxTokens?: number
  temperature?: number
  timeoutMs?: number
  handlers?: StreamHandlers
  fetcher?: typeof fetch
  /** Explicit protocol-control option; application requests stream by default. */
  responseMode?: 'stream' | 'complete'
  /** Explicit local decoder for a verified provider/model tool template; never sent on the wire. */
  toolResponseDialect?: 'native' | 'qwen_xml'
  normalizeParameterNameQuotes?: boolean
  allowAssistantPrefix?: boolean
  /** Insert only a missing '<' before the opening offered function in a complete Qwen envelope. */
  normalizeFunctionOpening?: boolean
}
