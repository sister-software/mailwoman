/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The refinement-monotonicity law: a query that says MORE must not make a candidate the coarser query could
 *   reach unreachable, unless the added information contradicts it. Pure — no model, no I/O beyond reading the
 *   committed suite. The reading itself lives in `candidate-admissibility.ts`; this module owns the row
 *   vocabulary and the refusal.
 *
 *   WHY IT IS A PRODUCT COMMITMENT. Refinement is what a person does when the answer was wrong: they type
 *   `Springfield`, get Missouri, and add `IL`. If adding the state can push the Illinois Springfield out of
 *   reach, the one repair a user knows how to make is the one that cannot be relied on. Every other law in
 *   this directory states that a rewrite of the SAME information changes nothing; this one is the only law
 *   about information being ADDED and the axis those four cannot see.
 *
 *   THE BASE IS DERIVED, NOT AUTHORED — AND THE DERIVATION RUNS BACKWARD. The other four laws take a
 *   committed board row as the `base` and derive the `variant` from it. Here the committed row is the FULLEST
 *   query, so it is the `variant`, and each `base` is that row's own text with one named piece removed. A
 *   hand-typed base would let a row quietly become an address nobody geocodes, and the law would then measure
 *   a query the corpus never attested. {@linkcode REFINEMENT_DERIVATION_BY_STEP} is the source every base is
 *   re-derived from, and {@linkcode auditRefinementSuite} re-derives it.
 *
 *   A CHAIN IS A SEQUENCE OF PAIRS. `Springfield` → `Springfield, IL` → `Springfield, IL, USA` is two rows
 *   sharing one `rowRef`, each stating one link. The audit checks the links join: within a `rowRef` group,
 *   every fixture but one has its `variant` appear as another fixture's `base`, and that one is the chain's
 *   TIP — the query the committed row actually holds. Nothing here can check the tip against the corpus (this
 *   module never loads it); `refinement-monotonicity-suite.test.ts` does, and that is the check which makes
 *   the whole chain corpus-attested rather than merely self-consistent.
 */

import { existsSync } from "@mailwoman/platform/fs"
import { fileURLToPath } from "@mailwoman/platform/url"

import type { ConformanceFixture } from "./fixture.ts"

/**
 * The law name every row in this suite carries.
 */
export const REFINEMENT_MONOTONICITY_LAW = "refinement-monotonicity"

/**
 * The closed set of named coarsenings a row may state, and the only three a committed row may name.
 *
 * Each REMOVES information, so the surviving text is a query the fuller one strictly contains. That direction is what
 * makes the pair a refinement at all: the variant says everything the base says and one thing more.
 *
 * - `drop-leading-segment` — remove the first comma-delimited part. Peels a venue or a street line off the front of a
 *   structured address, leaving the place it sits in.
 * - `drop-trailing-segment` — remove the last comma-delimited part. Peels the coarsest admin off the back, which is the
 *   arm that produces an ambiguous bare toponym from a disambiguated one.
 * - `drop-leading-numeric-token` — remove the leading whitespace-delimited token when it carries a digit. A postcode or a
 *   house number written without a comma is not a segment, so neither segment step can reach it, and the DE and FR
 *   structured rows are written exactly that way.
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
		.filter((part) => part.length > 0)
}

/**
 * Each step's derivation: given the FULLER query, return the coarser one, or `null` when the step has nothing to
 * remove.
 *
 * `null` rather than the input unchanged, because a step that removed nothing has not stated the law — the pair would
 * be the identity wearing a refinement label, and it would hold trivially.
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
 * Which named step turns `variant` into `base`, or `null` when none does.
 *
 * Derived from the pair rather than stored on the fixture, on the canonical-form law's own reasoning: a stored step
 * name is a second copy of something the two strings already say, and the copy is what goes stale.
 *
 * The steps are tried in {@linkcode REFINEMENT_STEPS} order and the FIRST match wins. Two steps can agree on a pair — a
 * two-token single-segment query is reachable by both a segment step and the numeric one — and the order determines the
 * result rather than leaving the name to whichever branch ran last.
 */
export function classifyRefinementStep(base: string, variant: string): RefinementStep | null {
	if (base === variant) return null

	for (const step of REFINEMENT_STEPS) {
		if (REFINEMENT_DERIVATION_BY_STEP[step](variant) === base) return step
	}

	return null
}

/**
 * Every step that can be stated over `text` at all — the eligibility reading the coverage line is built from.
 */
export function statableSteps(text: string): RefinementStep[] {
	return REFINEMENT_STEPS.filter((step) => REFINEMENT_DERIVATION_BY_STEP[step](text) !== null)
}

/**
 * The committed suite.
 *
 * `new URL`-relative with a compiled-tree fallback: `tsc` emits no `.jsonl` into `out/`, so a compiled caller reads the
 * source-tree copy. Same bridge as `gauntlet/cases/load.ts`'s `CASES_DIR`.
 */
