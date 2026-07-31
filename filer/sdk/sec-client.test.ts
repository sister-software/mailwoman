/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Tests for {@linkcode createSECClient} — the throttled/cached/retrying SEC EDGAR client (3b
 *   decision 5). Every test drives a stub `fetchImpl` and, where time matters, a fake `ClockLike` — no
 *   test here ever performs a live network call or a real wall-clock sleep.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
	type ClockLike,
	createSECClient,
	isImmutableArchiveURL,
	SEC_MAX_REQUESTS_PER_SECOND,
	TokenBucket,
} from "./sec-client.ts"

// `$private` (`@mailwoman/core/env`) is a LIVE getter over `{ ...dotEnv, ...process.env }` — the repo's
// real `.env` already sets `SEC_EDGAR_USER_AGENT`, so `vi.stubEnv` alone can't hide it (see
// `bdc/sdk/client.test.ts`'s identical finding against `FCC_MAP_*`). Mock the module directly so the
// no-UA fail-fast test below is isolated from whatever the ambient `.env` actually contains. Every
// OTHER test in this file passes an explicit `userAgent` option and never reads `$private`.
vi.mock("@mailwoman/core/env", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@mailwoman/core/env")>()

	return {
		...actual,
		$private: { ...actual.$private, SEC_EDGAR_USER_AGENT: undefined },
	}
})

const TEST_USER_AGENT = "Test Harness test@example.com"

interface FakeClock extends ClockLike {
	/**
	 * Every `ms` value the client/limiter has awaited via `sleep`, in call order.
	 */
	sleepCalls: number[]
	/**
	 * Advance the fake clock WITHOUT recording a `sleepCalls` entry — simulates wall-clock time passing between two
	 * `get()` calls (e.g. "a day later") without the client itself having awaited anything.
	 */
	advance(ms: number): void
}

function createFakeClock(startAt = 0): FakeClock {
	let current = startAt
	const sleepCalls: number[] = []

	return {
		sleepCalls,
		now: () => current,
		sleep: async (ms: number) => {
			sleepCalls.push(ms)
			current += ms
		},
		advance: (ms: number) => {
			current += ms
		},
	}
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
	return new Response(JSON.stringify(body), init)
}

/**
 * A stub `fetchImpl` that returns one `Response` per call from `responses`, holding on the last entry once exhausted,
 * and records every requested URL (as a string) in call order.
 */
function stubFetch(responses: Response[]): { fetchImpl: typeof fetch; calls: string[] } {
	const calls: string[] = []
	let index = 0

	const fetchImpl = (async (input: string | URL | Request) => {
		calls.push(String(input))
		const response = responses[Math.min(index, responses.length - 1)]!

		index++

		return response
	}) as typeof fetch

	return { fetchImpl, calls }
}

let cacheDir: string

beforeEach(() => {
	cacheDir = mkdtempSync(join(tmpdir(), "sec-client-test-"))
})

afterEach(() => {
	rmSync(cacheDir, { recursive: true, force: true })
})

describe("createSECClient: User-Agent fail-fast", () => {
	it("throws a descriptive error without an explicit userAgent and without SEC_EDGAR_USER_AGENT", () => {
		expect(() => createSECClient()).toThrow(/User-Agent/i)
		expect(() => createSECClient()).toThrow(/SEC_EDGAR_USER_AGENT/)
		expect(() => createSECClient()).toThrow(/accessing-edgar-data/)
	})

	it("does not throw when userAgent is passed explicitly", () => {
		const { fetchImpl } = stubFetch([jsonResponse({})])

		expect(() => createSECClient({ userAgent: TEST_USER_AGENT, fetchImpl, cacheDir })).not.toThrow()
	})
})

