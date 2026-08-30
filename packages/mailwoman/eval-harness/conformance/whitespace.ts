/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The whitespace invariance law: changing only the SPACING of a query must not change what the pipeline
 *   answered. Pure — no model, no I/O beyond reading the committed suite.
 *
 *   WHY IT IS A PRODUCT COMMITMENT. Spacing is the part of an address a user never controls. A pasted
 *   spreadsheet cell arrives with a leading and a trailing space, a form field that concatenated two columns
 *   arrives with a doubled one, a tab-separated export arrives with a tab where the space should be, and a
 *   hand-typed line arrives with the comma tight against the next word. All of them name the same building
 *   as the evenly-spaced form a curator typed into the board, and Stage 1 exists to make them one string.
 *
 *   THE LAW IS STATED OVER THE PIPELINE, NOT OVER {@link "@mailwoman/normalize"}. `collapseWhitespace` folding
 *   a run to one ASCII space is a unit fact about one module; that the ANSWER does not move is a fact about
 *   the whole path, and only the second one is what a caller relies on. A row here therefore grades on the
 *   axis its own committed board row is graded on — the entity, the coordinate, or the parse — and never on
 *   the normalized string.
 *
 *   TWO GUARDS, ANSWERING DIFFERENT QUESTIONS. {@linkcode whitespaceBlindKey} decides whether a pair differs
 *   by whitespace AND NOTHING ELSE: equal keys mean every non-whitespace character survived, in order, so
 *   case, punctuation, transliteration and Unicode-normalization drift cannot enter this law wearing its
 *   name. {@linkcode whitespaceApplicability} then decides whether the transformation had anything to act on
 *   in the row's own text, which the key cannot say.
 *
 *   NEWLINE IS OUT OF THIS LAW, AND THE REASON IS MECHANICAL. `collapseWhitespace` folds `[ \t]` runs to one
 *   ASCII space and PRESERVES `\n`/`\r`, because `@mailwoman/query-shape`'s segmentation grammar reads a
 *   newline as a segment separator on a par with a comma. Swapping a space for a newline therefore
 *   re-segments the query on purpose; it is a claim about the segmentation grammar, not about spacing. A tab
 *   is the opposite case and belongs here twice over: the same grammar treats a RAW tab as a separator too,
 *   and the collapse is what stops one from reaching it — so the `tabbed` arm is the executable statement
 *   that the collapse still shields that grammar.
 *
 *   A SPACE INSIDE A STRUCTURED IDENTIFIER IS NOT SPACING. `SW1A 2AA` is one code whose format grammar puts a
 *   space in the middle; doubling it or turning it into a tab writes a string outside that grammar, and
 *   recognizing it is not an invariance this law may demand. The run-level transformations therefore skip
 *   those runs — detected through {@link "@mailwoman/codex"}'s own postcode shapes, never a local pattern —
 *   and a query whose ONLY run is structural reports {@linkcode WHITESPACE_APPLICABILITY_RULES}'s
 *   `structural-identifier-space` rather than the identity reading, because "this query has no spacing" and
 *   "this query's spacing is required" are different absences.
 *
 *   THE VARIANT IS DERIVED, NEVER AUTHORED. Every committed row's `variant` is exactly the named
 *   transformation applied to its `base`, and {@linkcode auditWhitespaceSuite} re-derives it. A hand-typed
 *   variant is how a "whitespace" row quietly acquires a dropped comma, and the law then measures something
 *   else under its own name.
 */

import { candidateSystemsForPostcode, UNIT_GRADE_POSTCODE } from "@mailwoman/codex"
import { pathExists } from "@mailwoman/core/fs/readers"
import { fileURLToPath } from "@mailwoman/platform/url"

import type { ConformanceFixture } from "./fixture.ts"

/**
 * The law name every row in this suite carries.
 */
export const WHITESPACE_LAW = "whitespace-invariance"

