/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The punctuation invariance law: dropping a comma, dropping an abbreviation point, appending a full stop,
 *   or swapping an apostrophe for its typographic twin must not change what the pipeline answered. Pure — no
 *   model, no I/O beyond reading the committed suite.
 *
 *   WHY IT IS A PRODUCT COMMITMENT. Punctuation is the part of an address a user supplies inconsistently and a
 *   tool rewrites behind their back. A phone keyboard emits a straight apostrophe, a word processor turns the
 *   same keystroke into `’`, a CSV export turns it back, a hand-typed line drops every comma, an address book
 *   writes `Str.` where a form writes `Str`, and a sentence-shaped paste ends in a full stop. All of them name
 *   the same building as the punctuated form a curator typed into the board, and Stage 1 exists to make them
 *   one string.
 *
 *   PUNCTUATION IS SOMETIMES FORMATTING AND SOMETIMES PART OF A NAME, so this law is deliberately narrow. Four
 *   marks, five named transformations, and three declared reasons a row may refuse an arm. What it will not do
 *   is claim invariance for every punctuation change a user could make: `COMER parís.méxico` carries a point
 *   inside its own name, and removing it writes a string nobody sends.
 *
 *   TWO GUARDS, ANSWERING DIFFERENT QUESTIONS. {@linkcode punctuationBlindKey} decides whether a pair differs
 *   by punctuation AND NOTHING ELSE: every letter, digit, mark and WHITESPACE character survives in order, so
 *   case, spacing and Unicode-normalization drift cannot enter this law wearing its name. That is also why no
 *   transformation here may rewrite whitespace — turning `Saint-Honoré` into `Saint Honoré` would be a spacing
 *   change carrying a punctuation label, and the key refuses it. {@linkcode punctuationApplicability} then
 *   decides whether the transformation had anything safe to act on in the row's own text and on the row's own
 *   comparator, which the key cannot say.
 *
 *   THE HYPHEN IS OUT OF THIS LAW, AND THE REASON IS THAT NO SAFE OPERATION EXISTS ON IT. Every hyphen the
 *   corpus carries is intra-token — `Bonneuil-sur-Marne`, `Stockton-on-Tees`, the house-number range `2-6`.
 *   Deleting it merges two tokens and replacing it with a space inserts a boundary, so one breaks token text
 *   and the other is a spacing change. A hyphen-to-`U+2010` swap is safe and inert: nothing a keyboard or a
 *   word processor emits produces that codepoint, so the row would measure a string nobody sends.
 *
 *   THE VARIANT IS DERIVED, NEVER AUTHORED. Every committed row's `variant` is exactly the named
 *   transformation applied to its `base`, and {@linkcode auditPunctuationSuite} re-derives it. A hand-typed
 *   variant is how a "punctuation" row quietly acquires a dropped accent, and the law then measures something
 *   else under its own name.
 */

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
 * The five punctuation transformations this law states, and the only five a committed row may use.
 *
 * - `comma-removed` — every separating comma deleted (`Portland, OR` → `Portland OR`). The headline register: a user who
 *   types an address as a phrase rather than as fields. The comma goes and the spacing stays, so the tokens keep their
 *   text and their order and only the field separator is gone.
 * - `period-removed` — every separating point deleted (`Neusser Str. 12` → `Neusser Str 12`). The abbreviation register,
 *   where one source writes `Str.` / `Jr.` / `Co.` and the next writes it bare.
 * - `terminal-period` — one full stop appended (`Portland, OR` → `Portland, OR.`). The sentence register, and the
 *   executable statement that Stage 1's trailing trim still takes the sentence punctuation a user appends.
 * - `apostrophe-typographic` — every `'` replaced by `’`: what a word processor does to a straight apostrophe.
 * - `apostrophe-ascii` — every `’` replaced by `'`: what a plain keyboard and a CSV export produce instead.
 *
 * The apostrophe pair is two names rather than one because the two are different registers reaching the pipeline from
 * different tools, and a lexicon holding one form and not the other regresses in one direction while the other holds.
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
 * What a transformation does to the marks it finds. It decides the reason an absent arm carries: a `removal` arm that
 * moved nothing may have found no mark at all or only marks inside tokens, a `replacement` one found no mark of its
 * source form, and a `boundary` one always moves something unless the text already ends in a full stop.
 */
export type PunctuationScope = "boundary" | "removal" | "replacement"

/**
 * Each transformation's scope, stated once so the applicability reading and the docstring cannot disagree about which
 * absence a missing arm reports.
 */
