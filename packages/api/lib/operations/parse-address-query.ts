/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { APIErrorSchema } from "@mailwoman/api-kit"
import type { APIOperation, APIOperationSchema } from "@mailwoman/api-kit/operation"
import { InputModeSchema } from "@mailwoman/core/pipeline"
import { z } from "zod"

import { StampedParseResponseSchema } from "#operations/parse-address"
import { ParsingTag } from "#operations/tags"

/**
 * The query string of {@link ParseAddressQueryOperation}.
 */
export const ParseQuerySchema = z.object({
	address: z.string().optional().meta({ description: "The address to parse." }),
	debug: z.string().optional().meta({ description: '`"true"` to include a diagnostic report.' }),
	input_mode: InputModeSchema.optional(),
})

const ParseAddressQuery = {
	operationId: "parseGet",
	summary: "Parse an address (query string)",
	tags: [ParsingTag.name],
	querystring: ParseQuerySchema,
	response: {
		200: StampedParseResponseSchema,
		400: APIErrorSchema.meta({ description: "`address` is required." }),
		501: APIErrorSchema.meta({ description: "The backing engine method is not wired for this deployment." }),
	},
} as const satisfies APIOperationSchema

/**
 * `GET /v1/parse`: parse the address in the query string.
 */
export const ParseAddressQueryOperation = {
	method: "GET",
	pathname: "/v1/parse",
	schema: ParseAddressQuery,
} as const satisfies APIOperation

export type ParseAddressQueryOperation = typeof ParseAddressQueryOperation
