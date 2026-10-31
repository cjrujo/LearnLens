import http from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { AppError, boundedString, normalizeBaseUrl, publicProvider, discoverModels, generateText, generateSpeech, generateSpeechBytes, transcribeAudio, geminiAudioTarget, decodeDataUrl, probeImage, primaryTimeoutSeconds } from './lib/provider.mjs';
import { validateLessonInput, lessonPrompt, parseLesson, demoLesson } from './lib/lesson.mjs';
import { renderLesson, renderScriptHash, fullAudioRenderScriptHash } from './lib/render.mjs';
import { createAudioPlanStore } from './lib/audio-plans.mjs';
import { normalizeReadingPauses } from './lib/speech-inventory.mjs';
import { prepareAudioEncoder } from './lib/audio-encode.mjs';
import { audioExtractionPrompt, parseAudioExtraction } from './lib/audio-extract.mjs';
import { documentName, documentBody, importDocument } from './lib/document-import.mjs';
import { createMaterialStore, UPLOAD_CHUNK_BYTES } from './lib/material-store.mjs';
import { digestInput, digestPrompt, parseDigest, localDigest } from './lib/material-digest.mjs';
import { reasoningEffort, starterPrimary, recommendationCatalog, recommendationPrompt, parseRecommendations } from './lib/setup.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const MAX_BODY = 13 * 1024 * 1024;
const SESSION_IDLE_MS = 60 * 60 * 1000;
const SESSION_MAX_MS = 12 * 60 * 60 * 1000;
const emptyRoles = () => ({ primary: null, transcription: null, speech: null });
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const check = (status, detail, role) => ({ status, detail, checkedAt: new Date().toISOString(), ...(role ? { api: role.api, ...(role.reasoningEffort ? { reasoningEffort: role.reasoningEffort } : {}), ...(role.timeoutSeconds !== undefined ? { timeoutSeconds: role.timeoutSeconds } : {}), ...(role.voice ? { voice: role.voice } : {}) } : {}) });

function json(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}

async function bodyJson(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] || '')) throw new AppError('Use Content-Type: application/json.', 415);
  if (Number(request.headers['content-length']) > MAX_BODY) {
    // Drain rejected uploads so browsers receive a readable 413 rather than a reset.
    for await (const _chunk of request) { /* no buffering */ }
    throw new AppError('Request is too large (maximum 13 MB).', 413);
  }
  const body = await new Promise((resolve, reject) => {
    let chunks = [], length = 0, exceeded = false;
    request.on('data', chunk => {
      if (exceeded) return;
      length += chunk.length;
      if (length > MAX_BODY) { exceeded = true; chunks = []; reject(new AppError('Request is too large (maximum 13 MB).', 413)); return; }
      chunks.push(chunk);
    });
    request.on('end', () => { if (!exceeded) resolve(Buffer.concat(chunks).toString('utf8')); });
    request.on('error', () => reject(new AppError('Request interrupted.')));
  });
  try {
    const parsed = JSON.parse(body || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch { throw new AppError('Request body must be a JSON object.'); }
}

function roleFor(session, value, name) {
  if (value === null) return null;
  if (!value || typeof value !== 'object') throw new AppError(`Invalid ${name} role.`);
  if (value.timeoutSeconds !== undefined && name !== 'primary') throw new AppError('Request timeout applies only to the primary lesson model.');
  if (value.engine === 'kokoro') {
    if (name !== 'speech' || !session.kokoro) throw new AppError('Kokoro is only available for speech when configured by the server operator.');
    const voice = boundedString(value.voice || session.kokoro.voice, 'Voice ID', 200);
    if (session.kokoro.voices && !session.kokoro.voices.includes(voice)) throw new AppError('Choose an installed native English voice, such as af_heart or bf_emma.');
    if (!/^[a-z0-9_]+(?:\+[a-z0-9_]+)*$/i.test(voice)) throw new AppError('Choose a Kokoro voice ID, such as af_heart. Paths, URLs and markup are not voice IDs.');
    return { engine: 'kokoro', model: session.kokoro.model, api: 'auto', voice };
  }
  if (value.engine && value.engine !== 'provider') throw new AppError('Unknown speech method.');
  const providerId = boundedString(value.providerId, 'Provider ID', 100);
  if (!session.providers.has(providerId)) throw new AppError('Select an existing provider.');
  const model = boundedString(value.model, 'Model ID', 200);
  if (/[\r\n]/.test(model)) throw new AppError('Model ID cannot contain newlines.');
  const api = value.api || 'auto';
  if (!['auto', 'chat', 'responses'].includes(api) && !(name === 'transcription' && api === 'gemini')) throw new AppError('API mode must be auto, chat, or responses; gemini is available only for speech-to-text.');
  const role = { providerId, model, api };
  if (api === 'gemini') role.model = geminiAudioTarget(session.providers.get(providerId), model).model;
  if (value.reasoningEffort !== undefined) {
    if (name !== 'primary') throw new AppError('Thinking level applies only to the primary lesson model.');
    const effort = reasoningEffort(value.reasoningEffort);
    if (effort !== 'default') role.reasoningEffort = effort;
  }
  if (value.timeoutSeconds !== undefined) role.timeoutSeconds = primaryTimeoutSeconds(value.timeoutSeconds);
  if (name === 'speech') role.voice = boundedString(value.voice || 'alloy', 'Voice ID', 200);
  return role;
}

function hostingOptions(options) {
  const accessPassword = options.accessPassword || '';
  let publicOrigin = options.publicOrigin || '';
  if (accessPassword && accessPassword.length < 16) throw new Error('Access password must contain at least 16 characters.');
  if (publicOrigin) {
    const url = new URL(publicOrigin);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('PUBLIC_ORIGIN must be an HTTPS origin without path, credentials, query, or fragment.');
    publicOrigin = url.origin;
    if (!accessPassword) throw new Error('Hosted mode requires LEARNLENS_ACCESS_PASSWORD.');
  }
  return { accessPassword, publicOrigin };
}

export function deploymentConfig(env = process.env) {
  const host = env.HOST || '127.0.0.1', port = Number(env.PORT || 3210);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be an integer between 0 and 65535.');
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) && (!env.PUBLIC_ORIGIN || !env.LEARNLENS_ACCESS_PASSWORD)) throw new Error('Remote binding requires HTTPS PUBLIC_ORIGIN and LEARNLENS_ACCESS_PASSWORD. See README.md for hosting.');
  return { host, port, options: {
    ...hostingOptions({ accessPassword: env.LEARNLENS_ACCESS_PASSWORD, publicOrigin: env.PUBLIC_ORIGIN }),
    kokoroBaseUrl: env.KOKORO_BASE_URL, kokoroApiKey: env.KOKORO_API_KEY, kokoroModel: env.KOKORO_MODEL,
    kokoroVoice: env.KOKORO_VOICE, kokoroBuiltin: env.KOKORO_BUILTIN === '1',
  } };
}

