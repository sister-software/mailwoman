/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Tests for {@linkcode createSECClient} — the SEC EDGAR client, now built on
 *   `@mailwoman/core/api`'s {@linkcode APIClient}.
 *
 *   Every test drives a stub Axios ADAPTER and, where timing matters, an injected `ClockLike`: no test
 *   here performs a live network call or a real wall-clock sleep (decision 5). Cache-expiry tests fake
 *   `Date` specifically, because `axios-cache-interceptor` stamps `createdAt` off `Date.now()` rather
 *   than off this client's injectable clock.
 *
 *   The stub errors are built structurally (`isAxiosError: true` plus `config`/`response`/`code`)
 *   rather than with `new AxiosError(...)`: `filer` depends on neither `axios` nor
 *   `axios-cache-interceptor`, reaching both only through `@mailwoman/core`, and a test file is not a
 *   reason to breach that.
 */

import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { APIClientConfig } from "@mailwoman/core/api"
import {
	createFakeClock,
	drainMicrotasks,
	maxCountInSlidingWindow,
	VirtualClock,
} from "@mailwoman/core/api/test-clocks"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
	createSECClient,
	isImmutableArchiveURL,
	isTransientResourceError,
	ResourceError,
	SEC_DEFAULT_REQUESTS_PER_SECOND,
	SEC_MAX_REQUESTS_PER_SECOND,
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

/**
 * The interesting subset of an Axios request config, as a stub adapter sees it.
 */
interface StubRequestConfig {
	url?: string
	headers?: Record<string, unknown>
	timeout?: number
}

/**
 * One scripted adapter outcome.
 */
interface StubOutcome {
	status?: number
	statusText?: string
	/**
	 * The RAW body, as the transport would hand it to Axios's `transformResponse`. A string here is what an upstream
	 * serving HTML under a 200 actually looks like.
	 */
	body?: unknown
	headers?: Record<string, string>
	/**
	 * A transport-level failure — no HTTP response ever arrives. `code` picks the class: `ERR_NETWORK` for a dropped
	 * socket, `ECONNABORTED` for this attempt's own timeout firing.
	 */
	throws?: { message: string; code: string }
}

/**
 * The Axios overrides `createSECClient` accepts, reached through `APIClientConfig` rather than by importing `axios`.
 */
type AxiosOverrides = NonNullable<APIClientConfig["axios"]>

interface StubTransport {
	/**
	 * Spread into `createSECClient()` as its `axios` override.
	 */
	axios: AxiosOverrides
	calls: string[]
	configs: StubRequestConfig[]
	dispatchTimes: number[]
}

const HTTP_OK = 200
const HTTP_MULTIPLE_CHOICES = 300

/**
 * Build an Axios-shaped rejection without importing `axios`. `isAxiosError(payload)` is `isObject(payload) &&
 * payload.isAxiosError === true`, and everything downstream reads `config`, `code`, and `response` — so this is the
 * full contract that matters here.
 */
function axiosLikeError(message: string, code: string, config: StubRequestConfig, response?: unknown): Error {
	const error = new Error(message) as Error & Record<string, unknown>

	error.isAxiosError = true
	error.code = code
	error.config = config

	if (response) {
		error.response = response
	}

	return error
}

/**
 * A stub Axios adapter that replays `outcomes` (holding on the last entry once exhausted) and records every dispatch.
 * It reproduces what Axios's real adapters do on a failing status — reject with an Axios-shaped error carrying the
 * response — because `validateStatus` is applied by the adapter, not by the interceptor chain.
 */
