import { MaterialWorkspace } from './materials.js';

const $ = id => document.getElementById(id);
const $$ = selector => [...document.querySelectorAll(selector)];
const token = document.querySelector('meta[name="learnlens-token"]').content;
const EMPTY = { primary: null, transcription: null, speech: null };
let state = { providers: [], roles: { ...EMPTY }, locked: false };
let ready = false, busy = false, settingsBusy = false, page = 'lesson';
let currentLesson = null, downloadUrl = '', lastRequest = null, clock = null;
let roleDrafts = { ...EMPTY }, roleViews = {};
let editingProviderId = null, recommendations = null;
let recording = null, micStream = null, recordTimer = null, micPending = false;
let sessionEpoch = 0, confirming = false, generationController = null;
const materials = new MaterialWorkspace({ list: $('material-list'), api, changed: () => updateStatus() });
function cancelWork(session = false) { sessionEpoch++; generationController?.abort(); materials.cancelPending({ session }); }
let toastTimer;

function element(tag, text, className) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; }
function icon(name) { const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('class', 'icon'); svg.setAttribute('aria-hidden', 'true'); const use = document.createElementNS(svg.namespaceURI, 'use'); use.setAttribute('href', '#i-' + name); svg.append(use); return svg; }
function message(id, text = '', type = '') { const node = typeof id === 'string' ? $(id) : id; node.textContent = text; node.classList.add('inline-message'); node.classList.remove('error', 'warning'); if (type) node.classList.add(type); node.hidden = !text; }
function toast(text) { $('toast-message').textContent = text; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 5000); }
function announce(text) { $('announcer').textContent = text; }
function providerFor(role) { return state.providers.find(p => p.id === role?.providerId); }
function chosenSubject() { return $('subject').value === 'custom' ? $('custom-subject').value.trim() : 'Auto'; }
function chosenLanguage() { return $('language').value === 'custom' ? $('custom-language').value.trim() : $('language').value; }
function duration(seconds) { return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; }
function checkOf(role, kind) {
  const check = role?.engine === 'kokoro' ? state.speechServices?.kokoro?.checks?.[role.voice] : providerFor(role)?.checks?.[role?.model]?.[kind];
  if (!check || (['text', 'vision'].includes(kind) && (check.api !== role?.api || (check.reasoningEffort || 'default') !== (role?.reasoningEffort || 'default'))) || (kind === 'speech' && check.voice !== (role?.voice || 'alloy'))) return null;
  return check;
}

