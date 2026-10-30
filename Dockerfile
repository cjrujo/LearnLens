FROM node:22-alpine
WORKDIR /app
COPY --chown=node:node package.json server.mjs ./
COPY --chown=node:node lib ./lib
COPY --chown=node:node public ./public
USER node
EXPOSE 3210
ENV HOST=0.0.0.0 PORT=3210
CMD ["node", "server.mjs"]
