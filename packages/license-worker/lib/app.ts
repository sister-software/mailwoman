/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The license worker's Hono app. Every response is `no-store`: nothing this worker answers may be cached by a proxy,
 *   because the claim and refresh routes carry tokens and the status route carries a verdict that revocation changes.
 *   Every `/v1` route sits behind the signing self-test: a worker whose key the shipped register does not trust answers
 *   503 rather than mint tokens no installation accepts, and `/health` stays up to say so. Dependencies arrive as values
 *   so a test can inject a fixture email provider, a ledger over Miniflare's D1, a Stripe client over a fetch stub, and
 *   a signing status without a key the shipped register trusts.
 */

import { OpenAPIHono } from "@hono/zod-openapi"
import { cors } from "hono/cors"
import type Stripe from "stripe"

import type { EmailProvider } from "#email/provider"
import type { LicenseWorkerEnv } from "#env"
import type { Ledger } from "#ledger/client"
import { registerClaimRoute } from "#routes/claim"
import { registerHealthRoute, type SigningStatusReport } from "#routes/health"
import { registerRefreshRoute } from "#routes/refresh"
import { registerStatusRoute } from "#routes/status"
import { registerWebhookRoute } from "#routes/webhook"
import { stripeClient } from "#stripe/client"

export interface AppDependencies {
	signingStatus: () => SigningStatusReport
	ledger: Ledger
	email: EmailProvider
	/**
	 * Built from the environment when absent; a test injects one over a fetch stub.
	 */
	stripe?: Stripe
	now?: () => number
}

export function createLicenseWorkerApp(env: LicenseWorkerEnv, deps: AppDependencies): OpenAPIHono {
	const app = new OpenAPIHono()
	const fulfil = { stripe: deps.stripe ?? stripeClient(env), ledger: deps.ledger, email: deps.email, now: deps.now }

	app.use(async (c, next) => {
		c.header("Cache-Control", "no-store")

		await next()
	})

	app.use("/v1/*", async (c, next) => {
		if (deps.signingStatus() !== "ok") return c.json({ error: "signing unavailable" }, 503)

		await next()
	})

	app.use("/v1/checkout-sessions/*", cors({ origin: env.SITE_ORIGIN, allowMethods: ["GET"] }))

	app.onError((error, c) => {
		console.error(error instanceof Error ? error.message : String(error))

		return c.json({ error: "internal error" }, 500)
	})

	registerHealthRoute(app, env, deps.signingStatus, deps.ledger, deps.now)
	registerWebhookRoute(app, env, fulfil)
	registerClaimRoute(app, env, fulfil)
	registerRefreshRoute(app, env, deps.ledger)
	registerStatusRoute(app, env, deps.ledger)

	return app
}
