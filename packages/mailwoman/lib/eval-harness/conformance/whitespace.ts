/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Define and audit pipeline invariance under whitespace changes.
 *   Transformations cover boundaries, safe internal runs, and comma spacing.
 *   Newlines and structured-identifier spaces are excluded; variants are derived by name.
 *   The blind key rejects non-whitespace edits, and applicability rejects unsafe rows.
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
 * The law name every row in this suite carries.
 */
export const WHITESPACE_LAW = "whitespace-invariance"

/**
 * The only whitespace transformations allowed in this suite.
 *
 * - `leading` / `trailing` — the pasted-cell registers: one ascii space bolted onto an end.
 *   Separate names because Stage 1 reaches them through separate code.
 *   The leading trim takes whitespace only, the trailing trim takes whitespace
 *   and the sentence punctuation a user appends — so one can regress without the other.
 * - `repeated` — every safe internal run doubled: the concatenated-column register.
 * - `tabbed` — every safe internal run replaced by one tab: the TSV-export register, and the arm
 *   that states the collapse still shields the segmentation grammar (see the module docstring).
 * - `separator-tightened` — the whitespace after each comma deleted (`Portland, or` → `Portland,or`).
 *   The comma survives, so the fields stay separated and the token order is untouched.
 * - `separator-loosened` — one space inserted before each comma (`Portland, or` → `Portland , or`).
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
 * Whether a transformation changes a boundary, run, or separator.
 */
export type WhitespaceScope = "boundary" | "run" | "separator"

/**
 * Scope for each transformation, shared with applicability checks.
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
 * Split text into alternating tokens and whitespace runs.
 */
function splitOnWhitespaceRuns(text: string): string[] {
	return text.split(/(\s+)/)
}

/**
 * Check postcode shapes using codex formats, including unit-grade forms.
 */
function isPostcodeShape(candidate: string): boolean {
	if (candidateSystemsForPostcode(candidate).length) return true

	return UNIT_GRADE_POSTCODE.some((pattern) => pattern.test(candidate))
}

/**
 * Return whitespace-run indices whose adjacent tokens form a structured postcode.
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
 * Return structured identifiers whose internal spaces cannot be changed.
 */
export function structuralIdentifierSpaces(text: string): string[] {
	const parts = splitOnWhitespaceRuns(text)

	return [...structuralRunIndices(parts)].map((index) => `${parts[index - 1] ?? ""} ${parts[index + 1] ?? ""}`)
}

/**
 * How many whitespace runs `text` holds, structural ones included.
 */
function whitespaceRunCount(text: string): number {
	return (splitOnWhitespaceRuns(text).length - 1) / 2
}

/**
 * Rewrite every safe whitespace run and leave the structural ones byte-identical.
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
 * Apply a named transformation; suite variants are derived from this table.
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
 * Remove whitespace for comparison; equal keys differ only in whitespace.
 */
export function whitespaceBlindKey(text: string): string {
	return text.replaceAll(/\s+/gu, "")
}

/**
 * Identify the named transformation from `base` to `variant`, or return `null`.
 */
export function classifyWhitespaceTransformation(base: string, variant: string): WhitespaceTransformationName | null {
	if (base === variant || whitespaceBlindKey(base) !== whitespaceBlindKey(variant)) return null

	for (const name of WHITESPACE_TRANSFORMATIONS) {
		if (WHITESPACE_TRANSFORMATION_BY_NAME[name](base) === variant) return name
	}

	return null
}

/**
 * Reasons a transformation cannot apply: identity or only structural identifier spaces.
 */
export const WHITESPACE_APPLICABILITY_RULES = ["identity-transformation", "structural-identifier-space"] as const

export type WhitespaceApplicabilityRule = (typeof WHITESPACE_APPLICABILITY_RULES)[number]

/**
 * Applicability result and explanation.
 */
export interface WhitespaceApplicability {
	applicable: boolean
	/**
	 * The rule that excluded it.
	 *
	 * Absent when `applicable`.
	 */
	rule?: WhitespaceApplicabilityRule
	reason: string
}

/**
 * Check whether this transformation can test the text's whitespace.
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
 * Audit fixture fields, country context, and named transformations.
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
 * Return the transformation label, or `?` for an invalid pair.
 */
export function describeWhitespaceTransformation(fixture: ConformanceFixture): string {
	return classifyWhitespaceTransformation(fixture.base, fixture.variant) ?? "?"
}
