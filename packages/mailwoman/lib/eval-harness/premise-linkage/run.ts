/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The two-arm premise-linkage runner: every controlled row goes through the same production
 *   `geocodeAddress` twice — once with the deps the shipped product uses, and once with those deps
 *   plus a configured authoritative provider — so the arm-to-arm delta is attributable to the
 *   provider rather than to the harness.
 *
 *   The open arm refuses on identity by construction: it has no authoritative namespace to answer
 *   in, so its identifier outcome is `refused` on every row, never `wrong`. Its comparable metric
 *   is the coordinate table. A refusal is not a miss, an ambiguous answer is never `exact`, a
 *   transport failure is `errored` rather than refused, and a match naming no identifier in the
 *   graded scheme is ungradable rather than `wrong`.
 */

import type { AuthoritativeProvider } from "@mailwoman/core/resolver"
import { haversineKm } from "@mailwoman/spatial"

import type { AuthoritativeAssertion } from "#authoritative"
import type { PremiseLinkageAdapter } from "#eval-harness/premise-linkage/adapter"
import { assertUsableSalt, caseIDFor } from "#eval-harness/premise-linkage/case-id"
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
	PremiseLinkageOutcome,
	PremiseLinkagePolicy,
	type PremiseLinkageRates,
	type PremiseLinkageReport,
	type PremiseLinkageResultRow,
	PREMISE_LINKAGE_SHAPE_CLASSES,
} from "#eval-harness/premise-linkage/schema"
import { geocodeAddress, type GeocodeDeps } from "#geocode/core"
import type { GeocodeResult } from "#geocode/result"

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
 * An empty name would read as a provider whose name was lost, and this arm consulted none.
 */
const OPEN_PROVIDER_NAME = "none"

const METERS_PER_KM = 1000

/**
 * Coordinate thresholds reported when the caller names none: a rooftop bar, a parcel bar,
 * and a building-block bar, each stated in the report beside its own denominator.
 */
const DEFAULT_COORDINATE_THRESHOLDS_M: readonly number[] = [5, 25, 100]

/**
 * The ladder improvement and regression are measured on: a confidently wrong identifier
 * ranks worst, an abstention next, candidates next, and a committed correct identifier
 * best. ungradable rows have no rank and are excluded from the comparison.
 */
const OUTCOME_RANK: Readonly<Record<string, number>> = {
	[PremiseLinkageOutcome.Wrong]: 0,
	[PremiseLinkageOutcome.Refused]: 1,
	[PremiseLinkageOutcome.Ambiguous]: 2,
	[PremiseLinkageOutcome.Exact]: 3,
}

/**
 * How one arm's answer graded, and why it was not exact.
 */
export interface PremiseLinkageGrade {
	outcome: PremiseLinkageOutcome
	failureCategory?: PremiseLinkageFailureCategory
}

/**
 * Map one arm's authoritative block onto the outcome vocabulary.
 * The only place an outcome is decided.
 */
export function outcomeFor(
	assertion: AuthoritativeAssertion | undefined,
	expected: PremiseLinkageObjectID
): PremiseLinkageGrade {
	if (!assertion) {
		return {
			outcome: PremiseLinkageOutcome.Refused,
			failureCategory: PremiseLinkageFailureCategory.ArmAssertsNoIdentifier,
		}
	}

	if (assertion.status === "transport_error") {
		return {
			outcome: PremiseLinkageOutcome.Errored,
			failureCategory: PremiseLinkageFailureCategory.TransportError,
		}
	}

	if (assertion.status === "refused") {
		return {
			outcome: PremiseLinkageOutcome.Refused,
			failureCategory: PremiseLinkageFailureCategory.ProviderRefused,
		}
	}

	if (assertion.status === "ambiguous") {
		return {
			outcome: PremiseLinkageOutcome.Ambiguous,
			failureCategory: PremiseLinkageFailureCategory.ProviderAmbiguous,
		}
	}

	const committed = assertion.matches?.[0]
	const observed = committed?.object_ids?.[expected.scheme]

	if (observed === undefined) {
		return {
			outcome: PremiseLinkageOutcome.Errored,
			failureCategory: PremiseLinkageFailureCategory.SchemeAbsent,
		}
	}

	if (observed === expected.id) return { outcome: PremiseLinkageOutcome.Exact }

	return {
		outcome: PremiseLinkageOutcome.Wrong,
		failureCategory: PremiseLinkageFailureCategory.IdentifierMismatch,
	}
}

/**
 * The coordinate this arm is graded on: the provider's when it committed to a premise,
 * Mailwoman's everywhere else.
 */
function gradedCoordinate(
	result: GeocodeResult,
	assertion: AuthoritativeAssertion | undefined
): { lat: number; lon: number } | undefined {
	const committed = assertion?.status === "matched" ? assertion.matches?.[0] : undefined

	if (committed?.lat !== undefined && committed.lon !== undefined) {
		return { lat: committed.lat, lon: committed.lon }
	}

	if (result.lat === null || result.lon === null) return undefined

	return { lat: result.lat, lon: result.lon }
}

