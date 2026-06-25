/**
 * Tests for the anchor-absorption counter-augmentation (#220/#723 Probe A1). The load-bearing checks:
 * (1) every slice aligns cleanly (no quarantine) so the shard is trainable, and (2) the LEADING
 * 5-digit gets the CONTEXT-correct label — house_number when a trailing postcode is present (CASE-H),
 * postcode when not (CASE-P). That contrast is exactly what the model must learn instead of flipping
 * the default (the Probe A0 erosion this shard fixes).
 */

import { describe, expect, it } from "vitest"

import { alignRow } from "./align.js"
import { synthesizeAnchorAbsorptionRow, type AnchorAbsorptionTemplate } from "./synthesize-anchor-absorption.js"

// A deterministic RNG so the assertions are stable.
function seeded(seed: number): () => number {
	let s = seed >>> 0
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0
		return s / 0x100000000
	}
}

function rowFor(template: AnchorAbsorptionTemplate, seed = 1) {
	const synth = synthesizeAnchorAbsorptionRow({ random: seeded(seed), forceTemplate: template })
	const aligned = alignRow({ raw: synth.raw, components: synth.components, country: synth.locale.slice(-2), source: "test", source_id: "t" })
	return { synth, aligned }
}

/** The BIO tag on the FIRST token of raw (the leading 5-digit's label). */
function leadingTag(aligned: ReturnType<typeof alignRow>): string | null {
	if (aligned.kind !== "labeled") return null
	const l = aligned.row.labels[0]
	return l && l !== "O" ? l.slice(2) : (l ?? null)
}

describe("synthesize-anchor-absorption", () => {
	const templates: AnchorAbsorptionTemplate[] = ["h-adversarial", "h-no-trailing-locality", "p-us-rural", "p-de", "anchor-fp", "locale-ambig", "standard"]

	it("every slice aligns cleanly (no quarantine) across seeds", () => {
		for (const t of templates) {
			for (let seed = 1; seed <= 20; seed++) {
				const { synth, aligned } = rowFor(t, seed)
				expect(aligned.kind, `${t} seed=${seed} raw=${synth.raw}`).toBe("labeled")
			}
		}
	})

	it("CASE-H: leading real-ZIP + trailing postcode → house_number", () => {
		const { synth, aligned } = rowFor("h-adversarial", 3)
		expect(synth.components.postcode).toBeTruthy() // a TRAILING postcode is present
		expect(leadingTag(aligned)).toBe("house_number")
	})

	it("CASE-P (US rural): leading postcode, NO trailing → postcode", () => {
		const { synth, aligned } = rowFor("p-us-rural", 3)
		expect(synth.components.house_number).toBeUndefined() // no house number — the leading IS the postcode
		expect(leadingTag(aligned)).toBe("postcode")
	})

	it("h-no-trailing-locality: leading number + LOCALITY + state, no trailing → house_number (the A3 fix)", () => {
		// The contrast to p-us-rural: same no-trailing state-bearing shape, but a LOCALITY is present, so the
		// leading number is the house number — the discriminator the A2 shard lacked (98 house#->postcode).
		const { synth, aligned } = rowFor("h-no-trailing-locality", 3)
		expect(synth.components.locality).toBeTruthy() // a locality IS present (vs p-us-rural's none)
		expect(synth.components.postcode).toBeUndefined() // no trailing postcode
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
