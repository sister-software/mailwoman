# syntax=docker/dockerfile:1
#
# The overlay tile build as one image: `mailwoman tiles overlays` with the `hrt` program on its path.
#
# A run starts from an empty work directory. It clones the Who's On First admin repositories from the
# `mailwoman` forks, copies the admin database from S3, reads Overture divisions from Overture's bucket,
# builds the `wof` and `gazetteer` archives and publishes them to the tile worker's R2 bucket.
# docs/engineering/reference/overlay-tiles.mdx is the runbook.
#
# Unlike the product image in ../Dockerfile, this image builds the monorepo at the checked-out commit,
# because the build commands are tooling and never ship to npm. Build it from the repository root:
#
#   podman build -f docker/overlay-tiles.Dockerfile -t mailwoman-overlay-tiles .
#
# docker/overlay-tiles.Dockerfile.dockerignore keeps installs, build output and data out of the context.

# ---- hrt: the tile builder. GEOS builds from source, so the stage needs cmake and a C++ compiler. ----
FROM docker.io/library/rust:1.99.1-bookworm AS hrt

RUN apt-get update \
	&& apt-get install -y --no-install-recommends cmake clang \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /repo

COPY . .

RUN cargo build --release -p hrt-cli

# ---- app: the compiled monorepo ----
FROM docker.io/library/node:24.22.3-bookworm AS app

WORKDIR /repo

COPY . .

RUN corepack enable \
	&& yarn install --immutable \
	&& yarn compile

# The compile needs every workspace's dev dependencies, and the run needs only the production closure of
# docker/overlay-tiles/package.json. The focus reinstalls node_modules as that closure, so the runtime copy
# holds what the manifests declare and none of the build and lint tooling.
RUN yarn workspaces focus --production @mailwoman/overlay-tiles-image

# ---- runtime ----
FROM docker.io/library/node:24.22.3-bookworm-slim AS runtime

# git clones the repositories, aws copies the admin database from S3, and rclone uploads to R2.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends git ca-certificates awscli rclone libgomp1 \
	&& rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
	MAILWOMAN_DATA_ROOT=/work/data

COPY --from=app /repo /repo
COPY --from=hrt /repo/target/release/hrt /usr/local/bin/hrt

WORKDIR /repo

# The work directory holds the clones, the exports and the hrt sort files. Mount instance scratch here.
VOLUME ["/work"]

ENTRYPOINT ["node", "packages/mailwoman/out/cli/main.js", "tiles", "overlays", "--work", "/work"]
