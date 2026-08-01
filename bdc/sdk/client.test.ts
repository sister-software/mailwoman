/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Tests for {@linkcode createBDCClient} — the FCC BDC public-API client, now built on
 *   `@mailwoman/core/api`'s {@linkcode APIClient}.
 *
 *   Every test drives a stub Axios ADAPTER and, where timing matters, an injected `ClockLike`. No test
 *   here performs a live network call or a real wall-clock sleep, and at ten requests per minute the
 *   second half of that matters more than anywhere else in the repo: one real throttle grant costs six
 *   seconds, so a suite that slept would take longer than the ingestion it models. Cache-expiry tests
 *   fake `Date` specifically, because `axios-cache-interceptor` stamps `createdAt` off `Date.now()`
 *   rather than off this client's injectable clock.
 *
 *   The stub errors are built structurally (`isAxiosError: true` plus `config`/`response`/`code`) rather
 *   than with `new AxiosError(...)`: `bdc` depends on neither `axios` nor `axios-cache-interceptor`,
 *   reaching both only through `@mailwoman/core`, and a test file is not a reason to breach that.
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { crc32 } from "node:zlib"

import type { APIClientConfig } from "@mailwoman/core/api"
import { createFakeClock, maxCountInSlidingWindow, VirtualClock } from "@mailwoman/core/api/test-clocks"
// `ResourceError` is used both as a VALUE (`toBeInstanceOf`) and as a TYPE (`as ResourceError`). The value
// arrives via the post-reset dynamic import below; a `const` carries no type side, so the type position
// needs its own static import. Type-only, so it never evaluates the mocked module chain.
import type { ResourceError as ResourceErrorShape } from "@mailwoman/core/errors"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { BDCFile, RawBDCFile } from "./common.ts"
import type { FCCAsOfDateEntry } from "./filing-dates.ts"

// `$private` (`@mailwoman/core/env`) is a LIVE getter over `{ ...dotEnv, ...process.env }` — `dotEnv` is
// read from the repo's real `.env` once at module load, so `vi.stubEnv(..., undefined)` alone can't hide
// real FCC_MAP_USERNAME/FCC_MAP_API_KEY values committed there: the merge falls back to `dotEnv`'s value
// regardless of what the test stubs on `process.env`. Mock the module directly so the no-credentials test
// below is isolated from whatever the ambient environment actually contains (live-data finding — this
// broke the first time real credentials landed in `.env`). Every OTHER test in this file passes explicit
// `username`/`apiKey` options and never reads `$private`, so this mock doesn't affect them.
vi.mock("@mailwoman/core/env", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@mailwoman/core/env")>()

	return {
		...actual,
		$private: { ...actual.$private, FCC_MAP_USERNAME: undefined, FCC_MAP_API_KEY: undefined },
	}
})

// Shared-graph guard: the root vitest config runs `isolate: false`, so `./client.ts` may already sit
// in the worker's cache — evaluated WITHOUT this file's `@mailwoman/core/env` mock by an earlier file
// (a cached module never re-evaluates, and vi.mock factories are only consulted at evaluation). Reset
// on the way in so the chain re-evaluates against the mock, and on the way out so the NEXT file in
// this fork never inherits our mocked env module from the cache.
//
// Carried through the APIClient migration: the module surface grew (the client now exports its rate
// default, throttle formatter and error helpers, and `./download.ts` joined the chain), but every one
// of these still reaches `@mailwoman/core/env` transitively, so all of them must load AFTER the reset.
vi.resetModules()
afterAll(() => vi.resetModules())

// Dynamic imports AFTER the reset so the module chain evaluates against the env mock.
const {
	BDC_API_BASE_URL,
	BDC_DEFAULT_REQUESTS_PER_MINUTE,
	createBDCClient,
	formatBDCThrottleStats,
	isTransientResourceError,
	ResourceError,
} = await import("./client.ts")

const { BDCFileCategory, BDCFilingDataType, BDCStateSubCategory } = await import("./common.ts")
const { downloadBDCFile } = await import("./download.ts")
const { resolveLatestVintage, retrieveFilingDates } = await import("./filing-dates.ts")
const { retrieveAvailabilityFiles } = await import("./list-files.ts")

const USERNAME = "alice"
const API_KEY = "s3cr3t"

/**
 * The pacing interval the default rate implies: 60000 / 10.
 */
const DEFAULT_INTERVAL_MS = 6000

const HTTP_OK = 200
const HTTP_MULTIPLE_CHOICES = 300
const HTTP_SERVER_ERROR_MIN = 500

/**
 * The interesting subset of an Axios request config, as a stub adapter sees it.
 */
interface StubRequestConfig {
	url?: string
	headers?: Record<string, unknown>
	timeout?: number
	responseType?: string
	cache?: unknown
}

/**
 * One scripted adapter outcome.
 */
