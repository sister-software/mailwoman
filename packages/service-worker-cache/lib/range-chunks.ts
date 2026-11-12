// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   A Workbox route handler that stores byte-range responses of immutable,
 *   versioned files in Cache Storage, one entry per requested range.
 *
 *   The Cache API rejects a 206 response, so each chunk is stored as a 200 under a synthetic
 *   per-range URL, with the original `Content-Range` in a header, and rebuilt into a 206 on a hit.
 *
 *   Mobile Safari's HTTP cache can hand back a 206 whose body is shorter than its `Content-Range` states.
 *   SQLite reads such a torn chunk as "database disk image is malformed".
 *
 *   The handler checks every chunk's length against its `Content-Range`, refetches a torn
 *   chunk once with `cache: "no-store"`, and stores only a chunk that passes.
 *
 *   An origin can also answer a range request with a 200 and the whole file,
 *   as a cache that bypassed the range did for a 2.88 GB gazetteer database.
 *   The reader issues its reads as synchronous XHR, which buffers that body in full
 *   before the reader can see its status.
 *
 *   The handler therefore cancels such a body, refetches once with `cache: "no-store"`, and answers a
 *   second whole-file response with a bodiless 502 marked by {@linkcode RANGE_REFUSED_HEADER}.
 */

import type { RouteHandlerCallbackOptions, RouteHandlerObject } from "workbox-core/types.js"

const HTTP_PARTIAL_CONTENT = 206
const HTTP_BAD_GATEWAY = 502

/**
 * The header on the 502 the handlers answer with when the network sent the
 * whole file for a closed range twice.
 */
export const RANGE_REFUSED_HEADER = "x-mw-range-refused"

/**
 * The header a stored chunk keeps its original `Content-Range` in.
 */
const STORED_CONTENT_RANGE_HEADER = "x-mw-content-range"

/**
 * The part of Cache Storage the handler uses: `CacheStorage` satisfies it, and
 * so does a test's in-memory store.
 */
export interface RangeChunkCacheStorage {
	open(cacheName: string): Promise<Pick<Cache, "match" | "put" | "delete">>
}

export interface RangeChunkHandlerOptions {
	/**
	 * The Cache Storage cache the chunks go in.
	 */
	cacheName: string

	/**
	 * @defaultValue `globalThis.caches`
	 */
	cacheStorage?: RangeChunkCacheStorage

	/**
	 * @defaultValue `globalThis.fetch`
	 */
	fetch?: typeof fetch
}

/**
 * The inclusive byte offsets of a `Range: bytes=<start>-<end>` request header,
 * or `null` for any other form.
 *
 * The handler stores only a closed range, because an open or multi-part range has no fixed key.
 */
export function parseClosedRange(header: string | null): { start: number; end: number } | null {
	const match = header ? /^bytes=(\d+)-(\d+)$/u.exec(header) : null

	return match ? { start: Number(match[1]), end: Number(match[2]) } : null
}

/**
 * The byte count a `Content-Range: bytes <start>-<end>/<size>` header states,
 * or `null` for an unparsable header.
 */
export function contentRangeLength(contentRange: string): number | null {
	const parsed = /^bytes (\d+)-(\d+)\/(?:\d+|\*)$/u.exec(contentRange)

	return parsed ? Number(parsed[2]) - Number(parsed[1]) + 1 : null
}

interface ValidatedChunk {
	body: ArrayBuffer
	contentRange: string
}

/**
 * The body of a 206 response whose length matches its `Content-Range`, or `null`
 * for a torn body, another status or an unparsable header.
 */
async function validatedChunk(response: Response): Promise<ValidatedChunk | null> {
	if (response.status !== HTTP_PARTIAL_CONTENT) return null

	const contentRange = response.headers.get("content-range")
	const expected = contentRange ? contentRangeLength(contentRange) : null

	if (expected == null || !contentRange) return null

	// The clone leaves the response itself readable, so a torn chunk can still pass through.
	const body = await response.clone().arrayBuffer()

	return body.byteLength === expected ? { body, contentRange } : null
}

