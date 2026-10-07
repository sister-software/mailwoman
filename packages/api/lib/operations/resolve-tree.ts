/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { APIErrorSchema, stampedResponseSchema } from "@mailwoman/api-kit"
import { type APIOperation, type APIOperationSchema, Ref } from "@mailwoman/api-kit/operation"
import { AddressTreeSchema } from "@mailwoman/core/decoder"
import { z } from "zod"

import { ResolvingTag } from "#operations/tags"

/**
 * The request body of {@link ResolveTreeOperation}: an already-decoded tree, the parser's output.
 */
export const ResolveRequestSchema = z
	.object({
		tree: Ref(AddressTreeSchema),
		opts: z.looseObject({}).default({}).meta({ description: "Resolver options." }),
	})
	.meta({ id: "ResolveRequest" })

export type ResolveRequest = z.infer<typeof ResolveRequestSchema>

/**
 * The same tree, decorated in place with gazetteer coordinates and attribution.
 */
export const ResolveResponseSchema = z
	.object({ tree: Ref(AddressTreeSchema) })
	.meta({ id: "ResolveResponse", description: "The tree, decorated with gazetteer coordinates and attribution." })

export type ResolveResponse = z.infer<typeof ResolveResponseSchema>

/**
 * {@link ResolveResponseSchema} with the engine stamp a route attaches.
 */
export const StampedResolveResponseSchema = stampedResponseSchema(ResolveResponseSchema, "StampedResolveResponse")

const ResolveTree = {
	operationId: "resolveTree",
	summary: "Resolve an already-decoded address tree against the gazetteer",
	tags: [ResolvingTag.name],
	body: Ref(ResolveRequestSchema),
	response: {
		200: StampedResolveResponseSchema,
		400: APIErrorSchema.meta({ description: "The body must be `{ tree: AddressTree, opts? }`." }),
		503: APIErrorSchema.meta({ description: "The resolver is not wired for this deployment (dependencies missing)." }),
	},
} as const satisfies APIOperationSchema

/**
 * `POST /v1/resolve`: resolve a decoded tree against the gazetteer.
 */
export const ResolveTreeOperation = {
	method: "POST",
	pathname: "/v1/resolve",
	schema: ResolveTree,
} as const satisfies APIOperation

export type ResolveTreeOperation = typeof ResolveTreeOperation
