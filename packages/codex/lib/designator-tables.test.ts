import { describe, expect, it } from "vitest"

import { designatorsInText, designatorTableFor, POSTAL_DESIGNATOR_TABLES } from "#designator-tables"
import { DESIGNATOR_CLASS, designatorClass, designatorCollisions, DesignatorConcept } from "#postal-designator"

describe("POSTAL_DESIGNATOR_TABLES", () => {
	it("holds one table per country, each row well formed", () => {
		const countries = POSTAL_DESIGNATOR_TABLES.map((table) => table.country)

		expect(new Set(countries).size).toBe(countries.length)

		for (const table of POSTAL_DESIGNATOR_TABLES) {
			expect(table.country).toMatch(/^[A-Z]{2}$/u)
			expect(table.rows.length).toBeGreaterThan(0)

			for (const row of table.rows) {
				const label = `${table.country} ${row.spelling}`

				expect(row.spelling.trim(), label).not.toBe("")
				expect(row.script, label).toMatch(/^[A-Z][a-z]{3}$/u)
				expect(row.language, label).toMatch(/^[a-z]{2,3}$/u)
				expect(row.source.trim(), label).not.toBe("")
				expect(Object.keys(DESIGNATOR_CLASS), label).toContain(row.concept)
			}
		}
	})

	it("reaches every concept in at least one country", () => {
		const reached = new Set(POSTAL_DESIGNATOR_TABLES.flatMap((table) => table.rows.map((row) => row.concept)))

		expect(Object.values(DesignatorConcept).filter((concept) => !reached.has(concept))).toEqual([])
	})

	it("reports UG as a basement in German-speaking countries and an upper ground floor in Britain and Ireland", () => {
		const ug = designatorCollisions(POSTAL_DESIGNATOR_TABLES).find((c) => c.spelling === "UG")

		expect(ug?.readings).toEqual(
			expect.arrayContaining([
				{ country: "DE", concept: "basement" },
				{ country: "GB", concept: "mezzanine" },
			])
		)
	})
})

describe("designatorsInText", () => {
	const classesIn = (text: string, country: string) =>
		new Set(designatorsInText(text, designatorTableFor(country)!).map((row) => designatorClass(row)))

	it("finds the designators of the board inputs that need them", () => {
		const singapore = classesIn("Blk 35 Brighton Avenue #09-71 Singapore 559280", "SG")

		expect(singapore.has("premise")).toBe(true)
		expect(singapore.has("sub_premise") || singapore.has("number_mark")).toBe(true)
		expect(classesIn("Flat A, 12/F, Block B", "HK").has("vertical")).toBe(true)
		expect(classesIn("Gate 12, Terminal 2, Manchester Airport, Manchester, M90 1QX", "GB").has("premise")).toBe(true)
		expect(classesIn("Platform 9¾, King's Cross, Euston Rd., London N1C 4AP", "GB").has("sub_premise")).toBe(true)
	})

	it("leaves a designator inside a longer word alone", () => {
		expect(designatorsInText("Rmx Street", { country: "XX", rows: [roomRow("Rm")] })).toEqual([])
		expect(designatorsInText("Rm 12", { country: "XX", rows: [roomRow("Rm")] })).toHaveLength(1)
	})
})

function roomRow(spelling: string) {
	return {
		spelling,
		abbreviations: [],
		script: "Latn",
		position: "prefix",
		concept: "room",
		language: "en",
		source: "test",
	} as const
}
