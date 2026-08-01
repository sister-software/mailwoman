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

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
	type ClockLike,
	createSECClient,
	isImmutableArchiveURL,
	RequestPacer,
	SEC_MAX_REQUESTS_PER_SECOND,
	SECRequestError,
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
	 * Every `ms` value the client/pacer has awaited via `sleep`, in call order.
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
 * This fidelity is exactly what the concurrency regression below needs: a coarser clock that resolves every
 * same-deadline sleeper "at once" cannot distinguish a fixed `RequestPacer` from a broken one — under such a clock,
 * BOTH a correct and a subtly-broken pacer happen to let a whole cohort of waiters through together, because the naive
 * clock's own call-time (not wake-time) mutation of `now()` interleaves refills in a way that masks bugs.
 * `VirtualClock` doesn't: each pending `sleep()` only resolves when `advance()` reaches its deadline, and after each
 * individual resolution, the woken continuation (which may itself register a NEW `sleep()`, pushing its own deadline
 * further out) is allowed to run to completion before the next same-deadline sleeper is resolved — reproducing exactly
 * how N real, independent timers would settle.
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

			// Let the woken `acquire()` continuation run — recompute + re-check, and possibly register a NEW
			// `sleep()` — before re-scanning for the next due deadline.
			await Promise.resolve()
			await Promise.resolve()
		}

		this.#now = target
	}
}

/**
 * The maximum number of `timestamps` falling within any sliding window of `windowMs`, using a trailing half-open window
 * `(anchor - windowMs, anchor]` at each timestamp — the conventional "requests in the last N ms" definition.
 */
