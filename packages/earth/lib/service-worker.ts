/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * The Earth service worker. `vite-plugin-pwa` injects the precache manifest into this file — the app shell, its
 * hashed assets, the icons and the manifest — and no code here precaches a model, a database or a tile.
 *
 * The worker also carries the range-chunk cache for the byte-range databases the resolver reads from the data
 * origin: every validated 64 KB range chunk of a versioned, immutable URL is stored in Cache Storage keyed by URL
 * and offset, and each chunk's body length is checked against its Content-Range because Mobile Safari's http cache
 * can hand back a torn chunk (a truncated body for a 206) that reaches SQLite as "database disk image is
 * malformed" — a torn chunk is refetched once with `cache: "no-store"`, and the readers' own cache-busting retry
 * stays as the backstop for browsers without service workers.
 *
 * Non-database requests are never intercepted (no `respondWith`); sql.js-httpvfs issues its range reads as
 * synchronous XHR inside a dedicated worker, which still routes through here because a dedicated worker inherits
 * its creator document's controller, and the page posts {@link PruneMessage} after a release is selected and chunks
 * from other releases are dropped.
 */

/// <reference lib="webworker" />

import { precacheAndRoute } from "workbox-precaching"

import { PRODUCTION_CONFIG } from "#config"
import { PRUNE_MESSAGE_TYPE, type PruneMessage } from "#runtime/range-cache"

declare const self: ServiceWorkerGlobalScope

precacheAndRoute(self.__WB_MANIFEST)

// #region Range cache

const HTTP_PARTIAL_CONTENT = 206

const CACHE_NAME = "mailwoman-db-ranges-v1"
const DB_HOST = PRODUCTION_CONFIG.dataOriginURL.hostname

interface ValidatedChunk {
	body: ArrayBuffer
	contentRange: string
}

function isPruneMessage(data: unknown): data is PruneMessage {
	return (
		typeof data === "object" &&
		data !== null &&
		(data as { type?: unknown }).type === PRUNE_MESSAGE_TYPE &&
		typeof (data as { keepVersion?: unknown }).keepVersion === "string"
	)
}

self.addEventListener("install", () => {
	void self.skipWaiting()
})

self.addEventListener("activate", (event) => {
	event.waitUntil(self.clients.claim())
})

self.addEventListener("message", (event) => {
	if (isPruneMessage(event.data)) {
		event.waitUntil(pruneOtherVersions(event.data.keepVersion))
	}
})

self.addEventListener("fetch", (event) => {
	const request = event.request

	if (request.method !== "GET") return

	let url: URL

	try {
		url = new URL(request.url)
	} catch {
		return
	}

	// Only the database files with plain URLs: a `?cb=` cache-busting retry from the
	// readers asks for untouched fresh bytes, so it bypasses this cache entirely.
	if (url.hostname !== DB_HOST || !url.pathname.endsWith(".db") || url.search !== "") return

	const range = request.headers.get("range")
	const match = range ? /^bytes=(\d+)-(\d+)$/u.exec(range) : null

	if (!match) return

	event.respondWith(respondWithCachedRange(request, url.href, Number(match[1]), Number(match[2])))
})

async function respondWithCachedRange(request: Request, href: string, start: number, end: number): Promise<Response> {
	try {
		const cache = await caches.open(CACHE_NAME)
		// The Cache API rejects 206 responses, so chunks are stored as 200s under a synthetic
		// per-range URL with the real Content-Range in a header for reconstruction.
		const cacheKey = `${href}?mwrange=${start}-${end}`
		const hit = await cache.match(cacheKey)

		if (hit) {
			const contentRange = hit.headers.get("x-mw-content-range")
			const body = await hit.arrayBuffer()

			if (contentRange && body.byteLength === rangeLength(contentRange)) {
				return rangeResponse(body, contentRange)
			}

			// An unreadable entry falls through to the network.
			await cache.delete(cacheKey)
		}

		let response = await fetch(request)
		let chunk = response.status === HTTP_PARTIAL_CONTENT ? await validatedChunk(response) : null

		if (!chunk && response.status === HTTP_PARTIAL_CONTENT) {
			// A torn chunk out of the http cache: force fresh bytes once.
			response = await fetch(href, {
				method: "GET",
				mode: "cors",
				credentials: "omit",
				cache: "no-store",
				headers: { range: `bytes=${start}-${end}` },
			})

			chunk = response.status === HTTP_PARTIAL_CONTENT ? await validatedChunk(response) : null
		}

		if (!chunk) return response

		await cache.put(
			cacheKey,
			new Response(chunk.body.slice(0), {
				status: 200,
				headers: {
					"content-type": "application/octet-stream",
					"x-mw-content-range": chunk.contentRange,
				},
			})
		)

		return rangeResponse(chunk.body, chunk.contentRange)
	} catch {
		return fetch(request)
	}
}

/**
 * Read a 206 response's body and verify its length against the Content-Range header,
 * which is the truth because a file's final chunk is legitimately shorter than requested;
 * null for a torn body or an unparsable header.
 */
async function validatedChunk(response: Response): Promise<ValidatedChunk | null> {
	const contentRange = response.headers.get("content-range")
	const expected = contentRange ? rangeLength(contentRange) : null

	if (expected === null || contentRange === null) return null

	const body = await response.arrayBuffer()

	if (body.byteLength !== expected) return null

	return { body, contentRange }
}

function rangeLength(contentRange: string): number | null {
	const parsed = /^bytes (\d+)-(\d+)\/(?:\d+|\*)$/u.exec(contentRange)

	if (!parsed) return null

	return Number(parsed[2]) - Number(parsed[1]) + 1
}

function rangeResponse(body: ArrayBuffer, contentRange: string): Response {
	return new Response(body, {
		status: HTTP_PARTIAL_CONTENT,
		statusText: "Partial Content",
		headers: {
			"content-type": "application/octet-stream",
			"content-length": String(body.byteLength),
			"content-range": contentRange,
		},
	})
}

async function pruneOtherVersions(keepVersion: string): Promise<void> {
	const cache = await caches.open(CACHE_NAME)
	const keepSegment = `/${keepVersion}/`

	for (const request of await cache.keys()) {
		if (!new URL(request.url).pathname.includes(keepSegment)) {
			await cache.delete(request)
		}
	}
}

// #endregion
