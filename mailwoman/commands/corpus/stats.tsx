/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Report corpus statistics.
 */

import { Text } from "ink"
import { type CommandSpec, type ParsedCommandComponent, useCommandTask } from "mailwoman/cli-kit"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "stats",
	description: "Build corpus statistics.",
	options: {
		shards: { type: "string", required: true, description: "Comma-separated parquet shard paths or a directory" },
		output: { type: "string", required: true, description: "Output corpus-stats.json path" },
		"limit-per-shard": { type: "number", description: "Row cap per shard (debug)" },
	},
} as const satisfies CommandSpec

interface Options {
	shards: string
	output: string
	limitPerShard?: number
}

const Cmd: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { buildCorpusStats } = await import("@mailwoman/corpus/tools")

		await buildCorpusStats({
			shardsArg: options.shards,
			outputPath: options.output,
			limitPerShard: options.limitPerShard,
		})

		return "done"
	})

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status === "done") return <Text color="green">✓ {state.result}</Text>

	return null
}

export default Cmd
