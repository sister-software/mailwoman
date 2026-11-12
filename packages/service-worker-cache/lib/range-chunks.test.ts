// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, test, vi } from "vitest"
import type { RouteHandlerCallbackOptions } from "workbox-core/types.js"

import {
	contentRangeLength,
	createRangeChunkHandler,
	createRangeGuardHandler,
	parseClosedRange,
	RANGE_REFUSED_HEADER,
	rangeChunkKey,
} from "#range-chunks"

import { MemoryCacheStorage } from "../test/memory-cache.ts"

const FILE = "https://public.example.test/gazetteer/2026-08-25b/candidate.db"
const CACHE_NAME = "ranges-test"

/**
 * The bytes the fake origin serves: offset `i` holds `i % 251`.
 */
function fileBytes(start: number, end: number): Uint8Array<ArrayBuffer> {
	return Uint8Array.from({ length: end - start + 1 }, (_, i) => (start + i) % 251)
}

function partial(start: number, end: number, options: { truncateBy?: number } = {}): Response {
	const body = fileBytes(start, end).slice(0, end - start + 1 - (options.truncateBy ?? 0))

	return new Response(body, {
		status: 206,
		headers: { "content-range": `bytes ${start}-${end}/1000000` },
	})
}

function rangeRequest(start: number, end: number, href = FILE): RouteHandlerCallbackOptions {
	return {
		request: new Request(href, { headers: { range: `bytes=${start}-${end}` } }),
		url: new URL(href),
		event: {} as ExtendableEvent,
	}
}

/**
 * A 200 carrying the whole file, as an origin that ignored the `Range` header sends it.
 *
 * The stream records whether its reader cancelled it.
 * Cancelling is how the handler stops the download.
 */
function wholeFile(): { response: Response; cancelled: () => boolean } {
	let cancelled = false

	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			controller.enqueue(new Uint8Array(1024))
		},
		cancel() {
			cancelled = true
		},
	})

	return { response: new Response(body, { status: 200 }), cancelled: () => cancelled }
}

describe("parseClosedRange and contentRangeLength", () => {
	test("read only a closed range and a well-formed Content-Range", () => {
		expect(parseClosedRange("bytes=0-65535")).toEqual({ start: 0, end: 65_535 })
		expect(parseClosedRange("bytes=100-")).toBeNull()
		expect(parseClosedRange("bytes=0-1,5-9")).toBeNull()
		expect(parseClosedRange(null)).toBeNull()
		expect(contentRangeLength("bytes 0-65535/2880921600")).toBe(65_536)
		expect(contentRangeLength("bytes 10-19/*")).toBe(10)
		expect(contentRangeLength("bytes */100")).toBeNull()
	})
})

