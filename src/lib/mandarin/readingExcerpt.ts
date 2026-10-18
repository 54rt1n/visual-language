/** A display-only excerpt around an exact selection in an unchanged source window.
 * Code-point clipping never rewrites the saved selection, pronunciation or context.
 */
export function readingExcerpt(selection: { context: string; contextStart: number; start: number; end: number; text: string }, radius = 16) {
  const { context, contextStart, start, end, text } = selection
  const from = start - contextStart, to = end - contextStart
  if (!Number.isInteger(radius) || radius < 0 || radius > 200 || !Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to <= from || to > context.length || context.slice(from, to) !== text || /^[\uDC00-\uDFFF]/.test(text) || /[\uD800-\uDBFF]$/.test(text)) throw new Error('The reading excerpt must match its source selection.')
  const before = [...context.slice(0, from)], after = [...context.slice(to)]
  return { before: radius ? before.slice(-radius).join('') : '', selected: text, after: after.slice(0, radius).join(''), leading: before.length > radius, trailing: after.length > radius }
}
