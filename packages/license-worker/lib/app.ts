/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The license worker's Hono app. Every response is `no-store`: nothing this worker answers may be cached by a proxy,
 *   because the claim and refresh routes carry tokens and the status route carries a verdict that revocation changes.
 *   Dependencies arrive as values so a test can inject a fixture email provider, a ledger over Miniflare's D1, and a
 *   signing status without a key the shipped register trusts.
 */

import { OpenAPIHono } from "@hono/zod-openapi"

import type { LicenseWorkerEnv } from "#env"
import { registerHealthRoute, type SigningStatusReport } from "#routes/health"

export interface AppDependencies {
	signingStatus: () => SigningStatusReport
}

const DEFAULT_DEPENDENCIES: AppDependencies = { signingStatus: () => "unchecked" }

export function createLicenseWorkerApp(
	env: LicenseWorkerEnv,
	deps: AppDependencies = DEFAULT_DEPENDENCIES
): OpenAPIHono {
	const app = new OpenAPIHono()

	app.use(async (c, next) => {
		c.header("Cache-Control", "no-store")

		await next()
	})

	app.onError((error, c) => {
		console.error(error instanceof Error ? error.message : String(error))

		return c.json({ error: "internal error" }, 500)
	})

	registerHealthRoute(app, env, deps.signingStatus)

	return app
}
