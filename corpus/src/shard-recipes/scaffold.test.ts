/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Covers {@link readCSVRecords}' value handling — specifically the line-break collapse, which exists
 *   because a quote-aware parse can return something the hand-rolled splitter it replaced never could.
 *   The fixtures are real rows from `us/ia/statewide.csv`, which carries 12 of these.
 */

import { describe, expect, it } from "vitest"

import { type CSVRecord, readCSVRecords } from "./scaffold.ts"

const read = (csv: string): CSVRecord[] => Array.from(readCSVRecords(new TextEncoder().encode(csv)))

describe("readCSVRecords", () => {
	const HEADER = "LON,LAT,NUMBER,STREET,UNIT,CITY,POSTCODE\n"

	it("collapses a line break inside a quoted value, keeping the record whole", () => {
		// us/ia/statewide.csv:5953 — the unit designator is written across two physical lines.
		const [row] = read(`${HEADER}-94.8,42.0,120,NORTH MAIN STREET,"#2\n#2",CARROLL,51401\n`)

		expect(row).toBeDefined()
		expect(row!.unit).toBe("#2 #2")
		// The point of collapsing rather than dropping: the rest of the address is intact and usable.
		expect(row!.city).toBe("CARROLL")
		expect(row!.postcode).toBe("51401")
	})

	it("collapses CRLF inside a quoted value too", () => {
		const [row] = read(`${HEADER}-91.5,41.6,1000,W BENTON ST,"314E\r\n314A",IOWA CITY,52246\n`)

		expect(row!.unit).toBe("314E 314A")
	})

	it("leaves runs of spaces and tabs exactly as the source wrote them", () => {
		// The collapse is scoped to \r\n on purpose. Spaces and tabs could ALWAYS appear, and every shard
		// built to date contains them — widening to \s+ would rewrite values on rows with no line break.
		const [row] = read(`${HEADER}-94.8,42.0,120,NORTH   MAIN\tSTREET,,CARROLL,51401\n`)

		expect(row!.street).toBe("NORTH   MAIN\tSTREET")
	})

	it("trims surrounding whitespace, as it always has", () => {
		const [row] = read(`${HEADER}-94.8,42.0,120,  MAIN ST  ,,CARROLL,51401\n`)

		expect(row!.street).toBe("MAIN ST")
	})

	it("lower-cases header names so a recipe can name columns in one case", () => {
		const [row] = read(`${HEADER}-94.8,42.0,120,MAIN ST,,CARROLL,51401\n`)

		expect(row!.street).toBe("MAIN ST")
		expect(row!.STREET).toBeUndefined()
	})

	it("reads a column the record stops short of as empty, and an undeclared one as undefined", () => {
		const [row] = read(`${HEADER}-94.8,42.0,120,MAIN ST\n`)

		expect(row!.city).toBe("")
		expect(row!.county).toBeUndefined()
	})
})
