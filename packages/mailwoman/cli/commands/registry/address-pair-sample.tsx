/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman registry address-pair-sample`: sample cross-source address-point pairs from a built address layer,
 *   stratified by failure shape, as JSONL rows for adjudication.
 */

import { allKeyed } from "@mailwoman/core/promises"
import { extractDelimited } from "@mailwoman/core/scripting/arguments"
import { CommandError } from "@mailwoman/core/scripting/command"

import {
	type CommandSpec,
	CommandSummaryLines,
	CommandTaskResult,
	type CommandComponent,
	useCommandTask,
} from "#cli-kit"

/**
 * Native command-line interface consumed by the filesystem command router.
 */
export const spec = {
	name: "address-pair-sample",
	description: "Sample cross-source address-point pairs from an address layer for adjudication.",
	options: {
		"layer-version": { type: "string", description: "The address layer version, such as 2026-11-08" },
		regions: { type: "string", description: "Comma-separated regions, such as us-ny,us-co" },
		"per-stratum": { type: "number", default: 60, description: "Pairs kept per stratum across all regions" },
		seed: { type: "number", default: 1, description: "Selects which key groups are read" },
		"out-jsonl": { type: "string", description: "Write the sampled pairs here as JSONL" },
	},
} as const satisfies CommandSpec

const RegistryAddressPairSample: CommandComponent<typeof spec> = ({ options }) => {
	const state = useCommandTask(async () => {
		if (!options.layerVersion) throw new CommandError("--layer-version is required")

		if (!options.regions) throw new CommandError("--regions is required")

		const {
			dataRoot: { dataRootPath },
			sample: { addressPairSample },
		} = await allKeyed({
			dataRoot: import("@mailwoman/core/data-root"),
			sample: import("@mailwoman/entity-resolution/tools/address-pairs/sample"),
		})

		const result = await addressPairSample(
			{
				root: dataRootPath("db"),
				version: options.layerVersion,
				regions: extractDelimited(options.regions),
				perStratum: options.perStratum,
				seed: options.seed,
				outJSONL: options.outJSONL,
			},
			(line) => console.error(line)
		)

		return Object.entries(result.strata).map(
			([stratum, kept]) =>
				`${stratum}: ${kept} kept of ${result.candidates[stratum as keyof typeof result.candidates]} seen`
		)
	})

	if (state.status !== "done") return <CommandTaskResult state={state} />

	return <CommandSummaryLines lines={state.result} />
}

export default RegistryAddressPairSample
