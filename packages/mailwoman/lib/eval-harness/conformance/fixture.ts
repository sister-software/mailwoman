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
 *   THREE CLOSED VOCABULARIES, and closing them is the point. `outcomeComparator` names one of five
 *   instruments, because "did the answer change" is not one question: a stable entity identity, an
 *   assembled coordinate, a strict parse, a component map and a mechanism-account shape are different
 *   observable contracts, and a universal equality function would either reject a legitimate
 *   transformation or hide a changed identity behind a nearby coordinate. `expect` names one of three
 *   relations, and `status` one of three verdict roles — a violated row is TRACKED rather than deleted, and
 *   never re-stated as `expect: diverges`, which would make the suite assert the defect. A fixture that
 *   omits the comparator, or names one that does not exist, is REFUSED at load with its own id in the
 *   message — never skipped, never defaulted. A skipped row reports as an absence, and an absence is what a
 *   law suite is measuring.
 *
 *   ONE CONTEXT, NOT TWO. A law varies the QUERY and holds the configuration fixed. Two contexts would let
 *   a row vary the country prior and the surface form at once, and the comparator could not say which one
 *   moved the answer.
 *
 *   The `law` name is a free string, on the same reasoning as the Gauntlet's own `AddressKind`: the
 *   taxonomy grows with the suites, and each suite owns the names it uses. Blank is still refused.
 */

import { isPlainObject } from "@mailwoman/core/objects"
import { JSONSpliterator } from "spliterator"

import type { GauntletGeocodeOpts } from "#eval-harness/gauntlet/harness"

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
 * - `candidate_admissibility` — which candidates the resolver's own lookups held, read from the recorded candidate tables
 *   with their fetch windows. The only comparator that reads the pipeline's INTERIOR rather than its answer, and the
 *   only one whose observation can fail to decide: see `candidate-admissibility.ts`.
 */
export const OUTCOME_COMPARATORS = [
	"resolution_identity",
	"assembled_coordinate",
	"parse_whole_strict",
	"component_map",
	"mechanism_shape",
	"candidate_admissibility",
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
 * What a row's outcome is allowed to mean for the verdict — the Gauntlet regression layer's own `CaseStatus`, spelled
 * again here because a law suite grades relations rather than cases and must not import the corpus schema to say so.
 *
 * - `pass` — the default, and the only status that GATES. A `pass` row whose law is violated fails the run.
 * - `known_fail` / `improvement_target` — the row is run and REPORTED, and does not block. A tracked row that starts
 *   holding is printed as a promotion instruction, which is what keeps the tracked list from becoming a place rows go
 *   to be forgotten.
 *
 * A red row is never deleted to make a run green, and it is never re-stated as `expect: diverges` either: that would
 * make the suite assert the defect, so fixing the defect would fail the suite.
 */
export const CONFORMANCE_STATUSES = ["pass", "known_fail", "improvement_target"] as const

export type ConformanceStatus = (typeof CONFORMANCE_STATUSES)[number]

/**
 * Which relations each comparator can actually express.
 *
 * `parse_whole_strict` and `mechanism_shape` are two-valued by construction: a strict parse is identical or it is not,
 * and a set of mechanism shapes has no containment order that means "more specific". A fixture asking either of them
 * for `refines` is refused at load rather than graded against a relation the instrument cannot report — an unreachable
 * expectation is a row that can only ever fail, which reads as a defect in the pipeline instead of a defect in the
 * fixture.
 *
 * `candidate_admissibility` is two-valued for the opposite reason: it reads a candidate POOL, where "unchanged" is the
 * degenerate case of "nothing admissible was lost" rather than a separate finding. Splitting the two would make a
 * fixture's expectation a claim about whether the added text reaches the resolver at all, which is behaviour rather
 * than law — so an identical pool reports `refines` and says so in its basis, and only a lost or unexplained candidate
 * reports `diverges`.
 */
export const RELATIONS_BY_COMPARATOR: Record<OutcomeComparatorName, readonly ConformanceRelation[]> = {
	resolution_identity: ["equivalent", "refines", "diverges"],
	assembled_coordinate: ["equivalent", "refines", "diverges"],
	parse_whole_strict: ["equivalent", "diverges"],
	component_map: ["equivalent", "refines", "diverges"],
	mechanism_shape: ["equivalent", "diverges"],
	candidate_admissibility: ["refines", "diverges"],
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
	 * Whether this row checks the run. Absent means {@linkcode CONFORMANCE_STATUSES}'s `pass` — a row says nothing about
	 * its status only when it is expected to hold.
	 */
	status?: ConformanceStatus
	/**
	 * Issue or record this row's tracked status points at, e.g. `#1919`. Free-form and never graded; it exists so a
	 * tracked row names where its diagnosis lives.
	 */
	bugRef?: string
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
	"status",
	"bugRef",
	"rowRef",
	"toleranceM",
	"note",
])

