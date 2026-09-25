/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Refinement-monotonicity suite rows and their audit. The law itself is evaluated in `candidate-admissibility.ts`.
 *
 *   Each row's `variant` is the finer query, and a named coarsening step derives its `base`. Rows that share a
 *   `rowRef` must form one chain whose finest query is the committed corpus row.
 */

import { stringifyJSON } from "@mailwoman/core/json"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"

import {
	auditCommonFixtureFields,
	type ConformanceFixture,
	MISSING_CASE_COUNTRY_PROBLEM,
} from "#eval-harness/conformance/fixture"

/**
 * Law identifier that every suite row carries.
 */
export const REFINEMENT_MONOTONICITY_LAW = "refinement-monotonicity"

/**
 * Named coarsening steps.
 *
 * - `drop-leading-segment` removes the first comma-separated segment, such as a venue or street line.
 * - `drop-trailing-segment` removes the last comma-separated segment,
 *   which is usually the coarsest admin area.
 * - `drop-leading-numeric-token` removes the first whitespace-separated token when it contains a digit.
 *   It reaches a postcode or house number that a comma does not separate, as in many DE and FR addresses.
 */
export const REFINEMENT_STEPS = ["drop-leading-segment", "drop-trailing-segment", "drop-leading-numeric-token"] as const

export type RefinementStep = (typeof REFINEMENT_STEPS)[number]

/**
 * Returns the trimmed, non-empty comma-separated segments of a query.
 */
function segmentsOf(text: string): string[] {
	return text
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part.length)
}

/**
 * Implementation of each step.
 * A step returns `null` when it cannot remove anything.
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
 * Returns the first step in {@link REFINEMENT_STEPS} order that derives `base` from `variant`, or `null`.
 */
export function classifyRefinementStep(base: string, variant: string): RefinementStep | null {
	if (base === variant) return null

	for (const step of REFINEMENT_STEPS) {
		if (REFINEMENT_DERIVATION_BY_STEP[step](variant) === base) return step
	}

	return null
}

/**
 * Returns the steps that can remove something from `text`.
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
 * Chain of fixtures that share one `rowRef`.
 */
export interface RefinementChain {
	rowRef: string
	/**
	 * Fixture IDs in chain order, coarsest first.
	 *
	 * The walk stops at a break, so a broken chain lists fewer IDs than its group has fixtures.
	 */
	links: string[]
	/**
	 * Finest query in the group, which the committed corpus row must hold.
	 * It is empty when the group has no single finest query.
	 */
	tip: string
}

/**
 * Builds one chain per `rowRef` by walking from the single base that no fixture produces as a variant.
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

		// The length guard stops the walk if the links form a cycle.
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
 * Counts that compare the suite against a corpus.
 */
export interface RefinementCoverage {
	/**
	 * Number of corpus inputs read.
	 */
	read: number
	/**
	 * Number of inputs that at least one step can coarsen.
	 */
	eligible: number
	/**
	 * Number of distinct source rows that the fixtures cover.
	 */
	stated: number
	/**
	 * Number of fixtures.
	 */
	links: number
	/**
	 * Eligible inputs per step.
	 * An input counts once for each step that applies to it.
	 */
	eligibleByStep: Record<RefinementStep, number>
}

/**
 * Measures how much of the corpus the suite covers.
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
 * Formats the coverage counts as one line.
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
 * Audits suite rows and chains.
 *
 * Each row needs the `candidate_admissibility` comparator, a `refines` expectation,
 * a `rowRef`, a `caseCountry`, and a named coarsening step.
 * Each chain must be connected, end at one finest query, and share one context.
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
 * Returns the fixture's step name, or `?` when no named step fits.
 */
export function describeRefinementStep(fixture: ConformanceFixture): string {
	return classifyRefinementStep(fixture.base, fixture.variant) ?? "?"
}
