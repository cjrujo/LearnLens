import { lookup as dnsLookup } from 'node:dns/promises';
import https from 'node:https';
import { isIP } from 'node:net';
import { checkServerIdentity } from 'node:tls';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { isAbsolute } from 'node:path';
import { performance } from 'node:perf_hooks';
import { AppError } from './provider.mjs';

// Source URLs have no local-mode exception. Do not reuse provider URL policy.
// Identity-only HTTP is intentional: no decompressor, automatic redirects,
// retries, proxy agent, cookie jar, netrc, or authentication is involved.
const MAX_URL = 8192;
const MAX_FILE = 1024 * 1024 * 1024;
const MAX_BUFFER = 8 * 1024 * 1024;
const MAX_TIMEOUT = 10 * 60 * 1000;
const DEFAULT_TIMEOUT = 60_000;
const MAX_REDIRECTS = 5;
const MAX_HEADERS = 16 * 1024;
const WRITE_BLOCK = 64 * 1024;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const safeErrors = new WeakSet();

function failure(message, status = 502) {
  const error = new AppError(message, status);
  safeErrors.add(error);
  return error;
}
const invalidUrl = () => failure('Use an unambiguous public HTTPS URL on port 443 without credentials.', 400);
const transportFailure = () => failure('Source transfer failed. No automatic retry was made.');
const invalidResponse = () => failure('Source returned an unsupported or malformed HTTP response.');
const tooLarge = () => failure('Source exceeds the permitted byte limit.', 413);
const truncated = () => failure('Source response was incomplete. No automatic retry was made.');
function safeFailure(error) { return safeErrors.has(error) ? error : transportFailure(); }

function ipv4Number(address) {
  return address.split('.').reduce((n, octet) => n * 256 + Number(octet), 0);
}

function ipv6Number(address) {
  // isIP alone accepts scoped IPv6; scoped addresses are never source targets.
  if (typeof address !== 'string' || address.includes('%') || isIP(address) !== 6) return null;
  let text = address.toLowerCase();
  if (text.includes('.')) {
    const index = text.lastIndexOf(':');
    const v4 = ipv4Number(text.slice(index + 1));
    text = `${text.slice(0, index)}:${Math.floor(v4 / 65536).toString(16)}:${(v4 % 65536).toString(16)}`;
  }
  const sides = text.split('::');
  const left = sides[0] ? sides[0].split(':') : [];
  const right = sides.length === 2 && sides[1] ? sides[1].split(':') : [];
  const groups = sides.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  return groups.reduce((n, group) => (n << 16n) | BigInt(parseInt(group, 16)), 0n);
}

/** Conservative globally routable address policy, independent of provider mode.
 * Excludes special-use IPv4, mapped/compatible/NAT64 IPv6, ULA/link-local,
 * multicast, Teredo/6to4, IETF protocol assignments, documentation and 6bone.
 * Globally reachable exceptions inside special-use blocks are deliberately denied.
 */
export function isPublicSourceAddress(address) {
  if (typeof address !== 'string' || address.includes('%')) return false;
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 192 && b === 88 && c === 99) || (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113));
  }
  const n = ipv6Number(address);
  if (n === null || n >> 125n !== 1n) return false; // Only 2000::/3.
  const first = Number(n >> 112n), second = Number((n >> 96n) & 65535n);
  return first !== 0x2002 && first !== 0x3ffe &&
    !(first === 0x2001 && (second < 0x200 || second === 0xdb8)) &&
    !(first === 0x3fff && second < 0x1000);
}

function checkUrlText(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_URL || Buffer.byteLength(value) > MAX_URL ||
    /[\s\p{Cc}\\]/u.test(value) || /%(?![a-f\d]{2})/i.test(value) ||
    /%(?:0[a-f\d]|1[a-f\d]|5c|7f)|%c2%(?:8[a-f\d]|9[a-f\d])/i.test(value)) throw invalidUrl();
}

