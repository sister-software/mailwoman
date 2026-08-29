/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The canonical-form invariance law: a query that arrives DECOMPOSED must answer the same as the composed
 *   query it is canonically equivalent to. Pure — no model, no I/O beyond reading the committed suite.
 *
 *   WHY IT IS A PRODUCT COMMITMENT. `é` has two spellings the Unicode standard declares equal: one code point
 *   (`U+00E9`) and two (`e` + `U+0301`). Which one reaches the pipeline is decided by the tool that produced
 *   the text, never by the person who typed it. A macOS filesystem API hands back decomposed text, a Korean
 *   or Vietnamese input method can emit either, a form post carries whatever the browser was given, and most
 *   databases and the web platform emit composed. `Köln` and `Köln` are the same city and different bytes,
 *   and a pipeline that resolves one and not the other has failed an input its own users cannot see.
 *
 *   CANONICAL, NOT COMPATIBILITY. {@linkcode canonicalFormKey} is `NFD`, which is UAX #15's own definition of
 *   canonical equivalence: two strings are canonically equivalent exactly when their decompositions match. So
 *   the key refuses, by construction, every relation this law is not — `ﬁ` against `fi` and `Ⅻ` against `XII`
 *   are COMPATIBILITY pairs and move the key, an accent removed moves the key, and a case change moves it too.
 *   Those are other laws or no law at all, and none of them can enter this one wearing its name.
 *
 *   THE CORPUS STATES ONE DIRECTION. Every committed board row is already written in NFC — 83 of 651 rows
 *   carry a canonically variant code point at all, and all 83 of those are composed — so the decompose arm is
 *   stateable everywhere and the compose arm nowhere. That is reported rather than inferred: the register's
 *   coverage line prints transformed rows over eligible rows on every run, because a suite that states one
 *   arm and declares two would otherwise imply a breadth it never exercised.
 *
 *   THE VARIANT IS DERIVED, NEVER AUTHORED. Every committed row's `variant` is exactly the named
 *   transformation applied to its `base`, and {@linkcode auditCanonicalFormSuite} re-derives it. A hand-typed
 *   variant is how a canonical-form row quietly acquires a dropped accent, and the law then measures
 *   something else under its own name.
 *
 *   STAGE 1 OWNS THIS, WHICH IS THE REASON TO MEASURE IT AND NOT THE REASON TO SKIP IT. `@mailwoman/normalize`
 *   composes to NFC before anything downstream sees the text, so both forms should converge before the
 *   tokenizer runs. "Should converge" is a claim about code; a divergence here is that claim failing, and the
 *   first place to look is whichever stage received the two forms still distinct.
 */

import { existsSync } from "@mailwoman/platform/fs"
import { fileURLToPath } from "@mailwoman/platform/url"

import type { ConformanceFixture } from "./fixture.ts"

/**
 * The law name every row in this suite carries.
 */
export const CANONICAL_FORM_LAW = "canonical-form-invariance"

/**
 * The two canonical normalization forms this law states, and the only two a committed row may name.
 *
 * - `nfd` — canonical DECOMPOSITION: every composed character split into its base plus its combining marks, and every
 *   Hangul syllable split into jamo. The register a macOS filesystem API, some input methods and some text pipelines
 *   produce.
 * - `nfc` — canonical COMPOSITION: the inverse, and the form the web platform, most databases and this pipeline's own
 *   Stage 1 emit.
 *
 * Compatibility normalization (`NFKC` / `NFKD`) is deliberately absent. It rewrites characters that are not canonically
 * equal — `ﬁ` to `fi`, `Ⅻ` to `XII`, a full-width digit to an ASCII one — so a pair related by it is not a pair this
 * law can state, and {@linkcode canonicalFormKey} refuses it.
 */
export const CANONICAL_FORMS = ["nfd", "nfc"] as const

export type CanonicalFormName = (typeof CANONICAL_FORMS)[number]

/**
 * The transformation each name applies. Pure, total, and the source the suite's variants are re-derived from.
 */
export const CANONICAL_TRANSFORMATION_BY_NAME: Record<CanonicalFormName, (text: string) => string> = {
	nfd: (text) => text.normalize("NFD"),
	nfc: (text) => text.normalize("NFC"),
}

/**
 * The canonical identity of a string — equal keys mean the two are canonically equivalent, which is the whole of what
 * this law claims about a pair.
 *
 * `NFD` rather than `NFC` because UAX #15 defines canonical equivalence on the decomposition, and the two agree on the
 * question anyway: what matters is that the key is a canonical form, so a compatibility difference, a removed accent, a
 * case change and a spacing change all move it.
 */
