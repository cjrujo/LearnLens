# Complete English audio

**The composer no longer selects eight spoken examples.** Complete English audio includes word targets and sentence/phrase targets from both the uploaded material and the generated lesson.

## Automatic English lessons

**Audio defaults to Auto · English-subject lessons only.** An explicitly selected English-learning subject enables audio; other selected subjects leave it off. With **Subject: Auto**, the normal teaching response supplies `englishLearning` metadata; older responses use a conservative subject-label fallback. No extra classifier request is made. This is model-reported classification, not independent verification: English explanations for mathematics do not by themselves request audio. English practice explained in Chinese or another language can still include English audio.

Choose **On** or **Off** to override Auto. The choice is saved with the generation checkpoint; editing the form does not change an interrupted request. Audio still requires separate exact-count speech confirmation. Non-English/Off requests make no extra audio-recognition, audio-preflight, plan or speech calls; transcription needed to understand an uploaded recording is separate.

For auto-detected English, teaching finishes first. The app then rereads local original parts, reuses pinned transcripts and performs only missing audio image recognition. This inventory-only upgrade never repeats transcription, teaching digests, merges or teaching. While its inventory is unfinished, attachments and new lesson/demo creation are locked; finish it or explicitly discard remaining audio first. Missing speech setup retains the text and preparation checkpoint so speech can be configured before continuing. Once the source inventory transfers to the audio context, normal two-lesson history resumes.

## Coverage, not highlights

- Original extracted text and transcripts are retained separately from the selective teaching digests. Contiguous text/Office chunks are rejoined before audio batching, including the final tail.
- Every extracted image gets a separately consented primary-model English text-recognition request, not just the five representative images used in the final lesson. Image recognition can cost additional provider credits.
- Whole-video source inventory reuses accepted, timestamped native speech/screen-word receipts. Derived observations are not original source text. Eager or post-teaching audio inventory never repeats video analysis, STT or still-image OCR; missing receipts fail rather than silently omitting a source.
- All detected Latin-script words are targets, including common words—not merely a model-selected keyword list. Sentences/phrases have their own playback targets. Exact word forms and source labels are retained; identical speech text shares a clip.
- Generated titles, objectives, explanations, examples, vocabulary, questions, translations containing English, and answers are inventoried. Answer controls remain inside the revealable answer; nothing autoplays an answer.
- Long narration is divided automatically at word boundaries. Each sentence target plays its ordered pieces. Source line breaks can define phrase boundaries. Pathological unbroken tokens over 500 characters fail explicitly rather than being silently truncated.

**Scope is English/Latin-script targeting, not reliable language identification.** Native Kokoro supports US/UK English only. Non-Latin explanations/translations remain readable but are not spoken by this feature. Latin-script French/Spanish/etc. can be matched but may be mispronounced by an English voice. Isolated words can have context-dependent pronunciations; use sentence playback as well. A multilingual provider does not change the current inventory's English/Latin-script scope automatically.

“Audio complete” means every retained target has its required clip(s). It does **not** certify that OCR or transcription recognized every original word, that pronunciation is correct, or that the lesson teaches every original task. Uncertain recognition is reported separately. Existing import limitations remain: Office images/charts/layout are not rendered, PDF text/rasterization can lose fidelity, and native-video providers may miss frames, motion, speech or screen words despite receiving every interval. Legacy sampled-stills imports remain only samples. Do not mistake source text for an archival copy of the original files.

## Creation and recovery

1. Confirm source preparation and teaching. The dialog discloses transcription, digests and extra image-recognition calls. Uploads/local previews alone do not call AI.
2. Local preflight verifies the managed audio encoder/capacity before audio-source recognition or speech. Explicit audio with configured speech may preflight before teaching; auto-detected English preflights after the text is retained. Missing media assets can download automatically; offline mode requires a verified cache.
3. The text lesson is retained before audio preparation. Full source descriptors are added to a private, session-owned plan, separately from the bounded final teaching request.
4. A second confirmation shows the **exact unique clip count**, speech model/voice, whether speech is local or potentially billable, completed clips and recognition uncertainties.
5. Clips run serially per session, with completed/total progress. Stop prevents later requests; an already submitted request may still finish or be billed.
6. **Continue audio** never repeats teaching or transcription. If original-source inventory is still pending, it shows current primary settings and asks for renewed consent before missing/failed OCR only; successful recognition and transcripts are reused from the pinned checkpoint even if the ordinary cache was evicted. Once the inventory is complete, continuation reads the existing plan without any OCR. Completed clips are reused. Failed/unknown attempts are not automatically replayed; repeated attempt IDs never dispatch another provider request.
7. If speech succeeds but local MP3 encoding fails, one bounded raw result is retained for local encoding recovery rather than paying for speech again. Other new speech waits until that result is resolved.
8. Download a complete or explicitly partial HTML file. Missing controls remain disabled, not silently omitted. Local export reads statuses/files only; it does not generate speech.

The page retains the current lesson plus one previous lesson. Starting another lesson cannot silently evict an unfinished audio plan. Finish it or explicitly discard remaining audio first; discard retains the last HTML but removes resume work. Completed server plans can be released once their HTML is retained.

**This is session-only recovery, not durable jobs.** Reloading loses page state; logout, expiry and host restart remove plan ownership. A known lost plan is never silently recreated and billed again. Settings changes require reconfirmation; a different speech provider/model/voice cannot silently retarget an old plan. Download before refreshing or restarting.

## Reading-pause marks versus literal slashes

New generated chunked-reading sections/audio entries can declare `readingPauses:true`. In those explicitly marked fields, a spaced single `/` becomes punctuation in the speech input, not the spoken word “slash”. Existing commas/dashes supply the pause without duplicate punctuation. Visible text, source spans, word targets and answer reveals are unchanged; clip IDs/deduplication use the actual spoken pieces.

This is **not global slash removal**. Unmarked prose and uploaded originals remain literal. Compact URLs/paths/IPA, numeric fractions and single-letter ratios are protected; word alternatives must remain unmarked because text alone cannot reliably distinguish them from reading pauses. The model prompt requires the annotation when it inserts reading-pause marks. A model that omits or misuses the annotation may still need correction. Existing downloaded audio is not rewritten; the new behavior applies when new clips are generated. Punctuation requests a pause but does not guarantee its precise duration or pronunciation quality.

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
