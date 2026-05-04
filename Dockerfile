# syntax=docker/dockerfile:1
FROM node:21-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json gulpfile.js ./
COPY public ./public
COPY src ./src
RUN npm run build && npm prune --omit=dev && npm cache clean --force

FROM node:21-alpine AS runtime

ENV NODE_ENV=production
ENV PORT=5000
EXPOSE 5000

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/build ./build
COPY --from=builder /app/public ./public
COPY --from=builder /app/package.json ./package.json
COPY healthcheck.js ./healthcheck.js

CMD ["node", "./build/server/index.js"]
