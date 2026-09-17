/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The prominence-floor benchmark (#2264) — does a `minWinningScore` floor reduce invented selections at
 *   every population band, or only where the gold is large enough to clear it?
 *
 *   The same-data benchmark measured this floor and could not answer. All 453 of its gold entities carry
 *   population above 15,151, so a floor of 4.0 — population 10,000 — admits every correct answer it contains
 *   by construction. This panel draws gold from 1 to millions, so the floor meets small places too.
 *
 *   Four phases, run separately so the expensive one happens once:
 *
 *     panel   Execute the frozen selection rules over the per-country GeoNames dumps and write the panel.
 *     record  Parse every query with the shipped model, drive the real backend once per arm option set, and
 *             freeze every answer. The only phase that touches a gazetteer.
 *     run     Replay the frozen fixture through the five arms and write the results.
 *     score   Read the results and decide the registered per-band rule.
 *
 *   Run:
 *     node packages/mailwoman/lib/dev-tools/prominence-floor.run.ts panel
 *     node packages/mailwoman/lib/dev-tools/prominence-floor.run.ts record
 *     node packages/mailwoman/lib/dev-tools/prominence-floor.run.ts run
 *     node packages/mailwoman/lib/dev-tools/prominence-floor.run.ts score
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
import { JSONSpliterator } from "spliterator"

import { readWeightsIdentity } from "#eval-harness/preregistration"
import { loadProminenceDefinition, type ProminenceFloorDefinition } from "#eval-harness/prominence-floor/definition"
import { buildProminencePanel, type ProminencePanelRow } from "#eval-harness/prominence-floor/panel"
import { runResolverArm, type ArmRowResult } from "#eval-harness/same-data/arms"
import { readGoldSets } from "#eval-harness/same-data/concordance"
import {
	assertEqualEvidence,
	fixtureDigest,
	type SameDataFixtureRow,
	validateFixture,
} from "#eval-harness/same-data/fixture"
import { readCities } from "#eval-harness/same-data/panel"
import { recordFixture } from "#eval-harness/same-data/record"
import { renderRatio } from "#eval-harness/same-data/report"
import { armMetrics } from "#eval-harness/same-data/score"

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
 * The FTS gazetteer, read for its `concordances` + `spr` tables — the identity join. The candidate backend below
 * carries no concordance table, which is why the two are separate flags rather than one.
 */
const GAZETTEER = values.gazetteer || dataRootPath("wof", "admin-global-priority.db")
/**
 * The backend the recording drives. Defaults to the promoted candidate table, which is what the shipped geocoder reads.
 */
const BACKEND = values.backend || dataRootPath("wof", "candidate.db").toString()
const OUT = values.out || repoRootPath("docs", "static", "benchmarks").toString()

const PANEL_PATH = `${OUT}/prominence-floor-panel.jsonl`
const FIXTURE_PATH = `${OUT}/prominence-floor-candidates.jsonl`
const RESULTS_PATH = `${OUT}/prominence-floor-results.jsonl`
const RECEIPT_PATH = `${OUT}/prominence-floor-receipt.json`
const SCORE_PATH = `${OUT}/prominence-floor-report.md`

/**
 * The frozen decision rule's two conditions, in percentage points. They are prose in `benchmark-definition.json`: the
 * false-selection rate must fall by at least 10 percentage points against the default arm in every band, and selection
 * accuracy must not fall more than 5 percentage points below the default arm's in any band. So they are named here
 * rather than carried as data: adding them to the definition after the freeze would move the content hash the freeze
 * record pins.
 */
const REQUIRED_FALSE_SELECTION_DROP_POINTS = 10
const ALLOWED_ACCURACY_COST_POINTS = 5

/**
 * Every arm's `ResolveOpts`, in the definition's order. The default arm's empty bag is listed explicitly: an omitted
 * default is a missing replay key, and `replayBackend` would raise on the arm the benchmark compares against.
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

	// A raised floor changes what the walk asks next, so each arm loses a different set of rows to replay misses.
	// Scoring each arm over its own survivors would compare rates whose denominators moved.
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

	// The registered rule: some floor must reduce the false-selection rate by at least 10 points against the default in
	// every band, while costing at most 5 points of selection accuracy in any band.
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

			// The rule is per band and decisive, so the arm is judged on its WORST band on each axis: the
			// smallest refusal it bought anywhere, and the largest accuracy it cost anywhere.
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
