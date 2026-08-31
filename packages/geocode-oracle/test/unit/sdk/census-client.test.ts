/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Tests for {@linkcode createCensusGeocoderClient} and the Census match → `ComponentTag`
 *   mapping. Stub adapter plus injected clock throughout; no live network call, no wall-clock sleep.
 *
 *   The fixture is the Census Bureau's own documentation example (4600 Silver Hill Rd), with the
 *   component slots filled the way the live API fills them — every value uppercase, the house number
 *   present ONLY in `matchedAddress`, and the address range on `fromAddress`/`toAddress`.
 */

import { isTransientResourceError } from "@mailwoman/core/api"
import { createFakeClock } from "@mailwoman/core/api/test-clocks"
import { stubTransport } from "@mailwoman/core/api/test-transport"
import { ResourceError, type ResourceError as ResourceErrorShape } from "@mailwoman/core/errors"
import { readDirectory } from "@mailwoman/core/fs/readers"
import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectoryExclusive } from "@mailwoman/core/fs/writers"
import { createCensusGeocoderClient, isCacheableCensusBody } from "@mailwoman/geocode-oracle/sdk/census-client"
import {
	CENSUS_RESOLUTION_TIER,
	buildCensusComponents,
	buildStreetComponents,
	parseCensusAddressMatch,
} from "@mailwoman/geocode-oracle/sdk/census-parser"
import type { CensusAddressComponents, CensusAddressMatch } from "@mailwoman/geocode-oracle/sdk/census-types"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

function addressComponents(overrides: Partial<CensusAddressComponents> = {}): CensusAddressComponents {
	return {
		preQualifier: "",
		preDirection: "",
		preType: "",
		streetName: "SILVER HILL",
		suffixType: "RD",
		suffixDirection: "",
		suffixQualifier: "",
		city: "WASHINGTON",
		state: "DC",
		zip: "20233",
		fromAddress: "4600",
		toAddress: "4698",
		...overrides,
	}
}

function match(overrides: Partial<CensusAddressMatch> = {}): CensusAddressMatch {
	return {
		matchedAddress: "4600 SILVER HILL RD, WASHINGTON, DC, 20233",
		addressComponents: addressComponents(),
		tigerLine: { side: "L", tigerLineId: "76355984" },
		coordinates: { x: -76.92744, y: 38.845985 },
		...overrides,
	}
}

const OK_BODY = { result: { addressMatches: [match()] } }
const NO_MATCH_BODY = { result: { addressMatches: [] } }

/**
 * Await a call that must reject and hand back its {@linkcode ResourceError}. Fails loudly if it resolves — a
 * `.catch(error => error)` inline would silently turn "it did not throw" into an assertion against `undefined`.
 */
async function captureError(promise: Promise<unknown>): Promise<ResourceErrorShape> {
	try {
		await promise
	} catch (error) {
		return error as ResourceErrorShape
	}

	throw new Error("Expected the call to reject, but it resolved.")
}

let cacheDir: string
let dataRoot: TemporaryDirectory

beforeEach(async () => {
	dataRoot = await temporaryDirectory("geocode-oracle-census-")
	cacheDir = dataRoot.resolve("http-cache")

	await makeDirectoryExclusive(cacheDir)
	vi.stubEnv("MAILWOMAN_DATA_ROOT", dataRoot.path.toString())
})

afterEach(() => {
	vi.unstubAllEnvs()
	dataRoot[Symbol.asyncDispose]()
})

describe("buildStreetComponents", () => {
	it("folds the seven Census slots into mailwoman's four tags", () => {
		expect(
			buildStreetComponents(
				addressComponents({
					preQualifier: "OLD",
					preDirection: "N",
					preType: "",
					streetName: "MAIN",
					suffixType: "ST",
					suffixDirection: "E",
					suffixQualifier: "EXTENDED",
				})
			)
		).toEqual({
			street_prefix: "N",
			street: "OLD MAIN EXTENDED",
			street_suffix: "ST E",
		})
	})

	it("keeps preDirection, which the isp-nexus interface omitted entirely", () => {
		expect(buildStreetComponents(addressComponents({ preDirection: "SW" })).street_prefix).toBe("SW")
	})

	it("emits nothing for an empty slot rather than an empty string", () => {
		const components = buildStreetComponents(addressComponents({ suffixType: "", suffixDirection: "" }))

		expect(components.street_suffix).toBeUndefined()
		expect(components.street_prefix).toBeUndefined()
	})
})

