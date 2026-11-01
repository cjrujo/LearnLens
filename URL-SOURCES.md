# Public URL sources and whole-video lessons

**Unreleased validation-branch feature.** Local synthetic/browser, Windows native-media and fresh Linux native-media checks pass. Public HTML/TXT/WAV/MP4 acquisition and 66 native-media checks also pass on Windows/Linux CI. The complete pinned YouTube runtime/permission checks and public YouTube acquisition remain blocking release gates; see the exact-run status below. This document does not mean an already-running LearnLens instance has been updated. See [verification status](TESTING.md#url-sources-and-whole-video-unreleased).

## How to import a public link

1. Open the lesson composer, paste a **public HTTPS** URL and select **Detect from content**, **Static webpage text**, **Whole video** or **Audio only**. Click **Fetch & review**, then approve retrieval. This contacts the website and stores a private temporary copy on the LearnLens host, but makes **no AI request**. Cancel makes no source request.
2. Review the saved material and warnings. Webpage mode extracts static text; Video mode can select one unambiguous native `<video>` resource. Auto dispatches direct supported files and imports HTML as static text, not a rendered browser page. Audio mode accepts unambiguous MP3/WAV; use Auto for other media containers so a visual track is not silently discarded.
3. Configure the required model roles, enter your learning instructions and choose **Create lesson**. Review the separate AI/data-sharing consent. Complete English audio, when requested by Auto/On, has another confirmation showing the exact unique speech clip count.

Successful review shows a ready source with chronological parts. A shortened preview is not a processing cutoff. The original stays private; the offline lesson contains teaching and retained audio/text, not the original video or a remote player.

### Supported and unsupported sources

- Static HTML, UTF-8 or BOM-marked UTF-16 text/Markdown; direct PDF/DOCX/PPTX and supported media files.
- Static HTML text preserves inline word boundaries, CJK adjacency and preformatted indentation/newlines. Scripts, styles, hidden content, navigation, images, embeds and CSS layout are not rendered or fetched. This is not a visual webpage capture.
- Public single-video YouTube watch/shorts/youtu.be links are **best-effort**. The managed helper accepts finished videos up to two hours and selects a complete progressive audiovisual resource (which can be lower quality than YouTube's separate-stream formats); captions, title/description, audio-only files and a few stills are not substitutes. Streaming-only formats, live/playlist/login/age/region/DRM challenges or unavailable helper assets can prevent import. Upload the original video instead; no cookies, browser login, DRM bypass or proxy rotation is offered.
- Dynamic lessons that require scripts or authentication are unsupported. HTTP errors and recognized short login/error pages are rejected, but detection of all access walls is not guaranteed: review the saved text. Incomplete, ambiguous, oversized or invalid media fail explicitly rather than being silently reduced.

## How to configure whole-video analysis

Assign **Video analysis** manually under AI providers. Use a provider/model that explicitly supports the Gemini-native `generateContent` request with inline MP4 and `videoMetadata.fps`. Text/vision/transcription discovery or a model name does not establish native-video compatibility. Recommendations do not assign or verify this role.

| Setting | Contract |
|---|---|
| API | Explicit `gemini`; no primary/audio/image/protocol fallback |
| Requested sampling | 1–24 FPS, default 24; frozen for a generation plan |
| Request wait | Integer 30–600 seconds, default 300; independent of primary wait |
| Local clip | Continuous 30-second interval; a final tail below 0.5 seconds joins the previous interval, at most 30.5 seconds |
| Analysis copy | H.264/AAC MP4, at most 8 MiB; source frame rate retained, resized only when needed to at most 1920×1080 |
| Model result | Every five-second window structurally accounted for; raw original-language speech, visible words, observations and uncertainty kept distinct |

New MP4/WebM uploads and imported videos use this path. Audio-only containers/recordings still use the transcription role. Legacy direct clients can explicitly use the older sampled-stills import mode; that mode is not whole-video analysis.

Each attached whole video needs a verified saved result for **every chronological interval before teaching starts**. Unsupported multiple substantive tracks, meaningful audiovisual gaps, missing timing evidence or undecodable clips fail closed. WebM missing stream durations gets one bounded packet-timing inspection per private snapshot; clips reuse that proof instead of rescanning the whole file.

**All intervals submitted does not mean all details understood.** Analysis copies are lossy, requested FPS is not a guarantee of provider sampling, and the model can miss speech, small text, motion or frames. Coverage labels are model-reported, not proof of complete perception or educational correctness. Review uncertain results and the original.

Whole-video English-audio inventory uses only retained native speech/screen-word receipts, not derived observations. It does not run additional video analysis, STT or still-image OCR. Image/PDF English recognition remains separately consented. See [complete audio](FULL-AUDIO.md).

## How to recover without fetching or paying twice

- **Lost fetch acknowledgement:** recover the same material ID with read-only status requests. No external fetch is replayed.
- **Completed download, failed local parsing:** the sealed original, hash and snapshot identity survive. Resume local import retries parsing or sidecar publication only, without contacting the website.
- **Failed/incomplete acquisition:** review the error. Explicit reimport uses a **new ID** and requires fresh fetch approval; same-ID lookup cannot fetch again.
- **Stopped/unknown video attempt:** poll its status. Completed or still-running receipts are reused, including after removing the current video role. Failed/damaged work requires explicit Continue, renewed consent and a new attempt ID. Never assume an unknown request was free or cancelled.
- **Accepted analysis, failed local checkpoint write:** retained output is repaired locally. No new clipping or provider call; a still-running repair is polled rather than reposted.
- **Changed settings:** newly confirmed provider/model/wait settings affect unfinished work only. Changed FPS requires a new generation plan; it cannot silently change an existing plan's sampling.

Generation/audio continuation never refetches a saved source. Keep the page open and download finished lessons: page/session checkpoints are not durable across refresh, logout, expiry or host restart. Stop cannot undo upstream work or guarantee no charge. Cleanup waits for owned writers/readers; failed physical cleanup retains reservations for later retry.

## Host setup and safety limits

The existing managed [media setup](IMPORTS.md#managed-media-engine) supplies FFmpeg/FFprobe. YouTube additionally requires operator-prepared, checksum-verified **yt-dlp 2026.10.26 and Deno 2.9.8**:

```sh
npm run setup:youtube
# Later, verify cache only; missing assets fail without downloading:
LEARNLENS_YOUTUBE_OFFLINE=1 npm run setup:youtube
```

Imports never install/update YouTube helpers automatically. Windows/Linux x64 are the implemented targets; the exact pinned runtime still has an outstanding verification gate. Preserve verified caches because upstream availability is not guaranteed. Bundled licenses differ from the projects' top-level licenses; see [notices](THIRD-PARTY-NOTICES.md).

URL acquisition requires HTTPS port 443, no URL credentials, exclusively public DNS answers, pinned connections and peer checks on every redirect. Private, loopback, link-local and benchmarking addresses remain forbidden even when LearnLens itself runs on localhost. Source fetches inherit no provider authentication, browser cookies, operator proxy credentials or user downloader configuration. Redirect, deadline, response and byte bounds apply; there is no automatic network retry. A network that resolves public hosts to private/benchmarking addresses must be fixed or replaced by the operator, not bypassed by relaxing these checks.

The destination website sees the actual request URL, including query tokens. Citations strip query/fragment (except canonical YouTube video ID); **citation origin/path and retained source content may be shared with chosen providers and included in lessons**. Full private fetch URLs and local paths are not diagnostic fields. This is not a guarantee that sensitive information already written in source content will be removed.

Existing 1 GiB/media, four-hour general-media (two-hour managed YouTube), ten-original/session, 1 GiB/session and 4 GiB/instance original-storage limits remain. Retained HTML plus selected media and text sidecars count toward storage. Static input is capped at 8 MiB and decoded text at two million UTF-16 code units. Missing-timing inspection has a 120-second total deadline, 128 MiB packet-output cap and two-million-record limit; buffering can transiently approach twice that output cap. Denser/unsupported sources fail rather than being truncated. Native-video results additionally reserve up to 64 MiB/owner, 256 MiB/instance, 512 KiB/result and 64 attempts/clip. These are safety ceilings, not measured peak-load guarantees.

## Troubleshooting

| Message/situation | Action |
|---|---|
| Public network addresses required | Use a suitable public-DNS host/network. Do not permit private/benchmarking addresses or import browser proxy secrets. |
| No readable static text / embedded player | Upload the original material or use a direct supported resource. |
| YouTube helper unavailable | Ask the operator to prepare the pinned tools, or upload the original video. |
| Native-video role missing/incompatible | Configure the explicit video role and review provider documentation; no automatic paid compatibility probe runs. |
| Source timing/track/size limit | Review the source and limits; unsupported media is not silently reduced to audio or screenshots. |
| Failed/unknown analysis | Review status/diagnostics and explicitly Continue only if another possibly billable attempt is intended. |

See [API reference](API-CONTRACT.md#url-acquisition-and-native-video-plans), [import limits](IMPORTS.md), and [verification evidence](TESTING.md#url-sources-and-whole-video-unreleased).
