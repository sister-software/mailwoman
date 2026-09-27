import type { SchemaOrgPlace } from "@mailwoman/annotations"
import { buildEngineStamp, type EngineStamp } from "@mailwoman/core/license"
import {
	createPhotonApp,
	photonFeature,
	photonFeatureToSchemaOrg,
	photonForwardCollection,
	photonForwardFeature,
	type PhotonEngine,
	type PhotonForwardInput,
	photonForwardProperties,
	photonOSMTags,
	type PhotonSearchParams,
} from "@mailwoman/photon"
import { expect, test } from "vitest"

const searchEngine: PhotonEngine = {
	search: async () => ({ type: "FeatureCollection", features: [] }),
}

const reverseEngine: PhotonEngine = {
	reverse: async () => ({ type: "FeatureCollection", features: [] }),
}

test("forward: name/city from the RESOLVED gazetteer name, not the parsed span casing", () => {
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

test("Forward: always carries osm_key/osm_value/type (client TypeErrors without them — P0)", () => {
	const city = photonForwardProperties({ lat: 52.5, lon: 13.4, places: [{ tag: "locality", name: "Berlin" }] })
	expect(city.osm_key).toBe("place")
	expect(city.osm_value).toBe("city")
	expect(city.type).toBe("city")

	const bare = photonForwardProperties({ lat: 0, lon: 0, places: [] })
	expect(bare.osm_key).toBeDefined()
	expect(bare.osm_value).toBeDefined()
	expect(bare.type).toBeDefined()
})

test("forward: fills the full admin ladder from resolved ancestry (parity with /reverse)", () => {
	const props = photonForwardProperties({
		lat: 38.9,
		lon: -77,
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

test("Forward: a house-grade (rooftop) result decorates type:house + housenumber/street", () => {
	const props = photonForwardProperties({
		lat: 48.8548,
		lon: 2.3451,
		postcode: "75001",
		country: { name: "France", code: "FR" },

		places: [{ tag: "locality", name: "Paris" }],
		house: { number: "8", street: "Boulevard du Palais" },
	})

	expect(props.type).toBe("house")
	expect(props.osm_key).toBe("place")
	expect(props.osm_value).toBe("house")
	expect(props.housenumber).toBe("8")
	expect(props.street).toBe("Boulevard du Palais")

	expect(props.name).toBeUndefined()

	expect(props.city).toBe("Paris")
	expect(props.postcode).toBe("75001")
	expect(props.country).toBe("France")
	expect(props.countrycode).toBe("fr")
})

test("Forward: WITHOUT `house`, the same locality resolution stays type:city (no false rooftop)", () => {
	const props = photonForwardProperties({ lat: 48.8566, lon: 2.3522, places: [{ tag: "locality", name: "Paris" }] })
	expect(props.type).toBe("city")
	expect(props.name).toBe("Paris")
	expect(props.housenumber).toBeUndefined()
	expect(props.street).toBeUndefined()
})

test("Forward: house-grade with a missing parsed street/number still types house (fields just omitted)", () => {
	const props = photonForwardProperties({
		lat: 48.8548,
		lon: 2.3451,
		places: [{ tag: "locality", name: "Paris" }],
		house: { number: "8", street: null },
	})

	expect(props.type).toBe("house")
	expect(props.housenumber).toBe("8")
	expect(props.street).toBeUndefined()
})

test("Forward: street-grade re-tags highway/street with the FULL name in `name`", () => {
	const props = photonForwardProperties({
		lat: 45.7655,
		lon: 4.8358,
		postcode: "69002",
		country: { name: "France", code: "FR" },
		places: [{ tag: "locality", name: "Lyon" }],
		street: { name: "Rue de la République" },
	})

	expect(props.type).toBe("street")
	expect(props.osm_key).toBe("highway")
	expect(props.osm_value).toBe("residential")
	expect(props.name).toBe("Rue de la République")

	expect(props.city).toBe("Lyon")
	expect(props.postcode).toBe("69002")
	expect(props.countrycode).toBe("fr")
})

test("Forward: house wins over street when both are set", () => {
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

test("PhotonForwardFeature: a house-grade input renders a type:house Point Feature", () => {
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

	expect(photonOSMTags("localadmin")).toEqual({ osm_key: "place", osm_value: "city", type: "city" })
	expect(photonOSMTags("region")).toEqual({ osm_key: "place", osm_value: "state", type: "state" })
	expect(photonOSMTags("country")).toEqual({ osm_key: "place", osm_value: "country", type: "country" })
	expect(photonOSMTags("whatever")).toEqual({ osm_key: "place", osm_value: "yes", type: "other" })
})

test("PhotonOSMTags: every /reverse descent tier has a projection ( close-out)", () => {
	const descentTiers = ["county", "localadmin", "locality", "borough", "neighbourhood", "microhood"]

	for (const tier of descentTiers) {
		expect(photonOSMTags(tier), tier).not.toEqual({ osm_key: "place", osm_value: "yes", type: "other" })
	}

	expect(photonOSMTags("microhood")).toEqual({ osm_key: "place", osm_value: "neighbourhood", type: "district" })
})

test("Interface: /api and /reverse derive the same osm tags for a place ( checkbox 4)", () => {
	const fwd = photonForwardProperties({ lat: 0, lon: 0, places: [{ tag: "locality", name: "X" }] })
	expect({ osm_key: fwd.osm_key, osm_value: fwd.osm_value, type: fwd.type }).toEqual(photonOSMTags("locality"))
})

test("PhotonForwardCollection: primary first, then alternatives, capped at limit", () => {
	const primary: PhotonForwardInput = { lat: 37.19, lon: -93.29, places: [{ tag: "locality", name: "Springfield" }] }

	const alternatives: PhotonForwardInput[] = [
		{ lat: 42.11, lon: -72.54, places: [{ tag: "locality", name: "Springfield" }] },
		{ lat: 39.77, lon: -89.65, places: [{ tag: "locality", name: "Springfield" }] },
	]

	const fc = photonForwardCollection({ primary, alternatives }, 2)
	expect(fc.features).toHaveLength(2)
	expect(fc.features[0]!.geometry.coordinates).toEqual([-93.29, 37.19])
	expect(fc.features[1]!.geometry.coordinates).toEqual([-72.54, 42.11])
})

test("photonForwardCollection: limit≥available returns all; limit<1 floors to the single best", () => {
	const primary: PhotonForwardInput = { lat: 0, lon: 0, places: [{ tag: "locality", name: "A" }] }
	const alternatives: PhotonForwardInput[] = [{ lat: 1, lon: 1, places: [{ tag: "locality", name: "B" }] }]
	expect(photonForwardCollection({ primary, alternatives }, 10).features).toHaveLength(2)
	expect(photonForwardCollection({ primary, alternatives }, 0).features).toHaveLength(1)
})

test("PhotonForwardFeature: wraps properties as a Point Feature at [lon, lat]", () => {
	const f = photonForwardFeature({ lat: 52.5, lon: 13.4, places: [{ tag: "locality", name: "Berlin" }] })
	expect(f.type).toBe("Feature")
	expect(f.geometry).toEqual({ type: "Point", coordinates: [13.4, 52.5] })
	expect(f.properties.city).toBe("Berlin")
})

test("PhotonFeatureToSchemaOrg: projects a house feature into a schema.org Place", () => {
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
	expect(place.address?.addressCountry).toBe("FR")
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

test("Route: /reverse?format=jsonld returns schema.org Place[] JSON-LD", async () => {
	const app = createPhotonApp(jsonldEngine)
	const res = await app.request("/reverse?lat=48.8566&lon=2.3522&format=jsonld")
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

test("Route: /api?format=jsonld returns schema.org Place[] JSON-LD; default stays GeoJSON", async () => {
	const app = createPhotonApp(jsonldEngine)
	const res = await app.request("/api?q=8+boulevard+du+palais&format=jsonld")
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

	const def = (await (await app.request("/api?q=x")).json()) as { type: string }
	expect(def.type).toBe("FeatureCollection")
})

test("CORS: permissive Access-Control-Allow-Origin on responses (upstream Photon parity)", async () => {
	const app = createPhotonApp(searchEngine)
	const res = await app.request("/api?q=berlin")
	expect(res.headers.get("access-control-allow-origin")).toBe("*")
})

test("CORS: preflight OPTIONS answers 204 with CORS headers", async () => {
	const app = createPhotonApp(searchEngine)

	const res = await app.request("/api", {
		method: "OPTIONS",
		headers: { origin: "https://example.com", "access-control-request-method": "GET" },
	})

	expect(res.status).toBe(204)
	expect(res.headers.get("access-control-allow-origin")).toBe("*")
	expect(res.headers.get("access-control-allow-methods")).toContain("GET")
})

test("CORS: { cors: false } disables the headers (for a proxy that owns CORS)", async () => {
	const app = createPhotonApp(searchEngine, { cors: false })
	const res = await app.request("/api?q=berlin")
	expect(res.headers.get("access-control-allow-origin")).toBeNull()
})

test("Root: GET / serves a friendly HTML banner, not a bare 404", async () => {
	const app = createPhotonApp(searchEngine)
	const res = await app.request("/")
	expect(res.status).toBe(200)
	expect(res.headers.get("content-type")).toContain("text/html")
	const body = await res.text()
	expect(body).toContain("@mailwoman/photon")
	expect(body).toContain("/api?q=")
	expect(body).toContain("what-mailwoman-is")
})

test("Repeated q answers the legacy 400 envelope (express array shape preserved)", async () => {
	const app = createPhotonApp(searchEngine)
	const res = await app.request("/api?q=berlin&q=paris")
	expect(res.status).toBe(400)
	expect(await res.json()).toEqual({ type: "FeatureCollection", features: [], message: "q is required" })
})

test("Repeated lat on /reverse answers the legacy 400 (Number(array) is NaN)", async () => {
	const app = createPhotonApp(reverseEngine)
	const res = await app.request("/reverse?lat=52.5&lat=52.6&lon=13.4")
	expect(res.status).toBe(400)
	expect(await res.json()).toEqual({ type: "FeatureCollection", features: [], message: "lat and lon are required" })
})

test("Repeated osm_tag and layer reach the engine as arrays (contractual repeatable params)", async () => {
	let seen: PhotonSearchParams | undefined

	const app = createPhotonApp({
		search: async (params) => {
			seen = params

			return { type: "FeatureCollection", features: [] }
		},
	})

	const res = await app.request("/api?q=berlin&osm_tag=place:city&osm_tag=place:town&layer=city&layer=locality")
	expect(res.status).toBe(200)
	expect(seen?.osmTag).toEqual(["place:city", "place:town"])
	expect(seen?.layer).toEqual(["city", "locality"])
})

test("Limit falls back to 15 on absent, non-numeric, and zero values (legacy Number(x) || 15)", async () => {
	const seen: number[] = []

	const app = createPhotonApp({
		search: async (params) => {
			seen.push(params.limit)

			return { type: "FeatureCollection", features: [] }
		},
	})

	for (const suffix of ["", "&limit=abc", "&limit=0"]) {
		await app.request(`/api?q=berlin${suffix}`)
	}

	expect(seen).toEqual([15, 15, 15])
})

test("Non-numeric bias lat/lon on /api is tolerated (soft bias — NaN reaches the engine without 400)", async () => {
	let seen: PhotonSearchParams | undefined

	const app = createPhotonApp({
		search: async (params) => {
			seen = params

			return { type: "FeatureCollection", features: [] }
		},
	})

	const res = await app.request("/api?q=berlin&lat=abc&lon=13.4")
	expect(res.status).toBe(200)
	expect(Number.isNaN(seen?.lat)).toBe(true)
})

test("out-of-range /reverse coordinates answer the exact range 400", async () => {
	const app = createPhotonApp(reverseEngine)
	const res = await app.request("/reverse?lat=91&lon=13.4")
	expect(res.status).toBe(400)

	expect(await res.json()).toEqual({
		type: "FeatureCollection",
		features: [],
		message: "lat must be in [-90, 90] and lon in [-180, 180]",
	})
})

test("GET /openapi.json serves the emitted 3.1 document", async () => {
	const app = createPhotonApp(searchEngine)
	const res = await app.request("/openapi.json")
	expect(res.status).toBe(200)
	const doc = (await res.json()) as { openapi: string; paths: Record<string, unknown> }
	expect(doc.openapi).toBe("3.1.0")
	expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining(["/", "/api", "/reverse"]))
})

test("An engine fault answers the clean legacy 500 envelope, never a crash", async () => {
	const app = createPhotonApp({
		search: async () => {
			throw new Error("resolver exploded")
		},
	})

	const res = await app.request("/api?q=berlin")
	expect(res.status).toBe(500)
	expect(await res.json()).toEqual({ type: "FeatureCollection", features: [], message: "internal error" })
})

test("Absent engine methods answer the exact legacy 501 envelopes", async () => {
	const app = createPhotonApp({})

	const search = await app.request("/api?q=berlin")
	expect(search.status).toBe(501)
	expect(await search.json()).toEqual({ type: "FeatureCollection", features: [], message: "search not implemented" })

	const reverse = await app.request("/reverse?lat=52.5&lon=13.4")
	expect(reverse.status).toBe(501)

	expect(await reverse.json()).toEqual({
		type: "FeatureCollection",
		features: [],
		message: "reverse not implemented",
	})
})

const stamp = buildEngineStamp({ version: "9.2.0", expression: "AGPL-3.0-only OR LicenseRef-Commercial" })

test("engine option: the FeatureCollection carries `engine` as a foreign member; features and jsonld are unchanged", async () => {
	const app = createPhotonApp(jsonldEngine, { engine: stamp })
	const res = await app.request("/api?q=berlin")

	expect(res.headers.get("server")).toBe("mailwoman/9.2.0 (AGPL-3.0-only)")

	const body = (await res.json()) as { type: string; engine: EngineStamp; features: object[] }

	expect(body.type).toBe("FeatureCollection")
	expect(body.engine).toEqual(stamp)
	expect(body.features.length).toBeGreaterThan(0)

	for (const f of body.features) {
		expect(f).not.toHaveProperty("engine")
	}

	const reverse = (await (await app.request("/reverse?lat=52.52&lon=13.405")).json()) as { engine: EngineStamp }

	expect(reverse.engine).toEqual(stamp)

	const jsonld = (await (await app.request("/api?q=berlin&format=jsonld")).json()) as object[]

	for (const place of jsonld) {
		expect(place).not.toHaveProperty("engine")
	}
})

test("no engine option: the collection has no `engine` member and no headers", async () => {
	const res = await createPhotonApp(jsonldEngine).request("/api?q=berlin")

	expect(res.headers.get("server")).toBeNull()
	expect((await res.json()) as object).not.toHaveProperty("engine")
})
