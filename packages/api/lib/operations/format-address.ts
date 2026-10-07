/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { APIErrorSchema, stampedResponseSchema } from "@mailwoman/api-kit"
import { type APIOperation, type APIOperationSchema, Ref } from "@mailwoman/api-kit/operation"
import { z } from "zod"

import { FormattingTag } from "#operations/tags"

/**
 * One component's value.
 *
 * Repeatable tags, such as a street with two names, arrive as an array.
 */
const ComponentValueSchema = z.union([z.string(), z.array(z.string())])

/**
 * The request body of {@link FormatAddressOperation}.
 *
 * A route collapses array values to their first span, because the formatter takes one string per tag.
 */
export const FormatRequestSchema = z
	.object({
		components: z.record(z.string(), ComponentValueSchema),
		country: z.string(),
		options: z.looseObject({}).default({}).meta({ description: "Formatter options." }),
	})
	.meta({ id: "FormatRequest" })

export type FormatRequest = z.infer<typeof FormatRequestSchema>

/**
 * The rendered string plus the deterministic canonical match key.
 */
export const FormatResponseSchema = z
	.object({ formatted: z.string(), canonicalKey: z.string() })
	.meta({ id: "FormatResponse", description: "The rendered address and its canonical match key." })

export type FormatResponse = z.infer<typeof FormatResponseSchema>

/**
 * {@link FormatResponseSchema} with the engine stamp a route attaches.
 */
export const StampedFormatResponseSchema = stampedResponseSchema(FormatResponseSchema, "StampedFormatResponse")

const FormatAddress = {
	operationId: "formatAddress",
	summary: "Render address components to a string and canonical match key",
	tags: [FormattingTag.name],
	body: Ref(FormatRequestSchema),
	response: {
		200: StampedFormatResponseSchema,
		400: APIErrorSchema.meta({ description: "Invalid request body." }),
	},
} as const satisfies APIOperationSchema

/**
 * `POST /v1/format`: render components into an address string.
 */
export const FormatAddressOperation = {
	method: "POST",
	pathname: "/v1/format",
	schema: FormatAddress,
} as const satisfies APIOperation

export type FormatAddressOperation = typeof FormatAddressOperation
