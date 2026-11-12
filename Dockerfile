# syntax=docker/dockerfile:1
#
# ghcr.io/sister-software/mailwoman — "docker run → geocoding endpoint" for non-JS stacks.
#
# The image installs the published @mailwoman/* packages from npm rather than building the monorepo:
# mailwoman, the native API and the drop-in servers, with the weights. What runs here is what a consumer
# installs. docker/package.json lists the packages, and docker/server.ts is the entrypoint, a native /v1
# API that answers parse requests when no data volume is mounted.
#
# MAILWOMAN_VERSION sets the version of every package. The publish workflow passes the release version,
# so a tagged image holds the packages of that release. A build without the argument installs `latest`.
#
# Model WEIGHTS ship IN the image (they arrive with @mailwoman/neural-weights-en-us). The gazetteer /
# resolver DBs are volume-mounted read-only at $MAILWOMAN_DATA_ROOT (=/data): `-v <host-data>:/data:ro`.
# Parse works with no volume; geocode lights up when /data holds a gazetteer.
#
# linux/amd64 only for now — onnxruntime-node ships glibc x64 prebuilds and the runtime base is Debian
# slim (glibc, NOT musl/alpine). arm64 is a follow-up (needs the arm64 ORT prebuild verified).

# ---- install stage: resolve + fetch the published npm packages ----
FROM node:24.22.1-slim AS install

ARG MAILWOMAN_VERSION=latest

WORKDIR /app

COPY docker/package.json ./package.json

# Every package in docker/package.json is set to MAILWOMAN_VERSION before the install. The release
# moves all @mailwoman/* packages in lockstep, so one version names a consistent set.
# onnxruntime-node's postinstall downloads its native binary here, which needs network at build time.
RUN node -e "const fs = require('node:fs'); const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8')); for (const name of Object.keys(manifest.dependencies)) manifest.dependencies[name] = process.env.MAILWOMAN_VERSION; fs.writeFileSync('package.json', JSON.stringify(manifest, null, 2))" \
	&& npm install --omit=dev --no-audit --no-fund --loglevel=error \
	&& npm cache clean --force

# ---- runtime stage ----
FROM node:24.22.1-slim AS runtime

# libgomp1 = the OpenMP runtime onnxruntime-node links for threaded ONNX inference. Everything else the
# prebuilt ORT binary needs (libstdc++6, libc) is already in node:24.22.1-slim.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends libgomp1 \
	&& rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
	MAILWOMAN_DATA_ROOT=/data

WORKDIR /app

COPY --from=install --chown=node:node /app/node_modules ./node_modules
COPY --from=install --chown=node:node /app/package.json ./package.json
# Node 24 strips the types of a .ts file outside node_modules, so the entrypoint runs as source.
COPY --chown=node:node docker/server.ts ./server.ts

# Gazetteer / resolver DBs mount here read-only. Empty (the default) → the server boots parse-only.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

# node:24-slim ships an unprivileged `node` user (uid 1000) — run as it, never root.
USER node

# The container always listens on 3000; remap the host side with `docker run -p <host>:3000`.
EXPOSE 3000

# Node 24 has global fetch, so the healthcheck needs no curl/wget in the slim image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
	CMD ["node", "-e", "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

LABEL org.opencontainers.image.title="mailwoman" \
	org.opencontainers.image.description="Mailwoman postal-address parser + geocoder — native /v1 HTTP API (parse, geocode, batch, format). Weights baked in; gazetteer volume-mounted at /data." \
	org.opencontainers.image.source="https://github.com/sister-software/mailwoman" \
	org.opencontainers.image.url="https://mailwoman.post" \
	org.opencontainers.image.documentation="https://mailwoman.post/docs" \
	org.opencontainers.image.licenses="AGPL-3.0-only OR LicenseRef-Commercial" \
	org.opencontainers.image.vendor="Sister Software"

# Default: the native /v1 API. Drop-in servers are also installed — override CMD to run one instead:
#   node node_modules/@mailwoman/nominatim/out/cli/main.js   (Nominatim-compatible /search /reverse, port 8080)
#   node node_modules/@mailwoman/photon/out/cli/main.js       (Photon-compatible /api /reverse, port 2322)
#   node node_modules/@mailwoman/libpostal/out/cli/main.js    (libpostal-compatible /parse /expand, port 8081)
# See docker/README.md + docker/docker-compose.yml.
CMD ["node", "server.ts"]
