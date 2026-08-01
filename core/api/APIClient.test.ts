/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Tests for {@linkcode APIClient} — pacing, the cooldown budget, bounded retry, and error mapping.
 *
 *   Every request is served by a stub Axios ADAPTER, so nothing here touches the network, and every
 *   timing assertion runs against an injected clock, so nothing here sleeps on the wall clock.
 */

import { AxiosError, type AxiosRequestConfig, type AxiosResponse, type InternalAxiosRequestConfig } from "axios"
import { buildMemoryStorage, buildStorage } from "axios-cache-interceptor"
import { describe, expect, it } from "vitest"

import { ResourceError } from "../errors/schema.ts"
import { APIClient } from "./APIClient.ts"
import { isTransientResourceError, ResourceErrorKind, resourceErrorKind } from "./responses.ts"
import { createFakeClock, drainMicrotasks, maxCountInSlidingWindow, VirtualClock } from "./test-clocks.ts"

/**
 * One scripted adapter outcome: an HTTP status (with an optional body/headers), or a thrown transport failure.
 */
interface StubOutcome {
	status?: number
	statusText?: string
	data?: unknown
	headers?: Record<string, string>
	/**
	 * A transport-level failure — no HTTP response ever arrives. Mirrors a dropped socket or a timeout.
	 */
	throws?: { message: string; code: string }
}

interface StubAdapter {
	adapter: (config: InternalAxiosRequestConfig) => Promise<AxiosResponse>
	/**
	 * The URL of every dispatch, in call order.
	 */
	calls: string[]
	/**
	 * The clock reading at each dispatch, when a clock is supplied.
	 */
	dispatchTimes: number[]
}

const HTTP_OK = 200
const HTTP_MULTIPLE_CHOICES = 300

/**
 * Build a stub Axios adapter that replays `outcomes` (holding on the last entry once exhausted). It reproduces what
 * Axios's real adapters do on a failing status — reject with an `AxiosError` carrying the response — because
 * `validateStatus` is applied by the adapter, not by the interceptor chain.
 */
function stubAdapter(outcomes: StubOutcome[], clock?: { now(): number }): StubAdapter {
	const calls: string[] = []
	const dispatchTimes: number[] = []
	let index = 0

	const adapter = async (config: InternalAxiosRequestConfig): Promise<AxiosResponse> => {
		calls.push(String(config.url))

		if (clock) {
			dispatchTimes.push(clock.now())
		}

		const outcome = outcomes[Math.min(index, outcomes.length - 1)]!

		index++

		if (outcome.throws) {
			throw new AxiosError(outcome.throws.message, outcome.throws.code, config, {})
		}

		const status = outcome.status ?? HTTP_OK

		const response: AxiosResponse = {
			data: outcome.data ?? { ok: true },
			status,
			statusText: outcome.statusText ?? "OK",
			headers: (outcome.headers ?? {}) as AxiosResponse["headers"],
			config,
		}

		if (status >= HTTP_OK && status < HTTP_MULTIPLE_CHOICES) return response

		throw new AxiosError(
			`Request failed with status code ${status}`,
			status >= 500 ? AxiosError.ERR_BAD_RESPONSE : AxiosError.ERR_BAD_REQUEST,
			config,
			{},
			response
		)
	}

	return { adapter, calls, dispatchTimes }
}

function get(url: string): AxiosRequestConfig {
	return { url }
}

describe("APIClient: disposal", () => {
	it("reaches a caching storage whose asyncDispose lives on the prototype", async () => {
		let disposeCount = 0

		// The regression case: [Symbol.asyncDispose] on the PROTOTYPE chain, not an own property.
		// The pre-migration predicate (Object.hasOwn on the instance) never matched this shape,
		// leaving cache disposal as dead code.
		const storagePrototype = {
			async [Symbol.asyncDispose](): Promise<void> {
				disposeCount += 1
			},
		}

		const storage = Object.assign(
			Object.create(storagePrototype) as typeof storagePrototype,
			buildStorage({
				find: () => undefined,
				set: () => undefined,
				remove: () => undefined,
			})
		)

		const client = new APIClient({
			displayName: "dispose-probe",
			caching: { storage },
		})

		await client[Symbol.asyncDispose]()

		expect(disposeCount).toBe(1)
	})
})

