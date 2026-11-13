// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * The Earth service worker.
 *
 * `vite-plugin-pwa` injects the precache manifest into this file: the app shell,
 * its hashed assets, the icons and the manifest.
 * The routes below cache what the page fetches from the data origin and the tile Worker,
 * so a page that loses its connection keeps the release it loaded and the tiles it drew.
 *
 * - A navigation loads the precached `index.html`.
 * - A file of the build that the precache leaves out, such as a `.wasm` runtime,
 *   is cache-first on first use.
 * - The staged SQLite runtime is stale-while-revalidate, because its file names have no content hash.
 * - A range read of a `.db` file goes to the range-chunk handler, and the
 *   handler stores each validated chunk.
 *   A `?cb=` retry from the readers asks for fresh bytes, so a URL with a query
 *   string skips the cache and goes to the range guard instead.
 *   Both handlers refuse an origin's whole-file answer to a range request.
 * - A whole-file read on the data origin is cache-first.
 *   Every path there's versioned, apart from `releases.json`.
 *   A request in `reload` or `no-store` mode, as the page's retries are,
 *   passes the stored copy and replaces it with the network's.
 * - `releases.json` and a tileset's TileJSON are network-first, so an offline page reads the last copy.
 * - A tile is cache-first, with an entry cap and a maximum age.
 *   A tile with no cached copy that the network cannot fetch answers 404.
 *   MapLibre reads a 404 as a missing tile: it logs no error and draws the
 *   nearest loaded parent tile in its place.
 *
 * The range reader issues its reads as synchronous XHR inside a dedicated worker, and those reads
 * still reach this worker because the dedicated worker inherits its creator document's controller.
 * The page posts a prune message after it selects a release, and this worker
 * then drops range chunks and release files of other releases.
 *
 * A deploy keeps the data caches: range chunks, release files, manifests and tiles.
 * Only the precache and the build's own files follow the build.
 *
 * A new worker installs and then waits.
 * It takes over only when a page posts `SKIP_WAITING`.
 *
 * Earth's "Update ready" prompt posts it, and every page an earlier worker served then reloads once.
 */

/// <reference lib="webworker" />

import { SERVED_FROM_HEADER } from "@mailwoman/core/load-ledger"
import {
	buildCacheName,
	deleteOtherBuildCaches,
	generationCacheName,
	roleCacheName,
} from "@mailwoman/service-worker-cache/build-caches"
import { answerCacheControl, isCacheControlMessage } from "@mailwoman/service-worker-cache/cache-control"
import { missingWhenUnreachablePlugin } from "@mailwoman/service-worker-cache/missing-when-unreachable"
import { isPruneMessage, pruneOtherVersions } from "@mailwoman/service-worker-cache/prune"
import { createRangeChunkHandler, createRangeGuardHandler } from "@mailwoman/service-worker-cache/range-chunks"
import { reloadBypassPlugin } from "@mailwoman/service-worker-cache/reload-bypass"
import { servedFromCachePlugin } from "@mailwoman/service-worker-cache/served-from"
import { isSkipWaitingMessage } from "@mailwoman/service-worker-cache/skip-waiting"
import { tornBodyPlugin } from "@mailwoman/service-worker-cache/torn-body"
import { CacheableResponsePlugin } from "workbox-cacheable-response"
import { ExpirationPlugin } from "workbox-expiration"
import { createHandlerBoundToURL, precacheAndRoute } from "workbox-precaching"
import { NavigationRoute, registerRoute } from "workbox-routing"
import { CacheFirst, NetworkFirst, StaleWhileRevalidate } from "workbox-strategies"

import { PRODUCTION_CONFIG } from "#config"
import { createReleaseArtifactLengthLookup } from "#release-artifact-length"

declare const self: ServiceWorkerGlobalScope

precacheAndRoute(self.__WB_MANIFEST)

// Earth routes in the page, so every navigation, such as `/debug`
// or `/?geocoder=local`, loads the same shell.
// The precache route matches a URL only after dropping `utm_*` and `fbclid`,
// so it answers none of these from the cache.
registerRoute(new NavigationRoute(createHandlerBoundToURL("index.html")))

/**
 * The build's short commit, as `vite.config.ts` defines it.
 */
