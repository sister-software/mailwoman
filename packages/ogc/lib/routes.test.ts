// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, test } from "vitest"

import {
	buildLandingPage,
	createOGCApp,
	OGC_DOC_INFO,
	type OGCCollection,
	OGCCollectionID,
	type OGCCollections,
	type OGCConformance,
	OGCConformanceClass,
	type OGCEngine,
	OGCFormat,
	type OGCItem,
	type OGCItemFeature,
	type OGCItemSource,
	type OGCItemsResponse,
	type OGCLayerTerms,
	OGC_ITEMS_MAX_LIMIT,
	type OGCLandingPage,
	OGCLinkRelation,
	OGCMediaType,
	type OGCSearchHit,
	type OGCSearchResponse,
	searchBoxContains,
} from "#index"

/**
 * The address the stub engine answers, and the matches it answers with.
 */
const DAM_1 = "Dam 1, 1012JS Amsterdam"

const DAM_1_HITS: OGCSearchHit[] = [
	{
		collectionID: OGCCollectionID.Addresses,
		lon: 4.8932,
		lat: 52.3731,
		displayName: "Dam 1, 1012 JS Amsterdam, Netherlands",
		score: null,
		scoreUnmeasured: "unrecorded",
	},
	{
		collectionID: OGCCollectionID.Places,
		lon: 4.8897,
		lat: 52.374,
		displayName: "Amsterdam, Netherlands",
		score: -5.94,
		placeID: "wof:101751893",
		placetype: "locality",
	},
	{
		collectionID: OGCCollectionID.Places,
		lon: -74.188,
		lat: 42.938,
		displayName: "Amsterdam, United States",
		score: -4.25,
	},
]

/**
 * The places the stub `places` collection serves: a 60-place grid south of Amsterdam's box,
 * then the locality `/search` answers, in ascending id order.
 */
const PLACES: OGCItem[] = [
	...Array.from({ length: 60 }, (_, index) => ({
		wofID: 1000 + index * 7,
		name: `Place ${index}`,
		placetype: "locality",
		countryCode: "NL",
		lon: 3.5 + (index % 10) * 0.3,
		lat: 50 + Math.floor(index / 10) * 0.3,
		displayName: `Place ${index}, Netherlands`,
	})),
	{
		wofID: 101_751_893,
		name: "Amsterdam",
		placetype: "locality",
		countryCode: "NL",
		lon: 4.8897,
		lat: 52.374,
		displayName: "Amsterdam, Netherlands",
	},
]

/**
 * An item source over {@link PLACES} that answers a page as the gazetteer reader does.
 */
const PLACE_ITEMS: OGCItemSource = {
	async page({ bbox, after, limit }) {
		return PLACES.filter((place) => after == null || place.wofID > after)
			.filter((place) => !bbox || searchBoxContains(bbox, place.lon, place.lat))
			.slice(0, limit)
	},
	async item(wofID) {
		return PLACES.find((place) => place.wofID === wofID) ?? null
	},
}

/**
 * A stub admin gazetteer manifest, in the shape the admin build writes.
 */
const ADMIN_LAYER: OGCLayerTerms = {
	name: "admin-global-priority",
	license: "LicenseRef-WhosOnFirst-Mixed AND ODbL-1.0 AND CC-BY-4.0",
	attribution: "whosonfirst, overture-divisions, geonames",
	source: "whosonfirst+overture-divisions+geonames",
}

/**
 * A stub candidate gazetteer manifest.
 * Its source is the admin layer by name and version.
 */
const CANDIDATE_LAYER: OGCLayerTerms = {
	name: "candidate",
	license: "CC-BY-4.0 AND LicenseRef-Undeclared-Input",
	attribution: null,
	source: "admin-global-priority@2026-11-18",
}

const engine: OGCEngine = {
	collections: [
		{ id: OGCCollectionID.Addresses, regions: ["NL"] },
		{ id: OGCCollectionID.Places, regions: null, items: PLACE_ITEMS, layers: [CANDIDATE_LAYER, ADMIN_LAYER] },
		{ id: OGCCollectionID.PlusCodes, regions: null, layers: [] },
	],
	search: async (q) => (q === DAM_1 ? DAM_1_HITS : []),
}

const app = createOGCApp(engine, { serveItems: true })

