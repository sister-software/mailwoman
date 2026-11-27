// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { APIErrorSchema, stampedResponseSchema } from "@mailwoman/api-kit"
import { type APIOperation, type APIOperationSchema, Ref } from "@mailwoman/api-kit/operation"
import { AddressTreeSchema } from "@mailwoman/core/decoder"
import { GeocodeResultSchema } from "@mailwoman/core/geocode"
import { InputModeSelectionSchema } from "@mailwoman/core/pipeline"
import { z } from "zod"

import { MAX_ADDRESS_LENGTH, MAX_BIAS_POINTS } from "#input-limits"
import { GeocoderUnavailableErrorSchema } from "#operations/errors"
import { GeocodingTag } from "#operations/tags"
import { SupportPromiseSchema } from "#support"

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
 * A place that scopes every lookup of a request, such as the borough or country the caller already knows.
 */
export const GeocodeParentSchema = z
	.object({
		/**
		 * The Who's On First id of the parent place.
		 */
		id: z.number().int().positive(),
		/**
		 * How the parent acts.
		 *
		 * `hard` keeps only places whose lineage agrees with the parent: places inside it,
		 * the parent and its ancestors.
		 * `soft` ranks the places inside it first and prefers its country,
		 * so a much larger place elsewhere can still answer.
		 */
		scope: z.enum(["hard", "soft"]).default("hard"),
	})
	.meta({ id: "GeocodeParent", description: "A place that scopes every lookup of the request." })

export type GeocodeParent = z.infer<typeof GeocodeParentSchema>

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
		 * It doesn't move a coordinate or add a candidate.
		 */
		bias: z.array(Ref(GeocodeBiasPointSchema)).max(MAX_BIAS_POINTS).default([]),
		/**
		 * A place that scopes every lookup, or null for none.
		 *
		 * A hard parent's excluded places are listed in `candidates` with `outsideScope`.
		 * An id the gazetteer doesn't hold fails the request.
		 */
		parent: Ref(GeocodeParentSchema).nullable().default(null),
		/**
		 * Whether the response includes the decoded address tree, the tree `POST /v1/parse` returns.
		 *
		 * A caller that renders spans and confidences sets it and sends one request instead of two.
		 */
		include_tree: z.boolean().default(false),
		/**
		 * The reading the caller expects, an outcome kind such as `natural.mountain`.
		 *
		 * It orders the candidates that satisfy it first and removes none.
		 * When the text decided another answer, the response lists the `outcome_hint_unsatisfied` advisory.
		 */
		outcome_hint: z.string().optional(),
		/**
		 * The outcome kinds the caller admits.
		 *
		 * A place is admissible when it satisfies one of them, and a filter that admits zero
		 * places answers zero places with the `outcome_filter_empty` advisory.
		 * An id outside the vocabulary, or a hint the filter excludes, fails the request.
		 */
		outcome_filter: z.array(z.string()).optional(),
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
	/**
	 * The support promise the query falls inside, matched on the resolved country and the query's script.
	 *
	 * It is null when no promise covers the query, such as a country Mailwoman makes
	 * no promise for or text in a script no promise names.
	 * A null value places the result outside every guarantee, and the result may still be right.
	 */
	support: Ref(SupportPromiseSchema).nullable(),
}).meta({
	id: "GeocodeResponse",
	description: "One geocoded address, with its decoded tree when the request asked for it.",
})

export type GeocodeResponse = z.infer<typeof GeocodeResponseSchema>

/**
 * The geocode an engine returns: the response before the route matches its support promise.
 */
export type EngineGeocodeResponse = Omit<GeocodeResponse, "support">

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
		400: APIErrorSchema.meta({
			description: "`address` is required, or the request's outcome fields were refused.",
		}),
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