describe("buildCensusComponents", () => {
	it("recovers the house number from matchedAddress", () => {
		// `addressComponents` carries the address RANGE (4600–4698) but never the matched number, so a
		// Census-sourced record came out of the original with a street and no number on it.
		expect(buildCensusComponents(match()).house_number).toBe("4600")
	})

	it("does not invent a house number when the line has none", () => {
		expect(
			buildCensusComponents(match({ matchedAddress: "SILVER HILL RD, WASHINGTON, DC, 20233" })).house_number
		).toBeUndefined()
	})

	it("stamps the country, which the response has no field for", () => {
		expect(buildCensusComponents(match()).country).toBe("US")
	})
})

describe("parseCensusAddressMatch", () => {
	it("reads {x, y} as {longitude, latitude}", () => {
		expect(parseCensusAddressMatch(match()).address.geocode?.coordinate).toEqual({
			latitude: 38.845985,
			longitude: -76.92744,
		})
	})

	it("always reports the interpolated tier", () => {
		// Not a hedge — the mechanism. The Census geocoder has no parcel or structure layer, so it
		// cannot produce a rooftop coordinate even for a perfect match.
		expect(parseCensusAddressMatch(match()).address.geocode?.tier).toBe(CENSUS_RESOLUTION_TIER)
		expect(CENSUS_RESOLUTION_TIER).toBe("interpolated")
	})

	it("carries the TIGER segment through on raw rather than calling it a place ID", () => {
		const parsed = parseCensusAddressMatch(match())

		expect(parsed.placeID).toBeNull()
		expect(parsed.raw.tigerLine.tigerLineId).toBe("76355984")
	})

	it("mints an address ID prefixed by the state", () => {
		expect(parseCensusAddressMatch(match()).addressID.startsWith("dc.")).toBe(true)
	})
})

