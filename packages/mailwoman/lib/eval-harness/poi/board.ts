/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   POI query board, which grades committed POI queries against the production pipeline's result and checks the
 *   registered floors.
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
 * Repository-relative path of the POI board fixtures.
 */
export const POI_BOARD_FIXTURES = "packages/mailwoman/lib/eval-harness/fixtures/poi-board.jsonl"

/**
 * Row statuses.
 *
 * Only `pass` rows count toward the floors.
 * A `known_fail` row needs a repair, and an `improvement_target` row needs a new capability.
 */
export const POI_BOARD_STATUSES = ["pass", "known_fail", "improvement_target"] as const

export type POIBoardStatus = (typeof POI_BOARD_STATUSES)[number]

/**
 * One POI board row.
 */
export interface POIBoardFixture {
	id: string
	query: string
	locale?: string
	expect: POIBoardExpect
	/**
	 * Row status.
	 * It defaults to `pass`.
	 */
	status?: POIBoardStatus
	/**
	 * Issue reference that a tracked row requires and a counted row must omit.
	 */
	bugRef?: string
	/**
	 * Source fixture reference, relative to the eval-harness directory.
	 */
	rowRef?: string
	/**
	 * Authoring note.
	 * The board does not grade it.
	 */
	note?: string
}

/**
 * Allowed fixture keys.
 * The audit rejects any other key.
 */
const FIXTURE_KEYS = new Set<string>(["id", "query", "locale", "expect", "status", "bugRef", "rowRef", "note"])

/**
 * Returns the row status, defaulting to `pass`.
 */
function fixtureStatus(fixture: POIBoardFixture): POIBoardStatus {
	return fixture.status ?? "pass"
}

/**
 * Reports whether the row counts toward the floors.
 */
export function isCountedFixture(fixture: POIBoardFixture): boolean {
	return fixtureStatus(fixture) === "pass"
}

/**
 * Audits fixtures for duplicate IDs, unknown keys and statuses, and `bugRef` use.
 * It returns one message per problem.
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
 * Pipeline result fields that grading reads.
 */
export interface POIBoardOutcome {
	path: PipelineResult["path"]
	poiIntent?: POIIntentOutcome
}

/**
 * Grade for one board row.
 */
export interface CaseGrade {
	id: string
	query: string
	expectKind: POIBoardExpect["kind"]
	pass: boolean
	detail: string
	/**
	 * Distance in kilometers from the fixture's `anchorGold` to the nearest result.
	 * Only `results` rows with at least one result set it.
	 */
	nearestKm?: number
	resultCount?: number
}

/**
 * Grades one row from its pipeline outcome.
 * It performs no I/O.
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

	// A `results` expectation sets either `brandWikidata` or `categoryID`.
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

	// Tests assert the exact category wording `top category X !== expected Y`, so each branch spells its text out.
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
 * Grade for a tracked row with the fixture fields that explain why it is tracked.
 */
export interface TrackedCase {
	grade: CaseGrade
	status: POIBoardStatus
	/**
	 * Issue that holds the row's diagnosis. {@linkcode auditFixtures} rejects a tracked row without one.
	 */
	bugRef: string
	rowRef?: string
	note?: string
	/**
	 * Whether the tracked row passed.
	 * The report tells the reader to promote such rows.
	 */
	holding: boolean
}

/**
 * Grades split into counted rows, which the floors read, and tracked rows, which are only reported.
 */
export interface CasePartition {
	counted: CaseGrade[]
	tracked: TrackedCase[]
}

/**
 * Splits grades by their fixture's status, matching grades to fixtures by ID.
 *
 * @throws When a grade's ID matches no fixture.
 * Dropping it would shrink the board and inflate the pass rate.
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

/**
 * Summary statistics for a list of distances.
 */
export interface QuantileStats {
	count: number
	min: number
	p50: number
	p95: number
	max: number
}

/**
 * Pre-registered floors as pass-rate fractions.
 *
 * The overall floor is 90%, and abstain and address-guard rows must all pass.
 */
export const POI_BOARD_FLOORS = {
	overall: 0.9,
	abstain: 1,
	address: 1,
} as const

/**
 * One evaluated floor.
 */
export interface FloorLine {
	key: keyof typeof POI_BOARD_FLOORS
	/**
	 * Label for the printed line.
	 */
	label: string
	/**
	 * Observed pass rate as a fraction from 0 to 1.
	 */
	observed: number
	/**
	 * Required pass rate as a fraction from 0 to 1.
	 */
	floor: number
	/**
	 * Whether the observed rate meets the floor.
	 * A category with no rows fails.
	 */
	met: boolean
	/**
	 * Passing and total rows as `pass/total`.
	 */
	fraction: string
}

/**
 * Evaluated floors and whether any of them failed.
 */
export interface FloorEvaluation {
	lines: FloorLine[]
	/**
	 * Whether any floor is unmet.
	 * Under `--enforce`, a breach produces a non-zero exit code.
	 */
	breached: boolean
}

/**
 * Report fields that {@link evaluateFloors} reads.
 */
export interface FloorInput {
	overallPassRate: number
	byExpectKind: Record<string, { total: number; pass: number; rate: number }>
}

/**
 * Evaluates the registered floors against a report.
 */
export function evaluateFloors(report: FloorInput): FloorEvaluation {
	const categoryLine = (key: "abstain" | "address", label: string): FloorLine => {
		const bucket = report.byExpectKind[key]
		const floor = POI_BOARD_FLOORS[key]
		const total = bucket?.total ?? 0
		const pass = bucket?.pass ?? 0
		// A category with no rows fails its floor, because an empty category proves no fact.
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

/**
 * Complete POI board report.
 */
export interface POIBoardReport {
	generatedAt: string
	db: string
	/**
	 * Number of committed rows, including tracked rows.
	 */
	totalCases: number
	/**
	 * Number of rows that the floors read, which is {@linkcode totalCases} minus {@linkcode trackedCases}.
	 */
	countedCases: number
	/**
	 * Number of tracked rows.
	 *
	 * They are graded and reported and never count toward the floors.
	 */
	trackedCases: number
	/**
	 * Pass counts per expectation kind over the counted rows.
	 */
	byExpectKind: Record<string, { total: number; pass: number; rate: number }>
	/**
	 * Pass rate over the counted rows, which the `overall` floor reads.
	 */
	overallPassRate: number
	/**
	 * Pass rate over every committed row.
	 *
	 * It is printed beside the counted rate to show the effect of tracked rows.
	 */
	allCasesPassRate: number
	floors: FloorEvaluation
	tracked: TrackedCase[]
	/**
	 * Number of POI results returned across all rows.
	 * The two rates below are fractions of this count.
	 */
	resultRowCount: number
	gersIDPresentRate: number
	ancestryPresentRate: number
	nearestKmStats: QuantileStats | null
	cases: CaseGrade[]
}

/**
 * Board report and the exit code for the command.
 */
export interface POIBoardRunResult {
	report: POIBoardReport
	exitCode: number
}

/**
 * Returns the `q` quantile of a sorted list by linear interpolation between neighboring values.
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
 * Runs every fixture through one board pipeline, grades the rows, evaluates the floors,
 * and prints the report unless `quiet` is set.
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
 * Prints the failing counted rows.
 * Tracked failures print in their own block.
 */
function printFailures(failures: readonly CaseGrade[]): void {
	if (!failures.length) return

	console.log(`\n--- ${failures.length} failing cases ---`)

	for (const f of failures) {
		console.log(`  [${f.expectKind}] ${f.id}: ${stringifyJSON(f.query)}`)
		console.log(`      ${f.detail}`)
	}
}