async function search(query: string): Promise<OGCSearchResponse> {
	const response = await app.request(`/search?${query}`)

	expect(response.status, query).toBe(200)
	expect(contentTypeOf(response)).toContain(OGCMediaType.GeoJSON)

	return (await response.json()) as OGCSearchResponse
}

const DAM_1_QUERY = `q=${encodeURIComponent(DAM_1)}`

function contentTypeOf(response: Response): string {
	return response.headers.get("content-type") ?? ""
}

async function landingPage(): Promise<OGCLandingPage> {
	const response = await app.request("/?f=json")

	expect(response.status).toBe(200)

	return (await response.json()) as OGCLandingPage
}

/**
 * Field names OpenAPI 3.1 added and the 3.0 schema refuses.
 */
const OPENAPI_31_ONLY_KEYS = new Set(["identifier", "jsonSchemaDialect", "webhooks", "prefixItems", "const"])

function openAPI31OnlyPaths(node: unknown, path = ""): string[] {
	if (Array.isArray(node)) return node.flatMap((item, index) => openAPI31OnlyPaths(item, `${path}/${index}`))

	if (node == null || typeof node !== "object") return []

	return Object.entries(node).flatMap(([key, value]) => {
		const here = `${path}/${key}`
		const own = OPENAPI_31_ONLY_KEYS.has(key) || (key === "type" && Array.isArray(value)) ? [here] : []

		return [...own, ...openAPI31OnlyPaths(value, here)]
	})
}

describe("landing page", () => {
	test("links the API definition and the conformance declaration under the relations OGC clients read", async () => {
		const rels = new Set((await landingPage()).links.map((link) => link.rel))

		for (const rel of [
			OGCLinkRelation.Self,
			OGCLinkRelation.Alternate,
			OGCLinkRelation.ServiceDesc,
			OGCLinkRelation.ServiceDoc,
			OGCLinkRelation.Conformance,
			OGCLinkRelation.OGCConformance,
		]) {
			expect(rels, rel).toContain(rel)
		}
	})

	test("every link resolves to 200 with the media type it declares", async () => {
		for (const link of (await landingPage()).links) {
			const response = await app.request(link.href)

			expect(response.status, link.href).toBe(200)
			expect(contentTypeOf(response), link.href).toContain(link.type)
		}
	})

	test("the HTML encoding carries every link as an <a> element", async () => {
		const response = await app.request("/?f=html")
		const html = await response.text()

		expect(contentTypeOf(response)).toContain(OGCMediaType.HTML)

		// The HTML page's self link is the HTML form, so its links are the landing page built for HTML.
		for (const link of buildLandingPage("http://localhost", OGC_DOC_INFO, OGCFormat.HTML).links) {
			expect(html, link.href).toContain(`href="${link.href.replaceAll("&", "&amp;")}"`)
		}
	})

	test("link hrefs resolve under a configured base URL", async () => {
		const proxied = createOGCApp(engine, { baseURL: "https://example.org/ogc/" })
		const landing = (await (await proxied.request("/?f=json")).json()) as OGCLandingPage

		for (const link of landing.links) {
			expect(link.href.startsWith("https://example.org/ogc/"), link.href).toBe(true)
		}
	})
})

describe("content negotiation", () => {
	test("an Accept header asking for HTML gets HTML when f is absent, and f overrides it", async () => {
		const html = await app.request("/conformance", { headers: { Accept: "text/html,*/*;q=0.8" } })
		const json = await app.request("/conformance?f=json", { headers: { Accept: "text/html" } })

		expect(contentTypeOf(html)).toContain(OGCMediaType.HTML)
		expect(contentTypeOf(json)).toContain(OGCMediaType.JSON)
	})
})

