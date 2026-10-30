# LearnLens

**See it. Hear it. Understand it.**

A responsive, bring-your-own-provider web app that turns screenshots, questions and source text into a downloadable, self-contained HTML lesson. This is the first working prototype, not a certified educational assessment system.

## Run locally

For lightweight development, requires **Node.js 22 or later**. The Node app has no npm runtime dependencies and no frontend build step. For the complete app with built-in Kokoro speech, use the standard Docker package below; it includes and starts the speech runtime automatically.

```sh
cd LearnLens
npm start
```

Open **http://127.0.0.1:3210**. Start with **Try a local example** (a hand-authored demonstration, no API request), or configure your provider to generate a real lesson.

```sh
npm test
npm run check
```

The tests use local mock providers. They do not call paid models or prove the educational quality of a real model. **40 automated tests pass**, plus a Chromium browser smoke suite covering desktop/mobile layouts, provider setup, uploads, transcription, sandboxed preview, real browser download, password gating and offline audio playback. See [TESTING.md](TESTING.md) for reproduction and remaining validation gaps.

## What works in v0.1

- Screenshot/photo input: PNG, JPEG, WebP, including clipboard paste and drag/drop.
- Text, Markdown and TXT material; text/voice learning requests.
- Free-form subjects and AI classification, across primary, junior secondary, high school and college/university. Users can specify subject, level, language and teaching goal.
- Flexible model-chosen lesson composition: explanations, ordered steps, examples, vocabulary, translations, practice with revealable answers, summaries and objectives.
- Built-in OpenAI standard preset (`https://api.openai.com/v1`), editable connections, multiple compatible providers and manual model IDs.
- Primary-model thinking level: Default, None, Minimal, Low, Medium, High, Extra high or Maximum, subject to model support.
- Optional primary-model setup advisor: reviewed suggestions with reasons, never silently saved or treated as capability verification.
- Explicit model listing and opt-in **billable** text, vision and speech capability tests.
- Separate primary, transcription and speech model roles. Same provider/model may serve several roles when supported.
- Responses API with narrowly scoped Chat Completions fallback, or explicit endpoint mode.
- Voice request recording/upload and transcription through `/audio/transcriptions`. Transcribed text is editable before lesson creation.
- Two speech methods: an online/compatible AI provider or the included Kokoro engine in the standard package via `/audio/speech`. Successful audio is embedded in the lesson with 1×, 0.75× and 0.5× playback. No browser speech-synthesis fallback. Voice quality depends on provider/model/language; listen to verify.
- Downloaded HTML includes its own CSS, trusted interaction script, source images and successfully generated audio. No CDN, font download, API connection or API key is required to open it offline.
- Responsive browser interface; separate in-memory state and credentials for each browser session.

## Choose models

| Role | Requirement | When needed |
|---|---|---|
| Primary | Text generation and image understanding for screenshots; able to follow a JSON schema prompt | Always |
| Transcription | OpenAI-compatible multipart `/audio/transcriptions` | Voice input |
| Speech | OpenAI-compatible `/audio/speech`, binary audio response, a voice supported by the provider | Lesson audio |

That means **one required role and two optional roles**, not necessarily three distinct models. Embeddings, live voice and multi-agent orchestration are not needed for the first document-to-lesson flow.

1. Start with the **OpenAI standard** preset or choose **Custom**. The base URL remains editable; enter the key belonging to that destination. Example: `https://api.openai.com/v1`, or `https://your-gateway.example/api/v1`.
2. Use **Discover models** to query `{baseURL}/models`. This does not run inference. A provider without this endpoint can still work: enter model IDs manually.
3. Assign models to roles. For primary, select **Auto**, **Responses** or **Chat Completions**. Auto tries Responses first and falls back only on HTTP 404, 405 or 501. It never retries authorization, quota or generic server errors against a different endpoint.
4. If unsure, click **Use a starter primary** (when available), then **Ask primary to suggest models**. The starter is a transparent catalog-based rule: prefer matching text/vision sample checks, otherwise `gpt-5.4-mini` only if that exact ID is listed. There is no guess for an unknown catalog. The advisor uses your chosen primary model and its thinking level, requires billable-call consent, and only considers listed or already-selected manual model IDs. Review the reasons, check the suggestions you want, copy them into the form, edit anything, and **Save model roles**. Recommendations do not verify capabilities or prices. Default scope shares only the primary provider’s catalog; “All” explicitly shares other connected provider catalogs with the advisor. Keys, base URLs and learning material are excluded.
5. Optionally run capability tests. Each requires confirmation and may incur a small provider charge. A model ID or successful listing is NOT proof of vision/audio/tools support. A verified badge means only the specific sample operation succeeded, not universal model quality.
6. Add material, preferences and a goal, then generate. Source material is sent to the selected primary provider. Requested audio scripts go to the selected speech provider. Voice recordings go to the selected transcription provider.

