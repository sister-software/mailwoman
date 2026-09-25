/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Whitespace invariance suite, which asserts that edge spaces, internal runs and comma spacing do not change a parse.
 *   The space inside a structured postcode such as `SW1A 1AA` is never rewritten.
 */

import { candidateSystemsForPostcode, UNIT_GRADE_POSTCODE } from "@mailwoman/codex"
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
export const WHITESPACE_LAW = "whitespace-invariance"

/**
 * Named whitespace transformations.
 *
 * - `leading` and `trailing` add one ASCII space at the start or end.
 *   They have separate names because the pipeline trims the two ends with separate code.
 * - `repeated` doubles every safe internal whitespace run.
 * - `tabbed` replaces every safe internal whitespace run with one tab.
 * - `separator-tightened` deletes spaces and tabs after each comma (`Portland, or` → `Portland,or`).
 * - `separator-loosened` inserts one space before each comma (`Portland, or` → `Portland , or`).
 *
 * A run is safe unless it sits inside a structured postcode.
 */
export const WHITESPACE_TRANSFORMATIONS = [
	"leading",
	"trailing",
	"repeated",
	"tabbed",
	"separator-tightened",
	"separator-loosened",
] as const

export type WhitespaceTransformationName = (typeof WHITESPACE_TRANSFORMATIONS)[number]

/**
 * Whether a transformation changes an end of the text, an internal run, or comma spacing.
 */
export type WhitespaceScope = "boundary" | "run" | "separator"

/**
 * Scope of each named transformation.
 */
export const WHITESPACE_TRANSFORMATION_SCOPE: Record<WhitespaceTransformationName, WhitespaceScope> = {
	leading: "boundary",
	trailing: "boundary",
	repeated: "run",
	tabbed: "run",
	"separator-tightened": "separator",
	"separator-loosened": "separator",
}

/**
 * Splits text into tokens and whitespace runs.
 * Runs sit at the odd indices.
 */
function splitOnWhitespaceRuns(text: string): string[] {
	return text.split(/(\s+)/)
}

/**
 * Reports whether the candidate matches a codex postcode format or a unit-grade postcode pattern.
 */
function isPostcodeShape(candidate: string): boolean {
	if (candidateSystemsForPostcode(candidate).length) return true

	return UNIT_GRADE_POSTCODE.some((pattern) => pattern.test(candidate))
}

/**
 * Returns the indices of whitespace runs whose neighboring tokens, joined by one space, form a postcode.
 */
function structuralRunIndices(parts: readonly string[]): Set<number> {
	const structural = new Set<number>()

	for (let index = 1; index < parts.length; index += 2) {
		const joined = `${parts[index - 1] ?? ""} ${parts[index + 1] ?? ""}`

		if (isPostcodeShape(joined)) {
			structural.add(index)
		}
	}

	return structural
}

/**
 * Returns each postcode in the text whose internal space the transformations must keep.
 */
export function structuralIdentifierSpaces(text: string): string[] {
	const parts = splitOnWhitespaceRuns(text)

	return [...structuralRunIndices(parts)].map((index) => `${parts[index - 1] ?? ""} ${parts[index + 1] ?? ""}`)
}

/**
 * Counts the whitespace runs in the text, including runs inside postcodes.
 */
function whitespaceRunCount(text: string): number {
	return (splitOnWhitespaceRuns(text).length - 1) / 2
}

/**
 * Rewrites every whitespace run except the runs inside postcodes.
 */
function rewriteSafeRuns(text: string, rewrite: (run: string) => string): string {
	const parts = splitOnWhitespaceRuns(text)
	const structural = structuralRunIndices(parts)

	for (let index = 1; index < parts.length; index += 2) {
		if (!structural.has(index)) {
			parts[index] = rewrite(parts[index]!)
		}
	}

	return parts.join("")
}

/**
 * Implementation of each named transformation.
 */
export const WHITESPACE_TRANSFORMATION_BY_NAME: Record<WhitespaceTransformationName, (text: string) => string> = {
	leading: (text) => ` ${text}`,
	trailing: (text) => `${text} `,
	repeated: (text) => rewriteSafeRuns(text, (run) => run + run),
	tabbed: (text) => rewriteSafeRuns(text, () => "\t"),
	"separator-tightened": (text) => text.replaceAll(/,[ \t]+/g, ","),
	"separator-loosened": (text) => text.replaceAll(",", " ,"),
}

/**
 * Returns the text with all whitespace removed.
 * Two strings with equal keys differ only in whitespace.
 */
export function whitespaceBlindKey(text: string): string {
	return text.replaceAll(/\s+/gu, "")
}