function partialResponse(body: ArrayBuffer, contentRange: string): Response {
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

/**
 * The key a range is stored under: the file's URL with the range appended as a query parameter.
 */
export function rangeChunkKey(href: string, start: number, end: number): string {
	return `${href}?mwrange=${start}-${end}`
}

/**
 * Whether a response to a closed range carries the whole file: a success status other than 206.
 */
function isWholeFileAnswer(response: Response): boolean {
	return response.ok && response.status !== HTTP_PARTIAL_CONTENT
}

/**
 * Releases a response's unread body, so a whole-file answer stops downloading.
 */
async function discard(response: Response): Promise<void> {
	await response.body?.cancel().catch(() => {
		// A body that already failed has nothing left to release.
	})
}

function rangeRefusedResponse(): Response {
	return new Response(null, {
		status: HTTP_BAD_GATEWAY,
		statusText: "Range Not Honored",
		headers: { [RANGE_REFUSED_HEADER]: "1" },
	})
}

/**
 * The network's answer to one closed range: a validated chunk, or a response to pass through.
 */
type NetworkRangeAnswer = { chunk: ValidatedChunk } | { response: Response }

/**
 * Fetches a closed range, refetching once with `cache: "no-store"` when the first
 * answer is a torn 206 or a whole-file response.
 *
 * A second whole-file response is never passed through.
 * Its body is cancelled and the answer is a 502 marked by {@linkcode RANGE_REFUSED_HEADER}.
 *
 * Any other status, such as a 404 or a 416, passes through unchanged.
 */
async function fetchRangeFromNetwork(
	fetchFromNetwork: typeof fetch,
	request: Request,
	range: { start: number; end: number }
): Promise<NetworkRangeAnswer> {
	let response = await fetchFromNetwork(request.clone())
	let chunk = await validatedChunk(response)

	if (!chunk && (response.status === HTTP_PARTIAL_CONTENT || isWholeFileAnswer(response))) {
		await discard(response)

		response = await fetchFromNetwork(request.url, {
			method: "GET",
			mode: "cors",
			credentials: "omit",
			cache: "no-store",
			headers: { range: `bytes=${range.start}-${range.end}` },
		})

		chunk = await validatedChunk(response)
	}

	if (chunk) {
		await discard(response)

		return { chunk }
	}

	if (isWholeFileAnswer(response)) {
		await discard(response)

		return { response: rangeRefusedResponse() }
	}

	return { response }
}

/**
 * Creates a route handler that applies the whole-file check of
 * {@linkcode createRangeChunkHandler} without Cache Storage.
 *
 * Register it on range requests that must reach the network, such as a reader's
 * cache-busting `?cb=` retry, so that retry can't download a whole file either.
 */
export function createRangeGuardHandler(options: Pick<RangeChunkHandlerOptions, "fetch"> = {}): RouteHandlerObject {
	const fetchFromNetwork = options.fetch ?? globalThis.fetch.bind(globalThis)

	return {
		handle: async ({ request }: RouteHandlerCallbackOptions): Promise<Response> => {
			const range = parseClosedRange(request.headers.get("range"))

			if (!range) return fetchFromNetwork(request)

			const answer = await fetchRangeFromNetwork(fetchFromNetwork, request, range)

			return "chunk" in answer ? partialResponse(answer.chunk.body, answer.chunk.contentRange) : answer.response
		},
	}
}

type ChunkCache = Pick<Cache, "match" | "put" | "delete">

/**
 * The stored chunk for `key` when its length matches its recorded `Content-Range`.
 *
 * An entry that fails the check is deleted.
 */
async function storedChunk(cache: ChunkCache, key: string): Promise<ValidatedChunk | null> {
	const hit = await cache.match(key)

	if (!hit) return null

	const contentRange = hit.headers.get(STORED_CONTENT_RANGE_HEADER)
	const body = await hit.arrayBuffer()

	if (contentRange && body.byteLength === contentRangeLength(contentRange)) return { body, contentRange }

	await cache.delete(key)

	return null
}

/**
 * Creates the range-chunk route handler.
 *
 * Register it on a route that matches only GET range requests of immutable files without a query string.
 * A request whose `Range` header isn't a closed range goes to the network unchanged.
 *
 * A failure inside the cache, such as a quota error, leaves the chunk unstored,
 * and the network's answer is returned under the same checks.
 */
export function createRangeChunkHandler(options: RangeChunkHandlerOptions): RouteHandlerObject {
	const fetchFromNetwork = options.fetch ?? globalThis.fetch.bind(globalThis)

	return {
		handle: async ({ request }: RouteHandlerCallbackOptions): Promise<Response> => {
			const range = parseClosedRange(request.headers.get("range"))

			if (!range) return fetchFromNetwork(request)

			const key = rangeChunkKey(request.url, range.start, range.end)

			const cache = await (options.cacheStorage ?? globalThis.caches).open(options.cacheName).catch(() => null)
			const hit = cache ? await storedChunk(cache, key).catch(() => null) : null

			if (hit) return partialResponse(hit.body, hit.contentRange)

			const answer = await fetchRangeFromNetwork(fetchFromNetwork, request, range)

			if (!("chunk" in answer)) return answer.response

			const { body, contentRange } = answer.chunk

			await cache
				?.put(
					key,
					new Response(body.slice(0), {
						status: 200,
						headers: {
							"content-type": "application/octet-stream",
							[STORED_CONTENT_RANGE_HEADER]: contentRange,
						},
					})
				)
				.catch(() => {
					// A chunk the cache can't store, as on a quota error, is still the answer.
				})

			return partialResponse(body, contentRange)
		},
	}
}
