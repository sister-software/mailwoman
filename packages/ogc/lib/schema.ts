// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Zod schemas, media types and conformance class URIs for the OGC API surface.
 *
 *   The shapes follow the `landingPage`, `confClasses` and `link` schemas of OGC
 *   API Common Part 1 (OGC 19-072), and the `collections` and `collectionDesc`
 *   schemas of OGC API Common Part 2 (OGC 20-024).
 *   The `/search` response follows PDOK's Location API, for which OGC publishes no schema.
 *
 *   Each schema is registered as a component, so the API definition references it by name.
 */

import { z } from "@hono/zod-openapi"
import { featureCollectionSchema, featureSchema } from "@mailwoman/api-kit"

/**
 * The media types this surface serves, keyed by their role.
 */
export const OGCMediaType = {
	JSON: "application/json",
	GeoJSON: "application/geo+json",
	HTML: "text/html",
	OpenAPI30: "application/vnd.oai.openapi+json;version=3.0",
} as const

export type OGCMediaType = (typeof OGCMediaType)[keyof typeof OGCMediaType]

/**
 * The values the `f` query parameter accepts on every resource.
 */
export const OGCFormat = {
	JSON: "json",
	HTML: "html",
} as const

export type OGCFormat = (typeof OGCFormat)[keyof typeof OGCFormat]

/**
 * The link relations the landing page emits.
 *
 * OGC API Common identifies the conformance relation by URI.
 * PDOK's Location API emits both the URI and the short name, and the landing page does the same.
 */
export const OGCLinkRelation = {
	Self: "self",
	Alternate: "alternate",
	ServiceDesc: "service-desc",
	ServiceDoc: "service-doc",
	Conformance: "conformance",
	OGCConformance: "http://www.opengis.net/def/rel/ogc/1.0/conformance",
	Data: "data",
	OGCData: "http://www.opengis.net/def/rel/ogc/1.0/data",
	Search: "search",
} as const

export type OGCLinkRelation = (typeof OGCLinkRelation)[keyof typeof OGCLinkRelation]

const COMMON_PART_1 = "http://www.opengis.net/spec/ogcapi-common-1/1.0/conf"

const COMMON_PART_2 = "http://www.opengis.net/spec/ogcapi-common-2/1.0/conf"

/**
 * The OGC API conformance classes this surface implements.
 *
 * Each one is declared only because a route serves what its requirements ask for:
 *
 * - `core`: HTTP 1.1, and a 400 for an unknown query parameter or an invalid `f` value.
 * - `landing-page`: `GET /` with API definition and conformance links, `GET /conformance`, `GET /api`.
 * - `json`: the landing page, conformance declaration and collections as `application/json`.
 * - `html`: the same resources as HTML5 carrying every link as an `<a>`.
 * - `oas30`: an OpenAPI 3.0 document as `service-desc` and its HTML form as `service-doc`.
 * - `collections` (Common Part 2): `GET /collections` linked from the landing page as `data`,
 *   `GET /collections/{collectionId}` for every listed id, each with `self` and `alternate` links.
 */
export const OGCConformanceClass = {
	Core: `${COMMON_PART_1}/core`,
	LandingPage: `${COMMON_PART_1}/landing-page`,
	JSON: `${COMMON_PART_1}/json`,
	HTML: `${COMMON_PART_1}/html`,
	OAS30: `${COMMON_PART_1}/oas30`,
	Collections: `${COMMON_PART_2}/collections`,
} as const

export type OGCConformanceClass = (typeof OGCConformanceClass)[keyof typeof OGCConformanceClass]

/**
 * A link object from OGC API Common's `link.yaml`.
 */
export const OGCLinkSchema = z
	.object({
		href: z.string(),
		rel: z.string(),
		type: z.string().optional(),
		title: z.string().optional(),
	})
	.openapi("OGCLink")

export type OGCLink = z.infer<typeof OGCLinkSchema>

/**
 * The landing page from OGC API Common's `landingPage.yaml`.
 */
export const OGCLandingPageSchema = z
	.object({
		title: z.string(),
		description: z.string(),
		links: z.array(OGCLinkSchema),
	})
	.openapi("OGCLandingPage")

export type OGCLandingPage = z.infer<typeof OGCLandingPageSchema>

/**
 * The conformance declaration from OGC API Common's `confClasses.yaml`.
 */
export const OGCConformanceSchema = z
	.object({
		conformsTo: z.array(z.string()),
		links: z.array(OGCLinkSchema).optional(),
	})
	.openapi("OGCConformance")

export type OGCConformance = z.infer<typeof OGCConformanceSchema>

const formatParameter = z.enum([OGCFormat.JSON, OGCFormat.HTML]).optional().openapi({
	description: "The response encoding. Without it the `Accept` header decides, and JSON is the default.",
})

/**
 * The query every resource accepts.
 *
 * The object is strict because OGC API Common's core class answers 400 to a query
 * parameter the API definition doesn't name.
 */
export const OGCFormatQuerySchema = z.object({ f: formatParameter }).strict()

/**
 * One collection description, from OGC API Common Part 2's `collectionDesc.yaml`.
 *
 * `id` and `links` are the two members the schema requires.
 * `itemType` is left out because it describes a `/collections/{collectionId}/items`
 * route this surface doesn't serve.
 */
