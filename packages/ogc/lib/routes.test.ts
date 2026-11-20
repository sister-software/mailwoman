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
	type OGCLandingPage,
	OGCLinkRelation,
	OGCMediaType,
	type OGCSearchHit,
	type OGCSearchResponse,
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
	},
	{
		collectionID: OGCCollectionID.Places,
		lon: -74.188,
		lat: 42.938,
		displayName: "Amsterdam, United States",
		score: -4.25,
	},
]

const engine: OGCEngine = {
	collections: [
		{ id: OGCCollectionID.Addresses, regions: ["NL"] },
		{ id: OGCCollectionID.Places, regions: null },
	],
	search: async (q) => (q === DAM_1 ? DAM_1_HITS : []),
}

const app = createOGCApp(engine)

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
		})
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
			expect(description.links.map((link) => link.rel)).toEqual([OGCLinkRelation.Self, OGCLinkRelation.Alternate])
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
