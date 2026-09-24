/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Tests for {@linkcode createGoogleGeocoderClient}.
 *
 *   Every test drives the stub Axios adapter from `@mailwoman/core/api/test-transport` and, where
 *   timing matters, an injected `ClockLike` from `@mailwoman/core/api/test-clocks`. no test here
 *   performs A live network call or A real sleep, and on this client the first half is not merely
 *   hygiene: every uncached Google request is billed, so a suite that reached the network would charge
 *   the operator's card on every CI run.
 *
 *   The interesting assertions are the ones about Google's IN-band error channel — statuses that
 *   arrive under http 200 and are therefore invisible to every check `core/api` provides — and about
 *   the API key, which must not reach a log, a cache key or a filename.
 */

import { createFakeClock } from "@mailwoman/core/api/test-clocks"
import { stubTransport } from "@mailwoman/core/api/test-transport"
import type { ResourceError as ResourceErrorShape } from "@mailwoman/core/errors"
import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectoryExclusive } from "@mailwoman/core/fs/writers"
import type { PathBuilder } from "path-ts"
import { Globerator } from "spliterator/node/fs"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// `$private` is a live getter over `{ ...dotEnv, ...process.env }`, and `dotEnv` is read from the
// repo's real `.env` once at module load, which on this machine does carry a `GOOGLE_MAPS_API_KEY`.
// A `vi.stubEnv(..., undefined)` cannot hide it: the merge falls back to `dotEnv`
// regardless of what the test puts on `process.env`.
// Mocking the module is the only way to make the missing-key test test anything.
// (`bdc/sdk/client.test.ts` learned this the first time real FCC credentials landed in `.env`.)
vi.mock("@mailwoman/geocode-oracle/env", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@mailwoman/geocode-oracle/env")>()

	return { ...actual, $private: { ...actual.$private, GOOGLE_MAPS_API_KEY: undefined } }
})

// Shared-graph guard: the root vitest config runs `isolate: false`, so `./google-client.ts` may
// already sit in the worker's cache — evaluated without this file's env mock by an earlier file.
// Reset on the way in so the chain re-evaluates against the mock, and on the way out
// so the next file in this fork does not inherit it.
vi.resetModules()
afterAll(() => vi.resetModules())

const { createGoogleGeocoderClient, geocodeCacheKey, isCacheableGoogleBody } =
	await import("@mailwoman/geocode-oracle/sdk/google-client")

// Also imported after the reset, so the `ResourceError` this file compares against is the same
// class identity the client under test throws — a `vi.resetModules()` mints a fresh module
// registry, and a statically-imported class from the old one would fail every `toBeInstanceOf`.
const { isTransientResourceError } = await import("@mailwoman/core/api")
const { ResourceError } = await import("@mailwoman/core/errors")

const API_KEY = "AIza-test-key-not-a-real-one"

/**
 * A minimal `OK` body for one Mountain View address.
 */
const OK_BODY = {
	status: "OK",
	results: [
		{
			address_components: [
				{ long_name: "1600", short_name: "1600", types: ["street_number"] },
				{ long_name: "Amphitheatre Parkway", short_name: "Amphitheatre Pkwy", types: ["route"] },
				{ long_name: "Mountain View", short_name: "Mountain View", types: ["locality", "political"] },
				{ long_name: "California", short_name: "CA", types: ["administrative_area_level_1", "political"] },
				{ long_name: "United States", short_name: "US", types: ["country", "political"] },
				{ long_name: "94043", short_name: "94043", types: ["postal_code"] },
			],
			formatted_address: "1600 Amphitheatre Pkwy, Mountain View, CA 94043, USA",
			geometry: { location: { lat: 37.4224764, lng: -122.0842499 }, location_type: "ROOFTOP" },
			place_id: "ChIJ2eUgeAK6j4ARbn5u_wAGqWA",
			types: ["street_address"],
		},
	],
}

/**
 * Await a call that must reject and hand back its {@linkcode ResourceError}.
 *
 * Fails loudly if it resolves.
 * A `.catch(error => error)` inline would silently turn "it did not throw"
 * into an assertion against `undefined`.
 */
async function captureError(promise: Promise<unknown>): Promise<ResourceErrorShape> {
	try {
		await promise
	} catch (error) {
		return error as ResourceErrorShape
	}

	throw new Error("Expected the call to reject, but it resolved.")
}