function isContextKey(key: string): key is ContextKey {
	return (CONTEXT_KEYS as readonly string[]).includes(key)
}

function isOutcomeComparator(value: unknown): value is OutcomeComparatorName {
	return typeof value === "string" && (OUTCOME_COMPARATORS as readonly string[]).includes(value)
}

function isConformanceRelation(value: unknown): value is ConformanceRelation {
	return typeof value === "string" && (CONFORMANCE_RELATIONS as readonly string[]).includes(value)
}

function isConformanceStatus(value: unknown): value is ConformanceStatus {
	return typeof value === "string" && (CONFORMANCE_STATUSES as readonly string[]).includes(value)
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

	const rawStatus = record["status"]

	if (rawStatus !== undefined && !isConformanceStatus(rawStatus)) {
		throw new Error(`${label}: unknown status ${JSON.stringify(rawStatus)} — known: ${CONFORMANCE_STATUSES.join(", ")}`)
	}

	const status = rawStatus

	const bugRef = record["bugRef"]

	if (bugRef !== undefined && (typeof bugRef !== "string" || !bugRef.trim())) {
		throw new Error(`${label}: "bugRef" must be a non-empty string when present (got ${JSON.stringify(bugRef)})`)
	}

	// A `bugRef` on a enforcing row points at a diagnosis for a row that is expected to hold, which reads as a tracked
	// row to everyone but the verdict. Refused for the same reason `toleranceM` is refused off its comparator.
	if (bugRef !== undefined && (status === undefined || status === "pass")) {
		throw new Error(
			`${label}: "bugRef" is only meaningful on a tracked row, and this row's status is ` +
				`"${status ?? "pass"}" — a enforcing row that names a defect asserts the defect is fixed.`
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
		...(status ? { status } : {}),
		...(typeof bugRef === "string" ? { bugRef } : {}),
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

/**
 * The population clause the invariance suites share: a base query that names no committed row names no population.
 */
export const MISSING_ROW_REF_PROBLEM =
	"no rowRef — every base query is drawn from a committed row, so a row without one names no population"

/**
 * The locale clause every suite shares: `context.caseCountry` selects the weights overlay the row grades through.
 */
export const MISSING_CASE_COUNTRY_PROBLEM =
	"no context.caseCountry — it selects the weights overlay the row grades through, and without it the row is graded base-only against a locale that is not its own"

/**
 * The invariance suites' shared relation clause, or `null` where the row states the one relation it may.
 */
export function invarianceExpectProblem(fixture: ConformanceFixture, lawNoun: string): string | null {
	return fixture.expect === "equivalent"
		? null
		: `expects "${fixture.expect}" — a ${lawNoun} row states an INVARIANCE, so the only relation it can state is "equivalent"`
}

/**
 * The per-fixture frame every law-suite audit opens with: the label a problem line names the row by, and the refusal of
 * a row filed under another suite's law. Suite-specific clauses run in `auditFixture`, in the order the suite states
 * them; a clause that disqualifies the rest of a row's checks returns early.
 */
export function auditCommonFixtureFields(
	fixtures: readonly ConformanceFixture[],
	law: string,
	auditFixture: (fixture: ConformanceFixture, label: string, problems: string[]) => void
): string[] {
	const problems: string[] = []

	for (const fixture of fixtures) {
		const label = `fixture "${fixture.id}"`

		if (fixture.law !== law) {
			problems.push(`${label}: law is "${fixture.law}", not "${law}"`)

			continue
		}

		auditFixture(fixture, label, problems)
	}

	return problems
}
