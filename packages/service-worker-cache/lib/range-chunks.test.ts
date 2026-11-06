/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test, vi } from "vitest"
import type { RouteHandlerCallbackOptions } from "workbox-core/types.js"

import { contentRangeLength, createRangeChunkHandler, parseClosedRange, rangeChunkKey } from "#range-chunks"

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

function rangeRequest(start: number, end: number): RouteHandlerCallbackOptions {
	return {
		request: new Request(FILE, { headers: { range: `bytes=${start}-${end}` } }),
		url: new URL(FILE),
		event: {} as ExtendableEvent,
	}
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
