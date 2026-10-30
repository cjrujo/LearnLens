# LearnLens verification

## Automated checks

From the project directory, with Node.js 22.13+ (run `npm ci` first):

```sh
npm test
npm run check
```

Latest import release checks: **100 passed, 0 failed, 1 optional media test skipped** in the regular suite. The real managed-media suite separately passed **17/17** with offline caches. Server, adapters, import modules and frontend syntax checks passed.

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
- Unified screenshot/Markdown/WAV, five-page PDF, >35k-character DOCX, six-slide PPTX, MP3/MP4/WebM and native browser MediaRecorder input. All pages/parts enter preparation; instructions are never overwritten. No AI calls occur during upload/preview or cancelled consent.
- Lesson generation with embedded source image and a WAV test clip.
- Built-in speech preselected before any learner configuration, optional switch to online speech and back, voice default, explicit local probe, and routing without a cloud fallback. Browser-level speech services are mocks.
- Actual Download HTML action; downloaded bytes equal the preview document.
- Provider failure preserves attachments/instructions and the preceding lesson. Explicit retry reuses successful cached paid preparation instead of repeating it.
- Password-gate login and session clearing.
- Downloaded file reopened with Chromium networking disabled: answer reveal, decoded audio metadata, 0.5× speed retained through audio reload, audio playback advancing, and no HTTP(S) resource requests.
- No unexpected JavaScript/CSP/resource errors. The deliberate provider failure emits one expected HTTP 502 console entry.

Screenshots and downloaded files are under `artifacts/` (git-ignored). Browser fixtures are in `tests/browser-fixtures.mjs`; their audio is an artificial tone, **not natural-voice narration**. The optional `LEARNLENS_NATIVE_LESSON=artifacts/native-offline-lesson.html` browser check additionally opens actual native Kokoro output, decodes/plays it with networking disabled, checks all three speeds through media reload and exercises answers. That real-WAV check also passed on Windows/Chromium.

## Real document/media import verification

The regular suite adds malformed provider wire responses/SSE, document signatures/ZIP paths/CRC/expansion/XML limits, actual PDF ranges, Office relationships/order/notes, isolated parser deadlines/cancellation, Unicode splitting, idempotent upload replay, ownership/logout cleanup and paid-digest consent/stale-setup regressions.

```sh
npm run setup:media
LEARNLENS_MEDIA_OFFLINE=1 LEARNLENS_MEDIA_INTEGRATION=1 npm run test:media
LEARNLENS_MEDIA_OFFLINE=1 LEARNLENS_MEDIA_INTEGRATION=1 npm run test:browser
```

PowerShell: set those environment variables with `$env:NAME='1'` before the npm command. The browser script can serve a staged coherent UI using `LEARNLENS_TEST_UI=artifacts/import-ui`; normally it tests `public/`.

Main-agent Windows rerun passed the full staged browser suite with real MP3/MP4/WebM/PDF/DOCX/PPTX on 2026-10-31 (UTC+8). A 251.25-second synthetic MP3 yielded 0–180 and 180–251.25 segments with exactly 251.25 seconds of decoded audio. The native MediaRecorder fixture is a one-second oscillator, not microphone audio. Silent video works without a transcription role. Full media extraction does not call any provider; teaching/transcription integration uses loopback fixtures only.

`.github/workflows/material-imports.yml` provides separate Windows/Linux real-engine checks; Linux uses an OS network namespace after cache preparation. Import-release Linux results are recorded after that workflow completes; prior speech CI does not verify the new media engine. Local evidence: `artifacts/import-browser-recovery.log`, `artifacts/native-media-verified.log`.

## Docker-free native speech

Local Windows / Node 22.23.1 x64: **PASS**. `npm ci`/install resolved native dependencies; `npm run setup:speech` downloaded and SHA-256-verified the pinned ~92 MB Q8 model and synthesized a real warmup. `npm run test:native` restarted from cache with downloads forbidden, tested automatic default selection and the consented probe, exercised the full lesson API against a loopback hand-authored lesson fixture with **real Kokoro WAV synthesis**, embedded a 248,444-byte WAV, and verified logout restores the default. No cloud primary/speech service was called. Output: `artifacts/native-offline-lesson.html` and `artifacts/native-speech.wav`.

Native unit coverage includes private token/Host/Origin enforcement, supported voice/script/format/size bounds, serialized/bounded inference, worker credential isolation, checksum failure/atomic writes/offline cache refusal, complete long-text splitting, IPC lifecycle, app shutdown on worker failure, safe hosting validation and explicit speech opt-out. `npm audit --omit=dev` reports zero known vulnerabilities at verification; `sharp` is pinned to patched 0.35.5.

`.github/workflows/native-speech.yml` performs native Windows/Linux checks; its Linux smoke runs in a network namespace with no external networking. **Both Windows and Linux passed** at commit `52617f4`: [native CI run 41018769895](https://github.com/cjrujo/LearnLens/actions/runs/41018769895). Each ran 51 tests, dependency audit, native setup and real synthesis/export; Linux completed the full API smoke with external networking disabled at the OS network-namespace level. The run publishes demonstration HTML/WAV artifacts for seven days. No actual user VPS, public TLS proxy or clean Windows installation missing VC++ runtime has been tested. Native voice coverage is English only; perceptual naturalness/all voices are not established by successful audio generation.

## Real optional Docker speech container

`.github/workflows/bundled-speech.yml` is a manually triggered packaging check. It builds the complete image, starts it with `--network none`, exercises the included default speech role and probe, synthesizes a real English MP3 clip, and verifies embedding in HTML. Docker is unavailable on the local Windows machine, so the real container was verified on GitHub Actions (Linux amd64): **PASS**, [run 41001150719](https://github.com/cjrujo/LearnLens/actions/runs/41001150719), commit `8001cf6`.

Evidence: image build synthesized a 142,774-byte WAV while populating caches. With external networking disabled, the packaged app started, preselected speech without a cloud provider, passed the speech probe, generated a real 61,868-byte MP3 and embedded it in standalone HTML. This proves the packaged English synthesis path, not perceptual naturalness, every voice/language, arm64 execution or public deployment.

## Not yet verified

- Real cloud providers, actual model availability/cost, educational accuracy, handwriting/equation comprehension, and natural speech quality in requested languages.
- Real microphone hardware/permission behavior. Native MediaRecorder was exercised using an oscillator-backed stream without microphone permission; physical-device behavior remains unverified.
- Safari/iOS, Android browsers, Firefox and physical tablets. Responsive emulation is not a claim of universal device compatibility. Opening local HTML varies by mobile OS; some file previews do not run JavaScript.
- End-to-end public HTTPS/reverse-proxy deployment, production DNS/TLS networking, multi-instance operation, load testing, and a full independent security/accessibility audit.
- Full Office visual/layout rendering, advanced typeset mathematics, generated diagrams, live voice and pronunciation scoring. Import fixtures do not establish correctness for every document/codec.

The hosted tests simulate the proxy’s Host/Origin headers and inspect secure-cookie behavior; they do not establish that a real domain or TLS deployment is running.
