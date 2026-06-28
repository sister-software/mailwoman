/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for the observability surface (#485): `GET /health`, `GET /metrics`, and the in-process
 *   metrics recorder. All run unconditionally — health reads files best-effort and the recorder is
 *   pure in-memory; neither needs WOF / weights.
 */

import express from "express"
import { describe, expect, test } from "vitest"

import { HealthRouter } from "../server/HealthRouter.js"
import { __resetMetricsForTest, metricsSnapshot, recordGeocode } from "../server/metrics.js"

function buildApp() {
	const app = express()
	app.use(express.json())
	app.use(HealthRouter)

	return app
}

async function getJson(app: express.Express, path: string) {
	const server = app.listen(0)

	try {
		const port = (server.address() as { port: number }).port
		const r = await fetch(`http://127.0.0.1:${port}${path}`)

		return { status: r.status, body: await r.json() }
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()))
	}
}

describe("metrics recorder", () => {
	test("counts tiers + computes latency percentiles; error tier is isolated", () => {
		__resetMetricsForTest()
		recordGeocode(10, "address_point")
		recordGeocode(20, "interpolated")
		recordGeocode(30, "admin")
		recordGeocode(5, "error")
		const s = metricsSnapshot()
		expect(s.geocode.total).toBe(4)
		expect(s.geocode.errors).toBe(1)
		expect(s.geocode.tiers).toEqual({ address_point: 1, interpolated: 1, admin: 1 })
		expect(s.geocode.latency_samples).toBe(4)
		expect(s.geocode.latency_ms).not.toBeNull()
		expect(s.geocode.latency_ms!.max).toBe(30)
	})

	test("latency_ms is null before any request", () => {
		__resetMetricsForTest()
		expect(metricsSnapshot().geocode.latency_ms).toBeNull()
	})
})

describe("HealthRouter", () => {
	test("GET /health returns status + data shape (never throws)", async () => {
		const r = await getJson(buildApp(), "/health")
		expect(r.status).toBe(200)
		const body = r.body as { status: string; data: { situs_states: number; interpolation_states: number } }
		expect(body.status).toBe("ok")
		expect(typeof body.data.situs_states).toBe("number")
		expect(typeof body.data.interpolation_states).toBe("number")
	})

	test("GET /metrics returns the snapshot, reflecting recorded requests", async () => {
		__resetMetricsForTest()
		recordGeocode(42, "address_point")
		const r = await getJson(buildApp(), "/metrics")
		expect(r.status).toBe(200)
		const body = r.body as { geocode: { total: number; tiers: { address_point: number } } }
		expect(body.geocode.total).toBe(1)
		expect(body.geocode.tiers.address_point).toBe(1)
	})
})