declare const __MAILWOMAN_BUILD_COMMIT__: string

/**
 * Every runtime cache's name starts with this.
 *
 * On activation the worker deletes every cache with it outside {@linkcode CURRENT_CACHES}:
 * an earlier build's app-asset cache, and data caches that an earlier worker keyed by build commit.
 */
const CACHE_PREFIX = "mailwoman-"

// The data caches hold versioned or dated URLs, so every build shares them.
const RANGE_CACHE = roleCacheName(CACHE_PREFIX, "db-ranges")
const ASSET_CACHE = roleCacheName(CACHE_PREFIX, "release-assets")
const MANIFEST_CACHE = roleCacheName(CACHE_PREFIX, "manifests")

/**
 * The generation of the tile cache, part of its name, such as `mailwoman-tiles-g1`.
 *
 * Bump it on a deploy whose tiles changed under the same URLs.
 * A tile URL holds no version, and a Cloudflare purge never reaches a device's tile cache,
 * so without a bump a device draws its stored tiles until {@link MAX_TILE_AGE_SECONDS} expires them.
 *
 * Activation deletes the earlier generation's cache, and no other cache, on that account.
 */
const TILE_CACHE_GENERATION = 1

const TILE_CACHE = generationCacheName(CACHE_PREFIX, "tiles", TILE_CACHE_GENERATION)

// The build's own files, such as the staged SQLite runtime, can change under the same URL.
const APP_ASSET_CACHE = buildCacheName(CACHE_PREFIX, "app-assets", __MAILWOMAN_BUILD_COMMIT__)

const CURRENT_CACHES: ReadonlySet<string> = new Set([
	RANGE_CACHE,
	ASSET_CACHE,
	MANIFEST_CACHE,
	TILE_CACHE,
	APP_ASSET_CACHE,
])

/**
 * The build's own files kept outside the precache, such as its WebAssembly runtimes.
 */
const MAX_APP_ASSET_ENTRIES = 40

/**
 * The tiles kept on the device.
 *
 * The expiration plugin drops the least recently used tile past the cap,
 * and drops the whole cache on a quota error.
 */
const MAX_TILE_ENTRIES = 6000

/**
 * How long a stored tile answers before the network is asked again.
 *
 * A tile URL holds its tileset's ID and no version, so a rebuilt tileset keeps its URLs.
 * The tile cache survives deploys, and this age bounds how long a replaced tile is drawn.
 *
 * An offline page past it has no tile, and MapLibre draws the parent tile in its place.
 */
const MAX_TILE_AGE_SECONDS = 7 * 24 * 60 * 60

/**
 * The release files kept on the device: a release's model, tokenizer, FSTs,
 * postcode binaries and pair indexes.
 */
const MAX_ASSET_ENTRIES = 200

/**
 * How long a network-first route waits before it answers from the cache.
 */
const MANIFEST_NETWORK_TIMEOUT_SECONDS = 4

const DATA_HOST = PRODUCTION_CONFIG.dataOriginURL.hostname
const TILE_HOST = PRODUCTION_CONFIG.tileWorkerURL.hostname

/**
 * A tile path ends in `/<z>/<x>/<y>.<extension>`, the tile Worker's tile route.
 */
const TILE_PATH = /\/\d+\/\d+\/\d+\.[a-z0-9]+$/u

self.addEventListener("activate", (event) => {
	event.waitUntil(deleteOtherBuildCaches(caches, CACHE_PREFIX, CURRENT_CACHES).then(() => self.clients.claim()))
})

/**
 * The cache each role a page may report or clear maps to.
 *
 * The page names roles rather than caches, because the app-asset cache's name changes with each build.
 */
const CACHES_BY_ROLE: Readonly<Record<string, string>> = {
	"db-ranges": RANGE_CACHE,
	"release-assets": ASSET_CACHE,
	manifests: MANIFEST_CACHE,
	tiles: TILE_CACHE,
	"app-assets": APP_ASSET_CACHE,
}