describe("createSECClient: request headers", () => {
	it("sends the configured User-Agent and the documented Accept-Encoding on every request, across hosts", async () => {
		const { fetchImpl, calls } = stubFetch([jsonResponse({ a: 1 }), jsonResponse({ b: 2 })])
		const seenHeaders: Record<string, string>[] = []

		const wrapped = (async (input: string | URL | Request, init?: RequestInit) => {
			seenHeaders.push((init?.headers ?? {}) as Record<string, string>)

			return fetchImpl(input, init)
		}) as typeof fetch

		const client = createSECClient({ userAgent: TEST_USER_AGENT, fetchImpl: wrapped, cacheDir })

		await client.get("https://data.sec.gov/submissions/CIK0000320193.json")
		await client.get("https://www.sec.gov/files/company_tickers.json")

		expect(calls).toEqual([
			"https://data.sec.gov/submissions/CIK0000320193.json",
			"https://www.sec.gov/files/company_tickers.json",
		])

		for (const headers of seenHeaders) {
			expect(headers).toMatchObject({ "User-Agent": TEST_USER_AGENT, "Accept-Encoding": "gzip, deflate" })
		}
	})
})

describe("isImmutableArchiveURL", () => {
	it("is true for an EDGAR archive filing-document path", () => {
		const url = new URL("https://www.sec.gov/Archives/edgar/data/320193/000032019323000106/aapl-20230930.htm")

		expect(isImmutableArchiveURL(url)).toBe(true)
	})

	it("is false for the submissions index, the ticker map, and the classic browse-edgar CGI", () => {
		expect(isImmutableArchiveURL(new URL("https://data.sec.gov/submissions/CIK0000320193.json"))).toBe(false)
		expect(isImmutableArchiveURL(new URL("https://www.sec.gov/files/company_tickers.json"))).toBe(false)

		expect(
			isImmutableArchiveURL(new URL("https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000320193"))
		).toBe(false)
	})
})

describe("createSECClient: on-disk cache keyed by URL", () => {
	const url = "https://data.sec.gov/submissions/CIK0000320193.json"

	it("caches a successful response and does not re-fetch on a second get() for the same URL", async () => {
		const { fetchImpl, calls } = stubFetch([jsonResponse({ cik: "0000320193" })])
		const client = createSECClient({ userAgent: TEST_USER_AGENT, fetchImpl, cacheDir })

		const first = await client.get<{ cik: string }>(url)
		const second = await client.get<{ cik: string }>(url)

		expect(first).toEqual({ cik: "0000320193" })
		expect(second).toEqual({ cik: "0000320193" })
		expect(calls).toHaveLength(1)
	})

	it("expires a MUTABLE (non-archive) URL's cache entry after cacheTTLMs, triggering a re-fetch", async () => {
		const clock = createFakeClock()
		const { fetchImpl, calls } = stubFetch([jsonResponse({ v: 1 }), jsonResponse({ v: 2 })])
		const client = createSECClient({ userAgent: TEST_USER_AGENT, fetchImpl, cacheDir, clock, cacheTTLMs: 1000 })

		expect(await client.get(url)).toEqual({ v: 1 })
		expect(calls).toHaveLength(1)

		clock.advance(1001)

		expect(await client.get(url)).toEqual({ v: 2 })
		expect(calls).toHaveLength(2)
	})

	it("never expires an ARCHIVE-path URL's cache entry, even long past cacheTTLMs", async () => {
		const archiveURL = "https://www.sec.gov/Archives/edgar/data/320193/000032019323000106/aapl-20230930.htm"
		const clock = createFakeClock()
		const { fetchImpl, calls } = stubFetch([jsonResponse({ v: 1 }), jsonResponse({ v: 2 })])
		const client = createSECClient({ userAgent: TEST_USER_AGENT, fetchImpl, cacheDir, clock, cacheTTLMs: 1000 })

		expect(await client.get(archiveURL)).toEqual({ v: 1 })

		clock.advance(1000 * 60 * 60 * 24 * 365) // a year — far past any reasonable TTL

		expect(await client.get(archiveURL)).toEqual({ v: 1 })
		expect(calls).toHaveLength(1)
	})
})

