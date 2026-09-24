/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Define and audit query refinements: adding non-conflicting detail must not remove
 *   candidates available to the coarser query. This module owns row derivation and validation;
 *   `candidate-admissibility.ts` evaluates the law.
 *
 *   Each committed row is the fullest query (`variant`); named steps derive its coarser bases.
 *   Multiple links share a `rowRef` and must form one chain. The suite test checks each chain tip
 *   against the corpus.
 */

import { stringifyJSON } from "@mailwoman/core/json"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"

import {
	auditCommonFixtureFields,
	type ConformanceFixture,
	MISSING_CASE_COUNTRY_PROBLEM,
} from "#eval-harness/conformance/fixture"

/**
 * The law name every row in this suite carries.
 */
export const REFINEMENT_MONOTONICITY_LAW = "refinement-monotonicity"

/**
 * The only named coarsening steps allowed in the suite.
 *
 * - `drop-leading-segment` — remove the first comma-delimited part.
 *   Peels a venue or a street line off the front of a structured address, leaving the place it sits in.
 * - `drop-trailing-segment` — remove the last comma-delimited part.
 *   Peels the coarsest admin off the back, which is the arm that produces an
 *   ambiguous bare toponym from a disambiguated one.
 * - `drop-leading-numeric-token` — remove the leading whitespace-delimited token when it carries a digit.
 *   A postcode or a house number written without a comma is not a segment, so neither segment
 *   step can reach it, and the DE and FR structured rows are written exactly that way.
 */
export const REFINEMENT_STEPS = ["drop-leading-segment", "drop-trailing-segment", "drop-leading-numeric-token"] as const

export type RefinementStep = (typeof REFINEMENT_STEPS)[number]

/**
 * The comma-delimited parts of a query, trimmed, with empty parts dropped.
 */
function segmentsOf(text: string): string[] {
	return text
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part.length)
}

/**
 * Derive the coarser query, or return `null` when the step removes nothing.
 */
export const REFINEMENT_DERIVATION_BY_STEP: Record<RefinementStep, (text: string) => string | null> = {
	"drop-leading-segment": (text) => {
		const segments = segmentsOf(text)

		return segments.length > 1 ? segments.slice(1).join(", ") : null
	},
	"drop-trailing-segment": (text) => {
		const segments = segmentsOf(text)

		return segments.length > 1 ? segments.slice(0, -1).join(", ") : null
	},
	"drop-leading-numeric-token": (text) => {
		const tokens = text.trim().split(/\s+/u)

		if (tokens.length < 2 || !/\d/u.test(tokens[0]!)) return null

		return tokens.slice(1).join(" ")
	},
}

/**
 * Identify the step deriving `base` from `variant`; first match follows declared step order.
 */
export function classifyRefinementStep(base: string, variant: string): RefinementStep | null {
	if (base === variant) return null

	for (const step of REFINEMENT_STEPS) {
		if (REFINEMENT_DERIVATION_BY_STEP[step](variant) === base) return step
	}

	return null
}

/**
 * Return the steps that can act on `text`.
 */
export function statableSteps(text: string): RefinementStep[] {
	return REFINEMENT_STEPS.filter((step) => REFINEMENT_DERIVATION_BY_STEP[step](text) !== null)
}

/**
 * Path to the committed refinement suite.
 */
export const REFINEMENT_MONOTONICITY_SUITE_PATH: string = resolvePackagePath(
	"mailwoman",
	"lib",
	"eval-harness",
	"conformance",
	"refinement-monotonicity.jsonl"
)

/**
 * One `rowRef` group's chain structure.
 */
export interface RefinementChain {
	rowRef: string
	/**
	 * The links in order, coarsest first.
	 *
	 * Each entry is one fixture id.
	 */
	links: string[]
	/**
	 * The fullest query in the group.
	 * The text the committed row must hold.
	 */
	tip: string
}

/**
 * Build one chain per `rowRef`; the audit rejects groups with disconnected links.
 *
 * The suite test separately checks each tip against the committed corpus.
 */
export function refinementChains(fixtures: readonly ConformanceFixture[]): RefinementChain[] {
	const groups = new Map<string, ConformanceFixture[]>()

	for (const fixture of fixtures) {
		const rowRef = fixture.rowRef ?? ""
		const group = groups.get(rowRef)

		if (group) {
			group.push(fixture)
		} else {
			groups.set(rowRef, [fixture])
		}
	}

	const chains: RefinementChain[] = []

	for (const [rowRef, group] of groups) {
		const byBase = new Map(group.map((fixture) => [fixture.base, fixture]))
		const bases = new Set(group.map((fixture) => fixture.base))
		const tips = group.filter((fixture) => !bases.has(fixture.variant))
		const tip = tips.length === 1 ? tips[0]!.variant : ""
		const links: string[] = []

		// Walk from the coarsest end: the one base no fixture produces as a variant.
		const variants = new Set(group.map((fixture) => fixture.variant))
		const roots = group.filter((fixture) => !variants.has(fixture.base))

		let current = roots.length === 1 ? roots[0] : undefined

		while (current && links.length <= group.length) {
			links.push(current.id)
			current = byBase.get(current.variant)
		}

		chains.push({ rowRef, links, tip })
	}

	return chains
}