function stubTransport(outcomes: StubOutcome[], clock?: { now(): number }): StubTransport {
	const calls: string[] = []
	const configs: StubRequestConfig[] = []
	const dispatchTimes: number[] = []
	let index = 0

	const adapter = async (config: StubRequestConfig): Promise<unknown> => {
		calls.push(String(config.url))
		configs.push(config)

		if (clock) {
			dispatchTimes.push(clock.now())
		}

		const outcome = outcomes[Math.min(index, outcomes.length - 1)]!

		index++

		if (outcome.throws) {
			throw axiosLikeError(outcome.throws.message, outcome.throws.code, config)
		}

		const status = outcome.status ?? HTTP_OK

		const response = {
			// Axios's `transformResponse` runs on the RAW body, so hand it a string exactly like the wire would.
			data: typeof outcome.body === "string" ? outcome.body : JSON.stringify(outcome.body ?? { ok: true }),
			status,
			statusText: outcome.statusText ?? "OK",
			headers: outcome.headers ?? {},
			config,
		}

		if (status >= HTTP_OK && status < HTTP_MULTIPLE_CHOICES) return response

		throw axiosLikeError(
			`Request failed with status code ${status}`,
			status >= 500 ? "ERR_BAD_RESPONSE" : "ERR_BAD_REQUEST",
			config,
			response
		)
	}

	// Structurally an Axios adapter. The precise `AxiosAdapter` signature isn't nameable here without
	// importing `axios`, which this workspace deliberately does not depend on.
	return { axios: { adapter } as AxiosOverrides, calls, configs, dispatchTimes }
}

let cacheDir: string

beforeEach(() => {
	cacheDir = mkdtempSync(join(tmpdir(), "sec-client-test-"))
})

afterEach(() => {
	rmSync(cacheDir, { recursive: true, force: true })
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

		expect(() => createSECClient({ userAgent: TEST_USER_AGENT, cacheDir, ...transport })).not.toThrow()
	})
})

