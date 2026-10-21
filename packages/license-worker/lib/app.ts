/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * The license worker's Hono app. Every response is `no-store`, because the claim and refresh routes return
 * tokens and the status route returns a verdict that revocation changes.
 *
 * Every `/v1` route sits behind the signing self-test, so a worker whose key the shipped register does not
 * trust answers 503 rather than mint tokens no installation accepts, while `/health` stays up to say so.
 * Dependencies arrive as values so a test can inject a fixture email provider, a ledger over
 * Miniflare's D1, a Stripe client over a fetch stub and a signing status without a trusted key.
 */

import { OpenAPIHono } from "@hono/zod-openapi"
import { cors } from "hono/cors"
import type Stripe from "stripe"

import { type ArtifactCatalog, PAID_ARTIFACTS } from "#artifacts/catalog"
import type { DeclarationDependencies } from "#declare"
import type { EmailProvider } from "#email/provider"
import type { LicenseWorkerEnv } from "#env"
import type { Ledger } from "#ledger/client"
import { registerClaimRoute } from "#routes/claim"
import { registerDeclarationRoutes } from "#routes/declare"
import { registerDownloadRoute } from "#routes/download"
import { registerEvaluationRoute } from "#routes/evaluate"
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
	 * Built from the environment when absent.
	 * A test injects one over a fetch stub.
	 */
	stripe?: Stripe
	now?: () => number
	/**
	 * Reads a declared source URL's license file on re-issuance.
	 *
	 * The platform's `fetch` when absent.
	 * A test scripts one.
	 */
	fetch?: typeof fetch
	/**
	 * The paid artifacts the download route serves.
	 *
	 * The shipped catalog when absent.
	 * A test injects one.
	 */
	artifacts?: ArtifactCatalog
}

export function createLicenseWorkerApp(env: LicenseWorkerEnv, deps: AppDependencies): OpenAPIHono {
	const app = new OpenAPIHono()
	const fulfil = { stripe: deps.stripe ?? stripeClient(env), ledger: deps.ledger, email: deps.email, now: deps.now }

	const declaring: DeclarationDependencies = {
		ledger: deps.ledger,
		email: deps.email,
		fetch: deps.fetch ?? globalThis.fetch.bind(globalThis),
		now: deps.now,
	}

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
	registerRefreshRoute(app, env, declaring)
	registerStatusRoute(app, env, deps.ledger)
	registerDeclarationRoutes(app, env, declaring)
	registerEvaluationRoute(app, env, declaring)
	registerDownloadRoute(app, env, { ledger: deps.ledger, artifacts: deps.artifacts ?? PAID_ARTIFACTS, now: deps.now })

	return app
}