export const PUNCTUATION_TRANSFORMATION_SCOPE: Record<PunctuationTransformationName, PunctuationScope> = {
	"comma-removed": "removal",
	"period-removed": "removal",
	"terminal-period": "boundary",
	"apostrophe-typographic": "replacement",
	"apostrophe-ascii": "replacement",
}

/**
 * The mark each removal transformation takes. Absent for the other scopes, which act on a form rather than on a
 * removable separator.
 */
const REMOVED_MARK: Partial<Record<PunctuationTransformationName, string>> = {
	"comma-removed": ",",
	"period-removed": ".",
}

/**
 * The comparators that read the query's own text back out of the result.
 *
 * `parse_whole_strict` and `component_map` both grade component VALUES, and a component value is the span the parser
 * quoted from the query — so a transformation that rewrites a token rewrites the value with it, and the comparator
 * reports the transformation rather than anything the pipeline decided. `resolution_identity` reads namespaced place
 * ids and `assembled_coordinate` reads a coordinate; neither can carry a mark.
 */
const TEXT_ECHOING_COMPARATORS = new Set<OutcomeComparatorName>(["parse_whole_strict", "component_map"])

/**
 * The removal transformations whose mark belongs to a TOKEN rather than to the space between two.
 *
 * A point followed by whitespace terminates the word in front of it — there is no address convention in which a lone
 * point separates two fields — so the parser's own span carries it: 18 of the corpus's 1,502 expected component values
 * hold a point, `Neusser Str.` and `Co. Kerry` among them. A comma is the opposite: it separates fields and the
 * tokenizer drops it, so a removed comma leaves every span's text untouched. Four committed venue values do carry an
 * embedded comma, which is why {@linkcode punctuationApplicability} takes the row's own spans as well as this list.
 */
const TOKEN_TEXT_REMOVALS = new Set<PunctuationTransformationName>(["period-removed"])

/**
 * Delete every SEPARATING run of `mark` and leave the intra-token ones byte-identical.
 *
 * A run is separating when whitespace or the end of the query follows it, which is the decidable form of "this mark
 * sits at a token's edge". `parís.méxico` keeps its point, `and more...,` keeps its ellipsis, and `Str. 12` loses one.
 * Whitespace is never touched, so the pair stays inside this law rather than drifting into the spacing one.
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
 * The transformation each name applies. Pure, total, and the source the suite's variants are re-derived from.
 *
 * `terminal-period` is a no-op on a query that already ends in a full stop, which is what keeps a doubled `..` out of
 * the suite: the pair then states the identity law and the applicability reading refuses it by name.
 */
export const PUNCTUATION_TRANSFORMATION_BY_NAME: Record<PunctuationTransformationName, (text: string) => string> = {
	"comma-removed": (text) => removeSeparatingRuns(text, ","),
	"period-removed": (text) => removeSeparatingRuns(text, "."),
	"terminal-period": (text) => (text.endsWith(".") ? text : `${text}.`),
	"apostrophe-typographic": (text) => text.replaceAll("'", "’"),
	"apostrophe-ascii": (text) => text.replaceAll("’", "'"),
}

/**
 * The punctuation-blind identity of a string — equal keys mean the two differ by punctuation and by nothing else.
 *
 * Every letter, digit, combining mark and whitespace character survives in its original order, so this is the strongest
 * available statement of the scope rule: a punctuation transformation preserves token order, spacing and every
 * non-punctuation codepoint. `\p{P}` rather than the four marks the transformations act on, for the same reason the
 * spacing law's key takes all of `\s`: the key is a comparison surface, not a transformation, and a pair that swapped a
 * hyphen for a dash must still come out equal here so {@linkcode classifyPunctuationTransformation} can refuse it BY
 * NAME rather than by looking like a different law.
 */
export function punctuationBlindKey(text: string): string {
	return text.replaceAll(/\p{P}/gu, "")
}

/**
 * Which named transformation turns `base` into `variant`, or `null` when none does.
 *
 * Derived from the pair rather than stored on the fixture: a stored transformation name is a second copy of something
 * the two strings already say, and the copy is what goes stale.
 */
export function classifyPunctuationTransformation(base: string, variant: string): PunctuationTransformationName | null {
	if (base === variant || punctuationBlindKey(base) !== punctuationBlindKey(variant)) return null

	for (const name of PUNCTUATION_TRANSFORMATIONS) {
		if (PUNCTUATION_TRANSFORMATION_BY_NAME[name](base) === variant) return name
	}

	return null
}

