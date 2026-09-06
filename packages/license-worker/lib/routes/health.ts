/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `GET /health`: the issuance switch, the environment's Stripe mode, the signing self-test's last result, whether the
 *   ledger answers a query, and whether any token's email has stayed `failed` for over an hour. 503 when the ledger
 *   does not answer, so a monitor sees a worker that cannot mint or answer a claim; a failing email is a 200 with
 *   `email: failing`, since the worker itself is well and the remedy is at the provider. One route, so one external
 *   check covers both alerts. No customer data, no key material.
 */

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi"
import { sql } from "kysely"

import type { LicenseWorkerEnv } from "#env"
import type { Ledger } from "#ledger/client"
import { countFailedEmailsBefore } from "#ledger/licenses"

export type SigningStatusReport = "ok" | "mismatch" | "unchecked"

const HealthSchema = z.object({
	issuance: z.boolean(),
	liveMode: z.boolean(),
	signing: z.enum(["ok", "mismatch", "unchecked"]),
	ledger: z.enum(["ok", "unreachable"]),
	email: z.enum(["ok", "failing"]),
})

const healthRoute = createRoute({
	method: "get",
	path: "/health",
	responses: {
		200: {
			description:
				"Issuance switch, Stripe mode, the signing self-test's last result, a reachable ledger, and whether an email has stayed failed for over an hour.",
			content: { "application/json": { schema: HealthSchema } },
		},
		503: {
			description: "The same report, when the ledger did not answer.",
			content: { "application/json": { schema: HealthSchema } },
		},
	},
})

/**
 * How long a failed email may stand before the report says so: past the mint's own attempt, short of the next resend.
 */
const EMAIL_FAILURE_GRACE_MS = 60 * 60 * 1000

async function ledgerAnswers(ledger: Ledger): Promise<boolean> {
	try {
		await sql`select 1`.execute(ledger)

		return true
	} catch {
		return false
	}
}

async function emailReport(ledger: Ledger, now: () => number): Promise<"ok" | "failing"> {
	const cutoff = new Date(now() - EMAIL_FAILURE_GRACE_MS).toISOString()

	return (await countFailedEmailsBefore(ledger, cutoff)) > 0 ? "failing" : "ok"
}

export function registerHealthRoute(
	app: OpenAPIHono,
	env: LicenseWorkerEnv,
	signing: () => SigningStatusReport,
	ledger: Ledger,
	now: () => number = Date.now
): void {
	app.openapi(healthRoute, async (c) => {
		const reachable = await ledgerAnswers(ledger)

		const report = {
			issuance: env.issuanceEnabled,
			liveMode: env.liveMode,
			signing: signing(),
			ledger: reachable ? ("ok" as const) : ("unreachable" as const),
			email: reachable ? await emailReport(ledger, now) : ("ok" as const),
		}

		return reachable ? c.json(report, 200) : c.json(report, 503)
	})
}