/**
 * Counts describing how much of the population the suite covers.
 */
export interface RefinementCoverage {
	/**
	 * Board rows examined.
	 */
	read: number
	/**
	 * Rows where at least one named step applies.
	 */
	eligible: number
	/**
	 * Eligible rows represented by at least one suite link.
	 */
	stated: number
	/**
	 * Total links across all chains.
	 */
	links: number
	/**
	 * Eligible rows per step; a row may count under multiple steps.
	 */
	eligibleByStep: Record<RefinementStep, number>
}

/**
 * Measure suite coverage against caller-supplied corpus inputs.
 */
export function refinementCoverage(
	fixtures: readonly ConformanceFixture[],
	corpusInputs: readonly string[]
): RefinementCoverage {
	const eligibleByStep: Record<RefinementStep, number> = {
		"drop-leading-segment": 0,
		"drop-trailing-segment": 0,
		"drop-leading-numeric-token": 0,
	}

	let eligible = 0

	for (const input of corpusInputs) {
		const steps = statableSteps(input)

		if (!steps.length) continue

		eligible += 1

		for (const step of steps) {
			eligibleByStep[step] += 1
		}
	}

	const stated = new Set(fixtures.map((fixture) => fixture.rowRef ?? fixture.variant))

	return { read: corpusInputs.length, eligible, stated: stated.size, links: fixtures.length, eligibleByStep }
}

/**
 * Format coverage, link count, and the eligible population's per-step breakdown.
 */
export function describeRefinementCoverage(
	fixtures: readonly ConformanceFixture[],
	corpusInputs: readonly string[]
): string {
	const coverage = refinementCoverage(fixtures, corpusInputs)
	const steps = REFINEMENT_STEPS.map((step) => `${step} ${coverage.eligibleByStep[step]}`).join(", ")

	return (
		`coverage: ${coverage.stated}/${coverage.eligible} eligible committed rows stated, ${coverage.links} links ` +
		`(${coverage.eligible} of ${coverage.read} rows read can state a step; reachable by ${steps})`
	)
}

/**
 * Audit fixture fields, coarsening steps, chain links, and country context.
 */
export function auditRefinementSuite(fixtures: readonly ConformanceFixture[]): string[] {
	const problems = auditCommonFixtureFields(
		fixtures,
		REFINEMENT_MONOTONICITY_LAW,
		(fixture, label, fixtureProblems) => {
			if (fixture.outcomeComparator !== "candidate_admissibility") {
				fixtureProblems.push(
					`${label}: names "${fixture.outcomeComparator}" — this law is stated over the resolver's candidate tables, ` +
						`so the only comparator that can read it is "candidate_admissibility"`
				)
			}

			if (fixture.expect !== "refines") {
				fixtureProblems.push(
					`${label}: expects "${fixture.expect}" — a refinement row states that nothing admissible was lost, and the ` +
						`comparator reports that as "refines"`
				)
			}

			if (!fixture.rowRef) {
				fixtureProblems.push(
					`${label}: no rowRef — every chain is derived from a committed row, and a row without one names no population`
				)
			}

			if (!fixture.context?.caseCountry) {
				fixtureProblems.push(`${label}: ${MISSING_CASE_COUNTRY_PROBLEM}`)
			}

			if (!classifyRefinementStep(fixture.base, fixture.variant)) {
				fixtureProblems.push(
					`${label}: base is not a named coarsening of variant — ${stringifyJSON(fixture.base)} is not what any of ` +
						`${REFINEMENT_STEPS.join(" / ")} produces from ${stringifyJSON(fixture.variant)}, so the pair's direction ` +
						`is not reproducible from its own name`
				)
			}
		}
	)

	for (const chain of refinementChains(fixtures)) {
		const group = fixtures.filter((fixture) => (fixture.rowRef ?? "") === chain.rowRef)

		if (chain.links.length !== group.length) {
			problems.push(
				`rowRef "${chain.rowRef}": its ${group.length} row(s) do not form one chain — walking from the coarsest ` +
					`base reached ${chain.links.length} of them (${chain.links.join(" → ") || "none"}). Each link's variant ` +
					`must be the next link's base.`
			)
		}

		if (!chain.tip) {
			problems.push(
				`rowRef "${chain.rowRef}": no single fullest query — a chain ends at exactly one variant that is nobody ` +
					`else's base, and that is the text the committed row has to hold`
			)
		}

		const contexts = new Set(group.map((fixture) => stringifyJSON(fixture.context ?? null)))

		if (contexts.size > 1) {
			problems.push(
				`rowRef "${chain.rowRef}": its links pin ${contexts.size} different contexts — a chain varies the QUERY, so ` +
					`every link has to be graded under the same priors`
			)
		}
	}

	return problems
}

/**
 * The step label a report line carries, e.g. `drop-trailing-segment`.
 *
 * `?` when the pair does not classify.
 * The audit refuses that, so it can only appear on a hand-built fixture that skipped the loader.
 */
export function describeRefinementStep(fixture: ConformanceFixture): string {
	return classifyRefinementStep(fixture.base, fixture.variant) ?? "?"
}