/**
 * Returns the named transformation that maps `base` to `variant`, or `null` when none does.
 */
export function classifyWhitespaceTransformation(base: string, variant: string): WhitespaceTransformationName | null {
	if (base === variant || whitespaceBlindKey(base) !== whitespaceBlindKey(variant)) return null

	for (const name of WHITESPACE_TRANSFORMATIONS) {
		if (WHITESPACE_TRANSFORMATION_BY_NAME[name](base) === variant) return name
	}

	return null
}

/**
 * Rules that exclude a transformation.
 *
 * The first applies when the text does not change.
 * The second applies when every internal run sits inside a postcode.
 */
export const WHITESPACE_APPLICABILITY_RULES = ["identity-transformation", "structural-identifier-space"] as const

export type WhitespaceApplicabilityRule = (typeof WHITESPACE_APPLICABILITY_RULES)[number]

/**
 * Whether a transformation applies to a text, with an explanation.
 */
export interface WhitespaceApplicability {
	applicable: boolean
	/**
	 * Rule that excluded the transformation.
	 * It is absent when `applicable` is true.
	 */
	rule?: WhitespaceApplicabilityRule
	reason: string
}

/**
 * Checks whether a transformation changes the text.
 */
export function whitespaceApplicability(
	text: string,
	transformation: WhitespaceTransformationName
): WhitespaceApplicability {
	if (WHITESPACE_TRANSFORMATION_BY_NAME[transformation](text) !== text) {
		return { applicable: true, reason: `"${transformation}" moves whitespace this query holds outside any identifier` }
	}

	const scope = WHITESPACE_TRANSFORMATION_SCOPE[transformation]

	if (scope === "run") {
		const identifiers = structuralIdentifierSpaces(text)

		if (identifiers.length && identifiers.length === whitespaceRunCount(text)) {
			return {
				applicable: false,
				rule: "structural-identifier-space",
				reason: `every whitespace run in this query sits inside a structured identifier (${identifiers.join(", ")}) whose format grammar fixes it, so "${transformation}" has no safe run to act on`,
			}
		}

		return {
			applicable: false,
			rule: "identity-transformation",
			reason: `"${transformation}" leaves the text unchanged — the query holds no internal whitespace, so the pair would state the identity law under a whitespace name`,
		}
	}

	if (scope === "separator") {
		return {
			applicable: false,
			rule: "identity-transformation",
			reason: `"${transformation}" leaves the text unchanged — the query holds no comma with whitespace to move, so the pair would state the identity law under a whitespace name`,
		}
	}

	return {
		applicable: false,
		rule: "identity-transformation",
		reason: `"${transformation}" leaves the text unchanged`,
	}
}

/**
 * Path to the committed whitespace suite.
 */
export const WHITESPACE_SUITE_PATH: string = resolvePackagePath(
	"mailwoman",
	"lib",
	"eval-harness",
	"conformance",
	"whitespace.jsonl"
)

/**
 * Audits suite rows.
 *
 * Each row needs a `rowRef`, a `caseCountry`, and a variant that a named
 * transformation derives from the base.
 */
export function auditWhitespaceSuite(fixtures: readonly ConformanceFixture[]): string[] {
	return auditCommonFixtureFields(fixtures, WHITESPACE_LAW, (fixture, label, problems) => {
		const expectation = invarianceExpectProblem(fixture, "whitespace")

		if (expectation) {
			problems.push(`${label}: ${expectation}`)
		}

		if (!fixture.rowRef) {
			problems.push(`${label}: ${MISSING_ROW_REF_PROBLEM}`)
		}

		if (!fixture.context?.caseCountry) {
			problems.push(`${label}: ${MISSING_CASE_COUNTRY_PROBLEM}`)
		}

		if (!classifyWhitespaceTransformation(fixture.base, fixture.variant)) {
			problems.push(
				`${label}: variant is not a named whitespace transformation of base — ` +
					(whitespaceBlindKey(fixture.base) === whitespaceBlindKey(fixture.variant)
						? `the pair differs by whitespace but by no member of ${WHITESPACE_TRANSFORMATIONS.join(" / ")}, so the change is not reproducible from its own name`
						: `the pair differs by more than whitespace (blind keys ${stringifyJSON(whitespaceBlindKey(fixture.base))} ≠ ${stringifyJSON(whitespaceBlindKey(fixture.variant))}), which is a different law`)
			)
		}
	})
}

/**
 * Returns the fixture's transformation name, or `?` when no named transformation fits.
 */
export function describeWhitespaceTransformation(fixture: ConformanceFixture): string {
	return classifyWhitespaceTransformation(fixture.base, fixture.variant) ?? "?"
}
