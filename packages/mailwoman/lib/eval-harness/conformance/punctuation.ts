/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Define and audit narrow punctuation invariance transformations.
 *   Rows may remove separating commas or periods, append a terminal period, or swap apostrophe forms.
 *   Punctuation-blind keys reject unrelated edits; applicability checks reject unsafe transformations.
 *   Hyphens and punctuation inside names are out of scope. Variants are derived from their names.
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
 * The law name every row in this suite carries.
 */
export const PUNCTUATION_LAW = "punctuation-invariance"

/**
 * The only punctuation transformations allowed in this suite.
 *
 * - `comma-removed` — every separating comma deleted (`Portland, or` → `Portland or`).
 *   The headline register: a user who types an address as a phrase rather than as fields.
 *   The comma goes and the spacing stays, so the tokens keep their text and their order
 *   and only the field separator is gone.
 * - `period-removed` — every separating point deleted (`Neusser Str. 12` → `Neusser Str 12`).
 *   The abbreviation register, where one source writes `Str.` / `Jr.` / `Co.` and the next writes it bare.
 * - `terminal-period` — one full stop appended (`Portland, or` → `Portland, or.`).
 *   The sentence register, and the executable statement that Stage 1's trailing
 *   trim still takes the sentence punctuation a user appends.
 * - `apostrophe-typographic` — every `'` replaced by `’`: what a word processor
 *   does to a straight apostrophe.
 * - `apostrophe-ascii` — every `’` replaced by `'`: what a plain keyboard and a CSV export produce instead.
 *
 * Apostrophe directions have separate names so each input form is tested independently.
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
 * Whether a transformation removes marks, replaces them, or changes a boundary.
 */
export type PunctuationScope = "boundary" | "removal" | "replacement"

/**
 * Scope for each transformation, shared with applicability checks.
 */
export const PUNCTUATION_TRANSFORMATION_SCOPE: Record<PunctuationTransformationName, PunctuationScope> = {
	"comma-removed": "removal",
	"period-removed": "removal",
	"terminal-period": "boundary",
	"apostrophe-typographic": "replacement",
	"apostrophe-ascii": "replacement",
}

/**
 * The mark each removal transformation takes.
 *
 * Absent for the other scopes, which act on a form rather than on a removable separator.
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
 * Removals whose punctuation belongs to the preceding token.
 *
 * The applicability check also inspects asserted spans for embedded commas.
 */
const TOKEN_TEXT_REMOVALS = new Set<PunctuationTransformationName>(["period-removed"])

/**
 * Remove separator runs of `mark`, preserving intra-token marks and whitespace.
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
 * Apply a named transformation; suite variants are derived from this table.
 */
export const PUNCTUATION_TRANSFORMATION_BY_NAME: Record<PunctuationTransformationName, (text: string) => string> = {
	"comma-removed": (text) => removeSeparatingRuns(text, ","),
	"period-removed": (text) => removeSeparatingRuns(text, "."),
	"terminal-period": (text) => (text.endsWith(".") ? text : `${text}.`),
	"apostrophe-typographic": (text) => text.replaceAll("'", "’"),
	"apostrophe-ascii": (text) => text.replaceAll("’", "'"),
}

/**
 * Remove punctuation for comparison; equal keys differ only in punctuation.
 *
 * Letters, digits, marks, and whitespace remain unchanged and in order.
 */
export function punctuationBlindKey(text: string): string {
	return text.replaceAll(/\p{P}/gu, "")
}

/**
 * Identify the named transformation from `base` to `variant`, or return `null`.
 */
export function classifyPunctuationTransformation(base: string, variant: string): PunctuationTransformationName | null {
	if (base === variant || punctuationBlindKey(base) !== punctuationBlindKey(variant)) return null

	for (const name of PUNCTUATION_TRANSFORMATIONS) {
		if (PUNCTUATION_TRANSFORMATION_BY_NAME[name](base) === variant) return name
	}

	return null
}

/**
 * Reasons a transformation cannot safely test this row: identity, in-token punctuation,
 * or a text-echoing comparator that would grade the edit itself.
 */
export const PUNCTUATION_APPLICABILITY_RULES = [
	"identity-transformation",
	"mark-inside-token",
	"text-echoing-comparator",
] as const

export type PunctuationApplicabilityRule = (typeof PUNCTUATION_APPLICABILITY_RULES)[number]

/**
 * Applicability result and explanation.
 */
export interface PunctuationApplicability {
	applicable: boolean
	/**
	 * The rule that excluded it.
	 *
	 * Absent when `applicable`.
	 */
	rule?: PunctuationApplicabilityRule
	reason: string
}

/**
 * What the row grades on, beyond its text.
 */
export interface PunctuationApplicabilityContext {
	/**
	 * The row's own `outcomeComparator`.
	 *
	 * Absent skips the {@linkcode PUNCTUATION_APPLICABILITY_RULES} `text-echoing-comparator` reading,
	 * which is what the suite audit does: the audit knows the comparator but not the spans.
	 * Therefore, it applies the declared half of the rule and the suite test applies the corpus-grounded half.
	 */
	comparator?: OutcomeComparatorName
	/**
	 * The component values the committed row asserts, e.g. `["Gate 12, Terminal 2"]`.
	 *
	 * A removal whose mark appears in one of them rewrites that value on the variant
	 * side whatever the transformation's declared scope says.
	 */
	echoedSpans?: readonly string[]
}

/**
 * Check whether this transformation can test the supplied text and comparator.
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
 * Audit fixture fields, country context, transformations, and declared applicability.
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
 * The transformation label a report line carries, e.g. `comma-removed`.
 *
 * `?` when the pair does not classify.
 * The audit refuses that, so it can only appear on a hand-built fixture that skipped the loader.
 */
export function describePunctuationTransformation(fixture: ConformanceFixture): string {
	return classifyPunctuationTransformation(fixture.base, fixture.variant) ?? "?"
}
