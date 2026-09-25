/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Case-folding invariance suite, which asserts that case-only variants of an address parse equivalently.
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
export const CASE_FOLDING_LAW = "case-folding-invariance"

/**
 * Named case transformations.
 *
 * The `mixed` transformation title-cases each whitespace-separated token.
 */
export const CASE_TRANSFORMATIONS = ["upper", "lower", "mixed"] as const

export type CaseTransformationName = (typeof CASE_TRANSFORMATIONS)[number]

/**
 * Lowercases a token and then uppercases its first cased character.
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
 * Implementation of each named transformation.
 * The `mixed` transformation keeps the original whitespace.
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
 * Returns a case-insensitive key.
 * Uppercasing first applies expansions such as `ß` to `SS`.
 */
export function caseFoldKey(text: string): string {
	return text.toUpperCase().toLowerCase()
}

/**
 * Returns the named transformation that maps `base` to `variant`, or `null` when none does.
 */
export function classifyCaseTransformation(base: string, variant: string): CaseTransformationName | null {
	if (base === variant || caseFoldKey(base) !== caseFoldKey(variant)) return null

	for (const name of CASE_TRANSFORMATIONS) {
		if (CASE_TRANSFORMATION_BY_NAME[name](base) === variant) return name
	}

	return null
}

/**
 * Rules that exclude a transformation.
 *
 * The first applies when the transformation leaves the text unchanged.
 * The second applies when locale-specific casing would change which letter is written.
 */
export const CASE_APPLICABILITY_RULES = ["identity-transformation", "locale-sensitive-casing"] as const

export type CaseApplicabilityRule = (typeof CASE_APPLICABILITY_RULES)[number]

/**
 * Characters whose casing depends on locale, keyed by ISO 3166-1 alpha-2 country code.
 */
const LOCALE_SENSITIVE_CASING: Record<string, { characters: string; note: string }> = {
	TR: { characters: "iıIİ", note: "Turkish separates dotted i/İ from dotless ı/I" },
	AZ: { characters: "iıIİ", note: "Azeri separates dotted i/İ from dotless ı/I" },
	LT: { characters: "iįjIĮJ", note: "Lithuanian retains the dot on a lowercase i/j under an accent" },
}

/**
 * Whether a transformation applies to a text, with an explanation.
 */
export interface CaseApplicability {
	applicable: boolean
	/**
	 * Rule that excluded the transformation.
	 * It is absent when `applicable` is true.
	 */
	rule?: CaseApplicabilityRule
	reason: string
}

/**
 * Checks whether a case transformation applies to the text in the given country.
 * The identity rule wins when both rules match.
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
 * Audits suite rows.
 *
 * Each row needs a `rowRef`, a `caseCountry`, and a variant that a named transformation
 * derives from the base and that applies in that country.
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
 * Returns the fixture's transformation name, or `?` when no named transformation fits.
 */
export function describeCaseTransformation(fixture: ConformanceFixture): string {
	return classifyCaseTransformation(fixture.base, fixture.variant) ?? "?"
}
