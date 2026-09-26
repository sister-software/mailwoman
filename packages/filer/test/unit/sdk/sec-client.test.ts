/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Tests for {@linkcode createSECClient} — the SEC edgar client, built on
 *   `@mailwoman/core/api`'s {@linkcode APIClient}.
 */

import { createFakeClock, maxCountInSlidingWindow, VirtualClock } from "@mailwoman/core/api/test-clocks"
import { type StubOutcome, stubTransport, type StubTransport } from "@mailwoman/core/api/test-transport"
// `ResourceError` arrives as a value via the post-reset dynamic import below,
// so the type position needs this type-only static import.
import type { ResourceError as ResourceErrorShape } from "@mailwoman/core/errors"
import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { Globerator } from "spliterator/node/fs"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// `./sec-client.ts` is imported dynamically below, after `vi.resetModules()`;
// a static import would bind the module before the reset.

// The repo's real `.env` sets `SEC_EDGAR_USER_AGENT` (a live getter over `{ ...dotEnv, ...process.env }`),
// so `vi.stubEnv` cannot hide it; mock the module directly.
vi.mock("@mailwoman/filer/env", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@mailwoman/filer/env")>()

	return {
		...actual,
		$private: { ...actual.$private, SEC_EDGAR_USER_AGENT: undefined },
	}
})

// The root vitest config runs `isolate: false`, so `./sec-client.ts` may already sit in the
// worker's cache evaluated without this file's env mock; reset on the way in so the chain
// re-evaluates against the mock, and on the way out so the next file never inherits it.
vi.resetModules()
afterAll(() => vi.resetModules())

const { createSECClient, isImmutableArchiveURL, SEC_DEFAULT_REQUESTS_PER_SECOND, SEC_MAX_REQUESTS_PER_SECOND } =
	await import("@mailwoman/filer/sdk/sec-client")

const { isTransientResourceError } = await import("@mailwoman/core/api")
const { ResourceError } = await import("@mailwoman/core/errors")

const TEST_USER_AGENT = "Test Harness test@example.com"

let cacheDir: TemporaryDirectory

beforeEach(async () => {
	cacheDir = await temporaryDirectory("sec-client-test-")
})

afterEach(() => {
	cacheDir[Symbol.asyncDispose]()
	vi.useRealTimers()
})

describe("createSECClient: User-Agent fail-fast", () => {
	it("throws a descriptive error without an explicit userAgent and without SEC_EDGAR_USER_AGENT", () => {
		expect(() => createSECClient()).toThrow(/User-Agent/i)
		expect(() => createSECClient()).toThrow(/SEC_EDGAR_USER_AGENT/)
		expect(() => createSECClient()).toThrow(/accessing-edgar-data/)
	})

	it("does not throw when userAgent is passed explicitly", () => {
		const transport = stubTransport([{}])

		expect(() => createSECClient({ userAgent: TEST_USER_AGENT, cacheDir: cacheDir.path, ...transport })).not.toThrow()
	})
})

describe("createSECClient: request headers", () => {
	it("sends the configured User-Agent and the documented Accept-Encoding on every request, across hosts", async () => {
		const transport = stubTransport([{ body: { a: 1 } }, { body: { b: 2 } }])

		const client = createSECClient({
			userAgent: TEST_USER_AGENT,
			cacheDir: cacheDir.path,
			clock: createFakeClock(),
			...transport,
		})

		await client.get("https://data.sec.gov/submissions/CIK0000320193.json")
		await client.get("https://www.sec.gov/files/company_tickers.json")

		expect(transport.calls).toEqual([
			"https://data.sec.gov/submissions/CIK0000320193.json",
			"https://www.sec.gov/files/company_tickers.json",
		])

		for (const config of transport.configs) {
			expect(config.headers).toMatchObject({
				"User-Agent": TEST_USER_AGENT,
				"Accept-Encoding": "gzip, deflate",
			})
		}
	})

	it("wires the per-attempt timeout onto every request", async () => {
		const transport = stubTransport([{ body: { ok: true } }])

		const client = createSECClient({
			userAgent: TEST_USER_AGENT,
			cacheDir: cacheDir.path,
			clock: createFakeClock(),
			requestTimeoutMs: 12_345,
			...transport,
		})

		await client.get("https://data.sec.gov/timeout-config.json")

		expect(transport.configs[0]?.timeout).toBe(12_345)
	})
})

