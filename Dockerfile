FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY scripts/install-hooks.mjs ./scripts/install-hooks.mjs
RUN npm ci --no-audit --no-fund

FROM dependencies AS build
COPY . .
RUN npm run build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV PORT=3000
WORKDIR /app
ARG VCS_REF=""
LABEL org.opencontainers.image.title="WatchPair" \
      org.opencontainers.image.description="Self-hosted synchronized watch rooms" \
      org.opencontainers.image.source="https://github.com/Etaselia/watchpair" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.revision="${VCS_REF}"
COPY --from=build --chown=node:node /app/node_modules/vinext ./node_modules/vinext
COPY --from=build --chown=node:node /app/node_modules/react ./node_modules/react
COPY --from=build --chown=node:node /app/node_modules/react-dom ./node_modules/react-dom
COPY --from=build --chown=node:node /app/node_modules/react-server-dom-webpack ./node_modules/react-server-dom-webpack
COPY --from=build --chown=node:node /app/node_modules/scheduler ./node_modules/scheduler
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node scripts/start-container.mjs ./scripts/start-container.mjs
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT}/api/health`).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "scripts/start-container.mjs"]