describe("search", () => {
	test("an exact address returns the engine's matches as features with their scores and collections", async () => {
		const body = await search(DAM_1_QUERY)

		expect(body.type).toBe("FeatureCollection")
		expect(body.numberReturned).toBe(body.features.length)
		expect(Number.isNaN(Date.parse(body.timeStamp))).toBe(false)
		expect(body.links.map((link) => link.rel)).toEqual([OGCLinkRelation.Self, OGCLinkRelation.Alternate])

		expect(body.features[0]).toEqual({
			type: "Feature",
			geometry: { type: "Point", coordinates: [4.8932, 52.3731] },
			properties: {
				display_name: "Dam 1, 1012 JS Amsterdam, Netherlands",
				score: null,
				score_unmeasured: "unrecorded",
				collection_id: OGCCollectionID.Addresses,
			},
		})

		expect(body.features[1]?.properties).toEqual({
			display_name: "Amsterdam, Netherlands",
			score: -5.94,
			collection_id: OGCCollectionID.Places,
			place_id: "wof:101751893",
			placetype: "locality",
			href: "http://localhost/collections/places/items/wof%3A101751893?f=json",
		})
	})

	test("a place hit links its item, and the link answers with the same place", async () => {
		const [, amsterdam, unlinked] = (await search(DAM_1_QUERY)).features

		// The third hit is a place without a place ID, so it has no item to link.
		expect(unlinked?.properties.href).toBeUndefined()

		const response = await app.request(amsterdam!.properties.href!)
		const feature = (await response.json()) as OGCItemFeature

		expect(response.status).toBe(200)
		expect(feature.id).toBe(amsterdam!.properties.place_id)
		expect(feature.properties.display_name).toBe(amsterdam!.properties.display_name)
	})

	test("a query the engine has no match for returns 200 with no features", async () => {
		const body = await search("q=nowhere")

		expect(body.features).toEqual([])
		expect(body.numberReturned).toBe(0)
	})

	test("a collection parameter restricts the matches to the named collections", async () => {
		const body = await search(`${DAM_1_QUERY}&places[version]=1&places[relevance]=0.5`)

		expect(body.features.length).toBeGreaterThan(0)
		expect(body.features.every((feature) => feature.properties.collection_id === OGCCollectionID.Places)).toBe(true)
	})

	test("bbox keeps only the features whose point lies inside it, and limit caps the rest", async () => {
		const europe = await search(`${DAM_1_QUERY}&bbox=-10,35,30,60`)

		expect(europe.features.map((feature) => feature.properties.display_name)).toEqual([
			"Dam 1, 1012 JS Amsterdam, Netherlands",
			"Amsterdam, Netherlands",
		])

		expect((await search(`${DAM_1_QUERY}&limit=1`)).features).toHaveLength(1)
	})

	test("a request that is missing q, or carries a malformed or unknown parameter, returns 400", async () => {
		for (const query of [
			"",
			"q=%20",
			`${DAM_1_QUERY}&bbox=1,2,3`,
			`${DAM_1_QUERY}&bbox=1,2,3,north`,
			`${DAM_1_QUERY}&bbox=200,0,210,10`,
			`${DAM_1_QUERY}&limit=0`,
			`${DAM_1_QUERY}&places[version]=2`,
			`${DAM_1_QUERY}&places[relevance]=2`,
			`${DAM_1_QUERY}&streets[version]=1`,
			`${DAM_1_QUERY}&unknown=1`,
		]) {
			const response = await app.request(`/search?${query}`)

			expect(response.status, query).toBe(400)
			expect(await response.json(), query).toMatchObject({ error: "invalid query parameter" })
		}
	})

	test("the HTML form answers without a query, and the results page lists every feature", async () => {
		const form = await app.request("/search?f=html")
		const results = await (await app.request(`/search?${DAM_1_QUERY}&f=html`)).text()

		expect(form.status).toBe(200)
		expect(await form.text()).toContain('<form method="get" action="search">')

		for (const hit of DAM_1_HITS) {
			expect(results).toContain(hit.displayName)
		}
	})
})

describe("collections", () => {
	test("an unknown collection id returns 404 in the native error form", async () => {
		const response = await app.request("/collections/streets")

		expect(response.status).toBe(404)
		expect(await response.json()).toMatchObject({ error: "collection not found" })
	})
})

async function items(path: string): Promise<OGCItemsResponse> {
	const response = await app.request(path)

	expect(response.status, path).toBe(200)
	expect(contentTypeOf(response), path).toContain(OGCMediaType.GeoJSON)

	return (await response.json()) as OGCItemsResponse
}

function nextHref(body: OGCItemsResponse): string | undefined {
	return body.links.find((link) => link.rel === OGCLinkRelation.Next)?.href
}

