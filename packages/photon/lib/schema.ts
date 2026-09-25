/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Zod schemas for the Photon-compatible API. Key names and envelopes match Photon and must not
 *   change. The query schemas accept any string or string array, so validation never fails. The
 *   handlers in `routes.ts` do the actual parsing.
 */

import { z } from "@hono/zod-openapi"
import { featureCollectionSchema, featureSchema, stampedResponseSchema } from "@mailwoman/api-kit"

/**
 * Photon feature properties with OSM-derived keys.
 * Extra keys are allowed.
 */
export const PhotonPropertiesSchema = z
	.object({
		osm_id: z.union([z.number(), z.string()]).optional(),
		osm_type: z.string().optional(),
		osm_key: z.string().optional(),
		osm_value: z.string().optional(),
		type: z.string().optional(),
		name: z.string().optional(),
		housenumber: z.string().optional(),
		street: z.string().optional(),
		postcode: z.string().optional(),
		city: z.string().optional(),
		district: z.string().optional(),
		county: z.string().optional(),
		state: z.string().optional(),
		country: z.string().optional(),
		countrycode: z.string().optional(),
		extent: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
	})
	.loose()
	.openapi("PhotonProperties")

/**
 * One Photon result feature with GeoJSON geometry and Photon's properties.
 */
export const PhotonFeatureSchema = featureSchema(PhotonPropertiesSchema).openapi("PhotonFeature")

/**
 * A GeoJSON FeatureCollection of Photon features.
 */
export const PhotonFeatureCollectionSchema =
	featureCollectionSchema(PhotonFeatureSchema).openapi("PhotonFeatureCollection")

/**
 * The error envelope, which is an empty FeatureCollection with a message.
 * Photon does not use an `{ error }` body.
 */
export const PhotonMessageCollectionSchema = z
	.object({
		type: z.literal("FeatureCollection"),
		features: z.array(PhotonFeatureSchema),
		message: z.string(),
	})
	.openapi("PhotonMessageCollection")

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
 * It mirrors the `SchemaOrgPlace` interface that `photonToSchemaOrg` produces.
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
 * The FeatureCollection with the optional `engine` stamp.
 *
 * The schema has an OpenAPI name because it is a union member.
 * A generated client would otherwise label an inlined member by its position.
 */
export const StampedPhotonFeatureCollectionSchema = stampedResponseSchema(
	PhotonFeatureCollectionSchema,
	"StampedPhotonFeatureCollection"
)

/**
 * The `/api` and `/reverse` 200 response for the OpenAPI document.
 *
 * The response is a GeoJSON FeatureCollection by default or an array of schema.org
 * `Place` objects for `format=jsonld`.
 */
export const PhotonResponseSchema = z
	.union([StampedPhotonFeatureCollectionSchema, z.array(SchemaOrgPlaceSchema)])
	.openapi("PhotonResponse")

/**
 * A query parameter that accepts one value or a repeated value.
 * Each use sets its documented type with `.openapi()`.
 */
const tolerantParam = z.union([z.string(), z.array(z.string())]).optional()

/**
 * The documented query parameters of `GET /api`.
 * The handler checks and parses them.
 */
export const searchQueryParams = z.object({
	q: tolerantParam.openapi({ type: "string", description: "The query string to search for." }),
	limit: tolerantParam.openapi({ type: "integer", description: "Maximum results (default 15)." }),
	lang: tolerantParam.openapi({ type: "string", description: "Preferred language." }),
	lat: tolerantParam.openapi({ type: "number", description: "Location-bias latitude." }),
	lon: tolerantParam.openapi({ type: "number", description: "Location-bias longitude." }),
	osm_tag: tolerantParam.openapi({
		type: "array",
		items: { type: "string" },
		description: "OSM tag filter; repeatable.",
	}),
	layer: tolerantParam.openapi({ type: "array", items: { type: "string" }, description: "Layer filter; repeatable." }),
	format: tolerantParam.openapi({ type: "string", enum: ["geojson", "jsonld"], description: "Output format." }),
})

/**
 * The documented query parameters of `GET /reverse`.
 */
export const reverseQueryParams = z.object({
	lat: tolerantParam.openapi({ type: "number", description: "Latitude." }),
	lon: tolerantParam.openapi({ type: "number", description: "Longitude." }),
	limit: tolerantParam.openapi({ type: "integer", description: "Maximum results (default 15)." }),
	lang: tolerantParam.openapi({ type: "string", description: "Preferred language." }),
	radius: tolerantParam.openapi({ type: "number", description: "Search radius in km." }),
	format: tolerantParam.openapi({ type: "string", enum: ["geojson", "jsonld"], description: "Output format." }),
})
