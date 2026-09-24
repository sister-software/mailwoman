/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Grade committed POI queries against the production pipeline's assembled result.
 *   Floors cover overall results, required abstentions, and address-path guards; `--enforce`
 *   makes breaches fail the command. Tracked rows are reported but excluded from floors and
 *   require a live issue reference. Only currently reachable POI behavior is scored.
 *   `gradeCase` is pure and tested without a database.
 */

import { stringifyJSON } from "@mailwoman/core/json"
import type { PipelineOpts, PipelineResult, POIIntentOutcome } from "@mailwoman/core/pipeline"
import { haversineKm } from "@mailwoman/spatial"
import { JSONSpliterator } from "spliterator"

import type { POIBoardExpect } from "#eval-harness/poi/board/expectations"
import { createPOIBoardPipeline, type POIBoardOptions } from "#eval-harness/poi/board/runtime"

export {
	createPOIBoardPipeline,
	type POIBoardOptions,
	type POIBoardPipelineHandle,
	type POIBoardResolverBackend,
} from "#eval-harness/poi/board/runtime"

export {
	type POIBoardAbstainExpect,
	type POIBoardAddressExpect,
	type POIBoardExpect,
	type POIBoardResultsExpect,
} from "#eval-harness/poi/board/expectations"

/**
 * Fixture set backing the POI query board.
 */
export const POI_BOARD_FIXTURES = "packages/mailwoman/lib/eval-harness/fixtures/poi-board.jsonl"

/**
 * Row statuses: `pass` rows count toward floors; tracked failures do not.
 *
 * `known_fail` needs a repair, while `improvement_target` needs a new capability.
 */
export const POI_BOARD_STATUSES = ["pass", "known_fail", "improvement_target"] as const

export type POIBoardStatus = (typeof POI_BOARD_STATUSES)[number]

export interface POIBoardFixture {
	id: string
	query: string
	locale?: string
	expect: POIBoardExpect
	/**
	 * Whether this row counts toward floors; defaults to `pass`.
	 */
	status?: POIBoardStatus
	/**
	 * Required live issue reference for tracked rows; disallowed on counted rows.
	 */
	bugRef?: string
	/**
	 * Optional source fixture reference, relative to the eval-harness directory.
	 */
	rowRef?: string
	/**
	 * Free-form authoring note.
	 *
	 * Never graded.
	 */
	note?: string
}

/**
 * Allowed fixture keys; unknown keys are rejected rather than ignored.
 */
const FIXTURE_KEYS = new Set<string>(["id", "query", "locale", "expect", "status", "bugRef", "rowRef", "note"])

/**
 * Return the row status, defaulting to `pass`.
 */
function fixtureStatus(fixture: POIBoardFixture): POIBoardStatus {
	return fixture.status ?? "pass"
}

/**
 * Whether this row's grade reaches the floors.
 */
export function isCountedFixture(fixture: POIBoardFixture): boolean {
	return fixtureStatus(fixture) === "pass"
}

/**
 * Validate committed fixtures before pipeline construction.
 */
export function auditFixtures(fixtures: readonly POIBoardFixture[]): string[] {
	const problems: string[] = []
	const seen = new Set<string>()

	for (const fixture of fixtures) {
		const label = `poi board fixture ${stringifyJSON(fixture.id)}`

		if (seen.has(fixture.id)) {
			problems.push(`${label}: id is used twice — ids name rows in output`)
		}

		seen.add(fixture.id)

		for (const key of Object.keys(fixture)) {
			if (!FIXTURE_KEYS.has(key)) {
				problems.push(`${label}: unknown key ${stringifyJSON(key)} — known: ${[...FIXTURE_KEYS].join(", ")}`)
			}
		}

		const rawStatus: unknown = fixture.status

		if (rawStatus !== undefined && !(POI_BOARD_STATUSES as readonly unknown[]).includes(rawStatus)) {
			problems.push(`${label}: unknown status ${stringifyJSON(rawStatus)} — known: ${POI_BOARD_STATUSES.join(", ")}`)

			continue
		}

		const counted = isCountedFixture(fixture)

		if (counted && fixture.bugRef !== undefined) {
			problems.push(
				`${label}: "bugRef" is only meaningful on a tracked row, and this row's status is ` +
					`"${fixtureStatus(fixture)}" — a counted row that names a defect asserts the defect is repaired.`
			)
		}

		if (!counted && !fixture.bugRef?.trim()) {
			problems.push(
				`${label}: a tracked row must name the live issue its diagnosis lives on in "bugRef" — a tracked row ` +
					`with nowhere to read is a failure nobody can act on.`
			)
		}
	}

	return problems
}