describe("APIClient: unthrottled default (the shape TileAPI uses)", () => {
	it("dispatches immediately, once, with no pacing, cooldown, or retry configured", async () => {
		const { adapter, calls } = stubAdapter([{ data: { tiles: [] } }])

		const client = new APIClient({ displayName: "tile-shape", axios: { adapter } })

		const response = await client.fetch<{ tiles: string[] }>(get("/basemap.json"))

		expect(response.data).toEqual({ tiles: [] })
		expect(calls).toEqual(["/basemap.json"])
	})

	it("makes exactly ONE attempt on a 503 — retry is opt-in, not the default", async () => {
		const { adapter, calls } = stubAdapter([{ status: 503, statusText: "Service Unavailable" }])

		const client = new APIClient({
			displayName: "no-retry-default",
			clock: createFakeClock(),
			axios: { adapter },
		})

		await expect(client.fetch(get("/flaky.json"))).rejects.toBeInstanceOf(ResourceError)
		expect(calls).toHaveLength(1)
	})
})

describe("APIClient: requestsPerMinute cooldown (A1 concurrency regression)", () => {
	// MEASURED BEFORE THE FIX, through this exact surface: `fetch()` awaited `$cooldown` once and the
	// request was only COUNTED by a response interceptor, so a 40-call fan-out put 40 dispatches on the
	// wire inside 3ms against a budget of 2/minute (and 40 against 10/minute). The gate has to be
	// checked AND the slot reserved in the same synchronous step.
	it("does not let a concurrent fan-out spend more than the per-minute budget before the cooldown opens", async () => {
		const REQUESTS_PER_MINUTE = 2
		const FAN_OUT = 40

		const clock = new VirtualClock()
		const { adapter, calls } = stubAdapter([{ data: { ok: true } }], clock)

		const client = new APIClient({
			displayName: "cooldown-fanout",
			requestsPerMinute: REQUESTS_PER_MINUTE,
			clock,
			axios: { adapter },
		})

		const pending = Array.from({ length: FAN_OUT }, (_, i) => client.fetch(get(`/item/${i}.json`)))

		await drainMicrotasks()

		// Nothing has driven the clock, so no cooldown can have lapsed: only the budget may have been spent.
		expect(calls).toHaveLength(REQUESTS_PER_MINUTE)

		// Drain: one cooldown (60000/2 = 30000ms) per budget's worth of requests.
		for (let i = 0; i < FAN_OUT; i++) {
			await clock.advance(30_000)
		}

		await Promise.all(pending)

		expect(calls).toHaveLength(FAN_OUT)
	})

	it("delivers no more than requestsPerMinute inside any sliding minute", async () => {
		// The RATE, which is what the option promises — not the schedule, which is what every other test here asserts.
		// That gap is how a 10x overrun shipped: the budget released N back to back then waited `60000/N` ms, so a
		// stated 10/minute sustained 100/minute, and no test failed because they all encoded the implemented spacing.
		const BUDGET = 10
		const clock = new VirtualClock()
		const arrivals: number[] = []

		const client = new APIClient({
			displayName: "rate-contract",
			requestsPerMinute: BUDGET,
			clock,
			axios: {
				adapter: async (requestConfig) => {
					arrivals.push(clock.now())

					return { data: { ok: true }, status: 200, statusText: "OK", headers: {}, config: requestConfig }
				},
			},
		})

		const pending = Array.from({ length: BUDGET * 3 }, (_, i) => client.fetch(get(`/rate/${i}.json`)))

		await clock.runUntilSettled(Promise.all(pending))

		expect(arrivals).toHaveLength(BUDGET * 3)
		expect(maxCountInSlidingWindow(arrivals, 60_000)).toBeLessThanOrEqual(BUDGET)
	})

	it("still throttles a serial run", async () => {
		// The FULL MINUTE, not `60000 / requestsPerMinute`. This constant used to be 30_000 — the spacing between two
		// requests — which encoded the very defect it read as guarding: a budget of 2 released 2, waited 30s, released
		// 2 more, i.e. 4/minute against a stated 2. Measured on a bare client at `requestsPerMinute: 10`, a 20-call
		// fan-out arrived `[0 x10, 6000 x10]` — 20 in one sliding minute, a sustained 100/minute.
		const COOLDOWN_MS = 60_000

		const clock = new VirtualClock()
		const { adapter, dispatchTimes } = stubAdapter([{ data: { ok: true } }], clock)

		const client = new APIClient({
			displayName: "cooldown-serial",
			requestsPerMinute: 2,
			clock,
			axios: { adapter },
		})

		await client.fetch(get("/serial/0.json"))
		await client.fetch(get("/serial/1.json"))

		// The budget is spent, so the third must stall — and does not dispatch on its own.
		const third = client.fetch(get("/serial/2.json"))

		await drainMicrotasks()
		expect(dispatchTimes).toEqual([0, 0])

		await clock.advance(COOLDOWN_MS)
		await third

		expect(dispatchTimes).toEqual([0, 0, COOLDOWN_MS])
	})
})

