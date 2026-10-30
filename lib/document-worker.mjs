// Isolated document parser. No provider settings, source logging or network access.
import net from 'node:net';
import dgram from 'node:dgram';
import { syncBuiltinESMExports } from 'node:module';
const denied = () => { throw new Error('Network access is disabled during document extraction.'); };
globalThis.fetch = async () => denied();
net.Socket.prototype.connect = denied;
dgram.Socket.prototype.send = denied;
syncBuiltinESMExports();
process.on('disconnect', () => process.exit(0));
process.once('message', async message => {
  let SafeError;
  try {
    const module = await import('./document-extract.mjs');
    SafeError = module.DocumentImportError;
    const result = await module.extractDocument(message.buffer, message.extension, message.options);
    process.send?.({ result }, () => process.exit(0));
  } catch (error) {
    const detail = SafeError && error instanceof SafeError ? error.message : 'This document could not be read. It may be damaged or contain unsupported content.';
    process.send?.({ error: detail }, () => process.exit(0));
  }
});
