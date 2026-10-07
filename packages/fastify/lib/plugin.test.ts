/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `@mailwoman/fastify` route + decorator tests. Every case injects a fake runtime pipeline via the `pipeline` option
 *   so no model weights or gazetteer data are needed — the plugin's routing, envelopes, decorator, POI filtering and
 *   prefix encapsulation are all exercised over `fastify.inject`.
 */

import type { AddressNode, AddressTree, PipelineOpts, PipelineResult } from "@mailwoman/core"
import Fastify, { type FastifyInstance } from "fastify"
import { describe, expect, it } from "vitest"

import { mailwomanFastify } from "#plugin"
import type { MailwomanFastifyOptions, RuntimePipeline } from "#shared"

/**
 * A minimal resolved locality node — includes a coordinate so `extractGeocodeResult`
 * returns lat/lon (admin tier).
 */
function localityNode(value: string, lat: number, lon: number): AddressNode {
	return {
		tag: "locality",
		value,
		start: 0,
		end: value.length,
		confidence: 0.9,
		children: [],
		lat,
		lon,
		metadata: { resolver_name: value, resolver_country: "US" },
	}
}

/**
 * Build a fake pipeline whose result is fixed except for the echoed input.
 */
function fakePipeline(overrides: Partial<PipelineResult> = {}): RuntimePipeline {
	return async (raw: string, _opts?: PipelineOpts): Promise<PipelineResult> => {
		const tree: AddressTree = { raw, roots: [localityNode("New York", 40.7128, -74.006)] }

		return {
			input: raw,
			normalized: { raw, normalized: raw },
			queryShape: { knownFormats: [] },
			locale: { locale: "en-US", confidence: 1, alternatives: [], source: "detected" },
			kind: { kind: "structured_address", confidence: 1, alternatives: [], intentMarkers: null },
			phraseProposals: [],
			tree,
			timing: {},
			faults: [],
			poiIntent: null,
			intentMarkers: [],
			path: "full",
			...overrides,
		}
	}
}

/**
 * Register the plugin against a fresh Fastify instance with an injected fake pipeline.
 */
async function buildApp(
	opts: Omit<MailwomanFastifyOptions, "pipeline"> & { pipeline?: RuntimePipeline }
): Promise<FastifyInstance> {
	const app = Fastify()
	await app.register(mailwomanFastify, { pipeline: fakePipeline(), ...opts })
	await app.ready()

	return app
}

