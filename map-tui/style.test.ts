/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { stylesFor } from "./style.ts"

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
