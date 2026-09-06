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
 *   does NOT port — that endpoint retires with the debug pages, and its coverage is unrelated
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
 *   whether or not real WOF + database data is present on this host. Success-path assertions check on
 *   real WOF + TX databases being present (`describeIfStack`), same as the express predecessor.
 */

import { createMailwomanAPI } from "@mailwoman/api"
import { metricsSnapshot, resetMetricsForTest, serveNode } from "@mailwoman/api-kit"
import { dataRootPath } from "@mailwoman/core/data-root"
import { pathExists } from "@mailwoman/core/fs/readers"
import { resolveModulePath } from "@mailwoman/core/module/resolvers"
import { workspacePath } from "@mailwoman/core/paths"
import { resolveWeights } from "@mailwoman/neural/weights"
import { createServeEngine } from "mailwoman/api-engine"
import { $public } from "mailwoman/env"
import { beforeAll, beforeEach, describe, expect, test } from "vitest"

const wofPath = $public.MAILWOMAN_WOF_DB ?? String(dataRootPath("wof", "admin-global-priority.db"))
const txSitus = String(dataRootPath("address-points", "address-points-us-tx.db"))
const hasStack = (await pathExists(wofPath)) && (await pathExists(txSitus))
// oxlint-disable-next-line vitest/valid-title, vitest/valid-describe-callback -- an aliased describe; the title and callback arrive where it is invoked
const describeIfStack = describe.skipIf(!hasStack)

/**
 * `/v1/parse` needs only the model weights — check its own tests independently of the WOF/TX stack above.
 */
async function weightsPresent(): Promise<boolean> {
	try {
		// ASK THE RESOLVER. This probed `packages/neural-weights-en-us/model.onnx` directly, which is true only
		// while the dev linker materializes binaries into that package — and a skip-guard that stops matching
		// does not fail, it SKIPS, so the suite disappears from the run reporting success. The repo has already
		// paid for this once: the workspace regroup left this literal behind and both this suite and
		// `api-engine.test.ts` went quiet until someone counted the skips.
		return await pathExists((await resolveWeights({ locale: "en-us" })).modelPath)
	} catch {
		return false
	}
}

// oxlint-disable-next-line vitest/valid-title, vitest/valid-describe-callback -- an aliased describe; the title and callback arrive where it is invoked
const describeIfWeights = describe.skipIf(!(await weightsPresent()))

let app: ReturnType<typeof createMailwomanAPI>

beforeAll(async () => {
	const { engine } = await createServeEngine()
	app = createMailwomanAPI(engine)
}, 120_000)

beforeEach(() => {
	resetMetricsForTest()
})

async function postJSON(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
	const res = await app.request(path, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	})

	return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

// MARK: /v1/geocode + /v1/batch — error paths

describe("api-engine — error paths (run unconditionally)", () => {
	test("POST /v1/geocode: 400 when `address` is missing", async () => {
		const r = await postJSON("/v1/geocode", {})
		expect(r.status).toBe(400)
		expect(r.body["error"]).toBe("address is required")
	})

	test("POST /v1/batch: 400 when `addresses` is not a string array", async () => {
		const r = await postJSON("/v1/batch", { addresses: [1, 2] })
		expect(r.status).toBe(400)
	})

	test("POST /v1/batch: 200 + empty results for an empty array", async () => {
		const r = await postJSON("/v1/batch", { addresses: [] })
		expect(r.status).toBe(200)
		expect((r.body as { results: unknown[] }).results).toEqual([])
	})
})

// MARK: /health — answers without the geocode stack

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

	// `readModelCard`'s FIRST non-env candidate is `import.meta.resolve` of the weights package's card. Pin the
	// resolver itself, not just the observable: the third candidate is a CWD-relative dev-tree path
	// (`neural-weights-en-us/model-card.json`) which happens to exist when the suite runs from the repo root, so the
	// /health assertion below would survive a broken resolution. This one would not.
	test("the weights card resolves through the package graph, not the CWD-relative dev fallback", () => {
		expect(resolveModulePath("@mailwoman/neural-weights-en-us/model-card.json")).toBe(
			workspacePath("neural-weights-en-us", "model-card.json")
		)
	})

	// The `model` block is `readModelCard`'s only observable. Deterministic in a checkout WITHOUT dev weights linked:
	// the card is one of the metadata files the weights workspace commits (the binaries are not).
	test("GET /health: the model block comes from the resolved weights package's card", async () => {
		const res = await app.request("/health")
		const body = (await res.json()) as { model: { name?: unknown; locale?: unknown; labels?: unknown } | null }

		expect(body.model).not.toBeNull()
		expect(body.model!.name).toBe("neural-weights-en-us")
		expect(body.model!.locale).toBe("en-us")
		expect(typeof body.model!.labels).toBe("number")
	})
})

// /v1/parse — native neural output; needs only the model weights, not the gazetteer, so
// it's conditioned on `weightsPresent()` rather than `hasStack` — a WOF-less boot still answers this.

describeIfWeights(
	"api-engine — /v1/parse (native neural output)",
	() => {
		test("POST /v1/parse: returns ordered components + the decoded tree, in engine reading order", async () => {
			const r = await postJSON("/v1/parse", { address: "3075 Hill Street, Round Rock, TX 78664" })
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
			const r = await postJSON("/v1/parse", { address: "3075 Hill Street, Round Rock, TX 78664", debug: true })
			expect(r.status).toBe(200)
			expect(typeof r.body["debug"]).toBe("string")
			expect(r.body["debug"] as string).toContain("<")
		})
	},
	60_000
)

// MARK: Success paths — real WOF + TX databases

describeIfStack("api-engine — success path against real WOF + TX databases", () => {
	test("POST /v1/geocode: resolves a TX address to a street-level coordinate", async () => {
		const r = await postJSON("/v1/geocode", { address: "3075 Hill Street, Round Rock, TX 78664" })
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

		await postJSON("/v1/geocode", { address: "3075 Hill Street, Round Rock, TX 78664" })

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
		const r = await postJSON("/v1/batch", { addresses })
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
		const [{ NeuralAddressClassifier }, { RemoteResolver }] = await Promise.all([
			import("@mailwoman/neural"),
			import("@mailwoman/resolver"),
		])

		await using handle = await serveNode({
			fetch: app.fetch,
			port: 0,
			hostname: "127.0.0.1",
		})

		const classifier = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })
		const tree = await classifier.parse("3075 Hill Street, Round Rock, TX 78664", { postcodeRepair: true })
		const remote = new RemoteResolver({ endpoint: `http://127.0.0.1:${handle.port}/v1/resolve` })
		const resolved = await remote.resolveTree(tree, { defaultCountry: "US" })

		const flat: Array<(typeof resolved.roots)[number]> = []

		const walk = (n: (typeof resolved.roots)[number]) => {
			flat.push(n)
			n.children.forEach(walk)
		}

		resolved.roots.forEach(walk)
		const street = flat.find((n) => n.tag === "street")
		// The resolver service wired its own databases → the street node carries a coordinate tier.
		expect(street?.metadata?.["resolution_tier"]).toBeDefined()
	}, 60_000)
})