function coordinateErrorFor(
	row: PremiseLinkageInputRow,
	result: GeocodeResult,
	assertion: AuthoritativeAssertion | undefined
): number | undefined {
	// Three independent absences — terms that forbid publication, a row with no
	// truth coordinate, and an arm that produced none — each keep the row out of the
	// coordinate table rather than counting as a zero.
	if (!row.coordinatePublishable) return undefined

	if (row.expectedLat === undefined || row.expectedLon === undefined) return undefined
	const answered = gradedCoordinate(result, assertion)

	if (!answered) return undefined

	return haversineKm(row.expectedLat, row.expectedLon, answered.lat, answered.lon) * METERS_PER_KM
}

function gradeRow(
	row: PremiseLinkageInputRow,
	caseID: string,
	result: GeocodeResult,
	mailwomanVersion: string
): PremiseLinkageResultRow {
	const assertion = result.authoritative
	const grade = outcomeFor(assertion, row.expectedObjectID)
	const coordinateErrorM = coordinateErrorFor(row, result, assertion)

	return {
		caseID,
		inputShapeClass: row.inputShapeClass,
		hasUnit: row.hasUnit,
		hasPostcode: row.hasPostcode,
		hasStreet: row.hasStreet,
		hasLocality: row.hasLocality,
		hasHistoricalAlias: row.hasHistoricalAlias,
		outcome: grade.outcome,
		coordinatePublishable: row.coordinatePublishable,
		...(coordinateErrorM === undefined ? {} : { coordinateErrorM }),
		providerName: assertion?.provider ?? OPEN_PROVIDER_NAME,
		...(assertion?.dataset_version === undefined ? {} : { providerDatasetVersion: assertion.dataset_version }),
		mailwomanVersion,
		...(grade.failureCategory === undefined ? {} : { failureCategory: grade.failureCategory }),
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
	return row.outcome === PremiseLinkageOutcome.Errored
}

/**
 * The rows an arm could have answered exactly: ungradable rows always leave, and refusals
 * leave only under `abstain_ok`, while remaining `refused` in the row itself.
 */
function eligibleRows(
	rows: readonly PremiseLinkageResultRow[],
	policy: PremiseLinkagePolicy
): readonly PremiseLinkageResultRow[] {
	const gradable = rows.filter((row) => !isErrored(row))

	if (policy === PremiseLinkagePolicy.UniqueRequired) return gradable

	return gradable.filter((row) => row.outcome !== PremiseLinkageOutcome.Refused)
}

function ratesFor(rows: readonly PremiseLinkageResultRow[], policy: PremiseLinkagePolicy): PremiseLinkageRates {
	const eligible = eligibleRows(rows, policy)

	return {
		exactOverEligible: count(
			countWhere(eligible, (row) => row.outcome === PremiseLinkageOutcome.Exact),
			eligible.length
		),
		wrongOverEligible: count(
			countWhere(eligible, (row) => row.outcome === PremiseLinkageOutcome.Wrong),
			eligible.length
		),
		refusedOverAll: count(
			countWhere(rows, (row) => row.outcome === PremiseLinkageOutcome.Refused),
			rows.length
		),
		ambiguousOverAll: count(
			countWhere(rows, (row) => row.outcome === PremiseLinkageOutcome.Ambiguous),
			rows.length
		),
	}
}

function coordinateThresholdsFor(
	rows: readonly PremiseLinkageResultRow[],
	thresholds: readonly number[]
): PremiseLinkageCoordinateThreshold[] {
	const measured = rows.filter((row) => row.coordinateErrorM !== undefined)

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
	const datasetVersion = rows.find((row) => row.providerDatasetVersion !== undefined)?.providerDatasetVersion
	const perClass: Partial<Record<PremiseLinkageInputShapeClass, PremiseLinkageRates>> = {}

	for (const shapeClass of PREMISE_LINKAGE_SHAPE_CLASSES) {
		const classRows = rows.filter((row) => row.inputShapeClass === shapeClass)

		// A class nobody supplied rows for has no rate to report, which is absent rather than zero.
		if (!classRows.length) continue

		perClass[shapeClass] = ratesFor(classRows, policy)
	}

	return {
		arm,
		providerName,
		...(datasetVersion === undefined ? {} : { providerDatasetVersion: datasetVersion }),
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

		if (before.outcome === after.outcome) continue

		changed++

		const beforeRank = OUTCOME_RANK[before.outcome] ?? 0
		const afterRank = OUTCOME_RANK[after.outcome] ?? 0

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
		// Set by the report writer, which is what removes cells.
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
	if (typeof value !== "object" || value === null) return false

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
