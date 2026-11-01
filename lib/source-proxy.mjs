import net from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { resolvePublicTarget, isPublicSourceAddress } from './source-fetch.mjs';
import { AppError } from './provider.mjs';

const fail = () => new AppError('YouTube metadata connection was blocked or interrupted. Upload the video instead.', 502);
const MAX_HEADERS = 8192;
const HOST = 'www.youtube.com';

function samePeer(peer, target) {
  if (!peer) return false;
  if (target.family === 4) return peer === target.address || peer.toLowerCase() === `::ffff:${target.address}`;
  try { return new URL(`https://[${peer}]/`).hostname === new URL(`https://[${target.address}]/`).hostname; }
  catch { return false; }
}

/** Per-job, loopback-only CONNECT broker for the TRUSTED pinned extractor.
 * This is not an OS firewall, TLS MITM, HTTP body/decompression cap, or a general
 * fetch endpoint. Deno runs separately with default-deny script permissions.
 * The second argument is a trusted test seam, never an HTTP options surface.
 */
export async function createSourceProxy({ signal, timeoutMs = 60_000, idleTimeoutMs = 15_000,
  maxBytes = 32 * 1024 * 1024, maxConnections = 24, maxConcurrent = 4 } = {},
{ resolve = resolvePublicTarget, connect = options => net.connect(options) } = {}) {
  for (const [value, ceiling] of [[timeoutMs, 60_000], [idleTimeoutMs, 15_000],
    [maxBytes, 32 * 1024 * 1024], [maxConnections, 24], [maxConcurrent, 4]]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) throw fail();
  }
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw fail();
  if (signal?.aborted) throw fail();
  const controller = new AbortController();
  const auth = Buffer.from(`Basic ${Buffer.from(`learnlens:${randomBytes(32).toString('hex')}`).toString('base64')}`);
  const sockets = new Set(), pending = new Set();
  let connections = 0, active = 0, bytes = 0, stopped = false, closing;
  let listening = false;
  const server = net.createServer({ allowHalfOpen: false }, client => {
    track(client);
    connections++; active++;
    client.once('close', () => { active--; });
    if (stopped || connections > maxConnections || active > maxConcurrent) { client.destroy(); stop(); return; }
    client.setTimeout(idleTimeoutMs, stop);
    let header = Buffer.alloc(0);
    const headers = chunk => {
      if (stopped) return;
      if (chunk.length > MAX_HEADERS - header.length) { stop(); return; }
      header = Buffer.concat([header, chunk]);
      const end = header.indexOf('\r\n\r\n');
      if (end < 0) return;
      client.pause(); client.removeListener('data', headers);
      if (end + 4 !== header.length || !validRequest(header)) { stop(); return; }
      // Observe async DNS even after cancellation; the default resolver races
      // abort and never initiates a late connection. No unchecked second lookup.
      const work = openTunnel(client).catch(stop);
      pending.add(work); work.finally(() => pending.delete(work));
    };
    client.on('data', headers);
  });
  function track(socket) {
    sockets.add(socket);
    socket.on('error', stop);
    socket.once('close', () => sockets.delete(socket));
  }
  function validRequest(buffer) {
    const text = buffer.toString('latin1');
    if (/[^\x20-\x7e\r\n]/.test(text)) return false;
    const lines = text.slice(0, -4).split('\r\n');
    if (!/^CONNECT www\.youtube\.com:443 HTTP\/1\.[01]$/.test(lines.shift())) return false;
    const headers = new Map();
    for (const line of lines) {
      const match = /^([a-zA-Z0-9-]+):[ \t]*([^\r\n]*)$/.exec(line);
      if (!match || headers.has(match[1].toLowerCase())) return false;
      headers.set(match[1].toLowerCase(), match[2].trim());
    }
    if (headers.has('content-length') || headers.has('transfer-encoding') || headers.has('upgrade') ||
      (headers.has('host') && headers.get('host') !== `${HOST}:443`)) return false;
    const candidate = Buffer.from(headers.get('proxy-authorization') || '');
    return candidate.length === auth.length && timingSafeEqual(candidate, auth);
  }
  async function openTunnel(client) {
    const target = await resolve(`https://${HOST}/`, { signal: controller.signal });
    if (stopped || client.destroyed) return;
    if (!target || !isPublicSourceAddress(target.address) || net.isIP(target.address) !== target.family) throw fail();
    const upstream = connect({ host: target.address, family: target.family, port: 443, autoSelectFamily: false });
    track(upstream);
    upstream.setTimeout(idleTimeoutMs, stop);
    client.once('close', () => upstream.destroy());
    upstream.once('close', () => client.destroy());
    upstream.once('connect', () => {
      if (stopped || client.destroyed || !samePeer(upstream.remoteAddress, target) || upstream.remotePort !== 443) { stop(); return; }
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      // Count both directions before forwarding; one cumulative encrypted byte
      // budget across ALL tunnels. Backpressure bounds queued memory.
      const forward = (from, to) => {
        from.on('data', chunk => {
          if (stopped) return;
          if (chunk.length > maxBytes - bytes) { stop(); return; }
          bytes += chunk.length;
          if (!to.write(chunk)) from.pause();
        });
        to.on('drain', () => { if (!stopped) from.resume(); });
        from.on('end', () => to.end());
      };
      forward(client, upstream); forward(upstream, client);
      client.resume();
    });
  }
  function stop() {
    if (stopped) return;
    stopped = true;
    controller.abort(fail());
    for (const socket of sockets) socket.destroy();
    if (listening) server.close();
  }
  const timer = setTimeout(stop, timeoutMs);
  const aborted = () => stop();
  signal?.addEventListener('abort', aborted, { once: true });
  server.on('error', stop);
  try {
    await new Promise((resolveReady, reject) => {
      const cancel = () => reject(fail());
      controller.signal.addEventListener('abort', cancel, { once: true });
      server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
        listening = true;
        controller.signal.removeEventListener('abort', cancel);
        if (stopped) { server.close(); reject(fail()); } else resolveReady();
      });
      if (signal?.aborted) stop();
    });
  } catch {
    await close(); throw fail();
  }
  async function close() {
    if (closing) return closing;
    closing = (async () => {
      clearTimeout(timer); signal?.removeEventListener('abort', aborted);
      const ended = [...sockets].map(socket => new Promise(resolveClosed => socket.once('close', resolveClosed)));
      stop();
      await new Promise(resolveClosed => server.close(() => resolveClosed()));
      await Promise.all(ended);
      await Promise.allSettled([...pending]);
    })();
    return closing;
  }
  const credential = Buffer.from(auth.toString().slice(6), 'base64').toString();
  return Object.freeze({
    // Sensitive, only for the child argv/environment. NEVER expose or log it.
    url: `http://${credential}@127.0.0.1:${server.address().port}`,
    signal: controller.signal, close,
    stats: () => ({ connections, active, bytes, stopped }),
  });
}
