// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, test } from "vitest"

import {
	buildLandingPage,
	createOGCApp,
	OGC_DOC_INFO,
	type OGCConformance,
	OGCConformanceClass,
	OGCFormat,
	type OGCLandingPage,
	OGCLinkRelation,
	OGCMediaType,
} from "#index"

const app = createOGCApp()

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
		const proxied = createOGCApp({ baseURL: "https://example.org/ogc/" })
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

/**
 * One probe per conformance class: a request that fails when the capability the class names is absent.
 */
const PROBES: Record<string, () => Promise<void>> = {
	[OGCConformanceClass.Core]: async () => {
		for (const path of ["/", "/conformance", "/api"]) {
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
		for (const path of ["/?f=json", "/conformance?f=json"]) {
			const response = await app.request(path)

			expect(contentTypeOf(response), path).toContain(OGCMediaType.JSON)
			await response.json()
		}
	},
	[OGCConformanceClass.HTML]: async () => {
		for (const path of ["/?f=html", "/conformance?f=html"]) {
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
