# Built-in natural speech

**Kokoro ships with the standard LearnLens container. Learners do not install it, configure a service URL, download a model, or supply a speech API key.**

The default package includes the CPU speech runtime, Kokoro model, voices and build-time English-language warmup/cache. One app container starts the private speech process automatically, waits for readiness, then starts LearnLens. New sessions already select **Built-in natural speech · Kokoro**. Online-provider speech remains an optional alternative.

## For learners

1. Connect a primary lesson model for understanding your material.
2. Enable **Add spoken examples** when creating a lesson. Built-in speech is already selected.
3. Listen in the app or download the HTML lesson. The generated audio travels with the file and works offline.

No separate Kokoro installation or API key is needed. The initial voice is English `af_heart`; choosing another voice is optional. Voice/language coverage and naturalness vary, and this release does not automatically select a voice by language. If synthesis fails, the text lesson is kept with a warning; there is **no silent switch to paid online speech**.

Clearing a bundled session removes user-configured providers/keys and restores the included speech default. Speech can still be disabled by clearing its role or leaving spoken examples off.

## For deployment operators

Use the normal project Dockerfile—not a second Kokoro service:

```sh
docker build -t learnlens .
docker run --env-file .env -p 127.0.0.1:3210:3210 --name learnlens learnlens
```

Set the usual HTTPS `PUBLIC_ORIGIN`, `LEARNLENS_ACCESS_PASSWORD`, `HOST` and `PORT` in `.env`; see README. **No `KOKORO_BASE_URL` is needed.** Put the app behind an HTTPS reverse proxy and never expose the raw Node HTTP port publicly.

The first image build downloads the pinned upstream speech image and any remaining warmup assets. This is a deployment/build step, not something each learner does. The built image is larger than the previous Node-only image and needs more CPU/RAM; select a host that supports a persistent Docker process rather than a tiny request-scoped serverless function.

The package:

- Includes the multi-arch Kokoro-FastAPI CPU v0.9.1 image pinned by digest, plus Node 22.
- Synthesizes a sample during the build, failing the build if the included English voice cannot run.
- Enables offline model-cache mode at runtime; model installation is not deferred to learners.
- Binds speech to private `127.0.0.1:8880`. Only the app port is intended for routing; speech is not published.
- Does not pass workspace passwords or provider keys to the speech child process.
- Disables upstream web-player, CORS, debug, tuning/cloning, voice tags and SSML features.
- Terminates both processes on shutdown and fails the container if either process unexpectedly exits, so an unhealthy worker is not silently advertised as ready.

Model synthesis can run without internet after packaging. A remote primary model still needs connectivity for new lessons. Downloaded HTML contains audio bytes, **not the model itself**.

### Advanced development/operator overrides

`npm start` remains a lightweight, Node-only developer command; it does not install Python/model dependencies. It is not the bundled end-user distribution. Use the container to test included speech.

Operators can intentionally opt out with `LEARNLENS_SPEECH_MODE=disabled`, or set `KOKORO_BASE_URL` to an already-managed service to override the included worker. `KOKORO_MODEL`, `KOKORO_VOICE` and `KOKORO_API_KEY` remain advanced configuration for that service. An external override is not automatically selected as the bundled default. These are not learner-facing installation requirements, and browser input cannot change the internal service URL.

## Verification

Local unit/browser checks cover the preselected speech role, process lifecycle, credential isolation, switching to online speech, and embedded audio. The separate **Bundled speech verification** GitHub Actions workflow builds the real container, starts it with `--network none`, tests the default speech role and API probe, synthesizes real MP3 audio and verifies its inclusion in HTML. See TESTING.md for the recorded outcome and remaining gaps.

English build-time warmup is not a guarantee that every language/voice works without additional assets; those combinations need explicit validation. No perceptual rating of voice naturalness or physical-device compatibility is implied by successful synthesis.

Upstream: https://github.com/remsky/Kokoro-FastAPI/tree/v0.9.1. See THIRD-PARTY-NOTICES.md and third_party/ for licensing/provenance.
