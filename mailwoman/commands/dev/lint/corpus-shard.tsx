/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman dev lint corpus-shard --shard <parquet> --stats <stats.json>` — corpus linter:
 *   compares a new shard against pre-computed corpus statistics (see `mailwoman corpus stats`) and
 *   flags the v0.6.2 "5th Avenue Theatre" class of poisoning patterns. Markdown report on stdout;
 *   exits 1 when any error-severity flag fires (warnings don't gate).
 */

import { lintCorpusShard } from "@mailwoman/corpus/tools"
import { Text } from "ink"
import zod from "zod"

import { type CommandComponent, useCommandTask } from "../../../cli-kit/index.ts"

const OptionsSchema = zod.object({
	shard: zod.string().describe("The new shard parquet to lint"),
	stats: zod.string().describe("Pre-computed corpus stats JSON"),
	rules: zod.string().optional().describe("Anti-pattern rules JSON (default: the bundled lint-rules.json)"),
	outMd: zod.string().optional().describe("Write the markdown report here as well as stdout"),
	outJson: zod.string().optional().describe("Write a JSON sidecar of the flags + summary here"),
})

export { OptionsSchema as options }

const report = (line: string): void => console.error(line)

const DevLintCorpusShard: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(
		async () =>
			lintCorpusShard(
				{
					shardPath: options.shard,
					statsPath: options.stats,
					rulesPath: options.rules,
					outMd: options.outMd,
					outJson: options.outJson,
				},
				report
			),
		(summary) => (summary.errors > 0 ? 1 : 0)
	)

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	// The tool already narrates LINT PASSED/FAILED on stderr (the old script's exact output) —
	// rendering it again here would duplicate the verdict line.
	return null
}

export default DevLintCorpusShard
