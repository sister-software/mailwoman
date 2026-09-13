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
 *     sweep   Re-grade the frozen results under an abstention threshold and write the trade curve (#2264).
 *     knob    Replay the frozen fixture at a range of `minWinningScore` floors — the shipped knob (#2264).
 *
 *   Nothing after `record` reads a database, so a difference the `run` phase reports cannot come from
 *   retrieval, an index vintage, or a data footprint: every arm reads the same frozen bytes, and
 *   `replayBackend` raises rather than inventing an answer.
 *
 *   Run:
 *     node packages/mailwoman/lib/dev-tools/same-data-benchmark.run.ts panel
 *     node packages/mailwoman/lib/dev-tools/same-data-benchmark.run.ts record
 *     node packages/mailwoman/lib/dev-tools/same-data-benchmark.run.ts run
 *     node packages/mailwoman/lib/dev-tools/same-data-benchmark.run.ts score
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
	renderDecisionTable,
	renderRatio,
	renderThresholdCurve,
	renderThresholdDecisions,
} from "#eval-harness/same-data/report"
import {
	armMetrics,
	comparePaired,
	evaluateVerdict,
	reliabilityTable,
	type ArmMetrics,
} from "#eval-harness/same-data/score"
import {
	dominatingPoints,
	irreducibleFalseSelections,
	thresholdCurve,
	thresholdDecisions,
	type ThresholdPoint,
} from "#eval-harness/same-data/threshold"

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

const PANEL_PATH = `${OUT}/same-data-panel.jsonl`
const FIXTURE_PATH = `${OUT}/same-data-candidates.jsonl`
const RESULTS_PATH = `${OUT}/same-data-results.jsonl`
const RECEIPT_PATH = `${OUT}/same-data-receipt.json`
const SCORE_PATH = `${OUT}/same-data-report.md`
const SWEEP_PATH = `${OUT}/same-data-threshold.md`
const KNOB_PATH = `${OUT}/same-data-knob.md`

async function panelPhase(): Promise<void> {
	const { definition, cities, countryNames, postcodeByAdmin } = await allKeyed({
		definition: loadSameDataDefinition(),
		cities: readCities(`${GEONAMES}/cities15000.txt`),
		countryNames: readCountryNames(`${GEONAMES}/countryInfo.txt`),
		postcodeByAdmin: readPostcodeByAdmin(`${GEONAMES}/allCountries-postal.txt`),
	})

	const { byGeonameID: goldSets, census: goldCensus } = await readGoldSets(GAZETTEER, cities)

	const { rows, census } = buildPanel({ definition, cities, countryNames, postcodeByAdmin, goldSets })

	await writeLocalJSONLFile(rows, PANEL_PATH)

	console.log(`panel: ${rows.length} rows → ${PANEL_PATH}`)
	console.table([goldCensus])
	console.table(census)
}

async function recordPhase(): Promise<void> {
	const panel = await JSONSpliterator.fromAsync<SameDataPanelRow>(PANEL_PATH).toArray()

	const limit = values.limit ? Number(values.limit) : panel.length
	const rows = panel.slice(0, limit)

	const {
		definition,
		weights,
		scorer: { createScorer },
		resolver: { WOFCandidateTableLookup },
	} = await allKeyed({
		definition: loadSameDataDefinition(),
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
		armOptions: armOptionSets(),
	})

	const problems = validateFixture(rows, fixture)

	if (problems.length) {
		for (const problem of problems.slice(0, 20)) {
			console.error(`  ${problem.rowID}: ${problem.problem}`)
		}

		throw new Error(`same-data record: the fixture is not equal-evidence (${problems.length} problems)`)
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

/**
 * Every arm's `ResolveOpts`, production first. The production arm's EMPTY bag is listed explicitly: an omitted default
 * is a missing replay key, and `replayBackend` would then raise on the arm the benchmark is about.
 */
function armOptionSets(): ResolveOpts[] {
	return [{}, ABLATION_RESOLVE_OPTS]
}

async function runPhase(): Promise<void> {
	const panel = await JSONSpliterator.fromAsync<SameDataPanelRow>(PANEL_PATH).toArray()
	const fixture = await JSONSpliterator.fromAsync<SameDataFixtureRow>(FIXTURE_PATH).toArray()

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

	await writeLocalJSONLFile(results, RESULTS_PATH)

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
	const { definition, panel, results } = await allKeyed({
		definition: loadSameDataDefinition(),
		panel: JSONSpliterator.fromAsync<SameDataPanelRow>(PANEL_PATH).toArray(),
		results: JSONSpliterator.fromAsync<ArmRowResult>(RESULTS_PATH).toArray(),
	})

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
		...renderDecisionTable(verdict),
		"",
		"## Rows the baseline won and Mailwoman did not",
		"",
		...renderLosses(panel, results, 25),
	]

	// `lines` must not end with an empty element: `oxfmt` strips a trailing blank line, so a generated file carrying
	// one fails `yarn lint` as soon as it is committed.
	await writeLocalTextFile(lines, SCORE_PATH)

	console.log(lines.join("\n"))
	console.log(`\nreport → ${SCORE_PATH}`)
}

async function sweepPhase(): Promise<void> {
	const { definition, panel, results } = await allKeyed({
		definition: loadSameDataDefinition(),
		panel: JSONSpliterator.fromAsync<SameDataPanelRow>(PANEL_PATH).toArray(),
		results: JSONSpliterator.fromAsync<ArmRowResult>(RESULTS_PATH).toArray(),
	})

	const panelByID = new Map(panel.map((row) => [row.id, row]))
	const arms = definition.arms.map((arm) => arm.id)
	const byArm = (arm: string): ArmRowResult[] => results.filter((result) => result.arm === arm)

	const baseline = armMetrics("baseline", "pooled", panelByID, byArm("baseline"))
	const accuracyFloor = baseline.selectionAccuracy.value ?? 0
	const falseFloor = baseline.falseSelection.value ?? 1

	const curves = arms.map((arm) => ({ arm, curve: thresholdCurve(arm, byArm(arm), panelByID) }))
	const mailwoman = curves.find((entry) => entry.arm === "mailwoman")!
	const ceiling = irreducibleFalseSelections(byArm("mailwoman"), panelByID)

	const dominating = dominatingPoints(mailwoman.curve, {
		selectionAccuracy: accuracyFloor,
		falseSelectionRate: falseFloor,
	})

	const describe = (point: ThresholdPoint): string =>
		`${point.threshold.toFixed(2)} (${(100 * (point.metrics.selectionAccuracy.value ?? 0)).toFixed(1)}% accuracy, ` +
		`${(100 * (point.metrics.falseSelection.value ?? 0)).toFixed(1)}% false selection)`

	const reference =
		`The baseline reads ${(100 * accuracyFloor).toFixed(1)}% accuracy and ` +
		`${(100 * falseFloor).toFixed(1)}% false selection.`

	const verdict = !dominating.length
		? `${reference} No threshold beats it on both axes at once.`
		: `${reference} ${dominating.length} of ${mailwoman.curve.length} thresholds beat it on both axes at once, ` +
			`from ${describe(dominating[0]!)} to ${describe(dominating.at(-1)!)}.`

	const decisions = thresholdDecisions(
		byArm("mailwoman"),
		byArm("baseline"),
		panelByID,
		dominating.map((point) => point.threshold),
		{ bootstrap: BOOTSTRAP, requiredMarginPoints: REQUIRED_MARGIN_POINTS }
	)

	const lines = [
		`# Abstention-threshold curve — ${definition.benchmarkID} ${definition.version}`,
		"",
		"Re-graded from the frozen results: a selection is withheld when its recorded confidence falls below the",
		"threshold. No resolver is re-run, so the walk is held fixed and the curve is an upper bound on what a",
		"threshold over this signal can buy at the final selection.",
		"",
		"**Exploratory, and outside the frozen pre-registration.** Every threshold here was read off results that",
		"were already visible, which is the one thing the registered rule forbids. The decision column below says",
		"what the registered rule WOULD have read at each threshold; it does not re-decide the frozen verdict, and",
		"no threshold earns a claim until it is registered ahead of a panel it has not seen.",
		"",
		`${ceiling.count} of ${ceiling.of} of Mailwoman's withheld-gold selections carry the maximum margin, because the`,
		"lookup that produced them considered one candidate. No threshold at or below 1 can withhold those.",
		"",
		verdict,
		"",
		"## The registered rule, re-read at each dominating threshold",
		"",
		...renderThresholdDecisions(decisions),
		"",
		"## Curves",
		"",
		...curves.flatMap(({ arm, curve }) => [...renderThresholdCurve(arm, curve), ""]).slice(0, -1),
	]

	await writeLocalTextFile(lines, SWEEP_PATH)

	console.log(lines.join("\n"))
	console.log(`\nsweep → ${SWEEP_PATH}`)
}

/**
 * The `minWinningScore` floors the knob sweep replays. The candidate backend's score is a log-population rank, measured
 * over this fixture's pools at min 0, median 2.55 and max 9.14, so these walk the populated half of that range.
 */
const MIN_WINNING_SCORES = [0, 1, 2, 3, 4, 5] as const

async function knobPhase(): Promise<void> {
	const { panel, fixture } = await allKeyed({
		panel: JSONSpliterator.fromAsync<SameDataPanelRow>(PANEL_PATH).toArray(),
		fixture: JSONSpliterator.fromAsync<SameDataFixtureRow>(FIXTURE_PATH).toArray(),
	})

	const fixtureByID = new Map(fixture.map((row) => [row.id, row]))
	const rows = panel.filter((row) => fixtureByID.has(row.id))
	const panelByID = new Map(rows.map((row) => [row.id, row]))

	const knobRows: string[][] = []

	for (const minWinningScore of MIN_WINNING_SCORES) {
		const results: ArmRowResult[] = []

		for (const row of rows) {
			results.push(await runResolverArm("mailwoman", row, fixtureByID.get(row.id)!, { minWinningScore }))
		}

		const metrics = armMetrics("mailwoman", `minWinningScore:${minWinningScore}`, panelByID, results)

		knobRows.push([
			minWinningScore.toFixed(1),
			String(metrics.errors),
			String(metrics.selections),
			renderRatio(metrics.selectionAccuracy),
			renderRatio(metrics.wrongArea),
			renderRatio(metrics.falseSelection),
		])
	}

	const lines = [
		"# The shipped knob, replayed",
		"",
		"`ResolveOpts.minWinningScore` compares against the candidate backend's score, which is a log-population",
		"rank. It is a PROMINENCE floor, not a confidence floor: raising it withholds small places rather than",
		"unsupported ones. Replayed against the frozen fixture, so a walk that asks a question the recording never",
		"answered is counted in `errors` and excluded from every rate — never read as an abstention.",
		"",
		"**Read the errors column before the rates.** A floor above 0 makes the walk refuse a node, and the",
		"questions it asks afterwards then differ from the ones the recording answered. Those rows leave the",
		"denominator, so selection accuracy at a raised floor is measured over fewer rows than at 0 and the two",
		"are not comparable. The false-selection column is, because its 100 withheld-gold rows all survive.",
		"",
		...renderMarkdownTable(
			["minWinningScore", "errors", "selections", "selection accuracy", "wrong-area rate", "false-selection rate"],
			knobRows
		),
	]

	await writeLocalTextFile(lines, KNOB_PATH)

	console.log(lines.join("\n"))
	console.log(`\nknob → ${KNOB_PATH}`)
}

const PHASES: Record<string, () => Promise<void>> = {
	panel: panelPhase,
	record: recordPhase,
	run: runPhase,
	score: scorePhase,
	sweep: sweepPhase,
	knob: knobPhase,
}

const phase = positionals[0] ?? ""
const handler = PHASES[phase]

if (!handler) {
	console.error(`same-data-benchmark: pass one phase — ${Object.keys(PHASES).join(", ")}`)

	process.exitCode = 1
} else {
	await handler()
}