export const REFINEMENT_MONOTONICITY_SUITE_PATH = ((): string => {
	const sibling = fileURLToPath(new URL("refinement-monotonicity.jsonl", import.meta.url))

	if (existsSync(sibling)) return sibling

	return fileURLToPath(new URL("../../../eval-harness/conformance/refinement-monotonicity.jsonl", import.meta.url))
})()

/**
 * One `rowRef` group's chain structure.
 */
export interface RefinementChain {
	rowRef: string
	/**
	 * The links in order, coarsest first. Each entry is one fixture id.
	 */
	links: string[]
	/**
	 * The fullest query in the group — the text the committed row must hold.
	 */
	tip: string
}

/**
 * Read the chains a suite states, one per `rowRef`.
 *
 * A group whose links do not join returns a chain whose `links` is shorter than the group;
 * {@linkcode auditRefinementSuite} is what turns that into a refusal. Exported because the suite test checks each `tip`
 * against the committed corpus, which is the check this module cannot perform.
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
 * How much of the population this law states a link over.
 *
 * Counted in COMMITTED ROWS, like the canonical-form law's own coverage: the denominator is rows a step can be stated
 * over at all, and a row carrying a three-link chain would otherwise read as three rows of coverage.
 */
export interface RefinementCoverage {
	/**
	 * Committed board rows read.
	 */
	read: number
	/**
	 * Of those, rows at least one named step can act on — the only rows this law can be stated over.
	 */
	eligible: number
	/**
	 * Of the eligible rows, how many this suite states at least one link over.
	 */
	stated: number
	/**
	 * Links stated, across every chain. Always at least {@linkcode stated}, and larger wherever a row carries a chain.
	 */
	links: number
	/**
	 * Eligible rows by the step that can act on them. A row several steps reach is counted under each, so these do NOT
	 * sum to {@linkcode eligible} — the question the breakdown answers is which arms the population can state, not how the
	 * rows partition.
	 */
	eligibleByStep: Record<RefinementStep, number>
}

/**
 * Measure this suite against the population it draws from.
 *
 * `corpusInputs` is every committed board row's query text, supplied by the runner rather than loaded here, so the law
 * module stays free of the corpus loader.
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
 * The coverage line a report prints — stated rows over eligible rows, with the link count and the denominator's own
 * breakdown, so a hold count cannot imply a breadth the suite never exercised.
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
 * Everything that must be true of a refinement row, checked without running anything.
 *
 * Returns one message per problem, each naming the fixture. Empty means the suite states this law and only this law.
 *
 * The `caseCountry` requirement is the canonical-form law's, for the same reason: a row graded with no country routes
 * through the BASE en-US weights package rather than its own overlay, so a violation would be reported for an
 * instrument that was never pointed at the row's locale.
 */
export function auditRefinementSuite(fixtures: readonly ConformanceFixture[]): string[] {
	const problems: string[] = []

	for (const fixture of fixtures) {
		const label = `fixture "${fixture.id}"`

		if (fixture.law !== REFINEMENT_MONOTONICITY_LAW) {
			problems.push(`${label}: law is "${fixture.law}", not "${REFINEMENT_MONOTONICITY_LAW}"`)

			continue
		}

		if (fixture.outcomeComparator !== "candidate_admissibility") {
			problems.push(
				`${label}: names "${fixture.outcomeComparator}" — this law is stated over the resolver's candidate tables, ` +
					`so the only comparator that can read it is "candidate_admissibility"`
			)
		}

		if (fixture.expect !== "refines") {
			problems.push(
				`${label}: expects "${fixture.expect}" — a refinement row states that nothing admissible was lost, and the ` +
					`comparator reports that as "refines"`
			)
		}

		if (!fixture.rowRef) {
			problems.push(
				`${label}: no rowRef — every chain is derived from a committed row, and a row without one names no population`
			)
		}

		if (!fixture.context?.caseCountry) {
			problems.push(
				`${label}: no context.caseCountry — it selects the weights overlay the row grades through, and without it the row is graded base-only against a locale that is not its own`
			)
		}

		if (!classifyRefinementStep(fixture.base, fixture.variant)) {
			problems.push(
				`${label}: base is not a named coarsening of variant — ${JSON.stringify(fixture.base)} is not what any of ` +
					`${REFINEMENT_STEPS.join(" / ")} produces from ${JSON.stringify(fixture.variant)}, so the pair's direction ` +
					`is not reproducible from its own name`
			)
		}
	}

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

		const contexts = new Set(group.map((fixture) => JSON.stringify(fixture.context ?? null)))

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
 * The step label a report line carries, e.g. `drop-trailing-segment`. `?` when the pair does not classify — which the
 * audit refuses, so it can only appear on a hand-built fixture that skipped the loader.
 */
export function describeRefinementStep(fixture: ConformanceFixture): string {
	return classifyRefinementStep(fixture.base, fixture.variant) ?? "?"
}