/**
 * Pipeline fields needed for grading.
 */
export interface POIBoardOutcome {
	path: PipelineResult["path"]
	poiIntent?: POIIntentOutcome
}

export interface CaseGrade {
	id: string
	query: string
	expectKind: POIBoardExpect["kind"]
	pass: boolean
	detail: string
	/**
	 * Distance (km) from the fixture's `anchorGold` to the nearest returned result — `results` cases only.
	 */
	nearestKm?: number
	resultCount?: number
}

/**
 * Grade one case without pipeline construction or I/O.
 */
export function gradeCase(fixture: POIBoardFixture, outcome: POIBoardOutcome): CaseGrade {
	const tookPoiPath = outcome.path === "poi" && outcome.poiIntent !== undefined
	const expect = fixture.expect

	if (expect.kind === "address") {
		return tookPoiPath
			? {
					id: fixture.id,
					query: fixture.query,
					expectKind: "address",
					pass: false,
					detail: `expected the address path, but the poi branch claimed it (${outcome.poiIntent?.type})`,
				}
			: {
					id: fixture.id,
					query: fixture.query,
					expectKind: "address",
					pass: true,
					detail: "address path (no poi claim)",
				}
	}

	if (!tookPoiPath) {
		return {
			id: fixture.id,
			query: fixture.query,
			expectKind: expect.kind,
			pass: false,
			detail: `expected a poi outcome (${expect.kind}), got path=${outcome.path} (no poi intent)`,
		}
	}

	const poiOutcome = outcome.poiIntent!

	if (expect.kind === "abstain") {
		if (poiOutcome.type !== "abstain") {
			return {
				id: fixture.id,
				query: fixture.query,
				expectKind: "abstain",
				pass: false,
				detail: `expected abstain(${expect.reason}), got type=intent (${poiOutcome.results?.length ?? 0} results)`,
			}
		}

		const pass = poiOutcome.reason === expect.reason

		return {
			id: fixture.id,
			query: fixture.query,
			expectKind: "abstain",
			pass,
			detail: pass
				? `abstain: ${poiOutcome.reason}`
				: `expected abstain(${expect.reason}), got abstain(${poiOutcome.reason})`,
		}
	}

	// expect.kind === "results". Either a categoryID or a brandWikidata expectation (never both).
	const expectedLabel =
		expect.brandWikidata !== undefined ? `brandWikidata=${expect.brandWikidata}` : `categoryID=${expect.categoryID}`

	if (poiOutcome.type !== "intent") {
		return {
			id: fixture.id,
			query: fixture.query,
			expectKind: "results",
			pass: false,
			detail: `expected results (${expectedLabel}), got abstain(${poiOutcome.reason})`,
		}
	}

	const results = poiOutcome.results ?? []

	if (!results.length) {
		return {
			id: fixture.id,
			query: fixture.query,
			expectKind: "results",
			pass: false,
			detail: `expected ≥1 result (${expectedLabel}), got 0`,
			resultCount: 0,
		}
	}

	const nearestKm = Math.min(
		...results.map((r) => haversineKm(r.latitude, r.longitude, expect.anchorGold.latitude, expect.anchorGold.longitude))
	)

	const withinRange = nearestKm <= expect.maxNearestKm

	// Brand and category checks use the same "top field, mismatch phrase"
	// shape (`top <field> <got> !== expected <want>`).
	// Kept as two branches (not a single templated string) so the category branch's exact
	// wording stays byte-stable against v1 assertions (`top category X !== expected Y`).
	const topCategoryID = results[0]!.categoryID
	const topBrandWikidata = results[0]!.brandWikidata

	const topMatches =
		expect.brandWikidata !== undefined ? topBrandWikidata === expect.brandWikidata : topCategoryID === expect.categoryID

	const topSummary =
		expect.brandWikidata !== undefined ? `top brandWikidata ${topBrandWikidata}` : `top category ${topCategoryID}`

	const mismatchDetail =
		expect.brandWikidata !== undefined
			? `top brandWikidata ${topBrandWikidata} !== expected ${expect.brandWikidata}`
			: `top category ${topCategoryID} !== expected ${expect.categoryID}`

	const pass = withinRange && topMatches

	const detail = pass
		? `${results.length} results, nearest ${nearestKm.toFixed(2)} km, ${topSummary}`
		: [
				!withinRange ? `nearest ${nearestKm.toFixed(2)} km > maxNearestKm ${expect.maxNearestKm}` : undefined,
				!topMatches ? mismatchDetail : undefined,
			]
				.filter((reason) => reason != null)
				.join("; ")

	return {
		id: fixture.id,
		query: fixture.query,
		expectKind: "results",
		pass,
		detail,
		nearestKm,
		resultCount: results.length,
	}
}

