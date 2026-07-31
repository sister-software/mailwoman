/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Tests for {@linkcode createSECClient} — the throttled/cached/retrying SEC EDGAR client (3b
 *   decision 5). Every test drives a stub `fetchImpl` and, where time matters, a fake `ClockLike` — no
 *   test in this file performs a live network call or a real wall-clock sleep (the one exception,
 *   documented at its call site, is the per-request-timeout test, which exercises the platform's real
 *   `AbortSignal.timeout` over a deliberately tiny real interval).
 */

import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
	type ClockLike,
	createSECClient,
	isImmutableArchiveURL,
	SEC_MAX_REQUESTS_PER_SECOND,
	SECRequestError,
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

/**
 * A simple, immediately-resolving fake clock — `sleep()` just bumps `now()` and resolves right away. Fine for every
 * SEQUENTIAL test in this file (nothing here ever has two `sleep()` calls racing each other), but NOT sufficient for
 * the concurrency regression test below — see {@linkcode VirtualClock}'s docstring for why.
 */
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

/**
 * A virtual-time clock that resolves concurrent `sleep()`s ONE AT A TIME, strictly in deadline order, only when
 * explicitly driven via {@linkcode VirtualClock.advance} — unlike {@linkcode createFakeClock}, which bumps `now()`
 * synchronously the INSTANT `sleep()` is called (fine when nothing else is concurrently racing the clock, but not a
 * faithful model of "N callers all waiting on the same deadline").
 *
 * This fidelity is exactly what the C1 concurrency regression needs: a coarser clock that resolves every same-deadline
 * sleeper "at once" cannot distinguish a fixed `TokenBucket` from the one review found broken — under such a clock,
 * BOTH the buggy (`if` + floor-clamped decrement) and fixed (`while` + unclamped decrement) implementations happen to
 * let a whole cohort of waiters through together, because the naive clock's own call-time (not wake-time) mutation of
 * `now()` interleaves refills in a way that masks the bug. `VirtualClock` doesn't: each pending `sleep()` only resolves
 * when `advance()` reaches its deadline, and after each individual resolution, the woken continuation (which may itself
 * register a NEW `sleep()`, pushing its own deadline further out) is allowed to run to completion before the next
 * same-deadline sleeper is resolved — reproducing exactly how N real, independent timers would settle.
 */
class VirtualClock implements ClockLike {
	#now = 0
	#pending: Array<{ deadline: number; resolve: () => void }> = []
	readonly sleepCalls: number[] = []

	now(): number {
		return this.#now
	}

	sleep(ms: number): Promise<void> {
		this.sleepCalls.push(ms)

		return new Promise<void>((resolve) => {
			this.#pending.push({ deadline: this.#now + ms, resolve })
		})
	}

