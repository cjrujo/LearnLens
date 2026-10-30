# Optional Kokoro speech service

LearnLens supports two independent speech methods:

| Method | Runs where | Network requirement |
|---|---|---|
| AI provider | Your selected provider’s `/audio/speech` service | Usually internet |
| Kokoro | An operator-configured service beside the LearnLens backend | Local network only after all model assets are installed |

Both produce audio embedded in downloaded HTML. Neither bundles the speech model inside the lesson. A cloud lesson model can still be used with local Kokoro narration.

## Local setup

One compatible implementation is [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI). Its README documents `/v1/audio/speech`, `model: "kokoro"`, provider-specific voice IDs, and MP3 output. LearnLens uses those standard fields. Follow that project’s current installation, model-download, hardware, security and license instructions.

For example, its documented CPU image can be run with a **loopback-only** published port:

```sh
docker run --name learnlens-kokoro -p 127.0.0.1:8880:8880 ghcr.io/remsky/kokoro-fastapi-cpu:latest
```

This command downloads a third-party image and may need model assets. It has **not** been run automatically or verified with real synthesis here. For deployment, select and pin a vetted image tag/digest rather than relying on `latest`. Keep the container/model storage persistent according to the service’s documentation; verify offline operation after initial downloads complete.

Start LearnLens with the service location. Git Bash/Linux/macOS:

```sh
KOKORO_BASE_URL=http://127.0.0.1:8880/v1 npm start
```

PowerShell:

```powershell
$env:KOKORO_BASE_URL = 'http://127.0.0.1:8880/v1'
npm start
```

Or put settings in your private `.env` and start with `node --env-file=.env server.mjs`. Do not reuse the hosted example’s HOST/PUBLIC_ORIGIN settings for a local-only installation without adjusting them.

Optional variables:

```text
KOKORO_MODEL=kokoro
KOKORO_VOICE=af_heart
KOKORO_API_KEY=
```

Then in LearnLens:

1. Open AI providers → Natural speech → Speech method → **Kokoro · local / self-hosted**.
2. Choose a voice ID supported by your service and target language. `af_heart` is the configurable initial default, not an automatic multilingual voice choice. Kokoro-FastAPI exposes its voices at `/v1/audio/voices`; LearnLens currently accepts a manual voice ID.
3. Optionally run **Test speech**, confirm the local synthetic request, and save model roles.
4. Enable spoken examples and create a lesson. Listen before judging voice quality or language suitability.

## Hosted deployment

Kokoro must be reachable **from the LearnLens server**. A learner’s phone/PC `localhost` is not the server’s `localhost`.

- Bare-metal: bind Kokoro to loopback and configure the same-host URL.
- Docker: put both services on a private network and use a service URL such as `http://kokoro:8880/v1`. Do not publish Kokoro’s port publicly. Inside the LearnLens container, `127.0.0.1` refers to that container, not the other service.
- Restrict network access, size the CPU/RAM or GPU, persist model assets, and set appropriate proxy timeouts. Free or sleeping application tiers may not be suitable for sustained TTS.
- `KOKORO_BASE_URL` is trusted **operator-only configuration**. It can reach private HTTP(S) services, unlike browser-supplied provider URLs in hosted mode. The browser cannot override it. Its API key is never sent to the browser or model advisor.
- The shared service is available to authenticated beta users. Apply authentication/quotas and infrastructure limits before wider use.

Kokoro is speech-only in LearnLens. It does not replace the lesson model or transcription role. There is no automatic cloud fallback. If synthesis fails, you receive a text lesson with a warning.

## Verification boundary

The API contract and routing are covered by mocks, including embedded audio and failure behavior. A real Kokoro deployment, voice quality, language coverage, latency and offline asset completeness still require operator/device testing. No claim of a running Kokoro installation is made by merely displaying the option.
