/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `POST /v1/evaluations` issues a thirty-day token to an email address, once per address. The token travels by
 *   email and the response answers the claim the CLI polls. A second request for an address answers 409. The route
 *   therefore confirms that an address has been used. That is the one fact the one-per-address rule has to reveal.
 */

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi"

import { type DeclarationDependencies, issueDeclaration } from "#declare"
import type { LicenseWorkerEnv } from "#env"
import { clientAddress, withinLimits } from "#routes/rate-limit"

const ErrorSchema = z.object({ error: z.string() })

/**
 * The body of an evaluation request: the address the token travels to,
 * the evaluator's name, and the installation id.
 */
export const EvaluationBodySchema = z.object({
	email: z.email(),
	name: z.string().trim().min(1).max(200),
	install: z.uuid().optional(),
})

const evaluateRoute = createRoute({
	method: "post",
	path: "/v1/evaluations",
	request: {
		body: { content: { "application/json": { schema: EvaluationBodySchema } }, required: true },
	},
	responses: {
		200: {
			description: "The claim to poll while the token travels to the address.",
			content: { "application/json": { schema: z.object({ status: z.literal("pending"), claim: z.string() }) } },
		},
		409: {
			description: "This address has received its evaluation.",
			content: { "application/json": { schema: ErrorSchema } },
		},
		429: {
			description: "Too many evaluations from this address.",
			content: { "application/json": { schema: ErrorSchema } },
		},
		503: {
			description: "Issuance is disabled.",
			content: { "application/json": { schema: ErrorSchema } },
		},
	},
})

export function registerEvaluationRoute(app: OpenAPIHono, env: LicenseWorkerEnv, deps: DeclarationDependencies): void {
	app.openapi(evaluateRoute, async (c) => {
		const body = c.req.valid("json")

		if (!(await withinLimits(env.EVALUATE_LIMITER, [`ip:${clientAddress(c)}`]))) {
			return c.json({ error: "rate limited" }, 429)
		}

		const outcome = await issueDeclaration(env, deps, { ...body, intent: "evaluation" })

		switch (outcome.outcome) {
			case "pending":
				return c.json({ status: "pending" as const, claim: outcome.claim }, 200)
			case "refused":
				if (outcome.reason === "evaluation_exists") return c.json({ error: "evaluation exists" }, 409)

				if (outcome.reason === "issuance_disabled") return c.json({ error: "issuance disabled" }, 503)

				throw new Error(`evaluation refused for ${outcome.reason}, which this route cannot produce`)
			case "issued":
				throw new Error("an evaluation answers a claim, never the token")
		}
	})
}
