/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { APIErrorSchema } from "@mailwoman/api-kit"
import { type APIOperation, type APIOperationSchema, Ref } from "@mailwoman/api-kit/operation"
import { POIQueryResultSchema } from "@mailwoman/core/pipeline"
import { z } from "zod"

import { MAX_ADDRESS_LENGTH } from "#input-limits"
import { NotImplementedErrorSchema } from "#operations/errors"
import { POITag } from "#operations/tags"

/**
 * The request body of {@link SearchPOIOperation}.
 */
export const POISearchRequestSchema = z
	.object({
		query: z.string().max(MAX_ADDRESS_LENGTH).meta({ description: "The POI query, such as `cafe near Paris`." }),
	})
	.meta({ id: "POISearchRequest" })

export type POISearchRequest = z.infer<typeof POISearchRequestSchema>

/**
 * The answer when the query did not read as a POI query.
 */
export const NotPOIQuerySchema = z
	.object({ type: z.literal("not_poi_query") })
	.meta({ id: "NotPOIQuery", description: "The query did not read as a POI query." })

export type NotPOIQuery = z.infer<typeof NotPOIQuerySchema>

/**
 * A POI intent with its results, an abstention, or {@link NotPOIQuerySchema}.
 */
export const POISearchResponseSchema = z
	.union([Ref(POIQueryResultSchema), Ref(NotPOIQuerySchema)])
	.meta({ id: "POISearchResponse", description: "The POI intent and results, an abstention, or not a POI query." })

export type POISearchResponse = z.infer<typeof POISearchResponseSchema>

const SearchPOI = {
	operationId: "searchPOI",
	summary: "Search for points of interest",
	tags: [POITag.name],
	body: Ref(POISearchRequestSchema),
	response: {
		200: POISearchResponseSchema,
		400: APIErrorSchema.meta({ description: "`query` is required." }),
		501: NotImplementedErrorSchema,
	},
} as const satisfies APIOperationSchema

/**
 * `POST /v1/poi`: run a POI query.
 */
export const SearchPOIOperation = {
	method: "POST",
	pathname: "/v1/poi",
	schema: SearchPOI,
} as const satisfies APIOperation

export type SearchPOIOperation = typeof SearchPOIOperation
