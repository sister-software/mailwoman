/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The prominence-floor benchmark asks whether a `minWinningScore` floor reduces invented selections
 *   in every population band. It also checks whether the reduction occurs only where the gold is large enough to clear the floor.
 *
 *   Four phases, run separately so the expensive one happens once:
 *
 *     panel   Execute the frozen selection rules over the per-country GeoNames dumps. Write the panel.
 *     record  Parse every query with the shipped model. Drive the real backend once per arm option set.
 *             Freeze every answer. This is the only phase that touches a gazetteer.
 *     run     Replay the frozen fixture through the five arms. Write the results.
 *     score   Read the results. Decide the registered per-band rule.
 *
 *   Run:
 *     node packages/mailwoman/tools/dev-tools/prominence-floor.run.ts panel
 *     node packages/mailwoman/tools/dev-tools/prominence-floor.run.ts record
 *     node packages/mailwoman/tools/dev-tools/prominence-floor.run.ts run
 *     node packages/mailwoman/tools/dev-tools/prominence-floor.run.ts score
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import type { AddressTree } from "@mailwoman/core/decoder"
import { writeLocalJSONFile, writeLocalJSONLFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { gitHead } from "@mailwoman/core/git"
import { repoRootPath } from "@mailwoman/core/paths"
import { allKeyed } from "@mailwoman/core/promises"
import type { ResolveOpts } from "@mailwoman/core/resolver"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { renderMarkdownTable } from "@mailwoman/core/strings/markdown-table"
import { isoSeconds } from "@mailwoman/core/utils"
import { wofDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import { JSONSpliterator } from "spliterator"

import { readWeightsIdentity } from "#tools/eval-harness/preregistration"
import {
	loadProminenceDefinition,
	type ProminenceFloorDefinition,
} from "#tools/eval-harness/prominence-floor/definition"
import { buildProminencePanel, type ProminencePanelRow } from "#tools/eval-harness/prominence-floor/panel"
import { runResolverArm, type ArmRowResult } from "#tools/eval-harness/same-data/arms"
import { readGoldSets } from "#tools/eval-harness/same-data/concordance"
import {
	assertEqualEvidence,
	fixtureDigest,
	type SameDataFixtureRow,
	validateFixture,
} from "#tools/eval-harness/same-data/fixture"
import { readCities } from "#tools/eval-harness/same-data/panel"
import { recordFixture } from "#tools/eval-harness/same-data/record"
import { renderRatio } from "#tools/eval-harness/same-data/report"
import { armMetrics } from "#tools/eval-harness/same-data/score"

const { values, positionals } = parseArguments({
	options: {
		geonames: { type: "string" },
		gazetteer: { type: "string" },
		backend: { type: "string" },
		out: { type: "string" },
		limit: { type: "string" },
	},
	allowPositionals: true,
})

const GEONAMES = values.geonames || dataRootPath("geonames")
/**
 * The FTS gazetteer supplies the `concordances` and `spr` tables for the identity join.
 *
 * The candidate backend below has no concordance table.
 * The tool therefore accepts separate flags for the two databases.
 */
const GAZETTEER = values.gazetteer || wofDatabasePath("admin-global-priority.db")
/**
 * The backend the recording drives.
 *
 * Defaults to the promoted candidate table used by the shipped geocoder.
 */
const BACKEND = values.backend || wofDatabasePath("candidate.db").toString()
const OUT = values.out || repoRootPath("docs", "static", "benchmarks").toString()

const PANEL_PATH = `${OUT}/prominence-floor-panel.jsonl`
const FIXTURE_PATH = `${OUT}/prominence-floor-candidates.jsonl`
const RESULTS_PATH = `${OUT}/prominence-floor-results.jsonl`
const RECEIPT_PATH = `${OUT}/prominence-floor-receipt.json`
const SCORE_PATH = `${OUT}/prominence-floor-report.md`

/**
 * The frozen decision rule's two conditions, in percentage points.
 *
 * The false-selection rate must fall by at least 10 percentage points against the default arm in every band.
 * Selection accuracy must stay within 5 percentage points of the default arm in every band.
 *
 * These conditions appear in `benchmark-definition.json`.
 * The constants hold these thresholds because the benchmark definition is already frozen.
 *
 * Their inclusion in that definition would change the content hash pinned by the freeze record.
 */
const REQUIRED_FALSE_SELECTION_DROP_POINTS = 10
const ALLOWED_ACCURACY_COST_POINTS = 5

/**
 * Every arm's `ResolveOpts`, in the definition's order.
 *
 * The default arm's empty bag is listed explicitly.
 * Its omission would remove a replay key.
 *
 * `replayBackend` would then raise when the benchmark compares against the default arm.
 */
function armOptionSets(definition: ProminenceFloorDefinition): ResolveOpts[] {
	return definition.arms.map((arm) => ({ ...arm.resolveOpts }))
}

async function panelPhase(): Promise<void> {
	const definition = await loadProminenceDefinition()

	const cities = (
		await Promise.all(definition.goldSource.countries.map((country) => readCities(`${GEONAMES}/${country}.txt`)))
	).flat()

	const { byGeonameID: goldSets, census: goldCensus } = await readGoldSets(GAZETTEER, cities)
	const { rows, census } = buildProminencePanel({ definition, cities, goldSets })

	await writeLocalJSONLFile(rows, PANEL_PATH)

	console.log(`panel: ${rows.length} rows from ${cities.length} register rows → ${PANEL_PATH}`)
	console.table([goldCensus])
	console.table(census)
}

async function recordPhase(): Promise<void> {
	const panel = await JSONSpliterator.fromAsync<ProminencePanelRow>(PANEL_PATH).toArray()
	const limit = values.limit ? Number(values.limit) : panel.length
	const rows = panel.slice(0, limit)

	const {
		definition,
		weights,
		scorer: { createScorer },
		resolver: { WOFCandidateTableLookup },
	} = await allKeyed({
		definition: loadProminenceDefinition(),
		weights: readWeightsIdentity({}),
		scorer: import("@mailwoman/neural/scorer"),
		resolver: import("@mailwoman/resolver-wof-sqlite"),
	})

	const scorer = await createScorer({
		modelPath: weights.weightsModelPath,
		tokenizerPath: weights.weightsModelPath.replace(/model\.onnx$/u, "tokenizer.model"),
		modelCardPath: weights.weightsModelPath.replace(/model\.onnx$/u, "model-card.json"),
		strict: true,
		tier: "server",
	})

	using lookup = new WOFCandidateTableLookup({ databasePath: BACKEND })

	const parse = (query: string): Promise<AddressTree> => scorer.parse(query, { postcodeRepair: true })

	const { fixture, census } = await recordFixture({
		panel: rows,
		backend: lookup,
		parse,
		armOptions: armOptionSets(definition),
	})

	const problems = validateFixture(rows, fixture)

	if (problems.length) {
		for (const problem of problems.slice(0, 20)) {
			console.error(`  ${problem.rowID}: ${problem.problem}`)
		}

		throw new Error(`prominence-floor record: the fixture is not equal-evidence (${problems.length} problems)`)
	}

	await writeLocalJSONLFile(fixture, FIXTURE_PATH)

	const errors = census.filter((entry) => entry.error)

	await writeLocalJSONFile(
		{
			benchmarkID: definition.benchmarkID,
			definitionVersion: definition.version,
			recordedAt: isoSeconds(),
			gitHead: await gitHead(repoRootPath()),
			weights,
			backendPath: BACKEND,
			gazetteerPath: GAZETTEER,
			countries: definition.goldSource.countries,
			rows: fixture.length,
			fixtureDigest: fixtureDigest(fixture),
			lookupsTotal: census.reduce((total, entry) => total + entry.lookups, 0),
			candidatesTotal: census.reduce((total, entry) => total + entry.candidates, 0),
			goldCandidatesRemoved: census.reduce((total, entry) => total + entry.removedGold, 0),
			rowsWithRecordingError: errors.length,
		},
		RECEIPT_PATH
	)

	console.log(`fixture: ${fixture.length} rows → ${FIXTURE_PATH}`)
	console.log(`digest: ${fixtureDigest(fixture)}`)
	console.log(`recording errors: ${errors.length}`)
}

async function runPhase(): Promise<void> {
	const { definition, panel, fixture } = await allKeyed({
		definition: loadProminenceDefinition(),
		panel: JSONSpliterator.fromAsync<ProminencePanelRow>(PANEL_PATH).toArray(),
		fixture: JSONSpliterator.fromAsync<SameDataFixtureRow>(FIXTURE_PATH).toArray(),
	})

	const fixtureByID = new Map(fixture.map((row) => [row.id, row]))
	const rows = panel.filter((row) => fixtureByID.has(row.id))
	const results: ArmRowResult[] = []

	for (const arm of definition.arms) {
		for (const row of rows) {
			results.push(await runResolverArm(arm.id, row, fixtureByID.get(row.id)!, { ...arm.resolveOpts }))
		}
	}

	const unequal = assertEqualEvidence(results.map((result) => result.evidence))

	if (unequal.length) {
		for (const problem of unequal.slice(0, 20)) {
			console.error(`  ${problem.rowID}: ${problem.problem}`)
		}

		throw new Error(`prominence-floor run: the arms did not read equal evidence (${unequal.length} problems)`)
	}

	await writeLocalJSONLFile(results, RESULTS_PATH)

	console.log(`results: ${results.length} rows → ${RESULTS_PATH}`)
	console.log(`equal evidence over ${rows.length} rows: confirmed`)
}

/**
 * One band's reading for one arm, over the rows every arm scored without a replay miss.
 */
interface BandReading {
	band: string
	arm: string
	selectionAccuracy: number | null
	falseSelection: number | null
	rendered: string[]
}

async function scorePhase(): Promise<void> {
	const { definition, panel, results } = await allKeyed({
		definition: loadProminenceDefinition(),
		panel: JSONSpliterator.fromAsync<ProminencePanelRow>(PANEL_PATH).toArray(),
		results: JSONSpliterator.fromAsync<ArmRowResult>(RESULTS_PATH).toArray(),
	})

	const panelByID = new Map(panel.map((row) => [row.id, row]))
	const bandOf = new Map(panel.map((row) => [row.id, row.band]))

	// A raised floor changes what the walk asks next, so each arm loses a different
	// set of rows to replay misses.
	// Per-arm survivor scores would compare rates whose denominators moved.
	const errored = new Set(results.filter((result) => result.error).map((result) => result.rowID))
	const scored = results.filter((result) => !errored.has(result.rowID))
	const survivors = new Map([...panelByID].filter(([id]) => !errored.has(id)))

	const readings: BandReading[] = []

	for (const band of definition.populationBands) {
		for (const arm of definition.arms) {
			const rows = scored.filter((result) => result.arm === arm.id && bandOf.get(result.rowID) === band.id)
			const metrics = armMetrics(arm.id, band.id, survivors, rows)

			readings.push({
				band: band.id,
				arm: arm.id,
				selectionAccuracy: metrics.selectionAccuracy.value,
				falseSelection: metrics.falseSelection.value,
				rendered: [
					band.id,
					arm.id,
					String(results.filter((result) => result.arm === arm.id && result.error).length),
					renderRatio(metrics.selectionAccuracy),
					renderRatio(metrics.wrongArea),
					renderRatio(metrics.falseSelection),
				],
			})
		}
	}

	const reading = (band: string, arm: string): BandReading | undefined =>
		readings.find((entry) => entry.band === band && entry.arm === arm)

	// The registered rule: some floor must reduce the false-selection rate by at least 10 points against
	// the default in every band, while costing at most 5 points of selection accuracy in any band.
	const verdictRows = definition.arms
		.filter((arm) => arm.id !== "default")
		.map((arm) => {
			const perBand = definition.populationBands.map((band) => {
				const base = reading(band.id, "default")
				const floor = reading(band.id, arm.id)

				const falseDrop = 100 * ((base?.falseSelection ?? 0) - (floor?.falseSelection ?? 0))
				const accuracyCost = 100 * ((base?.selectionAccuracy ?? 0) - (floor?.selectionAccuracy ?? 0))

				return { band: band.id, falseDrop, accuracyCost }
			})

			// The rule applies per band.
			// The arm is judged by its smallest refusal reduction and its largest
			// accuracy cost across those bands.
			const worstDrop = Math.min(...perBand.map((entry) => entry.falseDrop))
			const worstCost = Math.max(...perBand.map((entry) => entry.accuracyCost))
			const passed = worstDrop >= REQUIRED_FALSE_SELECTION_DROP_POINTS && worstCost <= ALLOWED_ACCURACY_COST_POINTS

			return {
				arm: arm.id,
				worstDrop,
				worstCost,
				passed,
				rendered: [arm.id, `${worstDrop.toFixed(1)} points`, `${worstCost.toFixed(1)} points`, passed ? "yes" : "no"],
			}
		})

	const winner = verdictRows.find((entry) => entry.passed)

	const lines = [
		`# Prominence floor — ${definition.benchmarkID} ${definition.version}`,
		"",
		`Gold from ${definition.goldSource.countries.join(", ")}, ${panel.length} rows across`,
		`${definition.populationBands.length} population bands. Every rate is measured over the ${survivors.size} of`,
		`${panel.length} rows that every arm scored without a replay miss.`,
		"",
		winner
			? `**The claim holds at ${winner.arm}.** Its worst band drops the false-selection rate by ${winner.worstDrop.toFixed(1)} points and costs at most ${winner.worstCost.toFixed(1)} points of selection accuracy.`
			: "**The claim does NOT hold.** No registered floor reduces the false-selection rate by 10 points in every band while costing at most 5 points of selection accuracy.",
		"",
		"## The registered rule, per arm",
		"",
		...renderMarkdownTable(
			["arm", "smallest false-selection drop, any band", "largest accuracy cost, any band", "rule met"],
			verdictRows.map((entry) => entry.rendered)
		),
		"",
		"## Per band and arm",
		"",
		...renderMarkdownTable(
			["band", "arm", "replay misses", "selection accuracy", "wrong-area rate", "false-selection rate"],
			readings.map((entry) => entry.rendered)
		),
	]

	await writeLocalTextFile(lines, SCORE_PATH)

	console.log(lines.join("\n"))
	console.log(`\nreport → ${SCORE_PATH}`)
}

const PHASES: Record<string, () => Promise<void>> = {
	panel: panelPhase,
	record: recordPhase,
	run: runPhase,
	score: scorePhase,
}

const phase = positionals[0] ?? ""
const handler = PHASES[phase]

if (!handler) {
	console.error(`prominence-floor: pass one phase — ${Object.keys(PHASES).join(", ")}`)

	process.exitCode = 1
} else {
	await handler()
}
