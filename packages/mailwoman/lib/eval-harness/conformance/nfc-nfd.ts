/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Define and audit NFC/NFD invariance: canonically equivalent text should produce equivalent results. Exclude
 *   compatibility, accent-removal, and case changes. Derive variants from their named transformations and report which
 *   directions the corpus supports.
 */

import { stringifyJSON } from "@mailwoman/core/json"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"

import {
	auditCommonFixtureFields,
	type ConformanceFixture,
	invarianceExpectProblem,
	MISSING_CASE_COUNTRY_PROBLEM,
	MISSING_ROW_REF_PROBLEM,
} from "#eval-harness/conformance/fixture"

/**
 * Law identifier used by suite rows.
 */
export const CANONICAL_FORM_LAW = "canonical-form-invariance"

/**
 * Supported canonical normalization forms.
 * Compatibility forms are excluded.
 */
export const CANONICAL_FORMS = ["nfd", "nfc"] as const

export type CanonicalFormName = (typeof CANONICAL_FORMS)[number]

/**
 * Transformations used to derive suite variants.
 */
export const CANONICAL_TRANSFORMATION_BY_NAME: Record<CanonicalFormName, (text: string) => string> = {
	nfd: (text) => text.normalize("NFD"),
	nfc: (text) => text.normalize("NFC"),
}

/**
 * NFD comparison key; equal keys indicate canonical equivalence.
 */
export function canonicalFormKey(text: string): string {
	return text.normalize("NFD")
}

/**
 * Check whether NFC and NFD produce different text.
 */
export function canonicallyVariant(text: string): boolean {
	return text.normalize("NFC") !== text.normalize("NFD")
}

/**
 * Current canonical form of a string; `mixed` means neither NFC nor NFD.
 */
export const CANONICAL_FORM_STATES = ["nfc", "nfd", "mixed"] as const

export type CanonicalFormState = (typeof CANONICAL_FORM_STATES)[number]

/**
 * Identify the string's canonical form.
 */
export function canonicalFormState(text: string): CanonicalFormState {
	if (text === text.normalize("NFC")) return "nfc"

	if (text === text.normalize("NFD")) return "nfd"

	return "mixed"
}

/**
 * Identify the named transformation from `base` to `variant`, or return `null` if none applies.
 */
export function classifyCanonicalTransformation(base: string, variant: string): CanonicalFormName | null {
	if (base === variant || canonicalFormKey(base) !== canonicalFormKey(variant)) return null

	for (const name of CANONICAL_FORMS) {
		if (CANONICAL_TRANSFORMATION_BY_NAME[name](base) === variant) return name
	}

	return null
}

/**
 * Reasons a canonical transformation is inapplicable: no canonical variance or already in the target form.
 */
export const CANONICAL_APPLICABILITY_RULES = ["no-canonical-variance", "already-in-target-form"] as const

export type CanonicalApplicabilityRule = (typeof CANONICAL_APPLICABILITY_RULES)[number]

/**
 * Applicability result and explanation.
 */
export interface CanonicalApplicability {
	applicable: boolean
	/**
	 * The rule that excluded it.
	 *
	 * Absent when `applicable`.
	 */
	rule?: CanonicalApplicabilityRule
	reason: string
}

/**
 * Check whether `form` can test this text's canonical variance.
 */
export function canonicalApplicability(text: string, form: CanonicalFormName): CanonicalApplicability {
	if (!canonicallyVariant(text)) {
		return {
			applicable: false,
			rule: "no-canonical-variance",
			reason: `this query's NFC and NFD forms are the same bytes — it carries no character with a canonical decomposition, so "${form}" would state the identity law under a canonical-form name`,
		}
	}

	if (CANONICAL_TRANSFORMATION_BY_NAME[form](text) === text) {
		const other = CANONICAL_FORMS.find((name) => name !== form)!

		return {
			applicable: false,
			rule: "already-in-target-form",
			reason: `this query is already written in ${form.toUpperCase()}, so "${form}" moves nothing — the arm this row states is "${other}"`,
		}
	}

	return {
		applicable: true,
		reason: `"${form}" rewrites the canonical form of a query written in ${canonicalFormState(text)}, and every code point survives the rewrite in canonical order`,
	}
}

