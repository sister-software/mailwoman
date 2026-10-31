/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Replays the suite rows under decoder arms over one traced parse's emissions, and counts the rows each arm fixes and
 *   breaks against the shipped BIO masks.
 *
 *   Usage:
 *   node packages/mailwoman/tools/eval-harness/osm-suites/decoder-arms.run.ts --suites /mnt/mw/corpus/heldout/osm-suites \
 *     --arm <weights cache> --replay-rows <V54 rows.jsonl> --failures <failure-list.json> \
 *     --transitions <crf-transitions.json> --out <directory>
 *
 *   Each row is parsed once with the trace on. Its post-prior emissions are decoded using only the BIO masks (the
 *   shipped decode), under the masks plus the fitted transitions at temperatures 0.5, 1 and 2, and by the cardinality
 *   filter over the 20 best masked paths. Each path is compared with the gold labels as `replay.ts` compares them. The
 *   cardinality arm is also parsed in full with `cardinalityFilter` and graded exactly. A row's population (both
 *   seeds fail, both pass) comes from the V54 replay's rows, and its families from the failure list.
 */

import { readLocalJSONFile, sortedGlob } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { countedPieces, decodeWithCardinalityFilter } from "@mailwoman/neural/cardinality-filter"
import { buildBIOEndMask, buildBIOStartMask, buildBIOTransitionMask, viterbi } from "@mailwoman/neural/viterbi"
import { basename, resolvePath } from "path-ts"
import { JSONSpliterator } from "spliterator"

import {
	heldoutWeightsLocale,
	readHeldoutLocalePackages,
	scoreHeldoutRow,
} from "#tools/eval-harness/heldout/per/country"
import type { OSMSuiteRow } from "#tools/eval-harness/osm-suites/extract"
import { failureFamilies, readFailureList } from "#tools/eval-harness/osm-suites/failure-families"
import { goldPieceLabels, labelsMatchGold } from "#tools/eval-harness/osm-suites/replay"
import type { FittedTransitions } from "#tools/training/fit/transitions"

const { values } = parseArguments({
	options: {
		suites: { type: "string", description: "The directory holding the suites' rows files" },
		arm: { type: "string", description: "The weights cache parsed with the trace on" },
		"replay-rows": { type: "string", description: "The V54 replay's rows.jsonl" },
		failures: { type: "string", description: "The failure list JSON the suite report wrote" },
		transitions: { type: "string", description: "The fitted crf-transitions.json at temperature 1" },
		out: { type: "string", description: "The output directory" },
	},
})

if (!values.suites || !values.arm || !values["replay-rows"] || !values.failures || !values.transitions || !values.out) {
	throw new Error("--suites, --arm, --replay-rows, --failures, --transitions and --out are required")
}

const TEMPERATURES = [0.5, 1, 2] as const
const ARMS = ["mask", ...TEMPERATURES.map((t) => `transitions-t${t}`), "cardinality"] as const

type Arm = (typeof ARMS)[number]

const fitted = await readLocalJSONFile<FittedTransitions>(values.transitions)
const packages = await readHeldoutLocalePackages()
const loaded = new Map<string, Promise<NeuralAddressClassifier>>()

function classifier(locale: string): Promise<NeuralAddressClassifier> {
	let entry = loaded.get(locale)

	if (!entry) {
		entry = NeuralAddressClassifier.loadFromWeights({ locale, cacheRoot: values.arm!, intraOpNumThreads: 2 })
		loaded.set(locale, entry)
	}

	return entry
}

const key = (suite: string, raw: string) => `${suite}\u0000${raw}`

interface ReplayRow {
	suite: string
	raw: string
	exact: boolean
	secondExact: boolean
}

const population = new Map<string, "both-fail" | "both-pass" | "split">()

for await (const row of JSONSpliterator.fromAsync<ReplayRow>(values["replay-rows"])) {
	population.set(
		key(row.suite, row.raw),
		!row.exact && !row.secondExact ? "both-fail" : row.exact && row.secondExact ? "both-pass" : "split"
	)
}

const familiesByKey = new Map<string, Set<string>>()

for (const { suite, country, entry, raw } of await readFailureList(values.failures)) {
	const families = familiesByKey.get(key(suite, raw)) ?? new Set<string>()

	for (const family of failureFamilies(entry, country)) {
		families.add(family)
	}

	familiesByKey.set(key(suite, raw), families)
}

function addMatrices(a: number[][], b: number[][], scale: number): number[][] {
	return a.map((row, i) => row.map((value, j) => value + scale * (b[i]?.[j] ?? 0)))
}

function addVectors(a: number[], b: number[], scale: number): number[] {
	return a.map((value, i) => value + scale * (b[i] ?? 0))
}

interface ArmRecord {
	suite: string
	raw: string
	population: string
	families: string[]
	gold: boolean
	pathMatches: Record<Arm, boolean>
	cardinalityRank: number
	cardinalityFellBack: boolean
	exact: boolean
	cardinalityExact: boolean
}

const records: ArmRecord[] = []

const suiteFiles = [
	...(await sortedGlob(values.suites, "osm-*-v2.rows.jsonl")),
	...(await sortedGlob(values.suites, "photon-*-v1.rows.jsonl")),
]

