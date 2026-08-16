/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The external client against a scripted wire — the real parsing, the real refusals, no network.
 *
 *   The bodies below are shortened captures of what the three engines actually answer, not shapes invented from their
 *   documentation. A parser tested against its author's idea of the format is a parser tested against nothing.
 */

import { createFakeClock } from "@mailwoman/core/api/test-clocks"
import { stubTransport } from "@mailwoman/core/api/test-transport"
import { describe, expect, it } from "vitest"

import {
	assertScorableEndpoint,
	EXTERNAL_ARM_MIN_REQUEST_INTERVAL_MS,
	ExternalEngine,
	ExternalGeocoderClient,
} from "./external-arm.ts"

const ENDPOINT = "http://127.0.0.1:4000"

const PELIAS_HIT = {
	geocoding: { version: "0.2", engine: { name: "Pelias", author: "Mapzen", version: "1.0" } },
	type: "FeatureCollection",
	features: [
		{
			type: "Feature",
			geometry: { type: "Point", coordinates: [-120.471512, 37.307614] },
			properties: { layer: "address", name: "30 West 26th Street", confidence: 1 },
		},
	],
}

const PELIAS_EMPTY = { geocoding: { version: "0.2", engine: { version: "1.0" } }, features: [] }

const NOMINATIM_STATUS = {
	status: 0,
	message: "OK",
	data_updated: "2026-08-05T19:34:29+00:00",
	software_version: "5.0.0",
	database_version: "4.5.0-0",
}

function client(engine: ExternalEngine, outcomes: Parameters<typeof stubTransport>[0], endpoint = ENDPOINT) {
	const transport = stubTransport(outcomes)

	return { transport, client: new ExternalGeocoderClient(engine, endpoint, { axios: transport.axios }) }
}

describe("assertScorableEndpoint", () => {
	it("refuses the shared public instances the benchmark plan bars from being a scored arm", () => {
		expect(() => assertScorableEndpoint("https://photon.komoot.io")).toThrow(/never be a scored arm|refused/)
		expect(() => assertScorableEndpoint("https://nominatim.openstreetmap.org/search")).toThrow(/refused/)
	})

	it("accepts a local origin and normalizes its trailing slash away", () => {
		expect(assertScorableEndpoint("http://127.0.0.1:4000/")).toBe("http://127.0.0.1:4000")
	})

	it("refuses something that is not a URL rather than composing a request against it", () => {
		expect(() => assertScorableEndpoint("127.0.0.1:4000")).toThrow(/not a URL|must be http/)
	})
})

describe("ExternalGeocoderClient.search", () => {
	it("reads top-1 out of a Pelias FeatureCollection, lon-first as GeoJSON orders it", async () => {
		const { client: pelias, transport } = client(ExternalEngine.Pelias, [{ body: PELIAS_HIT }])
		const answer = await pelias.search("30 W 26th St, New York")

		expect(answer.lat).toBeCloseTo(37.307614, 5)
		expect(answer.lon).toBeCloseTo(-120.471512, 5)
		expect(answer.resultType).toBe("address")
		expect(answer.noResultReason).toBeNull()
		expect(transport.calls[0]).toBe("http://127.0.0.1:4000/v1/search?text=30%20W%2026th%20St%2C%20New%20York&size=1")
	})

	it("reports an empty result as an absence with a reason, never as a coordinate", async () => {
		const { client: pelias } = client(ExternalEngine.Pelias, [{ body: PELIAS_EMPTY }])
		const answer = await pelias.search("nowhere at all")

		expect(answer.lat).toBeNull()
		expect(answer.lon).toBeNull()
		expect(answer.noResultReason).toContain("no features")
	})

	it("refuses a transposed position instead of scoring the distance to it", async () => {
		// A latitude past ±90 is what a lat/lon swap looks like on the wire. Accepting it would produce a finite
		// haversine distance and an ordinary-looking miss, which is indistinguishable from a real answer that is wrong.
		const swapped = {
			features: [{ type: "Feature", geometry: { type: "Point", coordinates: [37.3, -120.4] }, properties: {} }],
		}

		const { client: photon } = client(ExternalEngine.Photon, [{ body: swapped }], "http://127.0.0.1:2323")
		const answer = await photon.search("somewhere")

		expect(answer.lat).toBeNull()
		expect(answer.noResultReason).toContain("out of range")
	})

	it("parses Nominatim's decimal-STRING coordinates", async () => {
		const body = [{ lat: "43.6411038", lon: "7.4715097", addresstype: "country", display_name: "Monaco" }]
		const { client: nominatim } = client(ExternalEngine.Nominatim, [{ body }], "http://127.0.0.1:8081")
		const answer = await nominatim.search("Monaco")

		expect(answer.lat).toBeCloseTo(43.6411038, 5)
		expect(answer.lon).toBeCloseTo(7.4715097, 5)
		expect(answer.resultType).toBe("country")
	})
})

