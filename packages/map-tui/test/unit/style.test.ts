/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { styleForFeatureKind, stylesFor } from "@mailwoman/map-tui/style"
import { describe, expect, it } from "vitest"

describe("stylesFor", () => {
	it("fills water at every zoom", () => {
		const styles = stylesFor("water", 0)
		expect(styles).toHaveLength(1)
		expect(styles[0]!.kind).toBe("fill")
	})

	it("labels places", () => {
		const styles = stylesFor("places", 4)
		expect(styles.some((s) => s.kind === "label" && s.property === "name")).toBe(true)
	})

	it("gates buildings until high zoom", () => {
		expect(stylesFor("buildings", 10)).toHaveLength(0)
		expect(stylesFor("buildings", 14).length).toBeGreaterThan(0)
	})

	it("returns empty for unknown layers", () => {
		expect(stylesFor("nonexistent", 10)).toEqual([])
	})
})

describe("styleForFeatureKind", () => {
	it("colors road classes apart — a highway is not a minor road", () => {
		const styles = stylesFor("roads", 14)
		const highway = styleForFeatureKind(styles, "highway")
		const minor = styleForFeatureKind(styles, "minor_road")

		expect(highway).not.toBeNull()
		expect(minor).not.toBeNull()
		expect(highway!.color).not.toEqual(minor!.color)
	})

	it("separates urban landuse from vegetation", () => {
		const styles = stylesFor("landuse", 12)
		const residential = styleForFeatureKind(styles, "residential")
		const park = styleForFeatureKind(styles, "park")

		expect(residential!.color).not.toEqual(park!.color)
	})

	it("keeps rail visually apart from the road ramp", () => {
		const styles = stylesFor("roads", 14)
		const rail = styleForFeatureKind(styles, "rail")
		const minor = styleForFeatureKind(styles, "minor_road")

		expect(rail!.featureKinds).toContain("rail")
		expect(rail!.color).not.toEqual(minor!.color)
	})

	it("falls back to the catch-all for unlisted and missing kinds", () => {
		const styles = stylesFor("roads", 14)
		const other = styleForFeatureKind(styles, "other")
		const kindless = styleForFeatureKind(styles, undefined)

		expect(other).not.toBeNull()
		expect(other!.featureKinds).toBeUndefined()
		expect(kindless).toBe(other)
	})

	it("returns null when only kind-scoped styles remain", () => {
		const styles = stylesFor("roads", 14).filter((style) => style.featureKinds != null)

		expect(styleForFeatureKind(styles, "other")).toBeNull()
	})
})