describe("items", () => {
	test("following next links visits every place once, in id order, and the last page has no next link", async () => {
		const seen: string[] = []
		let href: string | undefined = "/collections/places/items?limit=7"

		while (href) {
			const body = await items(href)

			expect(body.numberReturned).toBe(body.features.length)
			expect(Number.isNaN(Date.parse(body.timeStamp))).toBe(false)
			seen.push(...body.features.map((feature) => feature.id))
			href = nextHref(body)
		}

		expect(seen).toEqual(PLACES.map((place) => `wof:${place.wofID}`))
	})

	test("bbox keeps only places whose point lies inside it, and a box that holds none returns 200 with no features", async () => {
		const amsterdam = await items("/collections/places/items?bbox=4.7,52.2,5.1,52.5")
		const empty = await items("/collections/places/items?bbox=100,10,101,11")
		const withHeight = await items("/collections/places/items?bbox=4.7,52.2,-10,5.1,52.5,10")

		expect(amsterdam.features.map((feature) => feature.id)).toEqual(["wof:101751893"])
		expect(withHeight.features).toEqual(amsterdam.features)
		expect(empty.features).toEqual([])
		expect(empty.numberReturned).toBe(0)
		expect(nextHref(empty)).toBeUndefined()
	})

	test("a limit above the maximum is served as the maximum rather than refused", async () => {
		const requested: number[] = []

		const capped = createOGCApp(
			{
				...engine,
				collections: [
					{
						id: OGCCollectionID.Places,
						regions: null,
						items: {
							...PLACE_ITEMS,
							page: async (request) => (requested.push(request.limit), PLACE_ITEMS.page(request)),
						},
					},
				],
			},
			{ serveItems: true }
		)

		const response = await capped.request(`/collections/places/items?limit=${OGC_ITEMS_MAX_LIMIT * 5}`)

		expect(response.status).toBe(200)
		// The route asks for one row past the page to learn whether a next page exists.
		expect(requested).toEqual([OGC_ITEMS_MAX_LIMIT + 1])
	})

	test("a valid datetime selects every place, because no place carries a time", async () => {
		const all = await items("/collections/places/items?limit=100")

		for (const datetime of [
			"2018-02-12T23:20:50Z",
			"2018-02-12T00:00:00Z/..",
			"../2018-03-18T12:31:12+01:00",
			"/2018-03-18T12:31:12Z",
		]) {
			expect(
				(await items(`/collections/places/items?limit=100&datetime=${encodeURIComponent(datetime)}`)).features
			).toEqual(all.features)
		}
	})

	test("a malformed bbox, limit, datetime or cursor, or an unknown parameter, returns 400", async () => {
		for (const query of [
			"bbox=1,2,3",
			"bbox=1,2,3,4,5",
			"bbox=1,60,3,50",
			"limit=0",
			"limit=ten",
			"datetime=2018-02-30T00:00:00Z",
			"datetime=2018-02-12",
			"datetime=../..",
			"after=wof:12",
			"unknown=1",
		]) {
			const response = await app.request(`/collections/places/items?${query}`)

			expect(response.status, query).toBe(400)
			expect(await response.json(), query).toMatchObject({ error: "invalid query parameter" })
		}
	})

	test("an unknown collection, a collection without items, and an unknown feature id return 404", async () => {
		for (const [path, error] of [
			["/collections/streets/items", "collection not found"],
			["/collections/addresses/items", "collection serves no items"],
			["/collections/addresses/items/wof:101751893", "collection serves no items"],
			["/collections/places/items/wof:1", "feature not found"],
			["/collections/places/items/101751893", "feature not found"],
		] as const) {
			const response = await app.request(path)

			expect(response.status, path).toBe(404)
			expect(await response.json(), path).toMatchObject({ error })
		}
	})

	test("a collection serves items only when its description links them", async () => {
		const list = (await (await app.request("/collections?f=json")).json()) as OGCCollections

		for (const collection of list.collections) {
			const linked = collection.links.some((link) => link.rel === OGCLinkRelation.Items)
			const response = await app.request(`/collections/${collection.id}/items`)

			expect(response.status, collection.id).toBe(linked ? 200 : 404)
			expect(collection.itemType === "feature", collection.id).toBe(linked)
		}
	})

	test("items are off unless the app is built with serveItems, even for a collection with an item source", async () => {
		const defaults = createOGCApp(engine)
		const { conformsTo } = (await (await defaults.request("/conformance?f=json")).json()) as OGCConformance
		const list = (await (await defaults.request("/collections?f=json")).json()) as OGCCollections
		const document = (await (await defaults.request("/api?f=json")).json()) as { paths: Record<string, unknown> }
		const searched = (await (await defaults.request(`/search?${DAM_1_QUERY}`)).json()) as OGCSearchResponse

		expect(conformsTo.filter((uri) => uri.includes("/ogcapi-features-1/"))).toEqual([])
		expect(list.collections.flatMap(({ links }) => links).some(({ rel }) => rel === OGCLinkRelation.Items)).toBe(false)
		expect(list.collections.some((collection) => collection.itemType)).toBe(false)
		expect(Object.keys(document.paths).filter((path) => path.includes("/items"))).toEqual([])
		expect(searched.features.some((feature) => feature.properties.href)).toBe(false)

		for (const path of ["/collections/places/items", "/collections/places/items/wof:101751893"]) {
			const response = await defaults.request(path)

			expect(response.status, path).toBe(404)
			expect(await response.json(), path).toMatchObject({ error: "collection serves no items" })
		}

		expect(await (await defaults.request("/collections/streets/items")).json()).toMatchObject({
			error: "collection not found",
		})
	})
})

