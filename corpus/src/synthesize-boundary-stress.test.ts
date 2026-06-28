/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Verifies the boundary-stress synthesizer (#375) aligns cleanly through the REAL `alignRow`
 *   aligner — the gold boundary the model should learn must survive tokenization + BIO labeling.
 *   Each shape asserts the stress-relevant tags land in order; the bulk run confirms the
 *   overwhelming majority align (no quarantine).
 */

import { describe, expect, it } from "vitest"

import { alignRow } from "./align.js"
import {
	type BoundaryStressTemplate,
	synthesizeBoundaryStressRow,
	type SynthesizedBoundaryStressRow,
} from "./synthesize-boundary-stress.js"
import type { CanonicalRow } from "./types.js"

function mulberry32(seed: number): () => number {
	let a = seed >>> 0

	return () => {
		a |= 0
		a = (a + 0x6d2b79f5) | 0
		let t = Math.imul(a ^ (a >>> 15), 1 | a)
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t

		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

function asCanonical(r: SynthesizedBoundaryStressRow): CanonicalRow {
	return { ...r, source: "synth-boundary-stress", source_id: "synth-boundary-stress:test" } as CanonicalRow
}

const labelsFor = (template: BoundaryStressTemplate, seed: number): readonly string[] => {
	const row = synthesizeBoundaryStressRow(undefined, { random: mulberry32(seed), forceTemplate: template })
	const result = alignRow(asCanonical(row))
	expect(result.kind, `${template} should align, raw=${row.raw}`).toBe("labeled")

	if (result.kind !== "labeled") return []

	return result.row.labels
}

describe("synthesizeBoundaryStressRow", () => {
	it("street-eats-affix: street and street_suffix are SEPARATE spans, in order", () => {
		const labels = labelsFor("street-eats-affix", 1)
		expect(labels).toContain("B-street")
		expect(labels).toContain("B-street_suffix")
		expect(labels.indexOf("B-street")).toBeLessThan(labels.indexOf("B-street_suffix"))
	})

	it("comma-less-city-state: locality + region + postcode still label without comma cues", () => {
		const row = synthesizeBoundaryStressRow(undefined, {
			random: mulberry32(2),
			forceTemplate: "comma-less-city-state",
		})
		expect(row.raw).not.toContain(",") // the whole point — no delimiter cue
		const result = alignRow(asCanonical(row))
		expect(result.kind, `raw=${row.raw}`).toBe("labeled")

		if (result.kind !== "labeled") return
		expect(result.row.labels).toContain("B-locality")
		expect(result.row.labels).toContain("B-region")
		expect(result.row.labels).toContain("B-postcode")
	})

	it("fr-prefix: street_prefix split from street, prefix first", () => {
		const labels = labelsFor("fr-prefix", 3)
		expect(labels).toContain("B-street_prefix")
		expect(labels).toContain("B-street")
		expect(labels.indexOf("B-street_prefix")).toBeLessThan(labels.indexOf("B-street"))
	})

	it("house-number-after-street: street before the trailing house_number", () => {
		const labels = labelsFor("house-number-after-street", 4)
		expect(labels).toContain("B-street")
		expect(labels).toContain("B-house_number")
		expect(labels.indexOf("B-street")).toBeLessThan(labels.indexOf("B-house_number"))
	})

	it("bare-locality: locality labels with NO street present (the v1.6.0 ship-blocker fix)", () => {
		const row = synthesizeBoundaryStressRow(
			{ locality: "Sacramento", region: "CA", postcode: "95823", country: "US" },
			{ random: mulberry32(7), forceTemplate: "bare-locality" }
		)
		const result = alignRow(asCanonical(row))
		expect(result.kind, `raw=${row.raw}`).toBe("labeled")

		if (result.kind !== "labeled") return
		expect(result.row.labels).toContain("B-locality")
		expect(result.row.labels).toContain("B-region")
		expect(result.row.labels).not.toContain("B-street") // the whole point — no street before the city
	})

	it("house-number-before-street: house_number BEFORE the street (the confounding mirror of #4)", () => {
		const labels = labelsFor("house-number-before-street", 8)
		expect(labels).toContain("B-house_number")
		expect(labels).toContain("B-street")
		expect(labels.indexOf("B-house_number")).toBeLessThan(labels.indexOf("B-street"))
	})

	it("is deterministic under a fixed seed", () => {
		const a = synthesizeBoundaryStressRow(undefined, { random: mulberry32(42) })
		const b = synthesizeBoundaryStressRow(undefined, { random: mulberry32(42) })
		expect(a.raw).toBe(b.raw)
	})

	it("bulk: ≥97% of 400 rows align cleanly, each carrying its stress tag", () => {
		const rng = mulberry32(123)
		let labeled = 0

		for (let i = 0; i < 400; i++) {
			const row = synthesizeBoundaryStressRow(undefined, { random: rng })
			const result = alignRow(asCanonical(row))

			if (result.kind !== "labeled") continue
			labeled++
		}
		expect(labeled).toBeGreaterThanOrEqual(388) // 97%
	})
})
