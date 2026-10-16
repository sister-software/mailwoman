/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The Code-Point Open metadata manifest parser.
 */

import { expect, test } from "vitest"

import { parseCodePointMetadata } from "#gazetteer/postcode/codepoint/extract"

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
	// OS has added header rows before (RM update date postdates the product).
	// A new one must not be fatal and must not be mistaken for an area count.
	const metadata = parseCodePointMetadata(
		["PRODUCT: OS CODE-POINT_03.02", "SOME NEW FIELD: whatever", "      AB\t17403"].join("\n")
	)

	expect(metadata.product).toBe("OS CODE-POINT_03.02")
	expect(metadata.rowsByArea).toEqual({ AB: 17_403 })
})