**Thinking level:** Default omits the parameter entirely; it is not the same as None. Responses uses `reasoning: { effort }`; Chat uses `reasoning_effort`. Both use output-token limits that include reasoning tokens. More effort can increase latency/cost or exhaust the output budget. Not every model/gateway supports every setting; unsupported requests fail visibly, without silently downgrading effort or retrying against a different endpoint on HTTP 400. Use Default if unsure. Capability badges are scoped to API mode/thinking level (and voice for speech).

**Editing a connection:** use its Edit button. A blank key retains the saved key only when the base URL is unchanged. Changing the URL requires re-entering a key for a remote provider, so credentials are not silently transferred to another endpoint. Changing the endpoint/key clears discovery results and checks, while keeping model IDs as editable, unverified selections.

**Endpoint compatibility, not branding, is the contract.** Providers differ in models, fields, supported image inputs and output formats. This release uses ordinary non-streaming JSON messages and requests plain JSON lesson output rather than requiring provider-specific structured-output features. The server validates the returned schema; invalid output fails safely without rendering arbitrary HTML.

**Audio caveat:** this release implements `/audio/speech`, not OpenAI-specific Live, Realtime, or Chat Completions audio-output protocols. A current direct-OpenAI model that only supports Realtime is NOT usable as the speech role merely because it appears in `/models`. Choose a compatible speech provider/model; otherwise leave audio disabled. Do not select deprecated models just to work around endpoint compatibility. A failed speech request preserves the text lesson and reports missing audio honestly.

## Built-in natural speech

**Kokoro is included in the standard Docker package and preselected for new sessions. Learners do not install a speech service, configure its URL, download a model or provide a speech API key.** The package contains the CPU runtime/model/voices, warms the English voice at build time, and starts the private worker automatically before the app. Online speech providers remain optional.

See [KOKORO.md](KOKORO.md) for the learner flow and deployment architecture. This is server-side synthesis, not a large model inside each browser or HTML file. Synthesis runs locally after packaging; remote primary-model generation still needs connectivity. Successful audio from either method is embedded in the exported lesson. A Kokoro failure preserves the text lesson and **never silently switches to cloud speech**. Voice/language coverage varies; the initial voice is English `af_heart`.

## Online app, offline lessons

Generation needs internet. The downloaded lesson does not. Offline capabilities include reading, original screenshots, revealing answers, and playing embedded audio at different speeds. Follow-up AI questions, generating new audio or transcribing a recording require the online app and are not available inside the downloaded file.

The app can be hosted behind HTTPS and used from modern desktop/tablet/mobile browsers. Microphone recording requires HTTPS (localhost is a browser exception), permission and MediaRecorder support; audio file upload is the fallback. Mobile operating systems differ in how they open downloaded HTML: use an actual browser, not a file-manager preview, for scripts and audio. Very slow playback is pitch-preserving where the browser supports it, but can sound less natural than normal-speed speech.

### Hosted private beta

The default Dockerfile bundles both the Node app and Kokoro speech in one container; no separate speech-service setup is required. The image is larger and needs a persistent CPU/RAM allocation. Public deployment has **not** been performed automatically. You need a host and domain/TLS certificate.

Set environment variables (see `.env.example`):

```text
HOST=0.0.0.0
PORT=3210
PUBLIC_ORIGIN=https://learnlens.your-domain.example
LEARNLENS_ACCESS_PASSWORD=<unique-random-secret-at-least-16-characters>
```

A public bind requires both an HTTPS origin and access password. Never expose the Node HTTP port directly to the internet. Put an HTTPS reverse proxy in front and preserve the original `Host` header. Terminate TLS at the proxy; set upload limits to at least 13 MB and upstream read timeouts appropriately for model/audio generation (several minutes). Use edge rate limiting as well.

Example Docker commands (create `.env` yourself with real values, do not commit it):

```sh
docker build -t learnlens .
docker run --env-file .env -p 127.0.0.1:3210:3210 --name learnlens learnlens
```

