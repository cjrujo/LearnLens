# Learning-material imports

LearnLens uses **one drop/paste/file area and one instruction box**. Subject, level, language and narration are optional. You can also ask a question without a file.

## Automatic preparation

| Material | Processing |
|---|---|
| PNG/JPEG/WebP | Browser preview and automatic resizing when needed. Large sets are processed in batches. |
| TXT/Markdown | UTF-8 or BOM-marked UTF-16 text, split into approximately 20,000-character parts. |
| PDF | Every requested three-page range is extracted and rasterized locally, including later pages. Scanned pages need a vision-capable primary model; there is no local OCR. |
| DOCX | Ordered body text and supported footnotes/endnotes. |
| PPTX | Actual presentation order, slide text and supported speaker notes. |
| MP3/MP4/WebM/WAV/OGG | Managed FFmpeg prepares independent three-minute, 16 kHz mono WAV parts and sampled video stills. The remainder is included; users do not manually cut clips. |

Office layout, charts, embedded objects and images are **not rendered**; import warnings explain the loss. Video stills are samples, not every frame or every slide. PDF rendering can fail on unsupported content or resource-intensive visuals; those limitations remain visible. Encrypted/password-protected documents and macro-enabled Office files are not supported.

Original documents/media upload to the **LearnLens host**, not directly to an AI provider. Uploads use resumable, idempotent four-MB transfers. Local previews are read-only and paginated; a shortened preview does not truncate processing.

## Consent, cost and recovery

Importing and previewing make no AI requests. Creating a lesson asks for explicit consent and shows part counts and estimated request counts. Audio parts go to the selected transcription role; extracted text/images go to the primary role. Large material is automatically reduced through source-labeled AI digests before the final lesson. These digests are **lossy**, not a faithful archival copy or independent fact-check. Up to five representative images are embedded; remaining visuals still enter preparation.

Successful transcripts/digests are cached in bounded memory **on the current page**. A retry requires fresh consent and reuses cached successes where settings/content match. Failed or unknown paid requests are never replayed automatically: an upstream request may have been billed even if its response was lost. Local upload recovery is non-billable and can retry boundedly. Stop/session clearing prevents later queued calls; it cannot undo a request already sent.

Changing model/provider settings after confirmation stops the operation rather than silently switching destinations. Reloading the page or restarting the host is not durable job recovery: reconnect and re-add originals as needed. Download finished lessons before refreshing. The offline HTML contains prepared teaching content, not the original video/document or model binaries.

## Managed media engine

Windows x64 and Linux x64 obtain pinned LGPL FFmpeg/FFprobe builds into `.cache/media/` automatically on first media import. No Docker, Python or separate system FFmpeg setup is required. Linux needs system `tar` with xz support. Other architectures are currently unsupported for this media engine, even if native speech runs there.

Operators can prepare it ahead of time:

```sh
npm run setup:media
# After preparation, require cache-only operation:
LEARNLENS_MEDIA_OFFLINE=1 npm start
```

PowerShell users can use `npm.cmd run setup:media` and `$env:LEARNLENS_MEDIA_OFFLINE='1'`. The initial archive is approximately 168 MB on Windows or 135 MB on Linux; extracted binaries require additional space. Releases, byte sizes and SHA-256 checksums are fixed in `deploy/media-assets.mjs`. Missing/corrupt offline caches fail clearly. There is no automatic substitution of another release or checksum. Upstream retention is not guaranteed: preserve verified caches. Licensing/provenance is in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## Host safety quotas—not manual model chunk limits

Automatic splitting does not mean unlimited host resources. Current private-beta ceilings are 100 MB per document, 1 GB per media file, four hours per recording, 1,000 PDF pages/slides, two million extracted text characters per extraction, and ten server-staged originals / 1 GB originals per session. The instance reserves at most 4 GB of originals, permits two simultaneous local processors, and bounds parser V8 heap, archive expansion, runtime and output. Browser preparation stops after 512 new paid preparation calls. These are protective ceilings, not requests to manually prepare ordinary larger materials.

Final model requests retain the 40,000-character / five-image / eight-MB image budget; the app handles intermediate segmentation and reduction. Generated narration remains at most eight short lines and 12 MB embedded audio.

## Temporary material storage

Original uploads and prepared parts use private directories under the host OS temporary directory. Removal, logout, session expiry and normal shutdown clean them up. Only the first preview and latest large raster/audio part are retained; other parts can be regenerated locally. Provider keys are **never written there**, into browser storage, or into exports.

A hard process/OS crash can leave a `learnlens-materials-*` temporary directory for operator/OS cleanup. Do not delete directories belonging to a running process. This alpha is single-instance and not a durable job/account storage system; use a trusted host, suitable disk permissions and storage monitoring.
