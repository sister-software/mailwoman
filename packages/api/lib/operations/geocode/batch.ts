/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { APIErrorSchema, stampedResponseSchema } from "@mailwoman/api-kit"
import { type APIOperation, type APIOperationSchema, Ref } from "@mailwoman/api-kit/operation"
import { GeocodeResultSchema } from "@mailwoman/core/geocode"
import { z } from "zod"

import { MAX_ADDRESS_LENGTH } from "#input-limits"
import { GeocoderUnavailableErrorSchema } from "#operations/errors"
import { RequestInputModeSchema } from "#operations/input-mode"
import { GeocodingTag } from "#operations/tags"

/**
 * The request body of {@link GeocodeBatchOperation}.
 */
export const BatchRequestSchema = z
	.object({
		// The `batchMax` cap bounds how many rows arrive.
		// This bounds how large each may be, or one request is 500 unbounded bodies.
		addresses: z.array(z.string().max(MAX_ADDRESS_LENGTH)),
		/**
		 * The register for every row.
		 *
		 * It defaults to `"formatted"`, because batch rows are the record register by nature.
		 */
		input_mode: RequestInputModeSchema.default("formatted"),
	})
	.meta({ id: "BatchRequest" })

export type BatchRequest = z.infer<typeof BatchRequestSchema>

/**
 * The failure slot for one batch row.
 * A row that throws does not fail its neighbors.
 */
export const BatchRowErrorSchema = z
	.object({ input: z.string(), error: z.string() })
	.meta({ id: "BatchRowError", description: "A row that failed, isolated from its neighbors." })

export type BatchRowError = z.infer<typeof BatchRowErrorSchema>

/**
 * One batch row: a geocode result or the row's error.
 */
export const BatchRowSchema = z.union([Ref(GeocodeResultSchema), Ref(BatchRowErrorSchema)])

export type BatchRow = z.infer<typeof BatchRowSchema>

/**
 * One row per input address, in input order.
 */
export const BatchResponseSchema = z
	.object({ results: z.array(BatchRowSchema) })
	.meta({ id: "BatchResponse", description: "One result per input address, in input order." })

export type BatchResponse = z.infer<typeof BatchResponseSchema>

/**
 * {@link BatchResponseSchema} with the engine stamp a route attaches.
 */
export const StampedBatchResponseSchema = stampedResponseSchema(BatchResponseSchema, "StampedBatchResponse")

const GeocodeBatch = {
	operationId: "geocodeBatch",
	summary: "Geocode a batch of addresses",
	tags: [GeocodingTag.name],
	body: Ref(BatchRequestSchema),
	response: {
		200: StampedBatchResponseSchema,
		400: APIErrorSchema.meta({ description: "The body must be `{ addresses: string[] }`." }),
		413: APIErrorSchema.meta({ description: "`addresses.length` exceeds the configured batch cap." }),
		503: GeocoderUnavailableErrorSchema,
	},
} as const satisfies APIOperationSchema

/**
 * `POST /v1/batch`: geocode many addresses, isolating each row's failure.
 */
export const GeocodeBatchOperation = {
	method: "POST",
	pathname: "/v1/batch",
	schema: GeocodeBatch,
} as const satisfies APIOperation

export type GeocodeBatchOperation = typeof GeocodeBatchOperation