let cacheDir: PathBuilder
let dataRoot: TemporaryDirectory

beforeEach(async () => {
	dataRoot = await temporaryDirectory("geocode-oracle-google-")
	cacheDir = dataRoot.path("http-cache")

	await makeDirectoryExclusive(cacheDir)
	vi.stubEnv("MAILWOMAN_DATA_ROOT", dataRoot.path.toString())
})

afterEach(() => {
	vi.unstubAllEnvs()
	dataRoot[Symbol.asyncDispose]()
})

describe("createGoogleGeocoderClient", () => {
	it("fails fast when no key is available", () => {
		expect(() => createGoogleGeocoderClient()).toThrow(/GOOGLE_MAPS_API_KEY/)
	})

	it("sends the key as a query parameter, never inside the request URL", async () => {
		const transport = stubTransport([{ body: OK_BODY }])

		await using client = createGoogleGeocoderClient({ apiKey: API_KEY, cacheDir, axios: transport.axios })

		await client.geocodeAddress("1600 Amphitheatre Parkway")

		// This is what `APIClient` logs and what `delegateAxiosError` interpolates into
		// timeout/DNS messages, so the key must not be in it.
		expect(transport.calls[0]).not.toContain(API_KEY)
		expect(transport.calls[0]).toBe("https://maps.googleapis.com/maps/api/geocode/json")
	})

	it("returns parsed results for an OK response", async () => {
		const transport = stubTransport([{ body: OK_BODY }])

		await using client = createGoogleGeocoderClient({ apiKey: API_KEY, cacheDir, axios: transport.axios })

		const results = await client.geocodeAddress("1600 Amphitheatre Parkway")

		expect(results).toHaveLength(1)
		expect(results[0]?.address.components.locality).toBe("Mountain View")
		expect(results[0]?.address.geocode?.tier).toBe("address_point")
	})

	it("forwards a country restriction as the components filter", async () => {
		const transport = stubTransport([{ body: OK_BODY }])

		await using client = createGoogleGeocoderClient({ apiKey: API_KEY, cacheDir, axios: transport.axios })

		await client.geocodeAddress("Springfield", { country: "NZ", language: "en" })

		const params = (transport.configs[0] as { params?: Record<string, string> }).params

		expect(params?.components).toBe("country:NZ")
		expect(params?.language).toBe("en")
		// The isp-nexus original hardcoded a contiguous-US bounding box on every
		// forward geocode, with no way to turn it off.
		// There is no default here.
		expect(params?.bounds).toBeUndefined()
	})
})

describe("in-band status mapping", () => {
	it("reports ZERO_RESULTS as a 404", async () => {
		const transport = stubTransport([{ body: { status: "ZERO_RESULTS", results: [] } }])

		await using client = createGoogleGeocoderClient({ apiKey: API_KEY, cacheDir, axios: transport.axios })

		const error = await captureError(client.geocodeAddress("nowhere at all"))

		expect(error).toBeInstanceOf(ResourceError)
		expect(error.status).toBe(404)
		expect(isTransientResourceError(error)).toBe(false)
	})

	it("reports REQUEST_DENIED as a 403 that names the key as the cause, and does not retry it", async () => {
		const transport = stubTransport([
			{ body: { status: "REQUEST_DENIED", results: [], error_message: "The provided API key is invalid." } },
		])

		await using client = createGoogleGeocoderClient({ apiKey: API_KEY, cacheDir, axios: transport.axios })

		const error = await captureError(client.geocodeAddress("anywhere"))

		expect(error.status).toBe(403)
		expect(error.message).toContain("KEY problem")
		expect(error.message).toContain("The provided API key is invalid.")
		// The key itself is never echoed back.
		expect(error.message).not.toContain(API_KEY)
		expect(transport.calls).toHaveLength(1)
	})

	it("retries OVER_QUERY_LIMIT on the injected clock and succeeds", async () => {
		const clock = createFakeClock()
		const transport = stubTransport([{ body: { status: "OVER_QUERY_LIMIT", results: [] } }, { body: OK_BODY }])

		await using client = createGoogleGeocoderClient({
			apiKey: API_KEY,
			cacheDir,
			clock,
			axios: transport.axios,
			baseRetryDelayMs: 500,
		})

		const results = await client.geocodeAddress("1600 Amphitheatre Parkway")

		expect(results).toHaveLength(1)
		expect(transport.calls).toHaveLength(2)
		// One 500ms in-band backoff, plus whatever the pacer spent.
		// No wall-clock time passed.
		expect(clock.sleepCalls).toContain(500)
	})

	it("gives up on OVER_QUERY_LIMIT at the attempt ceiling, as a transient error", async () => {
		const clock = createFakeClock()
		const transport = stubTransport([{ body: { status: "OVER_QUERY_LIMIT", results: [] } }])

		await using client = createGoogleGeocoderClient({
			apiKey: API_KEY,
			cacheDir,
			clock,
			maxAttempts: 2,
			axios: transport.axios,
		})

		const error = await captureError(client.geocodeAddress("anywhere"))

		expect(error.status).toBe(429)
		// A stated ceiling: the caller requeues, the client does not spin.
		expect(isTransientResourceError(error)).toBe(true)
		expect(transport.calls).toHaveLength(2)
	})
})

