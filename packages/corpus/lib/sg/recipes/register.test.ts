/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { mulberry32 } from "@mailwoman/core/utils"
import {
	abbreviateSGStreet,
	isBuildingName,
	renderSGRegister,
	sgRegisterRecipe,
	titleCaseSGName,
} from "@mailwoman/corpus/sg/recipes/register"
import { type SliceRow, sliceRunner } from "@mailwoman/corpus/test-kit/corpus-recipe"
import { describe, expect, it } from "vitest"

const run = sliceRunner("sg-register", sgRegisterRecipe, 7)

const ROWS = [
	{
		street: "OLD CHOA CHU KANG ROAD",
		number: "990",
		unit: "NATIONAL SHOOTING CENTRE",
		postcode: "699814",
		locality: "Singapore",
	},
	{
		street: "SERANGOON GARDEN WAY",
		number: "12",
		unit: "SERANGOON GARDEN ESTATE",
		postcode: "555933",
		locality: "Singapore",
	},
	{ street: "ANG MO KIO AVENUE 3", number: "123", unit: "NIL", postcode: "560123", locality: "Singapore" },
	{ street: "KALLANG AVENUE", number: "12A", unit: "", postcode: "339511", locality: "Singapore" },
	{ street: "TAMPINES STREET 21", number: "201", unit: "NIL", postcode: "520201", locality: "Singapore" },
	{ street: "NO POSTCODE ROAD", number: "1", unit: "NIL", postcode: "", locality: "Singapore" },
	{ street: "BAD NUMBER ROAD", number: "S-N", unit: "NIL", postcode: "123456", locality: "Singapore" },
]

describe("titleCaseSGName", () => {
	it("title-cases the register's upper-case names and leaves a mixed-case value alone", () => {
		expect(titleCaseSGName("OLD CHOA CHU KANG ROAD")).toBe("Old Choa Chu Kang Road")
		expect(titleCaseSGName("NATIONAL SHOOTING CENTRE")).toBe("National Shooting Centre")
		expect(titleCaseSGName("Ang Mo Kio Ave 3")).toBe("Ang Mo Kio Ave 3")
	})
})

describe("abbreviateSGStreet", () => {
	it("abbreviates the generic wherever it sits and leaves a street without one alone", () => {
		expect(abbreviateSGStreet("Ang Mo Kio Avenue 3")).toBe("Ang Mo Kio Ave 3")
		expect(abbreviateSGStreet("Old Choa Chu Kang Road")).toBe("Old Choa Chu Kang Rd")
		expect(abbreviateSGStreet("Serangoon Garden Way")).toBe("Serangoon Garden Way")
	})
})

describe("isBuildingName", () => {
	it("reads a building name and refuses an estate, NIL, a unit designator, or one word", () => {
		expect(isBuildingName("NATIONAL SHOOTING CENTRE")).toBe(true)
		expect(isBuildingName("SERANGOON GARDEN ESTATE")).toBe(false)
		expect(isBuildingName("NIL")).toBe(false)
		expect(isBuildingName("#05-67")).toBe(false)
		expect(isBuildingName("DIABETES & METABOLISM CENTRE (DMC)")).toBe(false)
		expect(isBuildingName("Penthouse")).toBe(false)
		expect(isBuildingName("")).toBe(false)
	})
})

