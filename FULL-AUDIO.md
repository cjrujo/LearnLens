# Complete English audio

**The composer no longer selects eight spoken examples.** Enable complete English audio to include word targets and sentence/phrase targets from both the uploaded material and the generated lesson.

## Coverage, not highlights

- Original extracted text and transcripts are retained separately from the selective teaching digests. Contiguous text/Office chunks are rejoined before audio batching, including the final tail.
- Every extracted image gets a separately consented primary-model English text-recognition request, not just the five representative images used in the final lesson. Image recognition can cost additional provider credits.
- All detected Latin-script words are targets, including common words—not merely a model-selected keyword list. Sentences/phrases have their own playback targets. Exact word forms and source labels are retained; identical speech text shares a clip.
- Generated titles, objectives, explanations, examples, vocabulary, questions, translations containing English, and answers are inventoried. Answer controls remain inside the revealable answer; nothing autoplays an answer.
- Long narration is divided automatically at word boundaries. Each sentence target plays its ordered pieces. Source line breaks can define phrase boundaries. Pathological unbroken tokens over 500 characters fail explicitly rather than being silently truncated.

**Scope is English/Latin-script targeting, not reliable language identification.** Native Kokoro supports US/UK English only. Non-Latin explanations/translations remain readable but are not spoken by this feature. Latin-script French/Spanish/etc. can be matched but may be mispronounced by an English voice. Isolated words can have context-dependent pronunciations; use sentence playback as well. A multilingual provider does not change the current inventory's English/Latin-script scope automatically.

“Audio complete” means every retained target has its required clip(s). It does **not** certify that OCR or transcription recognized every original word, that pronunciation is correct, or that the lesson teaches every original task. Uncertain recognition is reported separately. Existing import limitations remain: Office images/charts/layout are not rendered, PDF text/rasterization can lose fidelity, and video stills sample rather than cover every frame. Do not mistake source text for an archival copy of the original files.

## Creation and recovery

1. Confirm source preparation and teaching. The dialog discloses transcription, digests and extra image-recognition calls. Uploads/local previews alone do not call AI.
2. Local preflight verifies the managed audio encoder/capacity before those paid steps. Missing media assets can download automatically; offline mode requires a verified cache.
3. The text lesson is retained before audio preparation. Full source descriptors are added to a private, session-owned plan, separately from the bounded final teaching request.
4. A second confirmation shows the **exact unique clip count**, speech model/voice, whether speech is local or potentially billable, completed clips and recognition uncertainties.
5. Clips run serially per session, with completed/total progress. Stop prevents later requests; an already submitted request may still finish or be billed.
6. **Continue audio** reads the existing plan and asks for fresh consent. It never repeats teaching, OCR or transcription. Completed clips are reused. Failed/unknown attempts are not automatically replayed; repeated attempt IDs never dispatch another provider request.
7. If speech succeeds but local MP3 encoding fails, one bounded raw result is retained for local encoding recovery rather than paying for speech again. Other new speech waits until that result is resolved.
8. Download a complete or explicitly partial HTML file. Missing controls remain disabled, not silently omitted. Local export reads statuses/files only; it does not generate speech.

The page retains the current lesson plus one previous lesson. Starting another lesson cannot silently evict an unfinished audio plan. Finish it or explicitly discard remaining audio first; discard retains the last HTML but removes resume work. Completed server plans can be released once their HTML is retained.

**This is session-only recovery, not durable jobs.** Reloading loses page state; logout, expiry and host restart remove plan ownership. A known lost plan is never silently recreated and billed again. Settings changes require reconfirmation; a different speech provider/model/voice cannot silently retarget an old plan. Download before refreshing or restarting.

## Offline controls

The trusted renderer embeds each distinct audio asset once, with no API key, CDN, browser-system TTS or network fallback. Click an underlined word or a sentence button. Controls offer **1× / 0.75× / 0.5×**, repeat **1 / 3 / 5**, and Stop. New clicks cancel the previous queue; only one sound plays. Collapsing the active section, leaving the preview, or hiding/closing the page stops playback. Scripts and media stay within the restrictive export CSP and sandbox.

Native synthesis still returns 24 kHz mono PCM WAV internally. Managed FFmpeg converts it locally to mono 24 kHz, 48 kbps MP3 and fully decodes the output to check it. Decode validation proves a usable container, **not spoken-word accuracy or naturalness**. No ASR/pronunciation scoring was added.

## Real resource boundaries

There is no eight-clip limit in this path. Protective budgets remain:

| Resource | Default |
|---|---|
| Retained browser source text | 64 MiB UTF-8 |
| Source descriptor | 40,000 UTF-16 characters, automatically batched |
| Speech request piece | 500 UTF-16 characters, word-boundary split |
| Raw speech response | 8 MiB |
| Encoded clip | 2 MiB; no truncation |
| Compressed audio per plan | 128 MiB |
| Metadata / conservative interactive-markup budget | 64 MiB each per plan |
| Reserved compressed audio per instance | 512 MiB; at most four default-size plans |
| Plans per session | Two |
| Single HTML export | 256 MiB; only one export at a time |

The maximum encoded clip is reserved before a new speech request. Thus the final unused storage margin can be less than 2 MiB, rather than risking a paid result that cannot fit. Quota failures preserve prior work and report incomplete coverage; they are not permission to remove safeguards or claim unlimited files. Existing original-file, parser, 512 preparation-call, session-duration and concurrency quotas still apply. Many isolated word clips can take substantial CPU time or provider calls; review the exact count.

Plans use owner-private temporary `learnlens-audio-*` directories. Source text, lesson data and generated clips can be sensitive; they are not encrypted from the host operator. API keys are never written there. Normal removal/logout/expiry/shutdown cleans up owned plans. Failed filesystem cleanup retains its quota reservation and is retried in bounded maintenance passes, independently of whether its session still exists. Hard crashes or OS cleanup failures can leave temporary files for operator cleanup; never delete a running instance's directories.

## API compatibility and verification

The composer sends `/api/lessons` with `includeAudio:false`, then uses the separate audio-plan API in [API-CONTRACT.md](API-CONTRACT.md). Older direct clients can still use the legacy `includeAudio:true` eight-line/12 MiB sample path; that is **not** the complete-audio composer path.

See [TESTING.md](TESTING.md) for recorded results. Local fixtures verify coverage, ownership, consent, no replay, recovery, CSP and UI behavior; they do not establish cloud-provider compatibility or educational accuracy. `npm run test:audio-native` exercises real cached Kokoro/FFmpeg without cloud calls and writes a standalone example for separate browser playback verification.
