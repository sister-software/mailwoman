import { describe, expect, it } from "vitest"

import { FR_LEVEL_DESIGNATORS } from "#level-semantics"
import {
	designatorCollisions,
	designatorRowsFromLevels,
	foldDesignatorSpelling,
	type PostalDesignatorTable,
} from "#postal-designator"

describe("designatorRowsFromLevels", () => {
	it("reads French floors from the floor lexicon with their concepts", () => {
		const rows = designatorRowsFromLevels(FR_LEVEL_DESIGNATORS, { script: "Latn", language: "fr", source: "test" })
		const byCode = new Map(rows.map((row) => [row.spelling, row.concept]))

		expect(byCode.get("RDC")).toBe("ground_floor")
		expect(byCode.get("SOUS-SOL")).toBe("basement")
		expect(byCode.get("ÉTAGE")).toBe("floor")
	})
})

describe("designatorCollisions", () => {
	const row = (spelling: string, concept: "post_office_box" | "unit") =>
		({
			spelling,
			abbreviations: [],
			script: "Latn",
			position: "prefix",
			concept,
			language: "xx",
			source: "test",
		}) as const

	it("reports a spelling two countries read as different concepts", () => {
		const tables: PostalDesignatorTable[] = [
			{ country: "CH", rows: [row("C.P.", "post_office_box")] },
			{ country: "XX", rows: [row("CP", "unit")] },
		]

		expect(designatorCollisions(tables)).toEqual([
			{
				spelling: "CP",
				readings: [
					{ country: "CH", concept: "post_office_box" },
					{ country: "XX", concept: "unit" },
				],
			},
		])
	})

	it("leaves out a spelling every country reads the same way", () => {
		const tables: PostalDesignatorTable[] = [
			{ country: "CH", rows: [row("CP", "post_office_box")] },
			{ country: "IT", rows: [row("C.P.", "post_office_box")] },
		]

		expect(designatorCollisions(tables)).toEqual([])
	})
})

describe("foldDesignatorSpelling", () => {
	it("folds case, periods and whitespace", () => {
		expect(foldDesignatorSpelling("  Cx.  Postal ")).toBe("CX POSTAL")
	})
})
