/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Zod schemas for the Nominatim-compatible API. Key names and envelopes match Nominatim and must
 *   not change. The query schemas accept any string or string array and only shape the OpenAPI
 *   document. The handlers in `routes.ts` do the actual parsing.
 */

import { z } from "@hono/zod-openapi"
import { stampedResponseSchema } from "@mailwoman/api-kit"

/**
 * The `addressdetails=1` breakdown with OSM-derived keys.
 * Extra keys are allowed.
 */
export const NominatimAddressDetailsSchema = z
	.object({
		house_number: z.string().optional(),
		road: z.string().optional(),
		neighbourhood: z.string().optional(),
		suburb: z.string().optional(),
		city: z.string().optional(),
		town: z.string().optional(),
		village: z.string().optional(),
		county: z.string().optional(),
		state: z.string().optional(),
		postcode: z.string().optional(),
		country: z.string().optional(),
		country_code: z.string().optional(),
	})
	.loose()
	.openapi("NominatimAddressDetails")

/**
 * A single Nominatim result, in the shape that clients such as geopy parse.
 */
export const NominatimResultSchema = z
	.object({
		place_id: z.union([z.number(), z.string()]),
		licence: z.string(),
		osm_type: z.string().optional(),
		osm_id: z.union([z.number(), z.string()]).optional(),
		lat: z.string(),
		lon: z.string(),
		display_name: z.string(),
		boundingbox: z.tuple([z.string(), z.string(), z.string(), z.string()]).optional(),
		class: z.string().optional(),
		type: z.string().optional(),
		importance: z.number().optional(),
		place_rank: z.number().optional(),
		address: NominatimAddressDetailsSchema.optional(),
		geojson: z.unknown().optional(),
		annotations: z.looseObject({}).optional(),
	})
	.loose()
	.openapi("NominatimResult")

/**
 * An array of Nominatim results.
 */
export const NominatimResultsSchema = z.array(NominatimResultSchema)

/**
 * A GeoJSON 2D bounding box, as `[west, south, east, north]`.
 */
const BBox2DSchema = z.tuple([z.number(), z.number(), z.number(), z.number()])

/**
 * One feature in the `format=geojson` envelope.
 */
const NominatimFeatureSchema = z.object({
	type: z.literal("Feature"),
	properties: z.looseObject({}),
	geometry: z.unknown(),
	bbox: BBox2DSchema.optional(),
})

/**
 * The `format=geojson` envelope in Nominatim's shape.
 *
 * Result fields become feature properties, and the geometry may be a polygon.
 */
export const NominatimFeatureCollectionSchema = z
	.object({
		type: z.literal("FeatureCollection"),
		features: z.array(NominatimFeatureSchema),
	})
	.openapi("NominatimFeatureCollection")

/**
 * One database the deployment serves from, with the contents of its embedded `layer_manifest`.
 *
 * `manifest: "absent"` marks a database built before layer manifests existed.
 * The status payload still lists it so that a reader can tell it apart from
 * a database that was never opened.
 */
const NominatimStatusArtifactSchema = z
	.object({
		name: z.string(),
		path: z.string(),
		manifest: z.enum(["present", "absent", "unreadable"]),
		reason: z.string().optional(),
		built: z.string().optional(),
		version: z.string().optional(),
		sources: z.array(z.string()).optional(),
	})
	.openapi("NominatimStatusArtifact")

/**
 * The `/status` payload.
 *
 * The `mailwoman` block is an extension that upstream Nominatim lacks.
 * Clients that do not know it ignore it.
 */
export const NominatimStatusSchema = z
	.object({
		status: z.number(),
		message: z.string(),
		data_updated: z.string().optional(),
		mailwoman: z.object({ artifacts: z.array(NominatimStatusArtifactSchema) }).optional(),
	})
	.openapi("NominatimStatus")

/**
 * The JSON error envelope, `{ error }`.
 */
export const ErrorSchema = z
	.object({
		error: z.string(),
	})
	.openapi("Error")

/**
 * The schema.org [`GeoCoordinates`](https://schema.org/GeoCoordinates) node.
 *
 * It mirrors the `SchemaOrgGeoCoordinates` interface in `@mailwoman/annotations`.
 * Each API package defines its own schemas, so this one is written out here.
 */
export const SchemaOrgGeoCoordinatesSchema = z
	.object({
		"@type": z.literal("GeoCoordinates"),
		latitude: z.number(),
		longitude: z.number(),
	})
	.openapi("SchemaOrgGeoCoordinates")

/**
 * The schema.org [`PostalAddress`](https://schema.org/PostalAddress) node.
 * It mirrors `SchemaOrgPostalAddress`.
 */
export const SchemaOrgPostalAddressSchema = z
	.object({
		"@type": z.literal("PostalAddress"),
		streetAddress: z.string().optional(),
		postOfficeBoxNumber: z.string().optional(),
		addressLocality: z.string().optional(),
		addressRegion: z.string().optional(),
		postalCode: z.string().optional(),
		addressCountry: z.string().optional(),
	})
	.openapi("SchemaOrgPostalAddress")

/**
 * The `format=jsonld` output.
 *
 * It mirrors the `SchemaOrgPlace` interface that `nominatimResultToSchemaOrg` produces.
 */