describe("createRangeChunkHandler", () => {
	test("stores a validated chunk and answers the next request for it from the cache", async () => {
		const storage = new MemoryCacheStorage()
		const fetchStub = vi.fn(async () => partial(0, 99))
		const handler = createRangeChunkHandler({ cacheName: CACHE_NAME, cacheStorage: storage, fetch: fetchStub })

		const first = await handler.handle(rangeRequest(0, 99))
		const second = await handler.handle(rangeRequest(0, 99))

		expect(fetchStub).toHaveBeenCalledTimes(1)
		expect(second.status).toBe(206)
		expect(second.headers.get("content-range")).toBe("bytes 0-99/1000000")
		expect(new Uint8Array(await second.arrayBuffer())).toEqual(fileBytes(0, 99))
		expect(new Uint8Array(await first.arrayBuffer())).toEqual(fileBytes(0, 99))
		expect(storage.caches.get(CACHE_NAME)?.entries.has(rangeChunkKey(FILE, 0, 99))).toBe(true)
	})

	test("refetches a torn chunk once without the HTTP cache, and stores the whole one", async () => {
		const storage = new MemoryCacheStorage()

		const fetchStub = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(partial(100, 199, { truncateBy: 40 }))
			.mockResolvedValueOnce(partial(100, 199))

		const handler = createRangeChunkHandler({ cacheName: CACHE_NAME, cacheStorage: storage, fetch: fetchStub })

		const response = await handler.handle(rangeRequest(100, 199))

		expect(fetchStub).toHaveBeenCalledTimes(2)
		expect(fetchStub.mock.calls[1]?.[1]).toMatchObject({ cache: "no-store", headers: { range: "bytes=100-199" } })
		expect((await response.arrayBuffer()).byteLength).toBe(100)
		expect(storage.caches.get(CACHE_NAME)?.entries.size).toBe(1)
	})

	test("stores nothing when the refetch is torn too, and passes the network's response through", async () => {
		const storage = new MemoryCacheStorage()
		const fetchStub = vi.fn(async () => partial(0, 99, { truncateBy: 10 }))
		const handler = createRangeChunkHandler({ cacheName: CACHE_NAME, cacheStorage: storage, fetch: fetchStub })

		const response = await handler.handle(rangeRequest(0, 99))

		expect(fetchStub).toHaveBeenCalledTimes(2)
		expect((await response.arrayBuffer()).byteLength).toBe(90)
		expect(storage.caches.get(CACHE_NAME)?.entries.size).toBe(0)
	})

	test("replaces a stored chunk that fails the length check with the network's", async () => {
		const storage = new MemoryCacheStorage()
		const cache = await storage.open(CACHE_NAME)

		await cache.put(
			rangeChunkKey(FILE, 0, 99),
			new Response(new Uint8Array(20), { headers: { "x-mw-content-range": "bytes 0-99/1000000" } })
		)

		const fetchStub = vi.fn(async () => partial(0, 99))
		const handler = createRangeChunkHandler({ cacheName: CACHE_NAME, cacheStorage: storage, fetch: fetchStub })

		const response = await handler.handle(rangeRequest(0, 99))

		expect(fetchStub).toHaveBeenCalledTimes(1)
		expect((await response.arrayBuffer()).byteLength).toBe(100)
	})

	test("sends a request without a closed range to the network unchanged", async () => {
		const storage = new MemoryCacheStorage()
		const fetchStub = vi.fn(async () => new Response("whole file"))
		const handler = createRangeChunkHandler({ cacheName: CACHE_NAME, cacheStorage: storage, fetch: fetchStub })

		const response = await handler.handle({
			request: new Request(FILE),
			url: new URL(FILE),
			event: {} as ExtendableEvent,
		})

		await expect(response.text()).resolves.toBe("whole file")
		expect(storage.caches.size).toBe(0)
	})

	test("cancels a whole-file answer and stores the chunk from the uncached refetch", async () => {
		const storage = new MemoryCacheStorage()
		const first = wholeFile()

		const fetchStub = vi.fn<typeof fetch>().mockResolvedValueOnce(first.response).mockResolvedValueOnce(partial(0, 99))

		const handler = createRangeChunkHandler({ cacheName: CACHE_NAME, cacheStorage: storage, fetch: fetchStub })

		const response = await handler.handle(rangeRequest(0, 99))

		expect(first.cancelled()).toBe(true)
		expect(fetchStub.mock.calls[1]?.[1]).toMatchObject({ cache: "no-store", headers: { range: "bytes=0-99" } })
		expect(response.status).toBe(206)
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(fileBytes(0, 99))
		expect(storage.caches.get(CACHE_NAME)?.entries.has(rangeChunkKey(FILE, 0, 99))).toBe(true)
	})

	test("answers a second whole-file response with a marked 502 and stores nothing", async () => {
		const storage = new MemoryCacheStorage()
		const answers = [wholeFile(), wholeFile()]

		const fetchStub = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(answers[0]!.response)
			.mockResolvedValueOnce(answers[1]!.response)

		const handler = createRangeChunkHandler({ cacheName: CACHE_NAME, cacheStorage: storage, fetch: fetchStub })

		const response = await handler.handle(rangeRequest(0, 99))

		expect(fetchStub).toHaveBeenCalledTimes(2)
		expect(answers.map((answer) => answer.cancelled())).toEqual([true, true])
		expect(response.status).toBe(502)
		expect(response.headers.get(RANGE_REFUSED_HEADER)).toBe("1")
		expect((await response.arrayBuffer()).byteLength).toBe(0)
		expect(storage.caches.get(CACHE_NAME)?.entries.size).toBe(0)
	})

	test("passes a 404 through without a refetch", async () => {
		const storage = new MemoryCacheStorage()
		const fetchStub = vi.fn(async () => new Response("missing", { status: 404 }))
		const handler = createRangeChunkHandler({ cacheName: CACHE_NAME, cacheStorage: storage, fetch: fetchStub })

		const response = await handler.handle(rangeRequest(0, 99))

		expect(fetchStub).toHaveBeenCalledTimes(1)
		expect(response.status).toBe(404)
	})

	test("answers from the network when the cache throws, as on a quota error", async () => {
		const fetchStub = vi.fn(async () => partial(0, 99))

		const failing = {
			open: async () => {
				throw new DOMException("quota", "QuotaExceededError")
			},
		}

		const handler = createRangeChunkHandler({ cacheName: CACHE_NAME, cacheStorage: failing, fetch: fetchStub })

		const response = await handler.handle(rangeRequest(0, 99))

		expect(response.status).toBe(206)
		expect((await response.arrayBuffer()).byteLength).toBe(100)
	})
})

describe("createRangeGuardHandler", () => {
	const RETRY = `${FILE}?cb=1794486000000`

	test("passes a validated chunk through without Cache Storage", async () => {
		const fetchStub = vi.fn(async () => partial(0, 99))
		const handler = createRangeGuardHandler({ fetch: fetchStub })

		const response = await handler.handle(rangeRequest(0, 99, RETRY))

		expect(response.status).toBe(206)
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(fileBytes(0, 99))
	})

	test("refuses a whole-file answer to a cache-busting retry", async () => {
		const answers = [wholeFile(), wholeFile()]

		const fetchStub = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(answers[0]!.response)
			.mockResolvedValueOnce(answers[1]!.response)

		const handler = createRangeGuardHandler({ fetch: fetchStub })

		const response = await handler.handle(rangeRequest(0, 99, RETRY))

		expect(fetchStub.mock.calls[1]?.[0]).toBe(RETRY)
		expect(answers.map((answer) => answer.cancelled())).toEqual([true, true])
		expect(response.status).toBe(502)
		expect(response.headers.get(RANGE_REFUSED_HEADER)).toBe("1")
	})
})
