# Speech components and licenses

## Native Node deployment (default)

`npm ci` installs locked dependencies; LearnLens does not vendor their compiled binaries into Git. `npm start` prepares a local model cache. The LearnLens MIT license does not replace dependency/model licenses.

- `kokoro-js` **1.2.1**, Apache-2.0: https://github.com/hexgrad/kokoro/tree/664c76a704021239ba59c84dcbaa4d3dece01fe9/kokoro.js. Its npm package includes the voice binaries used by native inference.
- `@huggingface/transformers` **3.8.1**, Apache-2.0: https://github.com/huggingface/transformers.js/tree/2ec882e739e4cb461f8d440d4d7394cbf5372429. ONNX Runtime **1.21.0**, MIT: https://github.com/microsoft/onnxruntime/tree/v1.21.0. CPU only; optional CUDA download is disabled.
- Quantized model/tokenizer files: https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/tree/1939ad2a8e416c0acfeecc08a694d14ef25f2231, Apache-2.0 model card; based on https://huggingface.co/hexgrad/Kokoro-82M. `deploy/native-assets.mjs` pins revision, byte sizes and SHA-256 values. Do not infer language support from unenabled model variants.
- `phonemizer` **1.2.1** wrapper is Apache-2.0, but embeds compiled **eSpeak NG**, whose GPL terms also apply: https://github.com/xenova/phonemizer.js/tree/6835144b7ee9043129222549c1ed2f6a27216278 and https://github.com/espeak-ng/espeak-ng. Embedded-source/build provenance is not fully documented by that package; see the upstream discussion https://github.com/xenova/phonemizer.js/issues/6. This integration is not a certification of binary-redistribution compliance. Before shipping a repackaged binary/installer, review corresponding-source and notice obligations; do not describe the entire dependency stack as MIT/Apache-only.
- `sharp` is overridden to **0.35.5** to avoid known vulnerable bundled image libraries in the older dependency range. Native TTS does not process images through sharp. npm lock integrity pins the resolved dependency graph; retain each package's own license/notices.

## Optional Docker deployment

The optional LearnLens container incorporates the **Kokoro-FastAPI CPU v0.9.1** image, pinned to multi-platform manifest digest `sha256:03334df0f6de21df0138d2896f8211c20d1d513bae865e14a695b17d647bc961`.

- Kokoro-FastAPI source and license: https://github.com/remsky/Kokoro-FastAPI/tree/v0.9.1 (Apache-2.0).
- Kokoro implementation license is included in `third_party/Kokoro-82M-LICENSE`, from https://github.com/hexgrad/kokoro/blob/main/LICENSE. Model-specific provenance/card: https://huggingface.co/hexgrad/Kokoro-82M (Apache-2.0; review model/voice notices and usage requirements).
- The upstream image also includes Python, PyTorch, language-processing dependencies, voice assets, eSpeak NG and OS packages. These retain their own licenses, including GPL licenses for eSpeak NG; the LearnLens MIT license does not replace them.
- Node.js license text is included in `third_party/Node-LICENSE`. Node.js is copied from the official Node 22 Debian image and retains its own license: https://github.com/nodejs/node/blob/v22.x/LICENSE.

Upstream source for the pinned container is revision `c70cce8087ee233da6b2d04a6ace39c796bcf3ce`. Its Dockerfile, dependency lockfile and image metadata describe the included components. Maintain upstream copyright/license files and comply with applicable redistribution/source-offer requirements when redistributing a built image.

LearnLens keeps speech on private server loopback. Optional voice cloning/tuning, SSML, debug endpoints and web-player access are disabled for the bundled worker. No voice-model training or cloning feature is offered by LearnLens.
