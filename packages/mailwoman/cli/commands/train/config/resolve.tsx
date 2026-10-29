/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman train config resolve <config.yaml> --out <resolved.json>` writes the versioned resolved training
 *   config the Rust trainer and sampler read: every default applied, the YAML path absolute, and the source
 *   admission record embedded. It refuses a config the Python loader refuses, and a config that admits a source
 *   whose register rows lack a transform and train permission unless `data.unshippable_reason` is set.
 */

import { Box, Text } from "ink"

import { type CommandComponent, type CommandSpec, CommandTaskResult, useCommandTask } from "#cli-kit"

/**
 * Native command-line interface consumed by the filesystem command router.
 */
export const spec = {
	name: "resolve",
	description: "Write a training config's versioned resolved form, with its defaults and source admission.",
	positionals: [{ name: "config", required: true, description: "The training config YAML" }],
	options: {
		out: { type: "string", required: true, description: "The resolved config JSON to write" },
	},
} as const satisfies CommandSpec

const TrainConfigResolve: CommandComponent<typeof spec, [string]> = ({ options, args }) => {
	const state = useCommandTask(async () => {
		const { writeResolvedTrainingConfig } = await import("@mailwoman/corpus/training/config/load")

		return writeResolvedTrainingConfig(args[0], options.out)
	})

	if (state.status !== "done") return <CommandTaskResult state={state} />

	const { config_path, derived, source_rights } = state.result

	return (
		<Box flexDirection="column">
			<Text>{`${config_path} -> ${options.out}`}</Text>
			<Text>
				{`corpus ${derived.corpus_version}, ${derived.admitted_sources.length} admitted sources, ` +
					(source_rights.shippable ? "shippable" : `not shippable: ${source_rights.unshippable_reason}`)}
			</Text>
		</Box>
	)
}

export default TrainConfigResolve