/**
 * The six whitespace transformations this law states, and the only six a committed row may use.
 *
 * - `leading` / `trailing` — the pasted-cell registers: one ASCII space bolted onto an end. Separate names because Stage
 *   1 reaches them through separate code — the leading trim takes whitespace only, the trailing trim takes whitespace
 *   AND the sentence punctuation a user appends — so one can regress without the other.
 * - `repeated` — every safe internal run doubled: the concatenated-column register.
 * - `tabbed` — every safe internal run replaced by one tab: the TSV-export register, and the arm that states the collapse
 *   still shields the segmentation grammar (see the module docstring).
 * - `separator-tightened` — the whitespace after each comma deleted (`Portland, OR` → `Portland,OR`). The comma survives,
 *   so the fields stay separated and the token order is untouched.
 * - `separator-loosened` — one space inserted before each comma (`Portland, OR` → `Portland , OR`).
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
 * What a transformation acts ON. It decides the reason an absent arm carries: a `separator` transformation that moved
 * nothing found no comma, a `run` one found no safe run, and a `boundary` one always moves something.
 */
export type WhitespaceScope = "boundary" | "run" | "separator"

/**
 * Each transformation's scope, stated once so the applicability reading and the docstring cannot disagree about which
 * absence a missing arm reports.
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
 * Split `text` into alternating tokens and whitespace runs — even indices are tokens, odd indices the runs between
 * them. The capturing split is what lets a run-level transformation rewrite one run and leave every other byte alone.
 */
function splitOnWhitespaceRuns(text: string): string[] {
	return text.split(/(\s+)/)
}

/**
 * Is `candidate` a postcode under some address system's own shape?
 *
 * Both instruments are codex's, and using two is not belt-and-braces: `candidateSystemsForPostcode` asks the eight
 * systems that have a codex slice, and `UNIT_GRADE_POSTCODE` carries the NL PC6 and CA urban LDU shapes, neither of
 * which has one. A local regex here would be the third copy of a shape the codex already owns.
 */
function isPostcodeShape(candidate: string): boolean {
	if (candidateSystemsForPostcode(candidate).length) return true

	return UNIT_GRADE_POSTCODE.some((pattern) => pattern.test(candidate))
}

/**
 * The indices — into {@linkcode splitOnWhitespaceRuns}'s parts — of the whitespace runs that sit INSIDE a structured
 * identifier, i.e. whose two flanking tokens together read as one postcode.
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
 * The structured identifiers whose internal space `text` carries, e.g. `["SW1A 2AA"]`.
 *
 * Named rather than counted, because an exclusion that says only "the spacing is structural" makes the reader re-derive
 * which span it meant from a query that may hold several.
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
 * Rewrite every SAFE whitespace run and leave the structural ones byte-identical.
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
 * The transformation each name applies. Pure, total, and the source the suite's variants are re-derived from.
 *
 * The separator pair matches `[ \t]` rather than `\s`, the same class `collapseWhitespace` folds: a run holding a
 * newline is segmentation, and moving it would take the pair out of this law.
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
 * The whitespace-blind identity of a string — equal keys mean the two differ by whitespace and by nothing else.
 *
 * Every non-whitespace character survives, in its original order, so this is the strongest available statement of the
 * scope rule: a whitespace transformation preserves token content AND token order. `\s` rather than `[ \t]` on purpose
 * — the key is a comparison surface, not a transformation, and a pair that swapped a space for a newline must still
 * come out equal here so {@linkcode classifyWhitespaceTransformation} can refuse it by name.
 */
export function whitespaceBlindKey(text: string): string {
	return text.replaceAll(/\s+/gu, "")
}

/**
 * Which named transformation turns `base` into `variant`, or `null` when none does.
 *
 * Derived from the pair rather than stored on the fixture: a stored transformation name is a second copy of something
 * the two strings already say, and the copy is what goes stale.
 */
export function classifyWhitespaceTransformation(base: string, variant: string): WhitespaceTransformationName | null {
	if (base === variant || whitespaceBlindKey(base) !== whitespaceBlindKey(variant)) return null

	for (const name of WHITESPACE_TRANSFORMATIONS) {
		if (WHITESPACE_TRANSFORMATION_BY_NAME[name](base) === variant) return name
	}

	return null
}

/**
 * The declared reasons a whitespace transformation is NOT stateable over a given row.
 *
 * - `identity-transformation` — the transformation returns the text unchanged because the query holds nothing of the kind
 *   it acts on: no comma for a separator transformation, no whitespace at all for a run one. Such a row is the IDENTITY
 *   law wearing a whitespace label — it would hold whatever the pipeline does with spacing.
 * - `structural-identifier-space` — the query's every whitespace run sits inside a structured identifier whose format
 *   grammar fixes it (`N7 0BT`), so a run transformation has no safe run to act on. Reported apart from the identity
 *   reading because the two absences say different things, and the difference is the one this law's tradeoff turns on.
 */
