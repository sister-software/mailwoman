/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The refinement-monotonicity law module: the named coarsenings, the chain reading, and every refusal the
 *   audit owes. Pure — no fixture file, no corpus, no engine. The committed suite is checked against the
 *   corpus in `refinement-monotonicity-suite.test.ts`.
 *
 *   THE DERIVATIONS ARE ASSERTED AGAINST THEIR OWN `null`. A step that returns the text unchanged would let a
 *   row state the identity law under a refinement name, and it would hold trivially — so every step reports
 *   an inapplicable input as an absence, and each of those absences is a case here.
 */

import type { ConformanceFixture } from "mailwoman/eval-harness/conformance/fixture"
import {
	auditRefinementSuite,
	classifyRefinementStep,
	describeRefinementCoverage,
	describeRefinementStep,
	REFINEMENT_DERIVATION_BY_STEP,
	REFINEMENT_MONOTONICITY_LAW,
	refinementChains,
	refinementCoverage,
	REFINEMENT_STEPS,
	statableSteps,
} from "mailwoman/eval-harness/conformance/refinement-monotonicity"
import { describe, expect, it } from "vitest"

function row(
	overrides: Partial<ConformanceFixture> & Pick<ConformanceFixture, "id" | "base" | "variant">
): ConformanceFixture {
	return {
		law: REFINEMENT_MONOTONICITY_LAW,
		outcomeComparator: "candidate_admissibility",
		expect: "refines",
		context: { caseCountry: "US" },
		rowRef: "cases/us/regression.jsonl#us-springfield-il-region-guard",
		...overrides,
	}
}

describe("the named coarsenings", () => {
	it("is a closed set with a derivation for every member", () => {
		expect(new Set(REFINEMENT_STEPS).size).toBe(REFINEMENT_STEPS.length)

		for (const step of REFINEMENT_STEPS) {
			expect(typeof REFINEMENT_DERIVATION_BY_STEP[step]).toBe("function")
		}
	})

	it("peels the first comma part off the front", () => {
		expect(REFINEMENT_DERIVATION_BY_STEP["drop-leading-segment"]("Neusser Str. 12, Nippes, 50733 Köln")).toBe(
			"Nippes, 50733 Köln"
		)
	})

	it("peels the last comma part off the back", () => {
		expect(REFINEMENT_DERIVATION_BY_STEP["drop-trailing-segment"]("Springfield, IL, USA")).toBe("Springfield, IL")
	})

	it("peels a leading token that carries a digit, which no comma step can reach", () => {
		expect(REFINEMENT_DERIVATION_BY_STEP["drop-leading-numeric-token"]("50733 Köln")).toBe("Köln")
		expect(REFINEMENT_DERIVATION_BY_STEP["drop-leading-segment"]("50733 Köln")).toBeNull()
		expect(REFINEMENT_DERIVATION_BY_STEP["drop-trailing-segment"]("50733 Köln")).toBeNull()
	})

	it("reports an inapplicable input as an absence rather than the text unchanged", () => {
		expect(REFINEMENT_DERIVATION_BY_STEP["drop-leading-segment"]("Springfield")).toBeNull()
		expect(REFINEMENT_DERIVATION_BY_STEP["drop-trailing-segment"]("Springfield")).toBeNull()
		expect(REFINEMENT_DERIVATION_BY_STEP["drop-leading-numeric-token"]("Springfield")).toBeNull()
		expect(REFINEMENT_DERIVATION_BY_STEP["drop-leading-numeric-token"]("Köln 50733")).toBeNull()
	})

	it("normalizes the spacing around the commas it keeps", () => {
		expect(REFINEMENT_DERIVATION_BY_STEP["drop-leading-segment"]("A ,  B ,C")).toBe("B, C")
	})
})

describe("classifying a pair", () => {
	it("names the step that produced the base from the variant", () => {
		expect(classifyRefinementStep("Springfield, IL", "Springfield, IL, USA")).toBe("drop-trailing-segment")

		expect(classifyRefinementStep("Nippes, 50733 Köln", "Neusser Str. 12, Nippes, 50733 Köln")).toBe(
			"drop-leading-segment"
		)

		expect(classifyRefinementStep("Köln", "50733 Köln")).toBe("drop-leading-numeric-token")
	})

	it("refuses a pair no step reaches, and the identity", () => {
		expect(classifyRefinementStep("Springfield", "Springfield")).toBeNull()
		expect(classifyRefinementStep("Springfield", "Springfield, IL, USA")).toBeNull()
		expect(classifyRefinementStep("springfield, il", "Springfield, IL, USA")).toBeNull()
	})

	it("settles an overlap by declaration order rather than by whichever branch ran last", () => {
		// "12 Rue" is one segment, so only the numeric step can act; "A, 12 B" is reachable by the leading-segment
		// step, and the numeric one cannot touch it because "A," carries no digit.
		expect(classifyRefinementStep("Rue", "12 Rue")).toBe("drop-leading-numeric-token")
		expect(classifyRefinementStep("12 B", "A, 12 B")).toBe("drop-leading-segment")
	})

	it("labels an unclassifiable pair without throwing — the audit is what refuses it", () => {
		expect(describeRefinementStep(row({ id: "x", base: "Sofia", variant: "Springfield, IL" }))).toBe("?")
	})

	it("reports every step a query can state, which is what the coverage denominator counts", () => {
		expect(statableSteps("Springfield")).toEqual([])
		expect(statableSteps("Springfield, IL")).toEqual(["drop-leading-segment", "drop-trailing-segment"])

		expect(statableSteps("3 Rue des Lyonnais, 75005 Paris")).toEqual([
			"drop-leading-segment",
			"drop-trailing-segment",
			"drop-leading-numeric-token",
		])
	})
})