describe("collection sources and terms", () => {
	async function describeCollection(id: string): Promise<OGCCollection> {
		return (await (await app.request(`/collections/${id}?f=json`)).json()) as OGCCollection
	}

	test("a collection links each license text and each source its manifests record, and credits them", async () => {
		const places = await describeCollection(OGCCollectionID.Places)
		const hrefsOf = (rel: string) => places.links.filter((link) => link.rel === rel).map((link) => link.href)

		expect(hrefsOf(OGCLinkRelation.License)).toEqual([
			"https://spdx.org/licenses/CC-BY-4.0.html",
			"https://github.com/whosonfirst-data/whosonfirst-data/blob/master/LICENSE.md",
			"https://spdx.org/licenses/ODbL-1.0.html",
		])

		// The candidate layer's source is the admin layer, so both resolve to the admin build's sources.
		expect(hrefsOf(OGCLinkRelation.Via)).toEqual([
			"https://github.com/mailwoman",
			"https://docs.overturemaps.org/guides/divisions/",
			"https://download.geonames.org/export/dump/",
		])

		expect(places.attribution).toBe("Who's On First; Overture Maps divisions theme; GeoNames")
		expect(places.description).toContain("LicenseRef-Undeclared-Input")
	})

	test("a collection whose layer records another opened layer as its source links that layer's licenses too", async () => {
		const derived = createOGCApp({
			...engine,
			collections: [
				{ id: OGCCollectionID.Places, regions: null, layers: [CANDIDATE_LAYER, ADMIN_LAYER] },
				{ id: OGCCollectionID.Postcodes, regions: null, layers: [CANDIDATE_LAYER] },
			],
		})

		const postcodes = (await (await derived.request("/collections/postcodes?f=json")).json()) as OGCCollection
		const licenses = postcodes.links.filter((link) => link.rel === OGCLinkRelation.License).map((link) => link.href)

		// The credit names Who's On First, so the license text that requires the link back is linked.
		expect(postcodes.attribution).toContain("Who's On First")
		expect(licenses).toContain("https://github.com/whosonfirst-data/whosonfirst-data/blob/master/LICENSE.md")
		expect(licenses).toContain("https://spdx.org/licenses/ODbL-1.0.html")
	})

	test("regional layers link each license and provider-located source once, and count the regions without a manifest", async () => {
		const regional = createOGCApp({
			...engine,
			collections: [
				{
					id: OGCCollectionID.Addresses,
					regions: ["DE", "NL", "US-AK", "US-AL"],
					unreadRegions: 2,
					layers: ["de", "nl"].map((cc) => ({
						name: `osm-address-points-${cc}-${cc}`,
						license: "ODbL-1.0",
						attribution: "© OpenStreetMap contributors",
						source: `openstreetmap:${cc}`,
						sourceLocations: { openstreetmap: { title: "OpenStreetMap", url: "https://example.org/build-osm" } },
					})),
				},
			],
		})

		const addresses = (await (await regional.request("/collections/addresses?f=json")).json()) as OGCCollection
		const relsAndHrefs = addresses.links.slice(2).map(({ rel, href }) => `${rel} ${href}`)

		expect(relsAndHrefs).toEqual([
			"license https://spdx.org/licenses/ODbL-1.0.html",
			"via https://example.org/build-osm",
		])

		expect(addresses.description).toContain("2 regions have a layer without a readable layer_manifest")
	})

	test("a manifest without a license or a source yields no link for it, and the description says so", async () => {
		const bare = createOGCApp({
			...engine,
			collections: [
				{
					id: OGCCollectionID.Postcodes,
					regions: null,
					layers: [{ name: "postalcode-xx", license: null, attribution: null, source: null }],
				},
			],
		})

		const postcodes = (await (await bare.request("/collections/postcodes?f=json")).json()) as OGCCollection

		expect(postcodes.links.filter((link) => link.rel === OGCLinkRelation.License)).toEqual([])
		expect(postcodes.links.filter((link) => link.rel === OGCLinkRelation.Via)).toEqual([])
		expect(postcodes.attribution).toBeUndefined()
		expect(postcodes.description).toContain("records no license")
		expect(postcodes.description).toContain("records no source")
	})

	test("a collection whose manifests the server didn't read says so, and one without a layer links nothing", async () => {
		const addresses = await describeCollection(OGCCollectionID.Addresses)
		const plusCodes = await describeCollection(OGCCollectionID.PlusCodes)

		expect(addresses.description).toContain("read no layer manifest")
		expect(plusCodes.links.map(({ rel }) => rel)).toEqual([OGCLinkRelation.Self, OGCLinkRelation.Alternate])
	})
})

