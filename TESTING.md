# LearnLens verification

## Automated checks

From the project directory, with Node.js 22+:

```sh
npm test
npm run check
```

Latest local result: **40/40 tests passed**; server, adapter, schema, renderer and frontend syntax checks passed.

Coverage includes browser-session isolation, secret redaction, model discovery versus explicit paid probes, Responses/Chat request formats, narrow fallback rules, valid/invalid image input, body/media limits, missing/failed speech, transcription multipart encoding, untrusted output escaping, export CSP, authorization/CSRF, public IP policy, and hosted configuration guards. Additional setup tests cover reasoning fields/omission for both APIs, unsupported-effort failure without downgrade, recommendation consent/privacy/scope/candidate validation, no silent role saving, provider-edit key transfer protection, and managed Kokoro authorization/routing/failures.

Regression tests specifically hold an upload or model response open, clear the session, and verify that stale work cannot repopulate settings, return a lesson, or start subsequent speech calls. A concurrent AI job is rejected before reaching the provider.

## Browser smoke suite

Start a **disposable** Chrome/Chromium instance with remote debugging on loopback port 9333. Do not use your everyday profile. For example, in Git Bash on Windows:

```sh
"C:/Program Files/Google/Chrome/Application/chrome.exe" \
  --headless=new --disable-gpu --no-first-run --no-default-browser-check \
  --remote-debugging-port=9333 \
  --user-data-dir="C:/Users/Wesley/LearnLens/artifacts/chrome-qa" about:blank
```

Keep that process running, then in a second terminal:

```sh
cd C:/Users/Wesley/LearnLens
npm run test:browser
```

Adjust the Chrome executable and disposable profile path for your OS. Remote debugging grants browser control: never expose this port publicly. Stop the disposable Chrome process after testing.

The test starts its own app and mock provider on ephemeral loopback ports, opens an isolated browser context, and closes its tabs/servers afterward. No app already running on port 3210 is needed. No real API keys or paid calls are used.

Latest result: **passed on Windows / Node 22.23.1 / Chromium 155**.

Verified:

- Desktop (1440 px) and mobile-emulated layouts (390 px and 320 px), no horizontal overflow.
- Local example, sandboxed iframe content, and inability of the iframe to read the parent app DOM.
- OpenAI preset and editable base URL, provider discovery, catalog-based starter primary.
- Consented model advisor using the chosen thinking level; suggestions remain unsaved, selected suggestions fill only the draft, and users can modify fields before saving.
- Three role assignments and explicitly consented vision probe.
- Screenshot and Markdown uploads, consented audio-file transcription into editable notes.
- Lesson generation with embedded source image and a WAV test clip.
- Built-in speech preselected before any learner configuration, optional switch to online speech and back, voice default, explicit local probe, and routing without a cloud fallback. Browser-level speech services are mocks.
- Actual Download HTML action; downloaded bytes equal the preview document.
- Provider failure keeps the draft and allows reopening the preceding lesson.
- Password-gate login and session clearing.
- Downloaded file reopened with Chromium networking disabled: answer reveal, decoded audio metadata, 0.5× speed retained through audio reload, audio playback advancing, and no HTTP(S) resource requests.
- No unexpected JavaScript/CSP/resource errors. The deliberate provider failure emits one expected HTTP 502 console entry.

Screenshots and downloaded files are under `artifacts/` (git-ignored). Browser fixtures are in `tests/browser-fixtures.mjs`; the test audio is an artificial tone, **not natural-voice narration**.

## Real bundled speech container

`.github/workflows/bundled-speech.yml` is a manually triggered packaging check. It builds the complete image, starts it with `--network none`, exercises the included default speech role and probe, synthesizes a real English MP3 clip, and verifies embedding in HTML. Docker is unavailable on the local Windows machine; the remote workflow outcome will be recorded after verification.

## Not yet verified

- Real cloud providers, actual model availability/cost, educational accuracy, handwriting/equation comprehension, and natural speech quality in requested languages.
- Real microphone hardware/permission behavior. Audio-file upload/transcription is browser-tested; MediaRecorder capture and cleanup need physical-device testing.
- Safari/iOS, Android browsers, Firefox and physical tablets. Responsive emulation is not a claim of universal device compatibility. Opening local HTML varies by mobile OS; some file previews do not run JavaScript.
- End-to-end public HTTPS/reverse-proxy deployment, production DNS/TLS networking, multi-instance operation, load testing, and a full independent security/accessibility audit.
- PDF/Office document extraction, advanced typeset mathematics, generated diagrams, live voice and pronunciation scoring (not implemented).

The hosted tests simulate the proxy’s Host/Origin headers and inspect secure-cookie behavior; they do not establish that a real domain or TLS deployment is running.
