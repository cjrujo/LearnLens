// Trusted synthetic inspection for unit/API/browser tests whose MP4 bytes are
// signatures only. Real decode/timing lives in video-clips/video-timing tests.
import { videoClipPlan, videoClipBounds } from '../lib/video-clips.mjs';
export async function syntheticVideoLoader() {
  return { videoClipPlan, videoClipBounds, inspectWholeVideoSource: async (_file, _extension, info) => info };
}
