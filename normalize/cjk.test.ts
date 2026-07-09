/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   CJK input normalization (#291): the postal-mark strip + full-width fold, and its composition into
 *   the `normalize()` pipeline (including the offset map back to raw).
 */
import { describe, expect, it } from "vitest"

import { applyCjkNormalization } from "./cjk.ts"
import { normalize } from "./compute.ts"

describe("applyCjkNormalization", () => {
	it("strips the postal mark 〒 (the byte-fallback OOV that poisons the postcode parse)", () => {
		const r = applyCjkNormalization("〒104-0061")
		expect(r.text).toBe("104-0061")
		expect(r.stripped).toBe(1)
		// every surviving char maps back to its original index (〒 was at 0)
		expect(r.map).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
	})

	it("folds full-width digits, letters, and the full-width hyphen-minus to ASCII", () => {
		const r = applyCjkNormalization("１０４－００６１") // full-width digits + full-width hyphen-minus U+FF0D
		expect(r.text).toBe("104-0061")
		expect(r.folded).toBe(8)
	})

	it("folds the ideographic space to an ASCII space", () => {
		const r = applyCjkNormalization("東京　都")
		expect(r.text).toBe("東京 都")
		expect(r.folded).toBe(1)
	})

	it("leaves kanji numerals alone (place names carry them — 三田, 四谷)", () => {
		const r = applyCjkNormalization("三田") // Mita — must NOT become "3田"
		expect(r.text).toBe("三田")
		expect(r.folded).toBe(0)
		expect(r.stripped).toBe(0)
	})

	it("is a no-op for Latin input (identity map, unchanged text)", () => {
		const input = "1-1-1 Ginza, Chuo-ku, Tokyo 104-0061"
		const r = applyCjkNormalization(input)
		expect(r.text).toBe(input)
		expect(r.folded).toBe(0)
		expect(r.stripped).toBe(0)
		expect(r.map).toEqual([...input].map((_, i) => i))
	})
})

describe("normalize() integration", () => {
	it("strips 〒 and records the transform; whitespace collapse tidies the gap", () => {
		const out = normalize("〒104-0061 東京都中央区銀座1丁目1番1号")
		expect(out.normalized.startsWith("104-0061 東京")).toBe(true)
		expect(out.transforms.some((t) => t.kind === "normalize_cjk")).toBe(true)
	})

	it("the offset map points normalized chars back to their raw positions", () => {
		const raw = "〒104東京"
		const out = normalize(raw)
		expect(out.normalized).toBe("104東京")
		// normalized[0]='1' came from raw[1]; the run is contiguous after the stripped 〒 at raw[0]
		expect(out.offsetMap[0]).toBe(1)
		expect(raw[out.offsetMap[0]!]).toBe("1")
		expect(raw[out.offsetMap[out.normalized.length - 1]!]).toBe("京")
	})

	it("folds the JP minus-sign block separator (U+2212) to an ASCII hyphen (1−2−3 → 1-2-3)", () => {
		const out = normalize("銀座1−2−3")
		expect(out.normalized).toBe("銀座1-2-3")
	})

	it("does not add a normalize_cjk transform for Latin input", () => {
		const out = normalize("12 rue de la Paix, 75002 Paris")
		expect(out.transforms.some((t) => t.kind === "normalize_cjk")).toBe(false)
		expect(out.normalized).toBe("12 rue de la Paix, 75002 Paris")
	})
})