describe("createSECClient: request headers", () => {
	it("sends the configured User-Agent and the documented Accept-Encoding on every request, across hosts", async () => {
		const transport = stubTransport([{ body: { a: 1 } }, { body: { b: 2 } }])

		const client = createSECClient({ userAgent: TEST_USER_AGENT, cacheDir, clock: createFakeClock(), ...transport })

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
			cacheDir,
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
		return createSECClient({ userAgent: TEST_USER_AGENT, cacheDir, clock: createFakeClock(), ...transport })
	}

	it("refuses a non-SEC host before touching the network, as a non-transient ResourceError", async () => {
		const transport = stubTransport([{}])
		const url = "https://attacker.example.invalid/collect"

		const caught = await clientFor(transport)
			.get(url)
			.catch((error: unknown) => error)

		expect(caught).toBeInstanceOf(ResourceError)
		expect((caught as ResourceError).status).toBe(400)
		expect(isTransientResourceError(caught)).toBe(false)
		expect((caught as Error).message).toMatch(/SEC EDGAR hosts/)
		expect(transport.calls).toHaveLength(0)
	})

	it("refuses a non-https scheme, even for an otherwise-allowed host", async () => {
		const transport = stubTransport([{}])

		await expect(clientFor(transport).get("http://www.sec.gov/files/company_tickers.json")).rejects.toThrow(/https/i)
		expect(transport.calls).toHaveLength(0)
	})

	it("admits the apex host and the EDGAR full-text-search host (task 8's Exhibit 21 discovery path)", async () => {
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
		// U+3002 IDEOGRAPHIC FULL STOP normalizes to `.`, turning this into a subdomain-suffix attempt.
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
		const client = createSECClient({ userAgent: TEST_USER_AGENT, cacheDir, clock: createFakeClock(), ...transport })

		expect(await client.get(url)).toEqual({ cik: "0000320193" })
		expect(await client.get(url)).toEqual({ cik: "0000320193" })
		expect(transport.calls).toHaveLength(1)
	})

	it("persists to disk, so a SEPARATE client instance over the same cacheDir hits it too", async () => {
		const first = stubTransport([{ body: { cik: "0000320193" } }])

		await createSECClient({ userAgent: TEST_USER_AGENT, cacheDir, clock: createFakeClock(), ...first }).get(url)

		const second = stubTransport([{ body: { cik: "SHOULD-NOT-BE-FETCHED" } }])

		const client = createSECClient({ userAgent: TEST_USER_AGENT, cacheDir, clock: createFakeClock(), ...second })

		expect(await client.get(url)).toEqual({ cik: "0000320193" })
		expect(second.calls).toHaveLength(0)
	})

	it("expires a MUTABLE (non-archive) URL's cache entry after cacheTTLMs, triggering a re-fetch", async () => {
		// `axios-cache-interceptor` stamps `createdAt`/expiry off `Date.now()`, not off the injected
		// `ClockLike`, so cache AGE is driven by faking `Date` specifically.
		vi.useFakeTimers({ toFake: ["Date"] })
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"))

		const transport = stubTransport([{ body: { v: 1 } }, { body: { v: 2 } }])

		const client = createSECClient({
			userAgent: TEST_USER_AGENT,
			cacheDir,
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
			cacheDir,
			clock: createFakeClock(),
			cacheTTLMs: 1000,
			...transport,
		})

		expect(await client.get(archiveURL)).toEqual({ v: 1 })

		vi.setSystemTime(new Date("2027-01-01T00:00:00Z"))

		expect(await client.get(archiveURL)).toEqual({ v: 1 })
		expect(transport.calls).toHaveLength(1)
	})

	it("treats URLs differing only by query string as DISTINCT cache entries", async () => {
		// browse-edgar's entire identity IS its query string — collapsing `origin + pathname` into the
		// cache key would silently merge every distinct CIK lookup into one entry.
		const transport = stubTransport([{ body: { cik: "0000320193" } }, { body: { cik: "0000789019" } }])
		const client = createSECClient({ userAgent: TEST_USER_AGENT, cacheDir, clock: createFakeClock(), ...transport })

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
			cacheDir,
			clock: createFakeClock(),
			maxAttempts: 1,
			...failing,
		})

		await expect(failingClient.get(errorURL)).rejects.toThrow(/500/)
		expect(readdirSync(cacheDir)).toHaveLength(0)

		const succeeding = stubTransport([{ body: { ok: true } }])

		const succeedingClient = createSECClient({
			userAgent: TEST_USER_AGENT,
			cacheDir,
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
			cacheDir,
			clock: createFakeClock(),
			maxAttempts: 1,
			...bad,
		})

		const caught = await client.get(archiveURL).catch((error: unknown) => error)

		expect(caught).toBeInstanceOf(ResourceError)
		expect((caught as Error).message).toContain(archiveURL)
		// An unchanged bad body cannot be fixed by retrying, so it must not be requeued either.
		expect(isTransientResourceError(caught)).toBe(false)
		expect(readdirSync(cacheDir)).toHaveLength(0)

		// Nothing was poisoned, so a later attempt against the same (archive!) URL still fetches.
		const fixed = stubTransport([{ body: { ok: true } }])

		const fixedClient = createSECClient({ userAgent: TEST_USER_AGENT, cacheDir, clock: createFakeClock(), ...fixed })

		expect(await fixedClient.get(archiveURL)).toEqual({ ok: true })
		expect(fixed.calls).toHaveLength(1)
	})
})

