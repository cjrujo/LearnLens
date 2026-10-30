# LearnLens MVP API contract

Node.js 22+, dependency-free HTTP server, locally on 127.0.0.1:3210. Vanilla HTML/CSS/ES modules frontend. No build step. Keys and lesson materials stay in server memory, never persisted. Non-secret settings also session-only for this release. Each browser gets an isolated HttpOnly SameSite cookie + CSRF token. Idle expiry 1 hour; absolute 12 hours. Hosted private-beta mode requires HTTPS PUBLIC_ORIGIN and LEARNLENS_ACCESS_PASSWORD (16+ chars), adds Secure cookies, and permits only public HTTPS provider destinations with checked/pinned IPs. Not a full account/auth platform; see README before hosting.

All /api routes require X-LearnLens-Token header from meta[name=learnlens-token]. Server replaces __APP_TOKEN__ in public/index.html. JSON mutation routes require application/json. Errors: {error: string}, appropriate non-2xx. All data/keys untrusted; use textContent, not innerHTML. Model capabilities cannot be determined from GET /models alone.

## GET /api/state
{locked:boolean,providers:[{id,name,baseUrl,hasKey,models:[{id}],checks:{[modelId]:{text?:{status,detail,checkedAt,api,voice?},vision?:...,speech?:...,transcription?:...}}}],roles:{primary: Role|null,transcription: Role|null,speech: Role|null}}
Role = {providerId,model,api:'auto'|'chat'|'responses',voice?:string,reasoningEffort?:'none'|'minimal'|'low'|'medium'|'high'|'xhigh'|'max'}. Thinking level is primary-only; omitted or 'default' is normalized to omitted. Responses sends reasoning.effort; Chat sends reasoning_effort. Support varies by model; no silent downgrade on rejection.
Speech may instead be {engine:'kokoro',model,api:'auto',voice}. The model is canonicalized from operator configuration. Browser-supplied private URLs are never accepted for this engine. api only matters to primary; speech uses /audio/speech compatibility endpoint. Speech is OPTIONAL (some direct OpenAI models need protocols not implemented yet). Never assume a model name guarantees endpoint support. Allow manual model ID for providers without listing support.

State also returns `starter: {role,reason}|null` and `speechServices: {kokoro:{available,bundled,model,voice,checks}}`. The starter is a non-billable built-in rule over listed models/sample checks, not an AI inference or a capability guarantee. Kokoro checks are keyed by voice. Managed endpoint URLs/keys are not returned. In the standard bundled deployment, new sessions have the Kokoro speech role selected by default without learner setup. Clearing the session restores this built-in default; users can explicitly select online speech or clear speech.

## POST /api/login
{password} => {ok:true}. Hosted access-password gate (not provider API key). GET state is available before login with locked=true and empty settings. Other routes are denied until authenticated.
## POST /api/logout
{} => {ok:true}. Clear this browser's provider keys and roles. Hosted mode locks the session again. In-flight external requests are not cancelled or undone. Their stale responses are rejected, and no follow-on speech requests start after logout.

## POST /api/providers
{name,baseUrl,apiKey} => {provider: publicProvider}
Base URL includes API prefix, e.g. https://api.openai.com/v1 or https://gateway.example/api/v1. Remove trailing slashes, don't append a second /v1. HTTP permitted only localhost/127.0.0.1/[::1] for locally hosted providers. API key optional for local providers, required for remote. Keys are write-only. Add multiple providers (or edit an existing connection with PUT).
## PUT /api/providers/:id
{name,baseUrl,apiKey?} => {provider: publicProvider}. Keeps provider ID and model-role references. Blank API key retains the existing key only when the normalized URL is unchanged; changing to a remote URL requires re-entering a key. A changed URL/key clears listed models and sample checks. Rejects during an active AI job. No upstream request is made by editing.
## DELETE /api/providers/:id
=> {ok:true}; clears roles referencing that provider.
## POST /api/providers/:id/discover
{} => {models:[{id}]} from /models. Empty list and unsupported endpoint should explain manual model entry, not block saving provider.
## POST /api/providers/:id/probe
{model,kind:'text'|'vision'|'speech',api:'auto'|'chat'|'responses',voice?:string,reasoningEffort?:string,consent:true} => {check:{status:'verified'|'failed',detail,checkedAt,api,voice?}}
Optional explicit tiny billable requests. UI must label paid tests and request confirmation. Text/vision use primary API selection. Vision tests image understanding, not mere payload acceptance. Checks include reasoningEffort when explicitly configured and are scoped to the selected primary API mode/thinking level or speech voice; changing these settings makes the relevant badge untested until another check succeeds. Speech probes one short line; transcription is verified after a real upload, not synthetic fake test.
## PUT /api/roles
{primary:Role|null,transcription:Role|null,speech:Role|null} => {roles}
Return selected model roles/count in UI; roles may reuse providers/models. Primary required to generate but can save null. Manual model IDs allowed. No fictitious model recommendations; show user-selected roles and untested status.

