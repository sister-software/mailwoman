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
 */

import type { RouteHandlerCallbackOptions, RouteHandlerObject } from "workbox-core/types.js"

const HTTP_PARTIAL_CONTENT = 206

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

	const body = await response.arrayBuffer()

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
 * Creates the range-chunk route handler.
 *
 * Register it on a route that matches only GET range requests of immutable files without a query string.
 * A request whose `Range` header isn't a closed range goes to the network unchanged.
 *
 * A failure inside the cache, such as a quota error, also sends the request to the network.
 */
export function createRangeChunkHandler(options: RangeChunkHandlerOptions): RouteHandlerObject {
	const fetchFromNetwork = options.fetch ?? globalThis.fetch.bind(globalThis)

	return {
		handle: async ({ request }: RouteHandlerCallbackOptions): Promise<Response> => {
			const range = parseClosedRange(request.headers.get("range"))

			if (!range) return fetchFromNetwork(request)

			try {
				const cache = await (options.cacheStorage ?? globalThis.caches).open(options.cacheName)
				const key = rangeChunkKey(request.url, range.start, range.end)
				const hit = await cache.match(key)

				if (hit) {
					const contentRange = hit.headers.get(STORED_CONTENT_RANGE_HEADER)
					const body = await hit.arrayBuffer()

					if (contentRange && body.byteLength === contentRangeLength(contentRange)) {
						return partialResponse(body, contentRange)
					}

					// An entry that fails the check goes, and the network answers.
					await cache.delete(key)
				}

				let response = await fetchFromNetwork(request.clone())
				let chunk = await validatedChunk(response.clone())

				if (!chunk && response.status === HTTP_PARTIAL_CONTENT) {
					response = await fetchFromNetwork(request.url, {
						method: "GET",
						mode: "cors",
						credentials: "omit",
						cache: "no-store",
						headers: { range: `bytes=${range.start}-${range.end}` },
					})

					chunk = await validatedChunk(response.clone())
				}

				if (!chunk) return response

				await cache.put(
					key,
					new Response(chunk.body.slice(0), {
						status: 200,
						headers: {
							"content-type": "application/octet-stream",
							[STORED_CONTENT_RANGE_HEADER]: chunk.contentRange,
						},
					})
				)

				return partialResponse(chunk.body, chunk.contentRange)
			} catch {
				return fetchFromNetwork(request)
			}
		},
	}
}
