/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The TypeScript character encoder produces the same `char_ids` and `attention_mask` as the Python
 *   `encode_row_units` for 56 rows the Python side encoded under the v8-cjk contract (S 96, W 7, ctx 3): 50 JP board
 *   rows, 4 CN board rows with a Latin tail, one row past S, and one row with an astral code point.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { encodeCharUnits, PAD_CHAR_ID, UNK_CHAR_ID } from "@mailwoman/neural/char-encoder"
import { describe, expect, it } from "vitest"

interface Fixture {
	contract: { max_units: number; max_unit_width: number; ctx_chars: number; pad_id: number; unk_id: number }
	vocab: Record<string, number>
	rows: Array<{ raw: string; char_ids: number[][]; attention_mask: number[] }>
}

const fixture = await readLocalJSONFile<Fixture>(
	resolvePackagePath("@mailwoman/neural", "test", "fixtures", "char-encoder-cjk.json")
)

const vocabulary = new Map(Object.entries(fixture.vocab))

const contract = {
	maxUnits: fixture.contract.max_units,
	maxUnitWidth: fixture.contract.max_unit_width,
	ctxChars: fixture.contract.ctx_chars,
}

describe("encodeCharUnits", () => {
	it("agrees with the Python encoder on every fixture row", () => {
		expect(fixture.contract.pad_id).toBe(PAD_CHAR_ID)
		expect(fixture.contract.unk_id).toBe(UNK_CHAR_ID)
		expect(fixture.rows).toHaveLength(56)

		for (const row of fixture.rows) {
			const encoded = encodeCharUnits(row.raw, vocabulary, contract)

			expect(encoded.charIDs, row.raw).toEqual(row.char_ids)
			expect(encoded.attentionMask, row.raw).toEqual(row.attention_mask)
		}
	})

	it("treats an astral code point as one unit and slices it back out of the input by UTF-16 offsets", () => {
		const raw = "札幌市中央区北１条西𠮷野１"
		const encoded = encodeCharUnits(raw, vocabulary, contract)
		const astral = encoded.units.find((unit) => unit.text === "𠮷")!

		expect(encoded.units).toHaveLength(Array.from(raw).length)
		expect(raw.slice(astral.start, astral.end)).toBe("𠮷")
		expect(encoded.charIDs[encoded.units.indexOf(astral)]![contract.ctxChars]).toBe(UNK_CHAR_ID)
	})

	it("truncates to S units and pads a short row with attention 0", () => {
		const long = encodeCharUnits("東京都千代田区丸の内一丁目".repeat(8), vocabulary, contract)
		expect(long.units).toHaveLength(contract.maxUnits)
		expect(long.attentionMask.every((bit) => bit === 1)).toBe(true)

		const short = encodeCharUnits("東京", vocabulary, contract)
		expect(short.units).toHaveLength(2)
		expect(short.attentionMask.slice(0, 2)).toEqual([1, 1])
		expect(short.attentionMask.slice(2).every((bit) => bit === 0)).toBe(true)
		expect(short.charIDs[2]).toEqual(new Array(contract.maxUnitWidth).fill(PAD_CHAR_ID))
	})
})
