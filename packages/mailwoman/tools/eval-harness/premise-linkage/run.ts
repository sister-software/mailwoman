/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Runs each controlled row through production `geocodeAddress` twice. The first call uses the shipped product's
 *   dependencies. The second adds a configured authoritative provider. The arm-to-arm difference therefore measures
 *   the provider rather than the harness.
 *
 *   The open arm has no authoritative namespace for identity. Its identifier result is `refused` on every row.
 *   The comparable metric is the coordinate table. A refusal, ambiguous answer and transport failure have distinct
 *   results: `refused`, a non-exact result and `errored`. A match without an identifier in the graded scheme is
 *   ungradable.
 */

import type { AuthoritativeAssertion, GeocodeResult } from "@mailwoman/core/geocode"
import type { AuthoritativeProvider } from "@mailwoman/core/resolver"
import { haversineKm } from "@mailwoman/spatial"

import { geocodeAddress, type GeocodeDeps } from "#geocode/core"
import type { PremiseLinkageAdapter } from "#tools/eval-harness/premise-linkage/adapter"
import { assertUsableSalt, caseIDFor } from "#tools/eval-harness/premise-linkage/case-id"
import {
	type PremiseLinkageArmReport,
	type PremiseLinkageComparison,
	type PremiseLinkageCoordinateThreshold,
	type PremiseLinkageCount,
	PremiseLinkageFailureCategory,
	type PremiseLinkageInputRow,
	type PremiseLinkageInputShapeClass,
	type PremiseLinkageMode,
	type PremiseLinkageObjectID,
	PremiseLinkageResult,
	PremiseLinkagePolicy,
	type PremiseLinkageRates,
	type PremiseLinkageReport,
	type PremiseLinkageResultRow,
	PREMISE_LINKAGE_SHAPE_CLASSES,
} from "#tools/eval-harness/premise-linkage/schema"

/**
 * Mailwoman with open artifacts only — the product as it ships.
 */
export const OPEN_ARM_NAME = "open"

/**
 * Mailwoman plus the configured authoritative provider.
 */
export const AUTHORITATIVE_ARM_NAME = "authoritative"

/**
 * What the open arm records in the provider slot.
 *
 * An empty name would suggest that the provider's name was lost.
 * This arm consulted no provider.
 */
const OPEN_PROVIDER_NAME = "none"

const METERS_PER_KM = 1000

/**
 * Reports coordinate thresholds when the caller supplies none.
 *
 * The defaults are rooftop, parcel and building-block bars.
 * The report gives each threshold with its own denominator.
 */
const DEFAULT_COORDINATE_THRESHOLDS_M: readonly number[] = [5, 25, 100]

/**
 * Ranks results to measure ladder improvement or regression.
 *
 * A confidently wrong identifier ranks lowest, followed by an abstention,
 * then candidates and a committed correct identifier.
 * Ungradable rows have no rank and stay outside the comparison.
 */
const RESULT_RANK: Readonly<Record<string, number>> = {
	[PremiseLinkageResult.Wrong]: 0,
	[PremiseLinkageResult.Refused]: 1,
	[PremiseLinkageResult.Ambiguous]: 2,
	[PremiseLinkageResult.Exact]: 3,
}

/**
 * Records how one arm's answer graded and explains a result short of exact.
 */
export interface PremiseLinkageGrade {
	result: PremiseLinkageResult
	failureCategory: PremiseLinkageFailureCategory | null
}

/**
 * Map one arm's authoritative block onto the result vocabulary.
 * The only place a result is decided.
 */
