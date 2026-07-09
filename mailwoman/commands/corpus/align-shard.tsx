/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman corpus align-shard` — ported from the scripts drawer (PR E, #1029). The tool module is
 *   lazy-imported so eager command loading stays dependency-light.
 */

import { Text } from "ink"
import { useEffect, useState } from "react"
import zod from "zod"

import type { CommandComponent } from "../../sdk/cli.ts"

const OptionsSchema = zod.object({
	input: zod.string().describe("Canonical jsonl input"),
	output: zod.string().describe("Labeled jsonl output"),
	corpusVersion: zod.string().describe("Corpus version stamp for the emitted rows"),
})

export { OptionsSchema as options }

const Cmd: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const [error, setError] = useState<string>()
	const [done, setDone] = useState<string>()

	useEffect(() => {
		void (async () => {
			try {
				const { alignCanonicalShard } = await import("../../corpus-tools/align-shard.ts")
				await alignCanonicalShard({
					input: options.input,
					output: options.output,
					corpusVersion: options.corpusVersion,
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
