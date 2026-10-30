// Fixed public model assets only. No user input, credentials or generated audio are cached.
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, stat, open, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
export const MODEL_REVISION = '1939ad2a8e416c0acfeecc08a694d14ef25f2231';
export const MODEL_FILES = [
  { path: 'config.json', size: 44, sha256: 'df34b4f930b23447cd4dc410fabfb42eb3f24e803e6c3f97d618fb359380a36f' },
  { path: 'tokenizer_config.json', size: 113, sha256: 'be1cb066d6ef6b074b3f15e6a6dd21ac88ff3cdaedf325f0aaed686c70f75d20' },
  { path: 'tokenizer.json', size: 3497, sha256: '77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34' },
  { path: 'onnx/model_quantized.onnx', size: 92361116, sha256: 'fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478' },
];

export async function validAsset(file, asset) {
  try {
    if ((await stat(file)).size !== asset.size) return false;
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return hash.digest('hex') === asset.sha256;
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export async function ensureAsset(file, asset, { offline = false, fetchAsset = fetch } = {}) {
  if (await validAsset(file, asset)) return;
  if (offline) throw new Error(`Missing or damaged cached speech asset: ${asset.path}. Run npm run setup:speech with LEARNLENS_SPEECH_OFFLINE unset while online.`);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.partial`;
  let handle;
  try {
    console.log(`Preparing Kokoro asset: ${asset.path} (${Math.ceil(asset.size / 1024)} KiB)…`);
    const response = await fetchAsset(`https://huggingface.co/${MODEL_ID}/resolve/${MODEL_REVISION}/${asset.path}`, { signal: AbortSignal.timeout(480000) });
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`Speech asset download failed (HTTP ${response.status}). Retry setup when connected.`); }
    handle = await open(temporary, 'wx', 0o600);
    const hash = createHash('sha256'); let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > asset.size) throw new Error('Speech asset exceeded its expected size.');
      hash.update(chunk); await handle.writeFile(chunk);
    }
    await handle.close(); handle = null;
    if (size !== asset.size || hash.digest('hex') !== asset.sha256) throw new Error('Speech asset integrity verification failed; the partial file was discarded.');
    await rename(temporary, file);
  } finally { await handle?.close(); await rm(temporary, { force: true }); }
}

export async function prepareNativeAssets(cacheRoot, options = {}) {
  const modelPath = join(cacheRoot, `kokoro-${MODEL_REVISION}-q8`);
  for (const asset of MODEL_FILES) await ensureAsset(join(modelPath, asset.path), asset, options);
  return modelPath;
}
