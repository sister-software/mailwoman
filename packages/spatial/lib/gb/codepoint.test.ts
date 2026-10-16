/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The Code-Point Open CSV reader. The tests pin quoted fields at both the resident-line compatibility
 *   helper and the streaming reader, because a newline crossing a chunk boundary is where line-first parsing fails.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { resolvePath } from "path-ts"
import { expect, test } from "vitest"

import {
	createCodePointParseStats,
	normalizeCodePointSpacing,
	postcodeArea,
	readCodePointCSV,
	splitCSVLine,
} from "#gb/codepoint"

test("splitCSVLine strips the wrapping quotes Code-Point puts on every text field", () => {
	const row = splitCSVLine('"SW10 0AA",10,526506,176966,"E92000001","E19000003","E18000007","","E09000013","E05013747"')

	expect(row).toHaveLength(10)
	expect(row[0]).toBe("SW10 0AA")
	expect(row[1]).toBe("10")
	expect(row[2]).toBe("526506")
	expect(row[4]).toBe("E92000001")
	// The empty admin-county field is an empty string rather than a `""` literal and not undefined.
	expect(row[7]).toBe("")
})

test("splitCSVLine treats a comma inside quotes as data", () => {
	// The case that defeats the shared splitter.
	// No row in the 2026-05 extract needs this.
	// The format allows it.
	expect(splitCSVLine('"AB1 1AA",10,1,2,"X, Y","b"')).toEqual(["AB1 1AA", "10", "1", "2", "X, Y", "b"])
})

test("splitCSVLine unescapes a doubled quote inside a quoted field", () => {
	expect(splitCSVLine('"a""b",1')).toEqual(['a"b', "1"])
})

test("splitCSVLine keeps empty trailing and interior fields", () => {
	// Arity is how the reader rejects a bad row, so a dropped trailing empty would
	// turn a valid 10-column row into a rejected 9-column one.
	expect(splitCSVLine("a,,c,")).toEqual(["a", "", "c", ""])
})

test("readCodePointCSV keeps a quoted multiline field in one logical record and accounts for every skip", async () => {
	await using scratch = await temporaryDirectory("mailwoman-codepoint-parse-")

	const csvPath = resolvePath(scratch.path, "rows.csv")
	// Exceeds the adaptive bulk threshold so the quoted field and its newline cross filesystem read boundaries.
	const multilineHealthAuthority = `"health,${"x".repeat(140_000)}\r\nauthority"`

	await writeLocalTextFile(
		[
			`"SW10 0AA",10,526506,176966,"E92000001",${multilineHealthAuthority},"","","",""`,
			'"AB1 1AA",90,0,0,"S92000003","","","","",""',
			'"B1 1AA",10,1,2,"E92000001","","","",""',
			'"EC1A 1BB",10,1,2,"E92000001","","","","","","extra"',
		].join("\r\n") + "\r\n",
		csvPath
	)

	const stats = createCodePointParseStats()
	const rows = await Array.fromAsync(readCodePointCSV(csvPath, stats))

	expect(rows).toHaveLength(1)
	expect(rows[0]).toMatchObject({ postcode: "SW10 0AA", quality: 10, countryCode: "E92000001", country: "ENG" })

	expect(stats).toEqual({
		read: 4,
		yielded: 1,
		skippedNoCoordinate: 1,
		skippedMalformed: 2,
		yieldedByArea: { SW: 1 },
	})
})

test("normalizeCodePointSpacing collapses the fixed-width padded form", () => {
	// Code-Point is specified as a 7-character field with the outward code left-justified,
	// so a short postcode is padded to `B1 1AA`.
	// Unchanged, that is a different string from `B1 1AA` and would land as a second, duplicate place.
	expect(normalizeCodePointSpacing('"B1  1AA"'.replaceAll('"', ""))).toBe("B1 1AA")
	expect(normalizeCodePointSpacing("sw1a 1aa")).toBe("SW1A 1AA")
	expect(normalizeCodePointSpacing("  EC1A 1BB  ")).toBe("EC1A 1BB")
})

test("postcodeArea takes the leading letters, which is what the manifest counts by", () => {
	expect(postcodeArea("SW1A 1AA")).toBe("SW")
	expect(postcodeArea("B33 8TH")).toBe("B")
	expect(postcodeArea("EC1A 1BB")).toBe("EC")
	expect(postcodeArea("ZE1 0AA")).toBe("ZE")
})
