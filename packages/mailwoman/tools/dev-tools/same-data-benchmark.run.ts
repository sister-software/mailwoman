/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The same-data controlled resolver benchmark. No step after `record` reads a database.
 *   A difference reported by `run` cannot come from retrieval, index vintage, or data footprint.
 *   `replayBackend` raises when the recording has no answer.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import type { AddressTree } from "@mailwoman/core/decoder"
import { tryReadLocalJSONFile } from "@mailwoman/core/fs/readers"
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
	ABLATION_RESOLVE_OPTS,
	runBaselineArm,
	runResolverArm,
	type ArmRowResult,
} from "#tools/eval-harness/same-data/arms"
import { readGoldSets } from "#tools/eval-harness/same-data/concordance"
import { loadSameDataDefinition } from "#tools/eval-harness/same-data/definition"
import {
	assertEqualEvidence,
	fixtureDigest,
	type SameDataFixtureRow,
	type SameDataPanelRow,
	validateFixture,
} from "#tools/eval-harness/same-data/fixture"
import { type KnobArm, readKnobArms } from "#tools/eval-harness/same-data/knob-arms"
import { buildPanel, readCities, readCountryNames, readPostcodeByAdmin } from "#tools/eval-harness/same-data/panel"
import { recordFixture } from "#tools/eval-harness/same-data/record"
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
} from "#tools/eval-harness/same-data/report"
import {
	armMetrics,
	comparePaired,
	evaluateVerdict,
	reliabilityTable,
	type ArmMetrics,
} from "#tools/eval-harness/same-data/score"
import {
	dominatingPoints,
	irreducibleFalseSelections,
	thresholdCurve,
	thresholdDecisions,
	type ThresholdPoint,
} from "#tools/eval-harness/same-data/threshold"

const { values, positionals } = parseArguments({
	options: {
		geonames: { type: "string" },
		gazetteer: { type: "string" },
		backend: { type: "string" },
		out: { type: "string" },
		panel: { type: "string" },
		limit: { type: "string" },
		arms: { type: "string" },
		"knob-out": { type: "string" },
		"withhold-every-denoting-row": { type: "boolean" },
	},
	allowPositionals: true,
})

const GEONAMES = values.geonames || dataRootPath("geonames")
/**
 * The FTS gazetteer supplies the `concordances` and `spr` tables.
 *
 * The candidate backend below has no concordance table, so these use separate flags.
 */
const GAZETTEER = values.gazetteer || wofDatabasePath("admin-global-priority.db")
const BACKEND = values.backend || wofDatabasePath("candidate.db").toString()
const OUT = values.out || repoRootPath("docs", "static", "benchmarks").toString()

/**
 * The separate flag lets a successor construction read the frozen panel
 * while writing its own fixture, since one path for both would force it to overwrite
 * the frozen artifacts to change the withheld-gold rule.
 */
