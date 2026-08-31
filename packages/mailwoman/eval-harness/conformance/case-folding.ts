/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The case-folding invariance law: changing only the CASE of a query must not change what the pipeline
 *   answered. Pure — no model, no I/O beyond reading the committed suite.
 *
 *   WHY THIS IS A PRODUCT COMMITMENT AND NOT A NICETY. Lowercase is the user register: a phone keyboard
 *   emits it, a pasted spreadsheet cell emits SHOUTING, and an autocapitalized field emits Title Case. All
 *   three name the same building as the mixed-case form a curator typed into the board. A pipeline that
 *   resolves one and not the others has not made a small mistake on an unusual input; it has failed the
 *   input shape most of its traffic arrives in.
 *
 *   TWO GUARDS, AND THEY ANSWER DIFFERENT QUESTIONS. {@linkcode caseFoldKey} decides whether a pair differs
 *   by case AND NOTHING ELSE — it is what keeps punctuation, whitespace, transliteration and
 *   Unicode-normalization drift out of this law, since any of those move the key. {@linkcode
 *   caseApplicability} decides whether a case change of that kind is a SEMANTIC equivalent in the row's own
 *   locale, which the key cannot say: `İstanbul` and `ISTANBUL` have matching fold keys and are different
 *   words in Turkish. A pair that clears the first guard and fails the second is excluded BEFORE it runs, per
 *   this law's own tradeoff — an invalid transformation must never be tolerated as a failure, because a
 *   failure invites someone to fix the pipeline for an input that was never a case variant.
 *
 *   THE VARIANT IS DERIVED, NEVER AUTHORED. Every committed row's `variant` is exactly the named
 *   transformation applied to its `base`, and {@linkcode auditCaseFoldingSuite} re-derives it. A hand-typed
 *   variant is how a "case-folding" row quietly acquires a dropped accent, and the whole law then measures
 *   something else under its own name.
 */

import { resolvePackagePath } from "@mailwoman/core/module/resolvers"

import type { ConformanceFixture } from "#eval-harness/conformance/fixture"

/**
 * The law name every row in this suite carries.
 */
export const CASE_FOLDING_LAW = "case-folding-invariance"

/**
 * The three case transformations this law states, and the only three a committed row may use.
 *
 * - `upper` — the SHOUTING register: a pasted spreadsheet cell, a scanned form, a legacy mainframe export.
 * - `lower` — the mobile register, and the one the house treats as first-class rather than degraded.
 * - `mixed` — title case, the autocapitalize register: every token's first cased character capitalized, the rest folded
 *   down. Named `mixed` rather than `title` because what the law tests is a case pattern that is neither extreme, and
 *   title case is the reproducible member of that class a user actually produces.
 */
export const CASE_TRANSFORMATIONS = ["upper", "lower", "mixed"] as const

export type CaseTransformationName = (typeof CASE_TRANSFORMATIONS)[number]

/**
 * Title-case one token: the first cased character up, every later one down.
 *
 * Reads the first CASED character rather than index 0, so `%ARABICA` and `10th` capitalize the letter rather than
 * leaving the token untouched because it happens to start with punctuation or a digit.
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
 * The transformation each name applies. Pure, total, and the source the suite's variants are re-derived from.
 *
 * `mixed` splits on the whitespace RUNS themselves (the capturing split keeps them), so the transformation cannot
 * collapse or insert whitespace — which would take the pair out of this law and into the whitespace one.
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
 * The case-insensitive identity of a string — equal keys mean the two differ by case and by nothing else.
 *
 * Upper-then-lower rather than a bare `toLowerCase`, because a bare fold leaves `ß` distinct from `SS` and would then
 * report `Friedrichstraße` / `FRIEDRICHSTRASSE` as differing by more than case. Routing through uppercase first
 * performs the expansion Unicode's full case folding performs (`ß → ss`), and JavaScript's own final-sigma rule keeps
 * `ΟΔΟΣ` / `οδος` matching. There is no `String.prototype.caseFold`; this is the composition that stands in for it.
 */
export function caseFoldKey(text: string): string {
	return text.toUpperCase().toLowerCase()
}

/**
 * Which named transformation turns `base` into `variant`, or `null` when none does.
 *
 * Derived from the pair rather than stored on the fixture: a stored transformation name is a second copy of something
 * the two strings already say, and the copy is what goes stale. Only pairs that are genuinely case-only classify —
 * anything else answers `null`, and the audit reports it as a row that does not belong to this law.
 */
export function classifyCaseTransformation(base: string, variant: string): CaseTransformationName | null {
	if (base === variant || caseFoldKey(base) !== caseFoldKey(variant)) return null

	for (const name of CASE_TRANSFORMATIONS) {
		if (CASE_TRANSFORMATION_BY_NAME[name](base) === variant) return name
	}

	return null
}

/**
 * The declared reasons a case transformation is NOT a semantic equivalent for a given row.
 *
 * - `identity-transformation` — the transformation returns the text unchanged, either because the script has no case
 *   (Japanese, Chinese, Thai, Hebrew, Arabic) or because the text is already written in the target case (`N7 0BT`
 *   uppercased). Such a row is the IDENTITY law wearing a case-folding label: it would hold whatever the pipeline does
 *   with casing, and its holding would be counted as evidence that casing is handled.
 * - `locale-sensitive-casing` — the row's locale maps the cases of a letter differently from the root locale, so a
 *   root-locale transformation changes which letter is written. Turkish and Azeri separate dotted `i`/`İ` from dotless
 *   `ı`/`I`, and Lithuanian retains the dot on a lowercase `i`/`j` under an accent; Unicode records all three in
 *   `SpecialCasing.txt` as the only locale-conditional casing rules.
 */
