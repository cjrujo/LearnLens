// Fixed-schema metadata only: never copy exception messages, URLs or bodies.
const categories = new Set(['timeout', 'provider_http', 'provider_protocol', 'connection', 'video_validation']);
const types = new Set(['application/json', 'application/problem+json', 'text/event-stream', 'text/html', 'text/plain', 'missing', 'unrecognized']);
const codes = new Set(['convert_request_failed', 'invalid_api_key', 'authentication_error', 'insufficient_quota', 'rate_limit_exceeded', 'model_not_found', 'unsupported_parameter', 'context_length_exceeded', 'content_policy_violation', 'server_error', 'internal_error', 'invalid_request_error', 'overloaded_error']);
export function videoFailureDiagnostics(error, dispatched) {
  const input = error?.diagnostics || {}, output = { version: 1, stage: 'video_analysis', category: dispatched ? 'video_analysis' : 'local_video', automaticRetry: false, responseBodyOmitted: true, providerRequested: dispatched === true };
  if (!dispatched) return output;
  output.endpoint = '/models/{model}:generateContent';
  if (categories.has(input.category)) output.category = input.category;
  for (const [key, low, high] of [['timeoutMs', 1, 600000], ['elapsedMs', 0, 900000], ['upstreamStatus', 100, 599], ['responseBytes', 0, 3 * 1024 * 1024]]) {
    if (Number.isSafeInteger(input[key]) && input[key] >= low && input[key] <= high) output[key] = input[key];
  }
  if (['response_headers', 'response_body'].includes(input.timeoutPhase)) output.timeoutPhase = input.timeoutPhase;
  if (types.has(input.contentType)) output.contentType = input.contentType;
  if (codes.has(input.providerCode)) output.providerCode = input.providerCode;
  // Request IDs have already been checked against credentials by providerRequest.
  if (typeof input.providerRequestId === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(input.providerRequestId)) output.providerRequestId = input.providerRequestId;
  return output;
}
