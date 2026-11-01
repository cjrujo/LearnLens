import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { YOUTUBE_ASSETS, YTDLP_VERSION, DENO_VERSION, createYouTubeAssetLoader, extractDenoArchive,
  prepareYouTubeAssets, verifyYouTubeAsset } from '../deploy/youtube-assets.mjs';
import { runOwnedProcess, youtubeChildEnvironment, DENO_PROVIDER_ARGS, HELPER_OUTPUT_LIMIT } from '../deploy/owned-process.mjs';

const root = fileURLToPath(new URL('../artifacts/', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function scratch(t) {
  fs.mkdirSync(root, { recursive: true });
  const directory = fs.mkdtempSync(join(root, 'youtube-tools-test-'));
  // Async removal lets libuv release native process handles after the close
  // callback; blocking rmSync retries can otherwise retain a Windows cwd lock.
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })); return directory;
}
function env(directory) { return youtubeChildEnvironment(directory, 'http://learnlens:LOCAL_TEST_NONCE@127.0.0.1:9'); }
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(entries) {
  const local = [], central = []; let offset = 0;
  for (const item of entries) {
    const name = Buffer.from(item.name), data = Buffer.from(item.data || 'synthetic-deno-executable'), crc = crc32(data);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50); lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(item.flags || 0, 6); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(item.size ?? data.length, 22); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50); ch.writeUInt16LE(0x0314, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(item.flags || 0, 8); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(item.size ?? data.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(((item.mode ?? 0x81c0) << 16) >>> 0, 38); ch.writeUInt32LE(offset, 42);
    local.push(lh, name, data); central.push(ch, name); offset += lh.length + name.length + data.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}
async function waitFile(file) {
  const deadline = Date.now() + 20000;
  while (!fs.existsSync(file) && Date.now() < deadline) await delay(20);
  assert.ok(fs.existsSync(file), 'owned fixture did not become ready');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
async function assertDead(pid) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); }
    catch (error) { if (error.code === 'ESRCH') return; throw error; }
    // A zombie has exited and owns no code/handles; init reaping is not ours.
    if (process.platform === 'linux') {
      try { if (/\) Z /.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'))) return; } catch { return; }
    }
    await delay(20);
  }
  assert.fail(`owned fixture process still alive: ${pid}`);
}

