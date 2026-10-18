/** Provenance bound, not a semantic entailment or translation check. */
export function readingExcerptIssue(example: string, passage: string | undefined): string | null {
  if (!passage) return 'Reading examples require the saved source passage.'
  // Permit surrounding quotation marks, final punctuation and layout whitespace.
  // Keep internal wording/punctuation so disjoint spans cannot be stitched together.
  const normalize = (text: string) => text.normalize('NFKC').replace(/\s/gu, '')
  const excerpt = normalize(example).replace(/^\p{P}+|\p{P}+$/gu, '')
  return excerpt && normalize(passage).includes(excerpt) ? null
    : 'Use a contiguous excerpt from sourceMaterial.passageHanzi for this reading example. Preserve its wording, entities and properties; do not substitute a related material or invent a new example.'
}
