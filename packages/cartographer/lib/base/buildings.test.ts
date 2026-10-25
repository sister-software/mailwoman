/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import {
	createPropertyExpression,
	type Feature,
	type StylePropertySpecification,
} from "@maplibre/maplibre-gl-style-spec"
import { expect, test } from "vitest"

import { buildingColor } from "#base/buildings"
import { GuideMapPalette } from "#base/theme"

/**
 * The style specification's entry for `fill-extrusion-color`: a data-driven color.
 */
const fillExtrusionColorSpec: StylePropertySpecification = {
	type: "color",
	"property-type": "data-driven",
	expression: { interpolated: true, parameters: ["zoom", "feature", "feature-state"] },
	transition: true,
	overridable: false,
}

const compiled = createPropertyExpression(buildingColor, "fill-extrusion-color", fillExtrusionColorSpec)

if (compiled.result !== "success") throw new Error(compiled.value.map((error) => error.message).join("; "))

const colorOf = (properties: Feature["properties"]) =>
	compiled.value.evaluate({ zoom: 15 }, { type: "Polygon", properties }).toString()

const rgba = (hex: string) =>
	`rgba(${Number.parseInt(hex.slice(1, 3), 16)},${Number.parseInt(hex.slice(3, 5), 16)},${Number.parseInt(hex.slice(5, 7), 16)},1)`

test("buildingColor: a tile without districts or tags keeps the base building color", () => {
	expect(colorOf({})).toBe(rgba(GuideMapPalette.building))
})

test("buildingColor: every district index takes its own tint", () => {
	GuideMapPalette.buildingDistricts.forEach((tint, district) => {
		expect(colorOf({ district })).toBe(rgba(tint))
	})
})

test("buildingColor: a tagged facade color is mixed toward the base color and wins over the roof color", () => {
	const facade = colorOf({ facade_color: "#ff0000", roof_color: "#0000ff", district: 3 })
	expect(facade).not.toBe(rgba("#ff0000"))
	expect(facade).not.toBe(rgba(GuideMapPalette.buildingDistricts[3]!))
	expect(colorOf({ roof_color: "#0000ff" })).not.toBe(colorOf({ facade_color: "#ff0000" }))
})
