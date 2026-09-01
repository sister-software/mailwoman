/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Report corpus statistics.
 */

import { type CommandSpec, CommandTaskResult, type ParsedCommandComponent, useCommandTask } from "#cli-kit"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "stats",
	description: "Build corpus statistics.",
	options: {
		slices: { type: "string", required: true, description: "Comma-separated parquet slice paths or a directory" },
		output: { type: "string", required: true, description: "Output corpus-stats.json path" },
		"limit-per-slice": { type: "number", description: "Row cap per slice (debug)" },
	},
} as const satisfies CommandSpec

interface Options {
	slices: string
	output: string
	limitPerSlice?: number
}

const Cmd: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { buildCorpusStats } = await import("@mailwoman/corpus/tools")

		await buildCorpusStats({
			slicesArg: options.slices,
			outputPath: options.output,
			limitPerSlice: options.limitPerSlice,
		})

		return "done"
	})

	return <CommandTaskResult state={state} />
}

export default Cmd
