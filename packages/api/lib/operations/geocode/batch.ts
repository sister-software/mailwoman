// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { APIErrorSchema, stampedResponseSchema } from "@mailwoman/api-kit"
import { type APIOperation, type APIOperationSchema, Ref } from "@mailwoman/api-kit/operation"
import { GeocodeResultSchema } from "@mailwoman/core/geocode"
import { InputModeSelectionSchema } from "@mailwoman/core/pipeline"
import { z } from "zod"

import { MAX_ADDRESS_LENGTH } from "#input-limits"
import { GeocoderUnavailableErrorSchema } from "#operations/errors"
import { GeocodingTag } from "#operations/tags"
import { SupportPromiseSchema } from "#support"

/**
 * The request body of {@link GeocodeBatchOperation}.
 */
export const BatchRequestSchema = z
	.object({
		// The `batchMax` cap bounds the number of rows that arrive.
		// This bounds how large each may be, or one request is 500 unbounded bodies.
		addresses: z.array(z.string().max(MAX_ADDRESS_LENGTH)),
		/**
		 * The register for every row.
		 *
		 * @defaultValue `"formatted"`, because batch rows are the record register by nature.
		 */
		input_mode: InputModeSelectionSchema.default("formatted"),
	})
	.meta({ id: "BatchRequest" })

export type BatchRequest = z.infer<typeof BatchRequestSchema>

/**
 * The failure slot for one batch row.
 * A row that throws doesn't fail its neighbors.
 */
export const BatchRowErrorSchema = z
	.object({ input: z.string(), error: z.string() })
	.meta({ id: "BatchRowError", description: "A row that failed, isolated from its neighbors." })

export type BatchRowError = z.infer<typeof BatchRowErrorSchema>

/**
 * One geocoded batch row, with the support promise its query falls inside.
 */
export const BatchGeocodeResultSchema = GeocodeResultSchema.extend({
	/**
	 * The support promise the row's query falls inside, or null when no promise covers it.
	 */
	support: Ref(SupportPromiseSchema).nullable(),
}).meta({ id: "BatchGeocodeResult", description: "One geocoded batch row, with the support promise it falls inside." })

/**
 * One batch row: a geocode result or the row's error.
 */
export const BatchRowSchema = z.union([Ref(BatchGeocodeResultSchema), Ref(BatchRowErrorSchema)])

export type BatchRow = z.infer<typeof BatchRowSchema>

/**
 * One row per input address, in input order.
 */
export const BatchResponseSchema = z
	.object({ results: z.array(BatchRowSchema) })
	.meta({ id: "BatchResponse", description: "One result per input address, in input order." })

export type BatchResponse = z.infer<typeof BatchResponseSchema>

/**
 * The batch an engine returns: each geocoded row before the route matches its support promise.
 */
export interface EngineBatchResponse {
	results: EngineBatchRow[]
}

/**
 * One row an engine returns: a geocode result before the route matches its
 * support promise, or the row's error.
 */
export type EngineBatchRow = Omit<z.infer<typeof BatchGeocodeResultSchema>, "support"> | BatchRowError

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
 * `POST /v1/batch`: geocode a list of addresses, isolating each row's failure.
 */
export const GeocodeBatchOperation = {
	method: "POST",
	pathname: "/v1/batch",
	schema: GeocodeBatch,
} as const satisfies APIOperation

export type GeocodeBatchOperation = typeof GeocodeBatchOperation
