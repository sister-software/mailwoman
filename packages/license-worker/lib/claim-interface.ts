/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Defines the schema used by the claim route and published in its OpenAPI document.
 * The success page and rehearsal use this schema for their responses. TypeScript types are inferred from it.
 */

import { z } from "zod"

/**
 * The lifecycle states are `pending` until the first invoice is paid, `revoked`
 * after a full refund or dispute, and `issued` once the token is minted.
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
 * Returns `undefined` for a body that does not match the schema, so a 200
 * whose fields are missing is no claim.
 */
export function parseClaimResponse(body: unknown): ClaimResponse | undefined {
	const parsed = ClaimResponseSchema.safeParse(body)

	return parsed.success ? parsed.data : undefined
}
