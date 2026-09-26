/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Tests for {@linkcode APIClient} — pacing, the cooldown budget, bounded retry, and error mapping.
 */

import { APIClient } from "@mailwoman/core/api/APIClient"
import { isTransientResourceError, ResourceErrorKind, resourceErrorKind } from "@mailwoman/core/api/responses"
import {
	createFakeClock,
	drainMicrotasks,
	maxCountInSlidingWindow,
	VirtualClock,
} from "@mailwoman/core/api/test-clocks"
import { stubTransport } from "@mailwoman/core/api/test-transport"
import { ResourceError } from "@mailwoman/core/errors/schema"
import { AxiosError, type AxiosRequestConfig, type AxiosResponse, type InternalAxiosRequestConfig } from "axios"
import { buildMemoryStorage, buildStorage } from "axios-cache-interceptor"
import { describe, expect, it } from "vitest"

function get(url: string): AxiosRequestConfig {
	return { url }
}

describe("APIClient: disposal", () => {
	it("reaches a caching storage whose asyncDispose lives on the prototype", async () => {
		let disposeCount = 0

		// The regression case: [Symbol.asyncDispose] on the prototype chain rather than an own property.
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
		const { axios, calls } = stubTransport([{ body: { tiles: [] } }])

		const client = new APIClient({ displayName: "tile-shape", axios })

		const response = await client.fetch<{ tiles: string[] }>(get("/basemap.json"))

		expect(response.data).toEqual({ tiles: [] })
		expect(calls).toEqual(["/basemap.json"])
	})

	it("makes exactly ONE attempt on a 503 — retry is opt-in, not the default", async () => {
		const { axios, calls } = stubTransport([{ status: 503, statusText: "Service Unavailable" }])

		const client = new APIClient({
			displayName: "no-retry-default",
			clock: createFakeClock(),
			axios,
		})

		await expect(client.fetch(get("/flaky.json"))).rejects.toBeInstanceOf(ResourceError)
		expect(calls).toHaveLength(1)
	})
})