	/**
	 * Advance virtual time to `now() + ms`, waking every pending `sleep()` due at or before that instant — one at a time,
	 * earliest deadline first (ties broken by registration order), yielding a couple of microtask turns after each wakeup
	 * so its synchronous continuation runs before the next deadline is considered.
	 */
	async advance(ms: number): Promise<void> {
		const target = this.#now + ms

		for (;;) {
			let earliestIndex = -1

			for (let i = 0; i < this.#pending.length; i++) {
				if (this.#pending[i]!.deadline > target) continue

				if (earliestIndex === -1 || this.#pending[i]!.deadline < this.#pending[earliestIndex]!.deadline) {
					earliestIndex = i
				}
			}

			if (earliestIndex === -1) break

			const [due] = this.#pending.splice(earliestIndex, 1)

			this.#now = due!.deadline
			due!.resolve()

			// Let the woken `acquire()` continuation run — refill + re-check, and possibly register a NEW
			// `sleep()` — before re-scanning for the next due deadline.
			await Promise.resolve()
			await Promise.resolve()
		}

		this.#now = target
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

describe("createSECClient: host allowlist", () => {
	it("refuses a non-SEC host before touching the network", async () => {
		const { fetchImpl, calls } = stubFetch([jsonResponse({})])
		const client = createSECClient({ userAgent: TEST_USER_AGENT, fetchImpl, cacheDir, clock: createFakeClock() })

		await expect(client.get("https://attacker.example.invalid/collect")).rejects.toThrow(/SEC EDGAR hosts/)
		expect(calls).toHaveLength(0)
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

	it("treats URLs differing only by query string as DISTINCT cache entries", async () => {
		// browse-edgar's entire identity IS its query string — collapsing `origin + pathname` into the cache
		// key (dropping the query) would silently merge every distinct CIK lookup into one cache entry. This
		// is the one mutation that survived the original suite (changing the key to `origin + pathname` left
		// every prior test green), so it's asserted directly here.
		const { fetchImpl, calls } = stubFetch([jsonResponse({ cik: "0000320193" }), jsonResponse({ cik: "0000789019" })])
		const client = createSECClient({ userAgent: TEST_USER_AGENT, fetchImpl, cacheDir })

		const first = await client.get("https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000320193")
		const second = await client.get("https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000789019")

		expect(first).toEqual({ cik: "0000320193" })
		expect(second).toEqual({ cik: "0000789019" })
		expect(calls).toHaveLength(2)
	})

	it("never writes a cache entry for a failed response — a later request still hits the network", async () => {
		const errorURL = "https://data.sec.gov/error-not-cached-test.json"
		const failing = stubFetch([new Response("", { status: 500, statusText: "Internal Server Error" })])

		const failingClient = createSECClient({
			userAgent: TEST_USER_AGENT,
			fetchImpl: failing.fetchImpl,
			cacheDir,
			clock: createFakeClock(),
			maxAttempts: 1,
		})

		await expect(failingClient.get(errorURL)).rejects.toThrow(/500/)
		expect(readdirSync(cacheDir)).toHaveLength(0)

		const succeeding = stubFetch([jsonResponse({ ok: true })])
		const succeedingClient = createSECClient({ userAgent: TEST_USER_AGENT, fetchImpl: succeeding.fetchImpl, cacheDir })

		expect(await succeedingClient.get(errorURL)).toEqual({ ok: true })
		expect(succeeding.calls).toHaveLength(1)
	})

	it("does not cache a 200 response with a non-JSON body, and the parse error names the URL", async () => {
		const archiveURL = "https://www.sec.gov/Archives/edgar/data/320193/000032019323000106/aapl-20230930.htm"
		const bad = stubFetch([new Response("<html>not json</html>", { status: 200 })])

		const client = createSECClient({
			userAgent: TEST_USER_AGENT,
			fetchImpl: bad.fetchImpl,
			cacheDir,
			clock: createFakeClock(),
		})

		await expect(client.get(archiveURL)).rejects.toThrow(archiveURL)
		expect(readdirSync(cacheDir)).toHaveLength(0)

		// Self-heals: nothing was poisoned, so a later attempt against the same (archive!) URL still fetches.
		const fixed = stubFetch([jsonResponse({ ok: true })])
		const fixedClient = createSECClient({ userAgent: TEST_USER_AGENT, fetchImpl: fixed.fetchImpl, cacheDir })

		expect(await fixedClient.get(archiveURL)).toEqual({ ok: true })
		expect(fixed.calls).toHaveLength(1)
	})
})

describe("createSECClient: stampede guard", () => {
	it("de-dupes concurrent misses for the SAME url onto a single in-flight fetch", async () => {
		const { fetchImpl, calls } = stubFetch([jsonResponse({ v: 1 })])
		const client = createSECClient({ userAgent: TEST_USER_AGENT, fetchImpl, cacheDir, clock: createFakeClock() })
		const url = "https://data.sec.gov/stampede-test.json"

		const results = await Promise.all([client.get(url), client.get(url), client.get(url)])

		expect(results).toEqual([{ v: 1 }, { v: 1 }, { v: 1 }])
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

	// --- C1 regression: concurrent acquire() calls must be paced, not let through in a batch. -----------------
	//
	// Reproduced (review, 2026-08-01): fanning 40 `client.get()` calls out via `Promise.all` against a 10 req/s
	// bucket issued 40 requests inside 100ms of virtual time, 30 of them sharing a single instant. Root cause,
	// both in `TokenBucket.acquire()`:
	//   - `if (this.#tokens < 1)` instead of `while` — a waiter that wakes never re-verifies a token is still
	//     there, so every waiter parked at the same deadline proceeds once ANY of them wakes.
	//   - `this.#tokens = Math.max(0, this.#tokens - 1)` — flooring the decrement at zero erases the "debt" an
	//     over-subscribing waiter should carry, so its own next wait calculation can't see it.
	//
	// This test uses `VirtualClock` (not the simpler `createFakeClock` used everywhere else in this file) because
	// the bug is specifically about how concurrent waiters interleave when woken — see `VirtualClock`'s docstring
	// for why the simpler clock can't distinguish the fixed limiter from the broken one.
	it("paces N concurrent acquire() calls one-per-interval past the initial burst, instead of letting a cohort through together", async () => {
		const CAPACITY = 10
		const TOTAL_CALLS = 40 // mirrors the reviewer's reproduction exactly.
		const QUEUED_CALLS = TOTAL_CALLS - CAPACITY

		const clock = new VirtualClock()
		const bucket = new TokenBucket(CAPACITY, clock)
		const grantTimes: number[] = []

		async function recordedAcquire(): Promise<void> {
			await bucket.acquire()
			grantTimes.push(clock.now())
		}

		// `Array.from`'s mapper runs synchronously for every index — this genuinely fans out 40 concurrent
		// `acquire()` calls with no intervening real async I/O, exactly reproducing the `Promise.all` shape the
		// review used against the public API, but at the exact unit the bug lives in.
		const pending = Array.from({ length: TOTAL_CALLS }, () => recordedAcquire())

		// The burst calls (1..CAPACITY) resolved synchronously with no `sleep()` involved, but `await`-ing an
		// already-resolved promise still defers their `grantTimes.push()` continuation to the microtask queue.
		// Flush it out HERE, before driving the clock forward — otherwise `advance()`'s own first internal
		// `await` would be what flushes them, by which point `now()` has already been bumped past t=0,
		// misattributing the burst's grant time to whatever instant the clock had reached by then.
		await new Promise<void>((resolve) => {
			setImmediate(resolve)
		})

		// 30 queued calls, each needing one more accrued token 100ms apart: 30 * 100ms = 3000ms is enough for
		// every one of them to be granted.
		await clock.advance(QUEUED_CALLS * 100)
		await Promise.all(pending)

		expect(grantTimes).toHaveLength(TOTAL_CALLS)

		// The initial burst: the first `CAPACITY` calls are granted immediately, at t=0.
		expect(grantTimes.slice(0, CAPACITY)).toEqual(new Array(CAPACITY).fill(0))

		// Every call past the burst is paced ONE per 100ms — no two of them share an instant, and none of them
		// land inside that same first 100ms window the burst occupied.
		const queuedGrants = grantTimes.slice(CAPACITY)
		const expectedQueuedGrants = Array.from({ length: QUEUED_CALLS }, (_, i) => (i + 1) * 100)

		expect(queuedGrants).toEqual(expectedQueuedGrants)
		expect(new Set(queuedGrants).size).toBe(QUEUED_CALLS) // no duplicates — no cohort let through together.
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

	it("gives up after maxAttempts on a persistent 503, rethrowing a SECRequestError — bounded, not until it works", async () => {
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

		const url = "https://data.sec.gov/retry-ceiling-test.json"

		let caught: unknown

		try {
			await client.get(url)
		} catch (error) {
			caught = error
		}

		expect(caught).toBeInstanceOf(SECRequestError)
		expect(caught).toMatchObject({ status: 503, url, retryable: true })
		expect(calls).toHaveLength(2)
	})

	it("does NOT retry a 403 — fails on the first attempt with a non-retryable SECRequestError", async () => {
		const url = "https://www.sec.gov/files/company_tickers.json"
		const { fetchImpl, calls } = stubFetch([new Response("", { status: 403, statusText: "Forbidden" })])

		const client = createSECClient({
			userAgent: TEST_USER_AGENT,
			fetchImpl,
			cacheDir,
			clock: createFakeClock(),
		})

		let caught: unknown

		try {
			await client.get(url)
		} catch (error) {
			caught = error
		}

		expect(caught).toBeInstanceOf(SECRequestError)
		expect(caught).toMatchObject({ status: 403, url, retryable: false })
		expect((caught as Error).message).toMatch(/did NOT identify itself/i)
		expect(calls).toHaveLength(1)
	})

	it("throws a non-retryable SECRequestError for a 404, without retrying", async () => {
		const url = "https://data.sec.gov/submissions/CIK9999999999.json"
		const { fetchImpl, calls } = stubFetch([new Response("", { status: 404, statusText: "Not Found" })])

		const client = createSECClient({
			userAgent: TEST_USER_AGENT,
			fetchImpl,
			cacheDir,
			clock: createFakeClock(),
		})

		let caught: unknown

		try {
			await client.get(url)
		} catch (error) {
			caught = error
		}

		expect(caught).toBeInstanceOf(SECRequestError)
		expect(caught).toMatchObject({ status: 404, url, retryable: false })
		expect(calls).toHaveLength(1)
	})

	it("retries a network error under the same bounded policy, then succeeds", async () => {
		const clock = createFakeClock()
		let callCount = 0

		const fetchImpl = (async () => {
			callCount++

			if (callCount === 1) {
				throw new TypeError("fetch failed: ECONNRESET")
			}

			return jsonResponse({ ok: true })
		}) as typeof fetch

		const client = createSECClient({
			userAgent: TEST_USER_AGENT,
			fetchImpl,
			cacheDir,
			clock,
			maxAttempts: 3,
			baseRetryDelayMs: 500,
		})

		const result = await client.get("https://data.sec.gov/network-error-test.json")

		expect(result).toEqual({ ok: true })
		expect(callCount).toBe(2)
		expect(clock.sleepCalls).toEqual([500])
	})

	it("gives up after maxAttempts on a persistent network error", async () => {
		const clock = createFakeClock()
		let callCount = 0

		const fetchImpl = (async () => {
			callCount++
			throw new TypeError("fetch failed: ECONNRESET")
		}) as typeof fetch

		const client = createSECClient({
			userAgent: TEST_USER_AGENT,
			fetchImpl,
			cacheDir,
			clock,
			maxAttempts: 2,
			baseRetryDelayMs: 1,
		})

		await expect(client.get("https://data.sec.gov/network-error-ceiling-test.json")).rejects.toThrow(/network error/i)

		expect(callCount).toBe(2)
	})

	it("honors a response's Retry-After header over the default exponential backoff", async () => {
		const clock = createFakeClock()

		const { fetchImpl, calls } = stubFetch([
			new Response("", { status: 429, statusText: "Too Many Requests", headers: { "Retry-After": "60" } }),
			jsonResponse({ ok: true }),
		])

		const client = createSECClient({
			userAgent: TEST_USER_AGENT,
			fetchImpl,
			cacheDir,
			clock,
			maxAttempts: 2,
			baseRetryDelayMs: 500, // would be 500ms if Retry-After weren't honored — it must NOT be 500 here.
		})

		const result = await client.get("https://data.sec.gov/retry-after-test.json")

		expect(result).toEqual({ ok: true })
		expect(calls).toHaveLength(2)
		expect(clock.sleepCalls).toEqual([60_000])
	})

	it("clamps an excessive Retry-After to a sane ceiling instead of honoring it verbatim", async () => {
		const clock = createFakeClock()

		const { fetchImpl } = stubFetch([
			new Response("", { status: 429, statusText: "Too Many Requests", headers: { "Retry-After": "999999" } }),
			jsonResponse({ ok: true }),
		])

		const client = createSECClient({ userAgent: TEST_USER_AGENT, fetchImpl, cacheDir, clock, maxAttempts: 2 })

		await client.get("https://data.sec.gov/retry-after-clamp-test.json")

		expect(clock.sleepCalls).toEqual([60_000])
	})

	// Real (tiny) wall-clock time, deliberately: `AbortSignal.timeout` is a platform primitive tied to the real
	// clock, not this client's injectable `ClockLike` (see `CreateSECClientOptions.requestTimeoutMs`'s docstring).
	// 50ms real time is not what decision 5's "no wall-clock sleeps" bans — that's about rate-limit/backoff
	// determinism; this is testing genuine abort-signal wiring, which has no clock-injectable platform equivalent.
	it("aborts a never-settling request after requestTimeoutMs and retries it as a network error", async () => {
		let callCount = 0

		const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
			callCount++

			if (callCount === 1) {
				return new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => {
						reject(new DOMException("The operation was aborted.", "AbortError"))
					})
				})
			}

			return jsonResponse({ ok: true })
		}) as typeof fetch

		const client = createSECClient({
			userAgent: TEST_USER_AGENT,
			fetchImpl,
			cacheDir,
			requestTimeoutMs: 50,
			maxAttempts: 2,
			baseRetryDelayMs: 1,
		})

		const result = await client.get("https://data.sec.gov/timeout-test.json")

		expect(result).toEqual({ ok: true })
		expect(callCount).toBe(2)
	})
})
