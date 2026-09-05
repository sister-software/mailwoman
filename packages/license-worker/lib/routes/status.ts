/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `POST /v1/license-status`: a lid answers one of four words and nothing else. No licensee, no dates, no reason: an
 *   installation checking online learns whether its key still stands, and a stranger with a lid learns only that.
 */

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi"

import type { LicenseWorkerEnv } from "#env"
import type { Ledger } from "#ledger/client"
import { findLicense } from "#ledger/licenses"
import { publicLicenseStatus } from "#ledger/schema"
import { LicenseIDSchema } from "#routes/refresh"

const StatusSchema = z.object({ status: z.enum(["active", "lapsed", "revoked", "unknown"]) })

const ErrorSchema = z.object({ error: z.string() })

const statusRoute = createRoute({
	method: "post",
	path: "/v1/license-status",
	request: {
		body: { content: { "application/json": { schema: z.object({ lid: LicenseIDSchema }) } }, required: true },
	},
	responses: {
		200: {
			description: "The license's public state; `unknown` for a lid this worker never minted.",
			content: { "application/json": { schema: StatusSchema } },
		},
		429: {
			description: "Too many checks for this lid.",
			content: { "application/json": { schema: ErrorSchema } },
		},
	},
})

export function registerStatusRoute(app: OpenAPIHono, env: LicenseWorkerEnv, ledger: Ledger): void {
	app.openapi(statusRoute, async (c) => {
		const { lid } = c.req.valid("json")
		const { success } = await env.STATUS_LIMITER.limit({ key: lid })

		if (!success) return c.json({ error: "rate limited" }, 429)

		const license = await findLicense(ledger, lid)

		return c.json({ status: license ? publicLicenseStatus(license.license_state) : "unknown" }, 200)
	})
}
