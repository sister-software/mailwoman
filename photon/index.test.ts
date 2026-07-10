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
	createPhotonRouter,
	photonFeature,
	photonFeatureToSchemaOrg,
	photonForwardCollection,
	photonForwardFeature,
	type PhotonForwardInput,
	photonForwardProperties,
	photonOSMTags,
	type PhotonEngine,
} from "./index.ts"

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

// #1041 — a rooftop / interpolated result must render HOUSE-GRADE. Upstream komoot/photon labels a bare
// residential address point `{osm_key:"place", osm_value:"house", type:"house", housenumber, street}` with NO
// `name` (verified against photon.komoot.io). Without this a rooftop inherits the admin ancestry's `type:city`
// and a client zooms to city scale on a doorstep match.

test("forward: a house-grade (rooftop) result decorates type:house + housenumber/street (#1041)", () => {
	const props = photonForwardProperties({
		lat: 48.8548,
		lon: 2.3451,
		postcode: "75001",
		country: { name: "France", code: "FR" },
		// The resolved ancestry is still locality→…; the `house` marker overrides the schema to house-grade.
		places: [{ tag: "locality", name: "Paris" }],
		house: { number: "8", street: "Boulevard du Palais" },
	})
	// Matches upstream komoot/photon's bare address point.
	expect(props.type).toBe("house")
	expect(props.osm_key).toBe("place")
	expect(props.osm_value).toBe("house")
	expect(props.housenumber).toBe("8")
	expect(props.street).toBe("Boulevard du Palais")
	// name is dropped (upstream has none for a bare address point; keeping the city here would double it in the
	// QGIS FLF label "Paris 8 Boulevard du Palais Paris 75001").
	expect(props.name).toBeUndefined()
	// The admin fields the ancestry filled are retained — a house result still carries city/postcode/country.
	expect(props.city).toBe("Paris")
	expect(props.postcode).toBe("75001")
	expect(props.country).toBe("France")
	expect(props.countrycode).toBe("fr")
})

test("forward: WITHOUT `house`, the same locality resolution stays type:city (no false rooftop) (#1041)", () => {
	const props = photonForwardProperties({ lat: 48.8566, lon: 2.3522, places: [{ tag: "locality", name: "Paris" }] })
	expect(props.type).toBe("city")
	expect(props.name).toBe("Paris")
	expect(props.housenumber).toBeUndefined()
	expect(props.street).toBeUndefined()
})

test("forward: house-grade with a missing parsed street/number still types house (fields just omitted) (#1041)", () => {
	const props = photonForwardProperties({
		lat: 48.8548,
		lon: 2.3451,
		places: [{ tag: "locality", name: "Paris" }],
		house: { number: "8", street: null },
	})
	expect(props.type).toBe("house")
	expect(props.housenumber).toBe("8")
	expect(props.street).toBeUndefined() // null street → field simply absent, never "null"
})

test("forward: street-grade re-tags highway/street with the FULL name in `name` (#1050)", () => {
	const props = photonForwardProperties({
		lat: 45.7655,
		lon: 4.8358,
		postcode: "69002",
		country: { name: "France", code: "FR" },
		places: [{ tag: "locality", name: "Lyon" }],
		street: { name: "Rue de la République" },
	})
	// Matches upstream komoot's street results (verified live 2026-07-10): full name in `name`,
	// highway osm_key, type street — never the locality's type:city / first-token truncation.
	expect(props.type).toBe("street")
	expect(props.osm_key).toBe("highway")
	expect(props.osm_value).toBe("residential")
	expect(props.name).toBe("Rue de la République")
	// Ancestry stays as context.
	expect(props.city).toBe("Lyon")
	expect(props.postcode).toBe("69002")
	expect(props.countrycode).toBe("fr")
})

test("forward: house wins over street when both are set (#1050)", () => {
	const props = photonForwardProperties({
		lat: 45.7655,
		lon: 4.8358,
		places: [{ tag: "locality", name: "Lyon" }],
		house: { number: "10", street: "Rue de la République" },
		street: { name: "Rue de la République" },
	})
	expect(props.type).toBe("house")
	expect(props.housenumber).toBe("10")
	expect(props.name).toBeUndefined()
})