describe("TokenBucket", () => {
	it("allows an immediate burst up to capacity with no wait", async () => {
		const clock = createFakeClock()
		const bucket = new TokenBucket(10, clock)

		for (let i = 0; i < 10; i++) {
			await bucket.acquire()
		}

		expect(clock.sleepCalls).toHaveLength(0)
	})

	it("waits for exactly the token deficit once capacity is exhausted", async () => {
		const clock = createFakeClock()
		const bucket = new TokenBucket(10, clock)

		for (let i = 0; i < 10; i++) {
			await bucket.acquire()
		}

		await bucket.acquire()

		// 1 missing token / (10 tokens/sec) = 100ms.
		expect(clock.sleepCalls).toEqual([100])
	})

	it("clamps a requested rate above the SEC ceiling down to SEC_MAX_REQUESTS_PER_SECOND", async () => {
		const clock = createFakeClock()
		const bucket = new TokenBucket(100, clock)

		for (let i = 0; i < SEC_MAX_REQUESTS_PER_SECOND; i++) {
			await bucket.acquire()
		}

		expect(clock.sleepCalls).toHaveLength(0)

		await bucket.acquire()

		expect(clock.sleepCalls).toHaveLength(1)
	})
})

describe("createSECClient: rate limiting", () => {
	it("throttles get() through its token bucket, clamped to the SEC ceiling regardless of a higher request", async () => {
		const clock = createFakeClock()
		const responses = Array.from({ length: 11 }, (_, i) => jsonResponse({ i }))
		const { fetchImpl } = stubFetch(responses)

		const client = createSECClient({
			userAgent: TEST_USER_AGENT,
			fetchImpl,
			cacheDir,
			clock,
			requestsPerSecond: 100, // attempts to exceed the policy ceiling
		})

		for (let i = 0; i < 10; i++) {
			await client.get(`https://data.sec.gov/rate-test/${i}.json`)
		}

		expect(clock.sleepCalls).toHaveLength(0)

		await client.get("https://data.sec.gov/rate-test/10.json")

		expect(clock.sleepCalls).toHaveLength(1)
	})
})

describe("createSECClient: bounded retry with backoff on 429/5xx", () => {
	it("retries a transient 429 with exponential backoff and succeeds once the server recovers", async () => {
		const clock = createFakeClock()

		const { fetchImpl, calls } = stubFetch([
			new Response("", { status: 429, statusText: "Too Many Requests" }),
			new Response("", { status: 429, statusText: "Too Many Requests" }),
			jsonResponse({ ok: true }),
		])

		const client = createSECClient({
			userAgent: TEST_USER_AGENT,
			fetchImpl,
			cacheDir,
			clock,
			maxAttempts: 3,
			baseRetryDelayMs: 500,
		})

		const result = await client.get("https://data.sec.gov/retry-test.json")

		expect(result).toEqual({ ok: true })
		expect(calls).toHaveLength(3)
		expect(clock.sleepCalls).toEqual([500, 1000])
	})

	it("gives up after maxAttempts on a persistent 503, rethrowing the last error — bounded, not until it works", async () => {
		const { fetchImpl, calls } = stubFetch([
			new Response("", { status: 503, statusText: "Service Unavailable" }),
			new Response("", { status: 503, statusText: "Service Unavailable" }),
		])

		const client = createSECClient({
			userAgent: TEST_USER_AGENT,
			fetchImpl,
			cacheDir,
			clock: createFakeClock(),
			maxAttempts: 2,
			baseRetryDelayMs: 1,
		})

		await expect(client.get("https://data.sec.gov/retry-ceiling-test.json")).rejects.toThrow(/503/)
		expect(calls).toHaveLength(2)
	})

	it("does NOT retry a 403 — fails on the first attempt and blames the User-Agent, not the resource", async () => {
		const { fetchImpl, calls } = stubFetch([new Response("", { status: 403, statusText: "Forbidden" })])

		const client = createSECClient({
			userAgent: TEST_USER_AGENT,
			fetchImpl,
			cacheDir,
			clock: createFakeClock(),
		})

		await expect(client.get("https://www.sec.gov/files/company_tickers.json")).rejects.toThrow(
			/did NOT identify itself/i
		)

		expect(calls).toHaveLength(1)
	})
})
