/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { AddressInfo } from "node:net"

import express from "express"
import { expect, test } from "vitest"

import {
	createPhotonRouter,
	type PhotonEngine,
	photonForwardFeature,
	photonForwardProperties,
	photonOSMTags,
} from "./index.js"

const engine: PhotonEngine = {
	search: async () => ({ type: "FeatureCollection", features: [] }),
}

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

// #1014 — forward /api must decorate properties from the RESOLVED gazetteer place (proper-cased
// names + ancestry + country), not the parsed input span, and carry osm_key/osm_value/type so
// Photon client libs (leaflet-control-geocoder, @openrunner/photon-geocoder) don't TypeError.

test("forward: name/city from the RESOLVED gazetteer name, not the parsed span casing", () => {
	// The parse span was lowercase "paris"; the resolver's canonical name is "Paris".
	const props = photonForwardProperties({
		lat: 48.8566,
		lon: 2.3522,
		postcode: "75008",
		country: { name: "France", code: "FR" },
		places: [{ tag: "locality", name: "Paris" }],
	})
	expect(props.name).toBe("Paris")
	expect(props.city).toBe("Paris")
	expect(props.postcode).toBe("75008")
	expect(props.country).toBe("France")
	expect(props.countrycode).toBe("fr")
})

test("forward: always carries osm_key/osm_value/type (client TypeErrors without them — #1014 P0)", () => {
	// A city primary maps to place/city/city…
	const city = photonForwardProperties({ lat: 52.5, lon: 13.4, places: [{ tag: "locality", name: "Berlin" }] })
	expect(city.osm_key).toBe("place")
	expect(city.osm_value).toBe("city")
	expect(city.type).toBe("city")
	// …and even an unmapped/empty resolution still sets the fields (never undefined).
	const bare = photonForwardProperties({ lat: 0, lon: 0, places: [] })
	expect(bare.osm_key).toBeDefined()
	expect(bare.osm_value).toBeDefined()
	expect(bare.type).toBeDefined()
})

test("forward: fills the full admin ladder from resolved ancestry (parity with /reverse)", () => {
	const props = photonForwardProperties({
		lat: 38.9,
		lon: -77.0,
		country: { name: "United States", code: "US" },
		places: [
			{ tag: "locality", name: "Washington" },
			{ tag: "county", name: "District of Columbia" },
			{ tag: "region", name: "District of Columbia" },
			{ tag: "country", name: "United States" },
		],
	})
	expect(props.city).toBe("Washington")
	expect(props.county).toBe("District of Columbia")
	expect(props.state).toBe("District of Columbia")
	expect(props.country).toBe("United States")
	// name = the most-specific resolved place.
	expect(props.name).toBe("Washington")
	expect(props.type).toBe("city")
})

test("forward: a street-primary result names the street and types as street", () => {
	const props = photonForwardProperties({
		lat: 38.8977,
		lon: -77.0365,
		places: [
			{ tag: "street", name: "Pennsylvania Avenue Northwest" },
			{ tag: "locality", name: "Washington" },
		],
	})
	expect(props.name).toBe("Pennsylvania Avenue Northwest")
	expect(props.street).toBe("Pennsylvania Avenue Northwest")
	expect(props.city).toBe("Washington")
	expect(props.type).toBe("street")
})

test("photonOSMTags: maps place tiers to the Photon osm schema, with a safe fallback", () => {
	expect(photonOSMTags("locality")).toEqual({ osm_key: "place", osm_value: "city", type: "city" })
	expect(photonOSMTags("localadmin")).toEqual({ osm_key: "place", osm_value: "city", type: "city" }) // reverse placetype
	expect(photonOSMTags("region")).toEqual({ osm_key: "place", osm_value: "state", type: "state" })
	expect(photonOSMTags("country")).toEqual({ osm_key: "place", osm_value: "country", type: "country" })
	expect(photonOSMTags("whatever")).toEqual({ osm_key: "place", osm_value: "yes", type: "other" }) // unknown → fallback
})

test("contract: /api and /reverse derive the same osm tags for a place (#1014 checkbox 4)", () => {
	// The forward projection (primary=locality) and the /reverse path (deepest.placetype=locality) both go through
	// photonOSMTags, so they can't drift.
	const fwd = photonForwardProperties({ lat: 0, lon: 0, places: [{ tag: "locality", name: "X" }] })
	expect({ osm_key: fwd.osm_key, osm_value: fwd.osm_value, type: fwd.type }).toEqual(photonOSMTags("locality"))
})

test("photonForwardFeature: wraps properties as a Point Feature at [lon, lat]", () => {
	const f = photonForwardFeature({ lat: 52.5, lon: 13.4, places: [{ tag: "locality", name: "Berlin" }] })
	expect(f.type).toBe("Feature")
	expect(f.geometry).toEqual({ type: "Point", coordinates: [13.4, 52.5] })
	expect(f.properties.city).toBe("Berlin")
})

test("CORS: permissive Access-Control-Allow-Origin on responses (upstream Photon parity)", async () => {
	await withServer(express().use(createPhotonRouter(engine)), async (base) => {
		const res = await fetch(`${base}/api?q=berlin`)
		expect(res.headers.get("access-control-allow-origin")).toBe("*")
	})
})

test("CORS: preflight OPTIONS answers 204 with CORS headers", async () => {
	await withServer(express().use(createPhotonRouter(engine)), async (base) => {
		const res = await fetch(`${base}/api`, { method: "OPTIONS" })
		expect(res.status).toBe(204)
		expect(res.headers.get("access-control-allow-origin")).toBe("*")
		expect(res.headers.get("access-control-allow-methods")).toContain("GET")
	})
})

test("CORS: { cors: false } disables the headers (for a proxy that owns CORS)", async () => {
	await withServer(express().use(createPhotonRouter(engine, { cors: false })), async (base) => {
		const res = await fetch(`${base}/api?q=berlin`)
		expect(res.headers.get("access-control-allow-origin")).toBeNull()
	})
})