export function resultFor(
	assertion: AuthoritativeAssertion | null,
	expected: PremiseLinkageObjectID
): PremiseLinkageGrade {
	if (!assertion) {
		return {
			result: PremiseLinkageResult.Refused,
			failureCategory: PremiseLinkageFailureCategory.ArmAssertsNoIdentifier,
		}
	}

	if (assertion.status === "transport_error") {
		return {
			result: PremiseLinkageResult.Errored,
			failureCategory: PremiseLinkageFailureCategory.TransportError,
		}
	}

	if (assertion.status === "refused") {
		return {
			result: PremiseLinkageResult.Refused,
			failureCategory: PremiseLinkageFailureCategory.ProviderRefused,
		}
	}

	if (assertion.status === "ambiguous") {
		return {
			result: PremiseLinkageResult.Ambiguous,
			failureCategory: PremiseLinkageFailureCategory.ProviderAmbiguous,
		}
	}

	const committed = assertion.matches?.[0]
	const observed = committed?.object_ids?.[expected.scheme]

	if (!observed) {
		return {
			result: PremiseLinkageResult.Errored,
			failureCategory: PremiseLinkageFailureCategory.SchemeAbsent,
		}
	}

	if (observed === expected.id) return { result: PremiseLinkageResult.Exact, failureCategory: null }

	return {
		result: PremiseLinkageResult.Wrong,
		failureCategory: PremiseLinkageFailureCategory.IdentifierMismatch,
	}
}

/**
 * The coordinate this arm is graded on: the provider's when it committed to a premise,
 * Mailwoman's everywhere else.
 */
function gradedCoordinate(
	result: GeocodeResult,
	assertion: AuthoritativeAssertion | null
): { lat: number; lon: number } | null {
	const committed = assertion?.status === "matched" ? assertion.matches?.[0] : null

	if (committed?.lat != null && committed.lon != null) {
		return { lat: committed.lat, lon: committed.lon }
	}

	if (result.lat === null || result.lon === null) return null

	return { lat: result.lat, lon: result.lon }
}

function coordinateErrorFor(
	row: PremiseLinkageInputRow,
	result: GeocodeResult,
	assertion: AuthoritativeAssertion | null
): number | null {
	// Three independent conditions exclude a row from the coordinate table: terms forbid
	// publication, the row lacks a truth coordinate, or the arm produced no coordinate.
	// The aggregate does not count these cases as zero.
	if (!row.coordinatePublishable) return null

	if (row.expectedLat === null || row.expectedLon === null) return null
	const answered = gradedCoordinate(result, assertion)

	if (!answered) return null

	return haversineKm(row.expectedLat, row.expectedLon, answered.lat, answered.lon) * METERS_PER_KM
}

function gradeRow(
	row: PremiseLinkageInputRow,
	caseID: string,
	result: GeocodeResult,
	mailwomanVersion: string
): PremiseLinkageResultRow {
	const assertion = result.authoritative
	const grade = resultFor(assertion ?? null, row.expectedObjectID)
	const coordinateErrorM = coordinateErrorFor(row, result, assertion ?? null)

	return {
		caseID,
		inputShapeClass: row.inputShapeClass,
		hasUnit: row.hasUnit,
		hasPostcode: row.hasPostcode,
		hasStreet: row.hasStreet,
		hasLocality: row.hasLocality,
		hasHistoricalAlias: row.hasHistoricalAlias,
		result: grade.result,
		coordinatePublishable: row.coordinatePublishable,
		coordinateErrorM,
		providerName: assertion?.provider ?? OPEN_PROVIDER_NAME,
		providerDatasetVersion: assertion?.dataset_version ?? null,
		mailwomanVersion,
		failureCategory: grade.failureCategory,
	}
}

function countWhere(rows: readonly PremiseLinkageResultRow[], predicate: (row: PremiseLinkageResultRow) => boolean) {
	let n = 0

	for (const row of rows) {
		if (predicate(row)) {
			n++
		}
	}

	return n
}

function count(n: number, of: number): PremiseLinkageCount {
	return { n, of }
}

function isErrored(row: PremiseLinkageResultRow): boolean {
	return row.result === PremiseLinkageResult.Errored
}

/**
 * Returns rows eligible for exact answers.
 *
 * It removes ungradable rows and removes refusals only under `abstain_ok`.
 * Each refusal retains its `refused` result in the row.
 */
