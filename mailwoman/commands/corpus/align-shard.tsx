/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman corpus align-shard` — ported from the scripts drawer (PR E, #1029). The tool module is
 *   lazy-imported so eager command loading stays dependency-light.
 */

import { Text } from "ink"
import zod from "zod"

import { type CommandComponent, useCommandTask } from "../../cli-kit/index.ts"

const OptionsSchema = zod.object({
	input: zod.string().describe("Canonical jsonl input"),
	output: zod.string().describe("Labeled jsonl output"),
	corpusVersion: zod.string().describe("Corpus version stamp for the emitted rows"),
})

export { OptionsSchema as options }

const Cmd: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { alignCanonicalShard } = await import("@mailwoman/corpus/tools")
		await alignCanonicalShard({
			input: options.input,
			output: options.output,
			corpusVersion: options.corpusVersion,
		})

		return "done"
	})

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status === "done") return <Text color="green">✓ {state.result}</Text>

	return null
}

export default Cmd
