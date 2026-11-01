// Opt-in CI investigation; never invoked by an import or npm test.
// Exercises only owned synthetic code. Does not change the existing failing gate.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { prepareYouTubeAssets } from '../deploy/youtube-assets.mjs';
import { runOwnedProcess, youtubeChildEnvironment, DENO_PROVIDER_ARGS } from '../deploy/owned-process.mjs';
import { downloadSourceFile } from '../lib/source-fetch.mjs';

const UPSTREAM = 'f264a6cbd1f630894da0f368df00f8aae50140e0';
const SOURCE_HASHES = { deno: '7776ce639b77f85e946db6acd25a6894139694becec4b061c498b4df911e410c', ejs: '3db3ca7ee7619ee9ba770261e68a3643ebbce5d2f5e7496134d8fd83f9fd4d88' };
const BUNDLES = [
  { name: 'yt.solver.lib.min.js', size: 151561, hash: 'c55987fe697e5b9ee18830163f7af85327e9bb5c3e674b969d38c8d205eaa577' },
  { name: 'yt.solver.core.min.js', size: 6945, hash: '18da6ce0758b416e7ae645084f4f8801f9f9d59d6c477c05eaa0ff94ebd8cc00' },
];
const EXPECT_DENIED = ['fetch', 'socket', 'read', 'write', 'env', 'run', 'ffi', 'sys', 'import', 'worker', ...['net', 'read', 'write', 'env', 'run', 'ffi', 'sys'].map(x => `request-${x}`)];
const sha = process.env.GITHUB_SHA;
const python = process.env.LEARNLENS_TEST_PYTHON;
const upstream = process.env.LEARNLENS_TEST_UPSTREAM;
if (process.env.LEARNLENS_YOUTUBE_BOUNDARY_TEST !== '1' || !/^[a-f0-9]{40}$/.test(sha || '') || !isAbsolute(python || '') || !isAbsolute(upstream || '')) {
  throw Error('This synthetic boundary investigation requires explicit CI opt-in, exact commit and owned absolute test paths.');
}
const execute = promisify(execFile);
const digest = value => createHash('sha256').update(value).digest('hex');
const directory = await mkdtemp(join(tmpdir(), 'learnlens-yt-boundary-'));
const report = { commit: sha, upstream: UPSTREAM, platform: process.platform, startedAt: new Date().toISOString(), aiRequests: 0, publicYoutubeRequests: 0, checks: [] };
const resultsDirectory = new URL(`../artifacts/youtube-boundary-${process.platform}/`, import.meta.url);
await mkdir(resultsDirectory, { recursive: true });
let current = 'setup', connections = 0;
const target = createServer((_req, res) => res.end('OWNED_TEST_ONLY'));
target.on('connection', () => connections++);
await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
const port = target.address().port;
const proxy = 'http://learnlens:OWNED_NONCE@127.0.0.1:9';