function eligibleRows(
	rows: readonly PremiseLinkageResultRow[],
	policy: PremiseLinkagePolicy
): readonly PremiseLinkageResultRow[] {
	const gradable = rows.filter((row) => !isErrored(row))

	if (policy === PremiseLinkagePolicy.UniqueRequired) return gradable

	return gradable.filter((row) => row.result !== PremiseLinkageResult.Refused)
}

function ratesFor(rows: readonly PremiseLinkageResultRow[], policy: PremiseLinkagePolicy): PremiseLinkageRates {
	const eligible = eligibleRows(rows, policy)

	return {
		exactOverEligible: count(
			countWhere(eligible, (row) => row.result === PremiseLinkageResult.Exact),
			eligible.length
		),
		wrongOverEligible: count(
			countWhere(eligible, (row) => row.result === PremiseLinkageResult.Wrong),
			eligible.length
		),
		refusedOverAll: count(
			countWhere(rows, (row) => row.result === PremiseLinkageResult.Refused),
			rows.length
		),
		ambiguousOverAll: count(
			countWhere(rows, (row) => row.result === PremiseLinkageResult.Ambiguous),
			rows.length
		),
	}
}

function coordinateThresholdsFor(
	rows: readonly PremiseLinkageResultRow[],
	thresholds: readonly number[]
): PremiseLinkageCoordinateThreshold[] {
	const measured = rows.filter((row) => row.coordinateErrorM !== null)

	return thresholds.map((thresholdM) => ({
		thresholdM,
		withinThreshold: count(
			countWhere(measured, (row) => (row.coordinateErrorM ?? Number.POSITIVE_INFINITY) <= thresholdM),
			measured.length
		),
	}))
}

function aggregateArm(
	arm: string,
	rows: readonly PremiseLinkageResultRow[],
	policy: PremiseLinkagePolicy,
	thresholds: readonly number[]
): PremiseLinkageArmReport {
	const providerName = rows[0]?.providerName ?? OPEN_PROVIDER_NAME
	const datasetVersion = rows.find((row) => row.providerDatasetVersion !== null)?.providerDatasetVersion ?? null
	const perClass: Partial<Record<PremiseLinkageInputShapeClass, PremiseLinkageRates>> = {}

	for (const shapeClass of PREMISE_LINKAGE_SHAPE_CLASSES) {
		const classRows = rows.filter((row) => row.inputShapeClass === shapeClass)

		// A class with no supplied rows has no rate.
		// The report omits the rate instead of recording zero.
		if (!classRows.length) continue

		perClass[shapeClass] = ratesFor(classRows, policy)
	}

	return {
		arm,
		providerName,
		providerDatasetVersion: datasetVersion,
		rowsRead: rows.length,
		erroredOverAll: count(countWhere(rows, isErrored), rows.length),
		overall: ratesFor(rows, policy),
		perClass,
		coordinateThresholds: coordinateThresholdsFor(rows, thresholds),
	}
}

function compareArms(
	baseline: readonly PremiseLinkageResultRow[],
	candidate: readonly PremiseLinkageResultRow[]
): PremiseLinkageComparison {
	const candidateByCase = new Map(candidate.map((row) => [row.caseID, row]))
	const total = baseline.length
	let changed = 0
	let improved = 0
	let regressed = 0

	for (const before of baseline) {
		const after = candidateByCase.get(before.caseID)

		// A row ungradable in either arm stays in the denominator and contributes to no numerator.
		if (!after || isErrored(before) || isErrored(after)) continue

		if (before.result === after.result) continue

		changed++

		const beforeRank = RESULT_RANK[before.result] ?? 0
		const afterRank = RESULT_RANK[after.result] ?? 0

		if (afterRank > beforeRank) {
			improved++
		} else if (afterRank < beforeRank) {
			regressed++
		}
	}

	return {
		baselineArm: OPEN_ARM_NAME,
		candidateArm: AUTHORITATIVE_ARM_NAME,
		changed: count(changed, total),
		improved: count(improved, total),
		regressed: count(regressed, total),
	}
}

