/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Canonical-form invariance suite, which asserts that NFC and NFD spellings of an address parse equivalently.
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
 * Law identifier that every suite row carries.
 */
export const CANONICAL_FORM_LAW = "canonical-form-invariance"

/**
 * Named canonical normalization forms.
 * The suite excludes the compatibility forms NFKC and NFKD.
 */
export const CANONICAL_FORMS = ["nfd", "nfc"] as const

export type CanonicalFormName = (typeof CANONICAL_FORMS)[number]

/**
 * Implementation of each named transformation.
 */
export const CANONICAL_TRANSFORMATION_BY_NAME: Record<CanonicalFormName, (text: string) => string> = {
	nfd: (text) => text.normalize("NFD"),
	nfc: (text) => text.normalize("NFC"),
}

/**
 * Returns the NFD form.
 *
 * Two strings are canonically equivalent when their keys are equal.
 */
export function canonicalFormKey(text: string): string {
	return text.normalize("NFD")
}

/**
 * Reports whether the NFC and NFD forms of the text differ.
 */
export function canonicallyVariant(text: string): boolean {
	return text.normalize("NFC") !== text.normalize("NFD")
}

/**
 * Canonical form that a string is written in.
 *
 * The value `mixed` means the string is in neither NFC nor NFD.
 */
export const CANONICAL_FORM_STATES = ["nfc", "nfd", "mixed"] as const

export type CanonicalFormState = (typeof CANONICAL_FORM_STATES)[number]

/**
 * Returns the canonical form that the text is written in.
 * Text with no decomposable character reports `nfc`.
 */
export function canonicalFormState(text: string): CanonicalFormState {
	if (text === text.normalize("NFC")) return "nfc"

	if (text === text.normalize("NFD")) return "nfd"

	return "mixed"
}

/**
 * Returns the named form that maps `base` to `variant`, or `null` when neither form does.
 */
export function classifyCanonicalTransformation(base: string, variant: string): CanonicalFormName | null {
	if (base === variant || canonicalFormKey(base) !== canonicalFormKey(variant)) return null

	for (const name of CANONICAL_FORMS) {
		if (CANONICAL_TRANSFORMATION_BY_NAME[name](base) === variant) return name
	}

	return null
}

/**
 * Rules that exclude a transformation.
 *
 * The first applies when the text has identical NFC and NFD forms.
 * The second applies when the text is already in the target form.
 */
export const CANONICAL_APPLICABILITY_RULES = ["no-canonical-variance", "already-in-target-form"] as const

export type CanonicalApplicabilityRule = (typeof CANONICAL_APPLICABILITY_RULES)[number]

/**
 * Whether a form applies to a text, with an explanation.
 */
export interface CanonicalApplicability {
	applicable: boolean
	/**
	 * Rule that excluded the form.
	 * It is absent when `applicable` is true.
	 */
	rule?: CanonicalApplicabilityRule
	reason: string
}

/**
 * Checks whether normalizing the text to `form` changes it.
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
 * Counts that compare the suite against a corpus.
 */
export interface CanonicalFormCoverage {
	/**
	 * Number of corpus inputs read.
	 */
	read: number
	/**
	 * Number of inputs whose NFC and NFD forms differ.
	 */
	eligible: number
	/**
	 * Number of distinct source rows among fixtures whose variant differs from the base.
	 */
	transformed: number
	/**
	 * Eligible inputs grouped by the canonical form they are written in.
	 */
	eligibleByState: Record<CanonicalFormState, number>
}

/**
 * Measures how much of the corpus the suite covers.
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

	// A hand-built fixture without a `rowRef` is identified by its base text.
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
 * Formats the coverage counts as one line.
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
 * Audits suite rows.
 *
 * Each row needs a `rowRef`, a `caseCountry`, and a variant that a named form derives from the base.
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
 * Returns the fixture's form name, or `?` when neither form fits.
 */
export function describeCanonicalTransformation(fixture: ConformanceFixture): string {
	return classifyCanonicalTransformation(fixture.base, fixture.variant) ?? "?"
}
