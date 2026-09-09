/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { mulberry32 } from "@mailwoman/core/utils"
import {
	bdRegisterRecipe,
	drawIslamabadSector,
	pkRegisterRecipe,
	renderSouthAsiaRegister,
} from "@mailwoman/corpus/recipes/south-asia-register"
import { type SliceRow, sliceRunner } from "@mailwoman/corpus/test-kit/corpus-recipe"
import { describe, expect, it } from "vitest"

const runPK = sliceRunner("pk-register", pkRegisterRecipe, 5)
const runBD = sliceRunner("bd-register", bdRegisterRecipe, 5)

const PK_ROWS = [
	{ street: "Street 25", number: "4", city: "Islamabad" },
	{ street: "Street 5", number: "B230", city: "Karachi", place: "Block 3" },
	{ street: "38th Street", number: "4", city: "Karachi", place: "DHA Phase 6", postcode: "75500" },
	{ street: "Islamabad Highway", number: "B-S-1", postcode: "44000" },
	{ street: "Chak shehzad", number: "Shehzad Town", city: "islamabad", postcode: "46000" },
]

const BD_ROWS = [
	{ street: "Kalabagan 1st Ln", number: "58", city: "Dhaka", postcode: "1205" },
	{ street: "Road 4", number: "34", city: "Uttara, Dhaka", suburb: "Sector 9", postcode: "1230" },
	{ street: "Road 104", number: "24", city: "Dhaka" },
	{ street: "Fuller Road", number: "-", city: "Dhaka" },
]

describe("drawIslamabadSector", () => {
	it("draws a sector code of the capital's grid", () => {
		for (let seed = 0; seed < 32; seed++) {
			expect(drawIslamabadSector(mulberry32(seed))).toMatch(/^[EFGI]-(?:6|7|8|9|10|11)\/[1-4]$/u)
		}
	})
})

describe("renderSouthAsiaRegister", () => {
	it("renders the Islamabad house line with House untagged and a drawn sector as the dependent locality", () => {
		const rendering = renderSouthAsiaRegister(
			{ house_number: "4", street: "Street 25", locality: "Islamabad" },
			mulberry32(1),
			"house"
		)

		expect(rendering?.raw).toMatch(/^House (?:No\. |# )?4, Street 25, [EFGI]-\d+\/[1-4], Islamabad$/u)

		expect(rendering?.components).toEqual({
			house_number: "4",
			street: "Street 25",
			locality: "Islamabad",
			dependent_locality: expect.stringMatching(/^[EFGI]-\d+\/[1-4]$/u),
		})
	})

	it("renders the Dhaka plain line with the trailing postcode and no dash", () => {
		const rendering = renderSouthAsiaRegister(
			{ house_number: "58", street: "Kalabagan 1st Ln", locality: "Dhaka", postcode: "1205" },
			mulberry32(1),
			"plain"
		)

		expect(rendering).toEqual({
			raw: "58 Kalabagan 1st Ln, Dhaka 1205",
			components: { house_number: "58", street: "Kalabagan 1st Ln", locality: "Dhaka", postcode: "1205" },
			register: "plain",
		})
	})

	it("keeps the row's own scheme and refuses a row without a number or a locality", () => {
		const rendering = renderSouthAsiaRegister(
			{ house_number: "B230", street: "Street 5", locality: "Karachi", dependent_locality: "Block 3" },
			mulberry32(2),
			"house"
		)

		expect(rendering?.raw).toMatch(/^House (?:No\. |# )?B230, Street 5, Block 3, Karachi$/u)
		expect(renderSouthAsiaRegister({ street: "Street 5", locality: "Karachi" }, mulberry32(2))).toBeNull()

		const noLocality = { house_number: "5", street: "Street 5", postcode: "44000" }

		expect(renderSouthAsiaRegister(noLocality, mulberry32(2))).toBeNull()
	})

	it("keeps every component a substring of the line across the seeds", () => {
		for (let seed = 0; seed < 64; seed++) {
			const rendering = renderSouthAsiaRegister(
				{ house_number: "34", street: "Road 4", locality: "Dhaka", dependent_locality: "Uttara", postcode: "1230" },
				mulberry32(seed)
			)!

			for (const [tag, value] of Object.entries(rendering.components)) {
				expect(rendering.raw, `${tag} of ${rendering.raw}`).toContain(value)
			}
		}
	})
})

describe("pk-register recipe", () => {
	it("emits an aligned row per usable register row and skips the rows the adapter refuses", async () => {
		const { stats, rows } = await runPK(PK_ROWS, [])

		expect(stats).toMatchObject({ read: 5, emitted: 3, skipped: 2 })

		for (const row of rows as Array<SliceRow & { country?: string; locale?: string; license?: string }>) {
			expect(row.country).toBe("PK")
			expect(row.locale).toBe("en-PK")
			expect(row.license).toBe("ODbL-1.0")
			expect(row.synth_method).toMatch(/^pk-register:(house|plain)$/u)
			expect(row.labels?.filter((label) => label.endsWith("house_number"))).toHaveLength(1)
		}

		const houseLines = rows.filter((row) => row.raw.startsWith("House"))

		for (const line of houseLines) {
			expect(line.labels?.[0]).toBe("O")
		}
	})
})

describe("bd-register recipe", () => {
	it("emits Dhaka rows with the trailing postcode tagged and refuses to run without --input", async () => {
		const { stats, rows } = await runBD(BD_ROWS, [])

		expect(stats).toMatchObject({ read: 4, emitted: 3, skipped: 1 })

		const withPostcode = rows.filter((row) => row.components?.postcode)

		expect(withPostcode).toHaveLength(2)

		for (const row of withPostcode) {
			expect(row.raw.endsWith(`Dhaka ${row.components!.postcode}`)).toBe(true)
			expect(row.labels?.at(-1)).toBe("B-postcode")
		}

		await expect(bdRegisterRecipe.run({ output: "", seed: 1, variants: 1 }, () => {})).rejects.toThrow(/--input/u)
	})
})