/** Returns a canonical string, preserving the (sensitive) query, removing hash.
 * Rejects encoded/legacy numeric hosts, empty userinfo, non-443/ambiguous ports,
 * raw Unicode hosts (use ASCII IDNA), trailing dots and special-use DNS suffixes.
 * Escaped controls/backslashes are rejected. Encoded spaces in paths/queries
 * remain encoded and are valid; they are not HTTP request-line whitespace.
 * Neither the returned URL nor redirect locations are suitable for diagnostics.
 */
export function normalizeSourceUrl(value) {
  checkUrlText(value);
  const authority = /^https:\/\/([^/?#]+)/i.exec(value)?.[1];
  if (!authority || /[%@\\]/.test(authority)) throw invalidUrl();
  let host, port;
  if (authority.startsWith('[')) {
    const match = /^(\[[\da-f:.]+\])(?::(443))?$/i.exec(authority);
    if (!match) throw invalidUrl();
    host = match[1]; port = match[2];
    if (!isPublicSourceAddress(host.slice(1, -1))) throw invalidUrl();
  } else {
    const match = /^([^:]+)(?::(443))?$/.exec(authority);
    if (!match) throw invalidUrl();
    host = match[1]; port = match[2];
    if (isIP(host) === 4) {
      if (!isPublicSourceAddress(host)) throw invalidUrl();
    } else {
      const labels = host.toLowerCase().split('.');
      if (host.length > 253 || labels.length < 2 || labels.some(label =>
        !/^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/.test(label)) ||
        !/[a-z]/.test(labels.at(-1)) ||
        /(?:^|\.)(?:localhost|localdomain|local|internal|intranet|lan|home|corp|test|invalid|example|onion|alt|arpa)$/i.test(host)) throw invalidUrl();
    }
  }
  let url;
  try { url = new URL(value); } catch { throw invalidUrl(); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') ||
    (port && port !== '443')) throw invalidUrl();
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!host.startsWith('[') && url.hostname !== host.toLowerCase()) throw invalidUrl();
  // The WHATWG parser recognizes legacy numeric forms; only strict isIP input
  // was allowed above. Recheck its canonical result as an additional barrier.
  if (isIP(hostname) && !isPublicSourceAddress(hostname)) throw invalidUrl();
  url.hash = '';
  if (url.href.length > MAX_URL) throw invalidUrl();
  return url.href;
}

function canonical(value) { return normalizeSourceUrl(value instanceof URL ? value.href : value); }
function redirectUrl(location, current) {
  checkUrlText(location);
  if (/^[a-z][a-z\d+.-]*:/i.test(location)) return normalizeSourceUrl(location);
  if (location.startsWith('//')) return normalizeSourceUrl(`https:${location}`);
  try { return normalizeSourceUrl(new URL(location, current).href); }
  catch { throw invalidUrl(); }
}

// One monotonic, non-resetting deadline. wait() observes abort independently of
// DNS, ClientRequest, IncomingMessage, or callback completion/events. Late DNS
// results are observed only to settle their promise, never to initiate a request.
function operationScope(signal, timeoutMs) {
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw failure('Invalid source cancellation signal.', 400);
  const controller = new AbortController();
  const deadline = performance.now() + timeoutMs;
  const timeoutError = () => failure('Source transfer exceeded its total deadline. No automatic retry was made.', 504);
  const stop = error => { if (!controller.signal.aborted) controller.abort(safeFailure(error)); };
  const onAbort = () => stop(failure('Source transfer was cancelled. No automatic retry was made.', 499));
  const timer = setTimeout(() => stop(timeoutError()), timeoutMs);
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  function check() {
    if (!controller.signal.aborted && performance.now() >= deadline) stop(timeoutError());
    if (controller.signal.aborted) throw controller.signal.reason;
  }
  function wait(run) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (callback, value) => {
        if (settled) return;
        settled = true;
        controller.signal.removeEventListener('abort', cancelled);
        callback(value);
      };
      const cancelled = () => settle(reject, controller.signal.reason);
      controller.signal.addEventListener('abort', cancelled, { once: true });
      Promise.resolve().then(() => { check(); return run(); }).then(value => {
        try { check(); settle(resolve, value); }
        catch (error) { settle(reject, safeFailure(error)); }
      }, error => settle(reject, safeFailure(error)));
      if (controller.signal.aborted) cancelled();
    });
  }
  return {
    signal: controller.signal, check, wait, stop,
    close() { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); },
  };
}

