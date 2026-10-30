# Bundled speech components

The default LearnLens container incorporates the **Kokoro-FastAPI CPU v0.9.1** image, pinned to multi-platform manifest digest `sha256:03334df0f6de21df0138d2896f8211c20d1d513bae865e14a695b17d647bc961`.

- Kokoro-FastAPI source and license: https://github.com/remsky/Kokoro-FastAPI/tree/v0.9.1 (Apache-2.0).
- Kokoro implementation license is included in `third_party/Kokoro-82M-LICENSE`, from https://github.com/hexgrad/kokoro/blob/main/LICENSE. Model-specific provenance/card: https://huggingface.co/hexgrad/Kokoro-82M (Apache-2.0; review model/voice notices and usage requirements).
- The upstream image also includes Python, PyTorch, language-processing dependencies, voice assets, eSpeak NG and OS packages. These retain their own licenses, including GPL licenses for eSpeak NG; the LearnLens MIT license does not replace them.
- Node.js license text is included in `third_party/Node-LICENSE`. Node.js is copied from the official Node 22 Debian image and retains its own license: https://github.com/nodejs/node/blob/v22.x/LICENSE.

Upstream source for the pinned container is revision `c70cce8087ee233da6b2d04a6ace39c796bcf3ce`. Its Dockerfile, dependency lockfile and image metadata describe the included components. Maintain upstream copyright/license files and comply with applicable redistribution/source-offer requirements when redistributing a built image.

LearnLens keeps speech on private server loopback. Optional voice cloning/tuning, SSML, debug endpoints and web-player access are disabled for the bundled worker. No voice-model training or cloning feature is offered by LearnLens.