describe("@mailwoman/fastify", () => {
	it("POST /v1/parse returns ordered components + the decoded tree", async () => {
		await using app = await buildApp({ pipeline: fakePipeline() })
		const res = await app.inject({ method: "POST", url: "/v1/parse", payload: { address: "New York" } })

		expect(res.statusCode).toBe(200)
		const body = res.json()
		expect(body.input).toBe("New York")
		expect(body.debug).toBeNull()
		expect(body.components).toContainEqual({ tag: "locality", value: "New York" })
		expect(body.tree.roots).toHaveLength(1)
	})

	it("POST /v1/geocode returns a GeocodeResult with the resolved coordinate", async () => {
		await using app = await buildApp({ pipeline: fakePipeline() })
		const res = await app.inject({ method: "POST", url: "/v1/geocode", payload: { address: "New York" } })

		expect(res.statusCode).toBe(200)
		const body = res.json()

		expect(body.input).toBe("New York")
		expect(body.lat).toBeCloseTo(40.7128)
		expect(body.lon).toBeCloseTo(-74.006)
		expect(body.locality).toBe("New York")
	})

	it("POST /v1/poi returns the pipeline's POI intent when a database is configured", async () => {
		const poiIntent = {
			type: "intent" as const,
			intent: {
				subject: {
					kind: "category" as const,
					categoryIDs: ["eat_and_drink.coffee"],
					matched: "coffee",
					countryBinding: null,
				},
				relation: null,
				anchor: null,
				limit: null,
			},
			results: [],
		}

		await using app = await buildApp({
			pipeline: fakePipeline({ poiIntent, path: "poi" }),
			poiDatabasePath: "/tmp/poi.db",
		})

		const res = await app.inject({ method: "POST", url: "/v1/poi", payload: { query: "coffee near Union Square" } })

		expect(res.statusCode).toBe(200)
		expect(res.json()).toMatchObject({ type: "intent", results: [] })
	})

	it("POST /v1/poi answers 501 with a clean envelope when no poiDatabasePath is configured", async () => {
		await using app = await buildApp({ pipeline: fakePipeline() })
		const res = await app.inject({ method: "POST", url: "/v1/poi", payload: { query: "coffee near Union Square" } })

		expect(res.statusCode).toBe(501)

		const body = res.json()

		expect(body.error).toBe("poi search not configured")
		expect(body.detail).toContain("poiDatabasePath")
	})

	it("POST /v1/poi returns not_poi_query when the pipeline produced no intent", async () => {
		await using app = await buildApp({ pipeline: fakePipeline(), poiDatabasePath: "/tmp/poi.db" })

		const res = await app.inject({ method: "POST", url: "/v1/poi", payload: { query: "New York" } })

		expect(res.statusCode).toBe(200)
		expect(res.json()).toEqual({ type: "not_poi_query" })
	})

	it("GET /v1/parse parses the address query parameter", async () => {
		await using app = await buildApp({ pipeline: fakePipeline() })
		const res = await app.inject({ method: "GET", url: "/v1/parse?address=New%20York" })

		expect(res.statusCode).toBe(200)
		expect(res.json().components).toContainEqual({ tag: "locality", value: "New York" })
	})

	it("GET /health returns the shared health response", async () => {
		await using app = await buildApp({ pipeline: fakePipeline() })

		const res = await app.inject({ method: "GET", url: "/health" })

		expect(res.statusCode).toBe(200)
		const body = res.json()

		expect(body.status).toBe("ok")
		expect(typeof body.uptime_s).toBe("number")
		expect(typeof body.version).toBe("string")
	})

	it("rejects a blank address with the API error envelope", async () => {
		await using app = await buildApp({ pipeline: fakePipeline() })

		const res = await app.inject({ method: "POST", url: "/v1/parse", payload: { address: "   " } })

		expect(res.statusCode).toBe(400)
		expect(res.json()).toEqual({ error: "address is required", detail: null })
	})

	it("rejects a body that fails the operation schema with the API error envelope", async () => {
		await using app = await buildApp({ pipeline: fakePipeline() })

		const res = await app.inject({ method: "POST", url: "/v1/parse", payload: { text: "New York" } })

		expect(res.statusCode).toBe(400)
		expect(res.json().error).toBe("invalid request")
	})

	it("exposes the fastify.mailwoman decorator with parse/geocode/poi", async () => {
		await using app = await buildApp({ pipeline: fakePipeline(), poiDatabasePath: "/tmp/poi.db" })
		const parsed = await app.mailwoman.parse("New York")
		const geo = await app.mailwoman.geocode("New York")
		const poi = await app.mailwoman.poi("New York")

		expect(parsed.components).toContainEqual({ tag: "locality", value: "New York" })
		expect(geo.lat).toBeCloseTo(40.7128)
		expect(poi).toEqual({ type: "not_poi_query" })
	})

	it("the decorator's poi throws when POI is not configured", async () => {
		await using app = await buildApp({ pipeline: fakePipeline() })
		await expect(app.mailwoman.poi("coffee")).rejects.toThrow(/not configured/)
	})

	it("honors Fastify's register prefix", async () => {
		await using app = await buildApp({ pipeline: fakePipeline(), prefix: "/geo" })

		const prefixed = await app.inject({ method: "POST", url: "/geo/v1/parse", payload: { address: "New York" } })
		expect(prefixed.statusCode).toBe(200)

		const unprefixed = await app.inject({ method: "POST", url: "/v1/parse", payload: { address: "New York" } })
		expect(unprefixed.statusCode).toBe(404)
	})
})