describe("APIClient: minRequestIntervalMs strict pacing (A2)", () => {
	it("spaces a 40-call concurrent fan-out one interval apart, holding the flat per-second cap", async () => {
		const INTERVAL_MS = 100
		const FAN_OUT = 40
		const EXPECTED_PER_SECOND = 10

		const clock = new VirtualClock()
		const { adapter, dispatchTimes } = stubAdapter([{ data: { ok: true } }], clock)

		const client = new APIClient({
			displayName: "paced-fanout",
			minRequestIntervalMs: INTERVAL_MS,
			clock,
			axios: { adapter },
		})

		const pending = Array.from({ length: FAN_OUT }, (_, i) => client.fetch(get(`/paced/${i}.json`)))

		await drainMicrotasks()

		await clock.advance((FAN_OUT - 1) * INTERVAL_MS)
		await Promise.all(pending)

		expect(dispatchTimes).toHaveLength(FAN_OUT)
		expect(new Set(dispatchTimes).size).toBe(FAN_OUT) // no cohort ever dispatched together
		expect(maxCountInSlidingWindow(dispatchTimes, 1000)).toBe(EXPECTED_PER_SECOND)
	})
})

describe("APIClient: bounded retry (A3)", () => {
	it("retries a transient 429 with exponential backoff and succeeds once the server recovers", async () => {
		const clock = createFakeClock()

		const { adapter, calls } = stubAdapter([
			{ status: 429, statusText: "Too Many Requests" },
			{ status: 429, statusText: "Too Many Requests" },
			{ data: { ok: true } },
		])

		const client = new APIClient({
			displayName: "retry-429",
			retry: { maxAttempts: 3, baseDelayMs: 500 },
			clock,
			axios: { adapter },
		})

		const response = await client.fetch<{ ok: boolean }>(get("/retry.json"))

		expect(response.data).toEqual({ ok: true })
		expect(calls).toHaveLength(3)
		expect(clock.sleepCalls).toEqual([500, 1000])
	})

	it("gives up after maxAttempts on a persistent 503 — bounded, not until it works", async () => {
		const { adapter, calls } = stubAdapter([{ status: 503, statusText: "Service Unavailable" }])

		const client = new APIClient({
			displayName: "retry-ceiling",
			retry: { maxAttempts: 2, baseDelayMs: 1 },
			clock: createFakeClock(),
			axios: { adapter },
		})

		const caught = await client.fetch(get("/down.json")).catch((error: unknown) => error)

		expect(caught).toBeInstanceOf(ResourceError)
		expect((caught as ResourceError).status).toBe(503)
		expect(isTransientResourceError(caught)).toBe(true)
		expect(calls).toHaveLength(2)
	})

	it("NEVER retries a 403, even with retry enabled — one attempt, non-transient", async () => {
		const { adapter, calls } = stubAdapter([{ status: 403, statusText: "Forbidden" }])

		const client = new APIClient({
			displayName: "retry-403",
			retry: { maxAttempts: 5, baseDelayMs: 1 },
			clock: createFakeClock(),
			axios: { adapter },
		})

		const caught = await client.fetch(get("/forbidden.json")).catch((error: unknown) => error)

		expect(caught).toBeInstanceOf(ResourceError)
		expect((caught as ResourceError).status).toBe(403)
		expect(isTransientResourceError(caught)).toBe(false)
		expect(calls).toHaveLength(1)
	})

	it("does not retry a 404 either, and maps it to a skippable ResourceError", async () => {
		const { adapter, calls } = stubAdapter([{ status: 404, statusText: "Not Found" }])

		const client = new APIClient({
			displayName: "retry-404",
			retry: { maxAttempts: 5, baseDelayMs: 1 },
			clock: createFakeClock(),
			axios: { adapter },
		})

		const caught = await client.fetch(get("/missing.json")).catch((error: unknown) => error)

		expect((caught as ResourceError).status).toBe(404)
		expect(isTransientResourceError(caught)).toBe(false)
		expect(calls).toHaveLength(1)
	})

	it("retries a transport-level failure — a dropped socket, not a status", async () => {
		const clock = createFakeClock()

		const { adapter, calls } = stubAdapter([
			{ throws: { message: "socket hang up", code: AxiosError.ERR_NETWORK } },
			{ data: { ok: true } },
		])

		const client = new APIClient({
			displayName: "retry-network",
			retry: { maxAttempts: 3, baseDelayMs: 500 },
			clock,
			axios: { adapter },
		})

		const response = await client.fetch<{ ok: boolean }>(get("/dropped.json"))

		expect(response.data).toEqual({ ok: true })
		expect(calls).toHaveLength(2)
		expect(clock.sleepCalls).toEqual([500])
	})

	it("exhausts its budget on a persistent transport failure and still reports it as requeueable", async () => {
		const { adapter, calls } = stubAdapter([{ throws: { message: "socket hang up", code: AxiosError.ERR_NETWORK } }])

		const client = new APIClient({
			displayName: "retry-network-ceiling",
			retry: { maxAttempts: 2, baseDelayMs: 1 },
			clock: createFakeClock(),
			axios: { adapter },
		})

		const caught = await client.fetch(get("/always-dropped.json")).catch((error: unknown) => error)

		expect(caught).toBeInstanceOf(ResourceError)
		expect(resourceErrorKind(caught)).toBe(ResourceErrorKind.Network)
		expect(isTransientResourceError(caught)).toBe(true)
		expect(calls).toHaveLength(2)
	})

	it("maps a timeout to a transient network error, not the old uniform 500", async () => {
		// The pre-migration mapper collapsed EVERY responseless failure into `ResourceError.from(500,
		// "Internal Server Error", "axios", "response", "missing")`, so a timeout was indistinguishable
		// from a refused connection or a DNS failure. Its `ECONNABORTED: return` arm — which would have
		// resolved the chain with `undefined` — could not be reached BY AXIOS: the `if (!response) throw`
		// above it ran first, and axios never attaches a `response` to a timeout, so a differential across
		// 18 failure shapes found no case that ever resolved. (Reachable in principle with a hand-built
		// error carrying both a `response` and `ECONNABORTED`, which no stock adapter produces.)
		const { adapter } = stubAdapter([{ throws: { message: "timeout of 30000ms exceeded", code: "ECONNABORTED" } }])

		const client = new APIClient({
			displayName: "timeout-map",
			clock: createFakeClock(),
			axios: { adapter },
		})

		const caught = await client.fetch(get("/slow.json")).catch((error: unknown) => error)

		expect(caught).toBeInstanceOf(ResourceError)
		expect(resourceErrorKind(caught)).toBe(ResourceErrorKind.Network)
		expect(isTransientResourceError(caught)).toBe(true)
	})

	it("does not retry a caller-initiated cancel", async () => {
		const { adapter, calls } = stubAdapter([{ throws: { message: "canceled", code: AxiosError.ERR_CANCELED } }])

		const client = new APIClient({
			displayName: "cancel",
			retry: { maxAttempts: 5, baseDelayMs: 1 },
			clock: createFakeClock(),
			axios: { adapter },
		})

		const caught = await client.fetch(get("/canceled.json")).catch((error: unknown) => error)

		expect(resourceErrorKind(caught)).toBe(ResourceErrorKind.Request)
		expect(isTransientResourceError(caught)).toBe(false)
		expect(calls).toHaveLength(1)
	})

	it("honors a numeric Retry-After over the exponential default", async () => {
		const clock = createFakeClock()

		const { adapter } = stubAdapter([
			{ status: 429, statusText: "Too Many Requests", headers: { "retry-after": "45" } },
			{ data: { ok: true } },
		])

		const client = new APIClient({
			displayName: "retry-after",
			retry: { maxAttempts: 2, baseDelayMs: 500 },
			clock,
			axios: { adapter },
		})

		await client.fetch(get("/rate-limited.json"))

		expect(clock.sleepCalls).toEqual([45_000])
	})

	it("clamps an excessive Retry-After to the ceiling", async () => {
		const clock = createFakeClock()

		const { adapter } = stubAdapter([
			{ status: 429, statusText: "Too Many Requests", headers: { "retry-after": "999999" } },
			{ data: { ok: true } },
		])

		const client = new APIClient({
			displayName: "retry-after-clamp",
			retry: { maxAttempts: 2, baseDelayMs: 500 },
			clock,
			axios: { adapter },
		})

		await client.fetch(get("/rate-limited.json"))

		expect(clock.sleepCalls).toEqual([60_000])
	})
})