interface StubOutcome {
	status?: number
	statusText?: string
	/**
	 * The RAW body, as the transport would hand it to Axios's `transformResponse`. A string here is what an upstream
	 * serving HTML under a 200 actually looks like; a `Buffer` is what Axios's Node adapter produces for `responseType:
	 * "arraybuffer"`.
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
 * The Axios overrides `createBDCClient` accepts, reached through `APIClientConfig` rather than by importing `axios`.
 */
type AxiosOverrides = NonNullable<APIClientConfig["axios"]>

interface StubTransport {
	/**
	 * Spread into `createBDCClient()` as its `axios` override.
	 */
	axios: AxiosOverrides
	calls: string[]
	configs: StubRequestConfig[]
	dispatchTimes: number[]
}

/**
 * Build an Axios-shaped rejection without importing `axios`. `isAxiosError(payload)` is `isObject(payload) &&
 * payload.isAxiosError === true`, and everything downstream reads `config`, `code`, and `response`.
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
			// Axios's `transformResponse` runs on the RAW body, so hand it exactly what the wire would: a
			// string passes through untouched (that is how an HTML error page under a 200 actually arrives),
			// bytes pass through untouched, and anything else is serialized the way a JSON endpoint would.
			data:
				typeof outcome.body === "string" || Buffer.isBuffer(outcome.body)
					? outcome.body
					: JSON.stringify(outcome.body ?? { data: [] }),
			status,
			statusText: outcome.statusText ?? "OK",
			headers: outcome.headers ?? {},
			config,
		}

		if (status >= HTTP_OK && status < HTTP_MULTIPLE_CHOICES) return response

		throw axiosLikeError(
			`Request failed with status code ${status}`,
			status >= HTTP_SERVER_ERROR_MIN ? "ERR_BAD_RESPONSE" : "ERR_BAD_REQUEST",
			config,
			response
		)
	}

	// Structurally an Axios adapter. The precise `AxiosAdapter` signature isn't nameable here without
	// importing `axios`, which this workspace deliberately does not depend on.
	return { axios: { adapter } as AxiosOverrides, calls, configs, dispatchTimes }
}

let cacheDir: string
let dataRoot: string

beforeEach(() => {
	dataRoot = mkdtempSync(join(tmpdir(), "bdc-client-test-"))
	cacheDir = join(dataRoot, "http-cache")

	// Created up front so "the cache is empty" is a readable directory rather than an ENOENT — the
	// distinction the never-cached assertions below depend on.
	mkdirSync(cacheDir)
	vi.stubEnv("MAILWOMAN_DATA_ROOT", dataRoot)
})

afterEach(() => {
	vi.unstubAllEnvs()
	vi.useRealTimers()
	rmSync(dataRoot, { recursive: true, force: true })
})

/**
 * A client with every timing seam pinned: an immediately-resolving clock, an isolated cache directory, and the stub
 * transport as its only route to "the network".
 */
function clientFor(transport: StubTransport, overrides: Parameters<typeof createBDCClient>[0] = {}) {
	return createBDCClient({
		username: USERNAME,
		apiKey: API_KEY,
		cacheDir,
		clock: createFakeClock(),
		...transport,
		...overrides,
	})
}

describe("createBDCClient: credential fail-fast", () => {
	it("throws a descriptive error without credentials and without env values", () => {
		vi.stubEnv("FCC_MAP_USERNAME", undefined)
		vi.stubEnv("FCC_MAP_API_KEY", undefined)

		expect(() => createBDCClient()).toThrow(/credentials/i)
		expect(() => createBDCClient()).toThrow(/FCC_MAP_USERNAME/)
		expect(() => createBDCClient()).toThrow(/broadbandmap\.fcc\.gov/)
	})

	it("throws when only ONE half of the pair is present", () => {
		expect(() => createBDCClient({ username: USERNAME })).toThrow(/credentials/i)
		expect(() => createBDCClient({ apiKey: API_KEY })).toThrow(/credentials/i)
	})

	it("does not throw when both halves are passed explicitly", () => {
		expect(() => clientFor(stubTransport([{}]))).not.toThrow()
	})
})

describe("createBDCClient: header-pair auth and URL building", () => {
	it("sends the username/hash_value header pair and the base-relative URL on every request", async () => {
		const transport = stubTransport([{ body: { data: [] } }, { body: Buffer.from("zip") }])
		const client = clientFor(transport)

		await client.get("/map/listAsOfDates")
		await client.getArrayBuffer("/map/downloads/downloadFile/availability/7")

		expect(transport.calls).toEqual([
			`${BDC_API_BASE_URL}/map/listAsOfDates`,
			`${BDC_API_BASE_URL}/map/downloads/downloadFile/availability/7`,
		])

		for (const config of transport.configs) {
			expect(config.headers).toMatchObject({ username: USERNAME, hash_value: API_KEY })
		}
	})

	it("serializes params and omits undefined ones rather than sending the literal string", async () => {
		const transport = stubTransport([{ body: { data: [] } }])

		await clientFor(transport).get("/map/downloads/listAvailabilityData/2024-12-31", {
			category: "State",
			subcategory: undefined,
			page: 2,
		})

		expect(transport.calls[0]).toBe(
			`${BDC_API_BASE_URL}/map/downloads/listAvailabilityData/2024-12-31?category=State&page=2`
		)
	})

	it("APPENDS the path to the base rather than RESOLVING it, so no path can redirect the credentials off-host", async () => {
		// `new URL(path, BDC_API_BASE_URL)` would resolve an absolute-looking path to another origin and
		// carry the `username`/`hash_value` pair there. Concatenation cannot: the host is already fixed by
		// the time the path is appended.
		const transport = stubTransport([{ body: { data: [] } }, { body: { data: [] } }])
		const client = clientFor(transport)

		await client.get("https://credential-thief.example/collect")
		await client.get("//credential-thief.example/collect")

		for (const call of transport.calls) {
			expect(new URL(call).origin).toBe(new URL(BDC_API_BASE_URL).origin)
		}
	})

	it("returns the response body UN-unwrapped, envelope intact", async () => {
		// Every BDC endpoint nests its payload under `data`, and both callers pluck `.data` themselves. A
		// client that unwrapped would silently break every call site's response type.
		const transport = stubTransport([{ body: { data: [{ as_of_date: "2024-12-31" }] } }])

		const body = await clientFor(transport).get<{ data: unknown[] }>("/map/listAsOfDates")

		expect(body).toEqual({ data: [{ as_of_date: "2024-12-31" }] })
	})
})

describe("createBDCClient: the 10 requests/minute throttle", () => {
	it("defaults to the FCC's published ten per minute, i.e. six seconds a call", async () => {
		const clock = createFakeClock()
		const transport = stubTransport([{ body: { data: [] } }])
		const client = clientFor(transport, { clock })

		await client.get("/map/rate/0")
		expect(clock.sleepCalls).toHaveLength(0) // the very first call is always immediate

		await client.get("/map/rate/1")
		expect(clock.sleepCalls).toEqual([DEFAULT_INTERVAL_MS])

		expect(BDC_DEFAULT_REQUESTS_PER_MINUTE).toBe(10)
	})

	it("is configurable, not a hard-coded law", async () => {
		const clock = createFakeClock()
		const transport = stubTransport([{ body: { data: [] } }])
		const client = clientFor(transport, { clock, requestsPerMinute: 30 })

		await client.get("/map/tuned/0")
		await client.get("/map/tuned/1")

		expect(clock.sleepCalls).toEqual([2000])
	})

	it("never lets more than the configured budget arrive inside any sliding minute", async () => {
		// ARRIVALS, timestamped inside the adapter — not `clock.sleepCalls`. The grant schedule is not what a
		// rate limiter sees, and asserting it is how a throttle bug hides: sleeps can be spaced correctly
		// while requests still land in a burst. `runUntilSettled` is required because the throttle gate sits
		// DOWNSTREAM of the on-disk cache lookup, so each request spends real event-loop turns in `readFile`
		// before it registers its sleep.
		const FAN_OUT = 12

		const clock = new VirtualClock()
		const transport = stubTransport([{ body: { data: [] } }], clock)
		const client = clientFor(transport, { clock })

		await clock.runUntilSettled(Promise.all(Array.from({ length: FAN_OUT }, (_, i) => client.get(`/map/fanout/${i}`))))

		const arrivals = transport.dispatchTimes

		expect(arrivals).toHaveLength(FAN_OUT)

		for (let i = 1; i < arrivals.length; i++) {
			expect(arrivals[i]! - arrivals[i - 1]!).toBeGreaterThanOrEqual(DEFAULT_INTERVAL_MS)
		}

		expect(maxCountInSlidingWindow(arrivals, 60_000)).toBeLessThanOrEqual(BDC_DEFAULT_REQUESTS_PER_MINUTE)
	})

	it("throttles the BINARY path too — caching is off there, the rate budget is not", async () => {
		const clock = createFakeClock()
		const transport = stubTransport([{ body: Buffer.from("zip-bytes") }])
		const client = clientFor(transport, { clock })

		await client.getArrayBuffer("/map/downloads/downloadFile/availability/1")
		await client.getArrayBuffer("/map/downloads/downloadFile/availability/2")

		expect(clock.sleepCalls).toEqual([DEFAULT_INTERVAL_MS])
	})

	it("does not throttle a cache HIT — six seconds saved per hit is the point of caching here", async () => {
		const REPEATS = 4

		const clock = createFakeClock()
		const transport = stubTransport([{ body: { data: [1] } }])
		const client = clientFor(transport, { clock })

		for (let i = 0; i < REPEATS; i++) {
			await client.get("/map/listAsOfDates")
		}

		expect(transport.calls).toHaveLength(1)
		expect(clock.sleepCalls).toEqual([])
	})
})

describe("createBDCClient: the throttle meter", () => {
	it("reports elapsed time and how much of it went to waiting", async () => {
		const clock = createFakeClock()
		const transport = stubTransport([{ body: { data: [] } }], clock)
		const client = clientFor(transport, { clock })

		expect(client.throttleStats()).toMatchObject({ waitingMs: 0, waits: 0 })

		for (let i = 0; i < 3; i++) {
			await client.get(`/map/meter/${i}`)
		}

		const stats = client.throttleStats()

		expect(stats.waits).toBe(2)
		expect(stats.waitingMs).toBe(2 * DEFAULT_INTERVAL_MS)
		expect(stats.elapsedMs).toBe(2 * DEFAULT_INTERVAL_MS)
		expect(formatBDCThrottleStats(stats)).toMatch(/waiting on the request throttle/)
	})

	it("unions concurrent waits instead of summing them, so waiting can never exceed elapsed", async () => {
		// Under a fan-out every caller sleeps at once and each wait is longer than the last (6s, 12s, …),
		// so SUMMING them reports more waiting than the run took: the first version of this meter printed
		// `78m 0s (2000%)` for a 40-call fan-out that finished in 3m54s. What the operator is assessing is
		// what SHARE of the wall clock went to the throttle, which only the union answers.
		//
		// Deliberately UNDER `BDC_DEFAULT_REQUESTS_PER_MINUTE`, so only the interval gate fires and `waits` is exactly
		// one per call after the first. At 12 this also crossed the per-minute budget, and once that gate's cooldown was
		// corrected to a full window (it had been releasing N back to back every `60000/N` ms — a 10x overrun) the extra
		// budget waits made the count ambiguous. Union-vs-sum is what this test is for; isolate it.
		const FAN_OUT = 8

		const clock = new VirtualClock()
		const transport = stubTransport([{ body: { data: [] } }], clock)
		const client = clientFor(transport, { clock })

		await clock.runUntilSettled(Promise.all(Array.from({ length: FAN_OUT }, (_, i) => client.get(`/map/union/${i}`))))

		const stats = client.throttleStats()

		expect(stats.waits).toBe(FAN_OUT - 1) // the first grant is immediate
		expect(stats.waitingMs).toBeLessThanOrEqual(stats.elapsedMs)
		expect(stats.waitingMs).toBe((FAN_OUT - 1) * DEFAULT_INTERVAL_MS)
	})

	it("counts a per-minute budget cooldown once the budget is spent", async () => {
		// The BUDGET gate (`requestsPerMinute`) is declared alongside the interval gate; this is what proves
		// it is actually wired, since the interval gate alone produces identical arrival spacing.
		const BUDGET = 2

		const clock = new VirtualClock()
		const transport = stubTransport([{ body: { data: [] } }], clock)
		const client = clientFor(transport, { clock, requestsPerMinute: BUDGET })

		await clock.runUntilSettled(Promise.all(Array.from({ length: 4 }, (_, i) => client.get(`/map/budget/${i}`))))

		expect(client.throttleStats().cooldowns).toBeGreaterThanOrEqual(1)
	})

	/**
	 * The composed steady state of BOTH gates, at the shipped defaults — pinned because `createBDCClient` and
	 * {@link BDCThrottleStats.cooldowns} both describe it in prose, and both used to describe it WRONGLY: they claimed
	 * the budget's cooldown "computes to <= 0" / is of "near-zero duration" once the interval gate has spaced the
	 * dispatches, so the budget was said to cost nothing. It is a real 6 s wait. `APIClient` measures the cooldown to the
	 * end of the MINUTE the window opened in, and after nine 6 s intervals only 54 s of that minute is spent.
	 *
	 * Nothing checked either claim, which is how they survived. This is the check.
	 */
	it("both gates composed: 10 requests per 66s, with a real 6s budget cooldown between windows", async () => {
		const WINDOWS = 2
		const FAN_OUT = BDC_DEFAULT_REQUESTS_PER_MINUTE * WINDOWS + 1

		const clock = new VirtualClock()
		const transport = stubTransport([{ body: { data: [] } }], clock)
		const client = clientFor(transport, { clock })

		await clock.runUntilSettled(Promise.all(Array.from({ length: FAN_OUT }, (_, i) => client.get(`/map/steady/${i}`))))

		// 0, 6, …, 54 — then a 6s cooldown, and the pacer discards its stale grant across it (APIClient
		// re-acquires rather than holding one, under-issuing by one, the safe direction), so the next window
		// opens at 66s rather than 60s.
		expect(transport.dispatchTimes).toEqual([
			0, 6000, 12_000, 18_000, 24_000, 30_000, 36_000, 42_000, 48_000, 54_000, 66_000, 72_000, 78_000, 84_000, 90_000,
			96_000, 102_000, 108_000, 114_000, 120_000, 132_000,
		])

		// One cooldown per budget's worth of requests, and it is a WAIT, not a zero-length rollover marker.
		expect(client.throttleStats().cooldowns).toBe(WINDOWS)

		// The composed rate lands BELOW the published limit — conservative, which is why the two gates are left
		// composed rather than dropping the budget.
		expect(maxCountInSlidingWindow(transport.dispatchTimes, 60_000)).toBeLessThanOrEqual(
			BDC_DEFAULT_REQUESTS_PER_MINUTE
		)
	})
})

describe("createBDCClient: the on-disk response cache", () => {
	const path = "/map/listAsOfDates"

	it("serves a repeat call from cache without re-dispatching", async () => {
		const transport = stubTransport([{ body: { data: [1] } }])
		const client = clientFor(transport)

		expect(await client.get(path)).toEqual({ data: [1] })
		expect(await client.get(path)).toEqual({ data: [1] })
		expect(transport.calls).toHaveLength(1)
	})

	it("persists to disk, so a SEPARATE client instance over the same cacheDir hits it too", async () => {
		await clientFor(stubTransport([{ body: { data: [1] } }])).get(path)

		const second = stubTransport([{ body: { data: ["SHOULD-NOT-BE-FETCHED"] } }])

		expect(await clientFor(second).get(path)).toEqual({ data: [1] })
		expect(second.calls).toHaveLength(0)
	})

	it("expires an entry after cacheTTLMs, triggering a re-fetch", async () => {
		// `axios-cache-interceptor` stamps `createdAt`/expiry off `Date.now()`, not off the injected
		// `ClockLike`, so cache AGE is driven by faking `Date` specifically.
		vi.useFakeTimers({ toFake: ["Date"] })
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"))

		const transport = stubTransport([{ body: { data: [1] } }, { body: { data: [2] } }])
		const client = clientFor(transport, { cacheTTLMs: 1000 })

		expect(await client.get(path)).toEqual({ data: [1] })

		vi.setSystemTime(new Date("2026-01-01T00:00:01.001Z"))

		expect(await client.get(path)).toEqual({ data: [2] })
		expect(transport.calls).toHaveLength(2)
	})

	it("ignores an upstream Cache-Control, so the filing-cadence TTL is the one that decides", async () => {
		vi.useFakeTimers({ toFake: ["Date"] })
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"))

		const transport = stubTransport([
			{ body: { data: [1] }, headers: { "cache-control": "max-age=1" } },
			{ body: { data: [2] }, headers: { "cache-control": "max-age=1" } },
		])

		const client = clientFor(transport)

		expect(await client.get(path)).toEqual({ data: [1] })

		// Well past the header's 1s max-age, far inside the configured TTL.
		vi.setSystemTime(new Date("2026-01-01T00:05:00Z"))

		expect(await client.get(path)).toEqual({ data: [1] })
		expect(transport.calls).toHaveLength(1)
	})

	it("treats URLs differing only by query string as DISTINCT entries", async () => {
		const transport = stubTransport([{ body: { data: ["ca"] } }, { body: { data: ["ny"] } }])
		const client = clientFor(transport)

		expect(await client.get("/map/downloads/listAvailabilityData/2024-12-31", { state: "06" })).toEqual({
			data: ["ca"],
		})

		expect(await client.get("/map/downloads/listAvailabilityData/2024-12-31", { state: "36" })).toEqual({
			data: ["ny"],
		})

		expect(transport.calls).toHaveLength(2)
	})

	it("never writes an entry for a failed response", async () => {
		const failing = stubTransport([{ status: 500, statusText: "Internal Server Error" }])

		await expect(clientFor(failing, { maxAttempts: 1 }).get("/map/error")).rejects.toBeInstanceOf(ResourceError)
		expect(readdirSync(cacheDir)).toHaveLength(0)
	})

	it("refuses to cache a 200 whose body is not a BDC `{ data: … }` envelope, and self-heals", async () => {
		// Validate BEFORE writing: an upstream serving an error page under a 200 would otherwise be handed
		// to the next run, whose caller destructures `.data` into `undefined`.
		const bad = stubTransport([{ body: { error: "nope" } }])

		expect(await clientFor(bad).get("/map/not-an-envelope")).toEqual({ error: "nope" })
		expect(readdirSync(cacheDir)).toHaveLength(0)

		const fixed = stubTransport([{ body: { data: [1] } }])

		expect(await clientFor(fixed).get("/map/not-an-envelope")).toEqual({ data: [1] })
		expect(fixed.calls).toHaveLength(1)
	})

	it("bypasses BOTH the read and the write when a caller passes skipCache", async () => {
		const transport = stubTransport([{ body: { data: [1] } }, { body: { data: [2] } }])
		const client = clientFor(transport)

		expect(await client.get(path, undefined, { skipCache: true })).toEqual({ data: [1] })
		expect(await client.get(path, undefined, { skipCache: true })).toEqual({ data: [2] })

		expect(transport.calls).toHaveLength(2)
		expect(readdirSync(cacheDir)).toHaveLength(0)
	})

	it("de-dupes concurrent misses for the SAME url onto a single in-flight request", async () => {
		const transport = stubTransport([{ body: { data: [1] } }])
		const client = clientFor(transport)

		const results = await Promise.all([client.get(path), client.get(path), client.get(path)])

		expect(results).toEqual([{ data: [1] }, { data: [1] }, { data: [1] }])
		expect(transport.calls).toHaveLength(1)
	})
})

describe("createBDCClient: the binary download path", () => {
	const path = "/map/downloads/downloadFile/availability/42"

	it("requests arraybuffer bytes with caching switched OFF for this request", async () => {
		const transport = stubTransport([{ body: Buffer.from("PK-zip-bytes") }])

		await clientFor(transport).getArrayBuffer(path)

		expect(transport.configs[0]?.responseType).toBe("arraybuffer")
		expect(transport.configs[0]?.cache).toBe(false)
	})

	it("never reaches the cache layer at all, and re-fetches on a second call", async () => {
		// A multi-hundred-megabyte zip through a JSON-validating disk cache is wrong twice over: it cannot
		// be read back, and `downloadBDCFile` already writes the extracted CSV to disk itself.
		//
		// An empty cache directory alone would NOT prove this — the storage layer's own `validate` gate
		// rejects a zip too, so the directory stays empty either way and the assertion would pass with
		// `cache: false` deleted. What distinguishes "the request bypassed the cache" from "the cache
		// refused the write" is the rejection itself: `buildDiskStorage` warns on every write it drops, so
		// a silent run is the proof that the interceptor never saw this response.
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)

		const transport = stubTransport([{ body: Buffer.from("first") }, { body: Buffer.from("second") }])
		const client = clientFor(transport)

		expect(Buffer.from(await client.getArrayBuffer(path)).toString()).toBe("first")
		expect(Buffer.from(await client.getArrayBuffer(path)).toString()).toBe("second")

		expect(transport.calls).toHaveLength(2)
		expect(readdirSync(cacheDir)).toHaveLength(0)
		expect(warn.mock.calls.flat().join(" ")).not.toMatch(/refusing to cache/i)

		warn.mockRestore()
	})

	it("returns the exact bytes as an ArrayBuffer from the Buffer body Axios's Node adapter produces", async () => {
		const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff])
		const transport = stubTransport([{ body: bytes }])

		const result = await clientFor(transport).getArrayBuffer(path)

		expect(result).toBeInstanceOf(ArrayBuffer)
		expect([...new Uint8Array(result)]).toEqual([...bytes])
	})

	it("copies out of a POOLED buffer rather than handing over its neighbours' bytes", async () => {
		// Node pools small `Buffer.allocUnsafe` allocations, so a short body arrives as a VIEW at a
		// non-zero `byteOffset` into a shared 8 KiB backing store (measured: offset 88). Returning
		// `.buffer` directly there would hand the caller the whole pool. The zero-copy branch is only
		// correct for the exactly-sized allocation `Buffer.concat` makes past the pool threshold, which is
		// what a real multi-hundred-megabyte download produces.
		const pool = Buffer.alloc(64, 0xaa)
		const view = pool.subarray(8, 12)

		const transport = stubTransport([{ body: view }])
		const result = await clientFor(transport).getArrayBuffer(path)

		expect(result.byteLength).toBe(4)
		expect([...new Uint8Array(result)]).toEqual([0xaa, 0xaa, 0xaa, 0xaa])
	})

	it("gives the download its own, far longer inactivity timeout than a JSON call", async () => {
		const transport = stubTransport([{ body: { data: [] } }, { body: Buffer.from("zip") }])
		const client = clientFor(transport, { requestTimeoutMs: 1234, downloadTimeoutMs: 98_765 })

		await client.get("/map/listAsOfDates")
		await client.getArrayBuffer(path)

		expect(transport.configs[0]?.timeout).toBe(1234)
		expect(transport.configs[1]?.timeout).toBe(98_765)
	})
})

