/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Unit tests for `ResolveRouter`. Schema + error paths run unconditionally; the success-path tests
 *   gate on real WOF + neural weights being available (same skip-if-missing pattern as the
 *   resolver-wof-sqlite integration tests).
 */

import { existsSync } from "node:fs"

import express from "express"
import { describe, expect, test } from "vitest"

import { ResolveRouter } from "../server/ResolveRouter.js"

const DEFAULT_WOF_PATH = "/mnt/playpen/mailwoman-data/wof/whosonfirst-data-admin-us-latest.db"
const wofPath = process.env["MAILWOMAN_WOF_DB"] ?? DEFAULT_WOF_PATH
const hasWOFDb = existsSync(wofPath)
const describeIfWOF = describe.skipIf(!hasWOFDb)

function buildApp() {
	const app = express()
	app.use(express.json())
	app.use(ResolveRouter)

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

describe("ResolveRouter — error paths (run unconditionally)", () => {
	test("400 when `text` is missing", async () => {
		const r = await postJson(buildApp(), "/api/resolve", {})
		expect(r.status).toBe(400)
		expect((r.body as { error?: string }).error).toMatch(/Missing `text`/)
	})

	test("400 when `text` is empty / whitespace", async () => {
		const r = await postJson(buildApp(), "/api/resolve", { text: "   " })
		expect(r.status).toBe(400)
	})
})

describeIfWOF("ResolveRouter — success path against real WOF", () => {
	test("returns parsed XML + flat node list for a known input", async () => {
		const r = await postJson(buildApp(), "/api/resolve", { text: "Springfield, Illinois" })
		expect(r.status).toBe(200)
		const body = r.body as {
			input: string
			xml: string
			nodes: Array<{ tag: string; placeID?: string; lat?: number; depth: number }>
		}
		expect(body.input).toBe("Springfield, Illinois")
		expect(body.xml).toContain("<address raw=")
		expect(body.nodes.length).toBeGreaterThan(0)
		// At least one node should have been resolver-decorated (region or locality).
		const resolved = body.nodes.filter((n) => n.placeID)
		expect(resolved.length).toBeGreaterThan(0)
	}, 30_000)

	test("returns the parsed-only tree when no node resolves (e.g. ambiguous bare locality)", async () => {
		const r = await postJson(buildApp(), "/api/resolve", { text: "Nonexistentplaceville" })
		// Even when the resolver can't match anything, the response is still 200 — the parsed tree
		// is the deliverable.
		expect(r.status).toBe(200)
		const body = r.body as { nodes: unknown[] }
		expect(Array.isArray(body.nodes)).toBe(true)
	}, 30_000)
})
