import { describe, expect, it } from "vitest"

import { type CensusTokenizer, censusReachability } from "#tools/eval-harness/heldout/dataset/reachability"
import type { HeldoutRow } from "#tools/eval-harness/heldout/per/country"

/**
 * A tokenizer that ends a piece at each given offset, so each piece holds the whitespace before it.
 */
function piecesEndingAt(ends: Record<string, number[]>): CensusTokenizer {
	return {
		encode(text) {
			const bounds = [0, ...(ends[text] ?? []), text.length]

			const pieces = bounds.slice(1).map((end, i) => ({
				piece: text.slice(bounds[i], end),
				id: 0,
				start: bounds[i]!,
				end,
			}))

			return { pieces, ids: [] }
		},
	}
}

function row(raw: string, spans: [number, number, string][]): HeldoutRow {
	return {
		raw,
		span_starts: spans.map((s) => s[0]),
		span_ends: spans.map((s) => s[1]),
		span_tags: spans.map((s) => s[2]),
		country: "HR",
		source: "test",
		source_id: raw,
		group: raw,
	}
}

describe("censusReachability", () => {
	const croatian = row("Ilica 1, HR-23211 Zadar", [
		[0, 5, "street"],
		[6, 7, "house_number"],
		[12, 17, "postcode"],
		[18, 23, "locality"],
	])

	it("counts a postcode start that falls inside a hyphen-and-digits piece", () => {
		// Pieces: `Ilica` ` 1` `,` ` HR` `-232` `11` ` Zadar`
		const census = censusReachability([croatian], piecesEndingAt({ [croatian.raw]: [5, 7, 8, 11, 15, 17] }))

		expect(census.unreachableAtClassChange).toBe(1)

		expect(census.examples[0]).toMatchObject({
			tag: "postcode",
			side: "start",
			edgeClass: "connector|digit",
			piece: "-232",
		})
	})

	it("reaches every edge when hyphen and digits are pieces of their own", () => {
		const census = censusReachability(
			[croatian],
			piecesEndingAt({ [croatian.raw]: [5, 7, 8, 11, 12, 13, 14, 15, 16, 17] })
		)

		expect(census.unreachable).toBe(0)
	})

	it("reports an edge inside a run of letters without counting it against admission", () => {
		const glued = row("CHINAGANSUDUJIACHUAN", [
			[0, 10, "region"],
			[10, 20, "locality"],
		])

		const census = censusReachability([glued], piecesEndingAt({ [glued.raw]: [9, 11] }))

		expect(census.unreachable).toBe(2)
		expect(census.unreachableAtClassChange).toBe(0)
	})

	it("leaves out rows the script router sends to the character path", () => {
		const han = row("东京都渋谷区神宮前1丁目", [[0, 3, "region"]])
		const census = censusReachability([han], piecesEndingAt({}))

		expect(census.characterPathRows).toBe(1)
		expect(census.edges).toBe(0)
	})
})
