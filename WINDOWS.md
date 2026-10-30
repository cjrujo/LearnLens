# Windows: LearnLens with built-in speech, without Docker

## First setup

1. Install **Node.js 22.x (22.9 or newer)** and Git if absent. Use the x64 build on an x64 PC. No Python, Docker, GPU or separate eSpeak installation is needed.
2. Open PowerShell in a directory where you keep projects:

   ```powershell
   git clone https://github.com/cjrujo/LearnLens.git
   cd LearnLens
   npm.cmd ci
   npm.cmd start
   ```

   If you already have a checkout, open that directory instead; do not clone over it. `npm.cmd` avoids PowerShell's `npm.ps1` execution-policy restriction without changing your security policy. In Command Prompt or Git Bash, plain `npm` works too.
3. First start downloads a pinned, SHA-256-verified Q8 model (about 92 MB) into `.cache/speech/`, checks the installed voices/phonemizer, and performs real speech warmup. npm dependencies require additional disk/downloads. Later starts reuse those files.
4. Wait for **LearnLens ready at http://127.0.0.1:3210**, then open that address. Native Kokoro should already be selected under **AI providers**.

No speech URL or speech API key is needed. The native engine supports **English US/UK voices**; default `af_heart`. Other languages require an explicitly selected online speech provider. There is no automatic paid fallback.

## Testing

- **Try a local example** checks the interface without a cloud key. That demo does not itself synthesize speech.
- The Kokoro speech capability test uses local synthesis, with explicit sample consent.
- To create an AI-written lesson, configure a primary model and consent to any provider charges. Turn on spoken examples to include local narration.
- Download the HTML and open it offline in a real browser; successful audio and answer controls travel with it.
- For a developer test with a hand-authored lesson fixture and **real native speech**, run `npm.cmd run test:native` after setup. It creates `artifacts/native-offline-lesson.html` and `artifacts/native-speech.wav`, without calling a cloud model.

## Settings and shutdown

No `.env` is needed for local use. To customize settings, copy `.env.example` to `.env` and edit it locally; do not commit it. `npm start` loads the repository-root file automatically; existing shell variables take precedence.

```dotenv
HOST=127.0.0.1
PORT=3210
# Require already-cached assets, with no startup downloads:
# LEARNLENS_SPEECH_OFFLINE=1
# Explicitly turn off managed speech:
# LEARNLENS_SPEECH_MODE=disabled
```

`npm.cmd run setup:speech` prepares/verifies/warms speech without leaving the app running. Keep `.cache/speech/` between restarts. Never expose the speech worker's private, authenticated loopback port.

Stop with **Ctrl+C** in the app terminal. Restart with `npm.cmd start`. Restarting clears session-only providers, keys and settings. This is a local foreground app, not a Windows service; closing its terminal or rebooting stops it.

For updates, stop the old process, then run each command only if the preceding one succeeds:

```powershell
git pull --ff-only
npm.cmd ci
npm.cmd run setup:speech
npm.cmd start
```

Do not reset local changes if Git refuses the update.

## Troubleshooting

- **Address already in use**: stop the previous LearnLens process, or choose another `PORT`. Do not kill unrelated Node processes.
- **Missing/damaged assets while offline**: temporarily unset `LEARNLENS_SPEECH_OFFLINE`, connect to the internet, and run `npm.cmd run setup:speech`. Do not bypass checksums.
- **Native DLL load failure**: verify Node/CPU architecture and `npm.cmd ci`. Some clean Windows installations may need Microsoft's official Visual C++ Redistributable matching the architecture. Do not download individual DLLs from third-party sites. A clean Windows installation without that prerequisite has not been verified.
- **Slow synthesis**: keep one app instance, use shorter text and review available RAM. `LEARNLENS_SPEECH_THREADS` defaults to 2 (allowed 1–8); more threads are not automatically faster.
- **Without local speech**: `npm.cmd run start:lite` is the lightweight developer entrypoint, or use `LEARNLENS_SPEECH_MODE=disabled` with normal startup.

This local URL is for this PC only. For public HTTPS deployment and tmux, see [VPS.md](VPS.md). Remote primary-model generation still needs internet; local synthesis can work from its cache and downloaded HTML works offline.