describe("renderSGRegister", () => {
	const row = { street: "ANG MO KIO AVENUE 3", number: "123", unit: "NIL", postcode: "560123" }

	it("keeps every component a substring of the line across the seeds", () => {
		const registers = new Set<string>()

		for (let seed = 0; seed < 64; seed++) {
			const unit = seed % 2 ? "NATIONAL SHOOTING CENTRE" : "NIL"
			const rendering = renderSGRegister({ ...row, unit }, mulberry32(seed))

			registers.add(rendering.register)

			for (const [tag, value] of Object.entries(rendering.components)) {
				expect(rendering.raw, `${tag} of ${rendering.raw}`).toContain(value)
			}

			expect(rendering.components.house_number).toBe("123")
			expect(rendering.components.postcode).toBe("560123")
		}

		expect([...registers].toSorted()).toEqual(["block", "bracket_postcode", "building_led", "official"])
	})

	it("renders the named register when one is forced, and falls back to official for a building-led row without a building", () => {
		expect(renderSGRegister(row, mulberry32(3), "block").register).toBe("block")
		expect(renderSGRegister(row, mulberry32(3), "bracket_postcode").register).toBe("bracket_postcode")
		expect(renderSGRegister(row, mulberry32(3), "official").register).toBe("official")
		expect(renderSGRegister(row, mulberry32(3), "building_led").register).toBe("official")

		const building = { ...row, unit: "NATIONAL SHOOTING CENTRE" }

		expect(renderSGRegister(building, mulberry32(3), "building_led").register).toBe("building_led")
	})

	it("renders the block line with Blk untagged, the floor-unit tagged unit, and Singapore as the locality", () => {
		const rendering = renderSGRegister(row, mulberry32(0), "block")

		expect(rendering.raw).toMatch(/^Blk 123 Ang Mo Kio Ave(nue)? 3 #\d{2}-\d{2,3} Singapore 560123$/u)

		expect(rendering.components).toEqual({
			house_number: "123",
			street: expect.stringMatching(/^Ang Mo Kio Ave(nue)? 3$/u),
			postcode: "560123",
			unit: expect.stringMatching(/^#\d{2}-\d{2,3}$/u),
			locality: "Singapore",
		})
	})

	it("renders the bracketed postcode with S( ) untagged", () => {
		const rendering = renderSGRegister(row, mulberry32(0), "bracket_postcode")

		expect(rendering.raw).toMatch(/^123 Ang Mo Kio Ave(nue)? 3 S\(560123\)$/u)
		expect(rendering.components.postcode).toBe("560123")
		expect(rendering.components.locality).toBeUndefined()
	})

	it("renders a building name as the venue lead and never an estate", () => {
		const building = { ...row, unit: "NATIONAL SHOOTING CENTRE" }
		const rendering = renderSGRegister(building, mulberry32(0), "building_led")

		expect(rendering.raw).toMatch(/^National Shooting Centre, 123 Ang Mo Kio Ave(nue)? 3, Singapore 560123$/u)
		expect(rendering.components.venue).toBe("National Shooting Centre")

		for (let seed = 0; seed < 64; seed++) {
			expect(renderSGRegister({ ...row, unit: "SERANGOON GARDEN ESTATE" }, mulberry32(seed)).register).not.toBe(
				"building_led"
			)
		}
	})
})

describe("sg-register recipe", () => {
	it("emits an aligned row per register row and skips a row without a 6-digit postcode or a numeric block", async () => {
		const { stats, rows } = await run(ROWS, [])

		expect(stats).toMatchObject({ read: 7, emitted: 5, skipped: 2 })
		expect(rows).toHaveLength(5)

		for (const row of rows as Array<SliceRow & { country?: string; locale?: string }>) {
			expect(row.country).toBe("SG")
			expect(row.locale).toBe("en-SG")
			expect(row.source).toBe("synth-sg-register")
			expect(row.synth_method).toMatch(/^sg-register:(official|block|bracket_postcode|building_led)$/u)
			expect(row.tokens?.length).toBe(row.labels?.length)
			expect(row.labels?.filter((label) => label.endsWith("house_number"))).toHaveLength(1)
			expect(row.labels?.filter((label) => label.endsWith("postcode"))).toHaveLength(1)
		}
	})

	it("honors --count and --golden", async () => {
		const { rows } = await run(ROWS, [], { count: 2, golden: true })

		expect(rows).toHaveLength(2)
		expect(rows[0]).toMatchObject({ country: "SG", locale: "en-SG" })
		expect(rows[0]?.labels).toBeUndefined()
	})

	it("refuses to run without --input", async () => {
		await expect(sgRegisterRecipe.run({ output: "", seed: 1, variants: 1 }, () => {})).rejects.toThrow(/--input/u)
	})
})
