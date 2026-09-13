/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The same-data controlled resolver benchmark (#2261) — the measurement that needs the model and the
 *   gazetteer. Three phases, run separately so the expensive one happens once:
 *
 *     panel   Execute the frozen selection rules over GeoNames and write the panel.
 *     record  Parse every query with the shipped model, drive the REAL backend once per arm option set,
 *             and freeze every answer. This is the only phase that touches a gazetteer.
 *     run     Replay the frozen fixture through the three arms, score, and write the results.
 *
 *   AFTER `record`, NOTHING READS A DATABASE. That is the whole point: a difference the `run` phase
 *   reports cannot come from retrieval, an index vintage, or a data footprint, because every arm reads the
 *   same frozen bytes and `replayBackend` raises rather than inventing an answer.
 *
 *   Run:
 *     node packages/mailwoman/lib/dev-tools/same-data-benchmark.run.ts panel
 *     node packages/mailwoman/lib/dev-tools/same-data-benchmark.run.ts record
 *     node packages/mailwoman/lib/dev-tools/same-data-benchmark.run.ts run
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import type { AddressTree } from "@mailwoman/core/decoder"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { gitHead } from "@mailwoman/core/git"
import { repoRootPath } from "@mailwoman/core/paths"
import type { ResolveOpts } from "@mailwoman/core/resolver"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { isoSeconds } from "@mailwoman/core/utils"
import { JSONSpliterator } from "spliterator"

import { readWeightsIdentity } from "#eval-harness/preregistration"
import { ABLATION_RESOLVE_OPTS, runBaselineArm, runResolverArm, type ArmRowResult } from "#eval-harness/same-data/arms"
import { readGoldSets } from "#eval-harness/same-data/concordance"
import { loadSameDataDefinition } from "#eval-harness/same-data/definition"
import {
	assertEqualEvidence,
	fixtureDigest,
	type SameDataFixtureRow,
	type SameDataPanelRow,
	validateFixture,
} from "#eval-harness/same-data/fixture"
import { buildPanel, readCities, readCountryNames, readPostcodeByAdmin } from "#eval-harness/same-data/panel"
import { recordFixture } from "#eval-harness/same-data/record"
import {
	renderAbstentionTable,
	renderLosses,
	renderMetricsTable,
	renderPairedComparison,
	renderReliability,
	renderVerdictTable,
} from "#eval-harness/same-data/report"
import {
	armMetrics,
	comparePaired,
	evaluateVerdict,
	reliabilityTable,
	type ArmMetrics,
} from "#eval-harness/same-data/score"

const { values: rawValues, positionals } = parseArguments({
	options: {
		geonames: { type: "string" },
		gazetteer: { type: "string" },
		backend: { type: "string" },
		out: { type: "string" },
		limit: { type: "string" },
	},
	strict: false,
	allowPositionals: true,
})

const values = rawValues as {
	geonames?: string
	gazetteer?: string
	backend?: string
	out?: string
	limit?: string
}

const GEONAMES = values.geonames || dataRootPath("geonames").toString()
/**
 * The FTS gazetteer, read for its `concordances` + `spr` tables — the identity join. The candidate backend below
 * carries no concordance table, which is why the two are separate flags rather than one.
 */
const GAZETTEER = values.gazetteer || dataRootPath("wof", "admin-global-priority.db").toString()
/**
 * The backend the recording drives. Defaults to the promoted candidate table, which is what the shipped geocoder reads.
 */
const BACKEND = values.backend || dataRootPath("wof", "candidate.db").toString()
const OUT = values.out || repoRootPath("docs", "static", "benchmarks").toString()

const PANEL_PATH = `${OUT}/same-data-panel.jsonl`
const FIXTURE_PATH = `${OUT}/same-data-candidates.jsonl`
const RESULTS_PATH = `${OUT}/same-data-results.jsonl`
const RECEIPT_PATH = `${OUT}/same-data-receipt.json`
const SCORE_PATH = `${OUT}/same-data-report.md`

function toJSONL(rows: ReadonlyArray<unknown>): string {
	return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`
}

async function readJSONL<T>(path: string): Promise<T[]> {
	return Array.fromAsync(JSONSpliterator.fromAsync<T>(path))
}

async function panelPhase(): Promise<void> {
	const definition = await loadSameDataDefinition()
	const cities = await readCities(`${GEONAMES}/cities15000.txt`)
	const countryNames = await readCountryNames(`${GEONAMES}/countryInfo.txt`)
	const postcodeByAdmin = await readPostcodeByAdmin(`${GEONAMES}/allCountries-postal.txt`)
	const { byGeonameID: goldSets, census: goldCensus } = await readGoldSets(GAZETTEER, cities)

	const { rows, census } = buildPanel({ definition, cities, countryNames, postcodeByAdmin, goldSets })

	await writeLocalTextFile(toJSONL(rows), PANEL_PATH)

	console.log(`panel: ${rows.length} rows → ${PANEL_PATH}`)
	console.table([goldCensus])
	console.table(census)
}

async function recordPhase(): Promise<void> {
	const definition = await loadSameDataDefinition()
	const panel = await readJSONL<SameDataPanelRow>(PANEL_PATH)
	const limit = values.limit ? Number(values.limit) : panel.length
	const rows = panel.slice(0, limit)

	const weights = await readWeightsIdentity({})
	const { createScorer } = await import("@mailwoman/neural/scorer")
	const { WOFCandidateTableLookup } = await import("@mailwoman/resolver-wof-sqlite")

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
		armOptions: armOptionSets(),
	})

	const problems = validateFixture(rows, fixture)

	if (problems.length) {
		for (const problem of problems.slice(0, 20)) {
			console.error(`  ${problem.rowID}: ${problem.problem}`)
		}

		throw new Error(`same-data record: the fixture is not equal-evidence (${problems.length} problems)`)
	}

	await writeLocalTextFile(toJSONL(fixture), FIXTURE_PATH)

	const errors = census.filter((entry) => entry.error)

	await writeLocalTextFile(
		`${JSON.stringify(
			{
				benchmarkID: definition.benchmarkID,
				definitionVersion: definition.version,
				recordedAt: isoSeconds(),
				gitHead: await gitHead(repoRootPath()),
				weights,
				backendPath: BACKEND,
				gazetteerPath: GAZETTEER,
				rows: fixture.length,
				fixtureDigest: fixtureDigest(fixture),
				lookupsTotal: census.reduce((total, entry) => total + entry.lookups, 0),
				candidatesTotal: census.reduce((total, entry) => total + entry.candidates, 0),
				goldCandidatesRemoved: census.reduce((total, entry) => total + entry.removedGold, 0),
				rowsWithRecordingError: errors.length,
			},
			null,
			"\t"
		)}\n`,
		RECEIPT_PATH
	)

	console.log(`fixture: ${fixture.length} rows → ${FIXTURE_PATH}`)
	console.log(`digest: ${fixtureDigest(fixture)}`)
	console.log(`recording errors: ${errors.length}`)
}

/**
 * Every arm's `ResolveOpts`, production first. The production arm's EMPTY bag is listed explicitly: an omitted default
 * is a missing replay key, and `replayBackend` would then raise on the arm the benchmark is about.
 */
function armOptionSets(): ResolveOpts[] {
	return [{}, ABLATION_RESOLVE_OPTS]
}

async function runPhase(): Promise<void> {
	const panel = await readJSONL<SameDataPanelRow>(PANEL_PATH)
	const fixture = await readJSONL<SameDataFixtureRow>(FIXTURE_PATH)
	const fixtureByID = new Map(fixture.map((row) => [row.id, row]))
	const rows = panel.filter((row) => fixtureByID.has(row.id))

	const results: ArmRowResult[] = []

	for (const row of rows) {
		const evidence = fixtureByID.get(row.id)!

		results.push(await runResolverArm("mailwoman", row, evidence, {}))
		results.push(runBaselineArm(row, evidence))
		results.push(await runResolverArm("ablation", row, evidence, ABLATION_RESOLVE_OPTS))
	}

	const unequal = assertEqualEvidence(results.map((result) => result.evidence))

	if (unequal.length) {
		for (const problem of unequal.slice(0, 20)) {
			console.error(`  ${problem.rowID}: ${problem.problem}`)
		}

		throw new Error(`same-data run: the arms did not read equal evidence (${unequal.length} problems)`)
	}

	await writeLocalTextFile(toJSONL(results), RESULTS_PATH)

	console.log(`results: ${results.length} rows → ${RESULTS_PATH}`)
	console.log(`equal evidence over ${rows.length} rows: confirmed`)
}

/**
 * The bootstrap settings the frozen ruler registers.
 */
const BOOTSTRAP = { resamples: 10_000, seed: 20_260_913 } as const

/**
 * The registered pooled margin, in percentage points.
 */
const REQUIRED_MARGIN_POINTS = 8

async function scorePhase(): Promise<void> {
	const definition = await loadSameDataDefinition()
	const panel = await readJSONL<SameDataPanelRow>(PANEL_PATH)
	const results = await readJSONL<ArmRowResult>(RESULTS_PATH)
	const panelByID = new Map(panel.map((row) => [row.id, row]))
	const arms = definition.arms.map((arm) => arm.id)

	const byArm = (arm: string): ArmRowResult[] => results.filter((result) => result.arm === arm)

	const pooled = comparePaired(byArm("mailwoman"), byArm("baseline"), panelByID, BOOTSTRAP)
	const versusAblation = comparePaired(byArm("mailwoman"), byArm("ablation"), panelByID, BOOTSTRAP)

	const byStratum = new Map<string, { mailwoman: ArmMetrics; baseline: ArmMetrics }>()

	for (const stratum of new Set(panel.map((row) => row.stratum))) {
		const scoped = (arm: string) =>
			armMetrics(
				arm,
				stratum,
				panelByID,
				results.filter((result) => result.arm === arm && result.stratum === stratum)
			)

		byStratum.set(stratum, { mailwoman: scoped("mailwoman"), baseline: scoped("baseline") })
	}

	const verdict = evaluateVerdict(pooled, byStratum, REQUIRED_MARGIN_POINTS)

	const lines = [
		`# Same-data resolver benchmark — ${definition.benchmarkID} ${definition.version}`,
		"",
		"## Per-stratum and pooled",
		"",
		...renderMetricsTable(panel, results, arms),
		"",
		"## Abstention, withheld-gold stratum only",
		"",
		...renderAbstentionTable(panel, results, arms),
		"",
		"## Paired comparisons",
		"",
		...renderPairedComparison("Mailwoman vs the registered baseline", pooled),
		"",
		...renderPairedComparison("Mailwoman vs its own ablation", versusAblation),
		"",
		"## Calibration",
		"",
		...arms.flatMap((arm) => [...renderReliability(arm, reliabilityTable(byArm(arm))), ""]),
		"## Registered decision",
		"",
		...renderVerdictTable(verdict),
		"",
		"## Rows the baseline won and Mailwoman did not",
		"",
		...renderLosses(panel, results, 25),
		"",
	]

	await writeLocalTextFile(`${lines.join("\n")}\n`, SCORE_PATH)

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
	console.error(`same-data-benchmark: pass one phase — ${Object.keys(PHASES).join(", ")}`)

	process.exitCode = 1
} else {
	await handler()
}