describe("downloadBDCFile: end to end over the migrated client", () => {
	it("downloads the zip, extracts its single CSV entry, and writes it to the destination", async () => {
		const csv = "location_id,provider_id\n1,42\n"
		const transport = stubTransport([{ body: storedZip("bdc_06_Cable_D24_31dec2024.csv", csv) }])
		const client = clientFor(transport)

		const file = { fileID: 42, fileName: "bdc_06_Cable_D24_31dec2024" } as BDCFile
		const destination = join(dataRoot, "availability")

		const written = await downloadBDCFile(client, file, destination)

		expect(written).toBe(join(destination, "bdc_06_Cable_D24_31dec2024.csv"))
		expect(readFileSync(written, "utf8")).toBe(csv)
		expect(transport.calls).toEqual([`${BDC_API_BASE_URL}/map/downloads/downloadFile/availability/42`])
	})

	it("returns the cached CSV path without issuing any request when the file already exists", async () => {
		const transport = stubTransport([{ body: storedZip("x.csv", "a,b\n") }])
		const client = clientFor(transport)

		const file = { fileID: 7, fileName: "already-here" } as BDCFile
		const destination = join(dataRoot, "availability")

		await downloadBDCFile(client, file, destination)
		expect(transport.calls).toHaveLength(1)

		await downloadBDCFile(client, file, destination)
		expect(transport.calls).toHaveLength(1)
	})
})