describe("ExternalGeocoderClient.probeIdentity", () => {
	it("records the version and data vintage an endpoint reports for itself", async () => {
		const body = [{ lat: "48.85", lon: "2.35", addresstype: "city" }]

		const { client: nominatim } = client(
			ExternalEngine.Nominatim,
			[{ body: NOMINATIM_STATUS }, { body }],
			"http://127.0.0.1:8081"
		)

		const identity = await nominatim.probeIdentity()

		expect(identity.version).toBe("5.0.0")
		expect(identity.version_source).toBe("endpoint")
		expect(identity.data_vintage).toBe("2026-08-05T19:34:29+00:00")
		expect(identity.warnings.join(" ")).not.toContain("caller")
	})

	it("refuses an endpoint that will not say what it is, because a drop-in answers identically", async () => {
		// Photon's search path has no version anywhere in it, so a 404 on /status leaves nothing to identify the arm
		// by. Scoring it anyway is how a benchmark ends up comparing mailwoman against mailwoman.
		const search = {
			features: [{ type: "Feature", geometry: { type: "Point", coordinates: [2.35, 48.85] }, properties: {} }],
		}

		const { client: photon } = client(ExternalEngine.Photon, [{ status: 404, body: "not found" }, { body: search }])

		await expect(photon.probeIdentity()).rejects.toThrow(/will not say what it is/)
	})

	it("accepts a caller-declared version for that endpoint, and marks it as a claim", async () => {
		const search = {
			features: [{ type: "Feature", geometry: { type: "Point", coordinates: [2.35, 48.85] }, properties: {} }],
		}

		const { client: photon } = client(ExternalEngine.Photon, [{ status: 404, body: "nope" }, { body: search }])
		const identity = await photon.probeIdentity("1.3.0")

		expect(identity.version).toBe("1.3.0")
		expect(identity.version_source).toBe("caller-declared")
		expect(identity.warnings.join(" ")).toContain("CALLER-DECLARED")
		expect(identity.warnings.join(" ")).toContain("did not answer")
	})

	it("refuses a dead endpoint with the reason, rather than letting the run score every row as a miss", async () => {
		const dead = { throws: { message: "connect ECONNREFUSED 127.0.0.1:4000", code: "ERR_NETWORK" } }
		const { client: pelias } = client(ExternalEngine.Pelias, [dead])

		await expect(pelias.probeIdentity()).rejects.toThrow(/does not start or stop external services/)
	})
})

describe("ExternalGeocoderClient pacing", () => {
	it("spaces dispatches at the configured interval, which is the gate that actually holds a rate", async () => {
		// Asserted rather than assumed: `requestsPerMinute` alone does NOT deliver N requests per minute (AGENTS.md
		// records 100/min measured against a budget of 10), so the claim that this client is paced rests entirely on
		// the interval gate being the one configured.
		const clock = createFakeClock()
		const transport = stubTransport([{ body: PELIAS_HIT }], { clock })

		const pelias = new ExternalGeocoderClient(ExternalEngine.Pelias, ENDPOINT, {
			clock,
			axios: transport.axios,
		})

		await pelias.search("one")

		expect(clock.sleepCalls).toHaveLength(0)

		await pelias.search("two")
		await pelias.search("three")

		expect(clock.sleepCalls).toEqual([EXTERNAL_ARM_MIN_REQUEST_INTERVAL_MS, EXTERNAL_ARM_MIN_REQUEST_INTERVAL_MS])

		expect(transport.dispatchTimes).toEqual([
			0,
			EXTERNAL_ARM_MIN_REQUEST_INTERVAL_MS,
			EXTERNAL_ARM_MIN_REQUEST_INTERVAL_MS * 2,
		])
	})
})
