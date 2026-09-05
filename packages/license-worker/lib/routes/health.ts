/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `GET /health`: the issuance switch, the environment's Stripe mode, the signing self-test's last result, and whether
 *   the ledger answers a query. 503 when the ledger does not, so a monitor sees a worker that cannot mint or answer a
 *   claim. No customer data, no key material.
 */

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi"
import { sql } from "kysely"

import type { LicenseWorkerEnv } from "#env"
import type { Ledger } from "#ledger/client"

export type SigningStatusReport = "ok" | "mismatch" | "unchecked"

const HealthSchema = z.object({
	issuance: z.boolean(),
	liveMode: z.boolean(),
	signing: z.enum(["ok", "mismatch", "unchecked"]),
	ledger: z.enum(["ok", "unreachable"]),
})

const healthRoute = createRoute({
	method: "get",
	path: "/health",
	responses: {
		200: {
			description: "Issuance switch, Stripe mode, the signing self-test's last result, and a reachable ledger.",
			content: { "application/json": { schema: HealthSchema } },
		},
		503: {
			description: "The same report, when the ledger did not answer.",
			content: { "application/json": { schema: HealthSchema } },
		},
	},
})

async function ledgerAnswers(ledger: Ledger): Promise<boolean> {
	try {
		await sql`select 1`.execute(ledger)

		return true
	} catch {
		return false
	}
}

export function registerHealthRoute(
	app: OpenAPIHono,
	env: LicenseWorkerEnv,
	signing: () => SigningStatusReport,
	ledger: Ledger
): void {
	app.openapi(healthRoute, async (c) => {
		const reachable = await ledgerAnswers(ledger)

		const report = {
			issuance: env.issuanceEnabled,
			liveMode: env.liveMode,
			signing: signing(),
			ledger: reachable ? ("ok" as const) : ("unreachable" as const),
		}

		return reachable ? c.json(report, 200) : c.json(report, 503)
	})
}
