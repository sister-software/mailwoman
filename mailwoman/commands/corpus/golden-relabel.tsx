/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman corpus golden-relabel` — move a golden answer-key version onto the corpus's US
 *   street-suffix convention (folded `street` → `street` + `street_suffix`). Writes a NEW version
 *   dir plus a review deck; the parent version is read-only. See
 *   `corpus/src/tools/golden-relabel-street.ts` for what it changes and, more importantly, what it
 *   refuses to.
 */

import { Text } from "ink"
import { type CommandComponent, useCommandTask } from "mailwoman/cli-kit"
import zod from "zod"

const OptionsSchema = zod.object({
	input: zod.string().describe("Parent golden version dir (read-only), e.g. data/eval/golden/v0.1.2"),
	output: zod.string().describe("Output golden version dir, e.g. data/eval/golden/v0.1.3"),
	deck: zod.string().optional().describe("Review-deck JSONL path. Default <output>/REVIEW-DECK.jsonl"),
	commit: zod.string().optional().describe("Commit SHA recorded as tool provenance in the manifest"),
	splitPrefix: zod
		.boolean()
		.default(true)
		.describe("Also lift a folded leading directional into street_prefix. --no-split-prefix measures the fold's cost"),
})

export { OptionsSchema as options }

const Cmd: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { relabelGoldenDirectory } = await import("@mailwoman/corpus/tools")

		const report = await relabelGoldenDirectory({
			input: options.input,
			output: options.output,
			...(options.deck ? { deck: options.deck } : {}),
			...(options.commit ? { commit: options.commit } : {}),
			splitPrefix: options.splitPrefix,
		})

		return `${report.totalChanged} rows split, ${report.totalFlagged} flagged → ${report.outputDir}`
	})

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status === "done") return <Text color="green">✓ {state.result}</Text>

	return null
}

export default Cmd