describe("reading the chains", () => {
	it("walks a multi-link chain from its coarsest end and names its tip", () => {
		const chains = refinementChains([
			row({ id: "b", base: "Springfield, IL", variant: "Springfield, IL, USA" }),
			row({ id: "a", base: "Springfield", variant: "Springfield, IL" }),
		])

		expect(chains).toHaveLength(1)
		expect(chains[0]!.links).toEqual(["a", "b"])
		expect(chains[0]!.tip).toBe("Springfield, IL, USA")
	})

	it("groups by rowRef, so two committed rows are two chains", () => {
		const chains = refinementChains([
			row({ id: "a", base: "Portland", variant: "Portland, ME", rowRef: "cases/us/regression.jsonl#us-portland-me" }),
			row({ id: "b", base: "Portland", variant: "Portland, OR", rowRef: "cases/us/regression.jsonl#us-portland-or" }),
		])

		expect(chains).toHaveLength(2)
		expect(chains.every((chain) => chain.links.length === 1)).toBe(true)
	})

	it("reports a broken chain as a short walk rather than repairing it", () => {
		const chains = refinementChains([
			row({ id: "a", base: "Springfield", variant: "Springfield, IL" }),
			row({ id: "b", base: "Chicago", variant: "Chicago, IL" }),
		])

		expect(chains).toHaveLength(1)
		expect(chains[0]!.links.length).toBeLessThan(2)
	})
})

describe("the suite audit", () => {
	it("passes a well-formed chain", () => {
		expect(
			auditRefinementSuite([
				row({ id: "a", base: "Springfield", variant: "Springfield, IL" }),
				row({ id: "b", base: "Springfield, IL", variant: "Springfield, IL, USA" }),
			])
		).toEqual([])
	})

	it("refuses a row that states another law", () => {
		const problems = auditRefinementSuite([
			row({ id: "a", base: "S", variant: "S, IL", law: "case-folding-invariance" }),
		])

		expect(problems).toHaveLength(1)
		expect(problems[0]).toContain("law is")
	})

	it("refuses a comparator that cannot read a candidate table", () => {
		const problems = auditRefinementSuite([
			row({ id: "a", base: "Springfield", variant: "Springfield, IL", outcomeComparator: "resolution_identity" }),
		])

		expect(problems.join("\n")).toContain("candidate_admissibility")
	})

	it("refuses any relation but refines — a refinement row states that nothing admissible was lost", () => {
		const problems = auditRefinementSuite([
			row({ id: "a", base: "Springfield", variant: "Springfield, IL", expect: "diverges" }),
		])

		expect(problems.join("\n")).toContain('expects "diverges"')
	})

	it("refuses a row that names no committed population, and one graded off its own overlay", () => {
		const noRef = auditRefinementSuite([
			{ ...row({ id: "a", base: "Springfield", variant: "Springfield, IL" }), rowRef: undefined },
		])

		const noCountry = auditRefinementSuite([
			{ ...row({ id: "a", base: "Springfield", variant: "Springfield, IL" }), context: undefined },
		])

		expect(noRef.join("\n")).toContain("no rowRef")
		expect(noCountry.join("\n")).toContain("no context.caseCountry")
	})

	it("refuses a base that is not a named coarsening of its variant", () => {
		const problems = auditRefinementSuite([row({ id: "a", base: "Sofia", variant: "Springfield, IL" })])

		expect(problems.join("\n")).toContain("not a named coarsening")
	})

	it("refuses links that do not join into one chain", () => {
		const problems = auditRefinementSuite([
			row({ id: "a", base: "Springfield", variant: "Springfield, IL" }),
			row({ id: "b", base: "Chicago", variant: "Chicago, IL" }),
		])

		expect(problems.join("\n")).toContain("do not form one chain")
	})

	it("refuses a chain whose links are graded under different priors", () => {
		const problems = auditRefinementSuite([
			row({ id: "a", base: "Springfield", variant: "Springfield, IL" }),
			row({
				id: "b",
				base: "Springfield, IL",
				variant: "Springfield, IL, USA",
				context: { caseCountry: "GB" },
			}),
		])

		expect(problems.join("\n")).toContain("different contexts")
	})
})

describe("the coverage reading", () => {
	const corpus = ["Springfield, IL, USA", "50733 Köln", "Springfield", "Köln"]

	it("counts eligible rows, not law arms", () => {
		const coverage = refinementCoverage(
			[
				row({ id: "a", base: "Springfield", variant: "Springfield, IL" }),
				row({ id: "b", base: "Springfield, IL", variant: "Springfield, IL, USA" }),
			],
			corpus
		)

		expect(coverage.read).toBe(4)
		expect(coverage.eligible).toBe(2)
		expect(coverage.stated).toBe(1)
		expect(coverage.links).toBe(2)
	})

	it("breaks the denominator down by the arms the population can state", () => {
		const coverage = refinementCoverage([], corpus)

		expect(coverage.eligibleByStep["drop-trailing-segment"]).toBe(1)
		expect(coverage.eligibleByStep["drop-leading-numeric-token"]).toBe(1)
		expect(coverage.stated).toBe(0)
	})

	it("prints both numerator and denominator, so a hold count cannot imply a breadth", () => {
		const line = describeRefinementCoverage([row({ id: "a", base: "Springfield", variant: "Springfield, IL" })], corpus)

		expect(line).toContain("1/2 eligible committed rows stated")
		expect(line).toContain("2 of 4 rows read")
	})
})