export const SchemaOrgPlaceSchema = z
	.object({
		"@context": z.literal("https://schema.org"),
		"@type": z.literal("Place"),
		name: z.string().optional(),
		geo: SchemaOrgGeoCoordinatesSchema.optional(),
		address: SchemaOrgPostalAddressSchema.optional(),
	})
	.openapi("SchemaOrgPlace")

/**
 * A jsonv2 or json result with the optional `engine` stamp.
 *
 * The schema has an OpenAPI name because it is a union member.
 * A generated client would otherwise label an inlined member by its position.
 */
export const StampedNominatimResultSchema = stampedResponseSchema(NominatimResultSchema, "StampedNominatimResult")

/**
 * The `format=geojson` FeatureCollection with the optional `engine` stamp.
 *
 * It has an OpenAPI name for the same reason as {@linkcode StampedNominatimResultSchema}.
 */
export const StampedNominatimFeatureCollectionSchema = stampedResponseSchema(
	NominatimFeatureCollectionSchema,
	"StampedNominatimFeatureCollection"
)

/**
 * The `/search` 200 response for the OpenAPI document.
 *
 * The response is a jsonv2 result array by default, a FeatureCollection for `format=geojson`,
 * or an array of schema.org `Place` objects for `format=jsonld`.
 */
export const NominatimSearchResponseSchema = z
	.union([
		z.array(StampedNominatimResultSchema),
		StampedNominatimFeatureCollectionSchema,
		z.array(SchemaOrgPlaceSchema),
	])
	.openapi("NominatimSearchResponse")

/**
 * The `/reverse` 200 response for the OpenAPI document.
 *
 * The response is a single jsonv2 result, `null` when no place resolves, a FeatureCollection
 * for `format=geojson`, or a schema.org `Place` for `format=jsonld`.
 */
export const NominatimReverseResponseSchema = z
	.union([StampedNominatimResultSchema, z.null(), StampedNominatimFeatureCollectionSchema, SchemaOrgPlaceSchema])
	.openapi("NominatimReverseResponse")

/**
 * The `/lookup` 200 response for the OpenAPI document.
 *
 * The response is a jsonv2 result array by default or a FeatureCollection for `format=geojson`.
 * The lookup handler returns the jsonv2 array for `format=jsonld`, so this union has no `Place` member.
 */
export const NominatimLookupResponseSchema = z
	.union([z.array(StampedNominatimResultSchema), StampedNominatimFeatureCollectionSchema])
	.openapi("NominatimLookupResponse")

/**
 * A query parameter that accepts one value or a repeated value.
 * Each use sets its documented type with `.openapi()`.
 */
const tolerantParam = z.union([z.string(), z.array(z.string())]).optional()

/**
 * The query parameters of `GET /search`.
 */
export const searchQueryParams = z.object({
	q: tolerantParam.openapi({
		type: "string",
		description: "Free-text query. Mutually exclusive with the structured fields.",
	}),
	street: tolerantParam.openapi({ type: "string", description: "Structured: house number and street name." }),
	city: tolerantParam.openapi({ type: "string", description: "Structured: city." }),
	county: tolerantParam.openapi({ type: "string", description: "Structured: county." }),
	state: tolerantParam.openapi({ type: "string", description: "Structured: state." }),
	country: tolerantParam.openapi({ type: "string", description: "Structured: country." }),
	postalcode: tolerantParam.openapi({ type: "string", description: "Structured: postcode." }),
	countrycodes: tolerantParam.openapi({
		type: "string",
		description: "Comma-separated ISO 3166-1 alpha-2 codes restricting results.",
	}),
	bounded: tolerantParam.openapi({ type: "string", enum: ["0", "1"], description: "Restrict to the viewbox." }),
	limit: tolerantParam.openapi({ type: "integer", description: "Maximum results (default 10)." }),
	addressdetails: tolerantParam.openapi({
		type: "string",
		enum: ["0", "1"],
		description: "Include the address breakdown.",
	}),
	format: tolerantParam.openapi({
		type: "string",
		enum: ["jsonv2", "json", "geojson", "jsonld"],
		description: "Output format (default jsonv2).",
	}),
	"accept-language": tolerantParam.openapi({ type: "string", description: "Preferred result language." }),
})

/**
 * The query parameters of `GET /reverse`.
 */
export const reverseQueryParams = z.object({
	lat: tolerantParam.openapi({ type: "number", description: "Latitude." }),
	lon: tolerantParam.openapi({ type: "number", description: "Longitude." }),
	zoom: tolerantParam.openapi({ type: "integer", description: "Detail level." }),
	addressdetails: tolerantParam.openapi({
		type: "string",
		enum: ["0", "1"],
		description: "Include the address breakdown.",
	}),
	format: tolerantParam.openapi({
		type: "string",
		enum: ["jsonv2", "json", "geojson", "jsonld"],
		description: "Output format (default jsonv2).",
	}),
	"accept-language": tolerantParam.openapi({ type: "string", description: "Preferred result language." }),
})

/**
 * The query parameters of `GET /lookup`.
 */
export const lookupQueryParams = z.object({
	osm_ids: tolerantParam.openapi({ type: "string", description: "Comma-separated OSM ids (N|W|R-prefixed)." }),
	addressdetails: tolerantParam.openapi({
		type: "string",
		enum: ["0", "1"],
		description: "Include the address breakdown.",
	}),
	format: tolerantParam.openapi({
		type: "string",
		enum: ["jsonv2", "json", "geojson", "jsonld"],
		description: "Output format (default jsonv2).",
	}),
})