/**
 * One tracked row's grade, carried with the record that says why it is tracked.
 */
export interface TrackedCase {
	grade: CaseGrade
	status: POIBoardStatus
	/**
	 * The live issue this row's diagnosis lives on.
	 *
	 * Never blank — {@linkcode auditFixtures} refuses a tracked row without one.
	 */
	bugRef: string
	rowRef?: string
	note?: string
	/**
	 * True when a tracked row passed.
	 *
	 * Printed as a promotion instruction rather than silently absorbed.
	 */
	holding: boolean
}

/**
 * The two populations a run produces: the rows the floors read, and the rows that only report.
 */
export interface CasePartition {
	counted: CaseGrade[]
	tracked: TrackedCase[]
}

/**
 * Split graded cases by their fixture's status.
 *
 * Pure, and keyed by id rather than by position.
 * A grade whose id names no fixture is refused rather than dropped, because a dropped
 * grade leaves the floors reading a smaller board and reports as a higher pass rate.
 */
export function partitionCases(fixtures: readonly POIBoardFixture[], grades: readonly CaseGrade[]): CasePartition {
	const byID = new Map(fixtures.map((fixture) => [fixture.id, fixture]))
	const counted: CaseGrade[] = []
	const tracked: TrackedCase[] = []

	for (const grade of grades) {
		const fixture = byID.get(grade.id)

		if (!fixture) {
			throw new Error(`poi board: graded case ${stringifyJSON(grade.id)} names no committed fixture`)
		}

		if (isCountedFixture(fixture)) {
			counted.push(grade)

			continue
		}

		tracked.push({
			grade,
			status: fixtureStatus(fixture),
			bugRef: fixture.bugRef ?? "",
			...(fixture.rowRef ? { rowRef: fixture.rowRef } : {}),
			...(fixture.note ? { note: fixture.note } : {}),
			holding: grade.pass,
		})
	}

	return { counted, tracked }
}

export interface QuantileStats {
	count: number
	min: number
	p50: number
	p95: number
	max: number
}

/**
 * Pre-registered assembled-answer floors (spec §3.6).
 *
 * Overall pass rate must reach 90%; abstain and address-guard cases require 100%.
 */
export const POI_BOARD_FLOORS = {
	overall: 0.9,
	abstain: 1,
	address: 1,
} as const

/**
 * One evaluated floor, printed on every run and enforced by `--enforce`.
 */