async function api(path, options = {}) {
  let response;
  try {
    response = await fetch('/api' + path, { ...options, headers: { 'X-LearnLens-Token': token, ...(options.raw ? { 'Content-Type': 'application/octet-stream' } : options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers }, credentials: 'same-origin', cache: 'no-store', body: options.raw || (options.body ? JSON.stringify(options.body) : undefined) });
  } catch (cause) { if (cause.name === 'AbortError') throw cause; const error = new Error('Could not reach LearnLens. Check your connection. An AI request already sent may still incur charges; it will not be retried automatically.'); error.network = true; throw error; }
  let result;
  try { result = await response.json(); } catch (cause) { if (cause.name === 'AbortError') throw cause; const error = new Error('LearnLens returned an unreadable response. Check the server connection.'); error.network = cause instanceof TypeError; throw error; }
  if (!response.ok) {
    if (response.status === 409 && ['/transcribe', '/materials/summarize', '/lessons'].includes(path)) {
      ready = false; cancelWork();
      $('connection-banner').hidden = false; $('connection-message').textContent = 'AI setup changed after confirmation. Processing stopped without switching providers. Refresh setup, then confirm again; your completed draft work remains intact.';
    }
    if ([401, 403].includes(response.status)) {
      cancelWork(true); ready = false; $('connection-banner').hidden = false; $('connection-message').textContent = 'Your session changed or expired. Download your lesson or copy your draft before reloading.'; $('reload-session').hidden = false; updateStatus();
    }
    const error = new Error(result.error || `Request failed (HTTP ${response.status}).`); error.status = response.status; throw error;
  }
  return result;
}

function navigate(next, focus = false) {
  page = next === 'providers' ? 'providers' : 'lesson';
  $('login-panel').hidden = !state.locked;
  $('lesson-page').hidden = state.locked || page !== 'lesson';
  $('providers-page').hidden = state.locked || page !== 'providers';
  $('breadcrumb-current').textContent = state.locked ? 'Unlock workspace' : page === 'lesson' ? 'New lesson' : 'AI providers';
  document.title = `${state.locked ? 'Unlock workspace' : page === 'lesson' ? 'New lesson' : 'AI providers'} · LearnLens`;
  $$('.nav-item').forEach(button => { const active = button.dataset.page === page; button.classList.toggle('is-active', active); if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current'); });
  if (focus) $(state.locked ? 'login-title' : page + '-page-title').focus({ preventScroll: true });
}
function tab(which) {
  for (const name of ['compose', 'preview']) { const active = name === which; $('tab-' + name).setAttribute('aria-selected', String(active)); $('tab-' + name).tabIndex = active ? 0 : -1; $(name + '-panel').hidden = !active; }
}

async function refreshState(rebuild = true) {
  try {
    state = await api('/state'); ready = true;
    $('connection-banner').hidden = true; $('reload-session').hidden = true;
    if (rebuild) { roleDrafts = structuredClone(state.roles); dismissRecommendations(); renderProviders(); renderRoles(); }
    updateStatus(); navigate(page);
  } catch (error) { ready = false; $('connection-banner').hidden = false; $('connection-message').textContent = error.message; updateStatus(); }
}

function updateStatus() {
  const assigned = Object.values(state.roles).filter(Boolean).length;
  $('setup-count').textContent = `${assigned}/3`; $('mini-count').textContent = `${assigned}/3`;
  $('saved-role-count').textContent = assigned;
  $('setup-label').textContent = !ready ? 'Connection unavailable' : state.locked ? 'Unlock workspace' : state.roles.primary ? 'AI setup ready' : 'Connect your AI';
  $('setup-dot').classList.toggle('pending', !state.roles.primary);
  $('clear-session').disabled = !ready || settingsBusy || Boolean(recording) || micPending || confirming;
  const usable = ready && !state.locked && !busy && !settingsBusy && !confirming && !materials.busy && !micPending;
  const editable = usable && !recording;
  $('retry-preview').disabled = !editable;
  materials.setLocked(busy || settingsBusy || confirming || !ready || state.locked || Boolean(recording) || micPending);
  $('dropzone').disabled = !editable; $('material-input').disabled = !editable;
  $('learning-goal').disabled = !editable;
  for (const id of ['subject', 'level', 'language']) $(id).disabled = !editable;
  $('custom-subject').disabled = !editable || $('subject').value !== 'custom';
  $('custom-language').disabled = !editable || $('language').value !== 'custom';
  $$('[data-goal]').forEach(button => button.disabled = !editable);
  $('material-list').setAttribute('aria-busy', String(materials.busy));
  $('import-status').hidden = !materials.busy;
  $('import-status').textContent = materials.busy ? materials.items.find(item => item.status === 'preparing')?.progress || 'Preparing local material previews… No AI request.' : '';
  $('generate-button').disabled = !editable;
  $('generate-label').textContent = busy ? 'Creating lesson…' : materials.busy ? 'Preparing materials locally…' : state.roles.primary ? 'Create my lesson' : 'Connect a primary model';
  $('generation-helper').textContent = state.roles.primary ? `Using ${state.roles.primary.model}` : 'One primary model is all you need to start.';
  $('include-audio').disabled = !state.roles.speech || !usable;
  if (!state.roles.speech) $('include-audio').checked = false;
  $('speech-note').textContent = state.roles.speech?.engine === 'kokoro' ? 'Built-in Kokoro speech · no extra API key. Generated audio is included in your download. Choose a voice that matches your language.' : state.roles.speech ? `AI-generated speech via ${providerFor(state.roles.speech)?.name} · additional credits apply.` : 'A compatible speech model is needed. Audio uses additional provider credits.';
  $('speech-setup-link').hidden = Boolean(state.roles.speech);
  $('provider-fields').disabled = !usable;
  $$('.provider-remove,.provider-edit,.discover-button').forEach(button => button.disabled = !usable);
  $('roles-fields').disabled = !usable;
  $('save-roles').disabled = !usable;
  $('settings-lock-note').hidden = !busy;
  $$('[data-action="demo"]').forEach(button => button.disabled = !usable);
  $('record-button').disabled = (!usable && !recording) || !navigator.mediaDevices?.getUserMedia || !window.MediaRecorder;
  for (const id of ['mini-roles', 'setup-role-list']) {
    const root = $(id); root.replaceChildren();
    for (const [key, label] of [['primary', 'Lesson model'], ['transcription', 'Voice input'], ['speech', 'Spoken examples']]) {
      const row = element('div'); const name = element('span', label); const value = element('span', state.roles[key]?.model || (key === 'primary' ? 'Needed' : 'Optional')); value.title = value.textContent; row.append(name, value); root.append(row);
    }
  }
  const unique = new Set(Object.values(state.roles).filter(Boolean).map(r => (r.engine || r.providerId) + '/' + r.model)).size;
  $('mini-setup-description').textContent = `${assigned} role${assigned === 1 ? '' : 's'} assigned across ${unique} distinct model${unique === 1 ? '' : 's'}. One primary is required; the two audio roles are optional.`;
  for (const view of Object.values(roleViews)) view.refreshChecks();
  updateAdvisorControls(usable);
  updateSummary();
}
function updateSummary() {
  $('summary-material').textContent = materials.items.length ? `${materials.items.length} attachment(s) · ${materials.partCount} automatic part(s)${materials.busy ? ' · preparing locally' : ''}` : $('learning-goal').value.trim() ? 'Question / instructions only' : 'Nothing added yet';
  $('summary-subject').textContent = chosenSubject() === 'Auto' ? 'Auto-detect' : chosenSubject() || 'Choose a subject';
  $('summary-level').textContent = $('level').value === 'Auto' ? 'Match the material' : $('level').value;
  $('summary-language').textContent = chosenLanguage() || 'Choose a language';
  $('summary-audio').textContent = $('include-audio').checked ? 'Natural AI voice' : 'Text-only lesson';
  $('summary-goal').textContent = $('learning-goal').value.trim() || 'Let the material guide the lesson.';
  $('vision-warning').hidden = !materials.hasVisuals || !state.roles.primary || checkOf(state.roles.primary, 'vision')?.status === 'verified';
  $('vision-warning-text').textContent = 'Image understanding is unverified for your primary model. You can run an optional paid vision test, or generate and carefully check the result.';
}

async function confirmAction({ title, description, detail = '', paid = false, accept = 'Continue' }) {
  const dialog = $('confirm-dialog'); if (dialog.open) return false;
  $('confirm-title').textContent = title; $('confirm-description').textContent = description; $('confirm-detail').textContent = detail; $('confirm-detail').hidden = !detail;
  $('confirm-consent-row').hidden = !paid; $('confirm-consent').checked = false; $('confirm-accept').textContent = accept; $('confirm-accept').disabled = paid;
  $('confirm-consent').onchange = () => $('confirm-accept').disabled = paid && !$('confirm-consent').checked;
  return new Promise(resolve => {
    const finish = value => { dialog.close(); resolve(value); };
    $('confirm-accept').onclick = () => finish(true); $('confirm-cancel').onclick = () => finish(false); $('confirm-close').onclick = () => finish(false);
    dialog.oncancel = event => { event.preventDefault(); finish(false); };
    dialog.showModal();
  });
}

function dismissRecommendations() {
  recommendations = null; $('recommend-results').hidden = true; $('recommend-cards').replaceChildren();
}
function updateAdvisorControls(usable) {
  const primary = roleViews.primary?.readDraft();
  $('use-starter').disabled = !usable || !state.starter;
  $('starter-hint').textContent = state.starter ? state.starter.reason : 'Discover models first. If no known starter is listed, select a general-purpose text/image model below; we will not guess from an unfamiliar name.';
  $('recommend-models').disabled = !usable || !primary?.model;
  $('recommend-scope').disabled = !usable;
  $('apply-recommendations').disabled = !usable || !recommendations;
}
function renderRecommendations(result) {
  recommendations = result; $('recommend-results').hidden = false; $('recommend-summary').textContent = result.summary;
  $('recommend-warnings').replaceChildren(...result.warnings.map(warning => element('li', warning)));
  const root = $('recommend-cards'); root.replaceChildren();
  for (const item of result.suggestions) {
    const card = element('article', undefined, 'recommend-card');
    const title = element('label', undefined, 'recommend-choice');
    const box = element('input'); box.type = 'checkbox'; box.dataset.role = item.role;
    box.disabled = !item.selection; box.checked = Boolean(item.selection && !roleDrafts[item.role]?.model);
    const name = rolesConfig[item.role].title;
    title.append(box, element('strong', name));
    const selection = item.selection;
    const selected = selection ? `${selection.engine === 'kokoro' ? 'Built-in Kokoro' : providerFor(selection)?.name || 'Provider'} / ${selection.model}` : 'No confident choice · keep your current selection';
    card.append(title, element('p', selected, 'recommend-model'), element('p', item.reason));
    if (item.caveat) card.append(element('p', item.caveat, 'field-hint'));
    const existing = roleDrafts[item.role];
    if (existing?.model) card.append(element('p', `Form choice when this advice arrived: ${existing.model}. Check this box only if you want to replace it.`, 'field-hint'));
    root.append(card);
  }
}
async function suggestModels() {
  const primary = roleViews.primary?.readDraft();
  if (!primary?.model || busy || settingsBusy) return;
  const scope = $('recommend-scope').value;
  if (!await confirmAction({ title: 'Ask your primary model for setup advice?', description: `This may use paid credits. Sends ${scope === 'all' ? 'all connected providers’' : 'the primary provider’s'} model IDs, display names and sample-check results to your chosen primary provider, plus Kokoro availability if configured. No API keys, base URLs, recordings or lesson material are included. Suggestions are not saved automatically.`, detail: `${providerFor(primary)?.name} · ${primary.model} · thinking: ${primary.reasoningEffort || 'model default'}`, paid: true, accept: 'Get model suggestions' })) return;
  settingsBusy = true; dismissRecommendations(); updateStatus(); message('recommend-message', 'Asking your primary model to explain suitable choices…');
  try { const result = await api('/roles/recommend', { method: 'POST', body: { primary, scope, consent: true } }); renderRecommendations(result); message('recommend-message', 'Review the suggestions. Nothing has been changed or capability-tested.'); }
  catch (error) { message('recommend-message', error.message + ' You can continue selecting models manually below.', 'error'); }
  finally { settingsBusy = false; updateStatus(); }
}
function resetProviderForm(preset = 'openai') {
  editingProviderId = null; $('provider-preset').value = preset;
  $('provider-name').value = preset === 'openai' ? 'OpenAI' : ''; $('provider-url').value = preset === 'openai' ? 'https://api.openai.com/v1' : '';
  $('provider-key').value = ''; $('provider-key').type = 'password'; $('toggle-key').setAttribute('aria-pressed', 'false'); $('toggle-key').setAttribute('aria-label', 'Show API key');
  $('provider-key-hint').textContent = 'Write-only and kept in memory. This field is cleared after saving. A key is optional for local providers.';
  $('save-provider').querySelector('span').textContent = 'Save provider'; $('cancel-provider-edit').hidden = true;
}

function renderProviders() {
  const root = $('provider-list'); root.replaceChildren();
  $('provider-empty').hidden = state.providers.length > 0;
  $('provider-count').textContent = `${state.providers.length} connected`;
  for (const provider of state.providers) {
    const card = $('provider-card-template').content.firstElementChild.cloneNode(true);
    card.querySelector('.provider-mark').textContent = provider.name.slice(0, 1).toUpperCase();
    card.querySelector('.provider-name').textContent = provider.name;
    card.querySelector('.provider-url').textContent = provider.baseUrl;
    card.querySelector('.provider-key-state').textContent = provider.hasKey ? 'Key in memory' : 'No key · local';
    card.querySelector('.provider-model-count').textContent = `${provider.models.length} listed models`;
    const list = card.querySelector('.model-id-list');
    provider.models.forEach(model => list.append(element('li', model.id)));
    card.querySelector('.model-list-details').hidden = !provider.models.length;
    card.querySelector('.provider-edit').onclick = () => {
      if (busy || settingsBusy) return;
      editingProviderId = provider.id; $('provider-preset').value = 'custom';
      $('provider-name').value = provider.name; $('provider-url').value = provider.baseUrl; $('provider-key').value = '';
      $('provider-key').type = 'password'; $('toggle-key').setAttribute('aria-pressed', 'false'); $('toggle-key').setAttribute('aria-label', 'Show API key');
      $('provider-key-hint').textContent = 'Leave the key blank to keep it ONLY when the URL is unchanged. Changing the URL requires re-entering a key for remote providers. Model IDs are kept but checks and the model list reset when the endpoint/key changes.';
      $('save-provider').querySelector('span').textContent = 'Save changes'; $('cancel-provider-edit').hidden = false;
      $('provider-add').open = true; $('provider-url').focus(); message('provider-form-message');
    };
    const remove = card.querySelector('.provider-remove'); remove.setAttribute('aria-label', `Remove ${provider.name}`);
    remove.onclick = async () => {
      if (busy || settingsBusy) return;
      if (!await confirmAction({ title: 'Remove this provider?', description: 'Its key and any associated model roles will be cleared from this browser session.', detail: provider.name, accept: 'Remove provider' })) return;
      settingsBusy = true; updateStatus();
      try { await api('/providers/' + provider.id, { method: 'DELETE' }); await refreshState(); toast('Provider removed.'); }
      catch (error) { message(card.querySelector('.provider-message'), error.message, 'error'); }
      finally { settingsBusy = false; updateStatus(); }
    };
    card.querySelector('.discover-button').onclick = async () => {
      if (busy || settingsBusy) return;
      settingsBusy = true; updateStatus(); const button = card.querySelector('.discover-button'); button.disabled = true;
      message(card.querySelector('.provider-message'), 'Requesting the provider’s model list…');
      try { const result = await api('/providers/' + provider.id + '/discover', { method: 'POST', body: {} }); await refreshState(false); renderProviders(); renderRoles(); toast(result.models.length ? `${result.models.length} models listed. Capabilities remain untested.` : 'No models listed. You can still enter an exact model ID.'); }
      catch (error) { message(card.querySelector('.provider-message'), error.message + ' You can still enter model IDs manually below.', 'error'); }
      finally { settingsBusy = false; updateStatus(); button.disabled = false; }
    };
    root.append(card);
  }
}
const rolesConfig = {
  primary: { title: 'Primary lesson model', icon: 'book', description: 'Understands material, identifies subjects, and creates lessons.', kinds: ['text', 'vision'] },
  transcription: { title: 'Speech-to-text', icon: 'mic', description: 'Turns recorded requests into editable text.', kinds: ['transcription'] },
  speech: { title: 'Natural speech', icon: 'headphones', description: 'Creates human-like, AI-generated spoken examples.', kinds: ['speech'] },
};
function renderRoles() {
  $('role-cards').replaceChildren(); roleViews = {};
  for (const [name, config] of Object.entries(rolesConfig)) {
    const card = $('role-card-template').content.firstElementChild.cloneNode(true); card.dataset.role = name;
    card.querySelector('.role-icon').append(icon(config.icon)); card.querySelector('[data-role-title]').textContent = config.title;
    card.querySelector('.role-requirement').textContent = name === 'primary' ? 'Required' : 'Optional'; card.querySelector('.role-description').textContent = config.description;
    const fields = Object.fromEntries(['provider', 'model', 'manual', 'api', 'voice', 'effort', 'engine'].map(key => [key, card.querySelector(`[data-field="${key}"]`)]));
    for (const [key, field] of Object.entries(fields)) { field.id = `role-${name}-${key}`; card.querySelector(`[data-for="${key}"]`).htmlFor = field.id; if (field.tagName === 'INPUT') field.maxLength = 200; }
    for (const provider of state.providers) fields.provider.add(new Option(provider.name, provider.id));
    const draft = roleDrafts[name]; fields.provider.value = draft?.providerId || ''; fields.api.value = draft?.api || 'auto'; fields.voice.value = draft?.voice || ''; fields.effort.value = draft?.reasoningEffort || 'default'; fields.engine.value = draft?.engine || 'provider';
    card.querySelector('.api-field').hidden = name !== 'primary'; card.querySelector('.effort-field').hidden = name !== 'primary'; card.querySelector('.voice-field').hidden = name !== 'speech'; card.querySelector('.engine-field').hidden = name !== 'speech';
    fields.engine.querySelector('[value="kokoro"]').disabled = !state.speechServices?.kokoro?.available;
    card.querySelector('.kokoro-hint').textContent = state.speechServices?.kokoro?.available ? (state.speechServices.kokoro.languages?.length === 1 && state.speechServices.kokoro.languages[0] === 'en' ? 'Included native Kokoro supports English (US/UK voices). Default: af_heart. Choose online speech for other languages. No installation, API key or automatic cloud fallback.' : 'Included speech runs on this server. No installation or API key needed. English voice af_heart is the default; voice and language support vary. No automatic cloud fallback.') : 'Built-in speech is unavailable on this server. You can use an online provider or contact the workspace administrator. No learner-side installation is required.';
    function readDraft() {
      if (name === 'speech' && fields.engine.value === 'kokoro') return { engine: 'kokoro', model: state.speechServices.kokoro.model, api: 'auto', voice: fields.voice.value.trim() || state.speechServices.kokoro.voice };
      if (!fields.provider.value) return null;
      return { providerId: fields.provider.value, model: fields.model.value === '__manual__' ? fields.manual.value.trim() : fields.model.value, api: fields.api.value, ...(name === 'primary' && fields.effort.value !== 'default' ? { reasoningEffort: fields.effort.value } : {}), ...(name === 'speech' ? { voice: fields.voice.value.trim() || 'alloy' } : {}) };
    }
    function refreshEngine() {
      const local = name === 'speech' && fields.engine.value === 'kokoro';
      card.querySelector('.provider-field').hidden = local; card.querySelector('.model-field').hidden = local;
      card.querySelector('.manual-model-field').hidden = local || fields.model.value !== '__manual__';
      fields.voice.placeholder = local ? state.speechServices.kokoro.voice : 'A voice your provider supports';
    }
    function populateModel(model = '') {
      const provider = state.providers.find(p => p.id === fields.provider.value);
      fields.model.replaceChildren(new Option(provider ? 'Select a model…' : 'Choose a provider first', ''));
      if (provider) { for (const entry of provider.models) fields.model.add(new Option(entry.id, entry.id)); fields.model.add(new Option('Enter model ID manually…', '__manual__')); }
      fields.model.disabled = !provider;
      fields.model.value = provider?.models.some(m => m.id === model) ? model : provider && (model || !provider.models.length) ? '__manual__' : '';
      fields.manual.value = model;
      card.querySelector('.manual-model-field').hidden = fields.model.value !== '__manual__';
    }
    function refreshChecks() {
      const role = readDraft(); const provider = providerFor(role); const checks = card.querySelector('.check-badges'); checks.replaceChildren();
      for (const kind of config.kinds) {
        const check = checkOf(role, kind); const badge = element('span', `${kind}: ${check?.status === 'verified' ? 'Verified' : check?.status === 'failed' ? 'Test failed' : 'Untested'}`, 'badge ' + (check?.status === 'verified' ? 'verified' : check?.status === 'failed' ? 'failed' : 'neutral')); badge.title = check?.detail || 'No verified capability test yet.'; checks.append(badge);
      }
      const help = role?.engine === 'kokoro' ? 'Uses the included Kokoro engine, never the online speech provider. Changing voices requires another check. Listen to judge language coverage and naturalness.' : name === 'primary' ? 'Auto tries Responses, then Chat only for missing endpoints. Thinking levels are model-dependent; Default is safest. Vision checks one synthetic image, not handwriting accuracy.' : name === 'speech' ? 'Requires /audio/speech compatibility. A Realtime-only model will not work here. Voice defaults to alloy; set a voice your provider supports.' : 'Requires /audio/transcriptions. Verification comes from an actual recording, not from a model name.';
      card.querySelector('.role-check-help').textContent = help;
      card.querySelectorAll('.probe-buttons button').forEach(button => button.disabled = !role?.model || (!provider && role?.engine !== 'kokoro') || busy || settingsBusy);
    }
    populateModel(draft?.model || ''); refreshEngine();
    const update = () => { roleDrafts[name] = readDraft(); refreshEngine(); refreshChecks(); updateAdvisorControls(ready && !state.locked && !busy && !settingsBusy); };
    fields.engine.onchange = () => { fields.voice.value = fields.engine.value === 'kokoro' ? state.speechServices.kokoro.voice : ''; update(); };
    fields.provider.onchange = () => { populateModel(); update(); };
    fields.model.onchange = () => { card.querySelector('.manual-model-field').hidden = fields.model.value !== '__manual__'; update(); };
    for (const key of ['manual', 'api', 'voice', 'effort']) fields[key].addEventListener(['api', 'effort'].includes(key) ? 'change' : 'input', update);
    if (name !== 'transcription') for (const kind of config.kinds) {
      const button = element('button', `Test ${kind}`, 'btn secondary small'); button.type = 'button';
      button.onclick = async () => {
        const role = readDraft(); if (!role?.model || busy || settingsBusy) return;
        const provider = providerFor(role);
        const local = role.engine === 'kokoro';
        if (!await confirmAction({ title: `Run a ${kind} capability test?`, description: local ? 'Generate a short synthetic clip using built-in speech. No lesson material is included and no cloud speech provider will be called.' : 'This sends a synthetic request to your selected provider. It may use paid credits; higher thinking levels can increase cost. No learning material is included.', detail: `${local ? 'Built-in Kokoro' : provider.name} · ${role.model}${kind === 'speech' ? ' · voice: ' + role.voice : ''}`, paid: !local, accept: local ? 'Test Kokoro' : 'Run paid test' })) return;
        settingsBusy = true; updateStatus(); refreshChecks(); message(card.querySelector('.role-feedback'), 'Testing this capability…');
        try { const result = await api(local ? '/speech/kokoro/probe' : `/providers/${provider.id}/probe`, { method: 'POST', body: { ...role, kind, consent: true } }); await refreshState(false); message(card.querySelector('.role-feedback'), result.check.detail, result.check.status === 'failed' ? 'error' : ''); }
        catch (error) { message(card.querySelector('.role-feedback'), error.message, 'error'); }
        finally { settingsBusy = false; updateStatus(); refreshChecks(); }
      };
      card.querySelector('.probe-buttons').append(button);
    }
    refreshChecks(); roleViews[name] = { card, readDraft, refreshChecks }; $('role-cards').append(card);
  }
}

async function addFiles(files) {
  if (busy || settingsBusy || confirming || recording || micPending || !ready || state.locked) return;
  try { const issues = await materials.add(files); message('upload-message', issues.join(' '), issues.length ? 'error' : ''); }
  catch (error) { if (error.name !== 'AbortError') message('upload-message', error.message, 'error'); }
}

async function preview(kind, request, approvedSetup) {
  if (busy || settingsBusy || materials.busy || confirming || recording || !ready) return;
  const epoch = sessionEpoch; generationController = new AbortController();
  const check = () => { if (epoch !== sessionEpoch || generationController.signal.aborted) throw new DOMException('Stopped. Your draft and completed preparation remain on this page.', 'AbortError'); };
  busy = true; lastRequest = { kind, request }; navigate('lesson'); tab('preview'); updateStatus();
  $('preview-empty').hidden = true; $('preview-error').hidden = true; $('preview-result').hidden = true; $('preview-loading').hidden = false;
  $('request-kind').textContent = kind === 'demo' ? 'LOCAL EXAMPLE' : 'CREATING YOUR LESSON';
  $('progress-title').textContent = kind === 'demo' ? 'Opening the example' : 'Preparing your materials';
  $('progress-description').textContent = kind === 'demo' ? 'No AI credits are used.' : 'All automatic parts are processed in order. Successful preparation is cached for retries on this page.';
  const started = Date.now(); const tick = () => $('progress-elapsed').textContent = duration(Math.floor((Date.now() - started) / 1000)) + ' elapsed'; tick(); clock = setInterval(tick, 1000);
  try {
    let payload = request;
    if (kind !== 'demo') {
      const prepared = await materials.prepare({ consent: true, goal: request.goal, roles: approvedSetup.roles, expectedSetupRevision: approvedSetup.revision, progress: text => { check(); $('progress-title').textContent = text; } });
      check(); payload = { ...request, ...prepared, consent: true };
      $('progress-title').textContent = 'Creating the final lesson';
      $('progress-description').textContent = 'Sending bounded source notes and representative images. Requested spoken examples follow. This may take a few minutes.';
    }
    check();
    const result = kind === 'demo' ? await api('/demo', { signal: generationController.signal }) : await api('/lessons', { method: 'POST', body: payload, signal: generationController.signal });
    check();
    currentLesson = { ...result, sample: kind === 'demo', sourceDescription: kind === 'demo' ? 'Hand-authored English sample · no uploaded material' : `${materials.items.length} original attachment(s) · ${materials.partCount} parts processed · ${payload.images.length} representative image(s)` };
    displayLesson(); announce('Your lesson is ready.'); await refreshState(false);
  } catch (error) {
    $('preview-error').hidden = false; $('preview-error-message').textContent = error.message;
    $('preview-error-note').textContent = 'Your attachments, instructions, previous lesson and successful cached preparation remain intact. Retry asks for paid consent and skips cached successes. A failed or unknown AI request may still incur charges.';
    $('show-previous').hidden = !currentLesson; announce('Processing stopped. Your draft is intact.');
  } finally { clearInterval(clock); busy = false; generationController = null; $('preview-loading').hidden = true; updateStatus(); }
}
function displayLesson() {
  const result = currentLesson; if (!result) return;
  $('preview-result').hidden = false; $('preview-error').hidden = true; $('preview-empty').hidden = true; $('preview-loading').hidden = true;
  $('result-kind').textContent = result.sample ? 'HAND-AUTHORED EXAMPLE · NO AI CALL' : 'YOUR AI-ASSISTED LESSON';
  $('result-title').textContent = result.title;
  $('result-meta').replaceChildren(...[result.lesson.subject, result.lesson.level, result.lesson.language, 'Offline HTML'].map(text => element('span', text)));
  $('result-source').textContent = result.sourceDescription;
  $('warning-list').replaceChildren(...result.warnings.map(text => element('li', text))); $('result-warnings').hidden = !result.warnings.length;
  $('lesson-frame').srcdoc = result.html;
  if (downloadUrl) URL.revokeObjectURL(downloadUrl); downloadUrl = URL.createObjectURL(new Blob([result.html], { type: 'text/html;charset=utf-8' }));
  $('download-lesson').href = downloadUrl;
  $('download-lesson').download = 'LearnLens-' + result.title.replace(/[^\p{L}\p{N} _-]/gu, '').slice(0, 70).trim().replace(/\s+/g, '-') + '.html';
  $('preview-dot').hidden = false;
  $('review-note-text').textContent = 'This HTML includes styles, exercises, source images and any successfully generated audio. It needs no internet. Open in a browser rather than a file-manager preview. Review AI explanations and answers.';
}
async function generate(event) {
  event?.preventDefault(); message('generation-error');
  if (busy || settingsBusy || confirming || materials.busy || !ready || micPending) return;
  if (!state.roles.primary) { navigate('providers', true); toast('Connect a provider and assign a primary lesson model.'); return; }
  if (recording) { message('generation-error', 'Stop recording before generating a lesson.', 'error'); return; }
  const request = { language: chosenLanguage(), level: $('level').value, subject: chosenSubject(), goal: $('learning-goal').value.trim(), includeAudio: $('include-audio').checked };
  if (!request.goal && !materials.items.length) { message('generation-error', 'Add material or ask a question in Instructions.', 'error'); $('learning-goal').focus(); return; }
  if (!request.language || !request.subject) { message('generation-error', 'Enter your chosen language and subject, or choose automatic detection.', 'error'); return; }
  if (materials.items.some(item => item.status !== 'ready')) { message('generation-error', 'Resume failed local imports before creating the lesson.', 'error'); return; }
  if (materials.needsTranscription && !state.roles.transcription) { message('generation-error', 'Assign a transcription role in AI providers for your audio or video.', 'error'); return; }
  if (!Number.isInteger(state.setupRevision)) { message('generation-error', 'Refresh AI setup before confirming: the server did not provide its setup revision.', 'error'); return; }
  const approvedSetup = { revision: state.setupRevision, roles: structuredClone(state.roles) };
  request.expectedSetupRevision = approvedSetup.revision;
  const epoch = sessionEpoch; confirming = true; updateStatus();
  let consent;
  try {
    consent = await confirmAction({ title: 'Process all parts and create your lesson?', description: 'Extracted text and images go to your primary provider; prepared audio parts go to your transcription provider. Originals never go directly to providers. This can make multiple billable calls. AI digests are lossy, not guaranteed verbatim; only representative preview images are embedded. Remove sensitive material before continuing.', detail: materials.describe() + '\nPrimary: ' + approvedSetup.roles.primary.model + (request.includeAudio ? '\nSpoken examples enabled: additional generation calls may apply.' : ''), paid: true, accept: 'Process all parts & create' });
  } finally { confirming = false; updateStatus(); }
  if (consent && epoch === sessionEpoch) await preview('generate', request, approvedSetup);
}

async function toggleRecording() {
  if (recording) { recording.stop(); return; }
  if (busy || settingsBusy || confirming || materials.busy || micPending || !ready || state.locked) return;
  const epoch = sessionEpoch; micPending = true; updateStatus(); message('voice-message');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (epoch !== sessionEpoch) { stream.getTracks().forEach(track => track.stop()); return; }
    micStream = stream;
    const type = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find(mime => MediaRecorder.isTypeSupported(mime));
    if (!type) throw new Error('No supported recording format. Upload an audio file instead.');
    recording = new MediaRecorder(stream, { mimeType: type }); const chunks = []; let recordingBytes = 0;
    const recorder = recording;
    recorder.ondataavailable = event => { if (event.data.size && epoch === sessionEpoch) { chunks.push(event.data); recordingBytes += event.data.size; if (recordingBytes > 1020 * 1024 * 1024 && recorder.state === 'recording') recorder.stop(); } };
    recorder.onstop = () => {
      stream.getTracks().forEach(track => track.stop()); micStream = null; recording = null; clearInterval(recordTimer);
      $('record-label').textContent = 'Record material'; $('recording-time').hidden = true; updateStatus();
      if (epoch === sessionEpoch) {
        const mime = type.split(';')[0]; const file = new File(chunks, `recording-${Date.now()}.${mime.split('/')[1]}`, { type: mime });
        addFiles([file]); message('voice-message', 'Recording added as material. Speech is automatically split; transcription requires confirmation when creating.');
      }
    };
    recorder.onerror = () => { message('voice-message', 'Recording failed. Upload an audio file instead.', 'error'); if (recorder.state !== 'inactive') recorder.stop(); stream.getTracks().forEach(track => track.stop()); };
    recorder.start(1000); $('record-label').textContent = 'Stop recording'; $('recording-time').hidden = false; $('recording-time').textContent = '0:00';
    const started = Date.now(); recordTimer = setInterval(() => { const seconds = Math.floor((Date.now() - started) / 1000); $('recording-time').textContent = duration(seconds); if (seconds > 0 && seconds % 300 === 0) void api('/state').catch(() => {}); if (seconds >= 14395 && recorder.state === 'recording') recorder.stop(); }, 1000);
  } catch (error) { micStream?.getTracks().forEach(track => track.stop()); recording = null; micStream = null; message('voice-message', error.name === 'NotAllowedError' ? 'Microphone access was declined. Upload audio or type your request.' : error.message, 'error'); }
  finally { micPending = false; updateStatus(); }
}

// Navigation and dialogs.
$$('[data-page]').forEach(button => button.addEventListener('click', event => { event.preventDefault(); navigate(button.dataset.page, true); }));
$$('[data-action="demo"]').forEach(button => button.onclick = () => preview('demo'));
for (const name of ['compose', 'preview']) { $('tab-' + name).onclick = () => tab(name); $('tab-' + name).onkeydown = event => { if (['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); const next = name === 'compose' ? 'preview' : 'compose'; tab(next); $('tab-' + next).focus(); } }; }
for (const id of ['empty-back-draft', 'error-back-draft', 'back-to-draft']) $(id).onclick = () => tab('compose');
$('show-previous').onclick = displayLesson;
$('retry-preview').onclick = () => { if (lastRequest?.kind === 'demo') preview('demo'); else generate(); };
$('stop-processing').onclick = () => cancelWork();
$('dismiss-toast').onclick = () => $('toast').hidden = true;
$('retry-state').onclick = () => refreshState();
$('reload-session').onclick = async () => { if (await confirmAction({ title: 'Reload your session?', description: 'Download any finished lesson and copy your draft first. Reloading clears the current draft.', accept: 'Reload' })) location.reload(); };
$('clear-session').onclick = async () => {
  if (!await confirmAction({ title: 'Clear this browser’s session?', description: 'Your provider keys and custom model assignments will be removed. Included speech returns to its default where available. Your current draft stays on this page. Already submitted AI requests cannot be undone.', accept: 'Clear session' })) return;
  cancelWork(true);
  try { await api('/logout', { method: 'POST', body: {} }); resetProviderForm(); await refreshState(); toast('Your provider settings were cleared.'); } catch (error) { toast(error.message); }
};
$('login-form').onsubmit = async event => {
  event.preventDefault(); $('login-button').disabled = true; message('login-message');
  try { await api('/login', { method: 'POST', body: { password: $('access-password').value } }); $('access-password').value = ''; await refreshState(); }
  catch (error) { message('login-message', error.message, 'error'); }
  finally { $('login-button').disabled = false; }
};
$('recommend-models').onclick = suggestModels;
$('dismiss-recommendations').onclick = () => { dismissRecommendations(); message('recommend-message'); updateStatus(); };
$('use-starter').onclick = async () => {
  if (!state.starter || busy || settingsBusy) return;
  if (roleDrafts.primary?.model && !await confirmAction({ title: 'Replace the primary model in your form?', description: state.starter.reason, accept: 'Use starter' })) return;
  roleDrafts.primary = structuredClone(state.starter.role); renderRoles(); updateStatus();
  message('roles-message', 'Starter filled in, not saved or tested. You can now ask it for suggestions or save your model roles.');
};
$('apply-recommendations').onclick = () => {
  if (!recommendations || busy || settingsBusy) return;
  let count = 0;
  for (const item of recommendations.suggestions) {
    const checked = document.querySelector(`#recommend-cards input[data-role="${item.role}"]`)?.checked;
    if (checked && item.selection) { roleDrafts[item.role] = structuredClone(item.selection); count++; }
  }
  if (!count) { message('recommend-message', 'Check the model roles you want to use first.', 'warning'); return; }
  renderRoles(); updateStatus(); message('roles-message', `${count} suggestion(s) filled into the form. Review or change any field, then Save model roles.`);
  message('recommend-message', 'Suggestions copied to the form only. Your saved roles have not changed.');
};
$('cancel-provider-edit').onclick = () => { resetProviderForm(); message('provider-form-message'); };
$('provider-preset').onchange = () => {
  const id = editingProviderId, preset = $('provider-preset').value;
  if (!id) resetProviderForm(preset);
  else { $('provider-name').value = preset === 'openai' ? 'OpenAI' : ''; $('provider-url').value = preset === 'openai' ? 'https://api.openai.com/v1' : ''; $('provider-key').value = ''; }
  message('provider-form-message', 'Preset updated. Check the destination and enter a key for that provider. No connection has been made.');
};
$('toggle-key').onclick = () => { const show = $('provider-key').type === 'password'; $('provider-key').type = show ? 'text' : 'password'; $('toggle-key').setAttribute('aria-pressed', String(show)); $('toggle-key').setAttribute('aria-label', show ? 'Hide API key' : 'Show API key'); };
$('provider-form').onsubmit = async event => {
  event.preventDefault(); if (busy || settingsBusy) return; message('provider-form-message');
  const body = { name: $('provider-name').value.trim(), baseUrl: $('provider-url').value.trim(), apiKey: $('provider-key').value.trim() };
  if (!body.name || !body.baseUrl) { message('provider-form-message', 'Enter a provider name and API base URL.', 'error'); return; }
  settingsBusy = true; updateStatus();
  try { await api(editingProviderId ? '/providers/' + editingProviderId : '/providers', { method: editingProviderId ? 'PUT' : 'POST', body }); resetProviderForm(); await refreshState(); message('provider-form-message', 'Provider saved. Discover its models, use a starter primary if available, or enter an exact model ID below.'); toast('Provider saved. No inference request was made.'); }
  catch (error) { message('provider-form-message', error.message, 'error'); }
  finally { body.apiKey = ''; settingsBusy = false; updateStatus(); }
};
$('roles-form').onsubmit = async event => {
  event.preventDefault(); if (busy || settingsBusy) return; message('roles-message');
  const roles = Object.fromEntries(Object.entries(roleViews).map(([key, view]) => [key, view.readDraft()]));
  if (Object.values(roles).some(role => role && !role.model)) { message('roles-message', 'Choose a model ID for each selected provider, or leave that role unassigned.', 'error'); return; }
  settingsBusy = true; updateStatus();
  try { await api('/roles', { method: 'PUT', body: roles }); await refreshState(); message('roles-message', 'Model roles saved. Capability tests are optional.'); toast('Your model roles have been saved.'); }
  catch (error) { message('roles-message', error.message, 'error'); }
  finally { settingsBusy = false; updateStatus(); }
};
$('dropzone').onclick = () => { if (!$('dropzone').disabled) $('material-input').click(); };
$('material-input').onchange = async event => { await addFiles(event.target.files); event.target.value = ''; };
for (const type of ['dragenter', 'dragover']) $('dropzone').addEventListener(type, event => { event.preventDefault(); $('dropzone').classList.add('dragover'); });
for (const type of ['dragleave', 'drop']) $('dropzone').addEventListener(type, event => { event.preventDefault(); $('dropzone').classList.remove('dragover'); if (type === 'drop') addFiles(event.dataTransfer.files); });
window.addEventListener('dragover', event => event.preventDefault()); window.addEventListener('drop', event => event.preventDefault());
document.addEventListener('paste', event => {
  if (page !== 'lesson' || state.locked || busy || settingsBusy || confirming || recording || micPending || !ready || $('confirm-dialog').open || event.target.closest('input,textarea,[contenteditable="true"]')) return;
  const files = [...(event.clipboardData?.files || [])]; const text = event.clipboardData?.getData('text/plain');
  if (files.length || text?.trim()) { event.preventDefault(); addFiles(files.length ? files : [new File([text], 'Pasted notes.txt', { type: 'text/plain' })]); }
});
$('subject').onchange = () => { const custom = $('subject').value === 'custom'; $('custom-subject-field').hidden = !custom; $('custom-subject').disabled = !custom; updateSummary(); };
$('language').onchange = () => { const custom = $('language').value === 'custom'; $('custom-language-field').hidden = !custom; $('custom-language').disabled = !custom; updateSummary(); };
for (const id of ['learning-goal', 'custom-language', 'custom-subject', 'level', 'include-audio']) $(id).addEventListener('input', updateSummary);
$$('[data-goal]').forEach(button => button.onclick = () => { const value = button.dataset.goal; const current = $('learning-goal').value; if (!current.includes(value)) $('learning-goal').value = (current + (current ? '\n' : '') + value).slice(0, 2000); button.setAttribute('aria-pressed', 'true'); updateSummary(); });
$('lesson-form').onsubmit = generate;
$('record-button').onclick = toggleRecording;
window.addEventListener('pagehide', () => { cancelWork(); if (recording?.state === 'recording') recording.stop(); micStream?.getTracks().forEach(track => track.stop()); });
window.addEventListener('beforeunload', event => { if (busy || recording || materials.busy) { event.preventDefault(); event.returnValue = ''; } });
if (/Mac|iPhone|iPad/.test(navigator.platform)) $('paste-shortcut').textContent = '⌘ V';
if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) message('voice-message', 'Recording is unavailable here. Use HTTPS and a supported browser, or upload an audio file.');
await refreshState();