/**
 * The pieces a controlled run supplies.
 *
 * A private config module or the synthetic self-check builds them.
 */
export interface PremiseLinkageRunConfig {
	adapter: PremiseLinkageAdapter
	/**
	 * The deps the open arm runs on — the production pipeline and artifacts.
	 */
	deps: GeocodeDeps
	authoritativeProvider: AuthoritativeProvider
	coordinateThresholdsM?: readonly number[]
}

export interface PremiseLinkageRunOptions extends PremiseLinkageRunConfig {
	/**
	 * The run's secret, never persisted, printed, or reused between published runs.
	 */
	salt: string
	policy: PremiseLinkagePolicy
	minCellSize: number
	mailwomanVersion: string
	mode: PremiseLinkageMode
}

/**
 * A run's output: the report is publishable after the writer's preflight; `rows` and `inputs` are not.
 */
export interface PremiseLinkageRunResult {
	report: PremiseLinkageReport
	rows: PremiseLinkageResultRow[]
	/**
	 * Every raw input the run read, held so the report writer can refuse a report containing one.
	 */
	inputs: string[]
}

/**
 * Grade one adapter's rows through both arms.
 */
export async function runPremiseLinkage(options: PremiseLinkageRunOptions): Promise<PremiseLinkageRunResult> {
	assertUsableSalt(options.salt)

	const thresholds = options.coordinateThresholdsM ?? DEFAULT_COORDINATE_THRESHOLDS_M
	const authoritativeDeps: GeocodeDeps = { ...options.deps, authoritativeProvider: options.authoritativeProvider }
	const inputs: string[] = []
	const openRows: PremiseLinkageResultRow[] = []
	const authoritativeRows: PremiseLinkageResultRow[] = []

	for await (const row of options.adapter.rows()) {
		inputs.push(row.input)
		const caseID = caseIDFor(row.input, options.salt)
		const open = await geocodeAddress(row.input, options.deps)
		const authoritative = await geocodeAddress(row.input, authoritativeDeps)

		openRows.push(gradeRow(row, caseID, open, options.mailwomanVersion))
		authoritativeRows.push(gradeRow(row, caseID, authoritative, options.mailwomanVersion))
	}

	const report: PremiseLinkageReport = {
		mode: options.mode,
		mailwomanVersion: options.mailwomanVersion,
		policy: options.policy,
		minCellSize: options.minCellSize,
		// The report writer sets this field and removes cells.
		// Zero here states no cell has been removed yet.
		suppressedCells: 0,
		arms: [
			aggregateArm(OPEN_ARM_NAME, openRows, options.policy, thresholds),
			aggregateArm(AUTHORITATIVE_ARM_NAME, authoritativeRows, options.policy, thresholds),
		],
		comparison: compareArms(openRows, authoritativeRows),
	}

	return { report, rows: [...openRows, ...authoritativeRows], inputs }
}

function hasRunConfigShape(value: unknown): value is PremiseLinkageRunConfig {
	if (typeof value !== "object" || !value) return false

	return "adapter" in value && "deps" in value && "authoritativeProvider" in value
}

/**
 * Validate what a private config module exported, before a licensed file is opened.
 *
 * A factory is accepted because opening a gazetteer and a provider connection
 * at import time makes `--help` do both.
 */
export async function resolvePremiseLinkageConfig(
	exported: unknown,
	specifier: string
): Promise<PremiseLinkageRunConfig> {
	const resolved: unknown = typeof exported === "function" ? await exported() : exported

	if (!hasRunConfigShape(resolved)) {
		throw new TypeError(
			`premise-linkage: ${specifier} must default-export a run configuration (or a factory returning one) with ` +
				"`adapter`, `deps` and `authoritativeProvider`."
		)
	}

	return resolved
}