test('official fixed version/SHA/size pins are immutable and target only standalone x64 assets', () => {
  assert.equal(YTDLP_VERSION, '2026.10.26'); assert.equal(DENO_VERSION, '2.9.8');
  assert.equal(YOUTUBE_ASSETS.win32.ytdlp.size, 23575744);
  assert.equal(YOUTUBE_ASSETS.win32.ytdlp.sha256, 'f5389d3698ecde4ef06f4e6b1ce0294fe9ac1396228c8990b8d3416d6d177a7d');
  assert.equal(YOUTUBE_ASSETS.linux.ytdlp.sha256, '767ba9dce7052aa196f8b12652f433d76de128ba168966fa84b6394d5e6c6795');
  assert.equal(YOUTUBE_ASSETS.linux.ytdlp.size, 41166968);
  assert.equal(YOUTUBE_ASSETS.win32.deno.sha256, 'cba84b26e0df5ae7f74fc66b86a95b866872a86292ebd84fa1e959927edd93bf');
  assert.equal(YOUTUBE_ASSETS.win32.deno.size, 42917472);
  assert.equal(YOUTUBE_ASSETS.linux.deno.sha256, 'e890975bc2549807bbcc0b584ffafda72cc7c93349dd99c80483dd784f6c4609');
  assert.equal(YOUTUBE_ASSETS.linux.deno.size, 41963064);
  for (const target of Object.values(YOUTUBE_ASSETS)) for (const pin of Object.values(target)) {
    assert.match(pin.url, /^https:\/\/github\.com\/(yt-dlp\/yt-dlp|denoland\/deno)\/releases\/download\//);
    assert.match(pin.sha256, /^[a-f0-9]{64}$/); assert.ok(Object.isFrozen(pin)); assert.ok(!pin.url.includes('/latest/'));
  }
});

test('allowlisted environment contains only owned homes/caches, controlled proxies and no inherited permission broker/loaders/secrets', t => {
  const directory = scratch(t);
  const forbidden = ['DENO_PERMISSION_BROKER_PATH', 'NODE_OPTIONS', 'NODE_PATH', 'DENO_V8_FLAGS', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES',
    'PYTHONPATH', 'PYTHONHOME', 'OPENAI_API_KEY', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'OTEL_EXPORTER_OTLP_HEADERS'];
  const previous = Object.fromEntries(forbidden.map(name => [name, process.env[name]]));
  try {
    for (const name of forbidden) process.env[name] = 'INHERITED_SECRET';
    for (const platform of ['win32', 'linux']) {
      const output = youtubeChildEnvironment(directory, 'http://learnlens:OWNED_NONCE@127.0.0.1:1', { platform });
      assert.ok(!JSON.stringify(output).includes('INHERITED_SECRET'));
      assert.equal(output.PATH, ''); assert.equal(output.DENO_NO_UPDATE_CHECK, '1'); assert.equal(output.DENO_NO_PACKAGE_JSON, '1');
      assert.equal(output.DENO_NO_PROMPT, '1'); assert.equal(output.YTDLP_NO_PLUGINS, '1'); assert.equal(output.NO_PROXY, '');
      assert.equal(output.HOME, directory); assert.equal(output.TEMP, directory);
      assert.equal(output.DENO_PERMISSION_BROKER_PATH, undefined);
    }
  } finally { for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } }
  assert.deepEqual([...DENO_PROVIDER_ARGS], ['run', '--ext=js', '--no-code-cache', '--no-prompt', '--no-remote',
    '--no-lock', '--node-modules-dir=none', '--no-config', '--no-npm', '--cached-only', '-']);
  assert.equal(HELPER_OUTPUT_LIMIT, 4 * 1024 * 1024);
});

test('safe ZIP selects only deno, rejects traversal/alternate executable/symlink/encryption/extras and preserves existing output', async t => {
  const directory = scratch(t), archive = join(directory, 'archive.zip'), output = join(directory, 'selected');
  fs.writeFileSync(archive, zip([{ name: 'deno.exe' }]));
  const expected = await extractDenoArchive(archive, output, 'deno.exe');
  assert.equal(await verifyYouTubeAsset(output, expected), true);
  await assert.rejects(extractDenoArchive(archive, output, 'deno.exe'));
  assert.equal(await verifyYouTubeAsset(output, expected), true);
  fs.unlinkSync(output);
  for (const entries of [[{ name: '../deno.exe' }], [{ name: '/deno.exe' }], [{ name: 'deno.exe:ads' }],
    [{ name: 'denort.exe' }], [{ name: 'deno.exe', mode: 0xa1ff }], [{ name: 'deno.exe', flags: 1 }],
    [{ name: 'deno.exe' }, { name: 'extra' }], [{ name: 'deno.exe' }, { name: 'deno.exe' }],
    [{ name: 'deno.exe', size: 201 * 1024 * 1024 }], []]) {
    fs.writeFileSync(archive, zip(entries)); await assert.rejects(extractDenoArchive(archive, output, 'deno.exe'));
    assert.equal(fs.existsSync(output), false);
  }
});

