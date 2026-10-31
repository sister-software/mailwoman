/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Replays the suite rows through a traced parse and attributes each row to the decoder stage that decided it.
 *
 *   Usage:
 *   node packages/mailwoman/tools/eval-harness/osm-suites/replay.run.ts --suites /mnt/mw/corpus/heldout/osm-suites \
 *     --arm <weights cache> --second-arm <weights cache> --failures <failure-list.json> --out <directory>
 *
 *   `--arm` is parsed with the trace on. `--second-arm` is parsed without it, so the rows both arms fail and both pass can
 *   be read. Every row record (`rows.jsonl`) holds the gold labels, the four traced label sequences, the stage that
 *   decided the row (`replay.ts`), and the rank of the gold labels among the decoder's 20 best paths over the
 *   post-prior emissions under the BIO masks. `summary.json` holds each arm's exact count per suite, the deciding stage
 *   and k-best availability per mechanism family for the failure list. `--failures` supplies the list in the shape the
 *   2026-10-28 suite report wrote.
 */

import { sortedGlob } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { countInto } from "@mailwoman/core/stats"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { buildBIOEndMask, buildBIOStartMask, buildBIOTransitionMask, viterbiKBest } from "@mailwoman/neural/viterbi"
import { basename, resolvePath } from "path-ts"
import { JSONSpliterator } from "spliterator"

import {
	heldoutWeightsLocale,
	readHeldoutLocalePackages,
	scoreHeldoutRow,
} from "#tools/eval-harness/heldout/per/country"
import type { OSMSuiteRow } from "#tools/eval-harness/osm-suites/extract"
import { failureFamilies, readFailureList } from "#tools/eval-harness/osm-suites/failure-families"
import {
	decidingStage,
	goldPieceLabels,
	labelsMatchGold,
	replayStages,
	type ReplayStage,
	stageMatches,
} from "#tools/eval-harness/osm-suites/replay"

const { values } = parseArguments({
	options: {
		suites: { type: "string", description: "The directory holding the suites' rows files" },
		arm: { type: "string", description: "The weights cache parsed with the trace on" },
		"second-arm": { type: "string", description: "The weights cache parsed plainly" },
		failures: { type: "string", description: "The failure list JSON the suite report wrote" },
		out: { type: "string", description: "The output directory" },
	},
})

if (!values.suites || !values.arm || !values["second-arm"] || !values.out) {
	throw new Error("--suites, --arm, --second-arm and --out are required")
}

const K_VALUES = [1, 5, 20] as const
const packages = await readHeldoutLocalePackages()

function classifiers(cacheRoot: string) {
	const loaded = new Map<string, Promise<NeuralAddressClassifier>>()

	return (locale: string) => {
		let classifier = loaded.get(locale)

		if (!classifier) {
			classifier = NeuralAddressClassifier.loadFromWeights({ locale, cacheRoot, intraOpNumThreads: 2 })
			loaded.set(locale, classifier)
		}

		return classifier
	}
}

const traced = classifiers(values.arm)
const plain = classifiers(values["second-arm"])

const suiteFiles = [
	...(await sortedGlob(values.suites, "osm-*-v2.rows.jsonl")),
	...(await sortedGlob(values.suites, "photon-*-v1.rows.jsonl")),
]

interface RowRecord {
	suite: string
	rowID: string | null
	country: string | null
	raw: string
	exact: boolean
	secondExact: boolean
	gold: Array<string | null> | null
	stages: ReturnType<typeof replayStages>
	matches: boolean[]
	stage: ReplayStage
	/**
	 * The 1-based rank of the gold labels among the 20 best paths, or null when they are not among them.
	 */
	goldRank: number | null
	/**
	 * The k-best decoder's first path equals the traced path.
	 */
	kBestReproducesPath: boolean
}

const records: RowRecord[] = []
const perSuite = new Map<string, { rows: number; exact: number; secondExact: number }>()