function maxCountInSlidingWindow(timestamps: number[], windowMs: number): number {
	let max = 0

	for (const anchor of timestamps) {
		const count = timestamps.filter((t) => t > anchor - windowMs && t <= anchor).length

		max = Math.max(max, count)
	}

	return max
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
	it("refuses a non-SEC host before touching the network, as a typed SECRequestError", async () => {
		const { fetchImpl, calls } = stubFetch([jsonResponse({})])
		const client = createSECClient({ userAgent: TEST_USER_AGENT, fetchImpl, cacheDir, clock: createFakeClock() })
		const url = "https://attacker.example.invalid/collect"

		let caught: unknown

		try {
			await client.get(url)
		} catch (error) {
			caught = error
		}

		expect(caught).toBeInstanceOf(SECRequestError)
		expect(caught).toMatchObject({ status: null, url, retryable: false })
		expect((caught as Error).message).toMatch(/SEC EDGAR hosts/)
		expect(calls).toHaveLength(0)
	})

	it("refuses a non-https scheme, even for an otherwise-allowed host", async () => {
		const { fetchImpl, calls } = stubFetch([jsonResponse({})])
		const client = createSECClient({ userAgent: TEST_USER_AGENT, fetchImpl, cacheDir, clock: createFakeClock() })

		await expect(client.get("http://www.sec.gov/files/company_tickers.json")).rejects.toThrow(/https/i)
		expect(calls).toHaveLength(0)
	})

	it("admits the apex host and the EDGAR full-text-search host (task 8's Exhibit 21 discovery path)", async () => {
		const { fetchImpl } = stubFetch([jsonResponse({ a: 1 }), jsonResponse({ b: 2 })])
		const client = createSECClient({ userAgent: TEST_USER_AGENT, fetchImpl, cacheDir, clock: createFakeClock() })

		expect(await client.get("https://sec.gov/index.json")).toEqual({ a: 1 })
		expect(await client.get("https://efts.sec.gov/LATEST/search-index?q=test")).toEqual({ b: 2 })
	})

	it("is case-insensitive on the host", async () => {
		const { fetchImpl } = stubFetch([jsonResponse({ ok: true })])
		const client = createSECClient({ userAgent: TEST_USER_AGENT, fetchImpl, cacheDir, clock: createFakeClock() })

		expect(await client.get("https://WWW.SEC.GOV/files/company_tickers.json")).toEqual({ ok: true })
	})

	it("rejects a subdomain-suffix bypass", async () => {
		const { fetchImpl, calls } = stubFetch([jsonResponse({})])
		const client = createSECClient({ userAgent: TEST_USER_AGENT, fetchImpl, cacheDir, clock: createFakeClock() })

		await expect(client.get("https://www.sec.gov.attacker.example/x")).rejects.toThrow(/SEC EDGAR hosts/)
		expect(calls).toHaveLength(0)
	})

	it("strips userinfo and still matches the allowed host", async () => {
		const { fetchImpl } = stubFetch([jsonResponse({ ok: true })])
		const client = createSECClient({ userAgent: TEST_USER_AGENT, fetchImpl, cacheDir, clock: createFakeClock() })

		expect(await client.get("https://user:pass@www.sec.gov/files/company_tickers.json")).toEqual({ ok: true })
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
		// key (dropping the query) would silently merge every distinct CIK lookup into one cache entry.
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

describe("createSECClient: cache writes across separate client instances sharing a cacheDir", () => {
	// I1 (review round 2, CRITICAL): a deterministic temp filename (`${finalPath}.building`) meant two
	// `createSECClient()` instances (or two processes — exactly what tasks 6-8 will run) racing to write the
	// SAME url both targeted the SAME temp file. The first `rename()` moved it away; the second got a raw,
	// untyped, unretried ENOENT for a response that had already succeeded (reproduced 6/6 rounds). With large
	// bodies the concurrent writes to the shared temp path also produced a corrupt-but-parseable entry in
	// 2/10 rounds — which would never expire under `/Archives/`. The fix makes the temp name unique per write
	// (`randomUUID()`), so the two writes are structurally independent — this test races two clients (each
	// with their own fetchImpl + clock, exactly modeling two separate processes) 10 times and checks both:
	// no thrown error, and exactly one intact, correctly-parseable cache entry per round.
	it("never throws and never corrupts the cache when two independent clients race to write the same URL", async () => {
		for (let round = 0; round < 10; round++) {
			const roundURL = `https://data.sec.gov/cross-client-race-test.json?round=${round}`
			const body = { round, payload: "x".repeat(200_000) }

			const clientA = createSECClient({
				userAgent: TEST_USER_AGENT,
				fetchImpl: stubFetch([jsonResponse(body)]).fetchImpl,
				cacheDir,
				clock: createFakeClock(),
			})

			const clientB = createSECClient({
				userAgent: TEST_USER_AGENT,
				fetchImpl: stubFetch([jsonResponse(body)]).fetchImpl,
				cacheDir,
				clock: createFakeClock(),
			})

			const filesBefore = new Set(readdirSync(cacheDir))

			const [resultA, resultB] = await Promise.all([clientA.get(roundURL), clientB.get(roundURL)])

			expect(resultA).toEqual(body)
			expect(resultB).toEqual(body)

			const newFiles = readdirSync(cacheDir).filter((name) => !filesBefore.has(name))

			// Exactly one entry: not zero (both writes vanished), not two (an orphaned temp file alongside the
			// final one — the OLD bug's ENOENT path left the losing writer's temp file behind un-renamed).
			expect(newFiles).toHaveLength(1)

			const raw = readFileSync(join(cacheDir, newFiles[0]!), "utf8")
			const entry = JSON.parse(raw) as { url: string; body: string }

			expect(entry.url).toBe(roundURL)
			expect(JSON.parse(entry.body)).toEqual(body)
		}
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

describe("RequestPacer", () => {
	it("grants the first call immediately, and clamps a requested rate above the SEC ceiling to the published interval", async () => {
		const clock = createFakeClock()
		const pacer = new RequestPacer(100, clock) // attempts to exceed the policy ceiling

		await pacer.acquire()
		expect(clock.sleepCalls).toHaveLength(0) // the very first call is always immediate

		await pacer.acquire()
		// Clamped to 10/s (100ms/interval) — NOT the requested 100/s (10ms/interval).
		expect(clock.sleepCalls).toEqual([100])
	})

	it("does not accumulate a burst backlog after an idle period", async () => {
		// Mutation-proves the `Math.max(#nextGrantAt, now)` recency clamp in `acquire()`: without it, a
		// long-stale `#nextGrantAt` would let every call after an idle period through immediately forever.
		const clock = createFakeClock()
		const pacer = new RequestPacer(10, clock)

		await pacer.acquire() // consumes the first, immediate grant

		clock.advance(10_000) // a long idle

		const grantTimes: number[] = []

		for (let i = 0; i < 5; i++) {
			await pacer.acquire()
			grantTimes.push(clock.now())
		}

		expect(grantTimes).toEqual([10_000, 10_100, 10_200, 10_300, 10_400])
	})

	// --- Concurrency regression (C1, review round 1; strict-pacing redesign, review round 2) -------------
	//
	// The original bug (fixed round 1, then superseded by the strict-pacing redesign in round 2): a
	// token-bucket `if`-not-`while` check let a whole cohort of concurrent waiters through together. Review
	// round 2 additionally found that ANY non-zero-capacity token bucket admits bursts after every idle gap
	// (measured 20 grants inside one 1000ms window against a 10/s ceiling), so the mechanism was replaced
	// entirely with `RequestPacer`'s strict minimum-interval design — no burst allowance at all, beyond the
	// one immediate first grant.
	//
	// This test uses `VirtualClock` (not the simpler `createFakeClock` used everywhere else in this file)
	// because the property under test is specifically about how concurrent waiters interleave when woken —
	// see `VirtualClock`'s docstring for why the simpler clock can't distinguish a fixed pacer from a broken
	// one.
	it("paces N concurrent acquire() calls strictly 1/rate apart — only the very first grant is immediate, no cohort ever shares an instant", async () => {
		const RATE = 10
		const TOTAL_CALLS = 40 // mirrors the review's reproduction scale.
		const INTERVAL_MS = 1000 / RATE

		const clock = new VirtualClock()
		const pacer = new RequestPacer(RATE, clock)
		const grantTimes: number[] = []

		async function recordedAcquire(): Promise<void> {
			await pacer.acquire()
			grantTimes.push(clock.now())
		}

		// `Array.from`'s mapper runs synchronously for every index — this genuinely fans out 40 concurrent
		// `acquire()` calls with no intervening real async I/O, exactly reproducing the `Promise.all` shape
		// the review used against the public API, but at the exact unit the pacing guarantee lives in.
		const pending = Array.from({ length: TOTAL_CALLS }, () => recordedAcquire())

		// The first call resolves synchronously (no `sleep()` involved), but `await`-ing an already-resolved
		// promise still defers its `grantTimes.push()` continuation to the microtask queue. Flush it out
		// HERE, before driving the clock forward — otherwise `advance()`'s own first internal `await` would
		// be what flushes it, by which point `now()` has already moved past t=0.
		await new Promise<void>((resolve) => {
			setImmediate(resolve)
		})

		await clock.advance((TOTAL_CALLS - 1) * INTERVAL_MS)
		await Promise.all(pending)

		expect(grantTimes).toHaveLength(TOTAL_CALLS)

		const expectedGrants = Array.from({ length: TOTAL_CALLS }, (_, i) => i * INTERVAL_MS)

		expect(grantTimes).toEqual(expectedGrants)
		expect(new Set(grantTimes).size).toBe(TOTAL_CALLS) // no duplicates — no cohort ever granted together.

		// The published ceiling, verified directly rather than assumed: no sliding 1000ms window contains
		// more than RATE grants.
		expect(maxCountInSlidingWindow(grantTimes, 1000)).toBe(RATE)
	})
})

describe("createSECClient: rate limiting", () => {
	it("paces get() calls through its pacer, clamped to the SEC ceiling regardless of a higher request", async () => {
		const clock = createFakeClock()
		const { fetchImpl } = stubFetch([jsonResponse({ a: 1 }), jsonResponse({ b: 2 })])

		const client = createSECClient({
			userAgent: TEST_USER_AGENT,
			fetchImpl,
			cacheDir,
			clock,
			requestsPerSecond: 100, // attempts to exceed the policy ceiling
		})

		await client.get("https://data.sec.gov/rate-test/0.json")
		expect(clock.sleepCalls).toHaveLength(0) // the very first call is always immediate

		await client.get("https://data.sec.gov/rate-test/1.json")
		// Clamped to 10/s (100ms) — NOT the requested 100/s (10ms).
		expect(clock.sleepCalls).toEqual([100])
	})
})

describe("createSECClient: bounded retry with backoff on 429/5xx and network-class failures", () => {
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

	it("retries a connect-class network error under the same bounded policy, then succeeds", async () => {
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

	// I2 (review round 2, BLOCKING): `response.text()` used to sit OUTSIDE the retry try/catch. A 200 whose
	// body read rejected mid-transfer (undici raises `TypeError: terminated` on a dropped connection — the
	// COMMON failure mode for tasks 6-8's multi-MB 10-K/Exhibit-21 fetches, more so than a connect failure)
	// got exactly one attempt and a plain, unretried `TypeError`. Fixed by moving the body read inside the
	// same try/catch as the fetch call, funneling it into the same network-error retry path.
	it("retries when the body read itself rejects (a mid-transfer drop), not just a connect failure", async () => {
		const clock = createFakeClock()
		let callCount = 0

		const fetchImpl = (async () => {
			callCount++

			if (callCount === 1) {
				return {
					ok: true,
					status: 200,
					statusText: "OK",
					text: () => Promise.reject(new TypeError("terminated")),
				} as unknown as Response
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

		const result = await client.get("https://data.sec.gov/mid-body-drop-test.json")

		expect(result).toEqual({ ok: true })
		expect(callCount).toBe(2)
		expect(clock.sleepCalls).toEqual([500])
	})

	// I4 (review round 2): the taxonomy originally covered HTTP statuses only, so every connect failure,
	// timeout, and mid-body-transfer failure was still a bare `Error` — forcing callers to regex prose
	// (which the suite itself did, at the line the reviewer cited). Network-class failures now carry
	// `SECRequestError` too, with `status: null, retryable: true`.
	it("gives up after maxAttempts on a persistent network error, throwing a SECRequestError with status: null, retryable: true", async () => {
		const clock = createFakeClock()
		let callCount = 0
		const url = "https://data.sec.gov/network-error-ceiling-test.json"

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

		let caught: unknown

		try {
			await client.get(url)
		} catch (error) {
			caught = error
		}

		expect(caught).toBeInstanceOf(SECRequestError)
		expect(caught).toMatchObject({ status: null, url, retryable: true })
		expect(callCount).toBe(2)
	})

	it("honors a response's numeric Retry-After header over the default exponential backoff", async () => {
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

	// m2 (review round 2): the numeric-only parse fell back to 500ms (the short exponential default) on an
	// HTTP-date Retry-After — the OTHER form RFC 9110 allows — so a 429 asking for two minutes retried in
	// half a second.
	it("honors an HTTP-date Retry-After header, not just the numeric delay-seconds form", async () => {
		const clock = createFakeClock()
		const retryAt = new Date(Date.now() + 45_000)

		// 45s from now — under the 60s ceiling
		const { fetchImpl, calls } = stubFetch([
			new Response("", {
				status: 429,
				statusText: "Too Many Requests",
				headers: { "Retry-After": retryAt.toUTCString() },
			}),
			jsonResponse({ ok: true }),
		])

		const client = createSECClient({
			userAgent: TEST_USER_AGENT,
			fetchImpl,
			cacheDir,
			clock,
			maxAttempts: 2,
			baseRetryDelayMs: 500,
		})

		await client.get("https://data.sec.gov/retry-after-date-test.json")

		expect(calls).toHaveLength(2)
		expect(clock.sleepCalls).toHaveLength(1)
		// A small tolerance for the real-time gap between constructing `retryAt` and parsing the header.
		expect(clock.sleepCalls[0]).toBeGreaterThan(40_000)
		expect(clock.sleepCalls[0]).toBeLessThanOrEqual(45_000)
	})

	it("clamps an excessive numeric Retry-After to a sane ceiling instead of honoring it verbatim", async () => {
		const clock = createFakeClock()

		const { fetchImpl } = stubFetch([
			new Response("", { status: 429, statusText: "Too Many Requests", headers: { "Retry-After": "999999" } }),
			jsonResponse({ ok: true }),
		])

		const client = createSECClient({ userAgent: TEST_USER_AGENT, fetchImpl, cacheDir, clock, maxAttempts: 2 })

		await client.get("https://data.sec.gov/retry-after-clamp-test.json")

		expect(clock.sleepCalls).toEqual([60_000])
	})

	// m2: a PRESENT-but-unparseable Retry-After must fail open toward the LONG ceiling, never the short
	// exponential default — the server is still asking us to back off, and guessing "short" risks hammering
	// it.
	it("falls back to the long ceiling (never the short exponential) when Retry-After is present but unparseable", async () => {
		const clock = createFakeClock()

		const { fetchImpl } = stubFetch([
			new Response("", {
				status: 429,
				statusText: "Too Many Requests",
				headers: { "Retry-After": "not-a-valid-value" },
			}),
			jsonResponse({ ok: true }),
		])

		const client = createSECClient({
			userAgent: TEST_USER_AGENT,
			fetchImpl,
			cacheDir,
			clock,
			maxAttempts: 2,
			baseRetryDelayMs: 500,
		})

		await client.get("https://data.sec.gov/retry-after-unparseable-test.json")

		expect(clock.sleepCalls).toEqual([60_000])
	})

	// m2: RFC 9110's `delay-seconds` is `1*DIGIT` only — no hex, no sign, no decimal point. `Number()` is
	// laxer than the grammar (`Number("0x10") === 16`, `Number("1.5") === 1.5`), so a naive `Number()` parse
	// would have silently honored either as a plausible-looking wait instead of recognizing them as
	// malformed (and falling back long).
	it.each([["0x10"], ["1.5"]])(
		"rejects %s as a numeric delay-seconds value, falling back to the long ceiling",
		async (value) => {
			const clock = createFakeClock()

			const { fetchImpl } = stubFetch([
				new Response("", { status: 429, statusText: "Too Many Requests", headers: { "Retry-After": value } }),
				jsonResponse({ ok: true }),
			])

			const client = createSECClient({
				userAgent: TEST_USER_AGENT,
				fetchImpl,
				cacheDir,
				clock,
				maxAttempts: 2,
				baseRetryDelayMs: 500,
			})

			await client.get(`https://data.sec.gov/retry-after-tight-parse-test.json?v=${value}`)

			expect(clock.sleepCalls).toEqual([60_000])
		}
	)

	// Real (tiny) wall-clock time, deliberately: `AbortSignal.timeout` is a platform primitive tied to the real
	// clock, not this client's injectable `ClockLike` (see `CreateSECClientOptions.requestTimeoutMs`'s docstring).
	// 50ms real time is not what decision 5's "no wall-clock sleeps" bans — that's about rate-limit/backoff
	// determinism; this is testing genuine abort-signal wiring, which has no clock-injectable platform equivalent.
	it("aborts a never-settling request after requestTimeoutMs and retries it as a network-class SECRequestError", async () => {
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
