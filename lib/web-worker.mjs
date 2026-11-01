// Nonexecuting static parser subprocess. HTML is data, never imported/evaluated.
// These network guards are defense in depth, not an OS sandbox claim.
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import dgram from 'node:dgram';
import dns from 'node:dns';
import dnsPromises from 'node:dns/promises';
import { syncBuiltinESMExports } from 'node:module';
const denied = () => { throw new Error('Network access is disabled during static webpage extraction.'); };
globalThis.fetch = async () => denied();
globalThis.WebSocket = class { constructor() { denied(); } };
net.Socket.prototype.connect = denied;
net.connect = net.createConnection = tls.connect = denied;
http.request = http.get = https.request = https.get = denied;
dgram.Socket.prototype.send = dgram.Socket.prototype.connect = denied;
for (const api of [dns, dnsPromises]) {
  for (const name of Object.keys(api)) if (/^(?:lookup|resolve|reverse)/.test(name) && typeof api[name] === 'function') api[name] = denied;
}
syncBuiltinESMExports();
process.on('disconnect', () => process.exit(0));
process.once('message', async message => {
  let SafeError;
  try {
    const module = await import('./web-extract.mjs');
    SafeError = module.WebExtractError;
    const result = module.parseWebHtml(message.buffer, { mode: message.mode });
    process.send?.({ result }, () => process.exit(0));
  } catch (error) {
    // Only fixed error codes cross IPC, never parser messages, URLs or source text.
    process.send?.({ error: SafeError && error instanceof SafeError ? error.code : 'invalid' }, () => process.exit(0));
  }
});
