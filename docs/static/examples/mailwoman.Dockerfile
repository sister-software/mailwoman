# syntax=docker/dockerfile:1
#
# A minimal Mailwoman image you build yourself, for the case where the published
# ghcr.io/sister-software/mailwoman image does not fit: you want a different dependency set, a pinned
# version line, or your own entrypoint.
#
# Derived from the repo-root Dockerfile that produces the published image. Every constraint below is
# one that file already encodes; the differences are that versions are pinned rather than "latest",
# the dependency set is parse-plus-geocode rather than every drop-in server, and the entrypoint is
# yours.
#
# linux/amd64 only. onnxruntime-node ships glibc x64 prebuilds, so the base is Debian slim — an Alpine
# (musl) base has no prebuild to install.

# ---- install stage: fetch the published npm packages ----
FROM node:24-slim AS install

WORKDIR /app

# Pin the line you tested against. The published image uses "latest" on purpose, so that each rebuild
# integration-tests the current release; a deployment usually wants the opposite.
RUN npm init -y >/dev/null \
	&& npm install --omit=dev --no-audit --no-fund --loglevel=error \
		mailwoman@8.7.0 \
		@mailwoman/neural@8.7.0 \
		@mailwoman/neural-weights-en-us@8.7.0 \
		@mailwoman/resolver@8.7.0 \
		@mailwoman/resolver-wof-sqlite@8.7.0 \
	&& npm cache clean --force

# Drop the ONNX Runtime binaries this image can never load: the other two platforms, and the CUDA and
# TensorRT execution providers. Measured on linux/x64: 746 MB of node_modules becomes 303 MB, and CPU
# inference is unaffected because it loads libonnxruntime.so.1 and onnxruntime_binding.node only.
RUN rm -rf node_modules/onnxruntime-node/bin/napi-v6/win32 \
		node_modules/onnxruntime-node/bin/napi-v6/darwin \
	&& rm -f node_modules/onnxruntime-node/bin/napi-v6/linux/x64/libonnxruntime_providers_cuda.so \
		node_modules/onnxruntime-node/bin/napi-v6/linux/x64/libonnxruntime_providers_tensorrt.so

# ---- runtime stage ----
FROM node:24-slim AS runtime

# libgomp1 is the OpenMP runtime onnxruntime-node links for threaded inference. Everything else the
# prebuilt binary needs (libstdc++6, libc) is already in node:24-slim.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends libgomp1 \
	&& rm -rf /var/lib/apt/lists/*

# MAILWOMAN_CANDIDATE_DB is baked as a DEFAULT so a reader who mounts a volume needs no `-e` flag. It is
# therefore set on every run, volume or not, which is why the entrypoint gates on the file existing
# rather than on the variable being set — see the note in mailwoman-server.mjs. Point it at the real
# file, not a symlink: an absolute-path symlink created on the host dangles inside the container.
ENV NODE_ENV=production \
	MAILWOMAN_DATA_ROOT=/data \
	MAILWOMAN_CANDIDATE_DB=/data/wof/candidate.db

WORKDIR /app

COPY --from=install --chown=node:node /app/node_modules ./node_modules
# The filename matches the example asset as downloaded, so `docker build` works on a directory holding
# the two files saved straight from the docs site.
COPY --chown=node:node mailwoman-server.mjs ./mailwoman-server.mjs

# Both resolver backends open SQLite read-only, so mount this `:ro`. Per-state rooftop shards are
# WAL-mode: keep their -wal and -shm siblings in the same mount, or those addresses fall back to a
# coarser resolution tier.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

# node:24-slim ships an unprivileged `node` user (uid 1000). Run as it, never root.
USER node

EXPOSE 3000

# Node 24 has global fetch, so the health check needs no curl or wget in the slim image. The start
# period covers the model load: measured at roughly 0.8 s on an idle x64 host, and a cold container
# on a throttled runtime is slower.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
	CMD ["node", "-e", "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "mailwoman-server.mjs"]