test('installer downloads only fixed official origins, checks SHA/size before cache use, rederives executable integrity from archive', async t => {
  const directory = scratch(t), ytdlp = Buffer.from('synthetic-standalone'), archive = zip([{ name: 'deno.exe' }]);
  const manifest = { win32: {
    ytdlp: { ...YOUTUBE_ASSETS.win32.ytdlp, size: ytdlp.length, sha256: hash(ytdlp) },
    deno: { ...YOUTUBE_ASSETS.win32.deno, size: archive.length, sha256: hash(archive) },
  } };
  const requests = [];
  const prepare = createYouTubeAssetLoader({ platform: 'win32', arch: 'x64', manifests: manifest,
    download: async (url, file, options) => {
      requests.push(url); assert.ok([manifest.win32.ytdlp.url, manifest.win32.deno.url].includes(url));
      assert.equal(options.allowUrl(new URL(url)), true);
      assert.equal(options.allowUrl(new URL('https://release-assets.githubusercontent.com/github-production-release-asset/1?sig=private')), true);
      for (const wrong of ['https://github.com/evil/release', 'https://evil.com/file', 'http://release-assets.githubusercontent.com/file',
        'https://user:pass@release-assets.githubusercontent.com/file', 'https://objects.githubusercontent.com:444/file']) assert.equal(options.allowUrl(new URL(wrong)), false);
      const data = url === manifest.win32.ytdlp.url ? ytdlp : archive;
      assert.equal(options.maxBytes, data.length); options.limitForHeaders({ contentLength: data.length });
      assert.throws(() => options.limitForHeaders({ contentLength: data.length + 1 }));
      fs.writeFileSync(file, data, { flag: 'wx' });
    } });
  await assert.rejects(prepare({ cacheRoot: directory })); assert.equal(requests.length, 0);
  const assets = await prepare({ cacheRoot: directory, offline: false }); assert.equal(requests.length, 2);
  assert.deepEqual(fs.readFileSync(assets.ytdlp), ytdlp); assert.equal(fs.readFileSync(assets.deno, 'utf8'), 'synthetic-deno-executable');
  fs.writeFileSync(assets.deno, 'tampered');
  const again = await prepare({ cacheRoot: directory }); assert.equal(requests.length, 2);
  assert.equal(fs.readFileSync(again.deno, 'utf8'), 'synthetic-deno-executable');
  fs.writeFileSync(again.ytdlp, 'tampered'); await assert.rejects(prepare({ cacheRoot: directory }));
  assert.equal(fs.readdirSync(join(assets.deno, '..')).some(name => /partial|extracted/.test(name)), false);
});

test('corrupt download and unsupported target fail closed with no partial or executable installation', async t => {
  const directory = scratch(t), calls = [];
  const prepare = createYouTubeAssetLoader({ platform: 'win32', arch: 'x64', download: async (_url, file) => {
    calls.push(file); fs.writeFileSync(file, 'corrupt', { flag: 'wx' });
  } });
  await assert.rejects(prepare({ cacheRoot: directory, offline: false }));
  assert.equal(calls.length, 1); assert.equal(fs.existsSync(calls[0]), false);
  await assert.rejects(createYouTubeAssetLoader({ platform: 'win32', arch: 'arm64' })({ cacheRoot: directory }));
  await assert.rejects(createYouTubeAssetLoader({ platform: 'darwin' })({ cacheRoot: directory }));
});

test('asset cache rejects symlink/junction roots, ZIP cancellation leaves no output, concurrent loads serialize', async t => {
  const directory = scratch(t), target = join(directory, 'real'), link = join(directory, 'linked');
  fs.mkdirSync(target);
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(createYouTubeAssetLoader({ platform: 'win32', arch: 'x64' })({ cacheRoot: link }));
  fs.unlinkSync(link);
  const archiveFile = join(directory, 'fixture.zip'), output = join(directory, 'selected');
  fs.writeFileSync(archiveFile, zip([{ name: 'deno.exe' }]));
  await assert.rejects(extractDenoArchive(archiveFile, output, 'deno.exe', { signal: AbortSignal.abort() }));
  assert.equal(fs.existsSync(output), false);
  const data = Buffer.from('standalone'), archive = fs.readFileSync(archiveFile);
  const manifest = { win32: {
    ytdlp: { ...YOUTUBE_ASSETS.win32.ytdlp, size: data.length, sha256: hash(data) },
    deno: { ...YOUTUBE_ASSETS.win32.deno, size: archive.length, sha256: hash(archive) },
  } };
  let downloads = 0;
  const prepare = createYouTubeAssetLoader({ platform: 'win32', arch: 'x64', manifests: manifest,
    download: async (url, file) => { downloads++; await delay(10); fs.writeFileSync(file, url === manifest.win32.ytdlp.url ? data : archive, { flag: 'wx' }); } });
  const results = await Promise.all([1, 2, 3].map(() => prepare({ cacheRoot: target, offline: false })));
  assert.equal(downloads, 2); assert.deepEqual(results[0], results[1]); assert.deepEqual(results[1], results[2]);
});

