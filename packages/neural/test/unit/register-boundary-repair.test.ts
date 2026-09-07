/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The register boundary repair over char-aligned tokens. JP: the model's early close at the inner 市 of `中新川郡上市町`
 *   is closed by the six-town register, a real city followed by a 町-initial district is untouched, and a surface that
 *   is already a register name absorbs nothing. KR: the two emissions the CJK model produced on Haeundae rows it never
 *   saw — a split `해:B 운:B` and a truncated `해운대` — both close on `해운대구`, and a compound city extends to its ward.
 */

import type { BIOLabel, DecoderToken } from "@mailwoman/core/decoder"
import { repairJPMunicipalityLabels, repairKRSubregionLabels } from "@mailwoman/neural/register-boundary-repair"
import { describe, expect, it } from "vitest"

/**
 * One token per code point, labelled from a compact spec: `[[surface, tag], …]` in text order.
 */
function charTokens(spans: readonly (readonly [string, string | null])[]): { text: string; tokens: DecoderToken[] } {
	const tokens: DecoderToken[] = []
	let text = ""

	for (const [surface, tag] of spans) {
		for (const [k, ch] of [...surface].entries()) {
			const label = (tag === null ? "O" : k === 0 ? `B-${tag}` : `I-${tag}`) as BIOLabel
			tokens.push({ piece: ch, start: text.length, end: text.length + ch.length, label, confidence: 1 })
			text += ch
		}
	}

	return { text, tokens }
}

function spansOf(text: string, tokens: readonly DecoderToken[]): [string, string][] {
	const out: [string, string][] = []

	for (const t of tokens) {
		const tag = t.label === "O" ? null : t.label.slice(2)

		if (t.label.startsWith("B-") || !out.length || out.at(-1)![1] !== tag) {
			if (tag) {
				out.push([text.slice(t.start, t.end), tag])
			}
		} else {
			out.at(-1)![0] += text.slice(t.start, t.end)
		}
	}

	return out
}

describe("repairJPMunicipalityLabels", () => {
	it("extends 中新川郡上市 by the 町 the register names and re-opens the district after it", () => {
		const { text, tokens } = charTokens([
			["富山県", "prefecture"],
			["中新川郡上市", "municipality"],
			["町北島", "district"],
			["148-7", "house_number"],
		])

		const result = repairJPMunicipalityLabels(text, tokens)

		expect(result.changed).toBe(2)

		expect(spansOf(text, result.tokens)).toEqual([
			["富山県", "prefecture"],
			["中新川郡上市町", "municipality"],
			["北島", "district"],
			["148-7", "house_number"],
		])
	})

	it("completes the bare town form too", () => {
		const { text, tokens } = charTokens([
			["奈良県", "prefecture"],
			["下市", "municipality"],
			["町阿知賀", "district"],
		])

		expect(spansOf(text, repairJPMunicipalityLabels(text, tokens).tokens)).toEqual([
			["奈良県", "prefecture"],
			["下市町", "municipality"],
			["阿知賀", "district"],
		])
	})

	it("leaves a real city followed by a 町-initial district alone", () => {
		const { text, tokens } = charTokens([
			["富山県", "prefecture"],
			["富山市", "municipality"],
			["町村", "district"],
			["195", "house_number"],
		])

		const result = repairJPMunicipalityLabels(text, tokens)

		expect(result.changed).toBe(0)
		expect(result.tokens).toEqual(tokens)
	})

	it("absorbs nothing from a span that is already a register name", () => {
		const { text, tokens } = charTokens([
			["富山県", "prefecture"],
			["中新川郡上市町", "municipality"],
			["北島", "district"],
		])

		expect(repairJPMunicipalityLabels(text, tokens).changed).toBe(0)
	})

	it("never mutates its input", () => {
		const { text, tokens } = charTokens([
			["中新川郡上市", "municipality"],
			["町", "district"],
		])

		const snapshot = structuredClone(tokens)

		repairJPMunicipalityLabels(text, tokens)

		expect(tokens).toEqual(snapshot)
	})
})

describe("repairKRSubregionLabels", () => {
	it("joins a split B-B emission and absorbs the ward suffix: 해 + 운 + 대구 → 해운대구", () => {
		// The CJK model's labels on `부산광역시 해운대구 반송로 910-1`: 해:B-subregion 운:B-subregion 대:B-street 구:O.
		const tokens: DecoderToken[] = []
		let text = ""

		for (const [ch, label] of [
			...[..."부산광역시"].map((c, k) => [c, k === 0 ? "B-region" : "I-region"] as const),
			[" ", "O"],
			["해", "B-subregion"],
			["운", "B-subregion"],
			["대", "B-street"],
			["구", "O"],
			[" ", "O"],
			["반", "B-street"],
			["송", "I-street"],
			["로", "I-street"],
			[" ", "O"],
			...[..."910-1"].map((c, k) => [c, k === 0 ? "B-house_number" : "I-house_number"] as const),
		] as const) {
			tokens.push({
				piece: ch,
				start: text.length,
				end: text.length + ch.length,
				label: label as BIOLabel,
				confidence: 1,
			})

			text += ch
		}

		expect(spansOf(text, repairKRSubregionLabels(text, tokens).tokens)).toEqual([
			["부산광역시", "region"],
			["해운대구", "subregion"],
			["반송로", "street"],
			["910-1", "house_number"],
		])
	})

	it("absorbs the one missing character of a truncated name: 해운대 + 구", () => {
		const { text, tokens } = charTokens([
			["부산광역시", "region"],
			[" ", null],
			["해운대", "subregion"],
			["구", null],
			[" ", null],
			["아랫반송로", "street"],
			[" ", null],
			["46", "house_number"],
		])

		expect(spansOf(text, repairKRSubregionLabels(text, tokens).tokens)).toEqual([
			["부산광역시", "region"],
			["해운대구", "subregion"],
			["아랫반송로", "street"],
			["46", "house_number"],
		])
	})

	it("extends a city to the compound the register keys when the ward follows: 성남시 + 분당구", () => {
		const { text, tokens } = charTokens([
			["경기도", "region"],
			[" ", null],
			["성남시", "subregion"],
			["분당구", "dependent_locality"],
			[" ", null],
			["판교역로", "street"],
		])

		expect(spansOf(text, repairKRSubregionLabels(text, tokens).tokens)).toEqual([
			["경기도", "region"],
			["성남시분당구", "subregion"],
			["판교역로", "street"],
		])
	})

	it("leaves a register name alone when what follows is not a longer name", () => {
		const { text, tokens } = charTokens([
			["서울특별시", "region"],
			[" ", null],
			["종로구", "subregion"],
			[" ", null],
			["자하문로", "street"],
		])

		expect(repairKRSubregionLabels(text, tokens).changed).toBe(0)
	})
})
