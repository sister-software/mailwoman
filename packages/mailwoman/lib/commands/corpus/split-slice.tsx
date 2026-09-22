/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman corpus split-slice --input <parquet> --out-dir <dir>` — route one overlay parquet
 *   through the holdout policy the base build applies, writing a parquet per split it reaches.
 *
 *   An overlay is appended to a manifest as a train file, so a country whose only rows of a given
 *   kind live in an overlay has no held-out row of that kind. Pass the per-split outputs to
 *   `mailwoman corpus overlay-manifest --split` so the manifest records where each one belongs.
 */

import { Box, Text } from "ink"

import { type CommandSpec, CommandTaskResult, type CommandComponent, useCommandTask } from "#cli-kit"

/**
 * Native command-line interface consumed by the filesystem command router.
 */
export const spec = {
	name: "split-slice",
	description: "Route an overlay parquet through the corpus holdout policy.",
	options: {
		input: { type: "string", required: true, description: "The overlay parquet to route" },
		"out-dir": { type: "string", required: true, description: "Directory the per-split parquets are written to" },
	},
} as const satisfies CommandSpec

const Cmd: CommandComponent<typeof spec> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { splitOverlaySlice } = await import("@mailwoman/corpus/tools")

		return splitOverlaySlice({ input: options.input, outputDir: options.outDir })
	})

	if (state.status !== "done") return <CommandTaskResult state={state} />

	const { rows, counts, outputs } = state.result

	return (
		<Box flexDirection="column">
			<Text>
				{rows.toLocaleString()} rows read from {state.result.input}
			</Text>

			{(["train", "val", "test"] as const).map((split) => (
				<Text key={split}>
					{"  "}
					{split}: {counts[split].toLocaleString()} {outputs[split] ? `→ ${outputs[split]}` : "(no file written)"}
				</Text>
			))}
		</Box>
	)
}

export default Cmd
