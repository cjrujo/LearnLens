import { prepareYouTubeAssets, YTDLP_VERSION, DENO_VERSION } from './youtube-assets.mjs';

import { AppError } from '../lib/provider.mjs';

// Explicit operator action only. Source imports never install/update helpers.
try {
  await prepareYouTubeAssets({ offline: process.env.LEARNLENS_YOUTUBE_OFFLINE === '1' });
  console.log(`Verified project-local YouTube tools: yt-dlp ${YTDLP_VERSION}; Deno ${DENO_VERSION}. This does not verify public-video availability or model compatibility.`);
} catch (error) {
  console.error(error instanceof AppError ? error.message : 'Could not prepare the pinned YouTube helpers. No source acquisition or AI request was made.');
  process.exitCode = 1;
}
