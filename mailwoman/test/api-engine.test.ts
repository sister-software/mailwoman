/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Ported tests for `api-engine.ts` — the wired `MailwomanAPIEngine` for `mailwoman serve` (Phase
 *   4b). Carries forward every assertion from the express-era `test/geocode-router.test.ts` and
 *   `test/health-router.test.ts` onto `createMailwomanAPI((await createServeEngine()).engine)` +
 *   `app.request()`.
 *
 *   `test/resolve-router.test.ts` (the `/api/resolve` XML-tree-viewer endpoint, `ResolveRouter.ts`)
 *   does NOT port — that endpoint retires with the debug pages (Task 2), and its coverage is unrelated
 *   to `resolveTreeHandler`/`/v1/resolve` (a DIFFERENT express router, `GeocodeRouter.ts`), which this
 *   file DOES cover (ported from `geocode-router.test.ts`'s RemoteResolver round-trip test).
 *
 *   The generic timing-metrics algorithm (percentiles, tier partition, reservoir) also does not
 *   re-port here — `api-kit/metrics.test.ts` already exhaustively covers the identical
 *   `recordTimed`/`metricsSnapshot` logic this engine delegates to. This file only exercises the
 *   `/metrics` HTTP surface reflecting a real wired call (the integration behavior, not the algorithm).
 *
 *   The engine is built ONCE (`beforeAll`) and reused across every test in this file — unlike
 *   express's per-request lazy `getDeps()`, `createServeEngine()` does the (slow: model + SQLite)
 *   setup work eagerly, so paying that cost once per file (not once per test) matters. Error-path
 *   assertions run unconditionally: the validation-layer 400s never reach the engine, so they pass
 *   whether or not real WOF + shard data is present on this host. Success-path assertions gate on
 *   real WOF + TX shards being present (`describeIfStack`), same as the express predecessor.
 */

import { existsSync, realpathSync } from "node:fs"

import { createMailwomanAPI } from "@mailwoman/api"
import { metricsSnapshot, resetMetricsForTest, serveNode, type ServerHandle } from "@mailwoman/api-kit"
import { $public } from "@mailwoman/core/env"
import { dataRootPath } from "@mailwoman/core/utils"
import { beforeAll, beforeEach, describe, expect, test } from "vitest"

import { createServeEngine } from "../api-engine.ts"

const wofPath = $public.MAILWOMAN_WOF_DB ?? String(dataRootPath("wof", "admin-global-priority.db"))
const txSitus = String(dataRootPath("address-points", "address-points-us-tx.db"))
const hasStack = existsSync(wofPath) && existsSync(txSitus)
const describeIfStack = describe.skipIf(!hasStack)

/** `/v1/parse` needs only the model weights (Task 2) — gate its own tests independently of the WOF/TX stack above. */
function weightsPresent(): boolean {
	try {
		return existsSync(realpathSync("neural-weights-en-us/model.onnx"))
	} catch {
		return false
	}
}
const describeIfWeights = describe.skipIf(!weightsPresent())

let app: ReturnType<typeof createMailwomanAPI>

beforeAll(async () => {
	const { engine } = await createServeEngine()
	app = createMailwomanAPI(engine)
}, 120_000)

beforeEach(() => {
	resetMetricsForTest()
})

async function postJson(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
	const res = await app.request(path, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	})

	return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

// ---------------------------------------------------------------------------------------------
// /v1/geocode + /v1/batch — error paths (run unconditionally; ported from geocode-router.test.ts)
// ---------------------------------------------------------------------------------------------

describe("api-engine — error paths (run unconditionally)", () => {
	test("POST /v1/geocode: 400 when `address` is missing", async () => {
		const r = await postJson("/v1/geocode", {})
		expect(r.status).toBe(400)
		expect(r.body["error"]).toBe("address is required")
	})

	test("POST /v1/batch: 400 when `addresses` is not a string array", async () => {
		const r = await postJson("/v1/batch", { addresses: [1, 2] })
		expect(r.status).toBe(400)
	})

	test("POST /v1/batch: 200 + empty results for an empty array", async () => {
		const r = await postJson("/v1/batch", { addresses: [] })
		expect(r.status).toBe(200)
		expect((r.body as { results: unknown[] }).results).toEqual([])
	})
})

// ---------------------------------------------------------------------------------------------
// /health — answers even when the geocode/resolve stack is unavailable (ported from health-router.test.ts)
// ---------------------------------------------------------------------------------------------

describe("api-engine — /health (run unconditionally, never throws)", () => {
	test("GET /health: returns status + data shape", async () => {
		const res = await app.request("/health")
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			status: string
			data: { situs_states: number; interpolation_states: number }
		}
		expect(body.status).toBe("ok")
		expect(typeof body.data.situs_states).toBe("number")
		expect(typeof body.data.interpolation_states).toBe("number")
	})
})

// ---------------------------------------------------------------------------------------------
// /v1/parse — native neural output (Task 2); needs only the model weights, not the gazetteer, so
// it's gated on `weightsPresent()` rather than `hasStack` — a WOF-less boot still answers this.
// ---------------------------------------------------------------------------------------------

