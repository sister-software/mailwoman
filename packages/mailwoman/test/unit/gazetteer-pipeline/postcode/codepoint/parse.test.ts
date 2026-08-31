/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The CSV reader and the metadata manifest parser. Quoting cases are pinned at both the resident-line compatibility
 *   helper and the streaming reader, because a newline crossing a chunk boundary is where line-first parsing fails.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { parseCodePointMetadata } from "mailwoman/gazetteer-pipeline/postcode/codepoint/extract"
import {
	createCodePointParseStats,
	normalizeCodePointSpacing,
	postcodeArea,
	readCodePointCSV,
	splitCSVLine,
} from "mailwoman/gazetteer-pipeline/postcode/codepoint/parse"
import { resolvePath } from "path-ts"
import { expect, test } from "vitest"

test("splitCSVLine strips the wrapping quotes Code-Point puts on every text field", () => {
	const row = splitCSVLine('"SW10 0AA",10,526506,176966,"E92000001","E19000003","E18000007","","E09000013","E05013747"')

	expect(row).toHaveLength(10)
	expect(row[0]).toBe("SW10 0AA")
	expect(row[1]).toBe("10")
	expect(row[2]).toBe("526506")
	expect(row[4]).toBe("E92000001")
	// The empty admin-county field is an empty string, not a `""` literal and not undefined.
	expect(row[7]).toBe("")
})

test("splitCSVLine treats a comma inside quotes as data", () => {
	// The case that defeats the shared splitter. No row in the 2026-05 cut needs this; the format allows it.
	expect(splitCSVLine('"AB1 1AA",10,1,2,"X, Y","b"')).toEqual(["AB1 1AA", "10", "1", "2", "X, Y", "b"])
})

test("splitCSVLine unescapes a doubled quote inside a quoted field", () => {
	expect(splitCSVLine('"a""b",1')).toEqual(['a"b', "1"])
})

test("splitCSVLine keeps empty trailing and interior fields", () => {
	// Arity is how the reader rejects a bad row, so a dropped trailing empty would turn a valid 10-column
	// row into a rejected 9-column one.
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
	// Code-Point is SPECIFIED as a 7-character field with the outward code left-justified, so a short
	// postcode is padded to `B1  1AA`. Left alone that is a different string from `B1 1AA` and would land
	// as a second, duplicate place.
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

test("parseCodePointMetadata reads the header fields and the per-area row manifest", () => {
	// Verbatim head of the 2026-05 `Doc/metadata.txt`, including its leading whitespace on the count rows.
	const metadata = parseCodePointMetadata(
		[
			"ORDNANCE SURVEY",
			"PRODUCT: OS CODE-POINT_03.02",
			"DATASET VERSION NUMBER: 2026.2.0",
			"COPYRIGHT DATE: 20260420",
			"RM UPDATE DATE: 20260417",
			"      AB\t17403",
			"      AL\t7789",
			"       B\t41835",
			"      ZE\t658",
		].join("\n")
	)

	expect(metadata.product).toBe("OS CODE-POINT_03.02")
	expect(metadata.datasetVersion).toBe("2026.2.0")
	expect(metadata.copyrightDate).toBe("20260420")
	expect(metadata.royalMailUpdateDate).toBe("20260417")
	expect(metadata.rowsByArea).toEqual({ AB: 17_403, AL: 7789, B: 41_835, ZE: 658 })
	expect(metadata.totalRows).toBe(17_403 + 7789 + 41_835 + 658)
})

test("parseCodePointMetadata survives an unknown header field", () => {
	// OS has added header rows before (RM UPDATE DATE postdates the product). A new one must not be fatal
	// and must not be mistaken for an area count.
	const metadata = parseCodePointMetadata(
		["PRODUCT: OS CODE-POINT_03.02", "SOME NEW FIELD: whatever", "      AB\t17403"].join("\n")
	)

	expect(metadata.product).toBe("OS CODE-POINT_03.02")
	expect(metadata.rowsByArea).toEqual({ AB: 17_403 })
})
