/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `GET /v1/checkout-sessions/:sessionID/license`: the success page's claim. The page arrives with the session id
 *   before Stripe's webhooks do, so a session the ledger has not seen is re-read from Stripe by id and its license row
 *   created here, the same way the webhook would; a session Stripe does not know is the only 404. The refresh secret is
 *   answered by exactly one claim, because the plaintext is cleared in the same statement that reads it. Rate limited
 *   per client address; CORS is the site's exact origin, set by the app.
 */

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi"

import type { LicenseWorkerEnv } from "#env"
import { ensureLicenseFromCheckoutSession, type FulfilDependencies } from "#fulfil"
import { currentToken, findLicenseByCheckoutSession, takePendingRefreshSecret } from "#ledger/licenses"
import { LicenseState } from "#ledger/schema"
import { isStripeNotFound } from "#stripe/client"

const ClaimSchema = z.discriminatedUnion("status", [
	z.object({ status: z.literal("pending") }),
	z.object({ status: z.literal("revoked") }),
	z.object({
		status: z.literal("issued"),
		token: z.string(),
		lid: z.string(),
		licensee: z.string(),
		issued: z.string(),
		expires: z.string(),
		refresh_secret: z.string().optional(),
	}),
])

const ErrorSchema = z.object({ error: z.string() })

const claimRoute = createRoute({
	method: "get",
	path: "/v1/checkout-sessions/{sessionID}/license",
	request: {
		params: z.object({ sessionID: z.string().regex(/^cs_[A-Za-z0-9_]+$/u) }),
	},
	responses: {
		200: {
			description: "Pending until the first invoice is paid; then the token, once with the refresh secret.",
			content: { "application/json": { schema: ClaimSchema } },
		},
		404: {
			description: "Stripe knows no Checkout Session by this id.",
			content: { "application/json": { schema: ErrorSchema } },
		},
		429: {
			description: "Too many claims from this address.",
			content: { "application/json": { schema: ErrorSchema } },
		},
	},
})

export function registerClaimRoute(app: OpenAPIHono, env: LicenseWorkerEnv, deps: FulfilDependencies): void {
	app.openapi(claimRoute, async (c) => {
		const { sessionID } = c.req.valid("param")
		const { success } = await env.CLAIM_LIMITER.limit({ key: c.req.header("cf-connecting-ip") ?? "unknown" })

		if (!success) return c.json({ error: "rate limited" }, 429)

		let license = await findLicenseByCheckoutSession(deps.ledger, sessionID)

		if (!license) {
			let session

			try {
				session = await deps.stripe.checkout.sessions.retrieve(sessionID, { expand: ["line_items"] })
			} catch (error) {
				if (isStripeNotFound(error)) return c.json({ error: "not found" }, 404)

				throw error
			}

			if (session.mode !== "subscription" || session.status !== "complete") {
				return c.json({ status: "pending" as const }, 200)
			}

			license = await ensureLicenseFromCheckoutSession(env, deps, session)
		}

		if (license.license_state === LicenseState.Revoked) return c.json({ status: "revoked" as const }, 200)

		const token = await currentToken(deps.ledger, license.lid)

		if (!token) return c.json({ status: "pending" as const }, 200)

		const refreshSecret = await takePendingRefreshSecret(deps.ledger, license.lid)

		return c.json(
			{
				status: "issued" as const,
				token: token.token,
				lid: license.lid,
				licensee: license.licensee,
				issued: token.issued,
				expires: token.expires,
				...(refreshSecret ? { refresh_secret: refreshSecret } : {}),
			},
			200
		)
	})
}
