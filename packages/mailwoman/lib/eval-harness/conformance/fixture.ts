/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Schema and validation for conformance-law fixtures. Each row compares base and variant queries under one fixed
 *   context, using a named comparator and expected relation. Comparator, relation, and status vocabularies are closed;
 *   invalid rows fail loading rather than being skipped or defaulted.
 */

import { stringifyJSON } from "@mailwoman/core/json"
import { isPlainObject } from "@mailwoman/core/objects"
import type { PathBuilderLike } from "path-ts"
import { JSONSpliterator } from "spliterator"

import type { GauntletGeocodeOpts } from "#eval-harness/gauntlet/harness"

/**
 * Supported outcome comparators.
 *
 * Each checks one observable interface; implementations live in `comparators.ts`.
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
 * Relations a fixture may require between base and variant outcomes.
 */
export const CONFORMANCE_RELATIONS = ["equivalent", "refines", "diverges"] as const

export type ConformanceRelation = (typeof CONFORMANCE_RELATIONS)[number]

/**
 * Verdict role of a fixture.
 *
 * `pass` blocks on failure; tracked statuses report without blocking.
 */
export const CONFORMANCE_STATUSES = ["pass", "known_fail", "improvement_target"] as const

export type ConformanceStatus = (typeof CONFORMANCE_STATUSES)[number]

/**
 * Relations supported by each comparator.
 * Reject expectations the instrument cannot evaluate.
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
 * Per-query options shared by base and variant, using the Gauntlet's option type.
 */
export type ConformanceContext = GauntletGeocodeOpts

/**
 * Runtime-validated keys accepted in a conformance context.
 */
const CONTEXT_KEYS = ["defaultCountry", "caseCountry", "fuzzyCountryScope"] as const

type ContextKey = (typeof CONTEXT_KEYS)[number]

/**
 * One conformance-law test case.
 */
export interface ConformanceFixture {
	/**
	 * Stable ID, unique within the file and used in diagnostics.
	 */
	id: string
	/**
	 * Law name, owned by the declaring suite.
	 */
	law: string
	/**
	 * Base query.
	 */
	base: string
	/**
	 * Variant query; may equal the base for idempotence checks.
	 */
	variant: string
	/**
	 * Options shared by both sides; absent means production defaults.
	 */
	context?: ConformanceContext
	/**
	 * Required comparator for the expected relation.
	 */
	outcomeComparator: OutcomeComparatorName
	/**
	 * The relation the two outcomes must stand in.
	 */
	expect: ConformanceRelation
	/**
	 * Whether failure blocks the run; defaults to `pass`.
	 */
	status?: ConformanceStatus
	/**
	 * Issue or record associated with a tracked row.
	 */
	bugRef?: string
	/**
	 * Source row or input set for this fixture.
	 */
	rowRef?: string
	/**
	 * Coordinate tolerance in metres; supported only by `assembled_coordinate`.
	 */
	toleranceM?: number
	/**
	 * Authoring note, not graded.
	 */
	note?: string
}

/**
 * Accepted fixture keys; reject unknown fields instead of silently dropping typos.
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
		throw new Error(`${label}: "${key}" must be a non-empty string (got ${stringifyJSON(value)})`)
	}

	return value
}

function readContext(raw: unknown, label: string): ConformanceContext | undefined {
	if (raw === undefined) return undefined

	if (!isPlainObject(raw)) {
		throw new Error(`${label}: "context" must be an object (got ${stringifyJSON(raw)})`)
	}

	const context: ConformanceContext = {}

	for (const [key, value] of Object.entries(raw)) {
		if (!isContextKey(key)) {
			throw new Error(`${label}: unknown context key "${key}" — known: ${CONTEXT_KEYS.join(", ")}`)
		}

		if (typeof value !== "string" || !value.trim()) {
			throw new Error(`${label}: context.${key} must be a non-empty string (got ${stringifyJSON(value)})`)
		}

		context[key] = value
	}

	return context
}

/**
 * Validate a fixture and include its source location in any error.
 */