test('owned native runner preserves literal argv (no shell), input, and redacts failures', async t => {
  const directory = scratch(t), special = 'quote " & | ; $() \\ trailing\\';
  const result = await runOwnedProcess(process.execPath, ['-e', 'let x="";process.stdin.on("data",b=>x+=b);process.stdin.on("end",()=>console.log(JSON.stringify({arg:process.argv[1],input:x})))', special],
    { cwd: directory, env: env(directory), input: 'stdin script' });
  assert.deepEqual(JSON.parse(result), { arg: special, input: 'stdin script' });
  await assert.rejects(runOwnedProcess(process.execPath, ['-e', 'console.error("PRIVATE_TOKEN https://bad.example/secret");process.exit(9)'],
    { cwd: directory, env: env(directory) }), error => !/PRIVATE_TOKEN|https:\/\//.test(error.message));
  assert.equal(fs.readdirSync(directory).some(name => /\.stdin$|\.json$/.test(name)), false);
});

test('combined stdout/stderr cap and hang deadline terminate the owned tree before returning', async t => {
  const directory = scratch(t);
  await assert.rejects(runOwnedProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(600));process.stderr.write("y".repeat(600));setInterval(()=>{},1000)'],
    { cwd: directory, env: env(directory), maxBytes: 1000 }), /output limit/);
  const marker = join(directory, 'loop-started');
  await assert.rejects(runOwnedProcess(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ready');while(true){}`],
    { cwd: directory, env: env(directory), timeoutMs: 5000 }), /deadline/);
  assert.equal(fs.existsSync(marker), true, 'deadline fixture must actually execute its infinite loop');
});

