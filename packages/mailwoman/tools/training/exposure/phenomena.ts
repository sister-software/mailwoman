/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Address phenomena measured over corpus rows: unary predicates over one row, relational ones over a pair.
 *
 *   The phenomenon ids are the `ConventionClaimID` values of `@mailwoman/codex/address/convention-claims`. That
 *   module records what a published layout states. This one records what a corpus row contains. The two share ids
 *   so a report can place them side by side.
 *
 *   A row is a list of `(tag, start, end)` spans over its `raw` text. A built corpus row holds those spans
 *   (`span_starts`, `span_ends`, `span_tags`). A canonical adapter row holds a component map instead, and
 *   {@linkcode spansFromComponents} locates each value in `raw`.
 *
 *   Every unary predicate returns `null` when the row does not hold the components the phenomenon is about, and a
 *   short string naming the form the row exercises when it does. A caller counts each form.
 *
 *   Offsets index the row's code points, as the Python predicates indexed a `str`. Case folding and script names
 *   follow CPython 3.12's Unicode tables through the `mtf-node` addon, because the folded text decides where a
 *   component is found.
 */

import { CLAIM_ARITY, ClaimArity, ConventionClaimID, reorderedPairs } from "@mailwoman/codex/address/convention-claims"
import { pythonRepr } from "@mailwoman/corpus/training/config/python-yaml"
import type { PythonText } from "@mailwoman/mtf/tools/sampler/native"

/**
 * Every phenomenon id, in `ConventionClaimID` order.
 */
export const PHENOMENON_IDS: readonly ConventionClaimID[] = Object.values(ConventionClaimID)

/**
 * Whether a phenomenon is read off one row or a pair of rows.
 */
export const ARITY: Readonly<Record<string, string>> = CLAIM_ARITY

/**
 * Premise-subdivision components across every registered label set.
 *
 * JP `block`, `sub_block` and `building_number` are parts of a house number (rule D4), not subdivisions.
 */
export const PREMISE_SUBDIVISION_TAGS: ReadonlySet<string> = new Set([
	"unit",
	"unit_designator",
	"level_designator",
	"level_id",
	"building_designator",
	"building_id",
	"entrance",
	"staircase",
])

/**
 * Components smaller than a region, for the `largest-unit-first` comparison.
 */
export const SMALLER_THAN_REGION: ReadonlySet<string> = new Set([
	"locality",
	"dependent_locality",
	"street",
	"house_number",
	"municipality",
	"district",
	"locality_unit",
])

/**
 * The controlled planning vocabulary the decoder-exposure handoff (2026-10-03) names.
 *
 * The report keeps which term matched, so a count can be split by term.
 */
export const PLANNING_TERMS = ["sector", "block", "phase"] as const

/**
 * A planning term as a whole word, case-insensitive.
 *
 * A word character is a letter, a number or the underscore, as `\w` reads a Python `str`.
 */
const PLANNING = new RegExp(`(?<![\\p{L}\\p{N}_])(${PLANNING_TERMS.join("|")})(?![\\p{L}\\p{N}_])`, "iu")

/**
 * One labeled span, in code points of the row's text.
 */
export interface Span {
	tag: string
	start: number
	end: number
}

/**
 * One address row as the predicates read it.
 */
export class Row {
	readonly raw: string
	readonly country: string
	readonly spans: readonly Span[]
	readonly #codePoints: string[]

	constructor(raw: string, country: string, spans: readonly Span[]) {
		this.raw = raw
		this.country = country
		this.spans = spans
		this.#codePoints = Array.from(raw)
	}

	first(tag: string): Span | null {
		return this.spans.find((span) => span.tag === tag) ?? null
	}

	has(tag: string): boolean {
		return this.spans.some((span) => span.tag === tag)
	}

	text(span: Span): string {
		return this.#codePoints.slice(span.start, span.end).join("")
	}
}

/**
 * A component value that does not occur in the row's raw text.
 */
export class LocateError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "LocateError"
	}
}

