# LearnLens

**See it. Hear it. Understand it.**

A responsive, bring-your-own-provider web app that turns screenshots, questions and source text into a downloadable, self-contained HTML lesson. This is the first working prototype, not a certified educational assessment system.

## Run locally

Requires **Node.js 22.13 or later**. **Docker is not required:** normal startup manages native Kokoro speech on Windows and Linux. There is no frontend build step. See [WINDOWS.md](WINDOWS.md) for a local PC and [VPS.md](VPS.md) for a Linux VPS with **tmux + HTTPS**.

```sh
cd LearnLens
npm ci
npm start
```

First startup downloads and verifies the pinned speech model (~92 MB, plus npm dependencies); subsequent starts reuse `.cache/speech/`. Native speech is English-only, defaults to `af_heart`, and needs no separate speech URL/key. `npm run setup:speech` prepares it separately. `npm start` automatically reads the project-root `.env` if present. For app-only development, use `npm run start:lite`.

Open **http://127.0.0.1:3210**. Start with **Try a local example** (a hand-authored demonstration, no API request), or configure your provider to generate a real lesson.

```sh
npm test
npm run check
```

The tests use local mock providers. They do not call paid models or prove the educational quality of a real model. Automated unit/API suites and opt-in real media/native checks are included, plus a Chromium browser smoke suite covering desktop/mobile layouts, provider setup, uploads, transcription, sandboxed preview, real browser download, password gating and offline audio playback. See [TESTING.md](TESTING.md) for reproduction and remaining validation gaps.

## What works in v0.2

- Screenshot/photo input: PNG, JPEG, WebP, including clipboard paste and drag/drop.
- One unified material area plus one instruction box. Text/Markdown, PDF, DOCX, PPTX, MP3, MP4, WebM, WAV and OGG join screenshots and voice recording.
- Resumable uploads and automatic document/media segmentation. Large sources become source-labeled preparation notes without asking learners to manually cut ordinary files. See [IMPORTS.md](IMPORTS.md) for processing, limits, privacy and costs.
- Free-form subjects and AI classification, across primary, junior secondary, high school and college/university. Users can specify subject, level, language and teaching goal.
- Flexible model-chosen lesson composition: explanations, ordered steps, examples, vocabulary, translations, practice with revealable answers, summaries and objectives.
- Built-in OpenAI standard preset (`https://api.openai.com/v1`), editable connections, multiple compatible providers and manual model IDs.
- Primary-model thinking level: Default, None, Minimal, Low, Medium, High, Extra high or Maximum, subject to model support. Configurable request wait: 30–600 seconds, default 300.
- Optional primary-model setup advisor: reviewed suggestions with reasons, never silently saved or treated as capability verification.
- Explicit model listing and opt-in **billable** text, vision and speech capability tests.
- Separate primary, transcription, native-video and speech model roles. Same provider/model may serve several roles when supported.
- Responses API with narrowly scoped Chat Completions fallback, or explicit endpoint mode. Bounded completed SSE responses and UTF-8 BOMs are handled; malformed, empty and HTML responses get safe, format-specific diagnostics rather than blaming the model.
- Voice recording and media transcription through `/audio/transcriptions` or an explicitly selected [Gemini-native audio API](GEMINI-AUDIO.md), after explicit consent. Long audio-only recordings are automatically split into independent audio parts. New videos use complete chronological native audiovisual clips, not sampled stills.
- [Complete English audio](FULL-AUDIO.md) defaults to **Auto: English-subject lessons only**, with explicit On/Off overrides. Subject Auto uses the normal lesson response, not the explanation language or an extra classifier call. It covers words and sentence/phrase targets from **both uploaded material and the generated lesson**, not eight selected examples. Full extracted text is retained separately from teaching summaries. Click-to-play, repeat, Stop and 1× / 0.75× / 0.5× work offline; completed clips are reused on continuation without repeating paid teaching.
- Explicit generated reading-pause `/` marks stay visible but become pauses in speech; literal slashes in unmarked content are not stripped. Downloaded existing clips are unchanged.
- Speech uses native Kokoro or an explicitly selected compatible provider. Native output is WAV internally; managed FFmpeg compresses complete-mode exports to MP3. The exact unique clip count and local/potentially billable speech destination require a second confirmation. English/Latin-script matching is not reliable language identification; recognition and pronunciation still need review. No automatic cloud or browser-TTS fallback.
- Downloaded HTML includes its own CSS, trusted interaction script, source images and successfully generated audio. No CDN, font download, API connection or API key is required to open it offline.
- Responsive browser interface; separate in-memory state and credentials for each browser session.