// The body is DATA in Function/EJS cases, never interpolated as initial-module syntax.
function hostileBody({ sentinel, canary, module, worker }) {
  return `console.log('BOUNDARY_ENTERED');
    const out={};
    async function deny(name,fn){try{await fn();out[name]='granted'}catch(e){out[name]=/NotCapable|PermissionDenied|Requires .* access|not permitted/i.test(e.name+':'+e.message)?'denied':'unexpected-error'}}
    await deny('fetch',()=>fetch('http://127.0.0.1:${port}/'));
    await deny('socket',()=>Deno.connect({hostname:'127.0.0.1',port:${port}}));
    await deny('read',()=>Deno.readTextFile(${JSON.stringify(sentinel)}));
    await deny('write',()=>Deno.writeTextFile(${JSON.stringify(canary)},'BAD'));
    await deny('env',()=>Deno.env.get('OWNED_TEST_SECRET'));
    await deny('run',()=>new Deno.Command(${JSON.stringify(process.execPath)},{args:['-e','process.exit(0)']}).output());
    await deny('ffi',()=>Deno.dlopen(${JSON.stringify(sentinel)},{}));
    await deny('sys',()=>Deno.osRelease());
    await deny('import',()=>import(${JSON.stringify(module)}));
    await deny('worker',()=>new Promise((resolve,reject)=>{
      let w;const timer=setTimeout(()=>{w?.terminate();reject(new Error('Worker test timeout'));},5000);
      try{w=new Worker(${JSON.stringify(worker)},{type:'module'});
        w.onerror=e=>{e.preventDefault();clearTimeout(timer);w.terminate();reject(new Error(e.message));};
        w.onmessage=()=>{clearTimeout(timer);w.terminate();resolve();};
      }catch(e){clearTimeout(timer);reject(e);}
    }));
    for(const name of ['net','read','write','env','run','ffi','sys'])out['request-'+name]=(await Deno.permissions.request({name})).state;
    console.log('BOUNDARY_RESULT:'+JSON.stringify(out));`;
}
async function fixture(name) {
  const cwd = join(directory, name); await mkdir(cwd);
  const sentinel = join(cwd, 'owned-sentinel.txt'), canary = join(cwd, 'must-not-write.txt');
  const moduleFile = join(cwd, `${randomUUID()}.mjs`), workerFile = join(cwd, `${randomUUID()}.mjs`);
  await writeFile(sentinel, 'OWNED_SENTINEL'); await writeFile(moduleFile, 'export default 123;');
  await writeFile(workerFile, 'postMessage("GRANTED");');
  return { cwd, sentinel, canary, module: pathToFileURL(moduleFile).href, worker: pathToFileURL(workerFile).href };
}
function parseOutput(bytes) {
  const lines = bytes.toString('utf8').trim().split(/\r?\n/);
  const results = lines.filter(x => x.startsWith('BOUNDARY_RESULT:'));
  assert.equal(results.length, 1, 'Exactly one owned result must finish');
  assert.equal(lines.filter(x => x === 'BOUNDARY_ENTERED').length, 1, 'The hostile body must actually execute');
  return JSON.parse(results[0].slice('BOUNDARY_RESULT:'.length));
}
async function invoke(assets, f, input, args = DENO_PROVIDER_ARGS) {
  const started = performance.now();
  const bytes = await runOwnedProcess(assets.deno, [...args], { cwd: f.cwd,
    env: { ...youtubeChildEnvironment(f.cwd, proxy), OWNED_TEST_SECRET: 'DO_NOT_READ' }, input });
  return { bytes, elapsedMs: Math.round(performance.now() - started) };
}
try {
  const git = await execute('git', ['-C', upstream, 'rev-parse', 'HEAD']);
  assert.equal(git.stdout.trim(), UPSTREAM);
  for (const [name, expected] of Object.entries(SOURCE_HASHES)) {
    const code = await readFile(join(upstream, `yt_dlp/extractor/youtube/jsc/_builtin/${name}.py`), 'utf8');
    assert.equal(digest(code.replaceAll('\r\n', '\n')), expected);
  }
  const assets = await prepareYouTubeAssets({ offline: true });
  for (const bundle of BUNDLES) {
    const file = join(directory, bundle.name);
    const got = await downloadSourceFile(`https://github.com/yt-dlp/ejs/releases/download/0.8.0/${bundle.name}`, file,
      { maxBytes: bundle.size, timeoutMs: 60000 });
    assert.equal(got.size, bundle.size); assert.equal(digest(await readFile(file)), bundle.hash);
  }
  current = 'owned-process-startup';
  const started = performance.now();
  const ready = await runOwnedProcess(process.execPath, ['-e', 'console.log("OWNED_READY")'],
    { cwd: directory, env: youtubeChildEnvironment(directory, proxy) });
  assert.equal(ready.toString().trim(), 'OWNED_READY');
  report.checks.push({ name: current, status: 'PASS', elapsedMs: Math.round(performance.now() - started) });

  for (const name of ['initial-literal-control', 'computed-import', 'compiled-function', 'pinned-ejs-player']) {
    current = name; const f = await fixture(name); let input, args = DENO_PROVIDER_ARGS;
    if (name === 'initial-literal-control') {
      input = `console.log('BOUNDARY_ENTERED');let result;try{await import(${JSON.stringify(f.module)});result='granted'}catch{result='denied'}console.log('BOUNDARY_RESULT:'+JSON.stringify({import:result}));`;
    } else if (name === 'computed-import') {
      input = `console.log('BOUNDARY_ENTERED');const path=${JSON.stringify(f.module)};let result;try{await import(path);result='granted'}catch(e){result=/NotCapable|PermissionDenied|Requires .* access/i.test(e.name+':'+e.message)?'denied':'unexpected-error'}console.log('BOUNDARY_RESULT:'+JSON.stringify({import:result}));`;
    } else {
      const body = `return (async()=>{${hostileBody(f)}})();`;
      if (name === 'compiled-function') input = `await Function(${JSON.stringify(body)})();`;
      else {
        // Valid one-statement player shape. Variable initializer survives the
        // real preprocessor; no privileged probe is executed in trusted code.
        const player = `(function(){var ownedProbe=(async()=>{${hostileBody(f)}})();}).call(this);`;
        const config = join(f.cwd, 'capture.json');
        await writeFile(config, JSON.stringify({ upstream, deno: assets.deno, proxy, player,
          lib: join(directory, BUNDLES[0].name), core: join(directory, BUNDLES[1].name) }));
        current = name + '/serialize';
        const captured = await execute(python, ['-I', '-S', fileURLToPath(new URL('./youtube-boundary-bridge.py', import.meta.url)), config],
          { cwd: f.cwd, env: youtubeChildEnvironment(f.cwd, proxy), timeout: 30000, maxBuffer: 1024 * 1024 });
        const capture = JSON.parse(captured.stdout);
        assert.equal(capture.argv[0], assets.deno); assert.deepEqual(capture.argv.slice(1), [...DENO_PROVIDER_ARGS]);
        assert.equal(capture.playerEncodedAsJson, true); assert.deepEqual(capture.sourceHashes, SOURCE_HASHES);
        assert.equal(capture.version, '0.8.0'); input = capture.stdin; args = capture.argv.slice(1);
        await writeFile(new URL('synthetic-stdin.js', resultsDirectory), input);
        // Owned synthetic capture only, never a real player or private URL.
        await writeFile(new URL('synthetic-capture.json', resultsDirectory), JSON.stringify(capture, null, 2));
        report.capture = { stdinSha256: digest(input), sourceHashes: capture.sourceHashes, bundleHashes: BUNDLES.map(b => b.hash), playerEncodedAsJson: true, argvMatches: true };
      }
    }
    current = name + '/execute';
    const { bytes, elapsedMs } = await invoke(assets, f, input, args);
    const results = parseOutput(bytes);
    const expected = name === 'initial-literal-control' ? { import: 'granted' } : name === 'computed-import' ? { import: 'denied' } : Object.fromEntries(EXPECT_DENIED.map(key => [key, 'denied']));
    let canaryExists = true; try { await readFile(f.canary); } catch (e) { if (e.code === 'ENOENT') canaryExists = false; else throw e; }
    const pass = JSON.stringify(Object.entries(results).sort()) === JSON.stringify(Object.entries(expected).sort()) && !canaryExists && connections === 0;
    report.checks.push({ name, status: pass ? 'PASS' : 'FAIL', executionMarker: true, results, canaryExists, networkConnections: connections, elapsedMs });
  }
  report.status = report.checks.every(c => c.status === 'PASS') ? 'PASS' : 'FAIL';
  if (report.status !== 'PASS') process.exitCode = 1;
} catch (error) {
  report.failureType = ['AssertionError', 'SyntaxError', 'TypeError'].includes(error.name) ? error.name : 'test_failure';
  // This capture is exclusively synthetic; never invoke this harness with a real player.
  if (current.endsWith('/serialize') && typeof error.stderr === 'string') await writeFile(new URL('synthetic-capture-error.txt', resultsDirectory), error.stderr.slice(0, 8192));
  report.status = 'FAILED_OR_BLOCKED'; report.failedCheck = current;
  report.error = 'Owned boundary investigation failed; no source content, environment values or local paths included.';
  process.exitCode = 1;
} finally {
  await new Promise(resolve => { target.close(resolve); target.closeAllConnections(); });
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  report.finishedAt = new Date().toISOString();
  await writeFile(new URL('report.json', resultsDirectory), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
