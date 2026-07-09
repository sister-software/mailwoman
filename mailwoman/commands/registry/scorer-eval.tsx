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

import {
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
	type EvalGeocodeStream,
} from "@mailwoman/registry/tools"
import { Text } from "ink"
import { argument } from "pastel"
import zod from "zod"

import { type CommandComponent, useCommandTask } from "../../cli-kit/index.ts"
import { evalGeocoderFactory } from "./run.tsx"

export const args = zod.tuple([
	zod
		.enum([
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
		])
		.describe(
			argument({
				name: "kind",
				description: "Eval kind (pairwise, clustering, cross-state, nppes-benchmark, …)",
			})
		),
])

const OptionsSchema = zod.object({
	// shared data wiring
	sources: zod
		.string()
		.optional()
		.describe("Record-matcher sources dir (default $MAILWOMAN_DATA_ROOT/record-matcher/sources)"),
	wof: zod
		.string()
		.optional()
		.describe("WOF admin SQLite path (default $MAILWOMAN_DATA_ROOT/wof/admin-global-priority.db)"),
	dataRoot: zod.string().optional().describe("Per-state shard root (default $MAILWOMAN_DATA_ROOT)"),
	outMd: zod.string().optional().describe("Also write the markdown report here"),
	// sampling
	state: zod.string().optional().describe("State filter (default TX)"),
	npis: zod.number().optional().describe("pairwise/clustering/cross-state: NPIs sampled"),
	cap: zod
		.number()
		.optional()
		.describe("dedup-ceiling/coverage-reconciliation/cross-dataset/threshold-sweep: sample cap"),
	max: zod.number().optional().describe("vs-provided-coords: facilities geocoded (default 2000)"),
	maxNpis: zod.number().optional().describe("nppes-benchmark: NPIs sampled (default 300)"),
	tau: zod.number().optional().describe("dedup-ceiling: org-name Jaccard collision threshold (default 0.7)"),
	// splits + seeds
	seed: zod.number().optional().describe("pairwise/clustering: base PRNG seed (default 1)"),
	seeds: zod.number().optional().describe("pairwise/clustering: splits averaged (default 8 / 4)"),
	split: zod.number().optional().describe("clustering: train fraction of the NPI split (default 0.67)"),
	trainState: zod.string().optional().describe("cross-state: state the GBT/LR train on (default TX)"),
	evalState: zod.string().optional().describe("cross-state: held-out state clustered (default CA)"),
	// nppes-benchmark
	trainEm: zod.boolean().default(true).describe("nppes-benchmark: EM-train the FS arms (--no-train-em uses seeds)"),
	legacyJoin: zod
		.boolean()
		.default(false)
		.describe("nppes-benchmark: #694 A/B — pre-flip space-join + normalizeCase off"),
	candidate: zod
		.string()
		.optional()
		.describe("nppes-benchmark/threshold-sweep: a trained GBT TS module to grade as an extra arm"),
	dumpOvermerges: zod.string().optional().describe("nppes-benchmark: write the #625 gold-set adjudication packet here"),
	h3Res: zod.number().optional().describe("nppes-benchmark: H3 resolution for the org-name-h3 grain (default 11)"),
	parallelGeocode: zod
		.boolean()
		.default(false)
		.describe("nppes-benchmark: geocode across a worker pool (mailwoman/geocode-stream)"),
	geoConcurrency: zod.number().optional().describe("nppes-benchmark: worker-pool concurrency (default 2)"),
	model: zod.string().optional().describe("nppes-benchmark: model-swap ONNX path (requires --model-card)"),
	tokenizer: zod.string().optional().describe("nppes-benchmark: model-swap tokenizer path"),
	modelCard: zod.string().optional().describe("nppes-benchmark: model-swap model-card path"),
	// cross-dataset family
	corpusFrequency: zod
		.boolean()
		.default(true)
		.describe("cross-dataset: build the corpus-wide address-frequency table (--no-corpus-frequency skips)"),
	outGeojson: zod
		.string()
		.optional()
		.describe("coverage-reconciliation/cross-dataset: also write the GeoJSON artifact here"),
})

export { OptionsSchema as options }

type Options = zod.infer<typeof OptionsSchema>
type Kind = zod.infer<typeof args>[0]

const report = (line: string): void => console.error(line)

async function runKind(kind: Kind, options: Options): Promise<string> {
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

const RegistryScorerEval: CommandComponent<typeof OptionsSchema, typeof args> = ({ options, args }) => {
	const state = useCommandTask(() => runKind(args[0], options))

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status === "done") return <Text color="green">{state.result}</Text>

	return null
}

export default RegistryScorerEval