## Public links and videos (unreleased)

The working tree adds explicit **fetch → private review → separate AI approval** for public webpage/audio/video/YouTube links. Whole-video analysis requires a separately configured native-video role and saved results for every interval before teaching. See [setup, recovery, privacy and limits](URL-SOURCES.md). Local tests are not proof of public YouTube availability or perfect video understanding; the release/activation gates remain in [TESTING.md](TESTING.md#url-sources-and-whole-video-unreleased).

## Choose models

| Role | Requirement | When needed |
|---|---|---|
| Primary | Text generation and image understanding for screenshots; able to follow a JSON schema prompt | Always |
| Transcription | OpenAI multipart `/audio/transcriptions` or explicit Gemini-native `models.generateContent` | Audio-only input |
| Video analysis | Explicit Gemini-native `generateContent` with inline MP4 and requested FPS | Whole-video input; assigned manually |
| Speech | OpenAI-compatible `/audio/speech`, binary audio response, a voice supported by the provider | Lesson audio |

That means **one always-required role and three input/output-dependent roles**, not necessarily four distinct models. Embeddings, live voice and multi-agent orchestration are not needed for the first document-to-lesson flow.

1. Start with the **OpenAI standard** preset or choose **Custom**. The base URL remains editable; enter the key belonging to that destination. Example: `https://api.openai.com/v1`, or `https://your-gateway.example/api/v1`.
2. Use **Discover models** to query `{baseURL}/models`. This does not run inference. A provider without this endpoint can still work: enter model IDs manually.
3. Assign models to roles. For primary, select **Auto**, **Responses** or **Chat Completions**. Auto tries Responses first and falls back only on HTTP 404, 405 or 501. It never retries authorization, quota or generic server errors against a different endpoint.
4. If unsure, click **Use a starter primary** (when available), then **Ask primary to suggest models**. The starter is a transparent catalog-based rule: prefer matching text/vision sample checks, otherwise `gpt-5.4-mini` only if that exact ID is listed. There is no guess for an unknown catalog. The advisor uses your chosen primary model and its thinking level, requires billable-call consent, and only considers listed or already-selected manual model IDs. Review the reasons, check the suggestions you want, copy them into the form, edit anything, and **Save model roles**. Recommendations do not verify capabilities or prices. Default scope shares only the primary provider’s catalog; “All” explicitly shares other connected provider catalogs with the advisor. Keys, base URLs and learning material are excluded.
5. Optionally run capability tests. Each requires confirmation and may incur a small provider charge. A model ID or successful listing is NOT proof of vision/audio/tools support. A verified badge means only the specific sample operation succeeded, not universal model quality.
6. Add material, preferences and a goal, then generate. Source material is sent to the selected primary provider. **Audio: Auto** includes English-learning lessons only (even with explanations in another language); choose On/Off to override. Subject Auto can identify English after teaching, then build original audio sources by rereading local parts and reusing pinned transcripts—no repeated teaching or transcription. Extra audio OCR is conditional and disclosed before generation; unfinished OCR needs renewed consent on continuation. Missing speech setup retains text while you configure it. Complete audio requires a separate exact-count confirmation; speech text then goes to the selected speech engine/provider. Voice recordings go to the selected transcription provider.

**Gemini audio:** In Speech-to-text, choose **Transcription API → Gemini-native audio**, then save. Your provider/key stay on the same host; a `/v1` base maps to `/v1beta` for audio only. Configure the primary teaching API separately (Aiberm documents Chat Completions for its Gemini model). A user reported a successful `gemini-3.8-flash` native transcription. Automated tests remain local fixtures; broader gateway/token-group compatibility is not established. No paid probe or protocol fallback is automatic. See [setup, limits and evidence](GEMINI-AUDIO.md).

**Native video:** configure its provider/model explicitly, requested sampling (1–24 FPS, default 24), and independent wait limit (30–600 seconds, default 300). No video fallback to STT, stills or another provider runs. Successful receipts feed later English audio without repeating video analysis. All submitted intervals and model-reported coverage do not prove every detail was understood. See [whole-video requirements](URL-SOURCES.md#how-to-configure-whole-video-analysis).

**Thinking level:** Default omits the parameter entirely; it is not the same as None. Responses uses `reasoning: { effort }`; Chat uses `reasoning_effort`. Both use output-token limits that include reasoning tokens. More effort can increase latency/cost or exhaust the output budget. Not every model/gateway supports every setting; unsupported requests fail visibly, without silently downgrading effort or retrying against a different endpoint on HTTP 400. Use Default if unsure. Capability badges are scoped to API mode/thinking level/wait limit (and voice for speech).

**Request wait limit:** under **AI providers → Primary lesson model**, choose 30–600 seconds (default 300 / five minutes), then **Save model roles**. Recognition, necessary preparation notes, teaching, primary capability tests and model advice use this limit per provider HTTP request, including reading the full response body. It does not change thinking or output-token budgets. Transcription/speech retain 100-second limits and discovery 20 seconds. Auto's narrowly allowed missing-endpoint fallback is a separate request with the same limit. A provider/proxy may stop sooner; waiting longer does not guarantee success or prevent charges. Timeout reports show the actual limit and whether response headers had arrived. No automatic timeout retry occurs. Keep the page open and use **Continue generation** with renewed consent; only unfinished work uses the new settings, not retained successful preparation. These settings and checkpoints remain session-only.

**Preparation notes:** 2,200 characters is a compactness target, not a reason to discard otherwise valid modestly longer output. Model notes up to 8,000 decoded UTF-16 code units are retained without clipping (existing outer whitespace trimming still applies). Larger/malformed/incomplete results fail explicitly; they are never silently repaired or replayed. Text-only inputs up to 2,200 characters still bypass model rewriting entirely. See [API boundaries](API-CONTRACT.md#post-apimaterialssummarize).

**Editing a connection:** use its Edit button. A blank key retains the saved key only when the base URL is unchanged. Changing the URL requires re-entering a key for a remote provider, so credentials are not silently transferred to another endpoint. Changing the endpoint/key clears discovery results and checks, while keeping model IDs as editable, unverified selections.

**Endpoint compatibility, not branding, is the contract.** Providers differ in models, fields, supported image inputs and output formats. This release uses ordinary non-streaming JSON messages and requests plain JSON lesson output rather than requiring provider-specific structured-output features. The server validates the returned schema; invalid output fails safely without rendering arbitrary HTML.

**Audio caveat:** this release implements `/audio/speech`, not OpenAI-specific Live, Realtime, or Chat Completions audio-output protocols. A current direct-OpenAI model that only supports Realtime is NOT usable as the speech role merely because it appears in `/models`. Choose a compatible speech provider/model; otherwise leave audio disabled. Do not select deprecated models just to work around endpoint compatibility. A failed speech request preserves the text lesson and reports missing audio honestly.

## Built-in natural speech

**`npm start` starts built-in Kokoro automatically, without Docker or Python, and preselects it for new sessions. Learners do not install a speech service, configure its URL or provide a speech API key.** The Node/ONNX CPU runtime uses a pinned, checksum-verified local model, performs real warmup before declaring readiness, and runs on an authenticated private loopback port. Native US/UK English voices are supported. The complete-audio inventory currently targets English/Latin-script text, even when the chosen provider supports other languages. The older Python Docker package remains available as an alternative.

See [KOKORO.md](KOKORO.md) for the learner flow and deployment architecture. This is server-side synthesis, not a large model inside each browser or HTML file. Synthesis runs locally after packaging; remote primary-model generation still needs connectivity. Successful audio from either method is embedded in the exported lesson. A Kokoro failure preserves the text lesson and **never silently switches to cloud speech**. The native engine's initial voice is English `af_heart`. Native output is PCM WAV internally; complete-mode audio is locally encoded to compact MP3 using the already-managed media tools, with no separate FFmpeg installation. See [coverage, recovery and quotas](FULL-AUDIO.md).

## Online app, offline lessons

Generation needs internet. The downloaded lesson does not. Offline capabilities include reading, original screenshots, revealing answers, and playing embedded audio at different speeds. Follow-up AI questions, generating new audio or transcribing a recording require the online app and are not available inside the downloaded file.

The app can be hosted behind HTTPS and used from modern desktop/tablet/mobile browsers. Microphone recording requires HTTPS (localhost is a browser exception), permission and MediaRecorder support; audio file upload is the fallback. Mobile operating systems differ in how they open downloaded HTML: use an actual browser, not a file-manager preview, for scripts and audio. Very slow playback is pitch-preserving where the browser supports it, but can sound less natural than normal-speed speech.

### Hosted private beta

Use [VPS.md](VPS.md) for the recommended **Docker-free native deployment with tmux**. Run a single instance behind an HTTPS reverse proxy; native speech starts automatically. Public deployment has **not** been performed automatically. The optional Dockerfile remains available but is not required.

Set environment variables (see `.env.example`):

```text
HOST=127.0.0.1
PORT=3210
PUBLIC_ORIGIN=https://learnlens.your-domain.example
LEARNLENS_ACCESS_PASSWORD=<unique-random-secret-at-least-16-characters>
```

A public bind requires both an HTTPS origin and access password. Never expose the Node HTTP port directly to the internet. Put an HTTPS reverse proxy in front and preserve the original `Host` header. Terminate TLS at the proxy; set upload limits to at least 13 MB and upstream read timeouts appropriately for model/audio generation (primary requests can wait up to ten minutes per HTTP attempt; narrow Auto fallback can add a separate attempt). Use edge rate limiting as well.

Example Docker commands (create `.env` yourself with real values, do not commit it):

```sh
docker build -t learnlens .
docker run --env-file .env -e HOST=0.0.0.0 -p 127.0.0.1:3210:3210 --name learnlens learnlens
```

Example Caddy site, running on the host:

```caddyfile
learnlens.your-domain.example {
    reverse_proxy 127.0.0.1:3210
}
```

For the normal native deployment, run `npm start` inside your tmux session. No separate speech process command is needed. tmux survives SSH disconnects, not reboots/crashes; it is not an auto-restarting service manager.

Hosted mode uses a shared access password for a small trusted beta, **not a full user-account system**. Each browser gets its own HttpOnly/SameSite/Secure cookie, random CSRF token, providers, roles and keys. Other browsers cannot read them. The same learner on another device must configure their providers again. Restarting the server clears everything. Scaling across instances needs sticky sessions or, preferably, a properly secured shared session store.

Before broad public launch: replace the shared password with real authentication, add per-account quotas/billing, abuse prevention, durable encrypted preferences, privacy/consent flows for minors, monitoring with data redaction, backups as appropriate, curriculum-specific evaluations and deployment security review.

### Security and privacy

- API keys are write-only and held **only in server memory**. They are not returned by `/api/state`, logged, placed in localStorage or embedded in HTML. The app host necessarily has access to in-memory keys; use a trusted host and limited-scope provider keys.
- Browser sessions expire after one hour idle or twelve hours total; clear session removes user providers and keys and, in the bundled package, restores the included speech default. Expired sessions require reload/reconfiguration. In-flight provider requests are not undone by clearing a session or closing the browser.
- Uploaded originals and prepared parts temporarily use private host OS storage; removal, logout, expiry and normal shutdown clean them up. Hard crashes can leave temporary directories requiring operator/OS cleanup. Keys remain memory-only. Exports can contain private source text/images; share carefully. Provider retention policies still apply.
- State-changing requests require same-origin checks and an unpredictable session token. API keys never go directly from browser to AI providers after setup.
- Redirects from providers are not followed. In hosted mode only public HTTPS provider destinations are permitted; all resolved addresses are checked and the selected address is pinned to the outbound TLS connection. User-configured private/local provider access is available only in local mode. The sole hosted exception is the managed internal Kokoro worker (or an explicit advanced operator override); browser input cannot choose or override its private destination.
- Model content is untrusted. Only validated lesson JSON is rendered; every text value is escaped. Exported files have a restrictive CSP and no network connections. Preview uses a sandboxed iframe without same-origin permission.
- The app automatically splits uploads into 4 MB transfers, PDF into three-page ranges, Office text into roughly 20k-character parts, and media into three-minute audio parts. Final model input remains bounded to 40,000 characters and 5 images (4 MB each / 8 MB combined); per-request audio remains at most 8 MB. Host storage/CPU quotas still apply; see [IMPORTS.md](IMPORTS.md). Complete audio is not limited to eight clips: it uses bounded session plans (128 MiB compressed audio per plan, plus metadata/markup/export limits). Older direct API clients retain the eight-line/12 MiB sample path only; see [FULL-AUDIO.md](FULL-AUDIO.md). One AI job per session, eight globally, two local processors and 200 sessions max.
- Natural narration is clearly AI-generated. Transcription does **not** establish pronunciation quality. No phoneme-scoring claims are made.

## Architecture

```text
Browser: material + preferences
  → Session-isolated Node API
  → Provider adapter (Responses / Chat Completions)
  → AI classifies, plans and writes LessonSpec JSON
  → Schema and size validation
  → Retain text lesson + complete source/lesson audio inventory
  → Exact-count consent → resumable clips → local MP3 encoding
  → Deterministic trusted HTML renderer
  → Sandboxed preview + offline download
```

The teaching composition is dynamic, but execution is deliberately bounded. The AI chooses section types, order, examples and explanations; it cannot create arbitrary executable workflows. Small inputs use one final generation call; larger inputs may first use multiple consented transcription/digest calls and hierarchical merging. This is not a separate independent reviewer or factual-verification guarantee. Successful preparation is cached in-page for retries; failed/unknown paid requests are not automatically retried.

```text
server.mjs           HTTP/session/security/routes
lib/provider.mjs     Provider adapters, discovery, probes, media validation
lib/lesson.mjs       Input validation, tutor prompt, lesson schema, demo
lib/setup.mjs        Bounded recommendation catalog, validation, starter rule
deploy/              Native startup/cache/worker; optional Docker speech startup
lib/audio-*.mjs      Source recognition, private audio plans, managed encoding
lib/speech-inventory.mjs  Stable complete word/sentence targets and clip splitting
lib/render.mjs       Escaped standalone HTML and offline interactions
public/              Responsive UI (vanilla ES modules, CSS, HTML)
tests/               Local mock-provider integration and unit tests
API-CONTRACT.md      Endpoint and LessonSpec documentation
```

## Next increments

1. XLSX extraction, richer Office visual rendering and better document-layout preservation. PDF/DOCX/PPTX and the requested audio/video formats are now accepted, with documented limitations.
2. Stronger math typesetting, trusted diagram/plot widgets, and accessibility/localization testing.
3. Current provider-specific audio adapters (Realtime/Chat audio) behind the same speech-role interface.
4. Lesson revision and clarification turns, curriculum alignment, calibrated source/answer checking.
5. Accounts and encrypted cross-device preferences/library with deletion controls.
6. Proper audio-aware pronunciation assessment and live tutoring, evaluated separately from transcription.

There is no guarantee that AI understands every screenshot or teaches every subject correctly. Unclear images should be recaptured; important facts and worked solutions should be checked with a teacher or authoritative source.
