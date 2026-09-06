/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The JP municipality boundary repair over char-aligned tokens: the model's early close at the inner 市 of `中新川郡上市町`
 *   is closed by the register, a real city followed by a 町-initial district is untouched, and a surface that is
 *   already a register name absorbs nothing.
 */

import type { BIOLabel, DecoderToken } from "@mailwoman/core/decoder"
import { repairJPMunicipalityLabels } from "@mailwoman/neural/jp-municipality-repair"
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
