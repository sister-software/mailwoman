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
 *   FLOORS (spec §3.6, set off the v1 baseline): `overall ≥ 90%`, `abstain = 100%`, `address = 100%`
 *   (`POI_BOARD_FLOORS` / `evaluateFloors`, pre-registered in
 *   `docs/articles/evals/2026-07-19-poi-query-board-v1-baseline.md`). Floors are graded and printed on
 *   EVERY run; a breach only turns into a non-zero exit under `--enforce`. Without `--enforce` the
 *   command stays report-only (exit 0 on case failures; a non-zero exit then means the HARNESS broke —
 *   missing fixtures, missing db, a pipeline construction error — not a graded case failing).
 *
 *   Composition (`fixtures/poi-board.jsonl`, committed): ~22 category+anchor cases spanning all four
 *   currently-shipped poi.db countries (US/CA/MX/FR), ~5 locale-restricted-synonym cases (exercising
 *   `@mailwoman/poi-taxonomy`'s locale filtering — exact-locale, cross-language, and unrestricted phrases),
 *   ~6 abstains (3 build-local infra categories that poi.db structurally can't answer, 3 bare
 *   shipped categories with no anchor to search from), ~6 address-guards (full addresses + the
 *   venue-led "category, address" shape — the poi branch must NOT claim these), ~6
 *   near-miss/robustness cases (comma anchors, multiword synonyms, multi-segment anchors), the
 *   4-row activity-phrased family promoted from the semantic-utility pre-registration, and one further
 *   activity-phrased row committed for the US drugstore recall gap the wave-1 semantics address.
 *
 *   THE ACTIVITY FAMILY NEEDS THE `--semantic-observation` ARM. Its five subjects reach no committed
 *   lexicon entry, so with the opt-in rung absent the query takes no POI branch at all and every one of
 *   them reads as `path=full`. They are tracked for that reason, and the floors are registered against
 *   the arm-OFF construction — the one that ships. Turning the arm on measures the capability; it does
 *   not move the floors, and a row that would move them is a row being counted.
 *
 *   TRACKED ROWS. A fixture may carry `status` + `bugRef`, the conformance layer's own convention
 *   ({@linkcode POI_BOARD_STATUSES}). A tracked row is run and REPORTED and its grade never reaches the
 *   floors, so a failure class can live on the surface every candidate is graded on before the work that
 *   answers it exists. Two rules keep the tracked list from becoming a place rows go to be forgotten: a
 *   tracked row must name a live issue, and a tracked row that starts passing is printed as a promotion
 *   instruction. A red row is never deleted to make a run green, and it is never re-stated as a weaker
 *   expectation either — a row rewritten to assert the current wrong answer would fail the moment the
 *   defect is repaired.
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

import { pathExists } from "@mailwoman/core/fs/readers"
import type { PipelineOpts, PipelineResult, POIIntentOutcome } from "@mailwoman/core/pipeline"
import type { Resolver } from "@mailwoman/core/resolver"
import { dataRootPath, wofExtractPaths } from "@mailwoman/core/utils"
import type { POIPhraseLookup } from "@mailwoman/kind-classifier"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { createWOFResolver } from "@mailwoman/resolver"
import { haversineKm } from "@mailwoman/spatial"
import { resolvePath, type PathBuilderLike } from "path-ts"
import { JSONSpliterator } from "spliterator"

import { createRuntimePipeline } from "#index"
import { createResolverBackend } from "#resolver-backend"
/**
 * Fixture set backing the POI query board.
 */
export const POI_BOARD_FIXTURES = "packages/mailwoman/lib/eval-harness/fixtures/poi-board.jsonl"

export interface POIBoardResultsExpect {
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

export interface POIBoardAbstainExpect {
	kind: "abstain"
	reason: string
}

export interface POIBoardAddressExpect {
	kind: "address"
}

export type POIBoardExpect = POIBoardResultsExpect | POIBoardAbstainExpect | POIBoardAddressExpect

/**
 * What a row's grade is allowed to mean for the floors — the conformance layer's own `ConformanceStatus` vocabulary
 * (`conformance/fixture.ts`), restated here because this board grades an assembled answer rather than a law relation
 * and must not import a law schema to say so.
 *
 * - `pass` — the default, and the only status the floors read. A `pass` row that fails lowers the floor rates.
 * - `known_fail` — the row fails because of a live DEFECT: the default path answers, and the answer is wrong.
 * - `improvement_target` — the row fails because a capability it needs is not on the default path at all.
 *
 * The difference between the two tracked statuses is what would move the row: a repair for `known_fail`, a capability
 * for `improvement_target`. Both are run and reported, and neither reaches the floors.
 */
export const POI_BOARD_STATUSES = ["pass", "known_fail", "improvement_target"] as const

export type POIBoardStatus = (typeof POI_BOARD_STATUSES)[number]

export interface POIBoardFixture {
	id: string
	query: string
	locale?: string
	expect: POIBoardExpect
	/**
	 * Whether this row's grade is counted toward the floors. Absent means `pass` — a row says nothing about its status
	 * only when it is expected to hold.
	 */
	status?: POIBoardStatus
	/**
	 * The live issue a tracked row's diagnosis lives on, e.g. `#1039`. Required on a tracked row, and refused on a
	 * counted one: a counted row that names a defect asserts the defect is already repaired.
	 */
	bugRef?: string
	/**
	 * The committed record this row was promoted from, as `file#id` — e.g.
	 * `semantic-utility/probe-definition.json#sem-act-us-01`, relative to `packages/mailwoman/lib/eval-harness/`. Carried
	 * so a promoted row names the population it came from rather than reading as authored here.
	 */
	rowRef?: string
	/**
	 * Free-form authoring note. Never graded.
	 */
	note?: string
}

/**
 * Every key a fixture record may carry. An unknown key is refused rather than dropped: a plain object silently discards
 * a misspelled field, so a row meant to be tracked would reach the floors while reading as authored — and the board
 * would then turn red for a reason nobody wrote.
 */
const FIXTURE_KEYS = new Set<string>(["id", "query", "locale", "expect", "status", "bugRef", "rowRef", "note"])

/**
 * The status a row grades under. Absent is `pass`, so every committed row before the tracked convention existed keeps
 * counting toward the floors without carrying a field.
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
 * Everything that must be true of the committed fixture set, checked without running anything. One message per problem,
 * each naming the row id. Empty means the set is loadable.
 *
 * Pure, so `poi-board.test.ts` exercises every refusal against synthetic rows, and `runPOIBoard` refuses the real file
 * before it builds a pipeline.
 */
export function auditFixtures(fixtures: readonly POIBoardFixture[]): string[] {
	const problems: string[] = []
	const seen = new Set<string>()

	for (const fixture of fixtures) {
		const label = `poi board fixture ${JSON.stringify(fixture.id)}`

		if (seen.has(fixture.id)) {
			problems.push(`${label}: id is used twice — ids name rows in output`)
		}

		seen.add(fixture.id)

		for (const key of Object.keys(fixture)) {
			if (!FIXTURE_KEYS.has(key)) {
				problems.push(`${label}: unknown key ${JSON.stringify(key)} — known: ${[...FIXTURE_KEYS].join(", ")}`)
			}
		}

		const rawStatus: unknown = fixture.status

		if (rawStatus !== undefined && !(POI_BOARD_STATUSES as readonly unknown[]).includes(rawStatus)) {
			problems.push(`${label}: unknown status ${JSON.stringify(rawStatus)} — known: ${POI_BOARD_STATUSES.join(", ")}`)

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
 * The slice of a `PipelineResult` grading needs — kept narrow so tests can hand in a fake without building a tree.
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
	 * Distance (km) from the fixture's `anchorGold` to the NEAREST returned result — `results` cases only.
	 */
	nearestKm?: number
	resultCount?: number
}

/**
 * Grade one case against the pipeline's outcome. Pure — no I/O, no pipeline construction — so this is the unit-tested
 * core (`poi-board.test.ts`) and the live runner (`runPOIBoard`) is just fixture-load + pipeline-call + this.
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
	 * The live issue this row's diagnosis lives on. Never blank — {@linkcode auditFixtures} refuses a tracked row without
	 * one.
	 */
	bugRef: string
	rowRef?: string
	note?: string
	/**
	 * True when a tracked row passed. Printed as a promotion instruction rather than silently absorbed.
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
 * Split graded cases by their fixture's status. Pure, and keyed by id rather than by position — a grade whose id names
 * no fixture is REFUSED rather than dropped, because a dropped grade leaves the floors reading a smaller board and
 * reports as a higher pass rate.
 */
export function partitionCases(fixtures: readonly POIBoardFixture[], grades: readonly CaseGrade[]): CasePartition {
	const byID = new Map(fixtures.map((fixture) => [fixture.id, fixture]))
	const counted: CaseGrade[] = []
	const tracked: TrackedCase[] = []

	for (const grade of grades) {
		const fixture = byID.get(grade.id)

		if (!fixture) {
			throw new Error(`poi board: graded case ${JSON.stringify(grade.id)} names no committed fixture`)
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

export interface POIBoardOptions {
	locale?: string
	weightsCacheRoot?: string
	fixturesPath?: string
	/**
	 * Sealed poi.db to query. Defaults to the standard data-root layer path — see `gazetteer build poi`'s own default.
	 */
	db?: PathBuilderLike
	/**
	 * WOF admin database path(s) for anchor resolution — same semantics as `mailwoman poi --resolve-db`.
	 */
	resolveDB?: string
	/**
	 * Byte-range candidate.db for anchor resolution (demo-parity backend) — same semantics as `mailwoman poi
	 * --candidate-db`.
	 */
	candidateDB?: string
	/**
	 * Suppress the human-readable table (the CLI's `--json` mode prints the full report instead).
	 */
	quiet?: boolean
	/**
	 * Enforce the pre-registered floors: return a non-zero exit code on any breach (floors are always printed).
	 */
	enforce?: boolean
	/**
	 * An additional positive-evidence phrase rung for the constructed pipeline, consulted only after the committed
	 * lexicon and the POI name lookup have both returned nothing (`CreateRuntimePipelineOpts.poiSemanticLookup`).
	 *
	 * Carried on the board's own options so a probe measuring an injected route runs through the SAME construction the
	 * board does. Absent — the default — constructs the pipeline the board has always constructed.
	 */
	poiSemanticLookup?: POIPhraseLookup
	/**
	 * Build `mailwoman/observations`' semantic route and inject it as {@linkcode poiSemanticLookup}.
	 *
	 * DEFAULT OFF, and the floors are registered against the off arm: the board grades the construction that ships, and a
	 * floor measured under an opt-in rung would describe a pipeline no caller runs. On, it measures the activity-phrase
	 * family — the rows whose subject reaches no committed lexicon entry, and which therefore take no POI branch at all
	 * with the rung absent. Ignored when {@linkcode poiSemanticLookup} is supplied directly.
	 */
	semanticObservation?: boolean
}

/**
 * Build the WOF resolver, mirroring `commands/poi.tsx`'s `tryLoadResolver`: candidate-table backend when configured,
 * else the FTS admin database set, else no resolver at all (anchored category cases then abstain `anchor_required`,
 * exactly like the CLI probe degrades). Caller owns closing the returned handle.
 */
async function loadResolver(
	options: POIBoardOptions
): Promise<({ resolver: Resolver; backend: POIBoardResolverBackend } & Disposable) | undefined> {
	const wofCandidates = options.candidateDB
		? []
		: options.resolveDB
			? options.resolveDB.split(",").map((p) => p.trim())
			: wofExtractPaths()

	const wofPaths = (await Promise.all(wofCandidates.map(async (path) => ({ path, exists: await pathExists(path) }))))
		.filter((entry) => entry.exists)
		.map((entry) => entry.path)

	if (!options.candidateDB && !wofPaths.length) {
		console.error(
			"note: no WOF resolver configured — anchor localities will not resolve to coordinates, so anchored " +
				"category/brand cases will abstain anchor_required. Set --resolve-db/--candidate-db to fix."
		)

		return undefined
	}

	try {
		const mod = await import("@mailwoman/resolver-wof-sqlite")
		const lookup = await createResolverBackend(mod, { candidateDB: options.candidateDB, wofPaths })

		return {
			resolver: createWOFResolver(lookup),
			[Symbol.dispose]: () => lookup[Symbol.dispose](),
			backend: lookup instanceof mod.WOFCandidateTableLookup ? "candidate" : "wof-fts",
		}
	} catch {
		console.error("note: `@mailwoman/resolver-wof-sqlite` is not installed — anchor localities will not resolve.")

		return undefined
	}
}

/**
 * Which lookup answered anchor resolution. Reported rather than re-derived: `createResolverBackend` falls back to the
 * convention candidate path, so a caller that reads only its own options names the wrong backend on any box where that
 * file exists.
 */
export type POIBoardResolverBackend = "candidate" | "wof-fts" | "none"

export interface QuantileStats {
	count: number
	min: number
	p50: number
	p95: number
	max: number
}

/**
 * Pre-registered pass-rate floors for the board (spec §3.6). Set in the follow-up PR after the v1 baseline
 * (`docs/articles/evals/2026-07-19-poi-query-board-v1-baseline.md`) established numbers to hold against.
 *
 * RE-REGISTERED when the activity-phrased family was promoted (#1960), and the three numbers are the whole argument.
 * Before: 51 rows, 49 pass, 96.1% against a 0.90 floor. After, with the four promoted activity rows tracked: the floors
 * read 51 rows, 49 pass, 96.1% — the same denominator, the same numerator, the same comparison. The counterfactual is
 * why the tracked convention is what carries them: had the four counted, 49/55 = 89.1% would sit BELOW the 0.90 floor,
 * so committing a known failure class would have turned the board red without any candidate changing, and lowering the
 * floor to admit them would have loosened the bar every other row is held to.
 *
 * That is also why a later tracked row needs no re-registration and must not get one: it moves the committed total and
 * leaves the counted set the floors read exactly where it was. A row that would move these numbers is a row being
 * COUNTED, and that is the change to argue for.
 *
 * - `overall` ≥ 0.90 — the assembled-answer pass rate over the rows the floors read. A soft floor: coverage gaps in
 *   poi.db (the `trail`/`supermarket` holdouts) are allowed to cost a few points without failing the board.
 * - `abstain` = 1.00 — every abstain case must abstain for the right reason. A hard floor: an abstain miss means the poi
 *   branch claimed a query poi.db structurally cannot answer, the exact false-positive this board guards.
 * - `address` = 1.00 — every address-guard case must stay on the address path. A hard floor for the same reason: the poi
 *   branch must never hijack a full address.
 */
export const POI_BOARD_FLOORS = {
	overall: 0.9,
	abstain: 1,
	address: 1,
} as const

/**
 * One graded floor line — printed on every run, and the breach unit `--enforce` keys its exit code off.
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
	 * Observed pass rate (0..1) for this slice.
	 */
	observed: number
	/**
	 * The required floor (0..1).
	 */
	floor: number
	/**
	 * `observed >= floor` — a missing slice (no cases of that kind) counts as NOT met.
	 */
	met: boolean
	/**
	 * `pass/total` for the slice (or `0/0` when the slice is absent), for the printed line.
	 */
	fraction: string
}

export interface FloorEvaluation {
	lines: FloorLine[]
	/**
	 * True when ANY floor line is unmet — the signal `--enforce` turns into a non-zero exit.
	 */
	breached: boolean
}

/**
 * The slice of a report `evaluateFloors` reads — kept narrow so tests can hand in a synthetic result set.
 */
export interface FloorInput {
	overallPassRate: number
	byExpectKind: Record<string, { total: number; pass: number; rate: number }>
}

/**
 * Grade a report against {@link POI_BOARD_FLOORS}. Pure — no I/O, no pipeline — so breach detection is unit-tested
 * against synthetic reports (`poi-board.test.ts`) without a live board run. A category floor over an absent slice (zero
 * cases of that kind) is treated as UNMET, not vacuously met.
 */
export function evaluateFloors(report: FloorInput): FloorEvaluation {
	const categoryLine = (key: "abstain" | "address", label: string): FloorLine => {
		const bucket = report.byExpectKind[key]
		const floor = POI_BOARD_FLOORS[key]
		const total = bucket?.total ?? 0
		const pass = bucket?.pass ?? 0
		// An absent slice can't clear a 100% floor — grading nothing is not the same as grading everything right.
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
	 * Rows carrying a tracked status. Run, graded, reported, and never counted toward the floors.
	 */
	trackedCases: number
	/**
	 * Per-expect-kind slices over the COUNTED rows only, which is what the floors read.
	 */
	byExpectKind: Record<string, { total: number; pass: number; rate: number }>
	/**
	 * Pass rate over the counted rows — the number the `overall` floor is compared against.
	 */
	overallPassRate: number
	/**
	 * Pass rate over every committed row. Report-only, and deliberately reported beside the floor number: a reader
	 * comparing the two sees what the tracked rows cost, rather than a single rate that hides them.
	 */
	allCasesPassRate: number
	/**
	 * Pre-registered floors graded against this report (spec §3.6). Printed on every run; enforced under `--enforce`.
	 */
	floors: FloorEvaluation
	/**
	 * Tracked rows with the record that says why. A tracked row whose `holding` is true is printed as a promotion
	 * instruction.
	 */
	tracked: TrackedCase[]
	/**
	 * Report-only metrics over every `POIResult` row returned across ALL cases (any expect kind).
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
 * Linear-interpolated quantile — deliberately NOT `percentile` from `@mailwoman/core/utils`.
 *
 * They are different estimators, not two copies of one. Core's is nearest-rank and its docstring warns against
 * "upgrading" it, because the resolver eval baselines were measured with that exact semantics. This one interpolates
 * between the bracketing order statistics, which is what the POI board's distance summaries have always reported.
 * Pointing this at core would shift published board numbers without changing a single measurement.
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
export interface POIBoardPipelineHandle extends Disposable {
	pipeline: (raw: string, runOpts?: PipelineOpts) => Promise<PipelineResult>
	/**
	 * The sealed poi.db the executor queries — carried here so a caller reporting artifact identity reads the path the
	 * pipeline actually opened rather than re-deriving the default.
	 */
	db: string
	/**
	 * Which lookup answered anchor resolution, as built rather than as requested.
	 */
	backend: POIBoardResolverBackend
}

/**
 * Construct the board's pipeline: classifier + resolver + poi executor, exactly as `commands/poi.tsx` builds it
 * (`NeuralAddressClassifier.loadFromWeights` + the shared resolver-backend selector + `createRuntimePipeline({
 * poiQueryKind: { poiDatabasePath } })`).
 *
 * Extracted so a probe that grades with {@link gradeCase} runs against the SAME construction the board does. A second
 * copy of these four calls would let the two drift — a different backend or a different weights locale would change
 * what the probe measures while the grader stayed identical, and the difference would read as a pipeline result.
 */
export async function createPOIBoardPipeline(options: POIBoardOptions = {}): Promise<POIBoardPipelineHandle> {
	const db = resolvePath(options.db ?? dataRootPath("poi", "poi.db"))

	const classifier = await NeuralAddressClassifier.loadFromWeights({
		locale: options.locale ?? "en-US",
		cacheRoot: options.weightsCacheRoot,
	})

	const resolverHandle = await loadResolver(options)
	// A caller-supplied rung wins: the probe hands one in AND drains it afterwards, so building a second here would give
	// it a route whose firings nobody reads.
	const semanticLookup = options.poiSemanticLookup ?? (await buildBoardSemanticLookup(options.semanticObservation))

	const pipeline = createRuntimePipeline({
		classifier,
		resolver: resolverHandle?.resolver,
		poiQueryKind: { poiDatabasePath: db },
		...(semanticLookup ? { poiSemanticLookup: semanticLookup } : {}),
	})

	return {
		pipeline,
		db,
		backend: resolverHandle?.backend ?? "none",
		[Symbol.dispose]: () => resolverHandle?.[Symbol.dispose](),
	}
}

/**
 * The semantic route as a phrase rung, or nothing when the arm was not asked for.
 *
 * Dynamically imported so a board run with the arm off never loads the compiled artifact reader — the same containment
 * `createRuntimePipeline` gets from taking the rung as an argument rather than constructing one.
 */
async function buildBoardSemanticLookup(semanticObservation?: boolean): Promise<POIPhraseLookup | undefined> {
	if (!semanticObservation) return undefined

	const { createSemanticObservationRoute } = await import("#observations/semantic-route")

	return (await createSemanticObservationRoute()).lookup
}

/**
 * Build the runtime pipeline once (classifier + resolver + poi executor), run every fixture through it, grade, and
 * aggregate.
 */
export async function runPOIBoard(options: POIBoardOptions = {}): Promise<POIBoardRunResult> {
	const fixturesPath = options.fixturesPath ?? POI_BOARD_FIXTURES

	const fixtures = await Array.fromAsync(JSONSpliterator.fromAsync<POIBoardFixture>(fixturesPath))

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
					JSON.stringify(entry.grade.query)
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
 * The failing COUNTED rows — the ones a floor breach is made of. Tracked failures print in their own block above, so a
 * reader never has to subtract one list from the other to see what actually moved.
 */
function printFailures(failures: readonly CaseGrade[]): void {
	if (!failures.length) return

	console.log(`\n--- ${failures.length} failing cases ---`)

	for (const f of failures) {
		console.log(`  [${f.expectKind}] ${f.id}: ${JSON.stringify(f.query)}`)
		console.log(`      ${f.detail}`)
	}
}
