/**
 * Test alignment and context-dependent labels for leading five-digit values.
 */

import { makeLcg } from "@mailwoman/core/random"
import {
	synthesizeAnchorAbsorptionRow,
	type AnchorAbsorptionTemplate,
} from "@mailwoman/corpus/synthesizers/anchor-absorption"
import { alignRow } from "@mailwoman/corpus/utils"
import { describe, expect, it } from "vitest"

// Seed fixtures for reproducible output.
function rowFor(template: AnchorAbsorptionTemplate, seed = 1) {
	const synth = synthesizeAnchorAbsorptionRow({ random: makeLcg(seed), forceTemplate: template })

	const aligned = alignRow({
		raw: synth.raw,
		components: synth.components,
		country: synth.locale.slice(-2),
		source: "test",
		source_id: "t",
		corpus_version: "0.0.0-test",
		license: "synthetic fixture — not distributed",
	})

	return { synth, aligned }
}

/**
 * Get the first token's BIO tag.
 */
function leadingTag(aligned: ReturnType<typeof alignRow>): string | null {
	if (aligned.kind !== "labeled") return null
	const l = aligned.row.labels[0]

	return l && l !== "O" ? l.slice(2) : (l ?? null)
}

describe("synthesize anchor-absorption", () => {
	const templates: AnchorAbsorptionTemplate[] = [
		"h-adversarial",
		"h-no-trailing-locality",
		"p-us-rural",
		"p-de",
		"anchor-fp",
		"locale-ambig",
		"standard",
	]

	it("every template aligns cleanly (no quarantine) across seeds", () => {
		for (const t of templates) {
			for (let seed = 1; seed <= 20; seed++) {
				const { synth, aligned } = rowFor(t, seed)
				expect(aligned.kind, `${t} seed=${seed} raw=${synth.raw}`).toBe("labeled")
			}
		}
	})

	it("CASE-H: leading real-ZIP + trailing postcode → house_number", () => {
		const { synth, aligned } = rowFor("h-adversarial", 3)
		expect(synth.components.postcode).toBeTruthy() // A trailing postcode is present.
		expect(leadingTag(aligned)).toBe("house_number")
	})

	it("CASE-P (US rural): leading postcode, NO trailing → postcode", () => {
		const { synth, aligned } = rowFor("p-us-rural", 3)
		expect(synth.components.house_number).toBeUndefined() // The leading value is a postcode.
		expect(leadingTag(aligned)).toBe("postcode")
	})

	it("h-no-trailing-locality: leading number + LOCALITY + state, no trailing → house_number (the A3 fix)", () => {
		// A locality distinguishes this from the rural postcode-first form.
		const { synth, aligned } = rowFor("h-no-trailing-locality", 3)
		expect(synth.components.locality).toBeTruthy() // A locality is present.
		expect(synth.components.postcode).toBeUndefined() // No trailing postcode.
		expect(leadingTag(aligned)).toBe("house_number")
	})

	it("CASE-P (DE): German leading postcode → postcode", () => {
		const { aligned } = rowFor("p-de", 3)
		expect(leadingTag(aligned)).toBe("postcode")
	})

	it("anchor-fp: 5-digit-shape house number (not a real ZIP) + trailing postcode → house_number", () => {
		const { aligned } = rowFor("anchor-fp", 3)
		expect(leadingTag(aligned)).toBe("house_number")
	})
})