function optionsFor(options, ceiling, defaultBytes) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw failure('Invalid source transfer options.', 400);
  const { signal, maxBytes = defaultBytes, timeoutMs = DEFAULT_TIMEOUT, onProgress, limitForHeaders, allowUrl } = options;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > ceiling ||
    !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT) {
    throw failure('Invalid source byte limit or total deadline.', 400);
  }
  for (const callback of [onProgress, limitForHeaders, allowUrl]) {
    if (callback !== undefined && typeof callback !== 'function') throw failure('Invalid source policy callback.', 400);
  }
  return { signal, maxBytes, timeoutMs, onProgress, limitForHeaders, allowUrl };
}

function peerMatches(address, target) {
  if (typeof address !== 'string') return false;
  if (target.family === 4) {
    if (isIP(address) === 4) return address === target.address;
    // An IPv4 peer can be reported by the OS as IPv4-mapped IPv6. This is
    // representation equivalence only, NOT permission to resolve mapped IPv6.
    const n = ipv6Number(address);
    return n !== null && n >> 32n === 65535n && Number(n & 0xffffffffn) === ipv4Number(target.address);
  }
  return isIP(address) === 6 && ipv6Number(address) === ipv6Number(target.address);
}

function destroy(stream) {
  if (!stream) return;
  // Destruction can emit errors after cancellation; never surface raw details.
  stream.on?.('error', ignoreError);
  try { stream.destroy(); } catch { /* The primary error is already sanitized. */ }
}
function ignoreError() {}