/**
 * Path to the committed canonical-form suite.
 */
export const NFC_NFD_SUITE_PATH: string = resolvePackagePath(
	"mailwoman",
	"lib",
	"eval-harness",
	"conformance",
	"nfc-nfd.jsonl"
)

/**
 * Counts describing suite coverage of the corpus population.
 */
export interface CanonicalFormCoverage {
	/**
	 * Board rows examined.
	 */
	read: number
	/**
	 * Rows with distinct NFC and NFD forms.
	 */
	eligible: number
	/**
	 * Eligible rows with a byte-distinct fixture variant, counted once per source row.
	 */
	transformed: number
	/**
	 * Eligible rows grouped by their current canonical form.
	 */
	eligibleByState: Record<CanonicalFormState, number>
}

/**
 * Measure suite coverage against caller-supplied corpus inputs.
 */
export function canonicalFormCoverage(
	fixtures: readonly ConformanceFixture[],
	corpusInputs: readonly string[]
): CanonicalFormCoverage {
	const eligibleInputs = corpusInputs.filter((input) => canonicallyVariant(input))
	const eligibleByState: Record<CanonicalFormState, number> = { nfc: 0, nfd: 0, mixed: 0 }

	for (const input of eligibleInputs) {
		eligibleByState[canonicalFormState(input)] += 1
	}

	// Use fixture text as the fallback for hand-built rows without references.
	const moved = fixtures.filter((fixture) => fixture.base !== fixture.variant)
	const transformed = new Set(moved.map((fixture) => fixture.rowRef ?? fixture.base))

	return {
		read: corpusInputs.length,
		eligible: eligibleInputs.length,
		transformed: transformed.size,
		eligibleByState,
	}
}

/**
 * Format coverage and the eligible rows' form breakdown.
 */
export function describeCanonicalFormCoverage(
	fixtures: readonly ConformanceFixture[],
	corpusInputs: readonly string[]
): string {
	const coverage = canonicalFormCoverage(fixtures, corpusInputs)
	const states = CANONICAL_FORM_STATES.map((state) => `${state} ${coverage.eligibleByState[state]}`).join(", ")

	return (
		`coverage: ${coverage.transformed}/${coverage.eligible} eligible committed rows transformed ` +
		`(${coverage.eligible} of ${coverage.read} rows read are canonically variant; those rows are written ${states})`
	)
}

/**
 * Audit law relation, source reference, country context, and named transformation.
 */
export function auditCanonicalFormSuite(fixtures: readonly ConformanceFixture[]): string[] {
	return auditCommonFixtureFields(fixtures, CANONICAL_FORM_LAW, (fixture, label, problems) => {
		const expectation = invarianceExpectProblem(fixture, "canonical-form")

		if (expectation) {
			problems.push(`${label}: ${expectation}`)
		}

		if (!fixture.rowRef) {
			problems.push(`${label}: ${MISSING_ROW_REF_PROBLEM}`)
		}

		if (!fixture.context?.caseCountry) {
			problems.push(`${label}: ${MISSING_CASE_COUNTRY_PROBLEM}`)
		}

		if (!classifyCanonicalTransformation(fixture.base, fixture.variant)) {
			problems.push(
				`${label}: variant is not a named canonical transformation of base — ` +
					(canonicalFormKey(fixture.base) === canonicalFormKey(fixture.variant)
						? `the pair is canonically equivalent but is neither of ${CANONICAL_FORMS.join(" / ")}, so the change is not reproducible from its own name`
						: `the pair is NOT canonically equivalent (decompositions ${stringifyJSON(canonicalFormKey(fixture.base))} ≠ ${stringifyJSON(canonicalFormKey(fixture.variant))}) — a compatibility rewrite, a removed accent or a case change is a different law`)
			)
		}
	})
}

/**
 * Return the transformation label, or `?` for an invalid pair.
 */
export function describeCanonicalTransformation(fixture: ConformanceFixture): string {
	return classifyCanonicalTransformation(fixture.base, fixture.variant) ?? "?"
}
