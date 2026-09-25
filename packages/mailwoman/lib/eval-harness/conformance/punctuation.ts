/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Punctuation invariance suite, which asserts that separator commas, periods and apostrophe forms do not change a
 *   parse. Hyphens and punctuation inside tokens are out of scope.
 */

import { stringifyJSON } from "@mailwoman/core/json"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"

import {
	auditCommonFixtureFields,
	type ConformanceFixture,
	invarianceExpectProblem,
	MISSING_CASE_COUNTRY_PROBLEM,
	MISSING_ROW_REF_PROBLEM,
	type OutcomeComparatorName,
} from "#eval-harness/conformance/fixture"

/**
 * Law identifier that every suite row carries.
 */
export const PUNCTUATION_LAW = "punctuation-invariance"

/**
 * Named punctuation transformations.
 *
 * - `comma-removed` deletes every separating comma and keeps the spacing (`Portland, or` → `Portland or`).
 * - `period-removed` deletes every separating period (`Neusser Str. 12` → `Neusser Str 12`).
 * - `terminal-period` appends one period unless the text already ends with one.
 * - `apostrophe-typographic` replaces every `'` with `’`.
 * - `apostrophe-ascii` replaces every `’` with `'`.
 *
 * A mark is separating when whitespace or the end of the text follows it.
 */
export const PUNCTUATION_TRANSFORMATIONS = [
	"comma-removed",
	"period-removed",
	"terminal-period",
	"apostrophe-typographic",
	"apostrophe-ascii",
] as const

export type PunctuationTransformationName = (typeof PUNCTUATION_TRANSFORMATIONS)[number]

/**
 * Whether a transformation removes marks, replaces them, or changes the end of the text.
 */
export type PunctuationScope = "boundary" | "removal" | "replacement"

/**
 * Scope of each named transformation.
 */
export const PUNCTUATION_TRANSFORMATION_SCOPE: Record<PunctuationTransformationName, PunctuationScope> = {
	"comma-removed": "removal",
	"period-removed": "removal",
	"terminal-period": "boundary",
	"apostrophe-typographic": "replacement",
	"apostrophe-ascii": "replacement",
}

/**
 * Mark that each removal transformation deletes.
 */
const REMOVED_MARK: Partial<Record<PunctuationTransformationName, string>> = {
	"comma-removed": ",",
	"period-removed": ".",
}

/**
 * Comparators that grade component text copied from the query.
 */
const TEXT_ECHOING_COMPARATORS = new Set<OutcomeComparatorName>(["parse_whole_strict", "component_map"])

/**
 * Removals whose mark belongs to the preceding token, as in `Str.`.
 * Removing the mark changes that token's text.
 */
const TOKEN_TEXT_REMOVALS = new Set<PunctuationTransformationName>(["period-removed"])

/**
 * Deletes each run of `mark` that whitespace or the end of the text follows.
 * Other runs and all whitespace stay.
 */
function removeSeparatingRuns(text: string, mark: string): string {
	let out = ""
	let index = 0

	while (index < text.length) {
		if (text[index] !== mark) {
			out += text[index]
			index += 1

			continue
		}

		let end = index

		while (end < text.length && text[end] === mark) {
			end += 1
		}

		const next = text[end]

		if (next !== undefined && !/\s/u.test(next)) {
			out += text.slice(index, end)
		}

		index = end
	}

	return out
}

/**
 * Implementation of each named transformation.
 */
export const PUNCTUATION_TRANSFORMATION_BY_NAME: Record<PunctuationTransformationName, (text: string) => string> = {
	"comma-removed": (text) => removeSeparatingRuns(text, ","),
	"period-removed": (text) => removeSeparatingRuns(text, "."),
	"terminal-period": (text) => (text.endsWith(".") ? text : `${text}.`),
	"apostrophe-typographic": (text) => text.replaceAll("'", "’"),
	"apostrophe-ascii": (text) => text.replaceAll("’", "'"),
}

/**
 * Returns the text with every Unicode punctuation character removed.
 * Two strings with equal keys differ only in punctuation.
 */
export function punctuationBlindKey(text: string): string {
	return text.replaceAll(/\p{P}/gu, "")
}

/**
 * Returns the named transformation that maps `base` to `variant`, or `null` when none does.
 */
export function classifyPunctuationTransformation(base: string, variant: string): PunctuationTransformationName | null {
	if (base === variant || punctuationBlindKey(base) !== punctuationBlindKey(variant)) return null

	for (const name of PUNCTUATION_TRANSFORMATIONS) {
		if (PUNCTUATION_TRANSFORMATION_BY_NAME[name](base) === variant) return name
	}

	return null
}

/**
 * Rules that exclude a transformation.
 *
 * `identity-transformation` applies when the text does not change.
 * `mark-inside-token` applies when every removable mark sits inside a token.
 *
 * `text-echoing-comparator` applies when the row's comparator grades text that the transformation rewrites.
 */
export const PUNCTUATION_APPLICABILITY_RULES = [
	"identity-transformation",
	"mark-inside-token",
	"text-echoing-comparator",
] as const

export type PunctuationApplicabilityRule = (typeof PUNCTUATION_APPLICABILITY_RULES)[number]