for (const file of suiteFiles) {
	const suite = basename(file).replace(/-v[12]\.rows\.jsonl$/, "")
	const totals = { rows: 0, exact: 0, secondExact: 0 }

	for await (const row of JSONSpliterator.fromAsync<OSMSuiteRow>(file)) {
		const locale = heldoutWeightsLocale(row.country, packages)
		const options = { postcodeRepair: true, ...(row.country ? { localeHint: row.country } : {}) }
		const classifier = await traced(locale)
		const trace = await classifier.traceParse(row.raw, options)
		const tree = await classifier.parse(row.raw, options)
		const outcome = scoreHeldoutRow(row, tree)
		const secondOutcome = scoreHeldoutRow(row, await (await plain(locale)).parse(row.raw, options))

		const spans = row.span_tags.map((tag, index) => ({
			tag,
			start: row.span_starts[index]!,
			end: row.span_ends[index]!,
		}))

		const gold = goldPieceLabels(row.raw, trace.pieces, spans)
		const stages = replayStages(trace, trace.tokens)
		const matches = gold ? stageMatches(stages, gold) : [false, false, false, false]
		const width = trace.emissions[0]?.length ?? 0
		const labels = trace.labels.slice(0, width)

		const paths = viterbiKBest(
			{
				emissions: trace.emissions,
				transitions: buildBIOTransitionMask(labels),
				startTransitions: buildBIOStartMask(labels),
				endTransitions: buildBIOEndMask(labels),
			},
			20
		)

		const rank = gold
			? paths.findIndex((candidate) =>
					labelsMatchGold(
						candidate.path.map((index) => labels[index] ?? "O"),
						gold
					)
				)
			: -1

		records.push({
			suite,
			rowID: outcome.rowID,
			country: row.country,
			raw: row.raw,
			exact: outcome.exact,
			secondExact: secondOutcome.exact,
			gold,
			stages,
			matches,
			stage: gold ? decidingStage(matches, outcome.exact) : "model",
			goldRank: rank === -1 ? null : rank + 1,
			kBestReproducesPath: (paths[0]?.path.join(",") ?? "") === trace.path.join(","),
		})

		totals.rows++

		if (outcome.exact) {
			totals.exact++
		}

		if (secondOutcome.exact) {
			totals.secondExact++
		}
	}

	perSuite.set(suite, totals)

	console.log(`[replay] ${suite}: ${totals.exact} and ${totals.secondExact} of ${totals.rows} exact`)
}

await writeLocalTextFile(
	records.map((record) => stringifyJSON(record)),
	resolvePath(values.out, "rows.jsonl")
)

const byKey = new Map(records.map((record) => [`${record.suite}\u0000${record.raw}`, record]))

interface FamilyRow {
	records: number
	inputs: Set<string>
	stages: Map<string, number>
	available: number[]
	replayedFailing: number
	notReplayed: number
}

const familyTable = new Map<string, FamilyRow>()

/**
 * Adds one failure-list record to its family's row: its input, and, when the replay
 * reproduced the failure, the deciding stage and the k-best availability.
 */
function tallyFamily(family: string, raw: string, record: RowRecord | undefined): void {
	let row = familyTable.get(family)

	if (!row) {
		row = {
			records: 0,
			inputs: new Set(),
			stages: new Map(),
			available: K_VALUES.map(() => 0),
			replayedFailing: 0,
			notReplayed: 0,
		}

		familyTable.set(family, row)
	}

	row.records++
	row.inputs.add(raw)

	if (!record) {
		row.notReplayed++

		return
	}

	if (record.exact) return

	row.replayedFailing++
	countInto(row.stages, record.stage)

	for (const [index, k] of K_VALUES.entries()) {
		if (record.goldRank !== null && record.goldRank <= k) {
			row.available[index]!++
		}
	}
}

if (values.failures) {
	for (const { suite, country, entry, raw } of await readFailureList(values.failures)) {
		const record = byKey.get(`${suite}\u0000${raw}`)

		for (const family of failureFamilies(entry, country)) {
			tallyFamily(family, raw, record)
		}
	}
}

const bothFail = records.filter((record) => !record.exact && !record.secondExact)
const stageCounts = new Map<string, number>()

for (const row of bothFail) {
	countInto(stageCounts, row.stage)
}

const bothPass = records.filter((record) => record.exact && record.secondExact)

const kAvailability = (rows: readonly RowRecord[]) =>
	Object.fromEntries(
		K_VALUES.map((k) => [`k${k}`, rows.filter((row) => row.goldRank !== null && row.goldRank <= k).length])
	)

await writeLocalJSONFile(
	{
		arm: values.arm,
		secondArm: values["second-arm"],
		rows: records.length,
		perSuite: Object.fromEntries(perSuite),
		bothFail: bothFail.length,
		bothPass: bothPass.length,
		kBestReproducesPath: records.filter((record) => record.kBestReproducesPath).length,
		goldUnrepresentable: records.filter((record) => record.gold === null).length,
		stagesBothFail: Object.fromEntries([...stageCounts].toSorted(([, a], [, b]) => b - a)),
		availabilityBothFail: kAvailability(bothFail),
		availabilityBothPass: kAvailability(bothPass),
		families: Object.fromEntries(
			[...familyTable].map(([family, row]) => [
				family,
				{
					records: row.records,
					distinctInputs: row.inputs.size,
					notReplayed: row.notReplayed,
					replayedFailing: row.replayedFailing,
					stages: Object.fromEntries(row.stages),
					available: Object.fromEntries(K_VALUES.map((k, index) => [`k${k}`, row.available[index]])),
				},
			])
		),
	},
	resolvePath(values.out, "summary.json")
)

console.log(`[replay] ${records.length} rows; both arms fail ${bothFail.length}, both pass ${bothPass.length}`)
