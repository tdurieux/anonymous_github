# syntax=docker/dockerfile:1.7

# Stage 1: install all deps (with cache mount so npm cache survives across builds)
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,id=npm-all,target=/root/.npm,sharing=locked \
    npm ci --prefer-offline --no-audit --fund=false

# Stage 2: build TypeScript + gulp assets. Source changes only invalidate from here.
FROM node:22-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json gulpfile.js ./
COPY public ./public
COPY src ./src
RUN npm run build

# Stage 3: install production deps on the runtime's libc. Native optional
# dependencies such as zstd must select musl binaries for the Alpine runtime.
FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,id=npm-prod,target=/root/.npm,sharing=locked \
    npm ci --omit=dev --prefer-offline --no-audit --fund=false

# Stage 4: minimal runtime
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
ENV PORT=5000
EXPOSE 5000
WORKDIR /app

COPY --from=prod-deps /app/node_modules ./node_modules
RUN node -e "const assert = require('node:assert/strict'); const zstd = require('@mongodb-js/zstd'); (async () => { const input = Buffer.from('native compression smoke test'); const compressed = await zstd.compress(input, 3); assert.deepEqual(await zstd.decompress(compressed), input); })().catch(error => { console.error(error); process.exit(1); });"
COPY --from=build /app/build ./build
COPY --from=build /app/public ./public
COPY package.json ./package.json
COPY healthcheck.js ./healthcheck.js

CMD ["node", "--max-old-space-size=2048", "./build/server/index.js"]