export interface FloorLine {
	/**
	 * The floor key (`overall` / `abstain` / `address`).
	 */
	key: keyof typeof POI_BOARD_FLOORS
	/**
	 * Human label for the printed line.
	 */
	label: string
	/**
	 * Observed pass rate (0..1) for this kind.
	 */
	observed: number
	/**
	 * The required floor (0..1).
	 */
	floor: number
	/**
	 * Whether the observed rate meets the floor; empty categories do not pass.
	 */
	met: boolean
	/**
	 * `pass/total` for the kind (or `0/0` when the kind is absent), for the printed line.
	 */
	fraction: string
}

export interface FloorEvaluation {
	lines: FloorLine[]
	/**
	 * True when any floor line is unmet — the signal `--enforce` turns into a non-zero exit.
	 */
	breached: boolean
}

/**
 * The subset of a report `evaluateFloors` reads.
 * Kept narrow so tests can hand in a synthetic result set.
 */
export interface FloorInput {
	overallPassRate: number
	byExpectKind: Record<string, { total: number; pass: number; rate: number }>
}

/**
 * Evaluate registered floors against a report; an empty category does not pass.
 */
export function evaluateFloors(report: FloorInput): FloorEvaluation {
	const categoryLine = (key: "abstain" | "address", label: string): FloorLine => {
		const bucket = report.byExpectKind[key]
		const floor = POI_BOARD_FLOORS[key]
		const total = bucket?.total ?? 0
		const pass = bucket?.pass ?? 0
		// An absent kind can't clear a 100% floor — grading nothing is not the same as grading everything right.
		const observed = total > 0 ? pass / total : 0

		return { key, label, observed, floor, met: total > 0 && observed >= floor, fraction: `${pass}/${total}` }
	}

	const overallTotal = Object.values(report.byExpectKind).reduce((sum, b) => sum + b.total, 0)
	const overallPass = Object.values(report.byExpectKind).reduce((sum, b) => sum + b.pass, 0)

	const overallLine: FloorLine = {
		key: "overall",
		label: "overall",
		observed: report.overallPassRate,
		floor: POI_BOARD_FLOORS.overall,
		met: report.overallPassRate >= POI_BOARD_FLOORS.overall,
		fraction: `${overallPass}/${overallTotal}`,
	}

	const lines = [overallLine, categoryLine("abstain", "abstain"), categoryLine("address", "address-guard")]

	return { lines, breached: lines.some((line) => !line.met) }
}

export interface POIBoardReport {
	generatedAt: string
	db: string
	/**
	 * Every committed row, tracked ones included.
	 */
	totalCases: number
	/**
	 * The rows the floors read — {@linkcode totalCases} minus {@linkcode trackedCases}.
	 */
	countedCases: number
	/**
	 * Rows carrying a tracked status.
	 *
	 * Run, graded, reported, and never counted toward the floors.
	 */
	trackedCases: number
	/**
	 * Per-expect-kind strata over the counted rows only, which is what the floors read.
	 */
	byExpectKind: Record<string, { total: number; pass: number; rate: number }>
	/**
	 * Pass rate over the counted rows.
	 * The number the `overall` floor is compared against.
	 */
	overallPassRate: number
	/**
	 * Pass rate over every committed row.
	 *
	 * Report-only, and deliberately reported beside the floor number: a reader comparing
	 * the two sees what the tracked rows cost, rather than a single rate that hides them.
	 */
	allCasesPassRate: number
	/**
	 * Pre-registered floors graded against this report (spec §3.6).
	 *
	 * Printed on every run.
	 * Enforced under `--enforce`.
	 */
	floors: FloorEvaluation
	/**
	 * Tracked rows with the record that says why.
	 *
	 * A tracked row whose `holding` is true is printed as a promotion instruction.
	 */
	tracked: TrackedCase[]
	/**
	 * Report-only metrics over every `POIResult` row returned across all cases (any expect kind).
	 */
	resultRowCount: number
	gersIDPresentRate: number
	ancestryPresentRate: number
	nearestKmStats: QuantileStats | null
	cases: CaseGrade[]
}

export interface POIBoardRunResult {
	report: POIBoardReport
	exitCode: number
}

/**
 * Linearly interpolate between adjacent order statistics for distance summaries.
 */
