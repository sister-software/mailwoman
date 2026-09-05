/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `POST /v1/licenses/refresh`: the lid and its secret answer the current token. A wrong secret and an unknown lid
 *   answer the same body, so the route confirms nothing about which lids exist. Rate limited per lid, which is what an
 *   attacker guessing secrets holds constant, and per address independently, so a stranger who learns a lid cannot
 *   spend its owner's allowance.
 */

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi"

import type { LicenseWorkerEnv } from "#env"
import { secretDigest, secretDigestsMatch } from "#identifiers"
import type { Ledger } from "#ledger/client"
import { currentToken, findLicense } from "#ledger/licenses"
import { LicenseState } from "#ledger/schema"
import { clientAddress, withinLimits } from "#routes/rate-limit"

/**
 * A license id as `newLicenseID` mints it: `lic_` plus 22 url-safe characters. Anything else is refused before a query
 * runs.
 */
export const LicenseIDSchema = z.string().regex(/^lic_[A-Za-z0-9_-]{22}$/u)

const RefreshBodySchema = z.object({
	lid: LicenseIDSchema,
	secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
})

const RefreshSchema = z.discriminatedUnion("status", [
	z.object({ status: z.literal("active"), token: z.string(), issued: z.string(), expires: z.string() }),
	z.object({ status: z.literal("pending") }),
	z.object({ status: z.literal("lapsed") }),
	z.object({ status: z.literal("revoked") }),
])

const ErrorSchema = z.object({ error: z.string() })

const refreshRoute = createRoute({
	method: "post",
	path: "/v1/licenses/refresh",
	request: {
		body: { content: { "application/json": { schema: RefreshBodySchema } }, required: true },
	},
	responses: {
		200: {
			description: "The current token for an active license, or the state that withholds one.",
			content: { "application/json": { schema: RefreshSchema } },
		},
		404: {
			description: "No license answers to this lid and secret.",
			content: { "application/json": { schema: ErrorSchema } },
		},
		429: {
			description: "Too many refreshes for this lid or from this address.",
			content: { "application/json": { schema: ErrorSchema } },
		},
	},
})

export function registerRefreshRoute(app: OpenAPIHono, env: LicenseWorkerEnv, ledger: Ledger): void {
	app.openapi(refreshRoute, async (c) => {
		const { lid, secret } = c.req.valid("json")

		if (!(await withinLimits(env.REFRESH_LIMITER, [`lid:${lid}`, `ip:${clientAddress(c)}`]))) {
			return c.json({ error: "rate limited" }, 429)
		}

		const license = await findLicense(ledger, lid)
		const digest = await secretDigest(secret)

		// The digest is computed before the lookup is consulted, so a missing lid costs the same work as a wrong secret.
		if (!license || !secretDigestsMatch(license.refresh_secret_sha256, digest)) {
			return c.json({ error: "not found" }, 404)
		}

		if (license.license_state === LicenseState.Revoked || license.license_state === LicenseState.Lapsed) {
			return c.json({ status: license.license_state }, 200)
		}

		const token = await currentToken(ledger, lid)

		if (!token) return c.json({ status: "pending" as const }, 200)

		return c.json({ status: "active" as const, token: token.token, issued: token.issued, expires: token.expires }, 200)
	})
}
