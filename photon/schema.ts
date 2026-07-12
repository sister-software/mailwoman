/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Zod wire schemas for the Photon-compatible surface. Key names and envelopes are the vendor
 *   contract — immutable. Query schemas are validator-proof by construction (unions accepting
 *   string or repeated values) with doc-exact `.openapi()` overrides: validation can never fail,
 *   and every wire decision stays in the handlers (see routes.ts's legacyQuery adapter).
 */

import { z } from "@hono/zod-openapi"
import { featureCollectionSchema, featureSchema } from "@mailwoman/api-kit"

/** Photon feature properties — OSM-derived keys; tolerant of extras (`[key: string]: unknown` on the wire type). */
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

export const PhotonFeatureSchema = featureSchema(PhotonPropertiesSchema).openapi("PhotonFeature")

export const PhotonFeatureCollectionSchema =
	featureCollectionSchema(PhotonFeatureSchema).openapi("PhotonFeatureCollection")

/** The error/degenerate envelope: an EMPTY FeatureCollection carrying a message. Never `{error}` on this surface. */
export const PhotonMessageCollectionSchema = z
	.object({
		type: z.literal("FeatureCollection"),
		features: z.array(PhotonFeatureSchema),
		message: z.string(),
	})
	.openapi("PhotonMessageCollection")

/**
 * A query param that may legally repeat (or that a client may repeat without the validator being allowed to answer for
 * us). Validator-proof: accepts one value or many; the doc override keeps the emitted parameter schema exact.
 */
const tolerantParam = z.union([z.string(), z.array(z.string())]).optional()

/** `GET /api` query — documented shape; presence/parsing enforced in-handler. */
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

/** `GET /reverse` query. */
export const reverseQueryParams = z.object({
	lat: tolerantParam.openapi({ type: "number", description: "Latitude." }),
	lon: tolerantParam.openapi({ type: "number", description: "Longitude." }),
	limit: tolerantParam.openapi({ type: "integer", description: "Maximum results (default 15)." }),
	lang: tolerantParam.openapi({ type: "string", description: "Preferred language." }),
	radius: tolerantParam.openapi({ type: "number", description: "Search radius in km." }),
	format: tolerantParam.openapi({ type: "string", enum: ["geojson", "jsonld"], description: "Output format." }),
})