export function canonicalFormKey(text: string): string {
	return text.normalize("NFD")
}

/**
 * Does this text hold anything a canonical transformation can act on?
 *
 * True exactly when the two forms differ, which is the eligibility rule the whole law rests on: a query of ASCII, or of
 * a script with no composed characters, is byte-identical under both forms and can state nothing.
 */
export function canonicallyVariant(text: string): boolean {
	return text.normalize("NFC") !== text.normalize("NFD")
}

/**
 * The three states a query's own text can be in with respect to the canonical forms.
 *
 * `mixed` is a real state and not a bookkeeping leftover: a string assembled from two sources can carry a composed `é`
 * beside a decomposed one, and it is then neither form while being canonically equivalent to both. A text that is not
 * {@linkcode canonicallyVariant} reads `nfc`, because it is — both forms are the same bytes.
 */
export const CANONICAL_FORM_STATES = ["nfc", "nfd", "mixed"] as const

export type CanonicalFormState = (typeof CANONICAL_FORM_STATES)[number]

/**
 * Which form `text` is already written in.
 */
export function canonicalFormState(text: string): CanonicalFormState {
	if (text === text.normalize("NFC")) return "nfc"

	if (text === text.normalize("NFD")) return "nfd"

	return "mixed"
}

/**
 * Which named transformation turns `base` into `variant`, or `null` when none does.
 *
 * Derived from the pair rather than stored on the fixture: a stored transformation name is a second copy of something
 * the two strings already say, and the copy is what goes stale.
 */
export function classifyCanonicalTransformation(base: string, variant: string): CanonicalFormName | null {
	if (base === variant || canonicalFormKey(base) !== canonicalFormKey(variant)) return null

	for (const name of CANONICAL_FORMS) {
		if (CANONICAL_TRANSFORMATION_BY_NAME[name](base) === variant) return name
	}

	return null
}

/**
 * The declared reasons a canonical transformation is NOT stateable over a given row.
 *
 * - `no-canonical-variance` — the query's two canonical forms are the same bytes, so neither arm moves anything. Plain
 *   ASCII, and every script whose characters carry no canonical decomposition, land here. Such a row is the IDENTITY
 *   law wearing a canonical-form label, and its holding would be counted as evidence that the forms are handled.
 * - `already-in-target-form` — the query IS canonically variant, and it is already written in the form this arm composes
 *   or decomposes toward, so this arm alone is the identity while its sibling states the law. Reported apart from the
 *   first reading because "this query has nothing to decompose" and "this query is already decomposed" are different
 *   absences, and the second one says which direction the row DOES state.
 */
export const CANONICAL_APPLICABILITY_RULES = ["no-canonical-variance", "already-in-target-form"] as const

export type CanonicalApplicabilityRule = (typeof CANONICAL_APPLICABILITY_RULES)[number]

/**
 * One applicability reading: whether the transformation may be stated as a law for this text, and why.
 *
 * The reason is populated on BOTH verdicts, for the same reason the three shipped laws populate it on both — a row
 * silently dropped from a law suite is the absence this layer exists to refuse.
 */
export interface CanonicalApplicability {
	applicable: boolean
	/**
	 * The rule that excluded it. Absent when `applicable`.
	 */
	rule?: CanonicalApplicabilityRule
	reason: string
}

/**
 * May `form` be stated as a canonical-form law over `text`?
 *
 * The variance rule is read FIRST: a text with no canonical variance could never have stated either arm, and that
 * reading is more useful than one naming the direction it is already in.
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
 * The committed suite.
 *
 * `new URL`-relative with a compiled-tree fallback: `tsc` emits no `.jsonl` into `out/`, so a compiled caller reads the
 * source-tree copy. Same bridge as `gauntlet/cases/load.ts`'s `CASES_DIR`.
 */
export const NFC_NFD_SUITE_PATH = ((): string => {
	const sibling = fileURLToPath(new URL("nfc-nfd.jsonl", import.meta.url))

	if (existsSync(sibling)) return sibling

	return fileURLToPath(new URL("../../../eval-harness/conformance/nfc-nfd.jsonl", import.meta.url))
})()

