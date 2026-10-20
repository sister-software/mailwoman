/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file `postcode-order` — the postcode sits opposite the native slot libaddressinput states, and every span aligns.
 */

import { describe, expect, it } from "vitest"

import { postcodeOrderRecipe, postcodeOrderSource } from "#recipes/postcode-order"
import { recipeRunner, type RecipeRow } from "#test-kit/corpus-recipe"

const run = recipeRunner("postcode-order", postcodeOrderRecipe, 4242)

const roma = {
	house_number: "12",
	street: "Via del Corso",
	locality: "Roma",
	postcode: "00186",
	cc: "IT",
	source: "openaddresses",
	license: "test license",
	streetFirst: true,
	baseSourceID: "it-1",
}

const saoPaulo = {
	house_number: "1000",
	street: "Av. Paulista",
	locality: "São Paulo",
	postcode: "01310-100",
	cc: "BR",
	source: "openaddresses",
	license: "test license",
	streetFirst: true,
	baseSourceID: "br-1",
}

const paris = {
	house_number: "8",
	street: "Rue de Rivoli",
	locality: "Paris",
	postcode: "75004",
	cc: "FR",
	source: "ban",
	license: "test license",
	streetFirst: false,
	baseSourceID: "fr-1",
}

const repeat = (tuple: object, n = 24): object[] => Array.from({ length: n }, () => ({ ...tuple }))

/**
 * Each span's text, read back out of `raw` by its offsets, keyed by tag.
 */
function spanTexts(row: RecipeRow & { span_starts?: number[]; span_ends?: number[]; span_tags?: string[] }) {
	const { span_starts: starts = [], span_ends: ends = [], span_tags: tags = [] } = row

	expect(starts).toHaveLength(tags.length)
	expect(ends).toHaveLength(tags.length)

	return Object.fromEntries(tags.map((tag, i) => [tag, row.raw.slice(starts[i], ends[i])]))
}

describe("postcode-order", () => {
	it("writes an Italian postcode after the locality, where IT's layout writes it before", async () => {
		const { rows } = await run(repeat(roma), [])

		expect(rows).toHaveLength(24)

		for (const row of rows) {
			expect(row.raw.indexOf("00186")).toBeGreaterThan(row.raw.indexOf("Roma"))
			expect(row.raw.startsWith("Via del Corso")).toBe(true)
		}

		expect(rows.some((row) => row.raw === "Via del Corso 12, Roma 00186")).toBe(true)
	})

	it("writes a Brazilian postcode before the locality, where BR's layout writes it after", async () => {
		const { rows } = await run(repeat(saoPaulo), [])

		for (const row of rows) {
			expect(row.raw.indexOf("01310-100")).toBeLessThan(row.raw.indexOf("São Paulo"))
		}

		expect(rows.some((row) => row.raw === "Av. Paulista 1000, 01310-100 São Paulo")).toBe(true)
	})

	it("keeps the source's house-number-first order", async () => {
		const { rows } = await run(repeat(paris), [])

		expect(rows.every((row) => row.raw.startsWith("8 Rue de Rivoli"))).toBe(true)
		expect(rows.some((row) => row.raw === "8 Rue de Rivoli, Paris 75004")).toBe(true)
	})

	it("aligns every span to the component it labels, across every separator variant", async () => {
		const { rows } = await run([...repeat(roma), ...repeat(saoPaulo)].slice(0, 24), [])
		const brRows = await run(repeat(saoPaulo), [])

		for (const row of [...rows, ...brRows.rows]) {
			const texts = spanTexts(row as Parameters<typeof spanTexts>[0])

			expect(texts).toEqual(row.components)
			expect(Object.keys(texts).toSorted()).toEqual(["house_number", "locality", "postcode", "street"])
		}

		// The variants this recipe draws all appear, so the alignment above covers each of them.
		const raws = [...rows, ...brRows.rows].map((row) => row.raw)

		expect(raws.some((raw) => raw.includes("\n"))).toBe(true)
		expect(raws.some((raw) => raw.includes("Roma, 00186") || raw.includes("01310-100, São Paulo"))).toBe(true)
		expect(raws.some((raw) => raw.includes("Via del Corso, 12") || raw.includes("Av. Paulista, 1000"))).toBe(true)
	})

	it("labels each row with its base source and forwards the base record's id", async () => {
		const { rows } = await run([roma], [])

		expect(rows[0]!.source).toBe(postcodeOrderSource("openaddresses"))
		expect(rows[0]!.source).toBe("postcode-order-openaddresses")
		expect(rows[0]!.base_source_id).toBe("it-1")
		expect(rows[0]!.surface).toBe("composed")
	})

	it("writes no row for a country libaddressinput does not describe, rather than guessing an order", async () => {
		// The UAE states no postcode, and Japan's layout prints no locality field, so neither states an order.
		const { rows, stats } = await run(
			[
				{ ...roma, cc: "AE" },
				{ ...roma, cc: "JP" },
			],
			[]
		)

		expect(rows).toEqual([])
		expect(stats).toMatchObject({ read: 2, emitted: 0, skipped: 2 })
	})

	it("refuses a tuples file that mixes base sources, so one overlay file holds one source", async () => {
		await expect(run([roma, paris], [])).rejects.toThrow(/one tuples file per source/)
	})
})
