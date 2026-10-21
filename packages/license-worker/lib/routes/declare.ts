/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `POST /v1/declarations` records a declaration of intent and mints its first token. An `open-source` declaration
 *   answers the token and its refresh secret. The other intents answer a claim id, and `GET /v1/declarations/{claimID}`
 *   answers the token once the email has gone out, with the refresh secret exactly once, as the checkout claim does.
 *   Both routes are rate limited per client address.
 */

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi"

import { ClaimResponseSchema } from "#claim-interface"
import { type DeclarationDependencies, issueDeclaration } from "#declare"
import type { LicenseWorkerEnv } from "#env"
import { currentIssuance, findDeclarationByClaim, takePendingDeclarationSecret } from "#ledger/declarations"
import { LicenseState } from "#ledger/schema"
import { clientAddress, withinLimits } from "#routes/rate-limit"

const ErrorSchema = z.object({ error: z.string() })

const NAME = z.string().trim().min(1).max(200)

/**
 * The body of a declaration.
 *
 * The commercial and evaluation intents have their own routes.
 */
export const DeclarationBodySchema = z.object({
	intent: z.enum(["open-source", "non-profit", "academic", "student"]),
	name: NAME,
	sourceURL: z.url().optional(),
	organization: NAME.optional(),
	email: z.email().optional(),
	install: z.uuid().optional(),
})

/**
 * What the declaration route answers: the token and secret for an open-source
 * declaration, or the claim to poll.
 */
export const DeclarationAnswerSchema = z.discriminatedUnion("status", [
	z.object({
		status: z.literal("issued"),
		token: z.string(),
		lid: z.string(),
		secret: z.string(),
		issued: z.string(),
		expires: z.string(),
	}),
	z.object({ status: z.literal("pending"), claim: z.string() }),
])

const declareRoute = createRoute({
	method: "post",
	path: "/v1/declarations",
	request: {
		body: { content: { "application/json": { schema: DeclarationBodySchema } }, required: true },
	},
	responses: {
		200: {
			description: "The token and secret for an open-source declaration, or the claim to poll for the others.",
			content: { "application/json": { schema: DeclarationAnswerSchema } },
		},
		400: {
			description: "A field the intent requires is missing.",
			content: { "application/json": { schema: ErrorSchema } },
		},
		429: {
			description: "Too many declarations from this address.",
			content: { "application/json": { schema: ErrorSchema } },
		},
		503: {
			description: "Issuance is disabled.",
			content: { "application/json": { schema: ErrorSchema } },
		},
	},
})

const claimRoute = createRoute({
	method: "get",
	path: "/v1/declarations/{claimID}",
	request: {
		params: z.object({ claimID: z.string().regex(/^clm_[A-Za-z0-9_-]{22}$/u) }),
	},
	responses: {
		200: {
			description: "Pending until the token is minted; then the token, once with the refresh secret.",
			content: { "application/json": { schema: ClaimResponseSchema } },
		},
		404: {
			description: "No declaration answers to this claim.",
			content: { "application/json": { schema: ErrorSchema } },
		},
		429: {
			description: "Too many claims from this address.",
			content: { "application/json": { schema: ErrorSchema } },
		},
	},
})

export function registerDeclarationRoutes(
	app: OpenAPIHono,
	env: LicenseWorkerEnv,
	deps: DeclarationDependencies
): void {
	app.openapi(declareRoute, async (c) => {
		const body = c.req.valid("json")

		if (!(await withinLimits(env.DECLARE_LIMITER, [`ip:${clientAddress(c)}`]))) {
			return c.json({ error: "rate limited" }, 429)
		}

		const outcome = await issueDeclaration(env, deps, body)

		switch (outcome.outcome) {
			case "issued":
				return c.json(
					{
						status: "issued" as const,
						token: outcome.token,
						lid: outcome.lid,
						secret: outcome.secret,
						issued: outcome.issued,
						expires: outcome.expires,
					},
					200
				)
			case "pending":
				return c.json({ status: "pending" as const, claim: outcome.claim }, 200)
			case "refused":
				return outcome.reason === "issuance_disabled"
					? c.json({ error: "issuance disabled" }, 503)
					: c.json({ error: outcome.reason.replaceAll("_", " ") }, 400)
		}
	})

	app.openapi(claimRoute, async (c) => {
		const { claimID } = c.req.valid("param")

		if (!(await withinLimits(env.DECLARE_LIMITER, [`ip:${clientAddress(c)}`]))) {
			return c.json({ error: "rate limited" }, 429)
		}

		const declaration = await findDeclarationByClaim(deps.ledger, claimID)

		if (!declaration) return c.json({ error: "not found" }, 404)

		if (declaration.license_state === LicenseState.Revoked) return c.json({ status: "revoked" as const }, 200)

		const issuance = await currentIssuance(deps.ledger, declaration.lid)

		if (!issuance) return c.json({ status: "pending" as const }, 200)

		const refreshSecret = await takePendingDeclarationSecret(deps.ledger, declaration.lid)

		return c.json(
			{
				status: "issued" as const,
				token: issuance.token,
				lid: declaration.lid,
				licensee: declaration.licensee,
				issued: issuance.issued,
				expires: issuance.expires,
				...(refreshSecret ? { refresh_secret: refreshSecret } : {}),
			},
			200
		)
	})
}
