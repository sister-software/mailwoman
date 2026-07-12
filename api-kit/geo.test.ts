/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { z } from "@hono/zod-openapi"
import { expect, test } from "vitest"

import { BBoxSchema, featureCollectionSchema, featureSchema, PointGeometrySchema } from "./index.ts"

test("PointGeometrySchema: accepts a lon/lat point, rejects wrong arity", () => {
	expect(PointGeometrySchema.safeParse({ type: "Point", coordinates: [13.405, 52.52] }).success).toBe(true)
	expect(PointGeometrySchema.safeParse({ type: "Point", coordinates: [13.405] }).success).toBe(false)
})

test("featureSchema: wraps a properties schema into a GeoJSON Feature envelope", () => {
	const schema = featureSchema(z.object({ name: z.string() }))
	const parsed = schema.safeParse({
		type: "Feature",
		geometry: { type: "Point", coordinates: [13.405, 52.52] },
		properties: { name: "Berlin" },
	})
	expect(parsed.success).toBe(true)
	expect(schema.safeParse({ type: "Feature", geometry: null, properties: { name: "x" } }).success).toBe(false)
})

test("featureCollectionSchema: wraps a feature schema into a FeatureCollection envelope", () => {
	const schema = featureCollectionSchema(featureSchema(z.object({}).loose()))
	expect(schema.safeParse({ type: "FeatureCollection", features: [] }).success).toBe(true)
	expect(schema.safeParse({ type: "FeatureCollection", features: [{}] }).success).toBe(false)
})

test("BBoxSchema: four finite numbers", () => {
	expect(BBoxSchema.safeParse([-5.1, 41.3, 9.6, 51.1]).success).toBe(true)
	expect(BBoxSchema.safeParse([1, 2, 3]).success).toBe(false)
})