describe("createCensusGeocoderClient", () => {
	it("sends a one-line address to the onelineaddress endpoint", async () => {
		const transport = stubTransport([{ body: OK_BODY }])

		await using client = createCensusGeocoderClient({ cacheDir, axios: transport.axios })

		await client.lookupAddress("4600 Silver Hill Rd, Washington, DC 20233")

		expect(transport.calls[0]).toBe("https://geocoding.geo.census.gov/geocoder/locations/onelineaddress")

		const params = (transport.configs[0] as { params?: Record<string, string> }).params

		expect(params?.address).toBe("4600 Silver Hill Rd, Washington, DC 20233")
		expect(params?.benchmark).toBe("Public_AR_Current")
		// `vintage` is a `geographies/*` parameter only. The original sent it on every call.
		expect(params?.vintage).toBeUndefined()
	})

	it("sends a structured address to the address endpoint, omitting blank fields", async () => {
		const transport = stubTransport([{ body: OK_BODY }])

		await using client = createCensusGeocoderClient({ cacheDir, axios: transport.axios })

		await client.lookupAddress({ street: "4600 Silver Hill Rd", city: "Washington", state: "DC", zip: "" })

		expect(transport.calls[0]).toBe("https://geocoding.geo.census.gov/geocoder/locations/address")

		const params = (transport.configs[0] as { params?: Record<string, string> }).params

		expect(params?.street).toBe("4600 Silver Hill Rd")
		// A blank `zip` is a filter nothing matches, so it must not be sent.
		expect(params?.zip).toBeUndefined()
	})

	it("pins a compatible benchmark/vintage pair for a geography lookup", async () => {
		const transport = stubTransport([{ body: OK_BODY }])

		await using client = createCensusGeocoderClient({ cacheDir, axios: transport.axios })

		await client.lookupGeography("4600 Silver Hill Rd, Washington, DC 20233")

		const params = (transport.configs[0] as { params?: Record<string, string> }).params

		expect(transport.calls[0]).toBe("https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress")
		expect(params?.benchmark).toBe("Public_AR_Census2020")
		expect(params?.vintage).toBe("Census2020_Census2020")
	})

	it("raises a 404 for an unmatched address instead of returning an empty array", async () => {
		const transport = stubTransport([{ body: NO_MATCH_BODY }])

		await using client = createCensusGeocoderClient({ cacheDir, axios: transport.axios })

		const error = await captureError(client.lookupAddress("PO Box 1, Nowhere, ZZ"))

		expect(error).toBeInstanceOf(ResourceError)
		expect(error.status).toBe(404)
		expect(isTransientResourceError(error)).toBe(false)
	})

	it("issues no request at all for a PO Box", async () => {
		// The original short-circuited a `PO BOX` input to a LOCAL parse and returned an address record
		// with no coordinate, under the same return type as a real match. An oracle must not do that:
		// a PO Box now takes the normal path and comes back as the same 404 as any other no-match.
		const transport = stubTransport([{ body: NO_MATCH_BODY }])

		await using client = createCensusGeocoderClient({ cacheDir, axios: transport.axios })

		await client.lookupAddress("PO BOX 1234, WASHINGTON, DC 20233").catch(() => undefined)

		expect(transport.calls).toHaveLength(1)
	})

	it("rejects an empty address before dispatching", async () => {
		const transport = stubTransport([{ body: OK_BODY }])

		await using client = createCensusGeocoderClient({ cacheDir, axios: transport.axios })

		const error = await captureError(client.lookupAddress("   "))

		expect(error.status).toBe(400)
		expect(transport.calls).toHaveLength(0)
	})

	it("caches a no-match, so a repeat costs no request", async () => {
		const transport = stubTransport([{ body: NO_MATCH_BODY }])

		await using client = createCensusGeocoderClient({ cacheDir, axios: transport.axios })

		await client.lookupAddress("nowhere").catch(() => undefined)
		await client.lookupAddress("nowhere").catch(() => undefined)

		expect(transport.calls).toHaveLength(1)
	})

	it("refuses to persist a body that is not the expected envelope", async () => {
		const transport = stubTransport([{ body: { unexpected: true } }])

		await using client = createCensusGeocoderClient({ cacheDir, axios: transport.axios })

		await client.lookupAddress("anywhere").catch(() => undefined)

		expect((await readDirectory(cacheDir)).filter((name) => name.endsWith(".json"))).toHaveLength(0)
	})

	it("retries a 500 on the injected clock", async () => {
		const clock = createFakeClock()
		const transport = stubTransport([{ status: 500 }, { body: OK_BODY }])

		await using client = createCensusGeocoderClient({
			cacheDir,
			clock,
			baseRetryDelayMs: 500,
			axios: transport.axios,
		})

		const results = await client.lookupAddress("4600 Silver Hill Rd")

		expect(results).toHaveLength(1)
		expect(transport.calls).toHaveLength(2)
		expect(clock.sleepCalls).toContain(500)
	})

	it("spaces dispatches by the interval the configured rate implies", async () => {
		const clock = createFakeClock()
		const transport = stubTransport([{ body: OK_BODY }], { clock })

		await using client = createCensusGeocoderClient({
			cacheDir,
			clock,
			requestsPerMinute: 60,
			axios: transport.axios,
		})

		await Promise.all([client.lookupAddress("a"), client.lookupAddress("b"), client.lookupAddress("c")])

		expect(transport.dispatchTimes).toEqual([0, 1000, 2000])
	})
})

describe("isCacheableCensusBody", () => {
	it("accepts an envelope with matches", () => {
		expect(isCacheableCensusBody({ data: { data: OK_BODY } })).toBe(true)
	})

	it("accepts an EMPTY match list — a real, stable answer", () => {
		expect(isCacheableCensusBody({ data: { data: NO_MATCH_BODY } })).toBe(true)
	})

	it("rejects anything else", () => {
		expect(isCacheableCensusBody({ data: { data: { result: {} } } })).toBe(false)
		expect(isCacheableCensusBody({ data: { data: "<html>overloaded</html>" } })).toBe(false)
		expect(isCacheableCensusBody({ data: {} })).toBe(false)
	})
})
