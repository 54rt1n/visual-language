import { describe, expect, it } from 'vitest'
import { protocolFixture, runProtocolControl, summarizeProtocolControls } from '../evaluation/native-protocol-controls'
import { httpInferenceFailure } from '../../src/lib/ai/inferenceFailure'
const provider = { baseUrl: 'https://example.invalid/v1', apiKey: 'fixture', model: 'fixture', compatibility: 'featherless' as const }
const options = { provider, responseMode: 'stream' as const, toolChoice: 'named' as const, thinking: false }
describe('protocol evidence layer counters', () => {
  it('separates a received response, accepted schema, accepted stage and failed request', async () => {
    const valid = await runProtocolControl('probe', { ...options, transport: protocolFixture })
    const badShape = await runProtocolControl('probe', { ...options, transport: async request => {
      const response = await protocolFixture(request); response.toolCalls[0]!.function.arguments = JSON.stringify({ ack: 'yes' }); return response
    } })
    const badContent = await runProtocolControl('question-build-english-stem', { ...options, transport: async request => {
      const response = await protocolFixture(request); const args = JSON.parse(response.toolCalls[0]!.function.arguments); args.stem = 'What does 分类投放 mean?'; response.toolCalls[0]!.function.arguments = JSON.stringify(args); return response
    } })
    const rejected = await runProtocolControl('probe', { ...options, transport: async () => { throw httpInferenceFailure(422, { message: 'Rejected fixture request.' }) } })
    expect(valid).toMatchObject({ responseReceived: true, schemaAccepted: true, contractAccepted: true })
    expect(badShape).toMatchObject({ responseReceived: true, schemaAccepted: false, contractAccepted: false, failure: { category: 'schema_invalid' } })
    expect(badContent).toMatchObject({ responseReceived: true, schemaAccepted: true, contractAccepted: false, failure: { category: 'constraints_invalid' } })
    expect(rejected).toMatchObject({ responseReceived: false, schemaAccepted: false, contractAccepted: false, failure: { category: 'http_rejected', httpStatus: 422 } })
    expect(summarizeProtocolControls([valid, badShape, badContent, rejected], false)).toMatchObject({
      requestsAttempted: 4, responsesReceived: 3, nativeResponsesReceived: 3, schemasAccepted: 2, contractsAccepted: 1, nativeContractsAccepted: 1, liveRequests: 0 })
    expect(summarizeProtocolControls([valid, badShape, badContent, rejected], false).failures).toHaveLength(3)
  })
  it('reports capacity as a harness error without removing the attempted request', async () => {
    const blocked = await runProtocolControl('probe', { ...options, transport: async () => {
      throw httpInferenceFailure(429, { message: 'Busy', provider: { code: 'concurrency_limit_exceeded' } })
    } })
    const summary = summarizeProtocolControls([blocked], false)
    expect(summary).toMatchObject({ requestsAttempted: 1, responsesReceived: 0, contractsAccepted: 0, failures: [],
      harnessErrors: [expect.objectContaining({ category: 'provider_capacity', detail: expect.objectContaining({ httpStatus: 429 }) })] })
  })
})
