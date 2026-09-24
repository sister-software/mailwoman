/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Define and audit the case-folding invariance suite: case-only variants should produce equivalent parses. Validate
 *   that variants are named transformations and semantically applicable in the row's locale; locale-sensitive casing
 *   and identity transformations are excluded.
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
 * Law identifier used by every suite row.
 */
export const CASE_FOLDING_LAW = "case-folding-invariance"

/**
 * Supported case transformations: uppercase, lowercase, and mixed/title case.
 */
export const CASE_TRANSFORMATIONS = ["upper", "lower", "mixed"] as const

export type CaseTransformationName = (typeof CASE_TRANSFORMATIONS)[number]

/**
 * Capitalize the first cased character and lowercase the rest.
 */
function titleCaseToken(token: string): string {
	const lower = token.toLowerCase()
	const index = [...lower].findIndex((character) => character.toUpperCase() !== character)

	if (index === -1) return lower

	const characters = [...lower]

	characters[index] = characters[index]!.toUpperCase()

	return characters.join("")
}

/**
 * Pure transformations used to derive and verify suite variants.
 * Preserve whitespace in mixed case.
 */
export const CASE_TRANSFORMATION_BY_NAME: Record<CaseTransformationName, (text: string) => string> = {
	upper: (text) => text.toUpperCase(),
	lower: (text) => text.toLowerCase(),
	mixed: (text) =>
		text
			.split(/(\s+)/)
			.map((token) => (/^\s*$/.test(token) ? token : titleCaseToken(token)))
			.join(""),
}

/**
 * Produce a case-insensitive key, including Unicode expansions such as `ß` to `ss`.
 */
export function caseFoldKey(text: string): string {
	return text.toUpperCase().toLowerCase()
}

/**
 * Identify the named case transformation from `base` to `variant`, or return
 * `null` if the pair differs otherwise.
 */
export function classifyCaseTransformation(base: string, variant: string): CaseTransformationName | null {
	if (base === variant || caseFoldKey(base) !== caseFoldKey(variant)) return null

	for (const name of CASE_TRANSFORMATIONS) {
		if (CASE_TRANSFORMATION_BY_NAME[name](base) === variant) return name
	}

	return null
}

/**
 * Reasons a transformation is not applicable: it changes nothing,
 * or locale-specific casing changes letter identity.
 */
export const CASE_APPLICABILITY_RULES = ["identity-transformation", "locale-sensitive-casing"] as const

export type CaseApplicabilityRule = (typeof CASE_APPLICABILITY_RULES)[number]

/**
 * Locale-sensitive casing characters, keyed by ISO-2 country code.
 */
const LOCALE_SENSITIVE_CASING: Record<string, { characters: string; note: string }> = {
	TR: { characters: "iıIİ", note: "Turkish separates dotted i/İ from dotless ı/I" },
	AZ: { characters: "iıIİ", note: "Azeri separates dotted i/İ from dotless ı/I" },
	LT: { characters: "iįjIĮJ", note: "Lithuanian retains the dot on a lowercase i/j under an accent" },
}

/**
 * Applicability result and explanation.
 */
export interface CaseApplicability {
	applicable: boolean
	/**
	 * The rule that excluded it.
	 *
	 * Absent when `applicable`.
	 */
	rule?: CaseApplicabilityRule
	reason: string
}

/**
 * Check whether a case transformation is meaningful for this text and locale.
 * Test identity transformations first.
 */
export function caseApplicability(
	text: string,
	transformation: CaseTransformationName,
	country?: string
): CaseApplicability {
	if (CASE_TRANSFORMATION_BY_NAME[transformation](text) === text) {
		return {
			applicable: false,
			rule: "identity-transformation",
			reason: `"${transformation}" leaves the text unchanged — either the script has no case or the text is already written in that case, so the pair would state the identity law under a case-folding name`,
		}
	}

	const sensitive = country ? LOCALE_SENSITIVE_CASING[country.toUpperCase()] : undefined

	if (sensitive && [...sensitive.characters].some((character) => text.includes(character))) {
		return {
			applicable: false,
			rule: "locale-sensitive-casing",
			reason: `${country} casing is locale-conditional (${sensitive.note}), and the text carries one of "${sensitive.characters}" — a root-locale "${transformation}" would change which letter is written, so the pair is not a case variant of the same name`,
		}
	}

	return { applicable: true, reason: `root-locale "${transformation}" preserves every letter's identity` }
}

/**
 * Path to the committed case-folding suite.
 */
export const CASE_FOLDING_SUITE_PATH: string = resolvePackagePath(
	"mailwoman",
	"lib",
	"eval-harness",
	"conformance",
	"case-folding.jsonl"
)

/**
 * Audit suite rows for valid case-only transformations and locale applicability.
 *
 * Requires `caseCountry` so each row uses the intended locale.
 */
export function auditCaseFoldingSuite(fixtures: readonly ConformanceFixture[]): string[] {
	return auditCommonFixtureFields(fixtures, CASE_FOLDING_LAW, (fixture, label, problems) => {
		const expectation = invarianceExpectProblem(fixture, "case-folding")

		if (expectation) {
			problems.push(`${label}: ${expectation}`)
		}

		if (!fixture.rowRef) {
			problems.push(`${label}: ${MISSING_ROW_REF_PROBLEM}`)
		}

		const country = fixture.context?.caseCountry

		if (!country) {
			problems.push(`${label}: ${MISSING_CASE_COUNTRY_PROBLEM}`)
		}

		const transformation = classifyCaseTransformation(fixture.base, fixture.variant)

		if (!transformation) {
			problems.push(
				`${label}: variant is not a named case transformation of base — ` +
					(caseFoldKey(fixture.base) === caseFoldKey(fixture.variant)
						? `the pair differs by case but by no member of ${CASE_TRANSFORMATIONS.join(" / ")}, so the change is not reproducible from its own name`
						: `the pair differs by more than case (fold keys ${stringifyJSON(caseFoldKey(fixture.base))} ≠ ${stringifyJSON(caseFoldKey(fixture.variant))}), which is a different law`)
			)

			return
		}

		const applicability = caseApplicability(fixture.base, transformation, country)

		if (!applicability.applicable) {
			problems.push(`${label}: ${applicability.rule} — ${applicability.reason}`)
		}
	})
}

/**
 * Return the transformation label, or `?` when the pair is invalid.
 */
export function describeCaseTransformation(fixture: ConformanceFixture): string {
	return classifyCaseTransformation(fixture.base, fixture.variant) ?? "?"
}