describe("APIClient: requestsPerMinute cooldown (A1 concurrency regression)", () => {
	// The budget check and the slot reservation must happen in the same synchronous step.
	it("does not let a concurrent fan-out spend more than the per-minute budget before the cooldown opens", async () => {
		const REQUESTS_PER_MINUTE = 2
		const FAN_OUT = 40

		const clock = new VirtualClock()
		const { axios, calls } = stubTransport([{ body: { ok: true } }], { clock })

		const client = new APIClient({
			displayName: "cooldown-fanout",
			requestsPerMinute: REQUESTS_PER_MINUTE,
			clock,
			axios,
		})

		const pending = Array.from({ length: FAN_OUT }, (_, i) => client.fetch(get(`/item/${i}.json`)))

		await drainMicrotasks()

		expect(calls).toHaveLength(REQUESTS_PER_MINUTE)

		for (let i = 0; i < FAN_OUT; i++) {
			await clock.advance(30_000)
		}

		await Promise.all(pending)

		expect(calls).toHaveLength(FAN_OUT)
	})

	it("delivers no more than requestsPerMinute inside any sliding minute", async () => {
		// Assert the rate the option promises, not the implemented spacing: a budget that releases
		// N back to back and then waits `60000/N` ms sustains 100/minute against a stated 10.
		const BUDGET = 10
		const clock = new VirtualClock()
		const arrivals: number[] = []

		const client = new APIClient({
			displayName: "rate-interface",
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
		// The cooldown is a full minute, not `60000 / requestsPerMinute`, which would let a
		// budget of 2 release 2, wait 30s, and release 2 more within the same minute.
		const COOLDOWN_MS = 60_000

		const clock = new VirtualClock()
		const { axios, dispatchTimes } = stubTransport([{ body: { ok: true } }], { clock })

		const client = new APIClient({
			displayName: "cooldown-serial",
			requestsPerMinute: 2,
			clock,
			axios,
		})

		await client.fetch(get("/serial/0.json"))
		await client.fetch(get("/serial/1.json"))

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
		const { axios, dispatchTimes } = stubTransport([{ body: { ok: true } }], { clock })

		const client = new APIClient({
			displayName: "paced-fanout",
			minRequestIntervalMs: INTERVAL_MS,
			clock,
			axios,
		})

		const pending = Array.from({ length: FAN_OUT }, (_, i) => client.fetch(get(`/paced/${i}.json`)))

		await drainMicrotasks()

		await clock.advance((FAN_OUT - 1) * INTERVAL_MS)
		await Promise.all(pending)

		expect(dispatchTimes).toHaveLength(FAN_OUT)
		expect(new Set(dispatchTimes).size).toBe(FAN_OUT)
		expect(maxCountInSlidingWindow(dispatchTimes, 1000)).toBe(EXPECTED_PER_SECOND)
	})
})

describe("APIClient: bounded retry (A3)", () => {
	it("retries a transient 429 with exponential backoff and succeeds once the server recovers", async () => {
		const clock = createFakeClock()

		const { axios, calls } = stubTransport([
			{ status: 429, statusText: "Too Many Requests" },
			{ status: 429, statusText: "Too Many Requests" },
			{ body: { ok: true } },
		])

		const client = new APIClient({
			displayName: "retry-429",
			retry: { maxAttempts: 3, baseDelayMs: 500 },
			clock,
			axios,
		})

		const response = await client.fetch<{ ok: boolean }>(get("/retry.json"))

		expect(response.data).toEqual({ ok: true })
		expect(calls).toHaveLength(3)
		expect(clock.sleepCalls).toEqual([500, 1000])
	})

	it("gives up after maxAttempts on a persistent 503 — bounded, not until it works", async () => {
		const { axios, calls } = stubTransport([{ status: 503, statusText: "Service Unavailable" }])

		const client = new APIClient({
			displayName: "retry-ceiling",
			retry: { maxAttempts: 2, baseDelayMs: 1 },
			clock: createFakeClock(),
			axios,
		})

		const caught = await client.fetch(get("/down.json")).catch((error: unknown) => error)

		expect(caught).toBeInstanceOf(ResourceError)
		expect((caught as ResourceError).status).toBe(503)
		expect(isTransientResourceError(caught)).toBe(true)
		expect(calls).toHaveLength(2)
	})

	it("NEVER retries a 403, even with retry enabled — one attempt, non-transient", async () => {
		const { axios, calls } = stubTransport([{ status: 403, statusText: "Forbidden" }])

		const client = new APIClient({
			displayName: "retry-403",
			retry: { maxAttempts: 5, baseDelayMs: 1 },
			clock: createFakeClock(),
			axios,
		})

		const caught = await client.fetch(get("/forbidden.json")).catch((error: unknown) => error)

		expect(caught).toBeInstanceOf(ResourceError)
		expect((caught as ResourceError).status).toBe(403)
		expect(isTransientResourceError(caught)).toBe(false)
		expect(calls).toHaveLength(1)
	})

	it("does not retry a 404 either, and maps it to a skippable ResourceError", async () => {
		const { axios, calls } = stubTransport([{ status: 404, statusText: "Not Found" }])

		const client = new APIClient({
			displayName: "retry-404",
			retry: { maxAttempts: 5, baseDelayMs: 1 },
			clock: createFakeClock(),
			axios,
		})

		const caught = await client.fetch(get("/missing.json")).catch((error: unknown) => error)

		expect((caught as ResourceError).status).toBe(404)
		expect(isTransientResourceError(caught)).toBe(false)
		expect(calls).toHaveLength(1)
	})

	it("retries a transport-level failure — a dropped socket, not a status", async () => {
		const clock = createFakeClock()

		const { axios, calls } = stubTransport([
			{ throws: { message: "socket hang up", code: AxiosError.ERR_NETWORK } },
			{ body: { ok: true } },
		])

		const client = new APIClient({
			displayName: "retry-network",
			retry: { maxAttempts: 3, baseDelayMs: 500 },
			clock,
			axios,
		})

		const response = await client.fetch<{ ok: boolean }>(get("/dropped.json"))

		expect(response.data).toEqual({ ok: true })
		expect(calls).toHaveLength(2)
		expect(clock.sleepCalls).toEqual([500])
	})

	it("exhausts its budget on a persistent transport failure and still reports it as requeueable", async () => {
		const { axios, calls } = stubTransport([{ throws: { message: "socket hang up", code: AxiosError.ERR_NETWORK } }])

		const client = new APIClient({
			displayName: "retry-network-ceiling",
			retry: { maxAttempts: 2, baseDelayMs: 1 },
			clock: createFakeClock(),
			axios,
		})

		const caught = await client.fetch(get("/always-dropped.json")).catch((error: unknown) => error)

		expect(caught).toBeInstanceOf(ResourceError)
		expect(resourceErrorKind(caught)).toBe(ResourceErrorKind.Network)
		expect(isTransientResourceError(caught)).toBe(true)
		expect(calls).toHaveLength(2)
	})

	it("maps a timeout to a transient network error, not the old uniform 500", async () => {
		const { axios } = stubTransport([{ throws: { message: "timeout of 30000ms exceeded", code: "ECONNABORTED" } }])

		const client = new APIClient({
			displayName: "timeout-map",
			clock: createFakeClock(),
			axios,
		})

		const caught = await client.fetch(get("/slow.json")).catch((error: unknown) => error)

		expect(caught).toBeInstanceOf(ResourceError)
		expect(resourceErrorKind(caught)).toBe(ResourceErrorKind.Network)
		expect(isTransientResourceError(caught)).toBe(true)
	})

	it("does not retry a caller-initiated cancel", async () => {
		const { axios, calls } = stubTransport([{ throws: { message: "canceled", code: AxiosError.ERR_CANCELED } }])

		const client = new APIClient({
			displayName: "cancel",
			retry: { maxAttempts: 5, baseDelayMs: 1 },
			clock: createFakeClock(),
			axios,
		})

		const caught = await client.fetch(get("/canceled.json")).catch((error: unknown) => error)

		expect(resourceErrorKind(caught)).toBe(ResourceErrorKind.Request)
		expect(isTransientResourceError(caught)).toBe(false)
		expect(calls).toHaveLength(1)
	})

	it("honors a numeric Retry-After over the exponential default", async () => {
		const clock = createFakeClock()

		const { axios } = stubTransport([
			{ status: 429, statusText: "Too Many Requests", headers: { "retry-after": "45" } },
			{ body: { ok: true } },
		])

		const client = new APIClient({
			displayName: "retry-after",
			retry: { maxAttempts: 2, baseDelayMs: 500 },
			clock,
			axios,
		})

		await client.fetch(get("/rate-limited.json"))

		expect(clock.sleepCalls).toEqual([45_000])
	})

	it("clamps an excessive Retry-After to the ceiling", async () => {
		const clock = createFakeClock()

		const { axios } = stubTransport([
			{ status: 429, statusText: "Too Many Requests", headers: { "retry-after": "999999" } },
			{ body: { ok: true } },
		])

		const client = new APIClient({
			displayName: "retry-after-clamp",
			retry: { maxAttempts: 2, baseDelayMs: 500 },
			clock,
			axios,
		})

		await client.fetch(get("/rate-limited.json"))

		expect(clock.sleepCalls).toEqual([60_000])
	})
})

describe("APIClient: the pacing check sits downstream of the cache (I2)", () => {
	it("does not pace a cache HIT — only a request that actually reaches the network", async () => {
		// A cache hit must not burn a pacer sleep: `/Archives/` documents are cached for a
		// century by design, so warm re-runs are the expected mode of a bulk crawl.
		const REPEATS = 6

		const clock = createFakeClock()
		const { axios, calls } = stubTransport([{ body: { ok: true } }])

		const client = new APIClient({
			displayName: "cache-hit-pacing",
			minRequestIntervalMs: 111,
			caching: { storage: buildMemoryStorage() },
			clock,
			axios,
		})

		for (let i = 0; i < REPEATS; i++) {
			await client.fetch(get("/archived.json"))
		}

		expect(calls).toHaveLength(1)

		expect(clock.sleepCalls).toEqual([])
	})

	it("still paces the MISSES when the same client interleaves hits and misses", async () => {
		const clock = createFakeClock()
		const { axios, calls, dispatchTimes } = stubTransport([{ body: { ok: true } }], { clock })

		const client = new APIClient({
			displayName: "mixed-pacing",
			minRequestIntervalMs: 100,
			caching: { storage: buildMemoryStorage() },
			clock,
			axios,
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
		const INTERVAL_MS = 100

		const clock = createFakeClock()

		const { axios, calls, dispatchTimes } = stubTransport(
			[
				{ status: 503, statusText: "Service Unavailable" },
				{ status: 503, statusText: "Service Unavailable" },
				{ body: { ok: true } },
			],
			{ clock }
		)

		const client = new APIClient({
			displayName: "paced-retries",
			minRequestIntervalMs: INTERVAL_MS,
			// A backoff far shorter than the pacing interval, so only the pacer can produce the spacing.
			retry: { maxAttempts: 3, baseDelayMs: 1 },
			clock,
			axios,
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
		// A pacer grant is a claim on a specific instant, so blocking on a cooldown after
		// taking one leaves it stale and every holder spends it the moment the cooldown lifts.
		const INTERVAL_MS = 100
		const FAN_OUT = 8

		const clock = new VirtualClock()
		const { axios, dispatchTimes } = stubTransport([{ body: { ok: true } }], { clock })

		const client = new APIClient({
			displayName: "both-checks",
			minRequestIntervalMs: INTERVAL_MS,
			requestsPerMinute: 2, // a 30s cooldown every 2 dispatches
			clock,
			axios,
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

describe("APIClient: a caller-supplied adapter cannot bypass the check", () => {
	it("strips a per-request adapter so the pacing grant is still taken", async () => {
		// `mergeConfig` lets a request-level `adapter` win over the instance default
		// that holds the pacing check; the cache interceptor's own adapter swap runs
		// inside the interceptor chain and is unaffected.
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
