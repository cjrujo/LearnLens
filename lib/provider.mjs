import { deflateSync } from 'node:zlib';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import https from 'node:https';
import { Readable } from 'node:stream';

export class AppError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export function boundedString(value, label, max = 200, required = true) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
    throw new AppError(`${label} must be ${required ? 'non-empty ' : ''}text, at most ${max} characters.`);
  }
  return value.trim();
}

export function normalizeBaseUrl(value) {
  let url;
  try { url = new URL(boundedString(value, 'Base URL', 2048)); }
  catch { throw new AppError('Enter a valid API base URL, including https:// and the API prefix (usually /v1).'); }
  if (url.username || url.password || url.search || url.hash) throw new AppError('Base URL cannot contain credentials, query parameters, or fragments.');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new AppError('Use HTTPS for remote providers. HTTP is allowed only for localhost providers.');
  if (/\/(models|responses|chat\/completions|audio\/speech|audio\/transcriptions)\/?$/.test(url.pathname)) throw new AppError('Use the API base URL, not a specific endpoint. For example: https://api.openai.com/v1');
  return url.toString().replace(/\/+$/, '');
}

export function publicProvider(provider) {
  return { id: provider.id, name: provider.name, baseUrl: provider.baseUrl, hasKey: Boolean(provider.apiKey), models: provider.models, checks: provider.checks };
}

const statusMessages = {
  400: 'rejected the request. Check the model, endpoint mode, inputs and thinking level; try Default if reasoning effort is unsupported',
  401: 'rejected authorization. Check your API key',
  403: 'denied access. Check model permissions and provider availability',
  404: 'could not find the endpoint or model. Check the API prefix and model ID; manual model selection is available',
  405: 'does not support this endpoint method',
  413: 'rejected the input size. Try a smaller image or recording',
  429: 'rate-limited the request or has insufficient credit. Check your account and retry later',
  500: 'encountered an internal error. Retry later',
  501: 'does not implement this endpoint',
  503: 'is temporarily unavailable',
};

export async function readLimited(response, max = 3 * 1024 * 1024) {
  if (Number(response.headers.get('content-length')) > max) { await response.body?.cancel(); throw new AppError('Provider response is too large.', 502); }
  const chunks = []; let size = 0;
  if (!response.body) return Buffer.alloc(0);
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > max) throw new AppError('Provider response is too large.', 502);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// In hosted mode, custom providers must resolve exclusively to public IPs.
// Pin the checked address into the HTTPS connection to prevent DNS rebinding.
export function isPublicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && [0, 168].includes(b)) || (a === 192 && b === 88 && c === 99) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && ([18, 19].includes(b) || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  // Restrict to global unicast; exclude transition mechanisms (Teredo/6to4),
  // documentation and special-use ranges, including zero-padded spellings.
  if (isIP(address) !== 6 || !/^[23][0-9a-f]{3}:/i.test(address)) return false;
  const [first, second] = address.split(':').map(value => parseInt(value || '0', 16));
  return first !== 0x2002 && !(first === 0x2001 && (second < 0x200 || second === 0xdb8)) && !(first === 0x3fff && second < 0x1000);
}

async function hostedFetch(urlString, options) {
  const url = new URL(urlString);
  if (url.protocol !== 'https:') throw new AppError('Hosted LearnLens only allows public HTTPS providers.');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await lookup(hostname, { all: true });
  if (!addresses.length || addresses.some(entry => !isPublicAddress(entry.address))) throw new AppError('Hosted LearnLens cannot contact private or local network providers.');
  const pinned = addresses[0];
  let body = options.body;
  const headers = { ...options.headers };
  if (body instanceof FormData) {
    const encoded = new Request(url, { method: 'POST', body });
    headers['Content-Type'] = encoded.headers.get('content-type');
    body = Buffer.from(await encoded.arrayBuffer());
  }
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: options.method, headers, signal: options.signal,
      lookup: (_name, lookupOptions, callback) => lookupOptions.all ? callback(null, [pinned]) : callback(null, pinned.address, pinned.family),
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400) { res.resume(); reject(new AppError('Provider redirects are not followed. Use the final API base URL.', 502)); return; }
      try {
        if (res.statusCode < 200 || res.statusCode > 599) throw new Error('Invalid upstream status.');
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(res.headers)) if (value !== undefined) responseHeaders.set(key, Array.isArray(value) ? value.join(', ') : value);
        const noBody = [204, 205, 304].includes(res.statusCode);
        if (noBody) res.resume();
        resolve(new Response(noBody ? null : Readable.toWeb(res), { status: res.statusCode, headers: responseHeaders }));
      } catch { res.resume(); reject(new AppError('Provider returned an invalid HTTP response.', 502)); }
    });
    req.on('error', reject);
    req.end(body);
  });
}

