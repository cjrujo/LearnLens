# Gemini-native speech-to-text

LearnLens can explicitly send prepared audio through Gemini's native `models.generateContent` API instead of OpenAI multipart `/audio/transcriptions`. Choosing a Gemini model does **not** automatically select this protocol, verify a gateway, or change your primary lesson model.

## Setup

1. Keep the provider's own base URL and key. For an Aiberm-style OpenAI connection ending in `/v1`, there is no need to create a second connection or send its key to Google.
2. In **AI providers → Speech-to-text**, select the provider and its exact native model ID, then choose **Transcription API → Gemini-native audio**. Save model roles. Saving sends no provider request.
3. Configure the **Primary lesson model** separately. Aiberm's public `gemini-3.8-flash` page lists **Chat Completions** for OpenAI-style teaching requests; choose that explicitly rather than assuming Responses support. The native STT selector does not change this setting.
4. Add media normally. Local FFmpeg prepares independent three-minute, 16 kHz mono WAV segments; you do not need to convert or trim files manually.
5. Review the creation dialog, including the transcription provider/model/API and estimated multistep work. Only your explicit confirmation sends segments. A real attempt may incur charges even when it fails. There is no automatic native/multipart fallback or replay.

**Verification boundary:** local tests cover payloads, routing, parsing and UI behavior. They do not establish that Aiberm forwards inline audio for your model/token group. The [Aiberm model page](https://aiberm.com/models/gemini-3.8-flash) documents `/v1beta/models/gemini-3.8-flash:generateContent`, but does not affirm inline-audio forwarding or its limits. No real Aiberm inference or paid compatibility test was performed for this implementation. A successful sample verifies only that selected format/model for that recording, not accuracy or universal compatibility.

## Routing and authentication

The configured origin (scheme, hostname and port) never changes. Custom prefixes are retained:

| Configured base | Native audio base |
| --- | --- |
| Provider root | `/v1beta` |
| `/v1` | `/v1beta` |
| `/custom/v1` | `/custom/v1beta` |
| `/v1beta` | Unchanged |
| `/custom/v1beta/openai` | `/custom/v1beta` |

Other base-path shapes are rejected locally rather than guessed. The normal base used by teaching, discovery and speech synthesis is not modified. Native model IDs are one ASCII path segment (letters, digits, `.`, `_`, `-`, starting with a letter/digit); an optional `models/` prefix is removed. Other namespace paths, percent encoding, query strings and fragments are rejected before any provider call.

Gateways retain `Authorization: Bearer …`. Only an explicitly configured `generativelanguage.googleapis.com` host uses `x-goog-api-key`; no key is placed in a query string, and gateway keys are never forwarded to Google. Hosted public-address checks, DNS pinning, redirect rejection, deadlines, concurrency limits and secret redaction still apply.

## Request and result boundaries

- `POST models/{model}:generateContent`, non-streaming JSON: top-level `systemInstruction`; `contents` with a user text part and `inlineData: {mimeType:'audio/wav',data:<base64 bytes>}`. No data-URL prefix, provider file upload, or remote file reference.
- Native STT accepts prepared WAV only, at most **8 MiB raw / 12 MiB serialized request**. Normal segments are about 5.76 MB. This is below Google's documented **20 MB total inline-request** ceiling, but a gateway can enforce lower limits. These are segment/request bounds, not original-media limits.
- One candidate, at most 8,192 output tokens; model-default thinking (no inferred reasoning controls). Original-language transcription, not translation or instruction-following. Audio remains untrusted source material; this prompt is not a guarantee against transcription errors or prompt injection.
- Accept one completed `STOP` candidate with usable text (up to 40,000 characters). Exclude `thought:true` parts. Reject blocked, truncated, missing, malformed, non-text, multiple-candidate and empty results; never treat incomplete output as a transcript.
- `[NO_SPEECH]` is an application prompt convention, **not** a reliable voice-activity detector. If returned, preparation stops with a clear no-intelligible-speech error rather than inventing text. Existing completed work remains available in the current page.
- Verification badges are protocol-specific. Cached work includes role/API and setup revision; a mode change requires new consent and cannot reuse the other protocol's transcript. Reload/restart still loses in-page preparation/session settings.
- Safe diagnostics identify `gemini.generateContent` and `/models/{model}:generateContent` without retaining audio, transcript, upstream prose, filenames, keys or base URLs. Provider/model labels are included; review before sharing.

References: [Google generateContent REST](https://ai.google.dev/api/generate-content), [Google audio guide](https://ai.google.dev/gemini-api/docs/audio), [Aiberm authentication](https://aiberm.com/docs/en/authentication/). A documented native endpoint or a model name is not runtime capability verification.
