import type { runProtocolControl } from './native-protocol-controls'
import { isProviderCapacity } from '../../src/lib/ai/inferenceFailure'
type ControlResult = Awaited<ReturnType<typeof runProtocolControl>>
/** Response, tool-schema and whole-stage outcomes describe distinct failure layers. */
export function summarizeProtocolControls(results: ControlResult[], live: boolean) {
  const count = (test: (result: ControlResult) => boolean) => results.filter(test).length
  return { requestsAttempted: results.length, responsesReceived: count(r => r.responseReceived),
    nativeResponsesReceived: count(r => r.responseReceived && r.representation === 'native'),
    adaptedResponsesReceived: count(r => r.responseReceived && r.representation === 'qwen_xml'),
    schemasAccepted: count(r => r.schemaAccepted), contractsAccepted: count(r => r.contractAccepted),
    nativeContractsAccepted: count(r => r.nativeContractAccepted),
    adaptedContractsAccepted: count(r => r.contractAccepted && r.representation === 'qwen_xml'),
    expectedFieldsMatched: count(r => r.expectedFieldsMatch === true), declaredExpectations: count(r => r.hasDeclaredExpectation),
    harnessErrors: results.filter(r => isProviderCapacity(r.failure)).map(r => ({ case: r.caseId, mode: r.responseMode,
      repetition: (r as ControlResult & { repetition?: number }).repetition, category: 'provider_capacity', detail: r.failure })),
    failures: results.filter(r => !r.contractAccepted && !isProviderCapacity(r.failure)).map(r => ({ case: r.caseId, mode: r.responseMode, toolChoice: r.toolChoice,
      repetition: (r as ControlResult & { repetition?: number }).repetition, category: r.failure?.category ?? 'unknown', httpStatus: r.failure?.httpStatus })),
    liveRequests: live ? results.length : 0 }
}
