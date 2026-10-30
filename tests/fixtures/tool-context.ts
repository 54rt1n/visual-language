/** Read the app-owned request projection, including instruction metadata. Never model output. */
export function currentToolMessage<T extends { role: string }>(messages: readonly T[]): T {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.role === 'user') return message
  }
  throw new Error('Missing current tool request.')
}

export function parseToolProjection(content: string) {
  if (content.startsWith('Current lesson\n')) {
    const evidence = content.split('\n\nCurrent task:', 1)[0]!
    const fields = [...evidence.matchAll(/^## (.+)\n([\s\S]*?)(?=\n\n## |$(?![\s\S]))/gm)]
    return Object.fromEntries(fields.map(([, label, text]) => {
      const key = label![0]!.toLowerCase() + label!.slice(1).replace(/ ([A-Za-z])/g, (_, letter: string) => letter.toUpperCase())
      const value = text!.trim()
      return [key, value.startsWith('```json\n') ? JSON.parse(value.slice(8, -3)) : value]
    }))
  }
  return JSON.parse(content.split('\n\nTool call:\n', 1)[0]!)
}

/** Task wording belongs to prompt assembly, not the captured lesson evidence. */
export function parseToolContext(content: string) {
  const { currentTask: _task, ...context } = parseToolProjection(content)
  return context
}
