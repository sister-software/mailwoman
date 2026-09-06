/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   What the claim route answers, as one schema: the route publishes it in the OpenAPI document and answers by it, the
 *   success page's fetch and the rehearsal read by it, and their TypeScript types are inferred from it. Browser-safe:
 *   zod and nothing else.
 */

import { z } from "zod"

/**
 * The three answers: `pending` until the first invoice is paid, `revoked` after a full refund or a dispute, and the
 * token with its dates once minted, carrying the refresh secret on the one claim that reads it.
 */
export const ClaimResponseSchema = z.discriminatedUnion("status", [
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

export type ClaimResponse = z.infer<typeof ClaimResponseSchema>

export type IssuedClaim = Extract<ClaimResponse, { status: "issued" }>

/**
 * A decoded body as a claim, or `undefined` for a body of another shape: a 200 whose fields are missing is no claim.
 */
export function parseClaimResponse(body: unknown): ClaimResponse | undefined {
	const parsed = ClaimResponseSchema.safeParse(body)

	return parsed.success ? parsed.data : undefined
}
