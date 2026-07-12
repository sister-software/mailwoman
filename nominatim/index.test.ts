/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { SchemaOrgPlace } from "@mailwoman/annotations"
import { expect, test } from "vitest"

import {
	createNominatimApp,
	MAILWOMAN_LICENCE,
	type NominatimEngine,
	type NominatimLookupParams,
	nominatimResultToSchemaOrg,
	type NominatimSearchParams,
	type ResolvedAddress,
	toFeatureCollection,
	toNominatimResult,
} from "./index.ts"

const dc: ResolvedAddress = {
	lat: 38.8977,
	lon: -77.0365,
	address: {
		house_number: "1600",
		road: "Pennsylvania Ave NW",
		city: "Washington",
		state: "DC",
		postcode: "20500",
		country: "United States",
		country_code: "us",
	},
}

test("toFeatureCollection: wraps results as a GeoJSON FeatureCollection (geometry + bbox + properties)", () => {
	const r = toNominatimResult({ ...dc, boundingbox: ["38.89", "38.90", "-77.04", "-77.03"] })
	const fc = toFeatureCollection([r, { ...r, lat: null as never, lon: null as never }])

	expect(fc.type).toBe("FeatureCollection")
	// the row without a coordinate is dropped — a Feature needs a geometry.
	expect(fc.features).toHaveLength(1)
	const f = fc.features[0]!
	expect(f.type).toBe("Feature")
	expect(f.geometry).toEqual({ type: "Point", coordinates: [-77.0365, 38.8977] })
	// boundingbox [south, north, west, east] → GeoJSON bbox [west, south, east, north]
	expect(f.bbox).toEqual([-77.04, 38.89, -77.03, 38.9])
	// the coordinate + boundingbox move OUT of properties; the rest stays.
	expect(f.properties["display_name"]).toBeDefined()
	expect(f.properties["lat"]).toBeUndefined()
	expect(f.properties["boundingbox"]).toBeUndefined()
})

test("toNominatimResult: renders lat/lon as strings + a joined display_name + licence", () => {
	const r = toNominatimResult(dc)
	expect(r.lat).toBe("38.8977")
	expect(r.lon).toBe("-77.0365")
	expect(r.licence).toBe(MAILWOMAN_LICENCE)
	expect(r.display_name).toBe("1600, Pennsylvania Ave NW, Washington, DC, 20500, United States, us")
	expect(typeof r.place_id).toBe("number")
})

test("toNominatimResult: addressdetails gates the address block", () => {
	expect(toNominatimResult(dc).address).toBeUndefined()
	expect(toNominatimResult(dc, { addressdetails: true }).address).toEqual(dc.address)
})

test("toNominatimResult: an explicit displayName overrides the join", () => {
	expect(toNominatimResult({ ...dc, displayName: "The White House" }).display_name).toBe("The White House")
})

test("toNominatimResult: place_id is stable for the same input, distinct across inputs", () => {
	expect(toNominatimResult(dc).place_id).toBe(toNominatimResult(dc).place_id)
	expect(toNominatimResult(dc).place_id).not.toBe(toNominatimResult({ ...dc, lat: 0, lon: 0 }).place_id)
})

test("toNominatimResult: carries class/type/importance/boundingbox when present", () => {
	const r = toNominatimResult({
		...dc,
		category: "building",
		type: "government",
		importance: 0.8,
		boundingbox: ["38.89", "38.90", "-77.04", "-77.03"],
	})
	expect(r.class).toBe("building")
	expect(r.type).toBe("government")
	expect(r.importance).toBe(0.8)
	expect(r.boundingbox).toEqual(["38.89", "38.90", "-77.04", "-77.03"])
})

// #1052 — schema.org Place/PostalAddress/GeoCoordinates JSON-LD as an alternate output format (`format=jsonld`).

test("nominatimResultToSchemaOrg: projects a result's address into a schema.org Place (#1052)", () => {
	const place = nominatimResultToSchemaOrg(toNominatimResult(dc, { addressdetails: true }))

	expect(place["@context"]).toBe("https://schema.org")
	expect(place["@type"]).toBe("Place")
	expect(place.geo).toEqual({ "@type": "GeoCoordinates", latitude: 38.8977, longitude: -77.0365 })
	expect(place.address?.["@type"]).toBe("PostalAddress")
	expect(place.address?.streetAddress).toBe("1600 Pennsylvania Ave NW")
	expect(place.address?.addressLocality).toBe("Washington")
	expect(place.address?.addressRegion).toBe("DC")
	expect(place.address?.postalCode).toBe("20500")
	expect(place.address?.addressCountry).toBe("US") // country_code "us" → uppercased alpha-2
})