export function createApp(options = {}) {
  const sessions = new Map();
  const materials = createMaterialStore(options.materialStoreOptions);
  const audioPlans = createAudioPlanStore(options.audioPlanStoreOptions);
  let encoderPromise;
  const encoder = () => encoderPromise ||= Promise.resolve().then(() => (options.audioEncoderFactory || prepareAudioEncoder)()).catch(error => { encoderPromise = null; throw error instanceof AppError ? error : new AppError(error?.name === 'MediaImportError' ? error.message : 'Could not prepare the managed audio encoder. No speech request was made.', 422); });
  // Snapshot a coherent UI at startup: editing source files cannot break live tabs.
  const publicDirectory = options.publicDirectory || resolve(root, 'public');
  const indexHtml = readFileSync(resolve(publicDirectory, 'index.html'), 'utf8');
  const assets = new Map(['/app.js', '/materials.js', '/audio-sources.js', '/audio-client.js', '/audio-policy.js', '/media.js', '/styles.css', '/favicon.svg'].flatMap(path => {
    const file = resolve(publicDirectory, path.slice(1));
    return existsSync(file) ? [[path, readFileSync(file)]] : [];
  }));
  // Operator-controlled endpoint only. Never accept a private Kokoro URL from browser input.
  let kokoro = null;
  if (options.kokoroBaseUrl) {
    const url = new URL(boundedString(options.kokoroBaseUrl, 'Kokoro base URL', 2048));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('KOKORO_BASE_URL must be an HTTP(S) API base URL without credentials or query parameters.');
    if (options.kokoroFormat && !['mp3', 'wav'].includes(options.kokoroFormat)) throw new Error('Unsupported managed speech format.');
    kokoro = { baseUrl: url.toString().replace(/\/+$/, ''), apiKey: boundedString(options.kokoroApiKey || '', 'Kokoro API key', 4096, false), speechFormat: options.kokoroFormat || 'mp3', languages: options.kokoroLanguages || null, voices: options.kokoroVoices || null, publicOnly: false, model: boundedString(options.kokoroModel || 'kokoro', 'Kokoro model', 200), voice: boundedString(options.kokoroVoice || 'af_heart', 'Kokoro voice', 200) };
  }
  const builtInSpeech = Boolean(kokoro && options.kokoroBuiltin);
  const initialRoles = () => ({ ...emptyRoles(), ...(builtInSpeech ? { speech: { engine: 'kokoro', model: kokoro.model, api: 'auto', voice: kokoro.voice } } : {}) });
  const { accessPassword, publicOrigin } = hostingOptions(options);
  let activeJobs = 0, activeImports = 0, loginAttempts = 0, loginWindow = Date.now();
  function prune() {
    const now = Date.now();
    for (const [id, session] of sessions) if (now - session.touched > SESSION_IDLE_MS || now - session.created > SESSION_MAX_MS) { session.importController?.abort(); void materials.clearOwner(id).catch(() => {}); void audioPlans.clearOwner(id).catch(() => {}); sessions.delete(id); }
    void audioPlans.retryCleanup();
  }
  const interval = setInterval(prune, 60_000).unref();

  const server = http.createServer(async (request, response) => {
    const requestId = randomUUID(); let diagnosticContext;
    const context = (stage, provider, role) => {
      const safe = value => typeof value === 'string' && ![provider?.apiKey, accessPassword].filter(Boolean).some(secret => value.includes(secret)) ? value.slice(0, 200) : '[redacted]';
      diagnosticContext = { stage, provider: safe(provider?.name || 'Configured provider'), model: safe(role?.model), apiMode: stage === 'speech_generation' ? 'audio/speech' : stage === 'transcription' ? (role?.api === 'gemini' ? 'gemini.generateContent' : 'audio/transcriptions') : ['auto', 'chat', 'responses'].includes(role?.api) ? role.api : 'auto', thinking: role?.reasoningEffort || 'default' };
    };
    response.setHeader('X-LearnLens-Request-Id', requestId);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Permissions-Policy', 'microphone=(self), camera=(), geolocation=()');
    response.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self' '${renderScriptHash}' '${fullAudioRenderScriptHash}'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'self'; frame-src 'self' blob:; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'`);
    if (publicOrigin) response.setHeader('Strict-Transport-Security', 'max-age=31536000');
    try {
      const expectedHost = publicOrigin ? new URL(publicOrigin).host : null;
      const host = request.headers.host || '';
      if (expectedHost ? host !== expectedHost : !/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(host)) throw new AppError('Unrecognized Host header.', 403);
      const origin = publicOrigin || `http://${host}`;
      if (request.headers.origin && request.headers.origin !== origin) throw new AppError('Cross-origin requests are not allowed.', 403);
      if (request.headers['sec-fetch-site'] === 'cross-site') throw new AppError('Cross-site requests are not allowed.', 403);
      const url = new URL(request.url, origin);
      const path = url.pathname;
      if (request.method === 'GET' && assets.has(path)) {
        const content = assets.get(path);
        response.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript; charset=utf-8' : path.endsWith('.css') ? 'text/css; charset=utf-8' : 'image/svg+xml');
        response.end(content); return;
      }
      if (request.method === 'GET' && path === '/health') { json(response, 200, { ok: true }); return; }
      prune();
      const cookieId = /(?:^|;\s*)learnlens_session=([a-f0-9]{64})(?:;|$)/.exec(request.headers.cookie || '')?.[1];
      let session = cookieId ? sessions.get(cookieId) : null;
      if (request.method === 'GET' && path === '/') {
        if (!session) {
          if (sessions.size >= 200) {
            const unused = [...sessions.values()].filter(s => !s.authorized && !s.busy).sort((a, b) => a.touched - b.touched)[0];
            if (unused) sessions.delete(unused.id);
            else throw new AppError('Server session capacity reached. Please try again later.', 503);
          }
          const id = randomBytes(32).toString('hex');
          session = { id, token: randomBytes(32).toString('hex'), authorized: !accessPassword, providers: new Map(), roles: initialRoles(), created: Date.now(), touched: Date.now(), busy: false, failures: 0, nextLogin: 0, revision: 0, setupRevision: 0, kokoro, kokoroChecks: Object.create(null) };
          sessions.set(id, session);
        }
        session.touched = Date.now();
        response.setHeader('Set-Cookie', `learnlens_session=${session.id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${publicOrigin ? '; Secure' : ''}`);
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end(indexHtml.replaceAll('__APP_TOKEN__', session.token)); return;
      }
      if (!path.startsWith('/api/')) throw new AppError('Not found.', 404);
      if (!session) throw new AppError('Session expired. Reload LearnLens and reconnect your provider.', 401);
      if (!equal(request.headers['x-learnlens-token'], session.token)) throw new AppError('Invalid session token. Reload this page.', 403);
      session.touched = Date.now();
      const revision = session.revision;
      const ensureCurrent = () => {
        if (session.revision !== revision || !sessions.has(session.id)) throw new AppError('Session changed or expired. Reload LearnLens.', 401);
      };
      const readBody = async () => { const body = await bodyJson(request); ensureCurrent(); return body; };
      const readPaidBody = async () => {
        const body = await readBody();
        if (body.consent !== true) throw new AppError('Explicit consent is required before sending material to an AI provider.');
        if (body.expectedSetupRevision !== undefined && body.expectedSetupRevision !== session.setupRevision) throw new AppError('AI settings changed. Review the current providers and confirm again before sending material.', 409);
        return body;
      };
      if (request.method === 'GET' && path === '/api/state') {
        json(response, 200, { locked: !session.authorized, setupRevision: session.setupRevision, providers: session.authorized ? [...session.providers.values()].map(publicProvider) : [], roles: session.authorized ? session.roles : emptyRoles(), starter: session.authorized ? starterPrimary([...session.providers.values()]) : null, speechServices: { kokoro: { available: Boolean(kokoro), bundled: builtInSpeech, languages: kokoro?.languages || null, voices: kokoro?.voices || null, model: kokoro?.model || 'kokoro', voice: kokoro?.voice || 'af_heart', checks: session.authorized ? session.kokoroChecks : {} } } }); return;
      }
      if (request.method === 'POST' && path === '/api/login') {
        const { password } = await readBody();
        if (Date.now() - loginWindow > 60_000) { loginAttempts = 0; loginWindow = Date.now(); }
        if (Date.now() < session.nextLogin || ++loginAttempts > 30) throw new AppError('Too many login attempts. Wait a minute before trying again.', 429);
        if (accessPassword && !equal(password, accessPassword)) { session.failures++; session.nextLogin = Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(session.failures, 6)); throw new AppError('Incorrect access password.', 401); }
        session.authorized = true; session.failures = 0; json(response, 200, { ok: true }); return;
      }
      if (request.method === 'POST' && path === '/api/logout') {
        await readBody();
        session.revision++;
        session.importController?.abort();
        session.providers.clear(); session.roles = initialRoles(); session.kokoroChecks = Object.create(null); session.setupRevision++; session.authorized = !accessPassword;
        await materials.clearOwner(session.id); await audioPlans.clearOwner(session.id);
        json(response, 200, { ok: true }); return;
      }
      if (!session.authorized) throw new AppError('Enter the LearnLens access password first.', 401);
      if (request.method === 'POST' && path === '/api/providers') {
        if (session.providers.size >= 12) throw new AppError('At most 12 providers can be configured per session.');
        const body = await readBody();
        const baseUrl = normalizeBaseUrl(body.baseUrl);
        const apiKey = boundedString(body.apiKey ?? '', 'API key', 4096, false);
        if (/[\r\n]/.test(apiKey)) throw new AppError('API key must not contain newlines.');
        if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(baseUrl).hostname) && !apiKey) throw new AppError('An API key is required for remote providers.');
        if (publicOrigin && new URL(baseUrl).protocol !== 'https:') throw new AppError('Hosted LearnLens only allows public HTTPS providers.');
        const provider = { id: randomUUID(), name: boundedString(body.name, 'Provider name', 80), baseUrl, apiKey, publicOnly: Boolean(publicOrigin), models: [], checks: Object.create(null) };
        session.providers.set(provider.id, provider); session.setupRevision++; json(response, 201, { provider: publicProvider(provider) }); return;
      }
      const providerPath = /^\/api\/providers\/([^/]+)(?:\/(discover|probe))?$/.exec(path);
      if (providerPath) {
        const provider = session.providers.get(providerPath[1]);
        if (!provider) throw new AppError('Provider not found.', 404);
        if (request.method === 'PUT' && !providerPath[2]) {
          const body = await readBody();
          if (session.busy) throw new AppError('Wait for the current AI request before editing a provider.', 409);
          if (!session.providers.has(provider.id)) throw new AppError('Provider was removed. Refresh settings.', 409);
          const baseUrl = normalizeBaseUrl(body.baseUrl);
          const suppliedKey = boundedString(body.apiKey || '', 'API key', 4096, false);
          const apiKey = suppliedKey || (baseUrl === provider.baseUrl ? provider.apiKey : '');
          if (/[\r\n]/.test(apiKey)) throw new AppError('API key must not contain newlines.');
          if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(baseUrl).hostname) && !apiKey) throw new AppError('Re-enter an API key when changing to a remote base URL. Existing keys are never transferred to a new URL automatically.');
          if (publicOrigin && new URL(baseUrl).protocol !== 'https:') throw new AppError('Hosted LearnLens only allows public HTTPS providers.');
          const name = boundedString(body.name, 'Provider name', 80);
          if (baseUrl !== provider.baseUrl || apiKey !== provider.apiKey) { provider.models = []; provider.checks = Object.create(null); }
          Object.assign(provider, { name, baseUrl, apiKey }); session.setupRevision++;
          json(response, 200, { provider: publicProvider(provider) }); return;
        }
        if (request.method === 'DELETE' && !providerPath[2]) {
          session.providers.delete(provider.id); session.setupRevision++;
          for (const role of Object.keys(session.roles)) if (session.roles[role]?.providerId === provider.id) session.roles[role] = null;
          json(response, 200, { ok: true }); return;
        }
        if (request.method === 'POST' && providerPath[2] === 'discover') {
          await readBody();
          const models = await discoverModels(provider); ensureCurrent(); provider.models = models; session.setupRevision++;
          json(response, 200, { models }); return;
        }
        if (request.method === 'POST' && providerPath[2] === 'probe') {
          const body = await readBody();
          if (body.consent !== true) throw new AppError('Capability tests make billable requests. Explicit consent is required.');
          if (!['text', 'vision', 'speech'].includes(body.kind)) throw new AppError('Choose a text, vision, or speech capability test.');
          const role = roleFor(session, { ...body, providerId: provider.id }, body.kind === 'speech' ? 'speech' : 'primary');
          await runJob(session, async () => {
            let result;
            try {
              if (body.kind === 'speech') {
                await generateSpeech(provider, role, 'Welcome to LearnLens.');
                result = check('verified', 'Speech endpoint returned a playable audio format for this voice. Audition a lesson to assess naturalness.');
              } else {
                const output = await generateText(provider, role, { instructions: 'Answer the request briefly.', text: body.kind === 'vision' ? 'What is the dominant color of the attached image? Reply with one English color word.' : 'Reply with the single word READY.', images: body.kind === 'vision' ? [probeImage()] : [], maxTokens: 4096 });
                if (body.kind === 'vision' && !/\bgreen\b/i.test(output.text)) throw new AppError('Image was accepted, but the color-recognition test did not pass. Vision remains unverified.');
                result = check('verified', body.kind === 'vision' ? `Recognized one synthetic image using ${output.api}. Not a guarantee of handwriting or diagram accuracy.` : `Received text using ${output.api}. Structured lesson generation, tools, and streaming are not implied.`);
              }
            } catch (error) { result = check('failed', error instanceof AppError ? error.message : 'Capability test failed.'); }
            ensureCurrent();
            result = { ...result, api: role.api, ...(role.reasoningEffort ? { reasoningEffort: role.reasoningEffort } : {}), ...(role.timeoutSeconds !== undefined ? { timeoutSeconds: role.timeoutSeconds } : {}), ...(role.voice ? { voice: role.voice } : {}) };
            provider.checks[role.model] ||= Object.create(null); provider.checks[role.model][body.kind] = result;
            json(response, 200, { check: result });
          }); return;
        }
        throw new AppError('Unsupported provider operation.', 405);
      }
      if (request.method === 'POST' && path === '/api/roles/recommend') {
        const body = await readBody();
        if (body.consent !== true) throw new AppError('Model suggestions use a potentially billable AI request. Explicit consent is required.');
        const primary = roleFor(session, body.primary || session.roles.primary, 'primary');
        if (!primary) throw new AppError('Choose a primary model first, or use the starter suggestion after discovery.');
        const candidates = recommendationCatalog([...session.providers.values()], session.roles, primary, body.scope || 'primary', kokoro);
        const snapshot = session.setupRevision;
        await runJob(session, async () => {
          const output = await generateText(session.providers.get(primary.providerId), primary, recommendationPrompt(candidates));
          ensureCurrent();
          if (session.setupRevision !== snapshot) throw new AppError('Provider settings changed while recommendations were generated. Request new suggestions.', 409);
          const result = parseRecommendations(output.text, candidates, session.roles, primary, kokoro);
          json(response, 200, { ...result, advisor: primary });
        }); return;
      }
      if (request.method === 'POST' && path === '/api/speech/kokoro/probe') {
        const body = await readBody();
        if (body.consent !== true) throw new AppError('Explicit consent is required to test Kokoro speech.');
        const role = roleFor(session, { engine: 'kokoro', voice: body.voice }, 'speech');
        await runJob(session, async () => {
          let result;
          try { await generateSpeech(kokoro, role, 'Welcome to LearnLens.'); result = check('verified', 'Kokoro returned a supported audio file. Listen to a lesson to assess voice and language quality.', role); }
          catch (error) { result = check('failed', error instanceof AppError ? error.message : 'Kokoro speech test failed.', role); }
          ensureCurrent(); session.kokoroChecks[role.voice] = result;
          json(response, 200, { check: result });
        }); return;
      }
      if (request.method === 'PUT' && path === '/api/roles') {
        const body = await readBody();
        const roles = {};
        for (const name of ['primary', 'transcription', 'speech']) roles[name] = roleFor(session, body[name] ?? null, name);
        session.roles = roles; session.setupRevision++; json(response, 200, { roles }); return;
      }
      if (request.method === 'GET' && path === '/api/demo') {
        json(response, 200, { id: 'sample', title: demoLesson.title, lesson: demoLesson, warnings: demoLesson.warnings, html: renderLesson(demoLesson, { warnings: demoLesson.warnings, sample: true }) }); return;
      }
      const audioRevision = body => {
        if (!Number.isInteger(body.expectedSetupRevision) || body.expectedSetupRevision !== session.setupRevision) throw new AppError('AI settings changed or the audio setup revision is missing. Review settings and confirm again; no speech request was made.', 409);
        return session.setupRevision;
      };
      const speechSetup = () => {
        const speech = session.roles.speech;
        if (!speech) throw new AppError('Assign a speech role before preparing complete English audio.');
        const provider = speech.engine === 'kokoro' ? kokoro : session.providers.get(speech.providerId);
        if (!provider) throw new AppError('The selected speech provider is no longer available.', 409);
        return { speech: structuredClone(speech), provider: { ...provider }, speechIdentity: JSON.stringify({ speech, baseUrl: provider.baseUrl, format: provider.speechFormat || 'mp3' }) };
      };
      if (request.method === 'POST' && path === '/api/audio/preflight') {
        await readBody(); speechSetup(); audioPlans.capacity(session.id);
        await runJob(session, async () => { await encoder(); ensureCurrent(); json(response, 200, { ready: true, limits: audioPlans.limits }); }); return;
      }
      if (request.method === 'POST' && path === '/api/audio/extract') {
        const body = await readPaidBody(), snapshot = audioRevision(body), prompt = audioExtractionPrompt(body);
        const primary = session.roles.primary;
        if (!primary) throw new AppError('Assign a primary model for source-image text recognition.');
        const provider = { ...session.providers.get(primary.providerId) };
        context('source_recognition', provider, primary);
        await runJob(session, async () => {
          ensureCurrent(); if (session.setupRevision !== snapshot) throw new AppError('AI setup changed before source recognition.', 409);
          // Make the existing effective output budget explicit; a longer wait does not raise it.
          const output = await generateText(provider, primary, { ...prompt, maxTokens: 10000 });
          ensureCurrent(); json(response, 200, parseAudioExtraction(output.text));
        }); return;
      }
      if (request.method === 'POST' && path === '/api/audio/plans') {
        const body = await readBody(), setupRevision = audioRevision(body), setup = speechSetup();
        await runJob(session, async () => { const result = await audioPlans.create(session.id, body, { ...setup, setupRevision }); ensureCurrent(); json(response, 201, result); }); return;
      }
      const audioPath = /^\/api\/audio\/plans\/([a-f0-9-]{36})(?:\/(sources|seal|export|reconfirm|clips)(?:\/([a-f0-9]{64}))?)?$/.exec(path);
      if (audioPath) {
        const [, id, action, clipId] = audioPath;
        // Every lookup (including GET) is scoped to the authenticated owner.
        if (request.method === 'GET' && !action) { json(response, 200, audioPlans.status(session.id, id)); return; }
        if (request.method === 'GET' && action === 'clips' && clipId) { json(response, 200, audioPlans.clipStatus(session.id, id, clipId)); return; }
        if (request.method === 'GET' && action === 'export' && !clipId) {
          await runJob(session, async () => { const result = await audioPlans.exportLesson(session.id, id); ensureCurrent(); json(response, 200, result); }); return;
        }
        if (request.method === 'DELETE' && !action) { await audioPlans.remove(session.id, id); ensureCurrent(); json(response, 200, { ok: true }); return; }
        if (request.method === 'POST' && action === 'reconfirm' && !clipId) {
          const body = await readPaidBody(), setupRevision = audioRevision(body), setup = speechSetup();
          await runJob(session, async () => { json(response, 200, await audioPlans.reconfirm(session.id, id, { setupRevision, speechIdentity: setup.speechIdentity })); }); return;
        }
        if (request.method === 'POST' && ['sources', 'seal'].includes(action) && !clipId) {
          const body = await readBody();
          await runJob(session, async () => { const result = action === 'sources' ? await audioPlans.addSource(session.id, id, body.source) : await audioPlans.seal(session.id, id); ensureCurrent(); json(response, 200, result); }); return;
        }
        if (request.method === 'POST' && action === 'clips' && clipId) {
          const body = await readPaidBody(), snapshot = audioRevision(body), setup = speechSetup();
          const speech = audioPlans.assertSetup(session.id, id, snapshot);
          // Reconfirmation is required after any setup revision; never retarget a plan silently.
          context('speech_generation', setup.provider, speech);
          await runJob(session, async () => {
            const encode = await encoder(); ensureCurrent();
            if (session.setupRevision !== snapshot) throw new AppError('AI setup changed before speech generation. Confirm again.', 409);
            const result = await audioPlans.synthesize(session.id, id, clipId, { attemptId: body.attemptId, retry: body.retry === true, encode, checkCurrent: ensureCurrent,
              generate: async text => { ensureCurrent(); if (session.setupRevision !== snapshot) throw new AppError('AI setup changed before speech generation. Confirm again.', 409); return generateSpeechBytes(setup.provider, speech, text); } });
            ensureCurrent(); json(response, 200, result);
          }); return;
        }
        throw new AppError('Unsupported audio plan operation.', 405);
      }
      if (request.method === 'POST' && path === '/api/materials') {
        const body = await readBody(); const result = await materials.create(session.id, body); ensureCurrent();
        json(response, 201, result); return;
      }
      if (request.method === 'POST' && path === '/api/materials/summarize') {
        const input = digestInput(await readPaidBody()), primary = session.roles.primary;
        if (!primary) throw new AppError('Assign a primary model before preparing material notes.');
        context('source_preparation', session.providers.get(primary.providerId), primary);
        await runJob(session, async () => {
          const retained = localDigest(input);
          if (retained) { ensureCurrent(); json(response, 200, retained); return; }
          const result = await generateText(session.providers.get(primary.providerId), primary, { ...digestPrompt(input), maxTokens: 2000 });
          ensureCurrent();
          let prepared;
          try { prepared = parseDigest(result.text); }
          catch (error) {
            if (error instanceof AppError) error.diagnostics = { ...result.diagnostics, ...error.diagnostics };
            throw error;
          }
          json(response, 200, { ...prepared, preparationMode: 'model' });
        }); return;
      }
      const materialPath = /^\/api\/materials\/([a-f0-9-]{36})(?:\/(content|finish|parts))?$/.exec(path);
      if (materialPath) {
        const [, id, action] = materialPath;
        if (request.method === 'GET' && !action) { json(response, 200, materials.status(session.id, id)); return; }
        if (request.method === 'DELETE' && !action) { await materials.remove(session.id, id); ensureCurrent(); json(response, 200, { ok: true }); return; }
        if (request.method === 'PUT' && action === 'content') {
          await runJob(session, async () => {
            const data = await documentBody(request, undefined, UPLOAD_CHUNK_BYTES); ensureCurrent();
            const result = await materials.append(session.id, id, Number(url.searchParams.get('offset')), data); ensureCurrent();
            json(response, 200, result);
          }); return;
        }
        if (request.method === 'POST' && ['finish', 'parts'].includes(action)) {
          const body = await readBody(); materials.status(session.id, id);
          if (activeImports >= 2) throw new AppError('Local material processing is busy. Try again shortly.', 503);
          await runJob(session, async () => {
            activeImports++;
            try {
              const result = action === 'finish' ? await materials.finish(session.id, id) : await materials.part(session.id, id, body.index);
              ensureCurrent(); json(response, 200, result);
            } finally { activeImports--; }
          }); return;
        }
      }
      if (request.method === 'POST' && path === '/api/materials/import') {
        const { name, extension } = documentName(request.headers['x-learnlens-filename']);
        if (activeImports >= 2) throw new AppError('Document extraction is busy. Try again shortly.', 503);
        await runJob(session, async () => {
          activeImports++;
          const controller = new AbortController(); session.importController = controller;
          const cancel = () => { if (!response.writableEnded) controller.abort(); };
          response.once('close', cancel);
          try {
            const buffer = await documentBody(request, controller.signal); ensureCurrent();
            const result = await importDocument(buffer, extension, { signal: controller.signal }); ensureCurrent();
            json(response, 200, { name, ...result });
          } finally { activeImports--; session.importController = null; response.removeListener('close', cancel); }
        }); return;
      }
      if (request.method === 'POST' && path === '/api/transcribe') {
        const body = await readPaidBody();
        const role = session.roles.transcription;
        if (!role) throw new AppError('Assign a speech-to-text model in AI providers first.');
        const audio = decodeDataUrl(body.dataUrl, 'audio');
        const extensions = { 'audio/webm': 'webm', 'audio/wav': 'wav', 'audio/mpeg': 'mp3', 'audio/mp4': 'mp4', 'audio/ogg': 'ogg' };
        const provider = session.providers.get(role.providerId);
        context('transcription', provider, role);
        await runJob(session, async () => {
          const text = await transcribeAudio(provider, role, audio, `recording.${extensions[audio.mime]}`);
          ensureCurrent();
          provider.checks[role.model] ||= Object.create(null); provider.checks[role.model].transcription = check('verified', `Successfully transcribed a recording using ${role.api === 'gemini' ? 'Gemini-native audio' : '/audio/transcriptions'}. This is a sample check, not pronunciation scoring or a guarantee for other recordings.`, role);
          json(response, 200, { text });
        }); return;
      }
      if (request.method === 'POST' && path === '/api/lessons') {
        const input = validateLessonInput(await readPaidBody());
        const primary = session.roles.primary, speech = session.roles.speech;
        if (!primary) throw new AppError('Assign a primary lesson model in AI providers first.');
        if (input.includeAudio && !speech) throw new AppError('Assign a speech generation model or turn off lesson audio.');
        const provider = session.providers.get(primary.providerId);
        context('lesson_generation', provider, primary);
        const speechProvider = speech && (speech.engine === 'kokoro' ? kokoro : session.providers.get(speech.providerId));
        await runJob(session, async () => {
          const output = await generateText(provider, primary, lessonPrompt(input));
          ensureCurrent();
          const lesson = parseLesson(output.text);
          const warnings = [...input.sourceWarnings, ...lesson.warnings];
          if (input.images.length && (provider.checks[primary.model]?.vision?.status !== 'verified' || provider.checks[primary.model]?.vision?.api !== primary.api || (provider.checks[primary.model]?.vision?.reasoningEffort || 'default') !== (primary.reasoningEffort || 'default') || (provider.checks[primary.model]?.vision?.timeoutSeconds ?? 300) !== (primary.timeoutSeconds ?? 300))) warnings.push('Image understanding was not capability-tested. Check that the lesson accurately reflects your screenshots.');
          provider.checks[primary.model] ||= Object.create(null); provider.checks[primary.model].text = check('verified', `Generated a structurally valid lesson using ${output.api}. Factual accuracy still needs review.`, primary);
          const audio = []; let audioBytes = 0;
          if (input.includeAudio) {
            if (!lesson.audio.length) warnings.push('The model did not provide a narration script. No audio was generated.');
            for (const line of lesson.audio) {
              try {
                ensureCurrent();
                const spoken = normalizeReadingPauses(line.text, line.readingPauses);
                if (!spoken.trim()) continue; // A pause marker alone is not narration.
                const generated = await generateSpeech(speechProvider, speech, spoken);
                ensureCurrent();
                audioBytes += generated.bytes;
                if (audioBytes > 12 * 1024 * 1024) { warnings.push('Audio size limit reached; remaining sentences were not embedded.'); break; }
                audio.push({ ...line, dataUrl: generated.dataUrl });
                const result = check('verified', 'Successfully generated an audio file. Listen to judge voice quality.', speech);
                if (speech.engine === 'kokoro') session.kokoroChecks[speech.voice] = result;
                else { speechProvider.checks[speech.model] ||= Object.create(null); speechProvider.checks[speech.model].speech = result; }
              } catch (error) { warnings.push(`Audio could not be completed: ${error instanceof AppError ? error.message : 'Speech service failed.'} The text lesson is still available.`); break; }
            }
          }
          ensureCurrent();
          const html = renderLesson(lesson, { images: input.images, sourceText: input.text, audio, warnings });
          json(response, 200, { id: randomUUID(), title: lesson.title, lesson, html, warnings });
        }); return;
      }
      throw new AppError('Not found.', 404);
    } catch (error) {
      if (!response.headersSent) json(response, error instanceof AppError ? error.status : 500, {
        error: error instanceof AppError ? error.message : 'An unexpected server error occurred. Please try again.', requestId,
        ...((diagnosticContext || (error instanceof AppError && error.diagnostics)) ? { diagnostics: { ...diagnosticContext, ...(error instanceof AppError ? error.diagnostics : {}), ...(!(error instanceof AppError) ? { category: 'internal' } : {}) } } : {}),
      });
      else response.end();
    }
  });

  async function runJob(session, work) {
    if (session.busy) throw new AppError('Another AI request is running in this session. Please wait for it to finish.', 409);
    if (activeJobs >= 8) throw new AppError('Server is busy. Please try again shortly.', 503);
    session.busy = true; activeJobs++;
    try { return await work(); } finally { session.busy = false; activeJobs--; }
  }
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.on('close', () => { clearInterval(interval); for (const session of sessions.values()) session.importController?.abort(); sessions.clear(); void materials.close().catch(() => {}); void audioPlans.close().catch(() => {}); });
  return { server };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const { host, port, options } = deploymentConfig();
  const { server } = createApp(options);
  server.listen(port, host, () => console.log(`LearnLens ready at ${process.env.PUBLIC_ORIGIN || `http://${host}:${port}`}\nAPI keys stay in isolated, expiring browser sessions. Press Ctrl+C to stop.`));
}