export const OGCCollectionSchema = z
	.object({
		id: z.string(),
		title: z.string(),
		description: z.string(),
		links: z.array(OGCLinkSchema),
		geometryDimension: z.literal(0).openapi({ description: "Every feature in the collection is a point." }),
		version: z.number().int().openapi({
			description: "The collection version, the value `/search` takes in `<collectionId>[version]`, as on PDOK.",
		}),
	})
	.openapi("OGCCollection")

export type OGCCollection = z.infer<typeof OGCCollectionSchema>

/**
 * The collections list, from OGC API Common Part 2's `collections.yaml`.
 */
export const OGCCollectionsSchema = z
	.object({
		links: z.array(OGCLinkSchema),
		collections: z.array(OGCCollectionSchema),
	})
	.openapi("OGCCollections")

export type OGCCollections = z.infer<typeof OGCCollectionsSchema>

/**
 * The path parameter of `/collections/{collectionId}`.
 */
export const OGCCollectionPathSchema = z.object({
	collectionId: z.string().openapi({ param: { name: "collectionId", in: "path" }, example: "addresses" }),
})

/**
 * The properties of one `/search` feature.
 */
export const OGCSearchPropertiesSchema = z
	.object({
		display_name: z.string().openapi({ description: "A one-line label for the matched place or address." }),
		score: z.number().nullable().openapi({
			description:
				"The engine's ranking score for the match, larger ranking higher. Scores compare candidates for one part of the input and have no unit across collections. Null when the engine measured none.",
		}),
		score_unmeasured: z.string().optional().openapi({
			description: "Why `score` is null. Absent when `score` holds a value.",
		}),
		collection_id: z.string().openapi({ description: "The collection the feature belongs to." }),
	})
	.openapi("OGCSearchProperties")

export type OGCSearchProperties = z.infer<typeof OGCSearchPropertiesSchema>

/**
 * One `/search` feature, a GeoJSON point.
 */
export const OGCSearchFeatureSchema = featureSchema(OGCSearchPropertiesSchema).openapi("OGCSearchFeature")

export type OGCSearchFeature = z.infer<typeof OGCSearchFeatureSchema>

/**
 * The `/search` response: a GeoJSON FeatureCollection with the members PDOK's Location API adds.
 */
export const OGCSearchResponseSchema = featureCollectionSchema(OGCSearchFeatureSchema)
	.extend({
		timeStamp: z.string().openapi({ description: "When the response was generated, as an RFC 3339 UTC timestamp." }),
		links: z.array(OGCLinkSchema),
		numberReturned: z.number().int(),
	})
	.openapi("OGCSearchResponse")

export type OGCSearchResponse = z.infer<typeof OGCSearchResponseSchema>

/**
 * The query name that selects a collection for `/search`, in PDOK's form, such as `addresses[version]`.
 */
export function collectionVersionParameter(collectionID: string): string {
	return `${collectionID}[version]`
}

/**
 * The query name that weights a collection for `/search`, in PDOK's form, such as `addresses[relevance]`.
 */
export function collectionRelevanceParameter(collectionID: string): string {
	return `${collectionID}[relevance]`
}

/**
 * The number of `/search` features returned when the request omits `limit`.
 */
export const OGC_SEARCH_DEFAULT_LIMIT = 10

/**
 * The largest `limit` `/search` accepts.
 */
export const OGC_SEARCH_MAX_LIMIT = 50

/**
 * The version every collection reports, and the only value `<collectionId>[version]` accepts.
 */
export const OGC_COLLECTION_VERSION = 1

/**
 * The `/search` query for a service whose collections are `collectionIDs`.
 *
 * The object is strict, as on every resource, and declares each collection's two parameters.
 * A parameter for a collection the service doesn't hold is therefore unknown and answers 400.
 */
export function searchQuerySchema(collectionIDs: readonly string[]) {
	const perCollection: Record<string, z.ZodOptional<z.ZodString>> = {}

	for (const id of collectionIDs) {
		perCollection[collectionVersionParameter(id)] = z
			.string()
			.optional()
			.openapi({
				description: `Restrict the search to the \`${id}\` collection, with any other collection named the same way. The value is the collection version, \`${OGC_COLLECTION_VERSION}\`.`,
			})

		perCollection[collectionRelevanceParameter(id)] = z.string().optional().openapi({
			description: `A number from 0 to 1, accepted for PDOK clients. It doesn't change the ranking, because the engine's scores don't compare across collections.`,
		})
	}

	return z
		.object({
			q: z.string().optional().openapi({ description: "The address or place to search for. Required." }),
			limit: z
				.string()
				.optional()
				.openapi({
					type: "integer",
					description: `The most features to return, from 1 to ${OGC_SEARCH_MAX_LIMIT}. The default is ${OGC_SEARCH_DEFAULT_LIMIT}.`,
				}),
			bbox: z.string().optional().openapi({
				description:
					"Keep only features inside the box `minLon,minLat,maxLon,maxLat`, in WGS 84 longitude and latitude.",
			}),
			f: formatParameter,
			...perCollection,
		})
		.strict()
}
