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
 * The request body of {@link GeocodeAddressOperation}.
 */
export const GeocodeRequestSchema = z
	.object({
		address: z.string().max(MAX_ADDRESS_LENGTH),
		input_mode: RequestInputModeSchema.default("auto"),
	})
	.meta({ id: "GeocodeRequest" })

export type GeocodeRequest = z.infer<typeof GeocodeRequestSchema>

/**
 * {@link GeocodeResultSchema} with the engine stamp a route attaches.
 */
export const StampedGeocodeResultSchema = stampedResponseSchema(GeocodeResultSchema, "StampedGeocodeResult")

const GeocodeAddress = {
	operationId: "geocodeAddress",
	summary: "Geocode an address to coordinates",
	tags: [GeocodingTag.name],
	body: Ref(GeocodeRequestSchema),
	response: {
		200: StampedGeocodeResultSchema,
		400: APIErrorSchema.meta({ description: "`address` is required." }),
		503: GeocoderUnavailableErrorSchema,
	},
} as const satisfies APIOperationSchema

/**
 * `POST /v1/geocode`: geocode one address.
 */
export const GeocodeAddressOperation = {
	method: "POST",
	pathname: "/v1/geocode",
	schema: GeocodeAddress,
} as const satisfies APIOperation

export type GeocodeAddressOperation = typeof GeocodeAddressOperation
