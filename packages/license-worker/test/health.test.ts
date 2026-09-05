/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { env } from "cloudflare:workers"
import { expect, test } from "vitest"

import { createLicenseWorkerApp } from "#app"
import { readEnv } from "#env"

test("GET /health answers issuance, the environment's mode, and no-store", async () => {
	const app = createLicenseWorkerApp(readEnv(env))
	const res = await app.request("/health")

	expect(res.status).toBe(200)
	expect(res.headers.get("cache-control")).toBe("no-store")
	expect(await res.json()).toEqual({ issuance: false, liveMode: false, signing: "unchecked" })
})
