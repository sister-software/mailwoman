/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The two-arm premise-linkage runner (#1902). Every controlled row goes through the SAME production
 *   `geocodeAddress` twice: once with the deps the shipped product uses, and once with those deps plus
 *   a configured authoritative provider (#1901). Nothing else differs between the arms, which is what
 *   makes the arm-to-arm delta attributable to the provider rather than to the harness.
 *
 *   THE OPEN ARM REFUSES ON IDENTITY, BY CONSTRUCTION. It has no authoritative namespace to answer in,
 *   so its identifier outcome is `refused` on every row — recorded in the same vocabulary as the other
 *   arm, and never as `wrong`. That is the size of the gap the authoritative arm exists to close,
 *   stated rather than hidden: the open arm's comparable metric is the coordinate table, and grading
 *   its identity by distance instead would answer a different question than the one asked.
 *
 *   FOUR DISTINCTIONS THE MAPPING KEEPS, all of them the #1901 contract's:
 *
 *   - A REFUSAL is not a miss. It enters the eligible denominator only when the registered policy says
 *       a unique answer was required, and even then it stays `refused`.
 *   - An AMBIGUOUS answer is never `exact`. The provider declined to choose; collapsing to its first
 *       candidate would manufacture the certainty it withheld.
 *   - A TRANSPORT FAILURE is not a refusal. It is `errored`: out of every rate, reported as its own
 *       count.
 *   - A MATCH THAT NAMES NO IDENTIFIER in the graded scheme is not `wrong` either. It is ungradable —
 *       also `errored` — because reading "I could not check this" as "this was incorrect" is the
 *       measurement-boundary lie this repository keeps finding.
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
 * What the open arm records in the provider slot. Not an empty string: an empty name reads as a provider whose name was
 * lost, and this arm consulted none.
 */
const OPEN_PROVIDER_NAME = "none"

const METERS_PER_KM = 1000

/**
 * Coordinate thresholds reported when the caller names none — a rooftop bar, a parcel bar, and a building-block bar.
 * Every one is stated in the report beside its own denominator, so a caller substituting their own changes what is
 * reported and not what is claimed.
 */
const DEFAULT_COORDINATE_THRESHOLDS_M: readonly number[] = [5, 25, 100]

/**
 * The ladder improvement and regression are measured on.
 *
 * A confidently WRONG identifier is the worst thing an arm can do — worse than declining, because a consumer acts on
 * it. An abstention is worse than candidates, which at least narrow the answer. A committed correct identifier is best.
 * Ungradable rows have no rank: they are excluded from the comparison rather than assigned one.
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
 * Map one arm's authoritative block onto the outcome vocabulary. Pure, and the ONLY place an outcome is decided — both
 * arms are graded through it, so neither can acquire a private definition of `exact`.
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
 * The coordinate this arm is graded on.
 *
 * The #1901 contract carries the provider's coordinate BESIDE Mailwoman's own and leaves the choice to the consumer.
 * This harness is that consumer, and the choice is stated here rather than implied: when the provider committed to a
 * premise, its coordinate is the one the authoritative arm asserted; everywhere else the arm's answer is Mailwoman's.
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
	// Three independent absences, none of them a zero: terms that forbid publication, a row with no truth
	// coordinate, and an arm that produced none. Each keeps the row out of the coordinate table entirely.
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
 * The rows an arm could have answered exactly.
 *
 * Ungradable rows always leave. Refusals leave only under `abstain_ok`, because an arm that was permitted to abstain
 * was not asked to be right on those rows; under `unique_required` they stay in the denominator and count against the
 * exact rate — while remaining `refused` in the row itself.
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

		// An absent class is absent, not zero: a class nobody supplied rows for has no rate to report.
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

		// A row ungradable in either arm contributes to no numerator and stays in the denominator: "we could
		// not compare this" is not "this did not move".
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
 * The pieces a controlled run supplies. A private config module exports these; the synthetic self-check builds them
 * from the shipped fixture.
 */
export interface PremiseLinkageRunConfig {
	adapter: PremiseLinkageAdapter
	/**
	 * The deps the OPEN arm runs on — the production pipeline and artifacts. The authoritative arm receives these plus
	 * the provider and nothing else.
	 */
	deps: GeocodeDeps
	authoritativeProvider: AuthoritativeProvider
	coordinateThresholdsM?: readonly number[]
}

export interface PremiseLinkageRunOptions extends PremiseLinkageRunConfig {
	/**
	 * The run's secret. Never persisted, never printed, and never reused between published runs.
	 */
	salt: string
	policy: PremiseLinkagePolicy
	minCellSize: number
	mailwomanVersion: string
	mode: PremiseLinkageMode
}

/**
 * A run's output. The report is publishable after the writer's preflight; `rows` and `inputs` are NOT, and exist so the
 * writer can check what the report was computed from.
 */
export interface PremiseLinkageRunResult {
	report: PremiseLinkageReport
	rows: PremiseLinkageResultRow[]
	/**
	 * Every raw input the run read, held so the report writer can refuse a report containing one. Discarded with the run.
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
		// Set by the report writer, which is what removes cells. Zero here states "nothing has been removed yet".
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
 * The module may export the configuration directly or a factory that builds it — a real one needs the factory, because
 * opening a gazetteer and a provider connection at import time makes `--help` do both.
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
