/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Range-chunk cache for the sql.js-httpvfs databases (wof-hot.db / wof-polygons.db, range-loaded
 *   from public.sister.software). Two jobs:
 *
 *   1. PERSISTENCE — the DB URLs are versioned + immutable, so every validated 64 KB range chunk is
 *        stored in Cache Storage keyed by url+offset. A repeat visit replays the warm-up and
 *        cascade reads entirely from disk: near-zero network, instant resolves.
 *   2. INTEGRITY — mobile Safari's HTTP cache can hand back a TORN range chunk (truncated body for a
 *        206), which surfaces in SQLite as "database disk image is malformed". Every chunk's body
 *        length is checked against its Content-Range BEFORE it is cached or served; a torn chunk is
 *        refetched once with `cache: "no-store"`. The app-level cache-busting retry in
 *        httpvfs-resolver.ts stays as a backstop for browsers without service workers.
 *
 *   Scope is the site root so both /demo and the PipelineExplorer embeds on article pages are
 *   covered. Non-DB requests are never intercepted (no respondWith → browser default), so the rest
 *   of the site pays only SW boot, not a proxy hop. sql.js-httpvfs issues its range reads as
 *   synchronous XHR inside a dedicated worker; those requests still route through this SW because
 *   dedicated workers inherit their creator document's controller.
 *
 *   The page posts {type: "mailwoman-prune-db-ranges", keepVersion} after version selection
 *   (register-range-sw.ts) and chunks from other versions are dropped — immutable URLs never expire
 *   on their own.
 */

const CACHE_NAME = "mailwoman-db-ranges-v1"
const DB_HOST = "public.sister.software"

self.addEventListener("install", () => {
	void self.skipWaiting()
})

self.addEventListener("activate", (event) => {
	event.waitUntil(self.clients.claim())
})

self.addEventListener("message", (event) => {
	const data = event.data

	if (data && data.type === "mailwoman-prune-db-ranges" && typeof data.keepVersion === "string") {
		event.waitUntil(pruneOtherVersions(data.keepVersion))
	}
})

self.addEventListener("fetch", (event) => {
	const request = event.request

	if (request.method !== "GET") return
	let url

	try {
		url = new URL(request.url)
	} catch {
		return
	}

	// Only the DB files, and only their plain URLs — a `?cb=` cache-busting retry from the app means
	// "give me untouched fresh bytes", so it bypasses this cache entirely.
	if (url.hostname !== DB_HOST || !url.pathname.endsWith(".db") || url.search !== "") return
	const range = request.headers.get("range")
	const match = range ? /^bytes=(\d+)-(\d+)$/.exec(range) : null

	if (!match) return
	event.respondWith(respondWithCachedRange(request, url.href, Number(match[1]), Number(match[2])))
})

/** Serve a range chunk from Cache Storage, falling back to a validated network fetch. */
async function respondWithCachedRange(request, href, start, end) {
	try {
		const cache = await caches.open(CACHE_NAME)
		// Cache API rejects 206 responses, so chunks are stored as 200s under a synthetic per-range
		// URL, with the real Content-Range stashed in a header for reconstruction.
		const cacheKey = `${href}?mwrange=${start}-${end}`
		const hit = await cache.match(cacheKey)

		if (hit) {
			const contentRange = hit.headers.get("x-mw-content-range")
			const body = await hit.arrayBuffer()

			if (contentRange && body.byteLength === rangeLength(contentRange)) {
				return rangeResponse(body, contentRange)
			}
			await cache.delete(cacheKey) // unreadable entry — fall through to network
		}

		let response = await fetch(request)
		let chunk = response.status === 206 ? await validatedChunk(response) : null

		if (!chunk && response.status === 206) {
			// Torn chunk out of the HTTP cache (the Safari failure mode) — force fresh bytes once.
			response = await fetch(href, {
				method: "GET",
				mode: "cors",
				credentials: "omit",
				cache: "no-store",
				headers: { range: `bytes=${start}-${end}` },
			})
			chunk = response.status === 206 ? await validatedChunk(response) : null
		}

		if (!chunk) return response // 200/4xx/5xx or still torn — hand it to the app untouched

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
 * Read a 206 response's body and verify its length against the Content-Range header. The final chunk of a file is
 * legitimately shorter than requested — the header, not the request, is truth. Returns null for a torn body or an
 * unparsable header.
 */
async function validatedChunk(response) {
	const contentRange = response.headers.get("content-range")
	const expected = contentRange ? rangeLength(contentRange) : null

	if (expected === null) return null
	const body = await response.arrayBuffer()

	if (body.byteLength !== expected) return null

	return { body, contentRange }
}

/** Byte count described by a `bytes start-end/total` Content-Range header, or null. */
function rangeLength(contentRange) {
	const parsed = /^bytes (\d+)-(\d+)\/(?:\d+|\*)$/.exec(contentRange)

	if (!parsed) return null

	return Number(parsed[2]) - Number(parsed[1]) + 1
}

/** Reconstruct the 206 the worker's XHR expects from a validated chunk. */
function rangeResponse(body, contentRange) {
	return new Response(body, {
		status: 206,
		statusText: "Partial Content",
		headers: {
			"content-type": "application/octet-stream",
			"content-length": String(body.byteLength),
			"content-range": contentRange,
		},
	})
}

/** Drop cached chunks whose URL path doesn't include the kept version segment. */
async function pruneOtherVersions(keepVersion) {
	const cache = await caches.open(CACHE_NAME)
	const keepSegment = `/${keepVersion}/`

	for (const request of await cache.keys()) {
		if (!new URL(request.url).pathname.includes(keepSegment)) {
			await cache.delete(request)
		}
	}
}