describe("APIClient: the pacing gate sits downstream of the cache (I2)", () => {
	it("does not pace a cache HIT — only a request that actually reaches the network", async () => {
		// The gate used to live in `fetch()`, upstream of the cache interceptor, so every hit burned a
		// full pacer sleep: measured 1 dispatch, 5 hits, five 111ms sleeps for zero network traffic.
		// `/Archives/` documents are cached for a century by design, so warm re-runs are the EXPECTED
		// mode for a bulk crawl — at 100k cached documents that is ~3 hours of sleeping at an empty
		// network.
		const REPEATS = 6

		const clock = createFakeClock()
		const { adapter, calls } = stubAdapter([{ data: { ok: true } }])

		const client = new APIClient({
			displayName: "cache-hit-pacing",
			minRequestIntervalMs: 111,
			caching: { storage: buildMemoryStorage() },
			clock,
			axios: { adapter },
		})

		for (let i = 0; i < REPEATS; i++) {
			await client.fetch(get("/archived.json"))
		}

		expect(calls).toHaveLength(1) // one miss, five hits

		// The single miss is the pacer's first grant, which is always immediate. Every later call is a
		// hit and must not sleep at all.
		expect(clock.sleepCalls).toEqual([])
	})

	it("still paces the MISSES when the same client interleaves hits and misses", async () => {
		const clock = createFakeClock()
		const { adapter, calls, dispatchTimes } = stubAdapter([{ data: { ok: true } }], clock)

		const client = new APIClient({
			displayName: "mixed-pacing",
			minRequestIntervalMs: 100,
			caching: { storage: buildMemoryStorage() },
			clock,
			axios: { adapter },
		})

		await client.fetch(get("/a.json"))
		await client.fetch(get("/a.json")) // hit
		await client.fetch(get("/b.json")) // miss
		await client.fetch(get("/b.json")) // hit
		await client.fetch(get("/c.json")) // miss

		expect(calls).toEqual(["/a.json", "/b.json", "/c.json"])

		for (let i = 1; i < dispatchTimes.length; i++) {
			expect(dispatchTimes[i]! - dispatchTimes[i - 1]!).toBeGreaterThanOrEqual(100)
		}
	})
})