// The contract an ingestion run depends on. Each branch is decided from `status` and
// `isTransientResourceError()` alone — never from message text.
describe("createBDCClient: the caller's failure taxonomy, decided without reading any message", () => {
	async function failureFor(outcomes: StubOutcome[], maxAttempts = 2): Promise<unknown> {
		const client = clientFor(stubTransport(outcomes), { maxAttempts, baseRetryDelayMs: 1 })

		return client.get("/map/taxonomy-probe").catch((error: unknown) => error)
	}

	it("401 → abort the run, and the error names the credential pair", async () => {
		const error = await failureFor([{ status: 401, statusText: "Unauthorized" }])

		expect((error as ResourceErrorShape).status).toBe(401)
		expect(isTransientResourceError(error)).toBe(false)
		expect((error as Error).message).toMatch(/hash_value/)
		expect((error as Error).message).toContain(USERNAME)
	})

	it("403 → abort the run, with the same explanation", async () => {
		const error = await failureFor([{ status: 403, statusText: "Forbidden" }])

		expect((error as ResourceErrorShape).status).toBe(403)
		expect(isTransientResourceError(error)).toBe(false)
		expect((error as Error).message).toMatch(/credential pair/)
	})

	it("does not retry a rejected credential", async () => {
		const transport = stubTransport([{ status: 401, statusText: "Unauthorized" }])

		await expect(clientFor(transport, { maxAttempts: 5 }).get("/map/probe")).rejects.toBeInstanceOf(ResourceError)
		expect(transport.calls).toHaveLength(1)
	})

	it("404 → skip this file", async () => {
		const error = await failureFor([{ status: 404, statusText: "Not Found" }])

		expect((error as ResourceErrorShape).status).toBe(404)
		expect(isTransientResourceError(error)).toBe(false)
		// A 404 is NOT a credential problem, so it must not pick up the credential explanation.
		expect((error as Error).message).not.toMatch(/hash_value/)
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
		const error = await failureFor([{ throws: { message: "timeout of 30000ms exceeded", code: "ECONNABORTED" } }])

		expect(error).toBeInstanceOf(ResourceError)
		expect(isTransientResourceError(error)).toBe(true)
	})

	it("a 200 carrying a non-JSON body → a programmer/upstream bug, never requeued", async () => {
		const error = await failureFor([{ body: "<html>maintenance</html>" }])

		expect(error).toBeInstanceOf(ResourceError)
		expect(isTransientResourceError(error)).toBe(false)
	})

	it("recovers from a transient 429, and the retry attempt still takes a throttle grant", async () => {
		const clock = createFakeClock()

		const transport = stubTransport([{ status: 429, statusText: "Too Many Requests" }, { body: { data: [1] } }], clock)

		// A backoff far SHORTER than the throttle interval, so only the throttle can produce the observed
		// spacing — a test with a long backoff would pass with the throttle deleted.
		const client = clientFor(transport, { clock, maxAttempts: 3, baseRetryDelayMs: 500 })

		expect(await client.get("/map/retry")).toEqual({ data: [1] })
		expect(transport.calls).toHaveLength(2)
		expect(clock.sleepCalls[0]).toBe(500) // the backoff
		// Every attempt re-enters the throttle, so a retry burst cannot outrun the rate budget.
		expect(transport.dispatchTimes[1]! - transport.dispatchTimes[0]!).toBeGreaterThanOrEqual(DEFAULT_INTERVAL_MS)
	})

	it("gives up after maxAttempts on a persistent 503 — bounded, not until it works", async () => {
		const transport = stubTransport([{ status: 503, statusText: "Service Unavailable" }])

		const caught = await clientFor(transport, { maxAttempts: 2, baseRetryDelayMs: 1 })
			.get("/map/down")
			.catch((error: unknown) => error)

		expect((caught as ResourceErrorShape).status).toBe(503)
		expect(transport.calls).toHaveLength(2)
	})
})