describe("createSECClient: stampede guard", () => {
	it("de-dupes concurrent misses for the SAME url onto a single in-flight request", async () => {
		const transport = stubTransport([{ body: { v: 1 } }])
		const client = createSECClient({ userAgent: TEST_USER_AGENT, cacheDir, clock: createFakeClock(), ...transport })
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
			cacheDir,
			clock,
			requestsPerSecond: 100, // attempts to exceed the policy ceiling
			...transport,
		})

		await client.get("https://data.sec.gov/rate-test/0.json")
		expect(clock.sleepCalls).toHaveLength(0) // the very first call is always immediate

		await client.get("https://data.sec.gov/rate-test/1.json")
		// Clamped to 10/s (100ms) — NOT the requested 100/s (10ms).
		expect(clock.sleepCalls).toEqual([100])
	})

	it("holds the DEFAULT rate, one under the published ceiling, across a 40-call concurrent fan-out", async () => {
		const FAN_OUT = 40
		// The default is SEC_DEFAULT_REQUESTS_PER_SECOND (9), not the ceiling. Pacing exactly at 10/s put 11 requests
		// inside a sliding second on 3 of 3 real-timer runs — the grants were spaced right, but the continuation that
		// issues each request lands 0-2ms late and tips one across the boundary. Asserting the ceiling here would pin
		// the schedule that measured as a violation.
		const INTERVAL_MS = 1000 / SEC_DEFAULT_REQUESTS_PER_SECOND

		expect(SEC_DEFAULT_REQUESTS_PER_SECOND).toBeLessThan(SEC_MAX_REQUESTS_PER_SECOND)

		const clock = new VirtualClock()
		const transport = stubTransport([{ body: { ok: true } }], clock)

		const client = createSECClient({ userAgent: TEST_USER_AGENT, cacheDir, clock, ...transport })

		const pending = Array.from({ length: FAN_OUT }, (_, i) => client.get(`https://data.sec.gov/fanout/${i}.json`))

		await drainMicrotasks()
		await clock.advance(Math.ceil((FAN_OUT - 1) * INTERVAL_MS))
		await Promise.all(pending)

		// GRANT instants, taken from the pacer's own reservations rather than from when the stub adapter
		// happened to run. Every one of the 40 calls reserves its slot in the same synchronous turn, so
		// caller `k` sleeps exactly `k * INTERVAL_MS` from t=0 and the first sleeps not at all. Reading
		// the schedule here (instead of timestamping inside the adapter) keeps the assertion independent
		// of the real filesystem latency the on-disk cache adds between a grant and the dispatch.
		const grantTimes = [0, ...clock.sleepCalls]

		expect(grantTimes).toHaveLength(FAN_OUT)
		expect(new Set(grantTimes).size).toBe(FAN_OUT)

		// Assert the PROPERTIES the pacer exists to guarantee, not a recomputed schedule. 1000/9 is not an integer and
		// each sleep is ceiled, so reproducing the exact instants here would couple the test to float arithmetic and
		// break on any rate that divides unevenly — while proving nothing extra. What matters: strictly increasing, never
		// closer together than the interval, and never more than the configured rate inside any sliding second.
		for (let i = 1; i < grantTimes.length; i++) {
			expect(grantTimes[i]! - grantTimes[i - 1]!).toBeGreaterThanOrEqual(Math.floor(INTERVAL_MS))
		}

		expect(maxCountInSlidingWindow(grantTimes, 1000)).toBe(SEC_DEFAULT_REQUESTS_PER_SECOND)
		expect(transport.calls).toHaveLength(FAN_OUT)
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
			cacheDir,
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
			cacheDir,
			clock: createFakeClock(),
			maxAttempts: 2,
			baseRetryDelayMs: 1,
			...transport,
		})

		const caught = await client.get("https://data.sec.gov/retry-ceiling-test.json").catch((error: unknown) => error)

		expect(caught).toBeInstanceOf(ResourceError)
		expect((caught as ResourceError).status).toBe(503)
		expect(transport.calls).toHaveLength(2)
	})

	it("does NOT retry a 403, and the error says the request failed to identify itself", async () => {
		const transport = stubTransport([{ status: 403, statusText: "Forbidden" }])

		const client = createSECClient({
			userAgent: TEST_USER_AGENT,
			cacheDir,
			clock: createFakeClock(),
			maxAttempts: 5,
			...transport,
		})

		const caught = await client.get("https://www.sec.gov/files/company_tickers.json").catch((error: unknown) => error)

		expect(caught).toBeInstanceOf(ResourceError)
		expect((caught as ResourceError).status).toBe(403)
		expect((caught as Error).message).toMatch(/did NOT identify itself/i)
		expect((caught as Error).message).toContain(TEST_USER_AGENT)
		expect(transport.calls).toHaveLength(1)
	})

	it("throws a non-retryable ResourceError for a 404, without retrying", async () => {
		const transport = stubTransport([{ status: 404, statusText: "Not Found" }])

		const client = createSECClient({
			userAgent: TEST_USER_AGENT,
			cacheDir,
			clock: createFakeClock(),
			maxAttempts: 5,
			...transport,
		})

		const caught = await client
			.get("https://data.sec.gov/submissions/CIK9999999999.json")
			.catch((error: unknown) => error)

		expect((caught as ResourceError).status).toBe(404)
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
			cacheDir,
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
		// RFC 9110's `delay-seconds` is `1*DIGIT` only. `Number()` is laxer than the grammar, so a naive
		// parse would silently honor either of these as a plausible-looking wait.
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
			cacheDir,
			clock,
			maxAttempts: 2,
			baseRetryDelayMs: 500, // must NOT be what gets slept
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
			cacheDir,
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

// The contract tasks 6-8 depend on. Each branch is decided from `status` and
// `isTransientResourceError()` alone — never from message text, which is the trap the standalone
// client's own suite fell into (it matched `/network error/i` to identify a transport failure).
describe("createSECClient: the caller's failure taxonomy, decided without reading any message", () => {
	async function failureFor(outcomes: StubOutcome[], maxAttempts = 2): Promise<unknown> {
		const transport = stubTransport(outcomes)

		const client = createSECClient({
			userAgent: TEST_USER_AGENT,
			cacheDir,
			clock: createFakeClock(),
			maxAttempts,
			baseRetryDelayMs: 1,
			...transport,
		})

		return client.get("https://data.sec.gov/taxonomy-probe.json").catch((error: unknown) => error)
	}

	it("404 → skip this filing", async () => {
		const error = await failureFor([{ status: 404, statusText: "Not Found" }])

		expect((error as ResourceError).status).toBe(404)
		expect(isTransientResourceError(error)).toBe(false)
	})

	it("403 → abort the run", async () => {
		const error = await failureFor([{ status: 403, statusText: "Forbidden" }])

		expect((error as ResourceError).status).toBe(403)
		expect(isTransientResourceError(error)).toBe(false)
	})

	it("exhausted 429 → requeue", async () => {
		const error = await failureFor([{ status: 429, statusText: "Too Many Requests" }])

		expect((error as ResourceError).status).toBe(429)
		expect(isTransientResourceError(error)).toBe(true)
	})

	it("exhausted 5xx → requeue", async () => {
		const error = await failureFor([{ status: 503, statusText: "Service Unavailable" }])

		expect(isTransientResourceError(error)).toBe(true)
	})

	// The most common bulk-crawl outcome, and the one the standalone client got wrong.
	it("exhausted network failure → requeue", async () => {
		const error = await failureFor([{ throws: { message: "socket hang up", code: "ERR_NETWORK" } }])

		expect(error).toBeInstanceOf(ResourceError)
		expect(isTransientResourceError(error)).toBe(true)
	})

	it("exhausted timeout → requeue", async () => {
		// Axios reports its own `timeout` config as ECONNABORTED, which must read as network-class rather
		// than as a caller-initiated cancel.
		const error = await failureFor([{ throws: { message: "timeout of 30000ms exceeded", code: "ECONNABORTED" } }])

		expect(error).toBeInstanceOf(ResourceError)
		expect(isTransientResourceError(error)).toBe(true)
	})

	it("a disallowed host → a programmer bug, never requeued", async () => {
		const transport = stubTransport([{}])

		const client = createSECClient({ userAgent: TEST_USER_AGENT, cacheDir, clock: createFakeClock(), ...transport })

		const error = await client.get("https://attacker.example/x").catch((caught: unknown) => caught)

		expect(isTransientResourceError(error)).toBe(false)
	})
})
