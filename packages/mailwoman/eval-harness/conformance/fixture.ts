/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The conformance-law fixture contract: what a law row is allowed to say, and what makes one
 *   unloadable. Pure — no model, no I/O beyond reading a JSONL file.
 *
 *   A law row states a RELATION between two runs of the same pipeline: a base query, a variant query, one
 *   context held constant across both, a named law, a named outcome comparator, and the relation the two
 *   outcomes are expected to stand in. The comparators themselves live in `comparators.ts`; the runner in
 *   `run.ts`. This module owns the vocabulary and the refusal.
 *
 *   TWO CLOSED VOCABULARIES, and closing them is the point. `outcomeComparator` names one of five
 *   instruments, because "did the answer change" is not one question: a stable entity identity, an
 *   assembled coordinate, a strict parse, a component map and a mechanism-account shape are different
 *   observable contracts, and a universal equality function would either reject a legitimate
 *   transformation or hide a changed identity behind a nearby coordinate. `expect` names one of three
 *   relations. A fixture that omits the comparator, or names one that does not exist, is REFUSED at load
 *   with its own id in the message — never skipped, never defaulted. A skipped row reports as an absence,
 *   and an absence is what a law suite is measuring.
 *
 *   ONE CONTEXT, NOT TWO. A law varies the QUERY and holds the configuration fixed. Two contexts would let
 *   a row vary the country prior and the surface form at once, and the comparator could not say which one
 *   moved the answer.
 *
 *   The `law` name is a free string, on the same reasoning as the Gauntlet's own `AddressKind`: the
 *   taxonomy grows with the suites, and each suite owns the names it uses. Blank is still refused.
 */

import { JSONSpliterator } from "spliterator"

import type { GauntletGeocodeOpts } from "../gauntlet/harness.ts"

/**
 * The closed set of outcome comparators. Each names an observable contract a law can preserve; adding one is a reviewed
 * instrument in `comparators.ts`, never an inline callback in a fixture.
 *
 * - `resolution_identity` — which entity was resolved, read from the namespaced place ids and nothing else. It never
 *   reads a coordinate, so an identity law cannot pass because two different places happen to sit close together.
 * - `assembled_coordinate` — where the answer landed, graded on the Gauntlet's own great-circle tolerance and tier.
 * - `parse_whole_strict` — the whole component map, key set included, under the Gauntlet's exact case-folded equality.
 * - `component_map` — the invariance suite's critical/non-critical severity reading over the same map.
 * - `mechanism_shape` — the mechanism-account shapes the two runs matched.
 */
export const OUTCOME_COMPARATORS = [
	"resolution_identity",
	"assembled_coordinate",
	"parse_whole_strict",
	"component_map",
	"mechanism_shape",
] as const

export type OutcomeComparatorName = (typeof OUTCOME_COMPARATORS)[number]

/**
 * The closed set of relations a law can expect between the base and variant outcomes.
 *
 * - `equivalent` — a normalization law: the variant carries the same information, so the comparator must find no
 *   difference on its axis.
 * - `refines` — a refinement law: the variant carries MORE information, so the variant's outcome must contain the base's
 *   and add to it.
 * - `diverges` — a contradiction law: the variant carries different information, so the outcomes must differ.
 */
export const CONFORMANCE_RELATIONS = ["equivalent", "refines", "diverges"] as const

export type ConformanceRelation = (typeof CONFORMANCE_RELATIONS)[number]

/**
 * Which relations each comparator can actually express.
 *
 * `parse_whole_strict` and `mechanism_shape` are two-valued by construction: a strict parse is identical or it is not,
 * and a set of mechanism shapes has no containment order that means "more specific". A fixture asking either of them
 * for `refines` is refused at load rather than graded against a relation the instrument cannot report — an unreachable
 * expectation is a row that can only ever fail, which reads as a defect in the pipeline instead of a defect in the
 * fixture.
 */
export const RELATIONS_BY_COMPARATOR: Record<OutcomeComparatorName, readonly ConformanceRelation[]> = {
	resolution_identity: ["equivalent", "refines", "diverges"],
	assembled_coordinate: ["equivalent", "refines", "diverges"],
	parse_whole_strict: ["equivalent", "diverges"],
	component_map: ["equivalent", "refines", "diverges"],
	mechanism_shape: ["equivalent", "diverges"],
}

/**
 * The per-query priors a law row may pin, held constant across both sides.
 *
 * Aliased from the Gauntlet's own {@linkcode GauntletGeocodeOpts} rather than re-declared: a law row's context is the
 * same thing a Gauntlet case's context is, and a second copy would let the two vocabularies drift while looking
 * identical at the call site.
 */
