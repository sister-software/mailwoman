/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Unit tests for `GeocodeRouter` (#485). Schema/error paths run unconditionally; the success-path
 *   tests gate on real WOF + per-state shards being present (same skip-if-missing pattern as the
 *   resolver integration tests). Success-path tests also need the neural weights installed.
 */

import express from "express"
import { existsSync } from "node:fs"
import { describe, expect, test } from "vitest"

import { GeocodeRouter } from "../server/GeocodeRouter.js"

const wofPath = process.env["MAILWOMAN_WOF_DB"] ?? "/mnt/playpen/mailwoman-data/wof/admin-global-priority.db"
const txSitus = "/mnt/playpen/mailwoman-data/address-points/address-points-us-tx.db"
const hasStack = existsSync(wofPath) && existsSync(txSitus)
const describeIfStack = describe.skipIf(!hasStack)

function buildApp() {
	const app = express()
	app.use(express.json({ limit: "2mb" }))
	app.use(GeocodeRouter)
	return app
}

async function postJson(app: express.Express, path: string, body: unknown) {
	const server = app.listen(0)
	try {
		const port = (server.address() as { port: number }).port
		const r = await fetch(`http://127.0.0.1:${port}${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		})
		return { status: r.status, body: await r.json() }
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()))
	}
}

describe("GeocodeRouter — error paths (run unconditionally)", () => {
	test("POST /api/geocode 400 when `address` is missing", async () => {
		const r = await postJson(buildApp(), "/api/geocode", {})
		expect(r.status).toBe(400)
		expect((r.body as { error?: string }).error).toMatch(/address/)
	})

	test("POST /api/batch 400 when `addresses` is not a string array", async () => {
		const r = await postJson(buildApp(), "/api/batch", { addresses: [1, 2] })
		expect(r.status).toBe(400)
	})

	test("POST /api/batch 200 + empty results for an empty array", async () => {
		const r = await postJson(buildApp(), "/api/batch", { addresses: [] })
		expect(r.status).toBe(200)
		expect((r.body as { results: unknown[] }).results).toEqual([])
	})
})

describeIfStack("GeocodeRouter — success path against real WOF + TX shards", () => {
	test("POST /api/geocode resolves a TX address to a street-level coordinate", async () => {
		const r = await postJson(buildApp(), "/api/geocode", { address: "3075 Hill Street, Round Rock, TX 78664" })
		expect(r.status).toBe(200)
		const body = r.body as { lat: number; lon: number; resolution_tier: string; region: string }
		expect(body.region).toBe("TX")
		expect(["address_point", "interpolated"]).toContain(body.resolution_tier)
		expect(typeof body.lat).toBe("number")
		expect(typeof body.lon).toBe("number")
	}, 60_000)

	test("POST /api/batch returns results in input order, one slot per input", async () => {
		const addresses = ["3075 Hill Street, Round Rock, TX 78664", "3029 Hill Street, Round Rock, TX 78664"]
		const r = await postJson(buildApp(), "/api/batch", { addresses })
		expect(r.status).toBe(200)
		const results = (r.body as { results: Array<{ input: string }> }).results
		expect(results).toHaveLength(2)
		expect(results[0]!.input).toBe(addresses[0])
		expect(results[1]!.input).toBe(addresses[1])
	}, 60_000)

	test("RemoteResolver round-trips a parsed tree → street-level via /api/resolve-tree", async () => {
		const { NeuralAddressClassifier } = await import("@mailwoman/neural")
		const { RemoteResolver } = await import("@mailwoman/core/resolver")
		const server = buildApp().listen(0)
		try {
			const port = (server.address() as { port: number }).port
			const classifier = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })
			const tree = await classifier.parse("3075 Hill Street, Round Rock, TX 78664", { postcodeRepair: true })
			const remote = new RemoteResolver({ endpoint: `http://127.0.0.1:${port}/api/resolve-tree` })
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
			await new Promise<void>((resolve) => server.close(() => resolve()))
		}
	}, 60_000)
})