function quantile(sorted: number[], q: number): number {
	if (!sorted.length) return Number.NaN

	if (sorted.length === 1) return sorted[0]!
	const idx = q * (sorted.length - 1)
	const lo = Math.floor(idx)
	const hi = Math.ceil(idx)

	if (lo === hi) return sorted[lo]!

	return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo)
}

function computeStats(values: number[]): QuantileStats | null {
	if (!values.length) return null
	const sorted = [...values].toSorted((a, b) => a - b)

	return {
		count: sorted.length,
		min: sorted[0]!,
		p50: quantile(sorted, 0.5),
		p95: quantile(sorted, 0.95),
		max: sorted.at(-1)!,
	}
}

/**
 * One constructed board pipeline, with the database it queries and the handle that closes its resolver.
 */
export async function runPOIBoard(options: POIBoardOptions = {}): Promise<POIBoardRunResult> {
	const fixturesPath = options.fixturesPath ?? POI_BOARD_FIXTURES

	const fixtures = await JSONSpliterator.fromAsync<POIBoardFixture>(fixturesPath).toArray()

	if (!fixtures.length) throw new Error(`poi board: no fixtures found at ${fixturesPath}`)

	const fixtureProblems = auditFixtures(fixtures)

	if (fixtureProblems.length) {
		throw new Error(
			[`poi board: ${fixturesPath} is not loadable:`, ...fixtureProblems.map((p) => `  - ${p}`)].join("\n")
		)
	}

	using pipelineHandle = await createPOIBoardPipeline(options)
	const { pipeline, db } = pipelineHandle

	const cases: CaseGrade[] = []
	const nearestKms: number[] = []
	let resultRowCount = 0
	let gersIDPresent = 0
	let ancestryPresent = 0

	for (const fixture of fixtures) {
		const runOpts: PipelineOpts = fixture.locale ? { locale: fixture.locale } : {}
		const result = await pipeline(fixture.query, runOpts)
		const outcome: POIBoardOutcome = { path: result.path, poiIntent: result.poiIntent }
		const grade = gradeCase(fixture, outcome)
		cases.push(grade)

		if (grade.nearestKm !== undefined) {
			nearestKms.push(grade.nearestKm)
		}

		if (result.poiIntent?.type === "intent" && result.poiIntent.results) {
			for (const r of result.poiIntent.results) {
				resultRowCount++

				if (r.gersID !== null) {
					gersIDPresent++
				}

				if (r.ancestry && r.ancestry.length) {
					ancestryPresent++
				}
			}
		}
	}

	const { counted, tracked } = partitionCases(fixtures, cases)
	const byExpectKind: POIBoardReport["byExpectKind"] = {}

	for (const grade of counted) {
		const bucket = byExpectKind[grade.expectKind] ?? { total: 0, pass: 0, rate: 0 }

		bucket.total++

		if (grade.pass) {
			bucket.pass++
		}

		byExpectKind[grade.expectKind] = bucket
	}

	for (const bucket of Object.values(byExpectKind)) {
		bucket.rate = bucket.total > 0 ? bucket.pass / bucket.total : 0
	}

	const countedPass = counted.filter((c) => c.pass).length
	const overallPassRate = counted.length ? countedPass / counted.length : 0
	const allPass = cases.filter((c) => c.pass).length

	const report: POIBoardReport = {
		generatedAt: new Date().toISOString(),
		db,
		totalCases: cases.length,
		countedCases: counted.length,
		trackedCases: tracked.length,
		byExpectKind,
		overallPassRate,
		allCasesPassRate: cases.length ? allPass / cases.length : 0,
		floors: evaluateFloors({ overallPassRate, byExpectKind }),
		tracked,
		resultRowCount,
		gersIDPresentRate: resultRowCount > 0 ? gersIDPresent / resultRowCount : 0,
		ancestryPresentRate: resultRowCount > 0 ? ancestryPresent / resultRowCount : 0,
		nearestKmStats: computeStats(nearestKms),
		cases,
	}

	if (!options.quiet) {
		printReport(report)
	}

	// Floors are always graded and printed; `--enforce` is what turns a breach into a non-zero exit.
	return { report, exitCode: options.enforce && report.floors.breached ? 1 : 0 }
}

