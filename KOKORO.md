# Built-in Kokoro — no Docker required

`npm start` now starts **native Node/ONNX Kokoro and LearnLens together** on Windows or a Linux VPS. Learners do not install a speech service, enter its URL, download a model themselves or provide a speech API key. Docker remains an optional alternative, not a requirement.

## Normal startup

Requires Node 22.9+ and project dependencies:

```sh
npm ci
npm start
```

The first start prepares a pinned Q8 model (about 92 MB) in `.cache/speech/`, verifies every model/tokenizer file with SHA-256, loads the installed voices/phonemizer, and synthesizes a warmup before starting the app. npm dependencies take additional space/downloads. No Python, GPU, FFmpeg or system-wide eSpeak installation is needed. Some clean Windows systems may need Microsoft's official VC++ runtime for the native ONNX binary; see [WINDOWS.md](WINDOWS.md).

To prepare the cache separately:

```sh
npm run setup:speech
```

Subsequent starts verify/reuse it. `LEARNLENS_SPEECH_OFFLINE=1` explicitly forbids asset downloads and fails clearly if a cached file is absent or damaged. Inference always disables remote model fetching; it never downloads new voices based on learner requests. The speech model stays on the app server/PC, not in each learner's browser or exported HTML.

See [WINDOWS.md](WINDOWS.md) and [VPS.md](VPS.md) for complete startup, tmux and HTTPS instructions. `.env` is loaded automatically by `npm start` and `setup:speech`; existing shell variables take precedence.

## Learner experience and language limits

1. Connect a primary lesson model for understanding your material.
2. Enable **Add spoken examples**. Built-in speech is already selected.
3. Listen or download the HTML. Successful audio is embedded and works offline at 1×, 0.75× and 0.5×.

**The native JavaScript engine currently supports English US/UK voices only.** Default: `af_heart`; alternatives include `af_bella`, `am_michael` and `bf_emma`. Voice support comes from the pinned package; only specifically tested voices should be considered verified. This is not a claim that other languages are supported merely because the underlying Kokoro model has multilingual variants. Choose an online speech provider for non-English narration. Unsupported voices/scripts fail visibly; Latin-script non-English text cannot always be detected, so choose appropriately.

Native audio is **24 kHz mono PCM WAV**, avoiding an FFmpeg/MP3 encoder dependency. WAV files are larger than MP3; the existing export/audio limits still apply. Online providers and the optional Python container retain their MP3 request behavior. Long native input is split instead of silently truncating narration.

A speech failure preserves the text lesson with a warning. There is **no automatic switch to paid online speech**. Clear-session restores the included default; learners can still explicitly disable speech or select online speech.

## Lifecycle and isolation

- One managed child process, CPU inference serialized through a bounded queue; main app remains responsive.
- Speech binds an ephemeral **127.0.0.1** port and requires a random internal token. It is not a public speech API.
- Host passwords, cloud provider keys and `NODE_OPTIONS` are not inherited by that worker. No user text/audio is cached or logged by LearnLens's speech adapter.
- Readiness is reported through parent/child IPC only after real warmup, not by trusting an arbitrary process already listening on a fixed port.
- Ctrl+C stops the app and worker. A killed parent disconnects IPC and terminates the worker. An unexpected worker exit closes the app; it does not keep advertising a dead service.
- The native adapter has no CORS, browser/player, model upload, cloning, tuning, SSML or filesystem-serving endpoints. Never expose its port through a firewall/proxy.

## Operator controls

| Setting | Purpose |
| --- | --- |
| `LEARNLENS_SPEECH_OFFLINE=1` | Require a complete valid existing model cache. |
| `LEARNLENS_SPEECH_CACHE=/private/path` | Override project-local cache directory; preserve between restarts. |
| `LEARNLENS_SPEECH_THREADS=2` | CPU thread count, allowed 1–8. Measure before tuning. |
| `LEARNLENS_SPEECH_MODE=disabled` | Start the app without managed speech. |
| `KOKORO_VOICE=af_heart` | Initial supported voice. |
| `KOKORO_BASE_URL=...` | Advanced override to an already-managed external service, instead of native startup. |

An external service may also use `KOKORO_MODEL` and `KOKORO_API_KEY`. It is not automatically selected as the included native default. These settings are operator-only; browser input cannot choose a private service URL. `npm run start:lite` is the app-only developer path and does not start speech.

## Optional Docker path

The existing Dockerfile still bundles Kokoro-FastAPI CPU v0.9.1 and Node. It uses `deploy/start.mjs`, not the native Node engine. English assets are warmed during the image build, and runtime downloads are disabled. Inside that container speech is private `127.0.0.1:8880`; only the web app is routed. Native and container language/voice coverage can differ. No Docker installation is required for the normal native path.

## Verification and licensing

`npm test` uses fixtures; `npm run test:native` exercises real native Kokoro with a cached model and a loopback, hand-authored lesson fixture (no cloud model or paid API). It saves `artifacts/native-offline-lesson.html` and `artifacts/native-speech.wav`. The native CI workflow tests Windows/Linux; Linux additionally runs the full smoke test inside a network namespace without external networking. See [TESTING.md](TESTING.md) for recorded outcomes and limitations.

Pinned model: [onnx-community/Kokoro-82M-v1.0-ONNX](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/tree/1939ad2a8e416c0acfeecc08a694d14ef25f2231). Runtime: [kokoro-js](https://github.com/hexgrad/kokoro/tree/664c76a704021239ba59c84dcbaa4d3dece01fe9/kokoro.js), Transformers.js and ONNX Runtime. See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md), including embedded eSpeak licensing/provenance caveats before redistributing binaries.
