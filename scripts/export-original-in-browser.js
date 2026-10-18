/* Run explicitly in the ORIGINAL app's browser console, on its original origin.
 * Reads only its three content tables and downloads a local JSON file. Does not
 * read localStorage, credentials, goals, or alter the original database.
 */
(async () => {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('VLLADatabase')
    request.onupgradeneeded = () => { request.transaction.abort(); reject(new Error('No original VLLADatabase exists on this origin. Nothing was created.')) }
    request.onerror = () => reject(new Error('Could not open the original database.'))
    request.onsuccess = () => resolve(request.result)
  })
  try {
    const tables = ['nodes', 'edges', 'vocabulary']
    if (!tables.every(name => db.objectStoreNames.contains(name))) throw new Error('The original content tables are unavailable.')
    const tx = db.transaction(tables, 'readonly')
    const completed = new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(new Error('The read-only export did not complete.')) })
    const reads = tables.map(name => new Promise((resolve, reject) => {
      const request = tx.objectStore(name).getAll()
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new Error('An original content table could not be read.'))
    }))
    const [[nodes, edges, vocabulary]] = await Promise.all([Promise.all(reads), completed])
    const pick = (record, keys) => Object.fromEntries(keys.filter(key => record[key] !== undefined).map(key => [key, record[key]]))
    const fields = {
      root: ['name'], user: ['content'], assistant: ['content', 'reasoning', 'streaming', 'model'],
      mandarinChunk: ['chunkText', 'pinyin', 'sourceNodeId'], modelConfig: ['provider', 'modelId', 'temperature', 'maxTokens'],
      system: ['content'], vocabularyContext: ['terms'], learningConfig: ['languageComplexity', 'pinyinDisplay', 'languageBalance'],
    }
    const result = {
      nodes: nodes.map(node => {
        if (!Object.hasOwn(fields, node.type)) throw new Error('This graph contains node types outside the eight-type importer. No partial export was downloaded.')
        if (node.type === 'mandarinChunk' && node.data.wordSegments !== undefined && (!Array.isArray(node.data.wordSegments) || node.data.wordSegments.length > 1000)) throw new Error('Unsupported original word segments. No partial export was downloaded.')
        return { ...pick(node, ['id', 'type', 'position', 'bookmarked', 'collapsed']), data: {
          ...pick(node.data, fields[node.type]), ...(node.type === 'assistant' && node.data.error ? { error: { message: 'Original request failed.' } } : {}),
          ...(node.type === 'mandarinChunk' && node.data.wordSegments !== undefined ? { wordSegments: node.data.wordSegments.map(segment => pick(segment, ['text', 'startIndex', 'endIndex', 'pinyin'])) } : {}),
        } }
      }),
      edges: edges.map(edge => pick(edge, ['id', 'source', 'target', 'type'])),
      vocabulary: vocabulary.map(entry => ({ ...pick(entry, ['id', 'term', 'pinyin', 'definition', 'sourceNodeIds', 'addedTimestamp', 'masteryLevel', 'category', 'lastSelfAssessmentTimestamp', 'selfAssessmentCorrectCount', 'selfAssessmentIncorrectCount']),
        ...(entry.reviewSchedule ? { reviewSchedule: pick(entry.reviewSchedule, ['nextReviewTimestamp', 'currentIntervalDays', 'easeFactor']) } : {}),
      })),
    }
    const blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' })
    if (blob.size > 25 * 1024 * 1024) throw new Error('This content exceeds the importer’s 25 MiB limit. Nothing was changed.')
    const url = URL.createObjectURL(blob), link = document.createElement('a')
    link.href = url; link.download = 'visual-language-original-content.json'
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30_000)
  } finally { db.close() }
})().catch(() => { console.error('Original content export failed. Check that this is the original app origin with its eight supported node types. No database changes were made.') })