for (const file of suiteFiles) {
	const suite = basename(file).replace(/-v[12]\.rows\.jsonl$/, "")
	let rows = 0

	for await (const row of JSONSpliterator.fromAsync<OSMSuiteRow>(file)) {
		const locale = heldoutWeightsLocale(row.country, packages)
		const options = { postcodeRepair: true, ...(row.country ? { localeHint: row.country } : {}) }
		const model = await classifier(locale)
		const trace = await model.traceParse(row.raw, options)
		const exact = scoreHeldoutRow(row, await model.parse(row.raw, options)).exact

		const cardinalityExact = scoreHeldoutRow(
			row,
			await model.parse(row.raw, { ...options, cardinalityFilter: true })
		).exact

		const spans = row.span_tags.map((tag, index) => ({
			tag,
			start: row.span_starts[index]!,
			end: row.span_ends[index]!,
		}))

		const gold = goldPieceLabels(row.raw, trace.pieces, spans)
		const width = trace.emissions[0]?.length ?? 0
		const labels = trace.labels.slice(0, width)

		if (fitted.labels.slice(0, width).join("\n") !== labels.join("\n")) {
			throw new Error(`${values.transitions}: its labels differ from the ${locale} model's`)
		}

		const masked = {
			emissions: trace.emissions,
			transitions: buildBIOTransitionMask(labels),
			startTransitions: buildBIOStartMask(labels),
			endTransitions: buildBIOEndMask(labels),
		}

		const cardinality = decodeWithCardinalityFilter(masked, labels, countedPieces(row.raw, trace.pieces))

		const paths: Record<Arm, number[]> = {
			mask: viterbi(masked).path,
			...Object.fromEntries(
				TEMPERATURES.map((t) => [
					`transitions-t${t}`,
					viterbi({
						emissions: trace.emissions,
						transitions: addMatrices(masked.transitions, fitted.transitions, t),
						startTransitions: addVectors(masked.startTransitions, fitted.start_transitions, t),
						endTransitions: addVectors(masked.endTransitions, fitted.end_transitions, t),
					}).path,
				])
			),
			cardinality: cardinality.result.path,
		} as Record<Arm, number[]>

		const matches = Object.fromEntries(
			ARMS.map((arm) => [
				arm,
				gold
					? labelsMatchGold(
							paths[arm]!.map((index) => labels[index] ?? "O"),
							gold
						)
					: false,
			])
		) as Record<Arm, boolean>

		records.push({
			suite,
			raw: row.raw,
			population: population.get(key(suite, row.raw)) ?? "unreplayed",
			families: [...(familiesByKey.get(key(suite, row.raw)) ?? [])],
			gold: gold !== null,
			pathMatches: matches,
			cardinalityRank: cardinality.rank,
			cardinalityFellBack: cardinality.fellBack,
			exact,
			cardinalityExact,
		})

		rows++
	}

	console.log(`[decoder-arms] ${suite}: ${rows} rows`)
}

await writeLocalTextFile(
	records.map((record) => stringifyJSON(record)),
	resolvePath(values.out, "rows.jsonl")
)

interface Tally {
	rows: number
	maskMatches: number
	arms: Record<string, { matches: number; fixed: number; broken: number }>
	cardinalityExact: { exact: number; armExact: number; fixed: number; broken: number }
}

function tally(rows: readonly ArmRecord[]): Tally {
	const arms = Object.fromEntries(
		ARMS.filter((arm) => arm !== "mask").map((arm) => [
			arm,
			{
				matches: rows.filter((row) => row.pathMatches[arm]).length,
				fixed: rows.filter((row) => row.pathMatches[arm] && !row.pathMatches.mask).length,
				broken: rows.filter((row) => !row.pathMatches[arm] && row.pathMatches.mask).length,
			},
		])
	)

	return {
		rows: rows.length,
		maskMatches: rows.filter((row) => row.pathMatches.mask).length,
		arms,
		cardinalityExact: {
			exact: rows.filter((row) => row.exact).length,
			armExact: rows.filter((row) => row.cardinalityExact).length,
			fixed: rows.filter((row) => row.cardinalityExact && !row.exact).length,
			broken: rows.filter((row) => !row.cardinalityExact && row.exact).length,
		},
	}
}

const families = [...new Set(records.flatMap((record) => record.families))].toSorted()

await writeLocalJSONFile(
	{
		arm: values.arm,
		transitions: values.transitions,
		rows: records.length,
		goldUnrepresentable: records.filter((record) => !record.gold).length,
		cardinalityFellBack: records.filter((record) => record.cardinalityFellBack).length,
		cardinalityTookLowerRank: records.filter((record) => record.cardinalityRank > 0).length,
		all: tally(records),
		bothFail: tally(records.filter((record) => record.population === "both-fail")),
		bothPass: tally(records.filter((record) => record.population === "both-pass")),
		families: Object.fromEntries(
			families.map((family) => [
				family,
				tally(records.filter((record) => record.population === "both-fail" && record.families.includes(family))),
			])
		),
	},
	resolvePath(values.out, "summary.json")
)

console.log(`[decoder-arms] ${records.length} rows`)
