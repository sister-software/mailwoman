/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */
import {
	type Feature,
	expression as styleExpression,
	type StylePropertySpecification,
} from "@maplibre/maplibre-gl-style-spec"
import { describe, expect, test } from "vitest"

import { BaseLayers } from "#base/layers"
import { pixelsPerMeter, roadClassOf } from "#base/road-width"

/**
 * The style specification's definition of `line-width` and `line-gap-width`:
 * a data-driven number interpolated over zoom.
 */
const LINE_WIDTH_SPEC: StylePropertySpecification = {
	type: "number",
	"property-type": "data-driven",
	expression: { interpolated: true, parameters: ["zoom", "feature"] },
	transition: true,
}

/**
 * Evaluates a layer's line paint property with MapLibre's expression evaluator.
 */
function widthAt(layerID: string, property: "line-width" | "line-gap-width", zoom: number, properties = {}): number {
	const layer = BaseLayers.find((entry) => entry.id === layerID)

	if (layer?.type !== "line") throw new Error(`${layerID} is not a line layer`)

	const compiled = styleExpression.createPropertyExpression(layer.paint?.[property], property, LINE_WIDTH_SPEC)

	if (compiled.result !== "success") throw new Error(compiled.value.map((error) => error.message).join("; "))

	const feature: Feature = { type: 2, properties }

	return compiled.value.evaluate({ zoom }, feature)
}

describe("road body width", () => {
	test("a minor street with no width tags draws 6 m wide from z18 to z24", () => {
		for (const zoom of [18, 19, 19.55, 21, 24]) {
			expect(widthAt("roads_minor", "line-width", zoom, { kind: "minor_road" })).toBeCloseTo(
				6 * pixelsPerMeter(zoom),
				0
			)
		}
	})

	test("a road's width tag, then its lane count, sets its ground width", () => {
		const zoom = 20
		const tagged = widthAt("roads_major", "line-width", zoom, { kind: "major_road", width: 21, lanes: 2 })
		const laned = widthAt("roads_major", "line-width", zoom, { kind: "major_road", lanes: 4 })

		expect(tagged).toBeCloseTo(21 * pixelsPerMeter(zoom), 0)
		expect(laned).toBeCloseTo(4 * 3.25 * pixelsPerMeter(zoom), 0)
	})

	test("a casing's gap equals its road's body width, so the outline stays on the road edge", () => {
		for (const zoom of [12, 15, 18, 21]) {
			const properties = { kind: "major_road", kind_detail: "primary" }

			expect(widthAt("roads_major_casing_late", "line-gap-width", zoom, properties)).toBeCloseTo(
				widthAt("roads_major", "line-width", zoom, properties),
				3
			)
		}
	})

	test("the width never falls below the Protomaps curve at low zoom", () => {
		// Protomaps draws a highway 1.6 px wide at z12.
		// An 11 m carriageway is 0.8 px there.
		expect(widthAt("roads_highway", "line-width", 12, { kind: "highway" })).toBeCloseTo(1.6, 2)
	})

	test("every road fill and casing layer except rail and piers takes a ground width", () => {
		const unclassed = BaseLayers.filter(
			(layer) => layer.type === "line" && layer.id.startsWith("roads_") && roadClassOf(layer.id) === null
		).map((layer) => layer.id)

		expect(new Set(unclassed)).toEqual(new Set(["roads_pier", "roads_rail", "roads_rail_hatch", "roads_rail_tunnel"]))
	})
})
