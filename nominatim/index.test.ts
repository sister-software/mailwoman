/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { AddressInfo } from "node:net"

import type { SchemaOrgPlace } from "@mailwoman/annotations"
import express from "express"
import { expect, test } from "vitest"

import {
	createNominatimRouter,
	MAILWOMAN_LICENCE,
	type NominatimEngine,
	nominatimResultToSchemaOrg,
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
	await withServer(express().use(createNominatimRouter(jsonldEngine)), async (base) => {
		const res = await fetch(`${base}/search?q=1600+pennsylvania+ave&format=jsonld`)
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
})

test("route: /reverse?format=jsonld returns a single schema.org Place (#1052)", async () => {
	await withServer(express().use(createNominatimRouter(jsonldEngine)), async (base) => {
		const res = await fetch(`${base}/reverse?lat=38.8977&lon=-77.0365&format=jsonld`)
		expect(res.status).toBe(200)
		const place = (await res.json()) as SchemaOrgPlace
		expect(place["@context"]).toBe("https://schema.org")
		expect(place["@type"]).toBe("Place")
		expect(place.address?.addressLocality).toBe("Washington")
		expect(place.address?.addressCountry).toBe("US")
	})
})

const corsEngine: NominatimEngine = { status: async () => ({ status: 0, message: "OK" }) }

/** Boot the app on an ephemeral port, hand the base URL to `fn`, always close. */
async function withServer(app: express.Express, fn: (base: string) => Promise<void>): Promise<void> {
	const server = app.listen(0)
	await new Promise((resolve) => server.once("listening", resolve))
	const { port } = server.address() as AddressInfo

	try {
		await fn(`http://127.0.0.1:${port}`)
	} finally {
		await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
	}
}

test("CORS: permissive Access-Control-Allow-Origin on responses (browser clients)", async () => {
	await withServer(express().use(createNominatimRouter(corsEngine)), async (base) => {
		const res = await fetch(`${base}/status`)
		expect(res.headers.get("access-control-allow-origin")).toBe("*")
	})
})

test("CORS: preflight OPTIONS answers 204 with CORS headers", async () => {
	await withServer(express().use(createNominatimRouter(corsEngine)), async (base) => {
		const res = await fetch(`${base}/search`, { method: "OPTIONS" })
		expect(res.status).toBe(204)
		expect(res.headers.get("access-control-allow-origin")).toBe("*")
		expect(res.headers.get("access-control-allow-methods")).toContain("GET")
	})
})

test("CORS: { cors: false } disables the headers (for a proxy that owns CORS)", async () => {
	await withServer(express().use(createNominatimRouter(corsEngine, { cors: false })), async (base) => {
		const res = await fetch(`${base}/status`)
		expect(res.headers.get("access-control-allow-origin")).toBeNull()
	})
})

test("root: GET / serves a friendly HTML banner, not a bare 404 (#1022)", async () => {
	await withServer(express().use(createNominatimRouter(corsEngine)), async (base) => {
		const res = await fetch(`${base}/`)
		expect(res.status).toBe(200)
		expect(res.headers.get("content-type")).toContain("text/html")
		const body = await res.text()
		expect(body).toContain("@mailwoman/nominatim")
		expect(body).toContain("/search?q=") // a clickable example query
		expect(body).toContain("switching-from-nominatim") // docs pointer
	})
})