function parseProviderWire(data, response, path) {
  const operation = { '/responses': 'Responses (/responses)', '/chat/completions': 'Chat Completions (/chat/completions)', '/models': 'Model discovery (/models)', '/audio/transcriptions': 'Transcription (/audio/transcriptions)' }[path] || 'Provider API';
  const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const media = ['application/json', 'application/problem+json', 'text/event-stream', 'text/html', 'text/plain'].includes(type) ? type : type ? 'unrecognized content type' : 'no content type';
  const fail = (detail, advice = 'Check the gateway API route and its compatibility with the selected API mode. No automatic retry was made.') => new AppError(`${operation} (HTTP ${response.status}, ${media}, ${data.length} bytes): ${detail} ${advice}`, 502);
  const providerError = value => {
    const code = value?.code || value?.type;
    const adviceMap = { invalid_api_key: 'Check the provider API key and authorization.', authentication_error: 'Check the provider API key and authorization.', insufficient_quota: 'Check provider quota and billing.', rate_limit_exceeded: 'The provider rate limit was reached; wait before retrying.', model_not_found: 'Check the model ID and account access.', unsupported_parameter: 'Check endpoint, model and thinking-level compatibility.', context_length_exceeded: 'Reduce the material size.', content_policy_violation: 'The provider declined this content.' };
    const advice = typeof code === 'string' && Object.hasOwn(adviceMap, code) ? adviceMap[code] : null;
    return fail('The provider returned an error envelope.', advice || 'Check provider logs, model access and account limits. Upstream messages are omitted to protect keys and lesson material.');
  };
  const text = data.toString('utf8').replace(/^\uFEFF/, '').trim();
  if (!text) throw fail('The response body was empty.', 'Check gateway/proxy logs and timeouts. A completed API response is required.');
  let parsed;
  try { parsed = JSON.parse(text); }
  catch {
    if (type === 'text/html' || /^\s*(?:<!doctype\s+html|<html\b)/i.test(text)) throw fail('The server returned HTML instead of API JSON.', 'This is often a website/login/error page. Check the API base path (usually ending in /v1), proxy routing and authentication.');
    if (type !== 'text/event-stream' && !/^(?:data:|event:|:)/m.test(text)) throw fail('The response contains malformed or truncated JSON.');
    if (!['/responses', '/chat/completions'].includes(path)) throw fail('This operation unexpectedly returned a streamed response.');
    const records = text.replace(/\r\n?/g, '\n').split(/\n\n+/);
    if (records.length > 20000) throw fail('The stream contains too many events.');
    let content = '', done = false, finishReason = null, completed = null;
    for (const record of records) {
      const value = record.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
      if (!value) continue;
      if (value.trim() === '[DONE]') { done = true; continue; }
      let event;
      try { event = JSON.parse(value); if (!event || Array.isArray(event) || typeof event !== 'object') throw new Error(); }
      catch { throw fail('The stream contains a malformed JSON event.'); }
      if (event.error || ['error', 'response.failed'].includes(event.type)) throw providerError(event.error || event.response?.error || event);
      if (path === '/chat/completions') {
        if (typeof event.type === 'string' && event.type.startsWith('response.')) throw fail('The gateway sent Responses events to the Chat Completions endpoint.', 'Select Responses API mode or correct the gateway routing.');
        if (event.choices !== undefined && !Array.isArray(event.choices)) throw fail('The stream contains malformed Chat Completions choices.');
        const choice = event.choices?.find(item => (item?.index ?? 0) === 0);
        if (typeof choice?.delta?.content === 'string') content += choice.delta.content;
        if (choice?.finish_reason) finishReason = choice.finish_reason;
      } else {
        if (Array.isArray(event.choices)) throw fail('The gateway sent Chat Completions events to the Responses endpoint.', 'Select Chat Completions API mode or correct the gateway routing.');
        if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') content += event.delta;
        if (['response.completed', 'response.incomplete'].includes(event.type) && event.response && typeof event.response === 'object' && !Array.isArray(event.response)) {
          completed = { ...event.response, status: event.type === 'response.incomplete' ? 'incomplete' : 'completed' };
        }
      }
    }
    if (path === '/chat/completions') {
      if (!done && !finishReason) throw fail('The stream ended before a completion marker.', 'The response may be incomplete. Check gateway timeouts; retry only when you are ready for another potentially billable request.');
      parsed = { choices: [{ message: { content }, finish_reason: finishReason }] };
    } else {
      if (!completed) throw fail('The Responses stream ended without a completed response.', 'Check gateway streaming support and timeouts, or explicitly choose Chat Completions if supported.');
      parsed = completed;
      if (!parsed.output_text && !parsed.output?.length && content) parsed.output_text = content;
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw fail(`Expected an API JSON object, but received ${Array.isArray(parsed) ? 'an array' : parsed === null ? 'null' : 'a ' + typeof parsed}.`);
  if (parsed.error) throw providerError(parsed.error);
  return parsed;
}

export async function providerRequest(provider, path, { body, form, timeout = 100_000, binary = false } = {}) {
  try {
    const headers = { Accept: binary ? 'audio/*' : 'application/json' };
    if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
    if (body) headers['Content-Type'] = 'application/json';
    const response = await (provider.publicOnly ? hostedFetch : fetch)(`${provider.baseUrl}${path}`, {
      method: body || form ? 'POST' : 'GET', headers,
      body: form || (body ? JSON.stringify(body) : undefined),
      signal: AbortSignal.timeout(timeout), redirect: 'error',
    });
    if (!response.ok) {
      await response.body?.cancel();
      const error = new AppError(`Provider ${statusMessages[response.status] || 'returned an error'} (HTTP ${response.status}).`, 502);
      error.providerStatus = response.status;
      throw error;
    }
    const data = await readLimited(response, binary ? 8 * 1024 * 1024 : 3 * 1024 * 1024);
    if (binary) return { data, mime: response.headers.get('content-type')?.split(';')[0] || 'application/octet-stream' };
    return parseProviderWire(data, response, path);
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error.name === 'TimeoutError' || error.name === 'AbortError') throw new AppError('Provider request timed out. Try again or choose a faster model.', 504);
    // Never echo upstream bodies, URLs with credentials, or raw transport errors.
    throw new AppError('Could not reach the provider. Check the URL, TLS certificate, and network. Redirects are not followed.', 502);
  }
}

export async function discoverModels(provider) {
  const result = await providerRequest(provider, '/models', { timeout: 20_000 });
  if (!Array.isArray(result.data)) throw new AppError('Provider model list must contain a data array. You can enter model IDs manually.', 502);
  const ids = [...new Set(result.data.filter(m => typeof m?.id === 'string' && m.id.length && m.id.length <= 200 && !/[\r\n\x00]/.test(m.id)).map(m => m.id))];
  return ids.sort((a, b) => a.localeCompare(b)).slice(0, 2000).map(id => ({ id }));
}

export async function generateText(provider, role, { instructions, text, images = [], maxTokens = 10_000 }) {
  async function request(api) {
    let result;
    if (api === 'responses') {
      result = await providerRequest(provider, '/responses', { body: {
        model: role.model, instructions, stream: false, max_output_tokens: maxTokens,
        ...(role.reasoningEffort && role.reasoningEffort !== 'default' ? { reasoning: { effort: role.reasoningEffort } } : {}),
        input: [{ role: 'user', content: [ { type: 'input_text', text }, ...images.map(image => ({ type: 'input_image', image_url: image.dataUrl })) ] }],
      } });
      if (Array.isArray(result.choices)) throw new AppError('The /responses endpoint returned Chat Completions format. Select Chat Completions for the primary role or correct the gateway routing. No automatic retry was made.', 502);
      if (result.status === 'incomplete') throw new AppError('Model output was truncated. Request a shorter lesson or use another model.', 502);
      const output = typeof result.output_text === 'string' ? result.output_text : (Array.isArray(result.output) ? result.output : []).filter(item => item?.type === 'message').flatMap(item => Array.isArray(item.content) ? item.content : []).filter(part => part?.type === 'output_text' && typeof part.text === 'string').map(part => part.text).join('\n');
      if (!output?.trim()) throw new AppError('Model returned no text (possibly a refusal or incompatible response format).', 502);
      return { text: output, api };
    }
    result = await providerRequest(provider, '/chat/completions', { body: {
      model: role.model, stream: false, max_completion_tokens: maxTokens,
      ...(role.reasoningEffort && role.reasoningEffort !== 'default' ? { reasoning_effort: role.reasoningEffort } : {}),
      messages: [{ role: 'system', content: instructions }, { role: 'user', content: images.length ? [{ type: 'text', text }, ...images.map(image => ({ type: 'image_url', image_url: { url: image.dataUrl } }))] : text }],
    } });
    if (result.output || result.output_text) throw new AppError('The /chat/completions endpoint returned Responses format. Select Responses for the primary role or correct the gateway routing. No automatic retry was made.', 502);
    if (result.choices?.[0]?.finish_reason === 'length') throw new AppError('Model output was truncated. Request a shorter lesson or use another model.', 502);
    const content = result.choices?.[0]?.message?.content;
    const output = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(p => p?.type === 'text' && typeof p.text === 'string').map(p => p.text).join('\n') : '';
    if (!output.trim()) throw new AppError('Model returned no text (possibly a refusal or incompatible response format).', 502);
    return { text: output, api };
  }
  if (role.api === 'chat' || role.api === 'responses') return request(role.api);
  try { return await request('responses'); }
  catch (error) {
    // Only a missing/unsupported endpoint triggers fallback, never auth, quota, or generic failures.
    if (![404, 405, 501].includes(error.providerStatus)) throw error;
    return request('chat');
  }
}

export function decodeDataUrl(value, category, maxBytes = 8 * 1024 * 1024) {
  if (typeof value !== 'string') throw new AppError(`Expected a ${category} data URL.`);
  const match = /^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(value);
  if (!match || match[2].length % 4 !== 0) throw new AppError('Invalid base64 data URL.');
  const mime = match[1].toLowerCase();
  const imageTypes = ['image/png', 'image/jpeg', 'image/webp'];
  const audioTypes = ['audio/webm', 'audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/ogg', 'video/webm', 'video/mp4'];
  if (!(category === 'image' ? imageTypes : audioTypes).includes(mime)) throw new AppError(`Unsupported ${category} format.`);
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.length > maxBytes || buffer.toString('base64') !== match[2]) throw new AppError(`Invalid or oversized ${category} (maximum ${Math.round(maxBytes / 1024 / 1024)} MB).`);
  const actual = sniffMedia(buffer);
  const normalized = mime.replace('audio/x-wav', 'audio/wav').replace('audio/mp3', 'audio/mpeg').replace('video/', 'audio/');
  if (actual !== normalized) throw new AppError(`The ${category} contents do not match its declared format.`);
  return { mime: normalized, buffer, dataUrl: `data:${normalized};base64,${match[2]}` };
}