Example Caddy site, running on the host:

```caddyfile
learnlens.your-domain.example {
    reverse_proxy 127.0.0.1:3210
}
```

Alternatively run Node directly: `node --env-file=.env server.mjs`.

Hosted mode uses a shared access password for a small trusted beta, **not a full user-account system**. Each browser gets its own HttpOnly/SameSite/Secure cookie, random CSRF token, providers, roles and keys. Other browsers cannot read them. The same learner on another device must configure their providers again. Restarting the server clears everything. Scaling across instances needs sticky sessions or, preferably, a properly secured shared session store.

Before broad public launch: replace the shared password with real authentication, add per-account quotas/billing, abuse prevention, durable encrypted preferences, privacy/consent flows for minors, monitoring with data redaction, backups as appropriate, curriculum-specific evaluations and deployment security review.

### Security and privacy

- API keys are write-only and held **only in server memory**. They are not returned by `/api/state`, logged, placed in localStorage or embedded in HTML. The app host necessarily has access to in-memory keys; use a trusted host and limited-scope provider keys.
- Browser sessions expire after one hour idle or twelve hours total; clear session removes user providers and keys and, in the bundled package, restores the included speech default. Expired sessions require reload/reconfiguration. In-flight provider requests are not undone by clearing a session or closing the browser.
- Lesson input/output is transient on the server. Exported lessons can contain private original images/text; share them carefully. Provider retention policies still apply.
- State-changing requests require same-origin checks and an unpredictable session token. API keys never go directly from browser to AI providers after setup.
- Redirects from providers are not followed. In hosted mode only public HTTPS provider destinations are permitted; all resolved addresses are checked and the selected address is pinned to the outbound TLS connection. User-configured private/local provider access is available only in local mode. The sole hosted exception is the fixed internal Kokoro worker (or an explicit advanced operator override); browser input cannot choose or override its private destination.
- Model content is untrusted. Only validated lesson JSON is rendered; every text value is escaped. Exported files have a restrictive CSP and no network connections. Preview uses a sandboxed iframe without same-origin permission.
- Inputs are bounded: 40,000 text characters; 5 images at most, 4 MB each / 8 MB combined; recordings at most 8 MB; HTTP request at most 13 MB. Generated audio is capped at 8 lines and 12 MB total embedded audio. One AI job per session, eight across the instance; 200 browser sessions max.
- Natural narration is clearly AI-generated. Transcription does **not** establish pronunciation quality. No phoneme-scoring claims are made.

## Architecture

```text
Browser: material + preferences
  → Session-isolated Node API
  → Provider adapter (Responses / Chat Completions)
  → AI classifies, plans and writes LessonSpec JSON
  → Schema and size validation
  → Optional speech synthesis
  → Deterministic trusted HTML renderer
  → Sandboxed preview + offline download
```

The teaching composition is dynamic, but execution is deliberately bounded. The AI chooses section types, order, examples and explanations; it cannot create arbitrary executable workflows. The first version uses one primary generation call, not a separate multi-agent reviewer or a claim of independent factual verification.

```text
server.mjs           HTTP/session/security/routes
lib/provider.mjs     Provider adapters, discovery, probes, media validation
lib/lesson.mjs       Input validation, tutor prompt, lesson schema, demo
lib/setup.mjs        Bounded recommendation catalog, validation, starter rule
deploy/              Bundled speech startup, build warmup and offline smoke test
lib/render.mjs       Escaped standalone HTML and offline interactions
public/              Responsive UI (vanilla ES modules, CSS, HTML)
tests/               Local mock-provider integration and unit tests
API-CONTRACT.md      Endpoint and LessonSpec documentation
```

## Next increments

1. PDF, DOCX, PPTX and XLSX extraction with page/slide/sheet provenance. These formats are **not yet accepted**; screenshot the material for now.
2. Stronger math typesetting, trusted diagram/plot widgets, and accessibility/localization testing.
3. Current provider-specific audio adapters (Realtime/Chat audio) behind the same speech-role interface.
4. Lesson revision and clarification turns, curriculum alignment, calibrated source/answer checking.
5. Accounts and encrypted cross-device preferences/library with deletion controls.
6. Proper audio-aware pronunciation assessment and live tutoring, evaluated separately from transcription.

There is no guarantee that AI understands every screenshot or teaches every subject correctly. Unclear images should be recaptured; important facts and worked solutions should be checked with a teacher or authoritative source.
