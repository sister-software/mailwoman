/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The POI QUERY BOARD (spec §3.6, exotic-POI arc) — a curated, committed panel of ~45 POI-shaped
 *   queries graded on the ASSEMBLED answer (a matched category id + a coordinate near the expected
 *   place), not on label F1. Runs the real `createRuntimePipeline({ poiQueryKind: { poiDatabasePath
 *   } })` surface end-to-end: subject match → anchor parse → anchor resolve → poi.db search, the same
 *   construction `mailwoman poi` uses.
 *
 *   PRE-REGISTRATION DISCIPLINE: this is the FIRST run of this board. There are no floors yet — the
 *   command is report-only (always exits 0 on case failures; a non-zero exit means the HARNESS broke,
 *   not that a case failed). Floors get written in a follow-up PR once the v1 numbers establish a
 *   baseline worth holding. Don't read a case failure here as a regression; there is nothing to
 *   regress FROM yet.
 *
 *   Composition (`fixtures/poi-board.jsonl`, committed): ~22 category+anchor cases spanning all four
 *   currently-shipped poi.db countries (US/CA/MX/FR), ~5 locale-gated-synonym cases (exercising
 *   `@mailwoman/poi-taxonomy`'s locale gating — exact-locale, cross-language, and ungated phrases),
 *   ~6 abstains (3 build-local infra categories that poi.db structurally can't answer, 3 bare
 *   shipped categories with no anchor to search from), ~6 address-guards (full addresses + the
 *   venue-led "category, address" shape — the poi branch must NOT claim these), and ~6
 *   near-miss/robustness cases (comma anchors, multiword synonyms, multi-segment anchors).
 *
 *   Only REACHABLE behavior is scored — no brand/name-subject cases; that detection doesn't exist yet
 *   (spec §3.1 Phase 2). A `results` expectation's `maxNearestKm` is deliberately city-scale (25 km):
 *   this board grades whether the ANCHOR resolved to roughly the right place and the SUBJECT matched
 *   the right category, not sub-block precision.
 *
 *   GRADING (pure, unit-testable without a db — see `poi-board.test.ts`): `gradeCase` takes a fixture
 *   and the pipeline's own outcome shape (`path` + optional `poiIntent`), never the pipeline itself,
 *   so the interval/distance math is tested against synthetic outcomes.
 */

import { existsSync, readFileSync } from "node:fs"

import type { PipelineOpts, PipelineResult, POIIntentOutcome } from "@mailwoman/core/pipeline"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { createWOFResolver, type Resolver } from "@mailwoman/resolver"
import { haversineKm } from "@mailwoman/spatial"
import { createRuntimePipeline } from "mailwoman"

import { createResolverBackend, dataRootPath, wofShardPaths } from "../resolver-backend.ts"

export const POI_BOARD_FIXTURES = "mailwoman/eval-harness/fixtures/poi-board.jsonl"

export interface PoiBoardResultsExpect {
	kind: "results"
	/**
	 * Exactly one of `categoryID` / `brandWikidata` is set per fixture — the grader checks the top result's matching
	 * field. `brandWikidata` cases (part 2 of the brand-lexicon work) assert the top result's `POIResult.brandWikidata`
	 * equals this QID; `categoryID` cases are unchanged from v1.
	 */
	categoryID?: string
	brandWikidata?: string
	anchorGold: { latitude: number; longitude: number }
	maxNearestKm: number
}

export interface PoiBoardAbstainExpect {
	kind: "abstain"
	reason: string
}

export interface PoiBoardAddressExpect {
	kind: "address"
}

export type PoiBoardExpect = PoiBoardResultsExpect | PoiBoardAbstainExpect | PoiBoardAddressExpect

export interface PoiBoardFixture {
	id: string
	query: string
	locale?: string
	expect: PoiBoardExpect
}

/** The slice of a `PipelineResult` grading needs — kept narrow so tests can hand in a fake without building a tree. */
export interface PoiBoardOutcome {
	path: PipelineResult["path"]
	poiIntent?: POIIntentOutcome
}

export interface CaseGrade {
	id: string
	query: string
	expectKind: PoiBoardExpect["kind"]
	pass: boolean
	detail: string
	/** Distance (km) from the fixture's `anchorGold` to the NEAREST returned result — `results` cases only. */
	nearestKm?: number
	resultCount?: number
}

/**
 * Grade one case against the pipeline's outcome. Pure — no I/O, no pipeline construction — so this is the unit-tested
 * core (`poi-board.test.ts`) and the live runner (`runPoiBoard`) is just fixture-load + pipeline-call + this.
 */
export function gradeCase(fixture: PoiBoardFixture, outcome: PoiBoardOutcome): CaseGrade {
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

	// expect.kind === "results" — either a categoryID or a brandWikidata expectation (never both).
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

	if (results.length === 0) {
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

	// Brand and category checks use the SAME "top field, mismatch phrase" shape (`top <field> <got> !== expected <want>`)
	// — kept as two branches (not a single templated string) so the category branch's exact wording stays byte-stable
	// against v1 assertions (`top category X !== expected Y`).
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
				.filter(Boolean)
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

export interface PoiBoardOptions {
	locale?: string
	weightsCacheRoot?: string
	fixturesPath?: string
	/** Sealed poi.db to query. Defaults to the standard data-root layer path — see `gazetteer build poi`'s own default. */
	db?: string
	/** WOF admin shard path(s) for anchor resolution — same semantics as `mailwoman poi --resolve-db`. */
	resolveDb?: string
	/**
	 * Byte-range candidate.db for anchor resolution (demo-parity backend) — same semantics as `mailwoman poi
	 * --candidate-db`.
	 */
	candidateDb?: string
	/** Suppress the human-readable table (the CLI's `--json` mode prints the full report instead). */
	quiet?: boolean
}

/**
 * Build the WOF resolver, mirroring `commands/poi.tsx`'s `tryLoadResolver`: candidate-table backend when configured,
 * else the FTS admin shard set, else no resolver at all (anchored category cases then abstain `anchor_required`,
 * exactly like the CLI probe degrades). Caller owns closing the returned handle.
 */
async function loadResolver(options: PoiBoardOptions): Promise<{ resolver: Resolver; close: () => void } | undefined> {
	const wofPaths = options.candidateDb
		? []
		: (options.resolveDb ? options.resolveDb.split(",").map((p) => p.trim()) : wofShardPaths()).filter((p) =>
				existsSync(p)
			)

	if (!options.candidateDb && wofPaths.length === 0) {
		console.error(
			"note: no WOF resolver configured — anchor localities will not resolve to coordinates, so anchored " +
				"category/brand cases will abstain anchor_required. Set --resolve-db/--candidate-db to fix."
		)

		return undefined
	}

	try {
		const mod = await import("@mailwoman/resolver-wof-sqlite")
		const lookup = createResolverBackend(mod, { candidateDb: options.candidateDb, wofPaths })

		return { resolver: createWOFResolver(lookup), close: () => lookup.close() }
	} catch {
		console.error("note: `@mailwoman/resolver-wof-sqlite` is not installed — anchor localities will not resolve.")

		return undefined
	}
}

export interface QuantileStats {
	count: number
	min: number
	p50: number
	p95: number
	max: number
}

export interface PoiBoardReport {
	generatedAt: string
	db: string
	totalCases: number
	byExpectKind: Record<string, { total: number; pass: number; rate: number }>
	overallPassRate: number
	/** Report-only metrics over every `POIResult` row returned across ALL cases (any expect kind). */
	resultRowCount: number
	gersIDPresentRate: number
	ancestryPresentRate: number
	nearestKmStats: QuantileStats | null
	cases: CaseGrade[]
}

export interface PoiBoardRunResult {
	report: PoiBoardReport
	exitCode: number
}

function quantile(sorted: number[], q: number): number {
	if (sorted.length === 0) return NaN

	if (sorted.length === 1) return sorted[0]!
	const idx = q * (sorted.length - 1)
	const lo = Math.floor(idx)
	const hi = Math.ceil(idx)

	if (lo === hi) return sorted[lo]!

	return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo)
}

function computeStats(values: number[]): QuantileStats | null {
	if (values.length === 0) return null
	const sorted = [...values].sort((a, b) => a - b)

	return {
		count: sorted.length,
		min: sorted[0]!,
		p50: quantile(sorted, 0.5),
		p95: quantile(sorted, 0.95),
		max: sorted[sorted.length - 1]!,
	}
}

/**
 * Build the runtime pipeline once (classifier + resolver + poi executor), run every fixture through it, grade, and
 * aggregate. Mirrors `commands/poi.tsx`'s construction: `NeuralAddressClassifier.loadFromWeights` + the same
 * resolver-backend selector (`resolver-backend.ts`) + `createRuntimePipeline({ poiQueryKind: { poiDatabasePath } })`.
 */
export async function runPoiBoard(options: PoiBoardOptions = {}): Promise<PoiBoardRunResult> {
	const fixturesPath = options.fixturesPath ?? POI_BOARD_FIXTURES
	const fixtures = readFileSync(fixturesPath, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as PoiBoardFixture)

	if (fixtures.length === 0) throw new Error(`poi board: no fixtures found at ${fixturesPath}`)

	const db = options.db ?? dataRootPath("poi", "poi.db")
	const classifier = await NeuralAddressClassifier.loadFromWeights({
		locale: options.locale ?? "en-US",
		cacheRoot: options.weightsCacheRoot,
	})

	const resolverHandle = await loadResolver(options)

	const pipeline = createRuntimePipeline({
		classifier,
		resolver: resolverHandle?.resolver,
		poiQueryKind: { poiDatabasePath: db },
	})

	const cases: CaseGrade[] = []
	const nearestKms: number[] = []
	let resultRowCount = 0
	let gersIDPresent = 0
	let ancestryPresent = 0

	try {
		for (const fixture of fixtures) {
			const runOpts: PipelineOpts = fixture.locale ? { locale: fixture.locale } : {}
			const result = await pipeline(fixture.query, runOpts)
			const outcome: PoiBoardOutcome = { path: result.path, poiIntent: result.poiIntent }
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

					if (r.ancestry && r.ancestry.length > 0) {
						ancestryPresent++
					}
				}
			}
		}
	} finally {
		resolverHandle?.close()
	}

	const byExpectKind: PoiBoardReport["byExpectKind"] = {}

	for (const grade of cases) {
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

	const totalPass = cases.filter((c) => c.pass).length

	const report: PoiBoardReport = {
		generatedAt: new Date().toISOString(),
		db,
		totalCases: cases.length,
		byExpectKind,
		overallPassRate: cases.length > 0 ? totalPass / cases.length : 0,
		resultRowCount,
		gersIDPresentRate: resultRowCount > 0 ? gersIDPresent / resultRowCount : 0,
		ancestryPresentRate: resultRowCount > 0 ? ancestryPresent / resultRowCount : 0,
		nearestKmStats: computeStats(nearestKms),
		cases,
	}

	if (!options.quiet) {
		printReport(report)
	}

	return { report, exitCode: 0 }
}

function printReport(report: PoiBoardReport): void {
	console.log(`\nPOI query board (spec §3.6) — v1, REPORT-ONLY (no floors yet) — db: ${report.db}`)
	console.log(`${report.totalCases} cases, ${(report.overallPassRate * 100).toFixed(1)}% overall pass rate\n`)
	console.log("  expect kind     n     pass    rate")

	for (const [kind, bucket] of Object.entries(report.byExpectKind).sort()) {
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

	const failures = report.cases.filter((c) => !c.pass)

	if (failures.length > 0) {
		console.log(`\n--- ${failures.length} failing cases ---`)

		for (const f of failures) {
			console.log(`  [${f.expectKind}] ${f.id}: ${JSON.stringify(f.query)}`)
			console.log(`      ${f.detail}`)
		}
	}
}