/**
 * One probe per conformance class: a request that fails when the capability the class names is absent.
 */
const PROBES: Record<string, () => Promise<void>> = {
	[OGCConformanceClass.Core]: async () => {
		for (const path of ["/", "/conformance", "/api", "/collections", "/collections/places"]) {
			for (const query of ["?unknown=1", "?f=xml"]) {
				const response = await app.request(`${path}${query}`)

				expect(response.status, `${path}${query}`).toBe(400)
				expect(await response.json()).toMatchObject({ error: "invalid query parameter" })
			}
		}
	},
	[OGCConformanceClass.LandingPage]: async () => {
		const landing = await landingPage()
		const rels = landing.links.map((link) => link.rel)

		expect(rels).toContain(OGCLinkRelation.OGCConformance)
		expect(rels).toContain(OGCLinkRelation.ServiceDesc)
		expect((await app.request("/conformance")).status).toBe(200)
	},
	[OGCConformanceClass.JSON]: async () => {
		for (const path of ["/?f=json", "/conformance?f=json", "/collections?f=json", "/collections/places?f=json"]) {
			const response = await app.request(path)

			expect(contentTypeOf(response), path).toContain(OGCMediaType.JSON)
			await response.json()
		}
	},
	[OGCConformanceClass.HTML]: async () => {
		for (const path of ["/?f=html", "/conformance?f=html", "/collections?f=html", "/collections/places?f=html"]) {
			const response = await app.request(path)

			expect(contentTypeOf(response), path).toContain(OGCMediaType.HTML)
			expect((await response.text()).startsWith("<!doctype html>"), path).toBe(true)
		}
	},
	[OGCConformanceClass.OAS30]: async () => {
		const json = await app.request("/api?f=json")
		const html = await app.request("/api?f=html")
		const document = (await json.json()) as { openapi: string; paths: Record<string, unknown> }

		expect(contentTypeOf(json)).toBe(OGCMediaType.OpenAPI30)
		expect(document.openapi.startsWith("3.0.")).toBe(true)
		expect(Object.keys(document.paths)).toEqual(expect.arrayContaining(["/", "/conformance", "/api"]))
		expect(openAPI31OnlyPaths(document)).toEqual([])
		expect(contentTypeOf(html)).toContain(OGCMediaType.HTML)
	},
	[OGCConformanceClass.Collections]: async () => {
		const landing = await landingPage()
		const data = landing.links.find((link) => link.rel === OGCLinkRelation.OGCData)

		expect(data, "the landing page links /collections as data").toBeDefined()

		const response = await app.request(data!.href)
		const list = (await response.json()) as OGCCollections

		expect(response.status).toBe(200)
		expect(list.links.map((link) => link.rel)).toEqual([OGCLinkRelation.Self, OGCLinkRelation.Alternate])
		expect(list.links.every((link) => typeof link.type === "string")).toBe(true)
		expect(list.collections.map(({ id }) => id)).toEqual(engine.collections.map(({ id }) => id))

		for (const listed of list.collections) {
			const described = await app.request(`/collections/${listed.id}?f=json`)
			const description = (await described.json()) as OGCCollection

			expect(described.status, listed.id).toBe(200)
			expect(description, listed.id).toEqual(listed)

			expect(description.links.slice(0, 2).map((link) => link.rel)).toEqual([
				OGCLinkRelation.Self,
				OGCLinkRelation.Alternate,
			])
		}
	},
	[OGCConformanceClass.FeaturesCore]: async () => {
		const list = (await (await app.request("/collections?f=json")).json()) as OGCCollections
		const withItems = list.collections.filter((collection) => collection.itemType === "feature")

		expect(withItems.length).toBeGreaterThan(0)

		for (const collection of withItems) {
			const link = collection.links.find((candidate) => candidate.rel === OGCLinkRelation.Items)
			const page = await items(link!.href)
			const [first] = page.features

			expect(collection.extent?.spatial.bbox.length).toBeGreaterThan(0)

			expect(page.links.map((candidate) => candidate.rel)).toEqual(
				expect.arrayContaining([OGCLinkRelation.Self, OGCLinkRelation.Alternate])
			)

			expect(page.links.every((candidate) => typeof candidate.type === "string")).toBe(true)

			const response = await app.request(`/collections/${collection.id}/items/${encodeURIComponent(first!.id)}`)
			const feature = (await response.json()) as OGCItemFeature

			expect(response.status).toBe(200)
			expect(feature.id).toBe(first!.id)

			expect(feature.links?.map((candidate) => candidate.rel)).toEqual(
				expect.arrayContaining([OGCLinkRelation.Self, OGCLinkRelation.Alternate, OGCLinkRelation.Collection])
			)
		}

		for (const query of ["?unknown=1", "?bbox=1,2,3", "?limit=0", "?datetime=yesterday"]) {
			expect((await app.request(`/collections/places/items${query}`)).status, query).toBe(400)
		}
	},
	[OGCConformanceClass.FeaturesGeoJSON]: async () => {
		const page = await app.request("/collections/places/items")
		const feature = await app.request("/collections/places/items/wof%3A101751893")

		expect(contentTypeOf(page)).toContain(OGCMediaType.GeoJSON)
		expect(((await page.json()) as OGCItemsResponse).type).toBe("FeatureCollection")
		expect(contentTypeOf(feature)).toContain(OGCMediaType.GeoJSON)
		expect(((await feature.json()) as OGCItemFeature).type).toBe("Feature")
	},
	[OGCConformanceClass.FeaturesHTML]: async () => {
		for (const path of ["/collections/places/items?f=html", "/collections/places/items/wof%3A101751893?f=html"]) {
			const response = await app.request(path)
			const html = await response.text()

			expect(contentTypeOf(response), path).toContain(OGCMediaType.HTML)
			expect(html.startsWith("<!doctype html>"), path).toBe(true)
			expect(html, path).toContain('rel="self"')
		}
	},
	[OGCConformanceClass.FeaturesOAS30]: async () => {
		const document = (await (await app.request("/api?f=json")).json()) as {
			paths: Record<string, { get?: { parameters?: Array<{ name: string; style?: string; explode?: boolean }> } }>
		}

		expect(Object.keys(document.paths)).toEqual(
			expect.arrayContaining(["/collections/{collectionId}/items", "/collections/{collectionId}/items/{featureId}"])
		)

		const parameters = document.paths["/collections/{collectionId}/items"]?.get?.parameters ?? []

		for (const name of ["limit", "bbox", "datetime"]) {
			expect(
				parameters.find((parameter) => parameter.name === name),
				name
			).toMatchObject({
				style: "form",
				explode: false,
			})
		}
	},
}

describe("conformance declaration", () => {
	test("every declared class has a served capability", async () => {
		const response = await app.request("/conformance?f=json")
		const { conformsTo } = (await response.json()) as OGCConformance

		expect(conformsTo.length).toBeGreaterThan(0)

		for (const uri of conformsTo) {
			const probe = PROBES[uri]

			expect(probe, `no probe for declared class ${uri}`).toBeDefined()
			await probe!()
		}
	})
})