describe("the response cache", () => {
	it("serves a repeat request from disk without dispatching", async () => {
		const transport = stubTransport([{ body: OK_BODY }])

		await using client = createGoogleGeocoderClient({ apiKey: API_KEY, cacheDir, axios: transport.axios })

		await client.geocodeAddress("1600 Amphitheatre Parkway")
		await client.geocodeAddress("1600 Amphitheatre Parkway")

		expect(transport.calls).toHaveLength(1)
		expect(await Globerator.files("json", { cwd: cacheDir, recursive: false }).toArray()).toHaveLength(1)
	})

	it("never writes the API key to disk, nor into a filename", async () => {
		const transport = stubTransport([{ body: OK_BODY }])

		await using client = createGoogleGeocoderClient({ apiKey: API_KEY, cacheDir, axios: transport.axios })

		await client.geocodeAddress("1600 Amphitheatre Parkway")

		const entries = await Globerator.files("json", { cwd: cacheDir, absolute: false, recursive: false }).toArray()

		expect(entries).toHaveLength(1)

		for (const entry of entries) {
			expect(entry).not.toContain(API_KEY)
			expect(await readLocalTextFile(cacheDir(entry))).not.toContain(API_KEY)
		}
	})

	it("refuses to persist a body that is not a real answer", async () => {
		const transport = stubTransport([{ body: { status: "REQUEST_DENIED", results: [] } }])

		await using client = createGoogleGeocoderClient({ apiKey: API_KEY, cacheDir, axios: transport.axios })

		await client.geocodeAddress("anywhere").catch(() => undefined)

		// A REQUEST_DENIED cached under a 30-day TTL would make an unbilled key look like a
		// permanently broken address, self-healing only by hand-deleting a hash-named file.
		expect(await Globerator.files("json", { cwd: cacheDir, recursive: false }).toArray()).toHaveLength(0)
	})

	it("does persist ZERO_RESULTS as a stable answer", async () => {
		const transport = stubTransport([{ body: { status: "ZERO_RESULTS", results: [] } }])

		await using client = createGoogleGeocoderClient({ apiKey: API_KEY, cacheDir, axios: transport.axios })

		await client.geocodeAddress("nowhere at all").catch(() => undefined)
		await client.geocodeAddress("nowhere at all").catch(() => undefined)

		expect(transport.calls).toHaveLength(1)
	})
})

describe("geocodeCacheKey", () => {
	it("excludes the API key so rotating it does not orphan the cache", () => {
		const withOldKey = geocodeCacheKey({ url: "u", params: { address: "x", key: "old" } })
		const withNewKey = geocodeCacheKey({ url: "u", params: { address: "x", key: "new" } })

		expect(withOldKey).toBe(withNewKey)
		expect(withOldKey).not.toContain("old")
	})

	it("is insensitive to parameter ordering", () => {
		expect(geocodeCacheKey({ url: "u", params: { a: "1", b: "2" } })).toBe(
			geocodeCacheKey({ url: "u", params: { b: "2", a: "1" } })
		)
	})

	it("still distinguishes different queries", () => {
		expect(geocodeCacheKey({ url: "u", params: { address: "x" } })).not.toBe(
			geocodeCacheKey({ url: "u", params: { address: "y" } })
		)
	})
})

