# The default deployment includes Kokoro, its CPU runtime, model and voice files.
# Pinned multi-arch Kokoro-FastAPI v0.9.1 image (amd64 + arm64).
FROM node:22-bookworm-slim AS node-runtime
FROM ghcr.io/remsky/kokoro-fastapi-cpu@sha256:03334df0f6de21df0138d2896f8211c20d1d513bae865e14a695b17d647bc961
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
WORKDIR /learnlens
COPY --chown=1000:1000 package.json server.mjs ./
COPY --chown=1000:1000 lib ./lib
COPY --chown=1000:1000 public ./public
COPY --chown=1000:1000 deploy ./deploy
COPY --chown=1000:1000 LICENSE THIRD-PARTY-NOTICES.md ./
COPY --chown=1000:1000 third_party ./third_party
USER appuser
# Fail the build if the included model cannot synthesize; populate any caches now,
# never ask a learner to download/install a model or fetch missing runtime assets.
RUN node --version && node deploy/warm-kokoro.mjs
ENV HOST=0.0.0.0 PORT=3210 HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
EXPOSE 3210
CMD ["node", "deploy/start.mjs"]
