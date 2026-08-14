/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Covers {@link readCSVRecords}' value handling — specifically the line-break collapse, which exists
 *   because a quote-aware parse can return something the hand-rolled splitter it replaced never could.
 *   The fixtures are real rows from `us/ia/statewide.csv`, which carries 12 of these.
 *
 *   Fixtures arrive one byte per chunk, so a value's opening and closing quote never land in the same
 *   read. That is the shape a real source has — the recipes read members of multi-gigabyte archives —
 *   and the case where a scanner that loses quote state across a chunk boundary splits a record in two.
 */

import { describe, expect, it } from "vitest"

import { type CSVRecord, readCSVRecords } from "./scaffold.ts"

async function* byteAtATime(csv: string): AsyncGenerator<Uint8Array> {
	for (const byte of new TextEncoder().encode(csv)) {
		yield Uint8Array.of(byte)
	}
}

const read = (csv: string): Promise<CSVRecord[]> => readCSVRecords(byteAtATime(csv)).toArray()

describe("readCSVRecords", () => {
	const HEADER = "LON,LAT,NUMBER,STREET,UNIT,CITY,POSTCODE\n"

	it("collapses a line break inside a quoted value, keeping the record whole", async () => {
		// us/ia/statewide.csv:5953 — the unit designator is written across two physical lines.
		const [row] = await read(`${HEADER}-94.8,42.0,120,NORTH MAIN STREET,"#2\n#2",CARROLL,51401\n`)

		expect(row).toBeDefined()
		expect(row!.unit).toBe("#2 #2")
		// The point of collapsing rather than dropping: the rest of the address is intact and usable.
		expect(row!.city).toBe("CARROLL")
		expect(row!.postcode).toBe("51401")
	})

	it("collapses CRLF inside a quoted value too", async () => {
		const [row] = await read(`${HEADER}-91.5,41.6,1000,W BENTON ST,"314E\r\n314A",IOWA CITY,52246\n`)

		expect(row!.unit).toBe("314E 314A")
	})

	it("leaves runs of spaces and tabs exactly as the source wrote them", async () => {
		// The collapse is scoped to \r\n on purpose. Spaces and tabs could ALWAYS appear, and every shard
		// built to date contains them — widening to \s+ would rewrite values on rows with no line break.
		const [row] = await read(`${HEADER}-94.8,42.0,120,NORTH   MAIN\tSTREET,,CARROLL,51401\n`)

		expect(row!.street).toBe("NORTH   MAIN\tSTREET")
	})

	it("trims surrounding whitespace, as it always has", async () => {
		const [row] = await read(`${HEADER}-94.8,42.0,120,  MAIN ST  ,,CARROLL,51401\n`)

		expect(row!.street).toBe("MAIN ST")
	})

	it("keeps a quoted column delimiter inside its value", async () => {
		const [row] = await read(`${HEADER}-94.8,42.0,120,"MAIN ST, W",,CARROLL,51401\n`)

		expect(row!.street).toBe("MAIN ST, W")
		expect(row!.city).toBe("CARROLL")
	})

	it("lower-cases header names so a recipe can name columns in one case", async () => {
		const [row] = await read(`${HEADER}-94.8,42.0,120,MAIN ST,,CARROLL,51401\n`)

		expect(row!.street).toBe("MAIN ST")
		expect(row!.STREET).toBeUndefined()
	})

	it("reads a column the record stops short of as empty, and an undeclared one as undefined", async () => {
		const [row] = await read(`${HEADER}-94.8,42.0,120,MAIN ST\n`)

		expect(row!.city).toBe("")
		expect(row!.county).toBeUndefined()
	})

	it("composes take, closing the source without reading the rest", async () => {
		const rows = `${HEADER}${Array.from({ length: 500 }, (_, i) => `-94.8,42.0,${i},MAIN ST,,CARROLL,51401`).join("\n")}\n`
		const held = await readCSVRecords(byteAtATime(rows)).take(3).toArray()

		expect(held).toHaveLength(3)
		expect(held.map((row) => row.number)).toEqual(["0", "1", "2"])
	})
})