describe("the SDK callers, over the migrated client", () => {
	it("retrieveFilingDates + resolveLatestVintage: picks the later as_of_date from two entries", async () => {
		const raw: FCCAsOfDateEntry[] = [
			{ data_type: BDCFilingDataType.Availability, as_of_date: "2024-06-30" },
			{ data_type: BDCFilingDataType.Availability, as_of_date: "2024-12-31" },
		]

		const transport = stubTransport([{ body: { data: raw } }])
		const client = clientFor(transport)

		const entries = await retrieveFilingDates(client, { filingType: BDCFilingDataType.Availability })

		expect(entries).toHaveLength(2)
		expect(resolveLatestVintage(entries, BDCFilingDataType.Availability)).toBe("2024-12-31")
	})

	it("retrieveFilingDates: a second filing type inside the TTL costs no request at all", async () => {
		const raw: FCCAsOfDateEntry[] = [
			{ data_type: BDCFilingDataType.Availability, as_of_date: "2024-12-31" },
			{ data_type: BDCFilingDataType.Challenge, as_of_date: "2024-11-30" },
		]

		const transport = stubTransport([{ body: { data: raw } }])
		const client = clientFor(transport)

		expect(await retrieveFilingDates(client, { filingType: BDCFilingDataType.Availability })).toHaveLength(1)
		expect(await retrieveFilingDates(client, { filingType: BDCFilingDataType.Challenge })).toHaveLength(1)

		expect(transport.calls).toHaveLength(1)
	})

	it("retrieveFilingDates: skipCache re-asks the API", async () => {
		const transport = stubTransport([{ body: { data: [] } }])
		const client = clientFor(transport)

		await retrieveFilingDates(client, { filingType: BDCFilingDataType.Availability })
		await retrieveFilingDates(client, { filingType: BDCFilingDataType.Availability, skipCache: true })

		expect(transport.calls).toHaveLength(2)
	})

	it("retrieveAvailabilityFiles: parses raw entries into BDCFile[] sorted ascending by revision", async () => {
		const rawFiles: RawBDCFile[] = [
			{
				file_id: 1,
				category: BDCFileCategory.State,
				subcategory: BDCStateSubCategory.FixedBroadband,
				technology_code: "10",
				technology_code_desc: "Asymmetric xDSL",
				state_fips: "06",
				state_name: "California",
				provider_id: "1",
				provider_name: "Example One",
				file_type: "csv",
				file_name: "bdc_06_Cable_D23_31dec2024",
				record_count: "1",
			},
			{
				file_id: 2,
				category: BDCFileCategory.State,
				subcategory: BDCStateSubCategory.FixedBroadband,
				technology_code: "10",
				technology_code_desc: "Asymmetric xDSL",
				state_fips: "06",
				state_name: "California",
				provider_id: "2",
				provider_name: "Example Two",
				file_type: "csv",
				file_name: "bdc_06_Cable_D23_01jan2023",
				record_count: "1",
			},
		]

		const transport = stubTransport([{ body: { data: rawFiles } }])
		const client = clientFor(transport)

		const files = await retrieveAvailabilityFiles(client, {
			asOfDate: "2024-12-31",
			category: BDCFileCategory.State,
			subcategory: BDCStateSubCategory.FixedBroadband,
		})

		expect(files.map((file) => file.fileID)).toEqual([2, 1])
	})
})