describe("APIClient: every retry attempt takes its own pacer grant (I6/M-R)", () => {
	it("paces retries, not just the first attempt", async () => {
		// The guarantee was stated in a docstring and tested nowhere: hoisting the gate out of the
		// per-dispatch path let a retry burst outrun the pacer entirely with 0 test failures. A retry
		// storm past the rate limit is the exact class this whole task exists to close.
		const INTERVAL_MS = 100

		const clock = createFakeClock()

		const { adapter, calls, dispatchTimes } = stubAdapter(
			[
				{ status: 503, statusText: "Service Unavailable" },
				{ status: 503, statusText: "Service Unavailable" },
				{ data: { ok: true } },
			],
			clock
		)

		const client = new APIClient({
			displayName: "paced-retries",
			minRequestIntervalMs: INTERVAL_MS,
			// A backoff far SHORTER than the pacing interval, so the pacer is the only thing that can
			// produce the spacing — a test with a long backoff would pass with the pacer deleted.
			retry: { maxAttempts: 3, baseDelayMs: 1 },
			clock,
			axios: { adapter },
		})

		await client.fetch(get("/flaky.json"))

		expect(calls).toHaveLength(3)
		expect(dispatchTimes).toHaveLength(3)

		for (let i = 1; i < dispatchTimes.length; i++) {
			expect(dispatchTimes[i]! - dispatchTimes[i - 1]!).toBeGreaterThanOrEqual(INTERVAL_MS)
		}
	})
})

