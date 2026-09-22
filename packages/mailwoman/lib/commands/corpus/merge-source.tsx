/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman corpus merge-source --inputs <a.parquet,b.parquet> --out <merged.parquet>` — merge one
 *   source's overlay parquet files into a single file whose rows are shuffled across them.
 *
 *   An epoch draws a bounded number of rows per source and reads one row-group to get them, so a
 *   source whose countries sit in separate files reaches only the countries of the file the draw lands
 *   in. Merging and shuffling puts every country of the source in every output row-group.
 */

import { extractDelimited } from "@mailwoman/core/scripting/arguments"
import { CommandError } from "@mailwoman/core/scripting/command"
import { Box, Text } from "ink"

import { type CommandSpec, CommandTaskResult, type CommandComponent, useCommandTask } from "#cli-kit"

/**
 * Native command-line interface consumed by the filesystem command router.
 */
export const spec = {
	name: "merge-source",
	description: "Merge one source's parquet files into a single shuffled file.",
	options: {
		inputs: { type: "string", required: true, description: "Parquet files to merge, comma-separated" },
		out: { type: "string", required: true, description: "The merged parquet file to write" },
		window: { type: "number", description: "Rows held in memory while shuffling" },
		seed: { type: "number", description: "Shuffle seed. Defaults to the corpus writer's own" },
	},
} as const satisfies CommandSpec

const Cmd: CommandComponent<typeof spec> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { mergeSourceFiles } = await import("@mailwoman/corpus/tools")
		const inputs = extractDelimited(options.inputs)

		if (inputs.length < 2) {
			throw new CommandError(`--inputs names ${inputs.length} file; merging takes two or more`)
		}

		return mergeSourceFiles({ inputs, output: options.out, windowSize: options.window, seed: options.seed })
	})

	if (state.status !== "done") return <CommandTaskResult state={state} />

	const { rows, byCountry, bySource, outputs } = state.result
	const countries = Object.entries(byCountry).toSorted(([, a], [, b]) => b - a)

	return (
		<Box flexDirection="column">
			<Text>
				{rows.toLocaleString()} rows → {outputs.length} file{outputs.length === 1 ? "" : "s"}
			</Text>

			{outputs.map((output) => (
				<Text key={output}>{`  ${output}`}</Text>
			))}

			<Text>{`  source: ${Object.keys(bySource).join(", ")}`}</Text>

			{countries.map(([country, count]) => (
				<Text key={country}>{`  ${country}: ${count.toLocaleString()}`}</Text>
			))}
		</Box>
	)
}

export default Cmd
