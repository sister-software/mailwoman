/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman registry train-scorer <variant>` — train + emit a committed learned-scorer model:
 *   `gbt` (the production dedup GBT, #603), `cross-gbt` (the NPI-anchored cross-source link scorer,
 *   #655 option 2), or `org-cross-gbt` (the CCN-anchored org-level cross-source scorer). Needs the
 *   record-matcher source files, weights, and WOF/shard data locally — operator-run, not CI.
 */

import { Text } from "ink"

import {
	type CommandSpec,
	CommandTaskResult,
	type ParsedCommandComponent,
	reportToStderr,
	useCommandTask,
} from "#cli-kit"

const variants = ["gbt", "cross-gbt", "org-cross-gbt"] as const

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "train-scorer",
	description: "Train a learned registry scorer.",
	positionals: [{ name: "variant", required: true, choices: variants, description: "Model variant" }],
	options: {
		sources: { type: "string", description: "Record-matcher sources" },
		state: { type: "string", description: "State filter" },
		npis: { type: "number", description: "NPIs sampled" },
		cap: { type: "number", description: "Facility cap" },
		cost: { type: "number", description: "Negative-class weight" },
		"precision-bar": { type: "number", description: "Held-out precision bar" },
		out: { type: "string", description: "Output module" },
		locale: { type: "string", default: "en-US", description: "Weights locale" },
		date: { type: "string", description: "Training date" },
		wof: { type: "string", description: "WOF database" },
		"data-root": { type: "string", description: "Per-state database root" },
	},
} as const satisfies CommandSpec

interface Options {
	sources?: string
	state?: string
	npis?: number
	cap?: number
	cost?: number
	precisionBar?: number
	out?: string
	locale: string
	date?: string
	wof?: string
	dataRoot?: string
}

type Variant = (typeof variants)[number]

async function runVariant(variant: Variant, options: Options): Promise<{ out: string; pairs: number }> {
	const { trainCrossSourceGBT, trainDedupGBT, trainOrgCrossSourceGBT } = await import("@mailwoman/registry/tools")
	const { evalGeocoderFactory } = await import("#commands/registry/run")

	const createGeocoder = evalGeocoderFactory({
		wof: options.wof,
		dataRoot: options.dataRoot,
		locale: options.locale,
	})

	const base = { createGeocoder, sources: options.sources, out: options.out, locale: options.locale }

	switch (variant) {
		case "gbt":
			return trainDedupGBT(
				{ ...base, state: options.state, npis: options.npis, cost: options.cost, date: options.date },
				reportToStderr
			)
		case "cross-gbt":
			return trainCrossSourceGBT(
				{
					...base,
					state: options.state,
					npis: options.npis,
					precisionBar: options.precisionBar,
					date: options.date,
				},
				reportToStderr
			)
		case "org-cross-gbt":
			return trainOrgCrossSourceGBT(
				{ ...base, cap: options.cap, precisionBar: options.precisionBar, date: options.date },
				reportToStderr
			)
	}
}

const RegistryTrainScorer: ParsedCommandComponent<Options, [Variant]> = ({ options, args }) => {
	const state = useCommandTask(() => runVariant(args[0], options))

	if (state.status !== "done") return <CommandTaskResult state={state} />

	if (state.status === "done") {
		return (
			<Text color="green">
				train-scorer {args[0]}: {state.result.pairs} pairs → {state.result.out}
			</Text>
		)
	}

	return null
}

export default RegistryTrainScorer
