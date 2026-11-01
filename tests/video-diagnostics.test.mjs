import test from 'node:test';
import assert from 'node:assert/strict';
import { videoFailureDiagnostics } from '../lib/video-diagnostics.mjs';

test('video errors retain bounded provider timing/status metadata, never arbitrary prose or private URLs', () => {
  const result = videoFailureDiagnostics({ message: 'PRIVATE source text', diagnostics: {
    category: 'timeout', timeoutMs: 600000, elapsedMs: 600032, timeoutPhase: 'response_headers',
    upstreamStatus: 502, contentType: 'application/json', responseBytes: 80, providerCode: 'convert_request_failed', providerRequestId: 'req-safe-123',
    endpoint: 'https://private.example/path?key=PRIVATE', model: 'PRIVATE', provider: 'PRIVATE', requestBody: 'PRIVATE', responseBody: 'PRIVATE', automaticRetry: true,
  } }, true);
  assert.equal(result.category, 'timeout'); assert.equal(result.timeoutMs, 600000); assert.equal(result.elapsedMs, 600032);
  assert.equal(result.providerRequestId, 'req-safe-123'); assert.equal(result.providerCode, 'convert_request_failed');
  assert.equal(result.automaticRetry, false); assert.equal(result.responseBodyOmitted, true);
  assert.equal(result.endpoint, '/models/{model}:generateContent'); assert.ok(!JSON.stringify(result).includes('PRIVATE'));
});
test('local preparation failure cannot masquerade as dispatched inference or leak diagnostics', () => {
  assert.deepEqual(videoFailureDiagnostics({ diagnostics: { category: 'timeout', providerRequestId: 'req-123' } }, false), {
    version: 1, stage: 'video_analysis', category: 'local_video', automaticRetry: false, responseBodyOmitted: true, providerRequested: false,
  });
});
test('unknown or out-of-range video diagnostic values are discarded', () => {
  const value = videoFailureDiagnostics({ diagnostics: { category: 'PRIVATE', timeoutMs: 600001, elapsedMs: -1, responseBytes: Infinity,
    upstreamStatus: 999, contentType: 'PRIVATE', providerCode: 'PRIVATE', providerRequestId: 'https://PRIVATE', timeoutPhase: 'PRIVATE' } }, true);
  assert.ok(!JSON.stringify(value).includes('PRIVATE')); assert.equal(value.timeoutMs, undefined); assert.equal(value.upstreamStatus, undefined);
});
