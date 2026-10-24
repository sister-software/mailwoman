/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { APIErrorSchema, stampedResponseSchema } from "@mailwoman/api-kit"
import { type APIOperation, type APIOperationSchema, Ref } from "@mailwoman/api-kit/operation"
import { AddressTreeSchema } from "@mailwoman/core/decoder"
import { GeocodeResultSchema } from "@mailwoman/core/geocode"
import { InputModeSelectionSchema } from "@mailwoman/core/pipeline"
import { z } from "zod"

import { MAX_ADDRESS_LENGTH, MAX_BIAS_POINTS } from "#input-limits"
import { GeocoderUnavailableErrorSchema } from "#operations/errors"
import { GeocodingTag } from "#operations/tags"

/**
 * A point the resolver prefers candidates near, such as the center of the map a person is looking at.
 */
export const GeocodeBiasPointSchema = z
	.object({
		lat: z.number().min(-90).max(90),
		lon: z.number().min(-180).max(180),
		/**
		 * How strongly this point pulls, relative to the request's other points.
		 *
		 * @defaultValue 1
		 */
		weight: z.number().positive().max(1).optional(),
	})
	.meta({ id: "GeocodeBiasPoint", description: "A point the resolver prefers candidates near." })

export type GeocodeBiasPoint = z.infer<typeof GeocodeBiasPointSchema>

/**
 * The request body of {@link GeocodeAddressOperation}.
 */
export const GeocodeRequestSchema = z
	.object({
		address: z.string().max(MAX_ADDRESS_LENGTH),
		input_mode: InputModeSelectionSchema.default("auto"),
		/**
		 * Points the resolver prefers candidates near, such as a map viewport's center and the device location.
		 *
		 * Bias reorders candidates of comparable rank.
		 * It does not move a coordinate or add a candidate.
		 */
		bias: z.array(Ref(GeocodeBiasPointSchema)).max(MAX_BIAS_POINTS).default([]),
		/**
		 * Whether the response includes the decoded address tree, the tree `POST /v1/parse` returns.
		 *
		 * A caller that renders spans and confidences sets it and sends one request instead of two.
		 */
		include_tree: z.boolean().default(false),
	})
	.meta({ id: "GeocodeRequest" })

export type GeocodeRequest = z.infer<typeof GeocodeRequestSchema>

/**
 * The response body of {@link GeocodeAddressOperation}: one geocoded address,
 * with its decoded tree when the request asked for it.
 */
export const GeocodeResponseSchema = GeocodeResultSchema.extend({
	/**
	 * The decoded address tree the coordinate was resolved from.
	 *
	 * It is null unless the request set `include_tree`.
	 */
	tree: Ref(AddressTreeSchema).nullable(),
}).meta({
	id: "GeocodeResponse",
	description: "One geocoded address, with its decoded tree when the request asked for it.",
})

export type GeocodeResponse = z.infer<typeof GeocodeResponseSchema>

/**
 * {@link GeocodeResponseSchema} with the engine stamp a route attaches.
 */
export const StampedGeocodeResponseSchema = stampedResponseSchema(GeocodeResponseSchema, "StampedGeocodeResponse")

const GeocodeAddress = {
	operationId: "geocodeAddress",
	summary: "Geocode an address to coordinates",
	tags: [GeocodingTag.name],
	body: Ref(GeocodeRequestSchema),
	response: {
		200: StampedGeocodeResponseSchema,
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
