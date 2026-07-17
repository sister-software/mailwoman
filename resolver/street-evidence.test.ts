/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for the #727 phase-4c street-name-evidence rerank policy (`street-evidence.ts`). Covers the
 *   fold contract, the G1 type-vocabulary guard, and the v2 pick policy's four cases (keep / fix /
 *   G1-skip / G2-cap / fail-open) that the FR fragment board measured at 96 fixes / 3 breaks.
 */

import { describe, expect, test } from "vitest"

import {
	foldStreetSurface,
	isPureTypeVocabulary,
	pickByStreetEvidence,
	type StreetCandidate,
	type StreetLocalityEvidence,
} from "./street-evidence.ts"

/** A mock evidence provider: a fixed set of folded street names that "exist". Fails open on anything else. */
const mockEvidence = (existing: string[]): StreetLocalityEvidence => {
	const set = new Set(existing.map(foldStreetSurface))

	return {
		countries: new Set(["FR"]),
		hasStreetName: (surface) => set.has(foldStreetSurface(surface)),
	}
}

const cand = (streetSurface: string, score: number): StreetCandidate => ({ streetSurface, score })

describe("foldStreetSurface", () => {
	test("strips diacritics, lowercases, collapses whitespace", () => {
		expect(foldStreetSurface("Rue Saint-Éleuthère")).toBe("rue saint eleuthere")
		expect(foldStreetSurface("  Chemin   de la  Grenouillère ")).toBe("chemin de la grenouillere")
	})

	test("normalizes hyphens and apostrophes to spaces (the fold contract — the v1 break class)", () => {
		expect(foldStreetSurface("Rue Pillet-Will")).toBe("rue pillet will")
		expect(foldStreetSurface("Chemin d'En Galinier")).toBe("chemin d en galinier")
		// A hyphenated index entry and an un-hyphenated one fold to the same key.
		expect(foldStreetSurface("Pillet-Will")).toBe(foldStreetSurface("Pillet Will"))
	})
})

describe("isPureTypeVocabulary (G1)", () => {
	test("bare type/particle surfaces are pure — no name, no evidence credit", () => {
		expect(isPureTypeVocabulary(foldStreetSurface("rue"))).toBe(true)
		expect(isPureTypeVocabulary(foldStreetSurface("chemin de la"))).toBe(true)
		expect(isPureTypeVocabulary(foldStreetSurface("route de"))).toBe(true)
	})

	test("a surface with a real name token is NOT pure", () => {
		expect(isPureTypeVocabulary(foldStreetSurface("rue corsier"))).toBe(false)
		expect(isPureTypeVocabulary(foldStreetSurface("chemin puget terrein"))).toBe(false)
	})

	test("empty is treated as pure (nothing to credit)", () => {
		expect(isPureTypeVocabulary("")).toBe(true)
	})
})

describe("pickByStreetEvidence — the v2 policy", () => {
	test("keeps rank-1 when its street already exists (no move)", () => {
		const evidence = mockEvidence(["Rue Corsier"])
		const pick = pickByStreetEvidence([cand("Rue Corsier", 5), cand("Corsier", 3)], evidence)
		expect(pick.index).toBe(0)
		expect(pick.moved).toBe(false)
	})

	test("FIX: moves off a wrong rank-1 to the in-index sibling", () => {
		// rank-1 "Puget" (not a street) loses to rank-3 "Chemin Puget Terrein" (in index), within margin.
		const evidence = mockEvidence(["Chemin Puget Terrein"])
		const cands = [cand("Puget", 5.0), cand("Puget Terrein", 4.9), cand("Chemin Puget Terrein", 4.6)]
		const pick = pickByStreetEvidence(cands, evidence)
		expect(pick.index).toBe(2)
		expect(pick.moved).toBe(true)
		expect(pick.candidate.streetSurface).toBe("Chemin Puget Terrein")
	})

	test("G1: does NOT credit a truncated pure-type sibling even though it exists in the index", () => {
		// "rue" IS in the index but is pure type vocab → skipped; gold "Rue Guarnieri" is the real pick.
		const evidence = mockEvidence(["rue", "Rue Guarnieri"])
		const cands = [cand("rue", 5.0), cand("Rue Guarnieri", 4.5)]
		const pick = pickByStreetEvidence(cands, evidence)
		expect(pick.index).toBe(1)
		expect(pick.candidate.streetSurface).toBe("Rue Guarnieri")
	})

	test("G2: does NOT promote an in-index candidate beyond the margin cap", () => {
		// Gold "Rue Paul Marzin" exists but sits 4.6 below rank-1 (> 2.5 cap) → keep rank-1 (fail-open).
		const evidence = mockEvidence(["Rue Paul Marzin"])
		const cands = [cand("Paul", 6.0), cand("Rue Paul Marzin", 1.4)]
		const pick = pickByStreetEvidence(cands, evidence)
		expect(pick.index).toBe(0)
		expect(pick.moved).toBe(false)
	})

	test("G2: DOES promote when the in-index candidate is within the margin cap", () => {
		const evidence = mockEvidence(["Rue Paul Marzin"])
		const cands = [cand("Paul", 6.0), cand("Rue Paul Marzin", 4.0)] // 2.0 gap ≤ 2.5
		const pick = pickByStreetEvidence(cands, evidence)
		expect(pick.index).toBe(1)
		expect(pick.moved).toBe(true)
	})

	test("fail-open: keeps rank-1 when NOTHING is in the index (positive evidence only)", () => {
		const evidence = mockEvidence([])
		const pick = pickByStreetEvidence([cand("Typoed Steet", 5), cand("Other", 3)], evidence)
		expect(pick.index).toBe(0)
		expect(pick.moved).toBe(false)
	})

	test("skips empty street surfaces", () => {
		const evidence = mockEvidence(["Rue Corsier"])
		const pick = pickByStreetEvidence([cand("", 5), cand("Rue Corsier", 4)], evidence)
		expect(pick.index).toBe(1)
	})

	test("custom marginCap is honored", () => {
		const evidence = mockEvidence(["Rue Paul Marzin"])
		const cands = [cand("Paul", 6.0), cand("Rue Paul Marzin", 1.4)]
		// With a wide cap the deep candidate is now eligible.
		const pick = pickByStreetEvidence(cands, evidence, { marginCap: 10 })
		expect(pick.index).toBe(1)
	})

	test("throws on empty candidate list", () => {
		expect(() => pickByStreetEvidence([], mockEvidence([]))).toThrow()
	})
})
