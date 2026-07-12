/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   GeoJSON wire atoms shared by the geo-shaped HTTP surfaces (photon, nominatim). Envelope
 *   builders only — surface-specific property schemas live with their routes, per the anti-meta
 *   guardrails in the 2026-07-12 design spec.
 */

import { z } from "@hono/zod-openapi"

/** A GeoJSON Point geometry: `[lon, lat]`. */
export const PointGeometrySchema = z
	.object({
		type: z.literal("Point"),
		coordinates: z.tuple([z.number(), z.number()]),
	})
	.openapi("PointGeometry")

/** A `[minLon, minLat, maxLon, maxLat]`-style 4-tuple (photon's `extent` uses `[minLon, maxLat, maxLon, minLat]`). */
export const BBoxSchema = z.tuple([z.number(), z.number(), z.number(), z.number()])

/** GeoJSON Feature envelope over a surface-specific properties schema. */
export function featureSchema<P extends z.ZodTypeAny>(properties: P) {
	return z.object({
		type: z.literal("Feature"),
		geometry: PointGeometrySchema,
		properties,
	})
}

/** GeoJSON FeatureCollection envelope over a feature schema. */
export function featureCollectionSchema<F extends z.ZodTypeAny>(feature: F) {
	return z.object({
		type: z.literal("FeatureCollection"),
		features: z.array(feature),
	})
}
