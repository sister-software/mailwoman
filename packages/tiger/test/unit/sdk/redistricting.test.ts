/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The segment-2 H1 offsets, pinned against a synthetic row shaped like the real file.
 */

import { H1_OCCUPIED, H1_TOTAL, H1_VACANT, parseH1, SEG2_FIELD_COUNT } from "@mailwoman/tiger/sdk"
import { describe, expect, it } from "vitest"

/**
 * A segment-2 row with the published California 2020 state figures in the H1 slots: `ca000022020.pl` has 152 fields and
 * its state row ends 14,392,140 / 13,475,623 / 916,517.
 */
function californiaStateRow(): string[] {
	const fields = new Array<string>(SEG2_FIELD_COUNT).fill("0")

	fields[0] = "PLST"
	fields[1] = "CA"
	fields[2] = "000"
	fields[3] = "02"
	fields[4] = "0000001"
	fields[H1_TOTAL] = "14392140"
	fields[H1_OCCUPIED] = "13475623"
	fields[H1_VACANT] = "916517"

	return fields
}

describe("parseH1", () => {
	it("reads the three H1 counts from the tail of a 152-field row", () => {
		expect(parseH1(californiaStateRow())).toEqual({ housing_units: 14_392_140, occupied: 13_475_623, vacant: 916_517 })
	})

	it("tolerates the trailing CR a CRLF file leaves on the last field", () => {
		const fields = californiaStateRow()

		fields[H1_VACANT] = "916517\r"

		expect(parseH1(fields).vacant).toBe(916_517)
	})

	it("refuses a row whose counts do not add up — the check that separates a correct offset from a plausible one", () => {
		const fields = californiaStateRow()

		fields[H1_VACANT] = "916518"

		expect(() => parseH1(fields)).toThrow(/breaks the H1 invariant/u)
	})

	it("refuses a row with the wrong field count rather than reading the wrong slots", () => {
		expect(() => parseH1(californiaStateRow().slice(0, 151))).toThrow(/151 fields, expected 152/u)
	})
})