export function sniffMedia(b) {
  if (b.length < 12) return null;
  if (b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) return 'image/jpeg';
  if (b.toString('ascii', 0, 4) === 'RIFF') {
    if (b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
    if (b.toString('ascii', 8, 12) === 'WAVE') return 'audio/wav';
  }
  if (b.toString('ascii', 0, 3) === 'ID3' || (b[0] === 255 && (b[1] & 224) === 224)) return 'audio/mpeg';
  if (b.toString('ascii', 0, 4) === 'OggS') return 'audio/ogg';
  if (b.toString('ascii', 4, 8) === 'ftyp') return 'audio/mp4';
  if (b.subarray(0, 4).equals(Buffer.from([26,69,223,163]))) return 'audio/webm';
  return null;
}

export async function generateSpeech(provider, role, text) {
  const { data } = await providerRequest(provider, '/audio/speech', { binary: true, body: { model: role.model, voice: role.voice || 'alloy', input: text, response_format: provider.speechFormat || 'mp3' } });
  const mime = sniffMedia(data);
  if (!mime?.startsWith('audio/')) throw new AppError('Speech provider did not return a supported audio file.', 502);
  return { dataUrl: `data:${mime};base64,${data.toString('base64')}`, bytes: data.length };
}

export async function transcribeAudio(provider, role, audio, name) {
  const form = new FormData();
  form.set('model', role.model);
  form.set('file', new Blob([audio.buffer], { type: audio.mime }), name);
  const result = await providerRequest(provider, '/audio/transcriptions', { form });
  if (typeof result.text !== 'string' || !result.text.trim() || result.text.length > 40_000) throw new AppError('Transcription did not return usable text.', 502);
  return result.text;
}

// Small synthetic green PNG for an opt-in vision test. No user data is sent.
export function probeImage() {
  function crc32(buffer) {
    let crc = -1;
    for (const byte of buffer) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
    return (crc ^ -1) >>> 0;
  }
  function chunk(type, data) {
    const tag = Buffer.from(type), head = Buffer.alloc(4), tail = Buffer.alloc(4);
    head.writeUInt32BE(data.length); tail.writeUInt32BE(crc32(Buffer.concat([tag, data])));
    return Buffer.concat([head, tag, data, tail]);
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(16, 0); ihdr.writeUInt32BE(16, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc(16 * 49);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) raw[y * 49 + 1 + x * 3 + 1] = 180;
  const data = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  return { name: 'capability-test.png', dataUrl: `data:image/png;base64,${data.toString('base64')}` };
}