self.addEventListener("message", (event) => {
	if (isSkipWaitingMessage(event.data)) {
		event.waitUntil(self.skipWaiting())

		return
	}

	if (isCacheControlMessage(event.data)) {
		const [port] = event.ports

		event.waitUntil(answerCacheControl(event.data, caches, CACHES_BY_ROLE).then((reply) => port?.postMessage(reply)))

		return
	}

	if (isPruneMessage(event.data)) {
		const { keepVersion } = event.data

		event.waitUntil(
			Promise.all(
				[RANGE_CACHE, ASSET_CACHE].map(async (name) => pruneOtherVersions(await caches.open(name), keepVersion))
			)
		)
	}
})

// The build's hashed files that the precache leaves out, such as onnxruntime's 14.8 MB `.wasm`:
// stored on first use, so a visitor who never loads the browser model never downloads them.
registerRoute(
	({ url }) => url.origin === self.location.origin && url.pathname.startsWith("/assets/"),
	new CacheFirst({
		cacheName: APP_ASSET_CACHE,
		plugins: [
			reloadBypassPlugin(),
			new CacheableResponsePlugin({ statuses: [200] }),
			tornBodyPlugin(),
			new ExpirationPlugin({ maxEntries: MAX_APP_ASSET_ENTRIES, purgeOnQuotaError: true }),
			servedFromCachePlugin(SERVED_FROM_HEADER),
		],
	})
)

// The SQLite runtime the range reader loads from `PRODUCTION_CONFIG.sqliteRuntimeBaseURL`.
// Its file names have no content hash, so a cached copy answers at once
// and the network's copy replaces it for the next load.
registerRoute(
	({ url }) =>
		url.origin === self.location.origin && url.pathname.startsWith(`${PRODUCTION_CONFIG.sqliteRuntimeBaseURL}/`),
	new StaleWhileRevalidate({
		cacheName: APP_ASSET_CACHE,
		plugins: [new CacheableResponsePlugin({ statuses: [200] }), tornBodyPlugin()],
	})
)

registerRoute(
	({ url, request }) =>
		url.hostname === DATA_HOST && url.pathname.endsWith(".db") && url.search === "" && request.headers.has("range"),
	createRangeChunkHandler({ cacheName: RANGE_CACHE })
)

registerRoute(
	({ url, request }) =>
		url.hostname === DATA_HOST && url.pathname.endsWith(".db") && url.search !== "" && request.headers.has("range"),
	createRangeGuardHandler()
)

registerRoute(
	({ url }) => (url.hostname === DATA_HOST || url.hostname === TILE_HOST) && url.pathname.endsWith(".json"),
	new NetworkFirst({
		cacheName: MANIFEST_CACHE,
		networkTimeoutSeconds: MANIFEST_NETWORK_TIMEOUT_SECONDS,
		plugins: [new CacheableResponsePlugin({ statuses: [200] })],
	})
)

const releaseArtifactLength = createReleaseArtifactLengthLookup(async (manifestURL) => {
	const cached = await caches.match(manifestURL, { cacheName: MANIFEST_CACHE })

	return cached ? ((await cached.json()) as unknown) : null
})

registerRoute(
	({ url, request }) => url.hostname === DATA_HOST && url.search === "" && !request.headers.has("range"),
	new CacheFirst({
		cacheName: ASSET_CACHE,
		plugins: [
			reloadBypassPlugin(),
			new CacheableResponsePlugin({ statuses: [200] }),
			// A release file served without `Content-Length` is checked against the length
			// its locale's cached `releases.json` records.
			tornBodyPlugin({ expectedLength: releaseArtifactLength }),
			new ExpirationPlugin({ maxEntries: MAX_ASSET_ENTRIES, purgeOnQuotaError: true }),
			servedFromCachePlugin(SERVED_FROM_HEADER),
		],
	})
)

registerRoute(
	({ url }) => url.hostname === TILE_HOST && TILE_PATH.test(url.pathname),
	new CacheFirst({
		cacheName: TILE_CACHE,
		plugins: [
			new CacheableResponsePlugin({ statuses: [200] }),
			tornBodyPlugin(),
			new ExpirationPlugin({
				maxEntries: MAX_TILE_ENTRIES,
				maxAgeSeconds: MAX_TILE_AGE_SECONDS,
				purgeOnQuotaError: true,
			}),
			missingWhenUnreachablePlugin(),
		],
	})
)
