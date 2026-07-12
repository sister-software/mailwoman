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
 * The schema.org [`GeoCoordinates`](https://schema.org/GeoCoordinates) node — mirrors `@mailwoman/annotations`'s
 * `SchemaOrgGeoCoordinates` interface. Hand-modeled locally (no import from `@mailwoman/annotations`) matching this
 * package's existing wire-schema convention: each surface owns its own doc-accuracy schemas rather than sharing a
 * schema across the package boundary.
 */
export const SchemaOrgGeoCoordinatesSchema = z
	.object({
		"@type": z.literal("GeoCoordinates"),
		latitude: z.number(),
		longitude: z.number(),
	})
	.openapi("SchemaOrgGeoCoordinates")

/** The schema.org [`PostalAddress`](https://schema.org/PostalAddress) node — mirrors `SchemaOrgPostalAddress`. */
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
 * The `format=jsonld` re-serialization (#1052) — mirrors `@mailwoman/annotations`'s `SchemaOrgPlace` interface, the
 * shape `photonToSchemaOrg` actually produces.
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
 * The real `/api` + `/reverse` 200 response union (#1052 doc accuracy): a GeoJSON FeatureCollection by default, or an
 * array of schema.org `Place` JSON-LD objects when `format=jsonld` — see `routes.ts`'s handlers (`photonToSchemaOrg`).
 * Doc-only; the wire behavior is unchanged.
 */
export const PhotonResponseSchema = z
	.union([PhotonFeatureCollectionSchema, z.array(SchemaOrgPlaceSchema)])
	.openapi("PhotonResponse")

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
