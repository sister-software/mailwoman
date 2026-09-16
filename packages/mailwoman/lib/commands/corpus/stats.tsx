/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Report corpus statistics.
 */

import { type CommandSpec, CommandTaskResult, type CommandComponent, useCommandTask } from "#cli-kit"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "stats",
	description: "Build corpus statistics.",
	options: {
		parquet: {
			type: "string",
			required: true,
			description: "Comma-separated parquet file paths or a directory",
			deprecatedName: "slices",
		},
		out: { type: "string", required: true, description: "Output corpus-stats.json path", deprecatedName: "output" },
		"limit-per-file": {
			type: "number",
			description: "Row cap per parquet file (debug)",
			deprecatedName: "limit-per-slice",
		},
	},
} as const satisfies CommandSpec

const Cmd: CommandComponent<typeof spec> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { buildCorpusStats } = await import("@mailwoman/corpus/tools")

		await buildCorpusStats({
			slicesArg: options.parquet,
			outputPath: options.out,
			limitPerSlice: options.limitPerFile,
		})

		return "done"
	})

	return <CommandTaskResult state={state} />
}

export default Cmd