describe("createSECClient: host allowlist", () => {
	function clientFor(transport: StubTransport) {
		return createSECClient({
			userAgent: TEST_USER_AGENT,
			cacheDir: cacheDir.path,
			clock: createFakeClock(),
			...transport,
		})
	}

	it("refuses a non-SEC host before touching the network, as a non-transient ResourceError", async () => {
		const transport = stubTransport([{}])
		const url = "https://attacker.example.invalid/collect"

		const caught = await clientFor(transport)
			.get(url)
			.catch((error: unknown) => error)

		expect(caught).toBeInstanceOf(ResourceError)
		expect((caught as ResourceErrorShape).status).toBe(400)
		expect(isTransientResourceError(caught)).toBe(false)
		expect((caught as Error).message).toMatch(/SEC EDGAR hosts/)
		expect(transport.calls).toHaveLength(0)
	})

	it("refuses a non-https scheme, even for an otherwise-allowed host", async () => {
		const transport = stubTransport([{}])

		await expect(clientFor(transport).get("http://www.sec.gov/files/company_tickers.json")).rejects.toThrow(/https/i)
		expect(transport.calls).toHaveLength(0)
	})

	it("admits the apex host and the EDGAR full-text-search host (the Exhibit 21 discovery path)", async () => {
		const transport = stubTransport([{ body: { a: 1 } }, { body: { b: 2 } }])
		const client = clientFor(transport)

		expect(await client.get("https://sec.gov/index.json")).toEqual({ a: 1 })
		expect(await client.get("https://efts.sec.gov/LATEST/search-index?q=test")).toEqual({ b: 2 })
	})

	it.each([
		["case-folded", "https://WWW.SEC.GOV/files/company_tickers.json"],
		["userinfo-bearing", "https://user:pass@www.sec.gov/files/company_tickers.json"],
		["percent-encoded", "https://www%2Esec%2Egov/files/company_tickers.json"],
		// A trailing dot is the explicit root label: `www.sec.gov.` and `www.sec.gov` are the same host.
		["fully-qualified (trailing dot)", "https://www.sec.gov./files/company_tickers.json"],
		["apex", "https://sec.gov/files/company_tickers.json"],
		["data subdomain", "https://data.sec.gov/files/company_tickers.json"],
	])("admits a %s allowed host", async (_label, url) => {
		const transport = stubTransport([{ body: { ok: true } }])

		expect(await clientFor(transport).get(url)).toEqual({ ok: true })
		expect(transport.calls).toHaveLength(1)
	})

	it.each([
		["subdomain-suffix", "https://www.sec.gov.attacker.example/x"],
		["apex-suffix", "https://sec.gov.attacker.com/x"],
		["prefix-hyphen lookalike", "https://evil-sec.gov/x"],
		// The Cyrillic `с` punycodes to `www.xn--se-pmc.gov`, which is not the allowlisted host.
		["unicode homograph", "https://www.seс.gov/x"],
		// U+3002 ideographic full stop normalizes to `.`, turning this into a subdomain-suffix attempt.
		["ideographic full stop", "https://www.sec.gov。attacker.example/x"],
		["trailing dot on a disallowed host", "https://attacker.example./x"],
		["bare disallowed host", "https://secgov.example/x"],
	])("rejects a %s bypass attempt without dispatching", async (_label, url) => {
		const transport = stubTransport([{}])

		await expect(clientFor(transport).get(url)).rejects.toThrow(/SEC EDGAR hosts/)
		expect(transport.calls).toHaveLength(0)
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

describe("createSECClient: on-disk cache", () => {
	const url = "https://data.sec.gov/submissions/CIK0000320193.json"
	const archiveURL = "https://www.sec.gov/Archives/edgar/data/320193/000032019323000106/aapl-20230930.htm"

	it("caches a successful response and does not re-fetch on a second get() for the same URL", async () => {
		const transport = stubTransport([{ body: { cik: "0000320193" } }])

		const client = createSECClient({
			userAgent: TEST_USER_AGENT,
			cacheDir: cacheDir.path,
			clock: createFakeClock(),
			...transport,
		})

		expect(await client.get(url)).toEqual({ cik: "0000320193" })
		expect(await client.get(url)).toEqual({ cik: "0000320193" })
		expect(transport.calls).toHaveLength(1)
	})

	it("persists to disk, so a SEPARATE client instance over the same cacheDir.path hits it too", async () => {
		const first = stubTransport([{ body: { cik: "0000320193" } }])

		await createSECClient({
			userAgent: TEST_USER_AGENT,
			cacheDir: cacheDir.path,
			clock: createFakeClock(),
			...first,
		}).get(url)

		const second = stubTransport([{ body: { cik: "SHOULD-NOT-BE-FETCHED" } }])

		const client = createSECClient({
			userAgent: TEST_USER_AGENT,
			cacheDir: cacheDir.path,
			clock: createFakeClock(),
			...second,
		})

		expect(await client.get(url)).toEqual({ cik: "0000320193" })
		expect(second.calls).toHaveLength(0)
	})

	it("expires a MUTABLE (non-archive) URL's cache entry after cacheTTLMs, triggering a re-fetch", async () => {
		// `axios-cache-interceptor` stamps `createdAt`/expiry off `Date.now()`, not the
		// injected `ClockLike`, so cache age is driven by faking `Date` specifically.
		vi.useFakeTimers({ toFake: ["Date"] })
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"))

		const transport = stubTransport([{ body: { v: 1 } }, { body: { v: 2 } }])

		const client = createSECClient({
			userAgent: TEST_USER_AGENT,
			cacheDir: cacheDir.path,
			clock: createFakeClock(),
			cacheTTLMs: 1000,
			...transport,
		})

		expect(await client.get(url)).toEqual({ v: 1 })
		expect(transport.calls).toHaveLength(1)

		vi.setSystemTime(new Date("2026-01-01T00:00:01.001Z"))

		expect(await client.get(url)).toEqual({ v: 2 })
		expect(transport.calls).toHaveLength(2)
	})

	it("never expires an ARCHIVE-path URL's cache entry, even a year past cacheTTLMs", async () => {
		vi.useFakeTimers({ toFake: ["Date"] })
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"))

		const transport = stubTransport([{ body: { v: 1 } }, { body: { v: 2 } }])

		const client = createSECClient({
			userAgent: TEST_USER_AGENT,
			cacheDir: cacheDir.path,
			clock: createFakeClock(),
			cacheTTLMs: 1000,
			...transport,
		})

		expect(await client.get(archiveURL)).toEqual({ v: 1 })

		vi.setSystemTime(new Date("2027-01-01T00:00:00Z"))

		expect(await client.get(archiveURL)).toEqual({ v: 1 })
		expect(transport.calls).toHaveLength(1)
	})

	it("ignores SEC's own Cache-Control, so the archive-forever rule survives a short max-age", async () => {
		// sec.gov serves `Cache-Control` on these endpoints, so with header interpretation on
		// the interceptor would derive the TTL from it and override the immutable-archive rule.
		vi.useFakeTimers({ toFake: ["Date"] })
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"))

		const transport = stubTransport([
			{ body: { v: 1 }, headers: { "cache-control": "max-age=1" } },
			{ body: { v: 2 }, headers: { "cache-control": "max-age=1" } },
		])

		const client = createSECClient({
			userAgent: TEST_USER_AGENT,
			cacheDir: cacheDir.path,
			clock: createFakeClock(),
			...transport,
		})

		expect(await client.get(archiveURL)).toEqual({ v: 1 })
		expect(transport.calls).toHaveLength(1)

		vi.setSystemTime(new Date("2026-01-01T00:00:30Z"))

		expect(await client.get(archiveURL)).toEqual({ v: 1 })
		expect(transport.calls).toHaveLength(1)
	})

	it("treats URLs differing only by query string as DISTINCT cache entries", async () => {
		// browse-edgar's entire identity is its query string, so collapsing `origin + pathname`
		// into the cache key would merge every distinct CIK lookup.
		const transport = stubTransport([{ body: { cik: "0000320193" } }, { body: { cik: "0000789019" } }])

		const client = createSECClient({
			userAgent: TEST_USER_AGENT,
			cacheDir: cacheDir.path,
			clock: createFakeClock(),
			...transport,
		})

		expect(await client.get("https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000320193")).toEqual({
			cik: "0000320193",
		})

		expect(await client.get("https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000789019")).toEqual({
			cik: "0000789019",
		})

		expect(transport.calls).toHaveLength(2)
	})

	it("never writes a cache entry for a failed response — a later request still hits the network", async () => {
		const errorURL = "https://data.sec.gov/error-not-cached-test.json"
		const failing = stubTransport([{ status: 500, statusText: "Internal Server Error" }])

		const failingClient = createSECClient({
			userAgent: TEST_USER_AGENT,
			cacheDir: cacheDir.path,
			clock: createFakeClock(),
			maxAttempts: 1,
			...failing,
		})

		await expect(failingClient.get(errorURL)).rejects.toThrow(/500/)
		expect(await Globerator.from("*", { cwd: cacheDir.path }).toArray()).toHaveLength(0)

		const succeeding = stubTransport([{ body: { ok: true } }])

		const succeedingClient = createSECClient({
			userAgent: TEST_USER_AGENT,
			cacheDir: cacheDir.path,
			clock: createFakeClock(),
			...succeeding,
		})

		expect(await succeedingClient.get(errorURL)).toEqual({ ok: true })
		expect(succeeding.calls).toHaveLength(1)
	})

	it("does not cache a 200 with a non-JSON body, names the URL, and self-heals", async () => {
		const bad = stubTransport([{ body: "<html>not json</html>" }])

		const client = createSECClient({
			userAgent: TEST_USER_AGENT,
			cacheDir: cacheDir.path,
			clock: createFakeClock(),
			maxAttempts: 1,
			...bad,
		})

		const caught = await client.get(archiveURL).catch((error: unknown) => error)

		expect(caught).toBeInstanceOf(ResourceError)
		expect((caught as Error).message).toContain(archiveURL)
		expect(isTransientResourceError(caught)).toBe(false)
		expect(await Globerator.from("*", { cwd: cacheDir.path }).toArray()).toHaveLength(0)

		const fixed = stubTransport([{ body: { ok: true } }])

		const fixedClient = createSECClient({
			userAgent: TEST_USER_AGENT,
			cacheDir: cacheDir.path,
			clock: createFakeClock(),
			...fixed,
		})

		expect(await fixedClient.get(archiveURL)).toEqual({ ok: true })
		expect(fixed.calls).toHaveLength(1)
	})
})

describe("createSECClient: getDocument — the raw-text path get() cannot provide", () => {
	const archiveURL = "https://www.sec.gov/Archives/edgar/data/320193/000032019323000106/ex21.htm"

	it("returns the raw HTML body as text, not JSON-parsed", async () => {
		const transport = stubTransport([{ body: "<html><body>Exhibit 21</body></html>" }])

		const client = createSECClient({
			userAgent: TEST_USER_AGENT,
			cacheDir: cacheDir.path,
			clock: createFakeClock(),
			...transport,
		})

		expect(await client.getDocument(archiveURL)).toBe("<html><body>Exhibit 21</body></html>")
	})

	it("shares the host allowlist with get() — refuses a non-SEC host before touching the network", async () => {
		const transport = stubTransport([{}])

		const client = createSECClient({
			userAgent: TEST_USER_AGENT,
			cacheDir: cacheDir.path,
			clock: createFakeClock(),
			...transport,
		})

		const caught = await client.getDocument("https://attacker.example.invalid/collect").catch((error: unknown) => error)

		expect(caught).toBeInstanceOf(ResourceError)
		expect(isTransientResourceError(caught)).toBe(false)
		expect(transport.calls).toHaveLength(0)
	})

	it("explains a 403 the same way get() does — this client did not identify itself", async () => {
		const transport = stubTransport([{ status: 403, statusText: "Forbidden" }])

		const client = createSECClient({
			userAgent: TEST_USER_AGENT,
			cacheDir: cacheDir.path,
			clock: createFakeClock(),
			...transport,
		})

		const caught = await client.getDocument(archiveURL).catch((error: unknown) => error)

		expect(caught).toBeInstanceOf(ResourceError)
		expect((caught as ResourceErrorShape).status).toBe(403)
		expect((caught as Error).message).toMatch(/did NOT identify itself/i)
	})

	it("caches a fetched document under the permanent archive TTL — a second call never re-fetches", async () => {
		const transport = stubTransport([{ body: "<html>filing text</html>" }])

		const client = createSECClient({
			userAgent: TEST_USER_AGENT,
			cacheDir: cacheDir.path,
			clock: createFakeClock(),
			...transport,
		})

		expect(await client.getDocument(archiveURL)).toBe("<html>filing text</html>")
		expect(await client.getDocument(archiveURL)).toBe("<html>filing text</html>")
		expect(transport.calls).toHaveLength(1)
	})

	it("does not persist a truncated/empty text body, so a later fetch still hits the network", async () => {
		const bad = stubTransport([{ body: "" }, { body: "<html>filing text</html>" }])

		const client = createSECClient({
			userAgent: TEST_USER_AGENT,
			cacheDir: cacheDir.path,
			clock: createFakeClock(),
			maxAttempts: 1,
			...bad,
		})

		expect(await client.getDocument(archiveURL)).toBe("")
		expect(await Globerator.from("*", { cwd: cacheDir.path }).toArray()).toHaveLength(0)

		expect(await client.getDocument(archiveURL)).toBe("<html>filing text</html>")
		expect(bad.calls).toHaveLength(2)
	})

	it("shares the on-disk cache with get() by URL — a document fetched via getDocument reads back as text on a fresh client instance", async () => {
		const first = stubTransport([{ body: "<html>persisted</html>" }])

		await createSECClient({
			userAgent: TEST_USER_AGENT,
			cacheDir: cacheDir.path,
			clock: createFakeClock(),
			...first,
		}).getDocument(archiveURL)

		const second = stubTransport([{ body: "SHOULD-NOT-BE-FETCHED" }])

		const client = createSECClient({
			userAgent: TEST_USER_AGENT,
			cacheDir: cacheDir.path,
			clock: createFakeClock(),
			...second,
		})

		expect(await client.getDocument(archiveURL)).toBe("<html>persisted</html>")
		expect(second.calls).toHaveLength(0)
	})
})

describe("createSECClient: stampede guard", () => {
	it("de-dupes concurrent misses for the SAME url onto a single in-flight request", async () => {
		const transport = stubTransport([{ body: { v: 1 } }])

		const client = createSECClient({
			userAgent: TEST_USER_AGENT,
			cacheDir: cacheDir.path,
			clock: createFakeClock(),
			...transport,
		})

		const url = "https://data.sec.gov/stampede-test.json"

		const results = await Promise.all([client.get(url), client.get(url), client.get(url)])

		expect(results).toEqual([{ v: 1 }, { v: 1 }, { v: 1 }])
		expect(transport.calls).toHaveLength(1)
	})
})

describe("createSECClient: rate limiting", () => {
	it("paces get() calls, clamped to the SEC ceiling regardless of a higher request", async () => {
		const clock = createFakeClock()
		const transport = stubTransport([{ body: { a: 1 } }, { body: { b: 2 } }])

		const client = createSECClient({
			userAgent: TEST_USER_AGENT,
			cacheDir: cacheDir.path,
			clock,
			requestsPerSecond: 100,
			...transport,
		})

		await client.get("https://data.sec.gov/rate-test/0.json")
		expect(clock.sleepCalls).toHaveLength(0)

		await client.get("https://data.sec.gov/rate-test/1.json")
		// Clamped to the 10/s ceiling (100ms), not the requested 100/s (10ms).
		expect(clock.sleepCalls).toEqual([100])
	})

	it("holds the DEFAULT rate, one under the published ceiling, across a 40-call concurrent fan-out", async () => {
		const FAN_OUT = 40
		// The interval is ceiled because `1000/9` is `111.111…`, which places the 10th grant
		// at exactly 1000.0ms after the first and lets any jitter admit a 10th arrival.
		const INTERVAL_MS = Math.ceil(1000 / SEC_DEFAULT_REQUESTS_PER_SECOND)

		expect(SEC_DEFAULT_REQUESTS_PER_SECOND).toBeLessThan(SEC_MAX_REQUESTS_PER_SECOND)

		const clock = new VirtualClock()
		const transport = stubTransport([{ body: { ok: true } }], { clock })

		const client = createSECClient({ userAgent: TEST_USER_AGENT, cacheDir: cacheDir.path, clock, ...transport })

		// `runUntilSettled` is required because the pacing check sits downstream of the on-disk cache
		// lookup, so each request spends real event-loop turns in `readFile` before registering its sleep.
		await clock.runUntilSettled(
			Promise.all(Array.from({ length: FAN_OUT }, (_, i) => client.get(`https://data.sec.gov/fanout/${i}.json`)))
		)

		const arrivals = transport.dispatchTimes

		expect(arrivals).toHaveLength(FAN_OUT)
		expect(transport.calls).toHaveLength(FAN_OUT)

		for (let i = 1; i < arrivals.length; i++) {
			expect(arrivals[i]! - arrivals[i - 1]!).toBeGreaterThanOrEqual(INTERVAL_MS)
		}

		expect(maxCountInSlidingWindow(arrivals, 1000)).toBe(SEC_DEFAULT_REQUESTS_PER_SECOND)
	})
})

describe("createSECClient: bounded retry with backoff on 429/5xx and network-class failures", () => {
	it("retries a transient 429 with exponential backoff and succeeds once the server recovers", async () => {
		const clock = createFakeClock()

		const transport = stubTransport([
			{ status: 429, statusText: "Too Many Requests" },
			{ status: 429, statusText: "Too Many Requests" },
			{ body: { ok: true } },
		])

		const client = createSECClient({
			userAgent: TEST_USER_AGENT,
			cacheDir: cacheDir.path,
			clock,
			maxAttempts: 3,
			baseRetryDelayMs: 500,
			...transport,
		})

		expect(await client.get("https://data.sec.gov/retry-test.json")).toEqual({ ok: true })
		expect(transport.calls).toHaveLength(3)
		expect(clock.sleepCalls).toEqual([500, 1000])
	})

	it("gives up after maxAttempts on a persistent 503 — bounded, not until it works", async () => {
		const transport = stubTransport([{ status: 503, statusText: "Service Unavailable" }])

		const client = createSECClient({
			userAgent: TEST_USER_AGENT,
			cacheDir: cacheDir.path,
			clock: createFakeClock(),
			maxAttempts: 2,
			baseRetryDelayMs: 1,
			...transport,
		})

		const caught = await client.get("https://data.sec.gov/retry-ceiling-test.json").catch((error: unknown) => error)

		expect(caught).toBeInstanceOf(ResourceError)
		expect((caught as ResourceErrorShape).status).toBe(503)
		expect(transport.calls).toHaveLength(2)
	})

	it("does NOT retry a 403, and the error says the request failed to identify itself", async () => {
		const transport = stubTransport([{ status: 403, statusText: "Forbidden" }])

		const client = createSECClient({
			userAgent: TEST_USER_AGENT,
			cacheDir: cacheDir.path,
			clock: createFakeClock(),
			maxAttempts: 5,
			...transport,
		})

		const caught = await client.get("https://www.sec.gov/files/company_tickers.json").catch((error: unknown) => error)

		expect(caught).toBeInstanceOf(ResourceError)
		expect((caught as ResourceErrorShape).status).toBe(403)
		expect((caught as Error).message).toMatch(/did NOT identify itself/i)
		expect((caught as Error).message).toContain(TEST_USER_AGENT)
		expect(transport.calls).toHaveLength(1)
	})

	it("throws a non-retryable ResourceError for a 404, without retrying", async () => {
		const transport = stubTransport([{ status: 404, statusText: "Not Found" }])

		const client = createSECClient({
			userAgent: TEST_USER_AGENT,
			cacheDir: cacheDir.path,
			clock: createFakeClock(),
			maxAttempts: 5,
			...transport,
		})

		const caught = await client
			.get("https://data.sec.gov/submissions/CIK9999999999.json")
			.catch((error: unknown) => error)

		expect((caught as ResourceErrorShape).status).toBe(404)
		expect(transport.calls).toHaveLength(1)
	})

	it("retries a connect-class network error under the same bounded policy, then succeeds", async () => {
		const clock = createFakeClock()

		const transport = stubTransport([
			{ throws: { message: "socket hang up: ECONNRESET", code: "ERR_NETWORK" } },
			{ body: { ok: true } },
		])

		const client = createSECClient({
			userAgent: TEST_USER_AGENT,
			cacheDir: cacheDir.path,
			clock,
			maxAttempts: 3,
			baseRetryDelayMs: 500,
			...transport,
		})

		expect(await client.get("https://data.sec.gov/network-error-test.json")).toEqual({ ok: true })
		expect(transport.calls).toHaveLength(2)
		expect(clock.sleepCalls).toEqual([500])
	})

	it.each([
		["numeric", "60", 60_000],
		["clamped", "999999", 60_000],
		["unparseable (fails LONG, never the short exponential)", "not-a-valid-value", 60_000],
		// RFC 9110's `delay-seconds` is `1*digit` only, and `Number()` is laxer,
		// so a naive parse would honor these as a plausible-looking wait.
		["hex-looking", "0x10", 60_000],
		["fractional", "1.5", 60_000],
	])("honors a %s Retry-After over the default exponential backoff", async (_label, header, expected) => {
		const clock = createFakeClock()

		const transport = stubTransport([
			{ status: 429, statusText: "Too Many Requests", headers: { "retry-after": header } },
			{ body: { ok: true } },
		])

		const client = createSECClient({
			userAgent: TEST_USER_AGENT,
			cacheDir: cacheDir.path,
			clock,
			maxAttempts: 2,
			baseRetryDelayMs: 500,
			...transport,
		})

		await client.get(`https://data.sec.gov/retry-after-test.json?v=${encodeURIComponent(header)}`)

		expect(clock.sleepCalls).toEqual([expected])
	})

	it("honors an HTTP-date Retry-After, not just the numeric delay-seconds form", async () => {
		const clock = createFakeClock()
		const retryAt = new Date(Date.now() + 45_000)

		const transport = stubTransport([
			{ status: 429, statusText: "Too Many Requests", headers: { "retry-after": retryAt.toUTCString() } },
			{ body: { ok: true } },
		])

		const client = createSECClient({
			userAgent: TEST_USER_AGENT,
			cacheDir: cacheDir.path,
			clock,
			maxAttempts: 2,
			baseRetryDelayMs: 500,
			...transport,
		})

		await client.get("https://data.sec.gov/retry-after-date-test.json")

		expect(clock.sleepCalls).toHaveLength(1)
		expect(clock.sleepCalls[0]).toBeGreaterThan(40_000)
		expect(clock.sleepCalls[0]).toBeLessThanOrEqual(45_000)
	})
})

describe("createSECClient: the caller's failure taxonomy, decided without reading any message", () => {
	async function failureFor(outcomes: StubOutcome[], maxAttempts = 2): Promise<unknown> {
		const transport = stubTransport(outcomes)

		const client = createSECClient({
			userAgent: TEST_USER_AGENT,
			cacheDir: cacheDir.path,
			clock: createFakeClock(),
			maxAttempts,
			baseRetryDelayMs: 1,
			...transport,
		})

		return client.get("https://data.sec.gov/taxonomy-probe.json").catch((error: unknown) => error)
	}

	it("404 → skip this filing", async () => {
		const error = await failureFor([{ status: 404, statusText: "Not Found" }])

		expect((error as ResourceErrorShape).status).toBe(404)
		expect(isTransientResourceError(error)).toBe(false)
	})

	it("403 → abort the run", async () => {
		const error = await failureFor([{ status: 403, statusText: "Forbidden" }])

		expect((error as ResourceErrorShape).status).toBe(403)
		expect(isTransientResourceError(error)).toBe(false)
	})

	it("exhausted 429 → requeue", async () => {
		const error = await failureFor([{ status: 429, statusText: "Too Many Requests" }])

		expect((error as ResourceErrorShape).status).toBe(429)
		expect(isTransientResourceError(error)).toBe(true)
	})

	it("exhausted 5xx → requeue", async () => {
		const error = await failureFor([{ status: 503, statusText: "Service Unavailable" }])

		expect(isTransientResourceError(error)).toBe(true)
	})

	it("exhausted network failure → requeue", async () => {
		const error = await failureFor([{ throws: { message: "socket hang up", code: "ERR_NETWORK" } }])

		expect(error).toBeInstanceOf(ResourceError)
		expect(isTransientResourceError(error)).toBe(true)
	})

	it("exhausted timeout → requeue", async () => {
		// Axios reports its own `timeout` config as econnaborted, which must read as
		// network-class rather than as a caller-initiated cancel.
		const error = await failureFor([{ throws: { message: "timeout of 30000ms exceeded", code: "ECONNABORTED" } }])

		expect(error).toBeInstanceOf(ResourceError)
		expect(isTransientResourceError(error)).toBe(true)
	})

	it("a disallowed host → a programmer bug, never requeued", async () => {
		const transport = stubTransport([{}])

		const client = createSECClient({
			userAgent: TEST_USER_AGENT,
			cacheDir: cacheDir.path,
			clock: createFakeClock(),
			...transport,
		})

		const error = await client.get("https://attacker.example/x").catch((caught: unknown) => caught)

		expect(isTransientResourceError(error)).toBe(false)
	})
})