export type ConformanceContext = GauntletGeocodeOpts

/**
 * The keys {@linkcode ConformanceContext} accepts. Kept beside the alias because a structural type has no runtime
 * membership test, and the loader needs one to refuse a misspelled key.
 */
const CONTEXT_KEYS = ["defaultCountry", "caseCountry", "fuzzyCountryScope"] as const

type ContextKey = (typeof CONTEXT_KEYS)[number]

/**
 * One conformance-law fixture.
 */
export interface ConformanceFixture {
	/**
	 * Stable fixture id, unique within its file. Named in every refusal and every failure line.
	 */
	id: string
	/**
	 * The law this row belongs to, e.g. `case-folding-invariance`. Owned by the suite that declares it.
	 */
	law: string
	/**
	 * The query the law's relation is stated FROM.
	 */
	base: string
	/**
	 * The query the law's relation is stated TO. May equal {@linkcode ConformanceFixture.base} — an idempotence law states
	 * that running the same input twice agrees, which is a relation between two runs rather than two strings.
	 */
	variant: string
	/**
	 * Per-query priors applied to BOTH sides. Absent means production defaults on both.
	 */
	context?: ConformanceContext
	/**
	 * The instrument that decides the relation. Required — see the module docstring.
	 */
	outcomeComparator: OutcomeComparatorName
	/**
	 * The relation the two outcomes must stand in.
	 */
	expect: ConformanceRelation
	/**
	 * The committed row or input set this fixture was drawn from, e.g. `parity-corpus.jsonl#fr-0042`. Carried into the
	 * failure line so a violation names the population it came from rather than only the synthetic pair.
	 */
	rowRef?: string
	/**
	 * Great-circle tolerance for `assembled_coordinate`, in metres. Absent uses the Gauntlet's own default. Refused on
	 * any other comparator: a stored expectation no branch reads is the defect this contract exists to make loud.
	 */
	toleranceM?: number
	/**
	 * Free-form authoring note. Never graded.
	 */
	note?: string
}

/**
 * Every key a fixture record may carry. An unknown key is refused rather than dropped: a plain object silently discards
 * a misspelled field, and the row then grades under a default nobody wrote while reading as authored.
 */
const FIXTURE_KEYS = new Set<string>([
	"id",
	"law",
	"base",
	"variant",
	"context",
	"outcomeComparator",
	"expect",
	"rowRef",
	"toleranceM",
	"note",
])

/**
 * The four narrowings this loader performs, each in one named place.
 *
 * Every one widens the KNOWN-GOOD LIST and never the value: `readonly ["a", "b"]` refuses `.includes` on anything
 * outside its own element type, so a membership test has to widen one side, and widening the list is the direction that
 * cannot assert something false about the value under test. The alternative idiom — `list.includes(value as Member)` —
 * asserts the membership it is about to check, so the assertion stands whether or not the check passes.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isContextKey(key: string): key is ContextKey {
	return (CONTEXT_KEYS as readonly string[]).includes(key)
}

function isOutcomeComparator(value: unknown): value is OutcomeComparatorName {
	return typeof value === "string" && (OUTCOME_COMPARATORS as readonly string[]).includes(value)
}

function isConformanceRelation(value: unknown): value is ConformanceRelation {
	return typeof value === "string" && (CONFORMANCE_RELATIONS as readonly string[]).includes(value)
}

function requireNonEmptyString(record: Record<string, unknown>, key: string, label: string): string {
	const value = record[key]

	if (typeof value !== "string" || !value.trim()) {
		throw new Error(`${label}: "${key}" must be a non-empty string (got ${JSON.stringify(value)})`)
	}

	return value
}

function readContext(raw: unknown, label: string): ConformanceContext | undefined {
	if (raw === undefined) return undefined

	if (!isPlainObject(raw)) {
		throw new Error(`${label}: "context" must be an object (got ${JSON.stringify(raw)})`)
	}

	const context: ConformanceContext = {}

	for (const [key, value] of Object.entries(raw)) {
		if (!isContextKey(key)) {
			throw new Error(`${label}: unknown context key "${key}" — known: ${CONTEXT_KEYS.join(", ")}`)
		}

		if (typeof value !== "string" || !value.trim()) {
			throw new Error(`${label}: context.${key} must be a non-empty string (got ${JSON.stringify(value)})`)
		}

		context[key] = value
	}

	return context
}

/**
 * Validate one fixture record and return it typed, or throw naming the fixture.
 *
 * `origin` is the file (and row) the record came from; it is prefixed to every message so a refusal points at the line
 * to edit even when the record has no usable id of its own.
 */
