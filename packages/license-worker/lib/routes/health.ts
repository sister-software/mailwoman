/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Serves `GET /health`, which reports issuance, Stripe mode, signing, ledger reachability and
 *   long-running email failures without exposing customer or key data.
 *
 *   The route returns 503 only when the ledger is unreachable. Email failures still return 200 with
 *   `email: "failing"`.
 */

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi"
import { sql } from "kysely"

import type { LicenseWorkerEnv } from "#env"
import type { Ledger } from "#ledger/client"
import { countFailedEmailsBefore } from "#ledger/licenses"

/**
 * The result of the most recent signing self-test.
 */
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
 * How long an email must stay failed before the report shows `email: "failing"`.
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

/**
 * Registers `GET /health` on the app.
 */
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
