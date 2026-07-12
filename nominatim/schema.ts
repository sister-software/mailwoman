/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Zod wire schemas for the Nominatim-compatible surface. Key names and envelopes are the vendor
 *   contract — immutable. Query schemas are validator-proof (string|string[] unions, all optional)
 *   with doc-exact `.openapi()` overrides; every wire decision lives in the handlers (see
 *   routes.ts's legacyQuery adapter, the photon-established pattern).
 */

import { z } from "@hono/zod-openapi"

/** The `addressdetails=1` breakdown — OSM-derived keys; tolerant of extras. */
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

/** A single Nominatim result (the shape geopy and friends parse). */
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

export const NominatimResultsSchema = z.array(NominatimResultSchema)

/** The `format=geojson` envelope — nominatim's own shape (polygon-capable geometry, result fields as properties). */
export const NominatimFeatureCollectionSchema = z
	.object({
		type: z.literal("FeatureCollection"),
		features: z.array(
			z.object({
				type: z.literal("Feature"),
				properties: z.looseObject({}),
				geometry: z.unknown(),
				bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
			})
		),
	})
	.openapi("NominatimFeatureCollection")

/** The `/status` payload. */
export const NominatimStatusSchema = z
	.object({
		status: z.number(),
		message: z.string(),
		data_updated: z.string().optional(),
	})
	.openapi("NominatimStatus")

/** The JSON error envelope (this surface uses `{error}`, unlike photon's FeatureCollection+message). */
export const ErrorSchema = z
	.object({
		error: z.string(),
	})
	.openapi("Error")

/**
 * The schema.org [`GeoCoordinates`](https://schema.org/GeoCoordinates) node — mirrors `@mailwoman/annotations`'s
 * `SchemaOrgGeoCoordinates` interface. Hand-modeled locally (no import from `@mailwoman/annotations`), matching this
 * file's existing wire-schema convention: each surface owns its own doc-accuracy schemas rather than sharing a schema
 * across the package boundary.
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
 * shape `nominatimResultToSchemaOrg` actually produces.
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
 * The real `/search` 200 response union (#1052 doc accuracy): a jsonv2/json result array by default, a `format=geojson`
 * FeatureCollection, or a `format=jsonld` array of schema.org `Place` objects — see `routes.ts`'s search handler.
 * Doc-only; the wire behavior is unchanged.
 */
export const NominatimSearchResponseSchema = z
	.union([NominatimResultsSchema, NominatimFeatureCollectionSchema, z.array(SchemaOrgPlaceSchema)])
	.openapi("NominatimSearchResponse")

/**
 * The real `/reverse` 200 response union (#1052 doc accuracy): a single jsonv2/json result, `null` when unresolved, a
 * `format=geojson` FeatureCollection, or a `format=jsonld` schema.org `Place` — see `routes.ts`'s reverse handler.
 * Doc-only; the wire behavior is unchanged.
 */
export const NominatimReverseResponseSchema = z
	.union([NominatimResultSchema, z.null(), NominatimFeatureCollectionSchema, SchemaOrgPlaceSchema])
	.openapi("NominatimReverseResponse")

/**
 * The real `/lookup` 200 response union (#1052 doc accuracy): a jsonv2/json result array by default, or a
 * `format=geojson` FeatureCollection. NO `jsonld` branch — a legacy quirk preserved verbatim by `routes.ts`'s lookup
 * handler (`format=jsonld` falls through to the raw jsonv2 array there), so this union stays two-wide, unlike
 * `/search`'s three-wide union.
 */
export const NominatimLookupResponseSchema = z
	.union([NominatimResultsSchema, NominatimFeatureCollectionSchema])
	.openapi("NominatimLookupResponse")

/** A validator-proof query param: accepts one value or repeats; the doc override keeps the emitted schema exact. */
const tolerantParam = z.union([z.string(), z.array(z.string())]).optional()

/** `GET /search` query. */
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
	postalcode: tolerantParam.openapi({ type: "string", description: "Structured: postal code." }),
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

/** `GET /reverse` query. */
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

/** `GET /lookup` query. */
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
