/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import { distinctBlocks, type FilingRow } from "#filings"

describe("US denominator control", () => {
	test("two speed groups in one block are one distinct block, and every other total stays unknown", () => {
		const rows: FilingRow[] = [
			{
				block: "360470001001000",
				provider: "Example Cable",
				technology: "cable",
				speedTier: "100/20",
				evidence: { source: "survey-2022" },
			},
			{
				block: "360470001001000",
				provider: "Example Cable",
				technology: "cable",
				speedTier: "1000/35",
				evidence: { source: "survey-2022" },
			},
		]

		expect(distinctBlocks(rows)).toEqual({ blocks: 1, buildings: "unknown", units: "unknown", subscribers: "unknown" })
	})
})
