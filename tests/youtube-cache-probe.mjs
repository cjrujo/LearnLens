// Diagnostic-only Linux cache attribution; no real player, website or AI.
import { mkdtemp, mkdir, writeFile, rm, readdir, lstat, readlink } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { prepareYouTubeAssets } from '../deploy/youtube-assets.mjs';
import { runOwnedProcess, youtubeChildEnvironment, DENO_PROVIDER_ARGS } from '../deploy/owned-process.mjs';
if (process.platform !== 'linux' || process.env.LEARNLENS_YOUTUBE_BOUNDARY_TEST !== '1' || !/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA || '')) throw Error('Explicit Linux CI diagnostic opt-in required.');
const assets = await prepareYouTubeAssets({ offline: true });
const root = await mkdtemp(join(tmpdir(), 'learnlens-cache-probe-'));
const results = [];
async function links(directory) {
  const found = []; let count = 0;
  async function walk(path) {
    for (const entry of await readdir(path)) {
      if (++count > 2048) throw Error('Owned metadata inventory exceeded its limit.');
      const file = join(path, entry), stat = await lstat(file);
      if (stat.isSymbolicLink()) {
        const destination = resolve(dirname(file), await readlink(file));
        found.push({ targetVerifiedDeno: destination === assets.deno, targetTestNode: destination === process.execPath,
          targetInsideOwner: destination === directory || destination.startsWith(directory + '/') });
      } else if (stat.isDirectory()) await walk(file);
    }
  }
  await walk(directory); return found;
}
try {
  for (const name of ['baseline', 'run', 'import', 'worker', 'ffi']) {
    const directory = join(root, name); await mkdir(directory);
    const module = join(directory, 'owned.mjs'), worker = join(directory, 'owned-worker.mjs');
    await writeFile(module, 'export default 123;'); await writeFile(worker, 'postMessage("GRANTED");');
    const probes = {
      baseline: 'void 0',
      run: `await new Deno.Command(${JSON.stringify(process.execPath)},{args:['-e','process.exit(0)']}).output()`,
      import: `await import(${JSON.stringify(pathToFileURL(module).href)})`,
      ffi: `Deno.dlopen(${JSON.stringify(module)},{})`,
      worker: `await new Promise((resolve,reject)=>{let w;try{w=new Worker(${JSON.stringify(pathToFileURL(worker).href)},{type:'module'});w.onerror=e=>{e.preventDefault();w.terminate();reject(new Error(e.message))};w.onmessage=()=>{w.terminate();resolve()}}catch(e){reject(e)}})`,
    };
    const body = `return(async()=>{try{${probes[name]};console.log('completed')}catch(e){console.log(/NotCapable|PermissionDenied|Requires .* access|not permitted/i.test(e.name+':'+e.message)?'denied':'unexpected-error')}await new Promise(r=>setTimeout(r,1200));})();`;
    let outcome;
    try {
      const output = await runOwnedProcess(assets.deno, [...DENO_PROVIDER_ARGS], { cwd: directory,
        env: youtubeChildEnvironment(directory, 'http://127.0.0.1:9'), input: `await Function(${JSON.stringify(body)})();` });
      const value = output.toString().trim(); outcome = ['completed', 'denied', 'unexpected-error'].includes(value) ? value : 'unexpected-output';
    } catch (error) { outcome = /private storage/.test(error.message) ? 'storage-guard' : 'other-helper-failure'; }
    results.push({ probe: name, outcome, links: await links(directory) });
  }
} finally {
  await rm(root, { recursive: true, force: true });
  const output = new URL('../artifacts/youtube-boundary-linux/', import.meta.url); await mkdir(output, { recursive: true });
  const report = { commit: process.env.GITHUB_SHA, aiRequests: 0, publicYoutubeRequests: 0, observations: results };
  await writeFile(new URL('cache-probes.json', output), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