export function parseConformanceFixture(raw: unknown, origin: string): ConformanceFixture {
	if (!isPlainObject(raw)) {
		throw new Error(`${origin}: conformance fixture must be an object (got ${JSON.stringify(raw)})`)
	}

	const record = raw
	const rawID = typeof record["id"] === "string" ? record["id"].trim() : ""
	const label = rawID ? `${origin}: fixture "${rawID}"` : `${origin}: fixture (no id)`

	for (const key of Object.keys(record)) {
		if (!FIXTURE_KEYS.has(key)) {
			throw new Error(`${label}: unknown field "${key}" — known: ${[...FIXTURE_KEYS].join(", ")}`)
		}
	}

	const id = requireNonEmptyString(record, "id", label)
	const law = requireNonEmptyString(record, "law", label)
	const base = requireNonEmptyString(record, "base", label)
	const variant = requireNonEmptyString(record, "variant", label)

	const comparator = record["outcomeComparator"]

	if (comparator === undefined) {
		throw new Error(
			`${label}: "outcomeComparator" is required — a law states which observable contract it preserves. ` +
				`Known: ${OUTCOME_COMPARATORS.join(", ")}`
		)
	}

	if (!isOutcomeComparator(comparator)) {
		throw new Error(
			`${label}: unknown outcomeComparator ${JSON.stringify(comparator)} — known: ${OUTCOME_COMPARATORS.join(", ")}`
		)
	}

	const outcomeComparator = comparator
	const expected = record["expect"]

	if (expected === undefined) {
		throw new Error(`${label}: "expect" is required — known: ${CONFORMANCE_RELATIONS.join(", ")}`)
	}

	if (!isConformanceRelation(expected)) {
		throw new Error(`${label}: unknown expect ${JSON.stringify(expected)} — known: ${CONFORMANCE_RELATIONS.join(", ")}`)
	}

	const expect = expected
	const supported = RELATIONS_BY_COMPARATOR[outcomeComparator]

	if (!supported.includes(expect)) {
		throw new Error(
			`${label}: comparator "${outcomeComparator}" cannot express the relation "${expect}" — it reports ` +
				`${supported.join(" / ")}. See RELATIONS_BY_COMPARATOR.`
		)
	}

	const tolerance = record["toleranceM"]

	if (tolerance !== undefined) {
		if (outcomeComparator !== "assembled_coordinate") {
			throw new Error(
				`${label}: "toleranceM" is only read by the assembled_coordinate comparator, and this row names ` +
					`"${outcomeComparator}" — a stored expectation no branch reads asserts nothing.`
			)
		}

		if (typeof tolerance !== "number" || !Number.isFinite(tolerance) || tolerance <= 0) {
			throw new Error(`${label}: "toleranceM" must be a positive finite number (got ${JSON.stringify(tolerance)})`)
		}
	}

	const rowRef = record["rowRef"]

	if (rowRef !== undefined && (typeof rowRef !== "string" || !rowRef.trim())) {
		throw new Error(`${label}: "rowRef" must be a non-empty string when present (got ${JSON.stringify(rowRef)})`)
	}

	const note = record["note"]

	if (note !== undefined && typeof note !== "string") {
		throw new Error(`${label}: "note" must be a string when present (got ${JSON.stringify(note)})`)
	}

	const context = readContext(record["context"], label)

	return {
		id,
		law,
		base,
		variant,
		outcomeComparator,
		expect,
		...(context ? { context } : {}),
		...(typeof rowRef === "string" ? { rowRef } : {}),
		...(typeof tolerance === "number" ? { toleranceM: tolerance } : {}),
		...(typeof note === "string" ? { note } : {}),
	}
}

/**
 * Read a JSONL law suite, validating every row.
 *
 * Loud on the first bad row rather than collecting the good ones: a partially-loaded suite reports fewer violations
 * than it has rows, and a smaller violation count is indistinguishable from a law that holds.
 */
export async function loadConformanceFixtures(path: string): Promise<ConformanceFixture[]> {
	const rows = await Array.fromAsync(JSONSpliterator.fromAsync<unknown>(path))
	const fixtures: ConformanceFixture[] = []
	const seen = new Set<string>()

	for (const [index, raw] of rows.entries()) {
		const fixture = parseConformanceFixture(raw, `${path}:${index + 1}`)

		if (seen.has(fixture.id)) {
			throw new Error(`${path}:${index + 1}: duplicate fixture id "${fixture.id}" — ids name rows in failure output`)
		}

		seen.add(fixture.id)
		fixtures.push(fixture)
	}

	return fixtures
}
