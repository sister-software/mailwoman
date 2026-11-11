/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman registry scorer-eval <kind>`: the record-matcher eval and benchmark suite.
 *
 *   Most kinds need the record-matcher source files, the weights and the WOF and database data
 *   locally, so they're operator-run.
 */

import { allKeyed } from "@mailwoman/core/promises"
import type { EvalGeocoderFactory, EvalGeocodeStream } from "@mailwoman/entity-resolution/tools/eval-geocoder"

import {
	type CommandSpec,
	CommandTaskResult,
	type OptionsOf,
	numberOption,
	type CommandComponent,
	reportToStderr,
	stringOption,
	useCommandTask,
} from "#cli-kit"

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

/**
 * Native command-line interface consumed by the filesystem command router.
 */
export const spec = {
	name: "scorer-eval",
	description: "Run a registry scorer evaluation",
	positionals: [{ name: "kind", required: true, choices: kinds, description: "Evaluation kind" }],
	options: {
		sources: stringOption("Record-matcher sources directory"),
		wof: stringOption("WOF admin SQLite path"),
		"data-root": stringOption("Per-state database root"),
		"out-md": stringOption("Markdown report path"),
		state: stringOption("State filter"),
		npis: numberOption("NPIs sampled"),
		cap: numberOption("Sample cap"),
		max: numberOption("Facilities geocoded"),
		"max-npis": numberOption("NPPES sample size"),
		tau: numberOption("Collision threshold"),
		seed: numberOption("PRNG seed"),
		seeds: numberOption("Splits averaged"),
		split: numberOption("Train fraction"),
		"train-state": stringOption("State used for model fitting"),
		"eval-state": stringOption("Evaluation state"),
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
		"corpus-frequency": { type: "boolean", default: true, description: "Build corpus frequency table" },
		"out-geojson": stringOption("GeoJSON artifact path"),
	},
} as const satisfies CommandSpec

type Options = OptionsOf<typeof spec>

/**
 * What every evaluator reads: the geocoder factory, the record-matcher sources and the report path.
 */
interface EvalBase {
	createGeocoder: EvalGeocoderFactory
	sources: Options["sources"]
	outMd: Options["outMd"]
}

/**
 * One evaluation kind: it loads that kind's module, runs it and answers the line the command prints.
 */
type KindEvaluator = (base: EvalBase, options: Options) => Promise<string>

/**
 * The evaluator of each kind.
 *
 * Each entry imports its own module when it runs, so a run loads the one kind it was asked for.
 */
const EVALUATORS = {
	pairwise: async (base, options) => {
		const { scorerPairwiseEval } = await import("@mailwoman/entity-resolution/tools/learned/scorer/eval")

		await scorerPairwiseEval(
			{ ...base, state: options.state, npis: options.npis, seed: options.seed, seeds: options.seeds },
			reportToStderr
		)

		return "pairwise: report emitted"
	},
	clustering: async (base, options) => {
		const { scorerClusteringEval } = await import("@mailwoman/entity-resolution/tools/learned/scorer/clustering-eval")

		await scorerClusteringEval(
			{
				...base,
				state: options.state,
				npis: options.npis,
				split: options.split,
				seed: options.seed,
				seeds: options.seeds,
			},
			reportToStderr
		)

		return "clustering: report emitted"
	},
	"cross-state": async (base, options) => {
		const { scorerCrossStateEval } = await import("@mailwoman/entity-resolution/tools/learned/scorer/crossstate-eval")

		await scorerCrossStateEval(
			{ ...base, trainState: options.trainState, evalState: options.evalState, npis: options.npis },
			reportToStderr
		)

		return "cross-state: report emitted"
	},
	// The same tool as `registry dedup-ceiling`, geocode-free, kept here
	// so the whole eval suite is reachable from one command.
	"dedup-ceiling": async (_base, options) => {
		const { dedupCeiling } = await import("@mailwoman/entity-resolution/tools/dedup-ceiling")

		const res = await dedupCeiling(
			{ sources: options.sources, cap: options.cap, state: options.state, tau: options.tau, outMd: options.outMd },
			reportToStderr
		)

		return `dedup-ceiling: ${res.collide} collisions over ${res.pairs} co-located pairs`
	},
	"nppes-benchmark": async (base, options) => {
		const { nppesDedupBenchmark } = await import("@mailwoman/entity-resolution/tools/nppes/dedup-benchmark")

		// The threaded-geocode surface is injected lazily.
		// The worker pool only loads when requested.
		const geocodeStream: EvalGeocodeStream = (records, opts) =>
			(async function* () {
				const { stream, dataRoot, wofPaths } = await allKeyed({
					stream: import("#geocode/stream"),
					dataRoot: import("@mailwoman/core/data-root"),
					wofPaths: import("@mailwoman/resolver-wof-sqlite/paths"),
				})

				yield* stream.geocodeStream(records, {
					mapping: opts.mapping,
					geocode: {
						wofDBPath: options.wof || wofPaths.wofDatabasePath("admin-global-priority.db").toString(),
						dataRoot: options.dataRoot || dataRoot.dataRootPath().toString(),
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
			reportToStderr
		)

		return "nppes-benchmark: report emitted"
	},
	"coverage-reconciliation": async (base, options) => {
		const { coverageReconciliation } = await import("@mailwoman/entity-resolution/tools/coverage-reconciliation")

		await coverageReconciliation(
			{ ...base, cap: options.cap, state: options.state, outGeojson: options.outGeojson },
			reportToStderr
		)

		return "coverage-reconciliation: report emitted"
	},
	"cross-dataset": async (base, options) => {
		const { crossDatasetCorrelation } = await import("@mailwoman/entity-resolution/tools/cross/dataset-correlation")

		await crossDatasetCorrelation(
			{
				...base,
				cap: options.cap,
				state: options.state,
				corpusFrequency: options.corpusFrequency,
				outGeojson: options.outGeojson,
			},
			reportToStderr
		)

		return "cross-dataset: report emitted"
	},
	"threshold-sweep": async (base, options) => {
		const { crossSourceThresholdSweep } =
			await import("@mailwoman/entity-resolution/tools/cross/source-threshold-sweep")

		await crossSourceThresholdSweep(
			{ ...base, cap: options.cap, state: options.state, candidate: options.candidate },
			reportToStderr
		)

		return "threshold-sweep: report emitted"
	},
	"namesake-probe": async (base) => {
		const { geocoderNamesakeProbe } = await import("@mailwoman/entity-resolution/tools/geocoder/namesake-probe")
		const res = await geocoderNamesakeProbe({ createGeocoder: base.createGeocoder }, reportToStderr)

		return `namesake-probe: ${res.wrongRegion}/${res.total} variants wrong-region`
	},
	"vs-provided-coords": async (base, options) => {
		const { geocoderVsProvidedCoords } = await import("@mailwoman/entity-resolution/tools/geocoder/vs-provided-coords")

		await geocoderVsProvidedCoords({ ...base, max: options.max }, reportToStderr)

		return "vs-provided-coords: report emitted"
	},
} as const satisfies Record<Kind, KindEvaluator>

async function runKind(kind: Kind, options: Options): Promise<string> {
	const { evalGeocoderFactory } = await import("#commands/registry/run")

	const createGeocoder = evalGeocoderFactory({
		wof: options.wof,
		dataRoot: options.dataRoot,
		modelPath: options.model,
		tokenizerPath: options.tokenizer,
		modelCardPath: options.modelCard,
	})

	return EVALUATORS[kind]({ createGeocoder, sources: options.sources, outMd: options.outMd }, options)
}

const RegistryScorerEval: CommandComponent<typeof spec, [Kind]> = ({ options, args }) => {
	const state = useCommandTask(async () => runKind(args[0], options))

	return <CommandTaskResult state={state} />
}

export default RegistryScorerEval