test("photonForwardFeature: a house-grade input renders a type:house Point Feature (#1041)", () => {
	const f = photonForwardFeature({
		lat: 48.8548,
		lon: 2.3451,
		places: [{ tag: "locality", name: "Paris" }],
		house: { number: "8", street: "Boulevard du Palais" },
	})
	expect(f.geometry.coordinates).toEqual([2.3451, 48.8548])
	expect(f.properties.type).toBe("house")
	expect(f.properties.housenumber).toBe("8")
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

test("photonForwardCollection: primary first, then alternatives, capped at limit (#1016)", () => {
	const primary: PhotonForwardInput = { lat: 37.19, lon: -93.29, places: [{ tag: "locality", name: "Springfield" }] }
	const alternatives: PhotonForwardInput[] = [
		{ lat: 42.11, lon: -72.54, places: [{ tag: "locality", name: "Springfield" }] },
		{ lat: 39.77, lon: -89.65, places: [{ tag: "locality", name: "Springfield" }] },
	]
	const fc = photonForwardCollection({ primary, alternatives }, 2)
	expect(fc.features).toHaveLength(2) // capped at limit
	expect(fc.features[0]!.geometry.coordinates).toEqual([-93.29, 37.19]) // primary first
	expect(fc.features[1]!.geometry.coordinates).toEqual([-72.54, 42.11])
})

test("photonForwardCollection: limit≥available returns all; limit<1 floors to the single best", () => {
	const primary: PhotonForwardInput = { lat: 0, lon: 0, places: [{ tag: "locality", name: "A" }] }
	const alternatives: PhotonForwardInput[] = [{ lat: 1, lon: 1, places: [{ tag: "locality", name: "B" }] }]
	expect(photonForwardCollection({ primary, alternatives }, 10).features).toHaveLength(2)
	expect(photonForwardCollection({ primary, alternatives }, 0).features).toHaveLength(1)
})

test("photonForwardFeature: wraps properties as a Point Feature at [lon, lat]", () => {
	const f = photonForwardFeature({ lat: 52.5, lon: 13.4, places: [{ tag: "locality", name: "Berlin" }] })
	expect(f.type).toBe("Feature")
	expect(f.geometry).toEqual({ type: "Point", coordinates: [13.4, 52.5] })
	expect(f.properties.city).toBe("Berlin")
})

// #1052 — schema.org Place/PostalAddress/GeoCoordinates JSON-LD as an alternate output format (`format=jsonld`).

test("photonFeatureToSchemaOrg: projects a house feature into a schema.org Place (#1052)", () => {
	const feature = photonForwardFeature({
		lat: 48.8548,
		lon: 2.3451,
		postcode: "75001",
		country: { name: "France", code: "FR" },
		places: [{ tag: "locality", name: "Paris" }],
		house: { number: "8", street: "Boulevard du Palais" },
	})
	const place = photonFeatureToSchemaOrg(feature)

	expect(place["@context"]).toBe("https://schema.org")
	expect(place["@type"]).toBe("Place")
	expect(place.geo).toEqual({ "@type": "GeoCoordinates", latitude: 48.8548, longitude: 2.3451 })
	expect(place.address?.["@type"]).toBe("PostalAddress")
	expect(place.address?.streetAddress).toBe("8 Boulevard du Palais")
	expect(place.address?.addressLocality).toBe("Paris")
	expect(place.address?.postalCode).toBe("75001")
	expect(place.address?.addressCountry).toBe("FR") // ISO-3166 alpha-2, uppercased
})

const jsonldEngine: PhotonEngine = {
	search: async () =>
		photonForwardCollection(
			{
				primary: {
					lat: 48.8548,
					lon: 2.3451,
					postcode: "75001",
					country: { name: "France", code: "FR" },
					places: [{ tag: "locality", name: "Paris" }],
					house: { number: "8", street: "Boulevard du Palais" },
				},
				alternatives: [],
			},
			1
		),
	reverse: async () => ({
		type: "FeatureCollection",
		features: [
			photonFeature(2.3522, 48.8566, {
				osm_key: "place",
				osm_value: "city",
				type: "city",
				name: "Paris",
				city: "Paris",
				countrycode: "fr",
			}),
		],
	}),
}

test("route: /reverse?format=jsonld returns schema.org Place[] JSON-LD (#1052)", async () => {
	await withServer(express().use(createPhotonRouter(jsonldEngine)), async (base) => {
		const res = await fetch(`${base}/reverse?lat=48.8566&lon=2.3522&format=jsonld`)
		expect(res.status).toBe(200)
		const body = (await res.json()) as SchemaOrgPlace[]
		expect(Array.isArray(body)).toBe(true)
		const place = body[0]!
		expect(place["@context"]).toBe("https://schema.org")
		expect(place["@type"]).toBe("Place")
		expect(place.name).toBe("Paris")
		expect(place.address?.addressLocality).toBe("Paris")
		expect(place.address?.addressCountry).toBe("FR")
	})
})

test("route: /api?format=jsonld returns schema.org Place[] JSON-LD; default stays GeoJSON (#1052)", async () => {
	await withServer(express().use(createPhotonRouter(jsonldEngine)), async (base) => {
		const res = await fetch(`${base}/api?q=8+boulevard+du+palais&format=jsonld`)
		expect(res.status).toBe(200)
		const body = (await res.json()) as SchemaOrgPlace[]
		expect(Array.isArray(body)).toBe(true)
		const place = body[0]!
		expect(place["@context"]).toBe("https://schema.org")
		expect(place["@type"]).toBe("Place")
		expect(place.address?.["@type"]).toBe("PostalAddress")
		expect(place.address?.streetAddress).toBe("8 Boulevard du Palais")
		expect(place.address?.addressCountry).toBe("FR")
		expect(place.geo?.latitude).toBeCloseTo(48.8548)

		// The native GeoJSON FeatureCollection stays the default (no format param).
		const def = (await (await fetch(`${base}/api?q=x`)).json()) as { type: string }
		expect(def.type).toBe("FeatureCollection")
	})
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

test("root: GET / serves a friendly HTML banner, not a bare 404 (#1022)", async () => {
	await withServer(express().use(createPhotonRouter(engine)), async (base) => {
		const res = await fetch(`${base}/`)
		expect(res.status).toBe(200)
		expect(res.headers.get("content-type")).toContain("text/html")
		const body = await res.text()
		expect(body).toContain("@mailwoman/photon")
		expect(body).toContain("/api?q=") // a clickable example query
		expect(body).toContain("switching-from-photon") // docs pointer
	})
})
