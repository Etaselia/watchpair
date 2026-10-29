ARG NODE_IMAGE=node:24.22.2-bookworm-slim
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY coordinator/package.json coordinator/package-lock.json ./
RUN npm ci
COPY coordinator/tsconfig.json ./
COPY coordinator/src ./src
RUN npm run build && npm prune --omit=dev

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
RUN mkdir /data && chown node:node /data
USER node
STOPSIGNAL SIGTERM
CMD ["node", "dist/src/main.js"]