test('private managed-storage budget is enforced and startup cancellation leaves no late writers', async t => {
  const directory = scratch(t), marker = join(directory, 'storage-ready.json');
  const script = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(join(directory, 'large-cache'))},Buffer.alloc(12*1024*1024));fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid}));setInterval(()=>{},1000)`;
  await assert.rejects(runOwnedProcess(process.execPath, ['-e', script],
    { cwd: directory, env: env(directory), storageBytes: 8 * 1024 * 1024 }), /private storage budget/);
  const { pid } = await waitFile(marker); await assertDead(pid);
  await fs.promises.rm(join(directory, 'large-cache')); await fs.promises.rm(marker);
  // Cancels during bootstrap rather than only after a synthetic worker starts.
  await assert.rejects(runOwnedProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'],
    { cwd: directory, env: env(directory), timeoutMs: 1 }), /deadline/);
  await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  await delay(100); assert.equal(fs.existsSync(directory), false);
});

test('abort kills descendants and awaits Job Object/group cleanup; normal root exit also kills descendants', async t => {
  const directory = scratch(t);
  for (const normal of [false, true]) {
    const ready = join(directory, `ready-${normal}.json`), controller = new AbortController();
    const script = `const fs=require('node:fs'),cp=require('node:child_process');const c=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({root:process.pid,child:c.pid}));${normal ? 'process.exit(0)' : 'setInterval(()=>{},1000)'}`;
    const work = runOwnedProcess(process.execPath, ['-e', script], { cwd: directory, env: env(directory), signal: controller.signal });
    work.catch(() => {});
    const pids = await waitFile(ready);
    if (normal) await work; else { controller.abort(); await assert.rejects(work, /cancelled/); }
    await assertDead(pids.root); await assertDead(pids.child);
    fs.unlinkSync(ready);
  }
});

test('Windows wrapper closes its kill-on-close job when its Node parent crashes', { skip: process.platform !== 'win32' }, async t => {
  const directory = scratch(t), ready = join(directory, 'crash-ready.json'), launcher = join(directory, 'launcher.mjs');
  const script = `const fs=require('node:fs'),cp=require('node:child_process');const c=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({root:process.pid,wrapper:process.ppid,child:c.pid}));setInterval(()=>{},1000)`;
  const moduleUrl = new URL('../deploy/owned-process.mjs', import.meta.url).href;
  fs.writeFileSync(launcher, `import {runOwnedProcess,youtubeChildEnvironment} from ${JSON.stringify(moduleUrl)}; await runOwnedProcess(process.execPath,['-e',${JSON.stringify(script)}],{cwd:${JSON.stringify(directory)},env:youtubeChildEnvironment(${JSON.stringify(directory)},'http://127.0.0.1:9')});`);
  const child = spawn(process.execPath, [launcher], { stdio: 'ignore', env: env(directory), windowsHide: true });
  t.after(() => child.kill());
  const pids = await waitFile(ready), closed = once(child, 'close'); child.kill('SIGKILL'); await closed;
  await assertDead(pids.root); await assertDead(pids.child); await assertDead(pids.wrapper);
});

test('pinned Deno adversarial local permissions under exact bundled-provider flags (offline assets only)', async t => {
  let assets;
  try { assets = await prepareYouTubeAssets({ offline: true }); }
  catch { t.skip('NOT TESTED: pinned official Deno/yt-dlp assets are not present and verified locally; no network install or public video trial.'); return; }
  const directory = scratch(t), sentinel = join(directory, 'owned-sentinel.txt'), canary = join(directory, 'must-not-write.txt');
  fs.writeFileSync(sentinel, 'OWNED_TEST_SENTINEL');
  const localModule = join(directory, 'must-not-import.mjs'); fs.writeFileSync(localModule, 'export default 123;');
  const fixture = `
    const out={};
    async function deny(name,fn){try{await fn();out[name]='GRANTED'}catch(e){out[name]=e.name+':'+e.message}}
    const code=async()=>{
      await deny('fetch',()=>fetch('http://127.0.0.1:9/'));
      await deny('socket',()=>Deno.connect({hostname:'127.0.0.1',port:9}));
      await deny('read',()=>Deno.readTextFile(${JSON.stringify(sentinel)}));
      await deny('write',()=>Deno.writeTextFile(${JSON.stringify(canary)},'BAD'));
      await deny('env',()=>Deno.env.get('OWNED_TEST_SECRET'));
      await deny('run',()=>new Deno.Command(${JSON.stringify(process.execPath)},{args:['-e','process.exit(0)']}).output());
      await deny('import',()=>import(${JSON.stringify(pathToFileURL(localModule).href)}));
      await deny('worker',()=>new Worker(${JSON.stringify(pathToFileURL(localModule).href)},{type:'module'}));
      for(const name of ['net','read','write','env','run','ffi','sys']) out['request-'+name]=(await Deno.permissions.request({name})).state;
    };await code();console.log(JSON.stringify(out));`;
  const output = await runOwnedProcess(assets.deno, [...DENO_PROVIDER_ARGS], { cwd: directory, env: { ...env(directory), OWNED_TEST_SECRET: 'DO_NOT_READ' }, input: fixture });
  const results = JSON.parse(output);
  for (const name of ['fetch', 'socket', 'read', 'write', 'env', 'run', 'import', 'worker']) assert.match(results[name], /NotCapable|PermissionDenied|Requires .* access|not permitted/i, name);
  for (const name of ['net','read','write','env','run','ffi','sys']) assert.equal(results[`request-${name}`], 'denied');
  assert.equal(fs.existsSync(canary), false);
  await assert.rejects(runOwnedProcess(assets.deno, [...DENO_PROVIDER_ARGS], { cwd: directory, env: env(directory), input: 'while(true){}', timeoutMs: 5000 }), /deadline/);
  await assert.rejects(runOwnedProcess(assets.deno, [...DENO_PROVIDER_ARGS], { cwd: directory, env: env(directory), input: 'while(true)console.log("x".repeat(65536))', maxBytes: 100_000 }), /output limit/);
});