function printReport(report: POIBoardReport): void {
	console.log(`\nPOI query board (spec §3.6) — floors enforced under --enforce — db: ${report.db}`)

	console.log(
		`${report.totalCases} cases: ${report.countedCases} counted toward the floors, ${report.trackedCases} tracked`
	)

	console.log(
		`${(report.overallPassRate * 100).toFixed(1)}% counted pass rate · ` +
			`${(report.allCasesPassRate * 100).toFixed(1)}% over every committed row\n`
	)

	console.log("  expect kind     n     pass    rate   (counted rows)")

	for (const [kind, bucket] of Object.entries(report.byExpectKind).toSorted()) {
		console.log(
			`  ${kind.padEnd(14)} ${String(bucket.total).padStart(4)}   ${String(bucket.pass).padStart(4)}    ${(bucket.rate * 100).toFixed(1)}%`
		)
	}

	console.log(`\nresult rows returned: ${report.resultRowCount}`)
	console.log(`  gersID non-null rate: ${(report.gersIDPresentRate * 100).toFixed(1)}%`)
	console.log(`  ancestry present rate: ${(report.ancestryPresentRate * 100).toFixed(1)}%`)

	if (report.nearestKmStats) {
		const s = report.nearestKmStats

		console.log(
			`\nnearest-distance distribution (km, results-cases with ≥1 result, n=${s.count}): min ${s.min.toFixed(2)}  p50 ${s.p50.toFixed(2)}  p95 ${s.p95.toFixed(2)}  max ${s.max.toFixed(2)}`
		)
	}

	console.log("\nfloors (spec §3.6):")

	for (const line of report.floors.lines) {
		const mark = line.met ? "✓" : "✗"

		console.log(
			`  ${mark} ${line.label.padEnd(14)} ${(line.observed * 100).toFixed(1)}% (${line.fraction})  floor ${(line.floor * 100).toFixed(0)}%`
		)
	}

	console.log(
		report.floors.breached
			? "  → BREACH: at least one floor unmet (exit non-zero under --enforce)"
			: "  → all floors met"
	)

	const trackedIDs = new Set(report.tracked.map((entry) => entry.grade.id))

	if (report.tracked.length) {
		const stillFailing = report.tracked.filter((entry) => !entry.holding)

		console.log(
			`\n--- ${report.tracked.length} tracked rows (reported, never counted toward the floors): ` +
				`${stillFailing.length} still failing ---`
		)

		for (const entry of report.tracked) {
			const mark = entry.holding ? "✓" : "~"
			const rowRef = entry.rowRef ? ` (row ${entry.rowRef})` : ""

			console.log(
				`  ${mark} [${entry.grade.expectKind}] ${entry.grade.id} [${entry.status} ${entry.bugRef}]${rowRef}: ` +
					stringifyJSON(entry.grade.query)
			)

			console.log(`      ${entry.grade.detail}`)
		}

		const holding = report.tracked.filter((entry) => entry.holding)

		if (holding.length) {
			console.log(`\n⚠ ${holding.length} tracked rows now pass — promote to status=pass and drop their bugRef:`)

			for (const entry of holding) {
				console.log(`  ${entry.grade.id} (${entry.bugRef})`)
			}
		}
	}

	printFailures(report.cases.filter((grade) => !grade.pass && !trackedIDs.has(grade.id)))
}

/**
 * The failing counted rows.
 * The ones a floor breach is made of.
 *
 * Tracked failures print in their own block above, so a reader never has to subtract
 * one list from the other to see what actually moved.
 */
function printFailures(failures: readonly CaseGrade[]): void {
	if (!failures.length) return

	console.log(`\n--- ${failures.length} failing cases ---`)

	for (const f of failures) {
		console.log(`  [${f.expectKind}] ${f.id}: ${stringifyJSON(f.query)}`)
		console.log(`      ${f.detail}`)
	}
}
