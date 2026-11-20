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
import { BBoxSchema, featureCollectionSchema, featureSchema } from "@mailwoman/api-kit"

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
	Items: "items",
	Next: "next",
	Collection: "collection",
	License: "license",
	Via: "via",
} as const

export type OGCLinkRelation = (typeof OGCLinkRelation)[keyof typeof OGCLinkRelation]

const COMMON_PART_1 = "http://www.opengis.net/spec/ogcapi-common-1/1.0/conf"

const COMMON_PART_2 = "http://www.opengis.net/spec/ogcapi-common-2/1.0/conf"

const FEATURES_PART_1 = "http://www.opengis.net/spec/ogcapi-features-1/1.0/conf"

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
 * - Features Part 1 `core`: `GET /collections/{collectionId}/items` with `limit`,
 *   `bbox` and `datetime`, and `GET /collections/{collectionId}/items/{featureId}`,
 *   for each collection whose description lists an `items` link.
 * - Features Part 1 `geojson`: both items resources as `application/geo+json`.
 * - Features Part 1 `html`: both items resources as HTML5, every link an `<a>`.
 * - Features Part 1 `oas30`: the OpenAPI 3.0 definition declares both items resources and their parameters.
 */
export const OGCConformanceClass = {
	Core: `${COMMON_PART_1}/core`,
	LandingPage: `${COMMON_PART_1}/landing-page`,
	JSON: `${COMMON_PART_1}/json`,
	HTML: `${COMMON_PART_1}/html`,
	OAS30: `${COMMON_PART_1}/oas30`,
	Collections: `${COMMON_PART_2}/collections`,
	FeaturesCore: `${FEATURES_PART_1}/core`,
	FeaturesGeoJSON: `${FEATURES_PART_1}/geojson`,
	FeaturesHTML: `${FEATURES_PART_1}/html`,
	FeaturesOAS30: `${FEATURES_PART_1}/oas30`,
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

/**
 * The CRS84 coordinate reference system: WGS 84 longitude and latitude, in that order.
 */
export const OGC_CRS84 = "http://www.opengis.net/def/crs/OGC/1.3/CRS84"

/**
 * A collection's extent, from OGC API Features Part 1's `extent.yaml`.
 */
export const OGCExtentSchema = z
	.object({
		spatial: z.object({
			bbox: z.array(BBoxSchema),
			crs: z.literal(OGC_CRS84),
		}),
	})
	.openapi("OGCExtent")

export type OGCExtent = z.infer<typeof OGCExtentSchema>

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
 * A collection that serves `/collections/{collectionId}/items` adds `itemType`,
 * the `items` link and the `extent` OGC API Features Part 1 describes.
 * Another collection omits all three.
 */
export const OGCCollectionSchema = z
	.object({
		id: z.string(),
		title: z.string(),
		description: z.string(),
		links: z.array(OGCLinkSchema),
		attribution: z.string().optional().openapi({
			description:
				"A short credit for the data, present when a layer's license requires attribution. OGC API Common Part 2 defines the member.",
		}),
		itemType: z.literal("feature").optional(),
		extent: OGCExtentSchema.optional(),
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
		place_id: z.string().optional().openapi({
			description:
				"The gazetteer place ID of a place or postcode, such as `wof:85975673`. Absent for an address, a street, a plus code, or a place the gazetteer gave no ID.",
		}),
		placetype: z.string().optional().openapi({
			description:
				"The gazetteer placetype of a place or postcode, such as `locality`, `localadmin` or `postalcode`. Absent for an address, a street or a plus code.",
		}),
		href: z.string().optional().openapi({
			description:
				"The URL of the same place at `/collections/{collectionId}/items/{featureId}`, as on PDOK. Absent when the collection serves no items or holds no item for the place.",
		}),
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

/**
 * The number of items `/collections/{collectionId}/items` returns when the request omits `limit`.
 */
export const OGC_ITEMS_DEFAULT_LIMIT = 10

/**
 * The most items one `/collections/{collectionId}/items` page returns.
 *
 * A larger `limit` is served as this one, because OGC API Features Part 1 requires
 * a `limit` above the maximum to succeed rather than fail.
 */
export const OGC_ITEMS_MAX_LIMIT = 1000

/**
 * The properties of one item.
 */
export const OGCItemPropertiesSchema = z
	.object({
		name: z.string().openapi({ description: "The place's name, as the gazetteer records it." }),
		placetype: z.string().openapi({ description: "The gazetteer placetype, such as `locality` or `region`." }),
		country_code: z.string().nullable().openapi({
			description: "The ISO 3166-1 alpha-2 country code the gazetteer records, or null when it records none.",
		}),
		display_name: z.string().openapi({
			description:
				"The place's name, then its ancestors, most specific first, then its country, as `/search` labels it.",
		}),
	})
	.openapi("OGCItemProperties")

export type OGCItemProperties = z.infer<typeof OGCItemPropertiesSchema>

/**
 * One item, a GeoJSON point feature with its gazetteer place ID as `id`.
 */
export const OGCItemFeatureSchema = featureSchema(OGCItemPropertiesSchema)
	.extend({
		id: z.string().openapi({ description: "The gazetteer place ID, such as `wof:85975673`, as `/search` reports it." }),
		links: z.array(OGCLinkSchema).optional(),
	})
	.openapi("OGCItemFeature")

export type OGCItemFeature = z.infer<typeof OGCItemFeatureSchema>

/**
 * One page of items: a GeoJSON FeatureCollection with the members OGC API Features Part 1 adds.
 *
 * `numberMatched` is omitted, as the standard permits, because counting a box's places costs a scan.
 */
export const OGCItemsResponseSchema = featureCollectionSchema(OGCItemFeatureSchema)
	.extend({
		timeStamp: z.string().openapi({ description: "When the response was generated, as an RFC 3339 UTC timestamp." }),
		links: z.array(OGCLinkSchema),
		numberReturned: z.number().int(),
	})
	.openapi("OGCItemsResponse")

export type OGCItemsResponse = z.infer<typeof OGCItemsResponseSchema>

/**
 * The path parameters of `/collections/{collectionId}/items/{featureId}`.
 */
export const OGCItemPathSchema = OGCCollectionPathSchema.extend({
	featureId: z.string().openapi({ param: { name: "featureId", in: "path" }, example: "wof:101751893" }),
})

/**
 * The query of `/collections/{collectionId}/items`.
 *
 * The parameter definitions follow OGC API Features Part 1, Requirements 21, 23 and 25,
 * including the `form` style without `explode` that a client reads from the API definition.
 * The values arrive as strings, and the route parses them.
 */
export const OGCItemsQuerySchema = z
	.object({
		limit: z
			.string()
			.optional()
			.openapi({
				param: { style: "form", explode: false },
				type: "integer",
				minimum: 1,
				maximum: OGC_ITEMS_MAX_LIMIT,
				default: OGC_ITEMS_DEFAULT_LIMIT,
				description: `The most features to return. The default is ${OGC_ITEMS_DEFAULT_LIMIT}, and a larger value than ${OGC_ITEMS_MAX_LIMIT} returns ${OGC_ITEMS_MAX_LIMIT}.`,
			}),
		bbox: z
			.string()
			.optional()
			.openapi({
				param: { style: "form", explode: false },
				type: "array",
				minItems: 4,
				maxItems: 6,
				items: { type: "number" },
				description:
					"Keep only features whose point lies inside the box: `minLon,minLat,maxLon,maxLat` in WGS 84 longitude and latitude, or six numbers with a minimum and maximum height after each latitude. The features have no height, so the height bounds select nothing out. A minimum longitude above the maximum crosses the antimeridian.",
			}),
		datetime: z
			.string()
			.optional()
			.openapi({
				param: { style: "form", explode: false },
				description:
					"An RFC 3339 date-time, or an interval of two separated by `/` with `..` or an empty string for an open end. The places carry no time, so every valid value matches every place, as OGC API Features Part 1 requires for features without a temporal geometry.",
			}),
		after: z.string().optional().openapi({
			description:
				"Start after the item with this WOF id. The `next` link sets it, and a client follows that link rather than building the value.",
		}),
		f: formatParameter,
	})
	.strict()