export function parseConformanceFixture(raw: unknown, origin: string): ConformanceFixture {
	if (!isPlainObject(raw)) {
		throw new Error(`${origin}: conformance fixture must be an object (got ${stringifyJSON(raw)})`)
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
			`${label}: "outcomeComparator" is required — a law states which observable interface it preserves. ` +
				`Known: ${OUTCOME_COMPARATORS.join(", ")}`
		)
	}

	if (!isOutcomeComparator(comparator)) {
		throw new Error(
			`${label}: unknown outcomeComparator ${stringifyJSON(comparator)} — known: ${OUTCOME_COMPARATORS.join(", ")}`
		)
	}

	const outcomeComparator = comparator
	const expected = record["expect"]

	if (expected === undefined) {
		throw new Error(`${label}: "expect" is required — known: ${CONFORMANCE_RELATIONS.join(", ")}`)
	}

	if (!isConformanceRelation(expected)) {
		throw new Error(`${label}: unknown expect ${stringifyJSON(expected)} — known: ${CONFORMANCE_RELATIONS.join(", ")}`)
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
		throw new Error(`${label}: unknown status ${stringifyJSON(rawStatus)} — known: ${CONFORMANCE_STATUSES.join(", ")}`)
	}

	const status = rawStatus

	const bugRef = record["bugRef"]

	if (bugRef !== undefined && (typeof bugRef !== "string" || !bugRef.trim())) {
		throw new Error(`${label}: "bugRef" must be a non-empty string when present (got ${stringifyJSON(bugRef)})`)
	}

	// `bugRef` is only valid on non-blocking tracked rows.
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
			throw new Error(`${label}: "toleranceM" must be a positive finite number (got ${stringifyJSON(tolerance)})`)
		}
	}

	const rowRef = record["rowRef"]

	if (rowRef !== undefined && (typeof rowRef !== "string" || !rowRef.trim())) {
		throw new Error(`${label}: "rowRef" must be a non-empty string when present (got ${stringifyJSON(rowRef)})`)
	}

	const note = record["note"]

	if (note !== undefined && typeof note !== "string") {
		throw new Error(`${label}: "note" must be a string when present (got ${stringifyJSON(note)})`)
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
 * Load and validate every JSONL fixture, rejecting the first invalid row.
 */
export async function loadConformanceFixtures(source: PathBuilderLike): Promise<ConformanceFixture[]> {
	const path = source.toString()
	const fixtures: ConformanceFixture[] = []
	const seen = new Set<string>()
	let index = 0

	for await (const raw of JSONSpliterator.fromAsync<unknown>(path)) {
		index++
		const fixture = parseConformanceFixture(raw, `${path}:${index}`)

		if (seen.has(fixture.id)) {
			throw new Error(`${path}:${index}: duplicate fixture id "${fixture.id}" — ids name rows in failure output`)
		}

		seen.add(fixture.id)
		fixtures.push(fixture)
	}

	return fixtures
}

/**
 * Shared audit message for fixtures without a source row reference.
 */
export const MISSING_ROW_REF_PROBLEM =
	"no rowRef — every base query is drawn from a committed row, so a row without one names no population"

/**
 * Shared audit message for fixtures without a country-specific context.
 */
export const MISSING_CASE_COUNTRY_PROBLEM =
	"no context.caseCountry — it selects the weights overlay the row grades through, and without it the row is graded base-only against a locale that is not its own"

/**
 * Check the relation required by an invariance suite.
 */
export function invarianceExpectProblem(fixture: ConformanceFixture, lawNoun: string): string | null {
	return fixture.expect === "equivalent"
		? null
		: `expects "${fixture.expect}" — a ${lawNoun} row states an INVARIANCE, so the only relation it can state is "equivalent"`
}

/**
 * Apply shared law checks and suite-specific validation to every fixture.
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
