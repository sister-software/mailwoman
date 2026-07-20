/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `@mailwoman/fastify` route + decorator tests. Every case injects a FAKE runtime pipeline via the `pipeline` option
 *   so no model weights or gazetteer data are needed — the plugin's routing, envelopes, decorator, POI gating, and
 *   prefix encapsulation are all exercised over `fastify.inject`.
 */

import Fastify, { type FastifyInstance } from "fastify"
import type { AddressNode, AddressTree, PipelineOpts, PipelineResult } from "mailwoman"
import { describe, expect, it } from "vitest"

import mailwomanFastify, { type MailwomanFastifyOptions, type RuntimePipeline } from "./index.ts"

/** A minimal resolved locality node — carries a coordinate so `extractGeocodeResult` returns lat/lon (admin tier). */
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

/** Build a fake pipeline whose result is fixed except for the echoed input. `poiIntent` is attached when supplied. */
function fakePipeline(overrides: Partial<PipelineResult> = {}): RuntimePipeline {
	return async (raw: string, _opts?: PipelineOpts): Promise<PipelineResult> => {
		const tree: AddressTree = { raw, roots: [localityNode("New York", 40.7128, -74.006)] }

		return {
			input: raw,
			normalized: { raw, normalized: raw },
			queryShape: { knownFormats: [] },
			locale: { locale: "en-US", confidence: 1, alternatives: [], source: "detected" },
			kind: { kind: "structured_address", confidence: 1, alternatives: [] },
			phraseProposals: [],
			tree,
			timing: {},
			path: "full",
			...overrides,
		}
	}
}

/** Register the plugin against a fresh Fastify instance with an injected fake pipeline. */
async function buildApp(
	opts: Omit<MailwomanFastifyOptions, "pipeline"> & { pipeline?: RuntimePipeline }
): Promise<FastifyInstance> {
	const app = Fastify()
	await app.register(mailwomanFastify, { pipeline: fakePipeline(), ...opts })
	await app.ready()

	return app
}

describe("@mailwoman/fastify", () => {
	it("POST /parse returns ordered components + the decoded tree", async () => {
		const app = await buildApp({ pipeline: fakePipeline() })
		const res = await app.inject({ method: "POST", url: "/parse", payload: { text: "New York" } })

		expect(res.statusCode).toBe(200)
		const body = res.json()
		expect(body.input).toBe("New York")
		expect(body.path).toBe("full")
		expect(body.components).toContainEqual({ tag: "locality", value: "New York" })
		expect(body.tree.roots).toHaveLength(1)
		await app.close()
	})

	it("POST /geocode returns a GeocodeResult with the resolved coordinate", async () => {
		const app = await buildApp({ pipeline: fakePipeline() })
		const res = await app.inject({ method: "POST", url: "/geocode", payload: { text: "New York" } })

		expect(res.statusCode).toBe(200)
		const body = res.json()
		expect(body.input).toBe("New York")
		expect(body.lat).toBeCloseTo(40.7128)
		expect(body.lon).toBeCloseTo(-74.006)
		expect(body.locality).toBe("New York")
		await app.close()
	})

	it("POST /poi returns the pipeline's POI intent when a database is configured", async () => {
		const poiIntent = {
			type: "intent" as const,
			intent: { subject: { kind: "category" as const, categoryID: "eat_and_drink.coffee", matched: "coffee" } },
			results: [],
		}
		const app = await buildApp({ pipeline: fakePipeline({ poiIntent, path: "poi" }), poiDatabasePath: "/tmp/poi.db" })
		const res = await app.inject({ method: "POST", url: "/poi", payload: { text: "coffee near Union Square" } })

		expect(res.statusCode).toBe(200)
		expect(res.json()).toMatchObject({ type: "intent" })
		await app.close()
	})

	it("POST /poi answers 501 with a clean envelope when no poiDatabasePath is configured", async () => {
		const app = await buildApp({ pipeline: fakePipeline() })
		const res = await app.inject({ method: "POST", url: "/poi", payload: { text: "coffee near Union Square" } })

		expect(res.statusCode).toBe(501)
		const body = res.json()
		expect(body.error).toBe("poi search not configured")
		expect(body.detail).toContain("poiDatabasePath")
		await app.close()
	})

	it("POST /poi returns not_poi_query when the pipeline produced no intent", async () => {
		const app = await buildApp({ pipeline: fakePipeline(), poiDatabasePath: "/tmp/poi.db" })
		const res = await app.inject({ method: "POST", url: "/poi", payload: { text: "New York" } })

		expect(res.statusCode).toBe(200)
		expect(res.json()).toEqual({ type: "not_poi_query" })
		await app.close()
	})

	it("GET /health returns { ok, version }", async () => {
		const app = await buildApp({ pipeline: fakePipeline() })
		const res = await app.inject({ method: "GET", url: "/health" })

		expect(res.statusCode).toBe(200)
		const body = res.json()
		expect(body.ok).toBe(true)
		expect(typeof body.version).toBe("string")
		await app.close()
	})

	it("rejects a blank body with 400 { error }", async () => {
		const app = await buildApp({ pipeline: fakePipeline() })
		const res = await app.inject({ method: "POST", url: "/parse", payload: { text: "   " } })

		expect(res.statusCode).toBe(400)
		expect(res.json().error).toBe("text is required")
		await app.close()
	})

	it("exposes the fastify.mailwoman decorator with parse/geocode/poi", async () => {
		const app = await buildApp({ pipeline: fakePipeline(), poiDatabasePath: "/tmp/poi.db" })
		const parsed = await app.mailwoman.parse("New York")
		const geo = await app.mailwoman.geocode("New York")
		const poi = await app.mailwoman.poi("New York")

		expect(parsed.components).toContainEqual({ tag: "locality", value: "New York" })
		expect(geo.lat).toBeCloseTo(40.7128)
		expect(poi).toEqual({ type: "not_poi_query" })
		await app.close()
	})

	it("the decorator's poi throws when POI is not configured", async () => {
		const app = await buildApp({ pipeline: fakePipeline() })
		await expect(app.mailwoman.poi("coffee")).rejects.toThrow(/not configured/)
		await app.close()
	})

	it("honors routePrefix (plugin encapsulation)", async () => {
		const app = await buildApp({ pipeline: fakePipeline(), routePrefix: "/geo" })

		const prefixed = await app.inject({ method: "POST", url: "/geo/parse", payload: { text: "New York" } })
		expect(prefixed.statusCode).toBe(200)

		const unprefixed = await app.inject({ method: "POST", url: "/parse", payload: { text: "New York" } })
		expect(unprefixed.statusCode).toBe(404)
		await app.close()
	})
})