describe("APIClient: the pacer and the cooldown compose (I4)", () => {
	it("re-acquires a pacer grant after a cooldown, instead of spending a stale one", async () => {
		// A grant is a claim on a specific instant. Taking one and THEN blocking on a cooldown leaves it
		// stale, and every caller holding a stale grant spends it the moment the cooldown lifts —
		// measured as four pairs dispatching 0ms apart against a documented 100ms minimum. Latent while
		// no client sets both, which is precisely why nothing caught it.
		const INTERVAL_MS = 100
		const FAN_OUT = 8

		const clock = new VirtualClock()
		const { adapter, dispatchTimes } = stubAdapter([{ data: { ok: true } }], clock)

		const client = new APIClient({
			displayName: "both-gates",
			minRequestIntervalMs: INTERVAL_MS,
			requestsPerMinute: 2, // a 30s cooldown every 2 dispatches
			clock,
			axios: { adapter },
		})

		await clock.runUntilSettled(
			Promise.all(Array.from({ length: FAN_OUT }, (_, i) => client.fetch(get(`/item/${i}.json`))))
		)

		expect(dispatchTimes).toHaveLength(FAN_OUT)

		for (let i = 1; i < dispatchTimes.length; i++) {
			expect(dispatchTimes[i]! - dispatchTimes[i - 1]!).toBeGreaterThanOrEqual(INTERVAL_MS)
		}
	})
})

describe("APIClient: a caller-supplied adapter cannot bypass the gate", () => {
	it("strips a per-request adapter so the pacing grant is still taken", async () => {
		// `mergeConfig` lets a request-level `adapter` win over the instance default, and the gate lives in that
		// instance adapter — so before this was stripped, three concurrent calls made 3 dispatches, took 0 grants and
		// slept 0 times. The cache interceptor's own adapter swap is unaffected: it happens inside the interceptor
		// chain on the merged config, not through this entry point.
		const clock = new VirtualClock()
		const dispatches: number[] = []

		const client = new APIClient({
			displayName: "adapter-bypass-probe",
			minRequestIntervalMs: 100,
			clock,
			axios: {
				adapter: async (requestConfig) => {
					dispatches.push(clock.now())

					return { data: { ok: true }, status: 200, statusText: "OK", headers: {}, config: requestConfig }
				},
			},
		})

		const rogueAdapter = async (requestConfig: InternalAxiosRequestConfig): Promise<AxiosResponse> => {
			dispatches.push(clock.now())

			return { data: { rogue: true }, status: 200, statusText: "OK", headers: {}, config: requestConfig }
		}

		const pending = [0, 1, 2].map((i) => client.fetch({ url: `https://example.invalid/${i}`, adapter: rogueAdapter }))

		// The rogue adapter never ran — every response came from the paced instance adapter.
		const responses = await clock.runUntilSettled(Promise.all(pending))

		for (const response of responses) {
			expect(response.data).toEqual({ ok: true })
		}

		expect(dispatches).toHaveLength(3)

		for (let i = 1; i < dispatches.length; i++) {
			expect(dispatches[i]! - dispatches[i - 1]!).toBeGreaterThanOrEqual(100)
		}
	})
})
