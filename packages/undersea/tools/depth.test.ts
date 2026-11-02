/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import { depthKindOf, TerrariumReader } from "#tools/depth"

/**
 * A reader whose every pixel answers from a function of its global pixel coordinates, with no network.
 */
class FixtureReader extends TerrariumReader {
	readonly #elevation: (x: number, y: number) => number | null

	constructor(elevation: (x: number, y: number) => number | null) {
		super("unused://{z}/{x}/{y}")
		this.#elevation = elevation
	}

	override async elevationAt(globalX: number, globalY: number): Promise<number | null> {
		return this.#elevation(globalX, globalY)
	}
}

describe("depthKindOf", () => {
	test("reads a depression's deepest sample", () => {
		expect(depthKindOf("Deep")).toBe("deepest")
		expect(depthKindOf("Trench")).toBe("deepest")
	})

	test("gives no depth to a rise, whose summit the grid smooths away, or to a term without a single depth", () => {
		expect(depthKindOf("Seamount")).toBeNull()
		expect(depthKindOf("Bank")).toBeNull()
		expect(depthKindOf("Fracture Zone")).toBeNull()
	})
})

describe("TerrariumReader.depthOf", () => {
	// The sea floor deepens one meter per pixel eastward, from -5,000 m.
	const reader = new FixtureReader((x) => -5000 - (x % 1000))

	test("searches a point's window for its extreme", async () => {
		const deepest = await reader.depthOf({ positions: [[0, 0]], window: true, kind: "deepest" })
		const shallowest = await reader.depthOf({ positions: [[0, 0]], window: true, kind: "shallowest" })

		// The window spans seven pixels, so the two extremes are six meters apart.
		expect(deepest! - shallowest!).toBe(-6)
	})

	test("answers null when every sample is at or above sea level", async () => {
		const land = new FixtureReader(() => 120)

		expect(await land.depthOf({ positions: [[0, 0]], window: true, kind: "deepest" })).toBeNull()
	})

	test("answers null when no tile covers the samples", async () => {
		const missing = new FixtureReader(() => null)

		expect(await missing.depthOf({ positions: [[0, 0]], window: false, kind: "deepest" })).toBeNull()
	})
})