// Echoes params.addressdetails into the result so the route test also proves the router FORCES it for jsonld.
const jsonldEngine: NominatimEngine = {
	search: async (params) => [toNominatimResult(dc, { addressdetails: params.addressdetails })],
	reverse: async (params) => toNominatimResult(dc, { addressdetails: params.addressdetails }),
}

test("route: /search?format=jsonld returns schema.org Place[] and forces addressdetails (#1052)", async () => {
	const app = createNominatimApp(jsonldEngine)
	const res = await app.request("/search?q=1600+pennsylvania+ave&format=jsonld")
	expect(res.status).toBe(200)
	const body = (await res.json()) as SchemaOrgPlace[]
	expect(Array.isArray(body)).toBe(true)
	const place = body[0]!
	expect(place["@type"]).toBe("Place")
	// jsonld forced addressdetails on (the client did not pass it), so the PostalAddress is fully populated.
	expect(place.address?.streetAddress).toBe("1600 Pennsylvania Ave NW")
	expect(place.address?.addressLocality).toBe("Washington")
	expect(place.address?.addressCountry).toBe("US")
})

test("route: /reverse?format=jsonld returns a single schema.org Place (#1052)", async () => {
	const app = createNominatimApp(jsonldEngine)
	const res = await app.request("/reverse?lat=38.8977&lon=-77.0365&format=jsonld")
	expect(res.status).toBe(200)
	const place = (await res.json()) as SchemaOrgPlace
	expect(place["@context"]).toBe("https://schema.org")
	expect(place["@type"]).toBe("Place")
	expect(place.address?.addressLocality).toBe("Washington")
	expect(place.address?.addressCountry).toBe("US")
})

const corsEngine: NominatimEngine = { status: async () => ({ status: 0, message: "OK" }) }

test("CORS: permissive Access-Control-Allow-Origin on responses (browser clients)", async () => {
	const app = createNominatimApp(corsEngine)
	const res = await app.request("/status")
	expect(res.headers.get("access-control-allow-origin")).toBe("*")
})

test("CORS: preflight OPTIONS answers 204 with CORS headers", async () => {
	const app = createNominatimApp(corsEngine)
	const res = await app.request("/search", {
		method: "OPTIONS",
		headers: { origin: "https://example.com", "access-control-request-method": "GET" },
	})
	expect(res.status).toBe(204)
	expect(res.headers.get("access-control-allow-origin")).toBe("*")
	expect(res.headers.get("access-control-allow-methods")).toContain("GET")
})

test("CORS: { cors: false } disables the headers (for a proxy that owns CORS)", async () => {
	const app = createNominatimApp(corsEngine, { cors: false })
	const res = await app.request("/status")
	expect(res.headers.get("access-control-allow-origin")).toBeNull()
})

test("root: GET / serves a friendly HTML banner, not a bare 404 (#1022)", async () => {
	const app = createNominatimApp(corsEngine)
	const res = await app.request("/")
	expect(res.status).toBe(200)
	expect(res.headers.get("content-type")).toContain("text/html")
	const body = await res.text()
	expect(body).toContain("@mailwoman/nominatim")
	expect(body).toContain("/search?q=") // a clickable example query
	expect(body).toContain("switching-from-nominatim") // docs pointer
})

// Pinning tests — the four nominatim wrinkles (wire contract) + the parsing/error-envelope guarantees.

test("/status without an engine method answers 200 OK, not 501 (the one non-501 absent-method default)", async () => {
	const app = createNominatimApp({})
	const res = await app.request("/status")
	expect(res.status).toBe(200)
	expect(await res.json()).toEqual({ status: 0, message: "OK" })
})

