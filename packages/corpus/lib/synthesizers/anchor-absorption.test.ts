import { makeLcg } from "@mailwoman/core/random"
import {
	synthesizeAnchorAbsorptionRow,
	type AnchorAbsorptionTemplate,
} from "@mailwoman/corpus/synthesizers/anchor-absorption"
import { alignRow } from "@mailwoman/corpus/utils"
import { describe, expect, it } from "vitest"

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

	it("Leading real-ZIP + trailing postcode → house_number", () => {
		const { synth, aligned } = rowFor("h-adversarial", 3)
		expect(synth.components.postcode).toBeTruthy()
		expect(leadingTag(aligned)).toBe("house_number")
	})

	it("CASE-P (US rural): leading postcode without trailing → postcode", () => {
		const { synth, aligned } = rowFor("p-us-rural", 3)
		expect(synth.components.house_number).toBeUndefined()
		expect(leadingTag(aligned)).toBe("postcode")
	})

	it("H-no-trailing-locality: leading number + LOCALITY + state without trailing → house_number (the A3 fix)", () => {
		const { synth, aligned } = rowFor("h-no-trailing-locality", 3)
		expect(synth.components.locality).toBeTruthy()
		expect(synth.components.postcode).toBeUndefined()
		expect(leadingTag(aligned)).toBe("house_number")
	})

	it("CASE-P (DE): German leading postcode → postcode", () => {
		const { aligned } = rowFor("p-de", 3)
		expect(leadingTag(aligned)).toBe("postcode")
	})

	it("Anchor-fp: 5-digit-shape house number (not a real ZIP) + trailing postcode → house_number", () => {
		const { aligned } = rowFor("anchor-fp", 3)
		expect(leadingTag(aligned)).toBe("house_number")
	})
})
