/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman corpus stats` — ported from the scripts drawer (PR E, #1029). The tool module is
 *   lazy-imported so eager command loading stays dependency-light.
 */

import { Text } from "ink"
import zod from "zod"

import { type CommandComponent, useCommandTask } from "../../cli-kit/index.ts"

const OptionsSchema = zod.object({
	shards: zod.string().describe("Comma-separated parquet shard paths or a directory"),
	output: zod.string().describe("Output corpus-stats.json path"),
	limitPerShard: zod.string().optional().describe("Row cap per shard (debug)"),
})

export { OptionsSchema as options }

const Cmd: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { buildCorpusStats } = await import("@mailwoman/corpus/tools")
		await buildCorpusStats({
			shardsArg: options.shards,
			outputPath: options.output,
			limitPerShard: options.limitPerShard ? Number(options.limitPerShard) : undefined,
		})

		return "done"
	})

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status === "done") return <Text color="green">✓ {state.result}</Text>

	return null
}

export default Cmd