/**
 * How much of the population this law actually transformed.
 *
 * Every field is a count of COMMITTED ROWS rather than of law arms, because the question the tradeoff asks is how much
 * of the corpus the suite reached, and a row carrying two arms would otherwise read as twice the coverage.
 */
export interface CanonicalFormCoverage {
	/**
	 * Committed board rows read.
	 */
	read: number
	/**
	 * Of those, rows whose text is canonically variant — the only rows this law can be stated over at all.
	 */
	eligible: number
	/**
	 * Of the eligible rows, how many this suite states a byte-distinct arm over.
	 *
	 * Counted by the COMMITTED ROW a fixture names, which is what makes the ratio a ratio: the denominator counts rows,
	 * two rows can carry the same query text, and one row can carry several arms. Keying on the text would report the
	 * first pair as one and keying on the fixture would report the second as several.
	 */
	transformed: number
	/**
	 * The eligible rows counted by the form they are ALREADY written in. This is the number that says which arms the
	 * corpus can state: a population that is entirely NFC can state the decompose arm and nothing else.
	 */
	eligibleByState: Record<CanonicalFormState, number>
}

/**
 * Measure this suite against the population it draws from.
 *
 * `corpusInputs` is every committed board row's query text; the caller supplies it rather than this module loading the
 * corpus, so the law module stays free of the corpus loader and a caller can measure the suite against any population
 * it can name.
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

	// A fixture with no `rowRef` names no row, so it is keyed by its own text. The audit refuses such a row, which
	// leaves this reachable only from a hand-built fixture that skipped the loader.
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
 * The coverage line a report prints — the DoD's transformed-over-eligible ratio, with the denominator's own breakdown
 * beside it so a reader can see which arms the population is able to state.
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
 * Everything that must be true of a canonical-form row, checked without running anything.
 *
 * Returns one message per problem, each naming the fixture. Empty means the suite states this law and only this law.
 *
 * The `caseCountry` requirement is not bookkeeping: a row graded with no country routes through the BASE en-US weights
 * package rather than its own overlay, so a canonical-form violation would be reported for an instrument that was never
 * pointed at the row's locale.
 *
 * Applicability is NOT re-checked here, unlike the punctuation law's audit, because both of this law's rules are
 * subsumed by the classification: a pair that classifies at all has a base its own transformation moved, so neither
 * rule can fire on a classified pair. The rules do their work in the absent-arm reading, which asks about arms the
 * suite does NOT carry — a question no audit over the committed rows can pose.
 */
export function auditCanonicalFormSuite(fixtures: readonly ConformanceFixture[]): string[] {
	const problems: string[] = []

	for (const fixture of fixtures) {
		const label = `fixture "${fixture.id}"`

		if (fixture.law !== CANONICAL_FORM_LAW) {
			problems.push(`${label}: law is "${fixture.law}", not "${CANONICAL_FORM_LAW}"`)

			continue
		}

		if (fixture.expect !== "equivalent") {
			problems.push(
				`${label}: expects "${fixture.expect}" — a canonical-form row states an INVARIANCE, so the only relation it can state is "equivalent"`
			)
		}

		if (!fixture.rowRef) {
			problems.push(
				`${label}: no rowRef — every base query is drawn from a committed row, so a row without one names no population`
			)
		}

		if (!fixture.context?.caseCountry) {
			problems.push(
				`${label}: no context.caseCountry — it selects the weights overlay the row grades through, and without it the row is graded base-only against a locale that is not its own`
			)
		}

		if (!classifyCanonicalTransformation(fixture.base, fixture.variant)) {
			problems.push(
				`${label}: variant is not a named canonical transformation of base — ` +
					(canonicalFormKey(fixture.base) === canonicalFormKey(fixture.variant)
						? `the pair is canonically equivalent but is neither of ${CANONICAL_FORMS.join(" / ")}, so the change is not reproducible from its own name`
						: `the pair is NOT canonically equivalent (decompositions ${JSON.stringify(canonicalFormKey(fixture.base))} ≠ ${JSON.stringify(canonicalFormKey(fixture.variant))}) — a compatibility rewrite, a removed accent or a case change is a different law`)
			)
		}
	}

	return problems
}

/**
 * The transformation label a report line carries, e.g. `nfd`. `?` when the pair does not classify — which the audit
 * refuses, so it can only appear on a hand-built fixture that skipped the loader.
 */
export function describeCanonicalTransformation(fixture: ConformanceFixture): string {
	return classifyCanonicalTransformation(fixture.base, fixture.variant) ?? "?"
}
