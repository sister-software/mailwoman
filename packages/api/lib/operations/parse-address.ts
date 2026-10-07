/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { APIErrorSchema, stampedResponseSchema } from "@mailwoman/api-kit"
import { type APIOperation, type APIOperationSchema, Ref } from "@mailwoman/api-kit/operation"
import { AddressTreeSchema, ParseComponentSchema } from "@mailwoman/core/decoder"
import { InputModeSchema } from "@mailwoman/core/pipeline"
import { z } from "zod"

import { MAX_ADDRESS_LENGTH } from "#input-limits"
import { ParsingTag } from "#operations/tags"

/**
 * The request body of {@link ParseAddressOperation}.
 */
export const ParseRequestSchema = z
	.object({
		address: z.string().max(MAX_ADDRESS_LENGTH),
		debug: z.boolean().optional(),
		input_mode: InputModeSchema.optional(),
	})
	.meta({ id: "ParseRequest" })

export type ParseRequest = z.infer<typeof ParseRequestSchema>

/**
 * A parsed address: its components in reading order and the decoded tree.
 */
export const ParseResponseSchema = z
	.object({
		input: z.string(),
		components: z.array(Ref(ParseComponentSchema)),
		tree: Ref(AddressTreeSchema),
		debug: z.string().nullable(),
	})
	.meta({ id: "ParseResponse", description: "The parsed components and decoded tree." })

export type ParseResponse = z.infer<typeof ParseResponseSchema>

/**
 * {@link ParseResponseSchema} with the engine stamp a route attaches.
 */
export const StampedParseResponseSchema = stampedResponseSchema(ParseResponseSchema, "StampedParseResponse")

const ParseAddress = {
	operationId: "parsePost",
	summary: "Parse an address (JSON body)",
	tags: [ParsingTag.name],
	body: Ref(ParseRequestSchema),
	response: {
		200: StampedParseResponseSchema,
		400: APIErrorSchema.meta({ description: "`address` is required." }),
		501: APIErrorSchema.meta({ description: "The backing engine method is not wired for this deployment." }),
	},
} as const satisfies APIOperationSchema

/**
 * `POST /v1/parse`: parse the address in a JSON body.
 */
export const ParseAddressOperation = {
	method: "POST",
	pathname: "/v1/parse",
	schema: ParseAddress,
} as const satisfies APIOperation

export type ParseAddressOperation = typeof ParseAddressOperation