/**
 * The declared reasons a punctuation transformation is NOT stateable over a given row.
 *
 * - `identity-transformation` — the transformation returns the text unchanged because the query holds nothing of the kind
 *   it acts on: no comma to drop, no straight apostrophe to curl, a query that already ends in a full stop. Such a row
 *   is the IDENTITY law wearing a punctuation label — it would hold whatever the pipeline does with punctuation.
 * - `mark-inside-token` — the query DOES carry the mark, and every occurrence sits inside a token (`COMER parís.méxico`,
 *   `and more...,`). Removing it would rewrite the token's text and change what the query names, which is the opt-out
 *   this law's narrowness exists for. Reported apart from the identity reading because "this query has no point" and
 *   "this query's point is part of a name" are different absences.
 * - `text-echoing-comparator` — the removal takes a mark that the parser quotes back inside a component value, and the
 *   row is graded on a comparator that reads those values. The comparator would then report the transformation itself,
 *   which reads as a pipeline defect and is nothing of the kind.
 */
export const PUNCTUATION_APPLICABILITY_RULES = [
	"identity-transformation",
	"mark-inside-token",
	"text-echoing-comparator",
] as const

export type PunctuationApplicabilityRule = (typeof PUNCTUATION_APPLICABILITY_RULES)[number]

/**
 * One applicability reading: whether the transformation may be stated as a law for this row, and why.
 *
 * The reason is populated on BOTH verdicts, for the same reason the two shipped laws populate it on both — a row
 * silently dropped from a law suite is the absence this layer exists to refuse.
 */
export interface PunctuationApplicability {
	applicable: boolean
	/**
	 * The rule that excluded it. Absent when `applicable`.
	 */
	rule?: PunctuationApplicabilityRule
	reason: string
}

/**
 * What the row grades on, beyond its text.
 */
export interface PunctuationApplicabilityContext {
	/**
	 * The row's own `outcomeComparator`. Absent skips the {@linkcode PUNCTUATION_APPLICABILITY_RULES}
	 * `text-echoing-comparator` reading, which is what the suite audit does: the audit knows the comparator but not the
	 * spans, so it applies the declared half of the rule and the suite test applies the corpus-grounded half.
	 */
	comparator?: OutcomeComparatorName
	/**
	 * The component values the committed row asserts, e.g. `["Gate 12, Terminal 2"]`. A removal whose mark appears in one
	 * of them rewrites that value on the variant side whatever the transformation's declared scope says.
	 */
	echoedSpans?: readonly string[]
}

/**
 * May `transformation` be stated as a punctuation law over `text`?
 *
 * The identity and inside-token rules are read FIRST, and a row several rules bear on reports the earliest: a
 * transformation that moves nothing could never have tested anything, and that reading is more useful than a statement
 * about the comparator it would have been graded on.
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
 * The committed suite.
 *
 * Anchored at the package root: `tsc` emits no `.jsonl` into `out/`, so the file is named from where the package starts
 * rather than from where this module runs.
 */
export const PUNCTUATION_SUITE_PATH: string = resolvePackagePath(
	"mailwoman",
	"lib",
	"eval-harness",
	"conformance",
	"punctuation.jsonl"
)

/**
 * Everything that must be true of a punctuation row, checked without running anything.
 *
 * Returns one message per problem, each naming the fixture. Empty means the suite states this law and only this law.
 *
 * The `caseCountry` requirement is not bookkeeping: a row graded with no country routes through the BASE en-US weights
 * package rather than its own overlay, so a punctuation violation would be reported for an instrument that was never
 * pointed at the row's locale.
 *
 * Applicability IS re-checked here, unlike the spacing law's audit, because two of this law's three rules can refuse a
 * pair that classifies perfectly well: a `period-removed` arm on a component comparator moves real text and is still
 * unstateable. Only the declared half runs — the audit reads a fixture, not the corpus — and the suite test supplies
 * the row's asserted spans for the other half.
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
						: `the pair differs by more than punctuation (blind keys ${JSON.stringify(punctuationBlindKey(fixture.base))} ≠ ${JSON.stringify(punctuationBlindKey(fixture.variant))}), which is a different law`)
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
 * The transformation label a report line carries, e.g. `comma-removed`. `?` when the pair does not classify — which the
 * audit refuses, so it can only appear on a hand-built fixture that skipped the loader.
 */
export function describePunctuationTransformation(fixture: ConformanceFixture): string {
	return classifyPunctuationTransformation(fixture.base, fixture.variant) ?? "?"
}
