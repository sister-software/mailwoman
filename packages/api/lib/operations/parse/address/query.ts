/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { APIErrorSchema } from "@mailwoman/api-kit"
import type { APIOperation, APIOperationSchema } from "@mailwoman/api-kit/operation"
import { z } from "zod"

import { NotImplementedErrorSchema } from "#operations/errors"
import { RequestInputModeSchema } from "#operations/input-mode"
import { StampedParseResponseSchema } from "#operations/parse/address"
import { ParsingTag } from "#operations/tags"

/**
 * The query string of {@link ParseAddressQueryOperation}.
 */
export const ParseQuerySchema = z.object({
	address: z.string().optional().meta({ description: "The address to parse." }),
	debug: z.enum(["true", "false"]).default("false").meta({ description: '`"true"` to include a diagnostic report.' }),
	input_mode: RequestInputModeSchema.default("auto"),
})

const ParseAddressQuery = {
	operationId: "parseAddressQuery",
	summary: "Parse an address (query string)",
	tags: [ParsingTag.name],
	querystring: ParseQuerySchema,
	response: {
		200: StampedParseResponseSchema,
		400: APIErrorSchema.meta({ description: "`address` is required." }),
		501: NotImplementedErrorSchema,
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