export const CASE_APPLICABILITY_RULES = ["identity-transformation", "locale-sensitive-casing"] as const

export type CaseApplicabilityRule = (typeof CASE_APPLICABILITY_RULES)[number]

/**
 * Countries whose locale casts a letter's case differently from the root locale, with the characters that trigger it.
 *
 * Keyed by ISO-3166 alpha-2 because that is what a fixture's `context.caseCountry` carries. The trigger sets are the
 * letters `SpecialCasing.txt`'s conditional mappings act on; a text carrying none of them cases identically under both
 * locales and stays applicable.
 */
const LOCALE_SENSITIVE_CASING: Record<string, { characters: string; note: string }> = {
	TR: { characters: "iıIİ", note: "Turkish separates dotted i/İ from dotless ı/I" },
	AZ: { characters: "iıIİ", note: "Azeri separates dotted i/İ from dotless ı/I" },
	LT: { characters: "iįjIĮJ", note: "Lithuanian retains the dot on a lowercase i/j under an accent" },
}

/**
 * One applicability reading: whether the transformation may be stated as a law for this text, and why.
 *
 * The reason is populated on BOTH verdicts. An exclusion that says only "not applicable" makes the reader re-derive the
 * rule from the text, and a row silently dropped from a law suite is the absence this layer exists to refuse.
 */
export interface CaseApplicability {
	applicable: boolean
	/**
	 * The rule that excluded it. Absent when `applicable`.
	 */
	rule?: CaseApplicabilityRule
	reason: string
}

/**
 * May `transformation` be stated as a case-folding law over `text` in `country`?
 *
 * `country` is the row's own `context.caseCountry` — the same value that selects the weights overlay the row grades
 * through, so the locale the applicability rule reads and the locale the pipeline runs under are one value rather than
 * two that can disagree.
 *
 * The identity rule is tested FIRST, and a row both rules bear on reports that one: a transformation that moves nothing
 * cannot have changed a letter's identity either, so the reading that says the pair could never have tested anything is
 * the more useful of the two.
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
 * The committed suite.
 *
 * Anchored at the package root: `tsc` emits no `.jsonl` into `out/`, so the file is named from where the package starts
 * rather than from where this module runs.
 */
export const CASE_FOLDING_SUITE_PATH: string = resolvePackagePath(
	"mailwoman",
	"eval-harness",
	"conformance",
	"case-folding.jsonl"
)

/**
 * Everything that must be true of a case-folding row, checked without running anything.
 *
 * Returns one message per problem, each naming the fixture. Empty means the suite states this law and only this law —
 * which is the claim the DoD's fourth item makes, and the only form of it that is executable.
 *
 * The `caseCountry` requirement is not bookkeeping. A row graded with no country routes through the BASE en-US weights
 * package, which carries no pair index for the row's country, so its dependent locality silently never fires and a
 * case-folding violation is reported for an instrument that was never pointed at the row's locale.
 */
export function auditCaseFoldingSuite(fixtures: readonly ConformanceFixture[]): string[] {
	const problems: string[] = []

	for (const fixture of fixtures) {
		const label = `fixture "${fixture.id}"`

		if (fixture.law !== CASE_FOLDING_LAW) {
			problems.push(`${label}: law is "${fixture.law}", not "${CASE_FOLDING_LAW}"`)

			continue
		}

		if (fixture.expect !== "equivalent") {
			problems.push(
				`${label}: expects "${fixture.expect}" — a case-folding row states an INVARIANCE, so the only relation it can state is "equivalent"`
			)
		}

		if (!fixture.rowRef) {
			problems.push(
				`${label}: no rowRef — every base query is drawn from a committed row, so a row without one names no population`
			)
		}

		const country = fixture.context?.caseCountry

		if (!country) {
			problems.push(
				`${label}: no context.caseCountry — it selects the weights overlay the row grades through, and without it the row is graded base-only against a locale that is not its own`
			)
		}

		const transformation = classifyCaseTransformation(fixture.base, fixture.variant)

		if (!transformation) {
			problems.push(
				`${label}: variant is not a named case transformation of base — ` +
					(caseFoldKey(fixture.base) === caseFoldKey(fixture.variant)
						? `the pair differs by case but by no member of ${CASE_TRANSFORMATIONS.join(" / ")}, so the change is not reproducible from its own name`
						: `the pair differs by more than case (fold keys ${JSON.stringify(caseFoldKey(fixture.base))} ≠ ${JSON.stringify(caseFoldKey(fixture.variant))}), which is a different law`)
			)

			continue
		}

		const applicability = caseApplicability(fixture.base, transformation, country)

		if (!applicability.applicable) {
			problems.push(`${label}: ${applicability.rule} — ${applicability.reason}`)
		}
	}

	return problems
}

/**
 * The transformation label a report line carries, e.g. `upper`. `?` when the pair does not classify — which the audit
 * refuses, so it can only appear on a hand-built fixture that skipped the loader.
 */
export function describeCaseTransformation(fixture: ConformanceFixture): string {
	return classifyCaseTransformation(fixture.base, fixture.variant) ?? "?"
}
