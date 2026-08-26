/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman registry scorer-eval <kind>` — the record-matcher eval/benchmark suite (the retired
 *   `scripts/eval/record-matcher/` scripts, one enum command). Kinds: `pairwise` / `clustering` /
 *   `cross-state` (the learned-scorer evals), `dedup-ceiling` (the #625 Bayes-error measurement —
 *   also its own `registry dedup-ceiling` command), `nppes-benchmark` (#617), and the cross-dataset
 *   family (`coverage-reconciliation`, `cross-dataset`, `threshold-sweep`) plus the geocoder probes
 *   (`namesake-probe`, `vs-provided-coords`). Every kind emits its report to stdout; most need the
 *   record-matcher source files + weights + WOF/shard data locally — operator-run, not CI.
 */

import type { EvalGeocodeStream } from "@mailwoman/registry/tools"
import { Text } from "ink"

import { type CommandSpec, type ParsedCommandComponent, useCommandTask } from "#cli-kit"

const kinds = [
	"pairwise",
	"clustering",
	"cross-state",
	"dedup-ceiling",
	"nppes-benchmark",
	"coverage-reconciliation",
	"cross-dataset",
	"threshold-sweep",
	"namesake-probe",
	"vs-provided-coords",
] as const

type Kind = (typeof kinds)[number]
const stringOption = (description: string) => ({ type: "string" as const, description })
const numberOption = (description: string) => ({ type: "number" as const, description })

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "scorer-eval",
	description: "Run a registry scorer evaluation",
	positionals: [{ name: "kind", required: true, choices: kinds, description: "Evaluation kind" }],
	options: {
		// shared data wiring
		sources: stringOption("Record-matcher sources directory"),
		wof: stringOption("WOF admin SQLite path"),
		"data-root": stringOption("Per-state database root"),
		"out-md": stringOption("Markdown report path"),
		// sampling
		state: stringOption("State filter"),
		npis: numberOption("NPIs sampled"),
		cap: numberOption("Sample cap"),
		max: numberOption("Facilities geocoded"),
		"max-npis": numberOption("NPPES sample size"),
		tau: numberOption("Collision threshold"),
		// splits + seeds
		seed: numberOption("PRNG seed"),
		seeds: numberOption("Splits averaged"),
		split: numberOption("Train fraction"),
		"train-state": stringOption("Training state"),
		"eval-state": stringOption("Evaluation state"),
		// nppes-benchmark
		"train-em": { type: "boolean", default: true, description: "EM-train FS arms" },
		"legacy-join": { type: "boolean", default: false, description: "Use legacy join" },
		candidate: stringOption("GBT module"),
		"dump-overmerges": stringOption("Adjudication packet path"),
		"h3-res": numberOption("H3 resolution"),
		"parallel-geocode": { type: "boolean", default: false, description: "Use geocode worker pool" },
		"geo-concurrency": numberOption("Geocode concurrency"),
		model: stringOption("Model path"),
		tokenizer: stringOption("Tokenizer path"),
		"model-card": stringOption("Model card path"),
		// cross-dataset family
		"corpus-frequency": { type: "boolean", default: true, description: "Build corpus frequency table" },
		"out-geojson": stringOption("GeoJSON artifact path"),
	},
} as const satisfies CommandSpec

interface Options {
	sources?: string
	wof?: string
	dataRoot?: string
	outMd?: string
	state?: string
	npis?: number
	cap?: number
	max?: number
	maxNpis?: number
	tau?: number
	seed?: number
	seeds?: number
	split?: number
	trainState?: string
	evalState?: string
	trainEm: boolean
	legacyJoin: boolean
	candidate?: string
	dumpOvermerges?: string
	h3Res?: number
	parallelGeocode: boolean
	geoConcurrency?: number
	model?: string
	tokenizer?: string
	modelCard?: string
	corpusFrequency: boolean
	outGeojson?: string
}

const report = (line: string): void => console.error(line)

async function runKind(kind: Kind, options: Options): Promise<string> {
	const {
		coverageReconciliation,
		crossDatasetCorrelation,
		crossSourceThresholdSweep,
		dedupCeiling,
		geocoderNamesakeProbe,
		geocoderVsProvidedCoords,
		nppesDedupBenchmark,
		scorerClusteringEval,
		scorerCrossStateEval,
		scorerPairwiseEval,
	} = await import("@mailwoman/registry/tools")

	const { evalGeocoderFactory } = await import("./run.tsx")

	const createGeocoder = evalGeocoderFactory({
		wof: options.wof,
		dataRoot: options.dataRoot,
		modelPath: options.model,
		tokenizerPath: options.tokenizer,
		modelCardPath: options.modelCard,
	})

	const base = { createGeocoder, sources: options.sources, outMd: options.outMd }

	switch (kind) {
		case "pairwise": {
			await scorerPairwiseEval(
				{ ...base, state: options.state, npis: options.npis, seed: options.seed, seeds: options.seeds },
				report
			)

			return "pairwise: report emitted"
		}
		case "clustering": {
			await scorerClusteringEval(
				{
					...base,
					state: options.state,
					npis: options.npis,
					split: options.split,
					seed: options.seed,
					seeds: options.seeds,
				},
				report
			)

			return "clustering: report emitted"
		}
		case "cross-state": {
			await scorerCrossStateEval(
				{ ...base, trainState: options.trainState, evalState: options.evalState, npis: options.npis },
				report
			)

			return "cross-state: report emitted"
		}
		case "dedup-ceiling": {
			// The same tool as `registry dedup-ceiling` (geocode-free) — kept in this enum so the whole
			// record-matcher eval suite is reachable from one command.
			const res = await dedupCeiling(
				{ sources: options.sources, cap: options.cap, state: options.state, tau: options.tau, outMd: options.outMd },
				report
			)

			return `dedup-ceiling: ${res.collide} collisions over ${res.pairs} co-located pairs`
		}
		case "nppes-benchmark": {
			// The threaded-geocode surface is injected lazily — the worker pool only loads when requested.
			const geocodeStream: EvalGeocodeStream = (records, opts) =>
				(async function* () {
					const { geocodeStream: stream } = await import("../../geocode-stream.ts")
					const { dataRootPath } = await import("@mailwoman/core/utils")
					const { mailwomanDataRoot } = await import("../../resolver-backend.ts")

					yield* stream(records, {
						mapping: opts.mapping,
						geocode: {
							wofDBPath: options.wof || String(dataRootPath("wof", "admin-global-priority.db")),
							dataRoot: options.dataRoot || mailwomanDataRoot(),
							locale: "en-US",
							country: "US",
						},
						concurrency: opts.concurrency,
					})
				})()

			await nppesDedupBenchmark(
				{
					...base,
					geocodeStream,
					state: options.state,
					maxNpis: options.maxNpis,
					trainEm: options.trainEm,
					legacyJoin: options.legacyJoin,
					candidate: options.candidate,
					dumpOvermerges: options.dumpOvermerges,
					h3Res: options.h3Res,
					parallelGeocode: options.parallelGeocode,
					geoConcurrency: options.geoConcurrency,
				},
				report
			)

			return "nppes-benchmark: report emitted"
		}
		case "coverage-reconciliation": {
			await coverageReconciliation(
				{ ...base, cap: options.cap, state: options.state, outGeojson: options.outGeojson },
				report
			)

			return "coverage-reconciliation: report emitted"
		}
		case "cross-dataset": {
			await crossDatasetCorrelation(
				{
					...base,
					cap: options.cap,
					state: options.state,
					corpusFrequency: options.corpusFrequency,
					outGeojson: options.outGeojson,
				},
				report
			)

			return "cross-dataset: report emitted"
		}
		case "threshold-sweep": {
			await crossSourceThresholdSweep(
				{ ...base, cap: options.cap, state: options.state, candidate: options.candidate },
				report
			)

			return "threshold-sweep: report emitted"
		}
		case "namesake-probe": {
			const res = await geocoderNamesakeProbe({ createGeocoder }, report)

			return `namesake-probe: ${res.wrongRegion}/${res.total} variants wrong-region`
		}
		case "vs-provided-coords": {
			await geocoderVsProvidedCoords({ ...base, max: options.max }, report)

			return "vs-provided-coords: report emitted"
		}
	}
}

const RegistryScorerEval: ParsedCommandComponent<Options, [Kind]> = ({ options, args }) => {
	const state = useCommandTask(() => runKind(args[0], options))

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status === "done") return <Text color="green">{state.result}</Text>

	return null
}

export default RegistryScorerEval