const PANEL_PATH = values.panel || `${OUT}/same-data-panel.jsonl`
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

	// The withheld-gold stratum under a rule `same-data-resolver-v1` was not frozen under,
	// so a fixture recorded this way belongs to a successor benchmark id rather than to v1.
	const withholdEveryDenotingRow = values["withhold-every-denoting-row"] === true

	if (withholdEveryDenotingRow) {
		console.error(
			`  withholding every DENOTING row — this is not the ${(await loadSameDataDefinition()).benchmarkID} construction; score it as a successor`
		)
	}

	const { fixture, census } = await recordFixture({
		panel: rows,
		backend: lookup,
		parse,
		armOptions: armOptionSets(),
		withholdEveryDenotingRow,
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
			benchmarkID: withholdEveryDenotingRow ? `${definition.benchmarkID}-denoting` : definition.benchmarkID,
			definitionVersion: definition.version,
			// Which withheld-gold rule produced this fixture.
			// The two rules define different strata, so the benchmark id by itself does not identify a run.
			withheldGoldRule: withholdEveryDenotingRow ? "every-denoting-row" : "concorded-ids",
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
 * Every arm's `ResolveOpts`, production first: the production arm's empty bag
 * is listed explicitly because an omitted default is a missing replay key
 * and `replayBackend` would raise on the arm the benchmark is about.
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

/**
 * What the receipt records about the fixture these results came from, read rather than assumed
 * because the two withheld-gold rules define different strata and a report headed by the
 * definition by itself would label a successor's numbers with the frozen benchmark's id.
 */
async function recordedUnder(): Promise<{ benchmarkID: string; withheldGoldRule: string }> {
	const receipt = await tryReadLocalJSONFile<{ benchmarkID?: string; withheldGoldRule?: string }>(RECEIPT_PATH)

	return {
		benchmarkID: receipt?.benchmarkID ?? "(no receipt beside these results)",
		// A fixture recorded before the rule was introduced has no field.
		// This selects the v1 rule and marks the receipt's age.
		withheldGoldRule: receipt?.withheldGoldRule ?? "concorded-ids (receipt predates the field)",
	}
}

async function scorePhase(): Promise<void> {
	const { definition, panel, results, recorded } = await allKeyed({
		definition: loadSameDataDefinition(),
		panel: JSONSpliterator.fromAsync<SameDataPanelRow>(PANEL_PATH).toArray(),
		results: JSONSpliterator.fromAsync<ArmRowResult>(RESULTS_PATH).toArray(),
		recorded: recordedUnder(),
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
		`# Same-data resolver benchmark — ${recorded.benchmarkID} ${definition.version}`,
		"",
		`Withheld-gold rule: \`${recorded.withheldGoldRule}\`. Ruler: \`${definition.benchmarkID}\` ${definition.version}.`,
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

	// `lines` must not end with an empty element: `oxfmt` strips a trailing blank line,
	// so a generated file carrying one fails `yarn lint`.
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
		"threshold over this signal can provide at the final selection.",
		"",
		"**Exploratory, and outside the frozen pre-registration.** Every threshold here was read off results that",
		"were already visible, which is the one thing the registered rule forbids. The decision column below says",
		"what the registered rule WOULD have read at each threshold; it does not re-decide the frozen verdict, and",
		"no threshold warrants a claim until it is registered ahead of a panel it has not seen.",
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
 * These option sets define the arms used by the knob replay.
 *
 * Over this fixture's pools, the candidate backend's log-population rank ranges
 * from 0 to 9.14, with a median of 2.55.
 * The arms also include `spanRescore` options.
 *
 * `applySpanRescore` returns early when the tree already holds a resolved place.
 * The implementation is in `resolve/passes.ts`.
 *
 * A floor refusal leaves the tree eligible for the recovery pass to answer instead.
 */
const DEFAULT_KNOB_ARMS: KnobArm[] = [
	{ label: "default", opts: {} },
	{ label: "minWinningScore 1", opts: { minWinningScore: 1 } },
	{ label: "minWinningScore 2", opts: { minWinningScore: 2 } },
	{ label: "minWinningScore 3", opts: { minWinningScore: 3 } },
	{ label: "minWinningScore 4", opts: { minWinningScore: 4 } },
	{ label: "minWinningScore 5", opts: { minWinningScore: 5 } },
	{ label: "spanRescore off", opts: { spanRescore: false } },
	{ label: "minWinningScore 4 + spanRescore off", opts: { minWinningScore: 4, spanRescore: false } },
	// This arm applies a narrower refusal than the blanket floor.
	// Span rescore still runs.
	// It refuses a sub-span that drops a word of the name.
	// It keeps one that drops a qualifier, a number or a street the parse read is kept.
	{ label: "spanRescore context remainder", opts: { spanRescoreRequireContextRemainder: true } },
]

async function knobPhase(): Promise<void> {
	// The committed `same-data-knob.md` and its prose describe the default arms, so a custom arm set writes elsewhere.
	if (values.arms && !values["knob-out"]) {
		throw new Error(
			"same-data-benchmark knob: --arms needs --knob-out, so the committed knob report is not overwritten"
		)
	}

	const arms = values.arms ? await readKnobArms(values.arms) : DEFAULT_KNOB_ARMS
	const knobPath = values["knob-out"] || KNOB_PATH

	const { panel, fixture } = await allKeyed({
		panel: JSONSpliterator.fromAsync<SameDataPanelRow>(PANEL_PATH).toArray(),
		fixture: JSONSpliterator.fromAsync<SameDataFixtureRow>(FIXTURE_PATH).toArray(),
	})

	const fixtureByID = new Map(fixture.map((row) => [row.id, row]))
	const rows = panel.filter((row) => fixtureByID.has(row.id))

	const byArm = new Map<string, ArmRowResult[]>()

	for (const { label, opts } of arms) {
		const results: ArmRowResult[] = []

		for (const row of rows) {
			results.push(await runResolverArm(label, row, fixtureByID.get(row.id)!, opts))
		}

		byArm.set(label, results)
	}

	// A raised floor changes what the walk asks next.
	// Each arm loses a different set of rows to replay misses.
	// Per-arm survivor scores would compare rates whose denominators moved.
	// This intersection is what makes the columns comparable.
	const errored = new Set(
		[...byArm.values()].flatMap((results) => results.filter((result) => result.error).map((result) => result.rowID))
	)

	const common = rows.filter((row) => !errored.has(row.id))
	const commonByID = new Map(common.map((row) => [row.id, row]))
	const commonIDs = new Set(commonByID.keys())

	const knobRows = arms.map(({ label }) => {
		const results = byArm.get(label)!

		const metrics = armMetrics(
			label,
			"common",
			commonByID,
			results.filter((result) => commonIDs.has(result.rowID))
		)

		return [
			label,
			String(results.filter((result) => result.error).length),
			renderRatio(metrics.selectionAccuracy),
			renderRatio(metrics.wrongArea),
			renderRatio(metrics.falseSelection),
		]
	})

	const table = renderMarkdownTable(
		["arm", "replay misses", "selection accuracy", "wrong-area rate", "false-selection rate"],
		knobRows
	)

	const customLines = [
		`# Resolver option arms from \`${values.arms}\`, replayed`,
		"",
		"Replayed against the frozen fixture. A walk that asks a question the recording never answered is counted in",
		"`replay misses`, and its row is dropped from every arm's denominator.",
		"",
		`Every rate below is measured over the ${common.length} of ${rows.length} rows that every arm scored without a`,
		"replay miss.",
		"",
		...table,
	]

	const defaultLines = [
		"# The shipped knob, replayed",
		"",
		"`ResolveOpts.minWinningScore` compares against the candidate backend's score, which is a log-population",
		"rank — a prominence floor rather than a confidence floor. Replayed against the frozen fixture, so a walk",
		"that asks a question the recording never answered is counted in `replay misses` and its row is dropped",
		"from every arm's denominator, never read as an abstention.",
		"",
		`Every rate below is measured over the ${common.length} of ${rows.length} rows that every arm scored without a`,
		"replay miss. The dropped rows are exactly the ones a floor changed most, so the accuracy column understates",
		"how much the floors move; all 100 withheld-gold rows survive every arm, so the false-selection column is",
		"complete.",
		"",
		...table,
		"",
		"Before #2265, a floor alone was inert: it moved the false-selection rate by one row across the whole",
		"populated range of the scale, because `applySpanRescore` recovers any tree holding no resolved place and a",
		"refusal leaves exactly that — so the recovery re-issued the byte-identical lookup the floor had declined.",
		"The floor now refuses for real, and the remaining gap to `spanRescore: false` is span rescore answering",
		"the rows the floor never reached rather than the ones it refused.",
		"",
		"The magnitudes are this panel's, not a setting: every one of its 453 gold entities has population above",
		"15,151 and four of its five strata sit above 50,000, so a floor of 4.0 — population 10,000 — admits every",
		"correct answer here by construction. A panel whose gold all clears a floor cannot measure that floor.",
	]

	const lines = values.arms ? customLines : defaultLines

	await writeLocalTextFile(lines, knobPath)

	console.log(lines.join("\n"))
	console.log(`\nknob → ${knobPath}`)
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