function headersOf(response) {
  const headers = new Map();
  let bytes = 0;
  const add = (name, value) => {
    if (typeof name !== 'string' || typeof value !== 'string' ||
      !/^[!#$%&'*+.^_`|~\da-z-]+$/i.test(name) || /[\r\n\0]/.test(value)) throw invalidResponse();
    bytes += name.length + value.length + 4;
    if (bytes > MAX_HEADERS) throw invalidResponse();
    const key = name.toLowerCase();
    headers.set(key, [...(headers.get(key) || []), value]);
  };
  if (Array.isArray(response.rawHeaders)) {
    if (response.rawHeaders.length % 2) throw invalidResponse();
    for (let i = 0; i < response.rawHeaders.length; i += 2) add(response.rawHeaders[i], response.rawHeaders[i + 1]);
  } else {
    for (const [name, values] of Object.entries(response.headers || {})) {
      for (const value of Array.isArray(values) ? values : [values]) add(name, value);
    }
  }
  return {
    has: name => headers.has(name),
    one(name, trim = true) {
      const values = headers.get(name);
      if (!values) return undefined;
      if (values.length !== 1) throw invalidResponse();
      return trim ? values[0].trim() : values[0];
    },
  };
}

function responseMetadata(response) {
  const headers = headersOf(response);
  if (headers.has('www-authenticate') || headers.has('proxy-authenticate') || headers.has('content-range')) throw invalidResponse();
  const encoding = headers.one('content-encoding');
  // Reject even identity lists/duplicates: no ambiguity and no decompression.
  if (encoding !== undefined && encoding.toLowerCase() !== 'identity') throw invalidResponse();
  const transfer = headers.one('transfer-encoding');
  const length = headers.one('content-length');
  if ((transfer !== undefined && transfer.toLowerCase() !== 'chunked') ||
    (transfer !== undefined && length !== undefined)) throw invalidResponse();
  if (length !== undefined && (!/^(?:0|[1-9]\d*)$/.test(length) || !Number.isSafeInteger(Number(length)))) throw invalidResponse();
  const contentLength = length === undefined ? null : Number(length);
  const type = headers.one('content-type');
  if (type !== undefined && (type.length > 1024 || !type)) throw invalidResponse();
  const contentType = type === undefined ? 'application/octet-stream' : type.split(';', 1)[0].trim().toLowerCase();
  if (!/^[!#$%&'*+.^_`|~\da-z-]+\/[!#$%&'*+.^_`|~\da-z-]+$/.test(contentType)) throw invalidResponse();
  return { headers, contentLength, contentType };
}

/** Construct only in trusted code/tests, never from HTTP-user options.
 * lookup follows dns.promises.lookup(host, {all:true, verbatim:true}); request
 * follows https.request(URL, options, onResponse). No other dependencies/options
 * are taken from the caller's transfer options.
 */
export function createSourceTransport({ lookup = dnsLookup, request = https.request } = {}) {
  if (typeof lookup !== 'function' || typeof request !== 'function') throw failure('Invalid source transport.', 400);

  async function resolveTarget(value, scope) {
    const url = new URL(canonical(value));
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    scope.check();
    const answers = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] :
      await scope.wait(() => lookup(hostname, { all: true, verbatim: true }));
    scope.check();
    if (!Array.isArray(answers) || !answers.length || answers.some(entry =>
      !entry || ![4, 6].includes(entry.family) || isIP(entry.address) !== entry.family || !isPublicSourceAddress(entry.address))) {
      throw failure('Source must resolve exclusively to public network addresses.', 400);
    }
    // Copy rather than retain a resolver-owned mutable record.
    return { url, address: answers[0].address, family: answers[0].family };
  }

  function openResponse(target, scope) {
    let req, res, socket, disposed = false;
    const socketListeners = new Map();
    let ready;
    const responseReady = new Promise(resolve => { ready = resolve; });
    const fail = error => { if (!disposed) scope.stop(error); };
    const dispose = () => {
      disposed = true;
      scope.signal.removeEventListener('abort', dispose);
      for (const [item, listener] of socketListeners) item.removeListener('secureConnect', listener);
      socketListeners.clear();
      destroy(res?.socket); destroy(res); destroy(req); destroy(socket);
    };
    const checkPeer = peer => {
      if (!peer || !peerMatches(peer.remoteAddress, target)) {
        fail(failure('Source connection did not match its validated public address.'));
        return false;
      }
      return true;
    };
    scope.signal.addEventListener('abort', dispose, { once: true });
    const hostname = target.url.hostname.replace(/^\[|\]$/g, '');
    try {
      scope.check();
      req = request(target.url, {
        method: 'GET', protocol: 'https:', hostname, port: 443,
        headers: { 'User-Agent': 'LearnLens-Source/1.0', 'Accept-Encoding': 'identity' },
        agent: false, proxyEnv: {}, timeout: 0, maxHeaderSize: MAX_HEADERS, highWaterMark: WRITE_BLOCK,
        insecureHTTPParser: false, joinDuplicateHeaders: false,
        family: target.family, autoSelectFamily: false,
        servername: isIP(hostname) ? '' : hostname, rejectUnauthorized: true,
        // Explicitly verify the ORIGINAL hostname, never the pinned IP for DNS
        // names. For IP URL literals tls.checkServerIdentity verifies the IP SAN.
        checkServerIdentity: (_name, certificate) => checkServerIdentity(hostname, certificate),
        lookup: (_name, lookupOptions, callback) => {
          // Even a delayed connection attempt after cancellation must not proceed.
          try {
            scope.check();
            if (disposed) throw transportFailure();
          } catch { callback(failure('Source connection was cancelled.')); return; }
          const pinned = { address: target.address, family: target.family };
          if (lookupOptions?.all) callback(null, [pinned]);
          else callback(null, pinned.address, pinned.family);
        },
      }, response => {
        if (disposed || scope.signal.aborted) { destroy(response); destroy(response.socket); return; }
        if (res) { destroy(response); fail(invalidResponse()); return; }
        res = response;
        res.on('error', () => fail(transportFailure()));
        res.on('aborted', () => fail(truncated()));
        res.on('close', () => { if (!res.complete) fail(truncated()); });
        if (!checkPeer(res.socket)) return;
        ready(res);
      });
      req.on('error', () => fail(transportFailure()));
      req.on('close', () => { if (!res) fail(truncated()); });
      req.on('socket', item => {
        if (disposed || scope.signal.aborted) { destroy(item); return; }
        socket = item;
        item.on('error', () => fail(transportFailure()));
        const listener = () => checkPeer(item);
        socketListeners.set(item, listener);
        item.once('secureConnect', listener);
      });
      const upgraded = (_response, upgradedSocket) => {
        destroy(upgradedSocket); destroy(_response);
        fail(failure('Source attempted an unsupported protocol upgrade.'));
      };
      req.on('upgrade', upgraded);
      req.on('connect', upgraded);
      if (disposed || scope.signal.aborted) dispose();
      else req.end();
    } catch (error) { fail(safeFailure(error)); }
    return { response: scope.wait(() => responseReady), dispose };
  }

  async function transfer(value, options, sink, scope) {
    let url = canonical(value);
    const visited = new Set();
    for (let redirects = 0; ; redirects++) {
      scope.check();
      if (visited.has(url)) throw failure('Source redirect loop is not permitted.');
      visited.add(url);
      if (options.allowUrl && await scope.wait(() => options.allowUrl(new URL(url))) !== true) {
        throw failure('Source URL is not permitted by the source policy.', 400);
      }
      const target = await resolveTarget(url, scope);
      const hop = openResponse(target, scope);
      try {
        const response = await hop.response;
        scope.check();
        const { headers, contentLength, contentType } = responseMetadata(response);
        if (REDIRECTS.has(response.statusCode)) {
          if (redirects >= MAX_REDIRECTS) throw failure('Source exceeded the redirect limit.');
          const location = headers.one('location', false);
          if (location === undefined || !location) throw invalidResponse();
          url = redirectUrl(location, url);
          continue;
        }
        if (response.statusCode !== 200) throw invalidResponse();
        let cap = options.maxBytes;
        if (options.limitForHeaders) {
          const policyCap = await scope.wait(() => options.limitForHeaders(Object.freeze({ contentType, contentLength })));
          if (policyCap !== undefined) {
            if (!Number.isSafeInteger(policyCap) || policyCap < 1 || policyCap > MAX_FILE) throw failure('Invalid source header byte limit.', 400);
            cap = Math.min(cap, policyCap);
          }
        }
        if (contentLength !== null && contentLength > cap) throw tooLarge();
        scope.check();
        sink.start(cap, contentLength);
        scope.check();
        const hash = createHash('sha256');
        let size = 0;
        const progress = () => options.onProgress ? scope.wait(() => options.onProgress(Object.freeze({
          receivedBytes: size, ...(contentLength !== null ? { totalBytes: contentLength } : {}),
        }))) : undefined;
        await progress();
        const iterator = response[Symbol.asyncIterator]();
        while (true) {
          const { value: chunk, done } = await scope.wait(() => iterator.next());
          scope.check();
          if (done) break;
          if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) throw invalidResponse();
          if (chunk.byteLength > cap - size) throw tooLarge();
          if (contentLength !== null && chunk.byteLength > contentLength - size) throw truncated();
          // No collecting media chunks. Sink persists each chunk before reading
          // another, with only the native bounded readable queue in flight.
          sink.write(chunk);
          scope.check();
          hash.update(chunk);
          size += chunk.byteLength;
          await progress();
        }
        if (response.complete !== true || (contentLength !== null && size !== contentLength)) throw truncated();
        if (response.rawTrailers?.length || Object.keys(response.trailers || {}).length) throw invalidResponse();
        scope.check();
        sink.finish();
        scope.check();
        return { url, size, contentType, sha256: hash.digest('hex') };
      } finally { hop.dispose(); }
    }
  }

  async function resolvePublicTarget(value, { signal } = {}) {
    const scope = operationScope(signal, DEFAULT_TIMEOUT);
    try { return await resolveTarget(value, scope); }
    catch (error) { throw safeFailure(error); }
    finally { scope.close(); }
  }

  /** Stream to a NEW, exclusive 0600 file in a caller-owned private directory.
   * maxBytes defaults to 64 MiB (hard ceiling 1 GiB); timeoutMs defaults to 60s
   * (hard ceiling 10min), shared by all hops, DNS, callbacks, body and writes.
   * allowUrl(URL clone) must return true, and is evaluated before DNS on EVERY
   * hop. limitForHeaders({contentType,contentLength}) may return a positive byte
   * cap; undefined keeps the existing cap and larger caps cannot enlarge it.
   * onProgress({receivedBytes,totalBytes?}) receives ONLY numeric counts. Policy
   * and progress callbacks may be async; errors/rejections are sanitized.
   *
   * Local filesystem operations are synchronous, with writes sliced to <=64KiB
   * and deadline checks before/after EACH syscall. This avoids uncancellable
   * pending opens/writes recreating a partial file AFTER a cancellation settles.
   * Failure cleanup completes before rejection; existing paths are never removed.
   * As with any in-process deadline, an OS-stalled synchronous syscall or a
   * blocking trusted callback cannot be preempted. Use ordinary local storage,
   * not device/FIFO/network paths; 0600 relies on POSIX mode/parent ACLs on Windows.
   */
  async function downloadSourceFile(value, file, options = {}) {
    const settings = optionsFor(options, MAX_FILE, 64 * 1024 * 1024);
    if (typeof file !== 'string' || !isAbsolute(file) || file.includes('\0')) throw failure('Invalid source destination.', 400);
    const scope = operationScope(settings.signal, settings.timeoutMs);
    let fd = null, created = false, closeFailed = false;
    const close = () => {
      if (fd !== null) {
        const descriptor = fd; fd = null;
        // A failed close has platform-dependent descriptor state. Do not retry
        // the numeric fd (it may already have been reused); report uncertainty.
        try { fs.closeSync(descriptor); }
        catch (error) { closeFailed = true; throw error; }
      }
    };
    const sink = {
      start() {
        scope.check();
        fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
        created = true;
      },
      write(chunk) {
        for (let offset = 0; offset < chunk.byteLength;) {
          scope.check();
          const length = Math.min(WRITE_BLOCK, chunk.byteLength - offset);
          const written = fs.writeSync(fd, chunk, offset, length);
          if (!Number.isSafeInteger(written) || written < 1 || written > length) throw transportFailure();
          offset += written;
          scope.check();
        }
      },
      finish: close,
    };
    try { return await transfer(value, settings, sink, scope); }
    catch (error) {
      let cleanupFailed = closeFailed;
      try { close(); } catch { cleanupFailed = true; }
      if (created) {
        try { fs.unlinkSync(file); }
        catch (cleanupError) { if (cleanupError?.code !== 'ENOENT') cleanupFailed = true; }
      }
      if (cleanupFailed) throw failure('Source failed and its incomplete file could not be fully cleaned up.', 500);
      throw safeFailure(error);
    } finally { scope.close(); }
  }

  /** Separate in-memory wrapper, hard limited to 8 MiB (also its default cap).
   * No file is created, no concatenation/double full-size allocation is needed.
   * The returned view may retain the bounded backing allocation for short bodies.
   */
  async function fetchSourceBuffer(value, options = {}) {
    const settings = optionsFor(options, MAX_BUFFER, MAX_BUFFER);
    // File-only callbacks are not an input surface of the buffer wrapper.
    settings.onProgress = undefined; settings.limitForHeaders = undefined;
    const scope = operationScope(settings.signal, settings.timeoutMs);
    let buffer, size = 0;
    const sink = {
      // A short response must not expose uninitialized bytes through .buffer.
      start(cap, contentLength) { buffer = Buffer.alloc(contentLength ?? cap); },
      write(chunk) { buffer.set(chunk, size); size += chunk.byteLength; },
      finish() {},
    };
    try {
      const result = await transfer(value, settings, sink, scope);
      return { url: result.url, buffer: buffer.subarray(0, size), contentType: result.contentType, sha256: result.sha256 };
    } catch (error) { throw safeFailure(error); }
    finally { scope.close(); }
  }

  return { normalizeSourceUrl, isPublicSourceAddress, resolvePublicTarget, downloadSourceFile, fetchSourceBuffer };
}

const transport = createSourceTransport();
export const resolvePublicTarget = transport.resolvePublicTarget;
export const downloadSourceFile = transport.downloadSourceFile;
export const fetchSourceBuffer = transport.fetchSourceBuffer;