/**
 * ZIP local-file-header, central-directory and end-of-central-directory signatures, and the fixed byte lengths of the
 * two headers this builder emits (30 and 46, per APPNOTE 4.3.7/4.3.12).
 */
const ZIP_LOCAL_SIGNATURE = 0x04_03_4b_50
const ZIP_CENTRAL_SIGNATURE = 0x02_01_4b_50
const ZIP_EOCD_SIGNATURE = 0x06_05_4b_50
const ZIP_LOCAL_HEADER_BYTES = 30
const ZIP_CENTRAL_HEADER_BYTES = 46
const ZIP_EOCD_BYTES = 22
const ZIP_VERSION = 20

/**
 * Build a single-entry, STORED (uncompressed) zip archive — the shape an FCC availability download has, minus the
 * deflate. Hand-assembled rather than pulled from a fixture file or a new dependency: `yauzl-promise` (the extractor
 * under test) reads zips and does not write them, and a committed binary fixture would be unreadable in review.
 */
function storedZip(filename: string, contents: string): Buffer {
	const name = Buffer.from(filename, "utf8")
	const data = Buffer.from(contents, "utf8")
	const checksum = crc32(data)

	const local = Buffer.alloc(ZIP_LOCAL_HEADER_BYTES)

	local.writeUInt32LE(ZIP_LOCAL_SIGNATURE, 0)
	local.writeUInt16LE(ZIP_VERSION, 4)
	local.writeUInt32LE(checksum, 14)
	local.writeUInt32LE(data.length, 18)
	local.writeUInt32LE(data.length, 22)
	local.writeUInt16LE(name.length, 26)

	const central = Buffer.alloc(ZIP_CENTRAL_HEADER_BYTES)

	central.writeUInt32LE(ZIP_CENTRAL_SIGNATURE, 0)
	central.writeUInt16LE(ZIP_VERSION, 4)
	central.writeUInt16LE(ZIP_VERSION, 6)
	central.writeUInt32LE(checksum, 16)
	central.writeUInt32LE(data.length, 20)
	central.writeUInt32LE(data.length, 24)
	central.writeUInt16LE(name.length, 28)

	const centralDirectory = Buffer.concat([central, name])
	const centralOffset = local.length + name.length + data.length

	const eocd = Buffer.alloc(ZIP_EOCD_BYTES)

	eocd.writeUInt32LE(ZIP_EOCD_SIGNATURE, 0)
	eocd.writeUInt16LE(1, 8)
	eocd.writeUInt16LE(1, 10)
	eocd.writeUInt32LE(centralDirectory.length, 12)
	eocd.writeUInt32LE(centralOffset, 16)

	return Buffer.concat([local, name, data, centralDirectory, eocd])
}
