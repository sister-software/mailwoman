/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { countShapes, shapeExposure } from "./shapes.ts"

describe("shapeExposure", () => {
	it("counts rows by the retention table's key and reports the retained keys never drawn", () => {
		const { counts, rows } = countShapes([
			{ country: "FR", spanTags: ["house_number", "street", "locality"] },
			{ country: "FR", spanTags: ["house_number", "street", "locality"] },
			{ country: "US", spanTags: ["venue", "locality"] },
			{ country: null, spanTags: ["street"] },
		])

		expect(rows).toBe(4)
		expect(counts.get("FR|house_number -> street -> locality")).toBe(2)

		const report = shapeExposure(
			["FR|house_number -> street -> locality", "US|venue -> locality", "GB|unit -> street"],
			counts,
			rows
		)

		expect(report).toMatchObject({ retainedKeys: 3, drawn: 2, undrawn: ["GB|unit -> street"], consumedRows: 4 })
		expect(report.byKey[0]).toEqual({ key: "GB|unit -> street", consumed: 0 })
	})
})