function indexOfCodePoints(haystack: readonly string[], needle: readonly string[], from: number): number {
	for (let at = from; at + needle.length <= haystack.length; at++) {
		if (needle.every((point, i) => haystack[at + i] === point)) return at
	}

	return -1
}

function byStart(spans: Span[]): Span[] {
	return spans.toSorted((a, b) => a.start - b.start)
}

/**
 * Locates each component value in `raw`, case-folded, without reusing a located range.
 *
 * @throws {LocateError} When a value does not occur.
 * The caller reports such a row as unreadable rather than measuring it as carrying fewer components.
 */
export function spansFromComponents(
	text: PythonText,
	raw: string,
	components: Readonly<Record<string, string>>
): Span[] {
	const folded = Array.from(text.casefold(raw))
	const taken: Array<[number, number]> = []
	const spans: Span[] = []

	for (const [tag, value] of Object.entries(components)) {
		const needle = Array.from(text.casefold(value))

		if (!needle.length) continue

		const overlaps = (at: number) => taken.some(([start, end]) => at < end && at + needle.length > start)
		let at = indexOfCodePoints(folded, needle, 0)

		while (at !== -1 && overlaps(at)) {
			at = indexOfCodePoints(folded, needle, at + 1)
		}

		if (at === -1) {
			throw new LocateError(`component ${tag}=${pythonRepr(value)} does not occur in ${pythonRepr(raw)}`)
		}

		taken.push([at, at + needle.length])
		spans.push({ tag, start: at, end: at + needle.length })
	}

	return byStart(spans)
}

/**
 * A row from a corpus row's span triple.
 *
 * @throws When the three lists differ in length.
 */
export function rowFromSpans(
	raw: string,
	country: string,
	starts: readonly number[],
	ends: readonly number[],
	tags: readonly string[]
): Row {
	if (starts.length !== ends.length || starts.length !== tags.length) {
		throw new Error(
			`span triple of ${raw} differs in length: ${starts.length} starts, ${ends.length} ends, ${tags.length} tags`
		)
	}

	return new Row(raw, country, byStart(starts.map((start, i) => ({ tag: tags[i]!, start, end: ends[i]! }))))
}

function order(row: Row, earlier: string, later: string): string | null {
	const a = row.first(earlier)
	const b = row.first(later)

	if (!a || !b) return null

	return a.start < b.start ? "before" : "after"
}

/**
 * `before` or `after`: where the first postcode span sits relative to the first locality span.
 */
export function postcodePrecedesLocality(row: Row): string | null {
	return order(row, "postcode", "locality")
}

/**
 * `before` or `after`: where the first house-number span sits relative to the first street span.
 */
export function houseNumberPrecedesStreet(row: Row): string | null {
	return order(row, "house_number", "street")
}

/**
 * `region-first` when the first region span starts before every smaller component, else `region-later`.
 *
 * `prefecture` counts as a region, since SCHEMA.mdx defines it as the JP first-level unit.
 */
export function largestUnitFirst(row: Row): string | null {
	const region = row.first("region") ?? row.first("prefecture")
	const smaller = row.spans.filter((span) => SMALLER_THAN_REGION.has(span.tag)).map((span) => span.start)

	if (!region || !smaller.length) return null

	return region.start < Math.min(...smaller) ? "region-first" : "region-later"
}

/**
 * `streetless` when a house number is present, a street absent, and a locality
 * or dependent locality present.
 */
export function streetlessPremiseIdentity(row: Row): string | null {
	if (!row.has("house_number") || row.has("street")) return null

	return row.has("locality") || row.has("dependent_locality") ? "streetless" : null
}

/**
 * The sorted, `+`-joined subdivision tags the row holds, such as `unit` or `entrance+unit`.
 */
export function premiseSubdivisionPresent(row: Row): string | null {
	const present = [...new Set(row.spans.map((span) => span.tag).filter((tag) => PREMISE_SUBDIVISION_TAGS.has(tag)))]

	return present.length ? present.toSorted().join("+") : null
}

/**
 * `<n>-digit` when the first postcode span is a run of ASCII digits, after removing spaces.
 */
