/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `GET /health`: the issuance switch, the environment's Stripe mode, and the signing self-test's last result. No
 *   customer data, no key material.
 */

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi"

import type { LicenseWorkerEnv } from "#env"

export type SigningStatusReport = "ok" | "mismatch" | "unchecked"

const HealthSchema = z.object({
	issuance: z.boolean(),
	liveMode: z.boolean(),
	signing: z.enum(["ok", "mismatch", "unchecked"]),
})

const healthRoute = createRoute({
	method: "get",
	path: "/health",
	responses: {
		200: {
			description: "Issuance switch, Stripe mode, and the signing self-test's last result.",
			content: { "application/json": { schema: HealthSchema } },
		},
	},
})

export function registerHealthRoute(app: OpenAPIHono, env: LicenseWorkerEnv, signing: () => SigningStatusReport): void {
	app.openapi(healthRoute, (c) =>
		c.json({ issuance: env.issuanceEnabled, liveMode: env.liveMode, signing: signing() }, 200)
	)
}