## POST /api/roles/recommend
{primary?:Role,scope?:'primary'|'all',consent:true} => {summary,suggestions:[{role:'primary'|'transcription'|'speech',selection:Role|null,reason,caveat}],warnings,advisor:Role}.
Uses the submitted primary draft or saved primary, including its thinking level. Explicit consent is required. Default scope includes only the primary provider; all scope shares other providers' catalogs with the primary advisor. Only catalog IDs, provider display names, scoped sample-check metadata and configured Kokoro availability are sent. No keys, base URLs, lesson material or internal provider IDs. Catalog includes listed and already-selected manual IDs; maximum 600 candidates. Unknown output candidates, invalid schema or settings changes during the call fail safely. Uses the normal AI job/session limits. Does not save roles or mark capability checks verified. UI renders text safely, lets users select which suggestions fill the draft, and requires a separate Save. Null selections mean abstain/preserve current choice.

## POST /api/speech/kokoro/probe
{voice?:string,consent:true} => {check}. Uses the included worker in the standard deployment, or an advanced operator-configured service. The service URL never comes from browser input. A Node-only developer run without a worker returns a clear unavailable error. Generates a short synthetic line and records the voice-specific result. Explicit local-test confirmation; no automatic cloud fallback. A returned supported audio format is not proof of naturalness or language quality.

## POST /api/lessons
{text:string,images:[{name,dataUrl}],language:string,level:string,subject:string,goal:string,includeAudio:boolean} => {id,title,html,warnings:[string],lesson:LessonSpec}
text up to 40k chars; up to 5 PNG/JPEG/WebP images, 4MB each and 8MB combined decoded; total HTTP body 13MB. Clipboard paste, drag/drop and file picker supported. TXT/MD frontend reads text and prefixes filename, text area editable. Explicit no PDF/Office import yet. Images require primary model vision capability; if untested show warning but let user request with data-processing notice. Inputs sent only to chosen provider on generate. Lesson model returns validated JSON and trusted renderer makes HTML; never execute arbitrary model HTML/JS. IncludeAudio=true generates up to 8 sentences from lesson.audio using the selected provider speech role or configured Kokoro engine. Failures keep valid text lesson with warnings, never claim audio exists. User explicitly initiates paid generation. No pronunciation scoring yet. All subjects primary through university via free-form subject + AI auto-detect; depth/correctness requires human review.

LessonSpec = {title,subject,level,language,summary,objectives:[string],sections:[{type:'explanation'|'steps'|'example'|'vocabulary'|'quiz'|'summary',title,body:string,items:[string],question:string,answer:string,translation:string,source:string}],audio:[{text,translation}],warnings:[string]}. Fields required (empty strings/arrays okay); max 16 sections, 8 audio sentences. Flexible section order/type chosen by AI/request. Plain text math in MVP, no arbitrary scripts or diagrams. Source labels from provided input, never fabricated page references. HTML output is self-contained with escaped content, embedded generated audio, 1x/.75x/.5x speed, revealable hints/answers and source labels. It contains no credentials or external calls.

## POST /api/transcribe
{dataUrl:'data:audio/webm;base64,...',name:'recording.webm'} => {text}
Selected transcription provider /audio/transcriptions multipart. Accept webm,wav,mp3,mp4,ogg; <=8MB. Frontend record via MediaRecorder if supported plus audio upload fallback. Ask before sending microphone data, stop tracks, show pending state. User can edit recognized text before generation. No claims that transcription measures pronunciation.

## GET /api/demo
=> same as lesson response, but clearly hand-authored example with no AI call, no generated audio. Text and interactive quizzes demonstrate format. Local sample English lesson. Preview via sandboxed iframe srcdoc, sandbox='allow-scripts' (NO allow-same-origin), accessible title. Download with Blob MIME text/html. Show source material can contain sensitive data and gets sent to configured providers.
