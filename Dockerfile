# syntax=docker/dockerfile:1.7
FROM node:24-slim AS assets
WORKDIR /app
COPY package.json package-lock.json gulpfile.js ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --fund=false
COPY public ./public
COPY src ./src
RUN npm run build:ui

FROM golang:1.27.4-bookworm AS build
WORKDIR /src
COPY backend/go.mod backend/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY backend ./
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /anonymous-server ./cmd/server

FROM debian:bookworm-slim
LABEL science.4open.owner-alert-protocol="recipient-v2"
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* && useradd --uid 10001 --create-home anonymous
WORKDIR /app
COPY --from=build /anonymous-server /usr/local/bin/anonymous-server
COPY --from=build /src/licenses /usr/share/licenses/anonymous-github
COPY --from=assets --chown=10001:10001 /app/public ./public
RUN mkdir /app/repositories && chown 10001:10001 /app/repositories
USER 10001:10001
ENV PORT=5000 PUBLIC_DIR=/app/public FOLDER=/app/repositories COOKIE_SECURE=true GOMEMLIMIT=768MiB
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD ["/usr/local/bin/anonymous-server", "healthcheck"]
EXPOSE 5000
ENTRYPOINT ["/usr/local/bin/anonymous-server"]