export const WHITESPACE_APPLICABILITY_RULES = ["identity-transformation", "structural-identifier-space"] as const

export type WhitespaceApplicabilityRule = (typeof WHITESPACE_APPLICABILITY_RULES)[number]

/**
 * One applicability reading: whether the transformation may be stated as a law for this text, and why.
 *
 * The reason is populated on BOTH verdicts, for the same reason the case-folding law populates it on both — a row
 * silently dropped from a law suite is the absence this layer exists to refuse.
 */
export interface WhitespaceApplicability {
	applicable: boolean
	/**
	 * The rule that excluded it. Absent when `applicable`.
	 */
	rule?: WhitespaceApplicabilityRule
	reason: string
}

/**
 * May `transformation` be stated as a whitespace law over `text`?
 *
 * Reads the TEXT and nothing else. Unlike case folding, no locale can make a space mean a different space: what makes a
 * space required here is the identifier it sits inside, which the text carries with it whatever country the row routes
 * through.
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
 * The committed suite.
 *
 * `new URL`-relative with a compiled-tree fallback: `tsc` emits no `.jsonl` into `out/`, so a compiled caller reads the
 * source-tree copy. Same bridge as `gauntlet/cases/load.ts`'s `CASES_DIR`.
 */
export const WHITESPACE_SUITE_PATH: string = await (async (): Promise<string> => {
	const sibling = fileURLToPath(new URL("whitespace.jsonl", import.meta.url))

	if (await pathExists(sibling)) return sibling

	return fileURLToPath(new URL("../../../eval-harness/conformance/whitespace.jsonl", import.meta.url))
})()

/**
 * Everything that must be true of a whitespace row, checked without running anything.
 *
 * Returns one message per problem, each naming the fixture. Empty means the suite states this law and only this law.
 *
 * The `caseCountry` requirement is not bookkeeping: a row graded with no country routes through the BASE en-US weights
 * package rather than its own overlay, so a whitespace violation would be reported for an instrument that was never
 * pointed at the row's locale.
 *
 * {@linkcode whitespaceApplicability} is deliberately NOT re-checked here, and the case-folding audit's parallel check
 * is not an oversight in this one. A pair classifies only when its transformation MOVED something, which is the whole
 * of what applicability asks of a whitespace transformation, so an inapplicable row cannot reach this function — it
 * fails classification first, naming the transformation set. The rules are required one layer out, where the suite's
 * COMPLETENESS test reads them: an arm absent from a committed row must name the rule that refuses it.
 */
export function auditWhitespaceSuite(fixtures: readonly ConformanceFixture[]): string[] {
	const problems: string[] = []

	for (const fixture of fixtures) {
		const label = `fixture "${fixture.id}"`

		if (fixture.law !== WHITESPACE_LAW) {
			problems.push(`${label}: law is "${fixture.law}", not "${WHITESPACE_LAW}"`)

			continue
		}

		if (fixture.expect !== "equivalent") {
			problems.push(
				`${label}: expects "${fixture.expect}" — a whitespace row states an INVARIANCE, so the only relation it can state is "equivalent"`
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

		if (!classifyWhitespaceTransformation(fixture.base, fixture.variant)) {
			problems.push(
				`${label}: variant is not a named whitespace transformation of base — ` +
					(whitespaceBlindKey(fixture.base) === whitespaceBlindKey(fixture.variant)
						? `the pair differs by whitespace but by no member of ${WHITESPACE_TRANSFORMATIONS.join(" / ")}, so the change is not reproducible from its own name`
						: `the pair differs by more than whitespace (blind keys ${JSON.stringify(whitespaceBlindKey(fixture.base))} ≠ ${JSON.stringify(whitespaceBlindKey(fixture.variant))}), which is a different law`)
			)
		}
	}

	return problems
}

/**
 * The transformation label a report line carries, e.g. `tabbed`. `?` when the pair does not classify — which the audit
 * refuses, so it can only appear on a hand-built fixture that skipped the loader.
 */
export function describeWhitespaceTransformation(fixture: ConformanceFixture): string {
	return classifyWhitespaceTransformation(fixture.base, fixture.variant) ?? "?"
}