test("absent engine methods answer the exact issue-ref 501 bodies", async () => {
	const app = createNominatimApp({})

	for (const [path, message] of [
		["/search?q=berlin", "search not implemented (see #802)"],
		["/reverse?lat=52.5&lon=13.4", "reverse not implemented (see #803)"],
		["/lookup?osm_ids=N1", "lookup not implemented (see #805)"],
	] as const) {
		const res = await app.request(path)
		expect(res.status).toBe(501)
		expect(await res.json()).toEqual({ error: message })
	}
})

test("unknown format falls back to jsonv2 (raw results array)", async () => {
	const app = createNominatimApp({ search: async () => [] })
	const res = await app.request("/search?q=berlin&format=xml")
	expect(res.status).toBe(200)
	expect(await res.json()).toEqual([])
})

test("format=jsonld forces addressdetails on search and reverse, but plain parseBool governs lookup", async () => {
	const seen: Array<boolean | undefined> = []
	const app = createNominatimApp({
		search: async (p) => {
			seen.push(p.addressdetails)

			return []
		},
		reverse: async (p) => {
			seen.push(p.addressdetails)

			return null
		},
		lookup: async (p) => {
			seen.push(p.addressdetails)

			return []
		},
	})

	await app.request("/search?q=x&format=jsonld")
	await app.request("/reverse?lat=1&lon=1&format=jsonld")
	await app.request("/lookup?osm_ids=N1&format=jsonld")
	expect(seen).toEqual([true, true, false])
})

test("reverse with a null engine result serializes null (jsonv2) and an empty FeatureCollection (geojson)", async () => {
	const app = createNominatimApp({ reverse: async () => null })

	const plain = await app.request("/reverse?lat=52.5&lon=13.4")
	expect(plain.status).toBe(200)
	expect(await plain.json()).toBeNull()

	const geo = await app.request("/reverse?lat=52.5&lon=13.4&format=geojson")
	expect(await geo.json()).toEqual({ type: "FeatureCollection", features: [] })
})

test("lookup has no jsonld branch — format=jsonld returns the raw results (legacy quirk preserved)", async () => {
	const results = [{ place_id: 1, licence: "L", lat: "1", lon: "2", display_name: "X" }]
	const app = createNominatimApp({ lookup: async () => results })
	const res = await app.request("/lookup?osm_ids=N1&format=jsonld")
	expect(await res.json()).toEqual(results)
})

test("repeated single-valued params are treated as absent (asString(array) → undefined; never a 400)", async () => {
	let seen: NominatimSearchParams | undefined
	const app = createNominatimApp({
		search: async (p) => {
			seen = p

			return []
		},
	})
	const res = await app.request("/search?q=berlin&q=paris&limit=5")
	expect(res.status).toBe(200)
	expect(seen?.q).toBeUndefined()
	expect(seen?.limit).toBe(5)
})

test("countrycodes and osm_ids comma-split; limit defaults to 10 on absent/invalid", async () => {
	const seenSearch: NominatimSearchParams[] = []
	const seenLookup: NominatimLookupParams[] = []
	const app = createNominatimApp({
		search: async (p) => {
			seenSearch.push(p)

			return []
		},
		lookup: async (p) => {
			seenLookup.push(p)

			return []
		},
	})

	await app.request("/search?q=x&countrycodes=de,fr")
	await app.request("/search?q=x&limit=abc")
	await app.request("/lookup?osm_ids=N1,W2,R3")
	expect(seenSearch[0]?.countrycodes).toEqual(["de", "fr"])
	expect(seenSearch[1]?.limit).toBe(10)
	expect(seenLookup[0]?.osmIds).toEqual(["N1", "W2", "R3"])
})

test("an engine fault answers the clean legacy 500 envelope", async () => {
	const app = createNominatimApp({
		search: async () => {
			throw new Error("resolver exploded")
		},
	})
	const res = await app.request("/search?q=x")
	expect(res.status).toBe(500)
	expect(await res.json()).toEqual({ error: "internal error" })
})

test("GET /openapi.json serves the emitted 3.1 document with all five paths", async () => {
	const app = createNominatimApp({})
	const res = await app.request("/openapi.json")
	const doc = (await res.json()) as { openapi: string; paths: Record<string, unknown> }
	expect(doc.openapi).toBe("3.1.0")
	expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining(["/", "/search", "/reverse", "/lookup", "/status"]))
})