export function fixedWidthNumericPostcode(row: Row): string | null {
	const span = row.first("postcode")

	if (!span) return null

	const text = row.text(span).replaceAll(" ", "")

	return /^[0-9]+$/.test(text) ? `${text.length}-digit` : null
}

/**
 * The lowercased planning term inside the first locality or dependent-locality span that holds one.
 */
export function planningWordNamesLocality(row: Row): string | null {
	for (const span of row.spans) {
		if (span.tag !== "locality" && span.tag !== "dependent_locality") continue

		const match = PLANNING.exec(row.text(span))

		if (match) return match[1]!.toLowerCase()
	}

	return null
}

/**
 * The unary predicates, by phenomenon, in the order a row's phenomena are listed.
 */
export const UNARY_PREDICATES: ReadonlyArray<[ConventionClaimID, (row: Row) => string | null]> = [
	[ConventionClaimID.PostcodePrecedesLocality, postcodePrecedesLocality],
	[ConventionClaimID.HouseNumberPrecedesStreet, houseNumberPrecedesStreet],
	[ConventionClaimID.LargestUnitFirst, largestUnitFirst],
	[ConventionClaimID.StreetlessPremiseIdentity, streetlessPremiseIdentity],
	[ConventionClaimID.PremiseSubdivisionPresent, premiseSubdivisionPresent],
	[ConventionClaimID.FixedWidthNumericPostcode, fixedWidthNumericPostcode],
	[ConventionClaimID.PlanningWordNamesLocality, planningWordNamesLocality],
]

/**
 * Every unary phenomenon the row exercises, with the form it exercises.
 */
export function rowPhenomena(row: Row): Map<string, string> {
	const out = new Map<string, string>()

	for (const [phenomenon, predicate] of UNARY_PREDICATES) {
		const value = predicate(row)

		if (value != null) {
			out.set(phenomenon, value)
		}
	}

	return out
}

/**
 * The row's tags in the order each first appears.
 */
function tagOrder(row: Row): string[] {
	return [...new Set(row.spans.map((span) => span.tag))]
}

/**
 * For two renderings of one address: `reordered` or `same-order`, or `null` when the pair does not qualify.
 *
 * The pair qualifies when both rows hold the same set of tags, at least two spans,
 * and text in different scripts.
 */
export function orderingReversesWithScript(text: PythonText, a: Row, b: Row): string | null {
	const tagsA = new Set(a.spans.map((span) => span.tag))
	const tagsB = new Set(b.spans.map((span) => span.tag))

	if (tagsA.size !== tagsB.size || [...tagsA].some((tag) => !tagsB.has(tag)) || a.spans.length < 2) return null

	if (text.detectScript(a.raw) === text.detectScript(b.raw)) return null

	return reorderedPairs(tagOrder(a), tagOrder(b)).length ? "reordered" : "same-order"
}

/**
 * `<n>-digit:<A>/<B>` when both rows hold an all-digit postcode of one width from two jurisdictions.
 */
export function numericShapeAcrossContexts(a: Row, b: Row): string | null {
	const widthA = fixedWidthNumericPostcode(a)
	const widthB = fixedWidthNumericPostcode(b)

	if (widthA == null || widthA !== widthB || a.country === b.country) return null

	const [first, second] = [a.country, b.country].toSorted()

	return `${widthA}:${first}/${second}`
}

/**
 * Every relational phenomenon the pair exercises, with the form it exercises.
 */
export function pairPhenomena(text: PythonText, a: Row, b: Row): Map<string, string> {
	const out = new Map<string, string>()
	const ordering = orderingReversesWithScript(text, a, b)
	const numeric = numericShapeAcrossContexts(a, b)

	if (ordering != null) {
		out.set(ConventionClaimID.OrderingReversesWithScript, ordering)
	}

	if (numeric != null) {
		out.set("numeric-shape-across-contexts", numeric)
	}

	return out
}

/**
 * Whether a phenomenon is relational.
 */
export function isRelational(phenomenon: string): boolean {
	return ARITY[phenomenon] === ClaimArity.Relational
}