describeIfWeights(
	"api-engine — /v1/parse (native neural output)",
	() => {
		test("POST /v1/parse: returns ordered components + the decoded tree, in engine reading order", async () => {
			const r = await postJson("/v1/parse", { address: "3075 Hill Street, Round Rock, TX 78664" })
			expect(r.status).toBe(200)
			const body = r.body as {
				input: string
				components: Array<{ tag: string; value: string }>
				tree: { roots: unknown[] }
			}
			expect(body.input).toBe("3075 Hill Street, Round Rock, TX 78664")
			expect(body.components.length).toBeGreaterThan(0)
			expect(body.components.some((c) => c.tag === "house_number" && c.value === "3075")).toBe(true)
			expect(Array.isArray(body.tree.roots)).toBe(true)
			expect(body.tree.roots.length).toBeGreaterThan(0)
		})

		test("POST /v1/parse: debug:true rides an XML diagnostic report back in the response", async () => {
			const r = await postJson("/v1/parse", { address: "3075 Hill Street, Round Rock, TX 78664", debug: true })
			expect(r.status).toBe(200)
			expect(typeof r.body["debug"]).toBe("string")
			expect(r.body["debug"] as string).toContain("<")
		})
	},
	60_000
)

// ---------------------------------------------------------------------------------------------
// Success paths against real WOF + TX shards (ported from geocode-router.test.ts)
// ---------------------------------------------------------------------------------------------

describeIfStack("api-engine — success path against real WOF + TX shards", () => {
	test("POST /v1/geocode: resolves a TX address to a street-level coordinate", async () => {
		const r = await postJson("/v1/geocode", { address: "3075 Hill Street, Round Rock, TX 78664" })
		expect(r.status).toBe(200)
		const body = r.body as { lat: number; lon: number; resolution_tier: string; region: string }
		expect(body.region).toBe("TX")
		expect(["address_point", "interpolated"]).toContain(body.resolution_tier)
		expect(typeof body.lat).toBe("number")
		expect(typeof body.lon).toBe("number")
	}, 60_000)

	test("GET /metrics: reflects a recorded /v1/geocode call", async () => {
		const before = (await (await app.request("/metrics")).json()) as { timings: { total: number } }
		expect(before.timings.total).toBe(0)

		await postJson("/v1/geocode", { address: "3075 Hill Street, Round Rock, TX 78664" })

		const after = (await (await app.request("/metrics")).json()) as {
			timings: { total: number; tiers: Record<string, number> }
		}
		expect(after.timings.total).toBe(1)
		expect(Object.keys(after.timings.tiers)).toEqual(
			expect.arrayContaining([expect.stringMatching(/^(address_point|interpolated)$/)])
		)
	}, 60_000)

	test("POST /v1/batch: returns results in input order, one slot per input, with per-row metrics recorded", async () => {
		const addresses = ["3075 Hill Street, Round Rock, TX 78664", "3029 Hill Street, Round Rock, TX 78664"]
		const r = await postJson("/v1/batch", { addresses })
		expect(r.status).toBe(200)
		const results = (r.body as { results: Array<{ input: string }> }).results
		expect(results).toHaveLength(2)
		expect(results[0]!.input).toBe(addresses[0])
		expect(results[1]!.input).toBe(addresses[1])

		// #485 4a handoff: per-ROW metrics land in the engine, not just the route's whole-call "batch" tier.
		const snapshot = metricsSnapshot()
		const perRowTotal = Object.entries(snapshot.timings.tiers)
			.filter(([tier]) => tier !== "batch")
			.reduce((sum, [, count]) => sum + count, 0)
		expect(perRowTotal).toBe(2)
	}, 60_000)

	test("POST /v1/reload: returns { reloaded: true, versions }", async () => {
		const res = await app.request("/v1/reload", { method: "POST" })
		expect(res.status).toBe(200)
		const body = (await res.json()) as { reloaded: boolean; versions: unknown }
		expect(body.reloaded).toBe(true)
	})

	test("RemoteResolver round-trips a parsed tree → street-level via /v1/resolve", async () => {
		const { NeuralAddressClassifier } = await import("@mailwoman/neural")
		const { RemoteResolver } = await import("@mailwoman/resolver")

		let handle!: ServerHandle
		const port = await new Promise<number>((resolve) => {
			handle = serveNode({
				fetch: app.fetch,
				port: 0,
				hostname: "127.0.0.1",
				onListen: (info) => resolve(info.port),
			})
		})

		try {
			const classifier = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })
			const tree = await classifier.parse("3075 Hill Street, Round Rock, TX 78664", { postcodeRepair: true })
			const remote = new RemoteResolver({ endpoint: `http://127.0.0.1:${port}/v1/resolve` })
			const resolved = await remote.resolveTree(tree, { defaultCountry: "US" })

			const flat: Array<(typeof resolved.roots)[number]> = []
			const walk = (n: (typeof resolved.roots)[number]) => {
				flat.push(n)
				n.children.forEach(walk)
			}
			resolved.roots.forEach(walk)
			const street = flat.find((n) => n.tag === "street")
			// The resolver service wired its own shards → the street node carries a coordinate tier.
			expect(street?.metadata?.["resolution_tier"]).toBeDefined()
		} finally {
			await handle.close()
		}
	}, 60_000)
})