describe("isCacheableGoogleBody", () => {
	it.each([
		["OK", true],
		["ZERO_RESULTS", true],
		["REQUEST_DENIED", false],
		["OVER_QUERY_LIMIT", false],
		["OVER_DAILY_LIMIT", false],
		["INVALID_REQUEST", false],
		["UNKNOWN_ERROR", false],
	])("%s → %s", (status, cacheable) => {
		expect(isCacheableGoogleBody({ data: { data: { status, results: [] } } })).toBe(cacheable)
	})

	it("rejects a non-object body", () => {
		expect(isCacheableGoogleBody({ data: { data: "<html>error</html>" } })).toBe(false)
	})
})

describe("input dispatch", () => {
	it("reverse-geocodes a coordinate object", async () => {
		const transport = stubTransport([{ body: OK_BODY }])

		await using client = createGoogleGeocoderClient({ apiKey: API_KEY, cacheDir, axios: transport.axios })

		await client.geocode({ lat: 37.4224764, lng: -122.0842499 })

		const params = (transport.configs[0] as { params?: Record<string, string> }).params

		expect(params?.latlng).toBe("37.4224764,-122.0842499")
	})

	it("rejects an off-globe coordinate rather than repairing it", async () => {
		const transport = stubTransport([{ body: OK_BODY }])

		await using client = createGoogleGeocoderClient({ apiKey: API_KEY, cacheDir, axios: transport.axios })

		const error = await captureError(client.reverseGeocode([999, 999]))

		expect(error.status).toBe(400)
		expect(transport.calls).toHaveLength(0)
	})

	it("treats a bare coordinate STRING as an address rather than a point", async () => {
		// Deliberate.
		// `"48.85, 2.29"` means latitude-then-longitude to Google's `latlng` parameter
		// and longitude-then-latitude to GeoJSON, and `GeoPoint.from` resolves that
		// as GeoJSON without a heuristic.
		// So reading the string as a point would silently reverse-geocode Somalia for someone who typed Paris.
		const transport = stubTransport([{ body: OK_BODY }])

		await using client = createGoogleGeocoderClient({ apiKey: API_KEY, cacheDir, axios: transport.axios })

		await client.geocode("48.8335023, 2.3686051")

		const params = (transport.configs[0] as { params?: Record<string, string> }).params

		expect(params?.address).toBe("48.8335023, 2.3686051")
		expect(params?.latlng).toBeUndefined()
	})

	it("routes a Place ID to the place_id parameter", async () => {
		const transport = stubTransport([{ body: OK_BODY }])

		await using client = createGoogleGeocoderClient({ apiKey: API_KEY, cacheDir, axios: transport.axios })

		await client.geocode("ChIJ2eUgeAK6j4ARbn5u_wAGqWA")

		const params = (transport.configs[0] as { params?: Record<string, string> }).params

		expect(params?.place_id).toBe("ChIJ2eUgeAK6j4ARbn5u_wAGqWA")
	})

	it("does not mistake a one-word place name for a Place ID", async () => {
		const transport = stubTransport([{ body: OK_BODY }])

		await using client = createGoogleGeocoderClient({ apiKey: API_KEY, cacheDir, axios: transport.axios })

		await client.geocode("Paris")

		const params = (transport.configs[0] as { params?: Record<string, string> }).params

		expect(params?.address).toBe("Paris")
		expect(params?.place_id).toBeUndefined()
	})
})

describe("pacing", () => {
	it("spaces dispatches by the interval the configured rate implies", async () => {
		const clock = createFakeClock()
		const transport = stubTransport([{ body: OK_BODY }], { clock })

		await using client = createGoogleGeocoderClient({
			apiKey: API_KEY,
			cacheDir,
			clock,
			requestsPerMinute: 60,
			axios: transport.axios,
		})

		await Promise.all([client.geocodeAddress("a"), client.geocodeAddress("b"), client.geocodeAddress("c")])

		// 60000 / 60 = 1000ms.
		// `requestsPerMinute` alone would have let all three go out at once.
		// It is a budget rather than a rate.
		// See `bdc/sdk/client.ts` for the measurement.
		expect(transport.dispatchTimes).toEqual([0, 1000, 2000])
	})
})