/**
 * Whether a transformation applies to a row, with an explanation.
 */
export interface PunctuationApplicability {
	applicable: boolean
	/**
	 * Rule that excluded the transformation.
	 * It is absent when `applicable` is true.
	 */
	rule?: PunctuationApplicabilityRule
	reason: string
}

/**
 * Grading details of the row that the applicability check needs besides its text.
 */
export interface PunctuationApplicabilityContext {
	/**
	 * The row's `outcomeComparator`.
	 *
	 * The `text-echoing-comparator` rule runs only when this is set.
	 */
	comparator?: OutcomeComparatorName
	/**
	 * Component values that the committed row asserts, for example `["Gate 12, Terminal 2"]`.
	 *
	 * A removal whose mark appears in one of them rewrites that value in the variant.
	 *
	 * The suite audit omits this field because it lacks the corpus rows.
	 * The suite test supplies it.
	 */
	echoedSpans?: readonly string[]
}

/**
 * Checks whether a transformation applies to the text under the row's comparator.
 */
export function punctuationApplicability(
	text: string,
	transformation: PunctuationTransformationName,
	context: PunctuationApplicabilityContext = {}
): PunctuationApplicability {
	const mark = REMOVED_MARK[transformation]

	if (PUNCTUATION_TRANSFORMATION_BY_NAME[transformation](text) === text) {
		if (mark !== undefined && text.includes(mark)) {
			return {
				applicable: false,
				rule: "mark-inside-token",
				reason: `every "${mark}" in this query sits inside a token, so "${transformation}" would rewrite the token's text rather than drop a separator`,
			}
		}

		return {
			applicable: false,
			rule: "identity-transformation",
			reason: `"${transformation}" leaves the text unchanged — the query holds nothing of the kind it acts on, so the pair would state the identity law under a punctuation name`,
		}
	}

	const { comparator, echoedSpans } = context

	if (mark !== undefined && comparator && TEXT_ECHOING_COMPARATORS.has(comparator)) {
		if (TOKEN_TEXT_REMOVALS.has(transformation)) {
			return {
				applicable: false,
				rule: "text-echoing-comparator",
				reason: `a separating "${mark}" belongs to the token in front of it, so "${transformation}" rewrites the span the parser quotes back, and "${comparator}" grades those spans — the reading would report the transformation rather than the pipeline`,
			}
		}

		const echoing = echoedSpans?.filter((span) => span.includes(mark)) ?? []

		if (echoing.length) {
			return {
				applicable: false,
				rule: "text-echoing-comparator",
				reason: `this row asserts a component whose own text carries "${mark}" (${echoing.join(", ")}), and "${comparator}" grades component values — "${transformation}" would rewrite that value and the reading would report the transformation`,
			}
		}
	}

	return {
		applicable: true,
		reason: `"${transformation}" moves punctuation this query holds outside any token${comparator ? ` and outside every span "${comparator}" grades` : ""}`,
	}
}

/**
 * Path to the committed punctuation suite.
 */
export const PUNCTUATION_SUITE_PATH: string = resolvePackagePath(
	"mailwoman",
	"lib",
	"eval-harness",
	"conformance",
	"punctuation.jsonl"
)

/**
 * Audits suite rows.
 *
 * Each row needs a `rowRef`, a `caseCountry`, and a variant that a named transformation
 * derives from the base and that applies under the row's comparator.
 */
export function auditPunctuationSuite(fixtures: readonly ConformanceFixture[]): string[] {
	return auditCommonFixtureFields(fixtures, PUNCTUATION_LAW, (fixture, label, problems) => {
		const expectation = invarianceExpectProblem(fixture, "punctuation")

		if (expectation) {
			problems.push(`${label}: ${expectation}`)
		}

		if (!fixture.rowRef) {
			problems.push(`${label}: ${MISSING_ROW_REF_PROBLEM}`)
		}

		if (!fixture.context?.caseCountry) {
			problems.push(`${label}: ${MISSING_CASE_COUNTRY_PROBLEM}`)
		}

		const transformation = classifyPunctuationTransformation(fixture.base, fixture.variant)

		if (!transformation) {
			problems.push(
				`${label}: variant is not a named punctuation transformation of base — ` +
					(punctuationBlindKey(fixture.base) === punctuationBlindKey(fixture.variant)
						? `the pair differs by punctuation but by no member of ${PUNCTUATION_TRANSFORMATIONS.join(" / ")}, so the change is not reproducible from its own name`
						: `the pair differs by more than punctuation (blind keys ${stringifyJSON(punctuationBlindKey(fixture.base))} ≠ ${stringifyJSON(punctuationBlindKey(fixture.variant))}), which is a different law`)
			)

			return
		}

		const applicability = punctuationApplicability(fixture.base, transformation, {
			comparator: fixture.outcomeComparator,
		})

		if (!applicability.applicable) {
			problems.push(`${label}: ${applicability.rule} — ${applicability.reason}`)
		}
	})
}

/**
 * Returns the fixture's transformation name, or `?` when no named transformation fits.
 */
export function describePunctuationTransformation(fixture: ConformanceFixture): string {
	return classifyPunctuationTransformation(fixture.base, fixture.variant) ?? "?"
}
