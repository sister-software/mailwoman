/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The subsidiary-name→FRN match: which FRNs a canonical name collects, and what the score says about it.
 *
 *   The score ladder's whole point is that it is NOT flat, and a flattened one is invisible from the outside — every
 *   corroboration edge still gets written, still with a number in `match_score`. These pin the three rungs against
 *   the name pairs that produced them.
 */

import { describe, expect, it } from "vitest"

import {
	EDGAR_MATCH_SCORE_DESIGNATION_DIFFERS,
	EDGAR_MATCH_SCORE_IDENTICAL_RAW_NAME,
	EDGAR_MATCH_SCORE_NORMALIZATION_ONLY,
	groupFRNsByCanonicalLegalName,
	scoreEdgarSubsidiaryMatch,
	strippedDesignationKey,
} from "#sdk/build/edgar-match"

describe("strippedDesignationKey", () => {
	it("sorts the deleted tokens, so token ORDER cannot make two equal names differ", () => {
		expect(strippedDesignationKey("Acme Co Inc")).toBe(strippedDesignationKey("Acme Inc Co"))
	})

	it("separates names whose designations differ", () => {
		expect(strippedDesignationKey("American Broadband LLC")).not.toBe(
			strippedDesignationKey("American Broadband, Inc.")
		)
	})
})

describe("scoreEdgarSubsidiaryMatch", () => {
	it("tops out below certainty — a name is evidence about identity, never proof", () => {
		expect(scoreEdgarSubsidiaryMatch("Acme Fiber LLC", "Acme Fiber LLC")).toBe(EDGAR_MATCH_SCORE_IDENTICAL_RAW_NAME)
		expect(EDGAR_MATCH_SCORE_IDENTICAL_RAW_NAME).toBeLessThan(1)
	})

	it("grades case/punctuation variance below a byte-identical match", () => {
		expect(scoreEdgarSubsidiaryMatch("ACME FIBER, LLC", "Acme Fiber LLC")).toBe(EDGAR_MATCH_SCORE_NORMALIZATION_ONLY)
	})

	it("grades a designation difference lowest — canonicalization erased what told them apart", () => {
		expect(scoreEdgarSubsidiaryMatch("American Broadband, Inc.", "American Broadband LLC")).toBe(
			EDGAR_MATCH_SCORE_DESIGNATION_DIFFERS
		)
	})

	it("keeps the three rungs strictly ordered", () => {
		expect(EDGAR_MATCH_SCORE_IDENTICAL_RAW_NAME).toBeGreaterThan(EDGAR_MATCH_SCORE_NORMALIZATION_ONLY)
		expect(EDGAR_MATCH_SCORE_NORMALIZATION_ONLY).toBeGreaterThan(EDGAR_MATCH_SCORE_DESIGNATION_DIFFERS)
	})
})

describe("groupFRNsByCanonicalLegalName", () => {
	it("keeps the FULL bucket so the caller can see a collision instead of the first match", () => {
		const buckets = groupFRNsByCanonicalLegalName(
			new Map([
				["0001111111", { name: "American Broadband LLC", filedAt: "2026-01-01" }],
				["0002222222", { name: "American Broadband, Inc.", filedAt: "2026-01-01" }],
			])
		)

		expect(buckets.get("american broadband")).toEqual([
			{ frn: "0001111111", legalName: "American Broadband LLC" },
			{ frn: "0002222222", legalName: "American Broadband, Inc." },
		])
	})

	it("carries the RAW spelling, which is the only thing left that can grade the match", () => {
		const buckets = groupFRNsByCanonicalLegalName(
			new Map([["0003333333", { name: "ACME FIBER, LLC", filedAt: "2026-01-01" }]])
		)

		expect(buckets.get("acme fiber")).toEqual([{ frn: "0003333333", legalName: "ACME FIBER, LLC" }])
	})

	it("drops a name that canonicalizes to nothing — it could never identify a filer", () => {
		const buckets = groupFRNsByCanonicalLegalName(new Map([["0004444444", { name: "LLC", filedAt: "2026-01-01" }]]))

		expect(buckets.size).toBe(0)
	})
})
