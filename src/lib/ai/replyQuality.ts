/** Conservative loop detection, not a language-quality or correctness assessment.
 * Keep rejected text as evidence; never silently rewrite it or retry a paid call.
 */
export function unusableReplyReason(text: string, completed = false): string | undefined {
  const trimmed = text.trim()
  if (!trimmed) return completed ? 'The model returned no readable reply. Retry the response or choose another model in Settings.' : undefined
  const sample = trimmed.slice(-4096).replace(/\s/gu, '')
  const minimum = completed ? 32 : 64
  if (sample.length >= minimum && !/[\p{L}\p{N}]/u.test(sample)) {
    const counts = new Map<string, number>()
    for (const char of sample) counts.set(char, (counts.get(char) ?? 0) + 1)
    if (Math.max(...counts.values()) >= [...sample].length * 0.8) return 'The model returned repeated symbols instead of a readable reply. The output is preserved; retry or choose another model in Settings.'
  }
  // A long, dominant repeated tail catches loops spanning many SSE deltas, while
  // allowing normal punctuation, reduplication, short drills and quoted examples.
  const repeated = sample.match(/(.{1,64})\1{15,}$/u)?.[0]
  if (repeated && repeated.length >= 256 && repeated.length >= trimmed.replace(/\s/gu, '').length * 0.8) {
    return 'The model appears stuck repeating itself. This request was stopped and its output preserved. Retry or choose another model in Settings.'
  }
  return undefined
}
