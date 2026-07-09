/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman corpus stats` — ported from the scripts drawer (PR E, #1029). The tool module is
 *   lazy-imported so eager command loading stays dependency-light.
 */

import { Text } from "ink"
import { useEffect, useState } from "react"
import zod from "zod"

import type { CommandComponent } from "../../cli-kit/index.ts"

const OptionsSchema = zod.object({
	shards: zod.string().describe("Comma-separated parquet shard paths or a directory"),
	output: zod.string().describe("Output corpus-stats.json path"),
	limitPerShard: zod.string().optional().describe("Row cap per shard (debug)"),
})

export { OptionsSchema as options }

const Cmd: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const [error, setError] = useState<string>()
	const [done, setDone] = useState<string>()

	useEffect(() => {
		void (async () => {
			try {
				const { buildCorpusStats } = await import("../../corpus-tools/corpus-stats.ts")
				await buildCorpusStats({
					shardsArg: options.shards,
					outputPath: options.output,
					limitPerShard: options.limitPerShard ? Number(options.limitPerShard) : undefined,
				})
				setDone("done")
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e))
			}
		})()
	}, [options])

	useEffect(() => {
		if (done || error) {
			setImmediate(() => process.exit(error ? 1 : 0))
		}
	}, [done, error])

	if (error) return <Text color="red">✗ {error}</Text>

	if (done) return <Text color="green">✓ {done}</Text>

	return null
}

export default Cmd
