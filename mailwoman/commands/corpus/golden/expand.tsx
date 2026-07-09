/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman corpus golden expand` — generate golden-set candidate entries by LLM-driven
 *   surface-form synthesis from verified-label seeds in a corpus test shard. Candidates land in
 *   `data/eval/golden/candidates/` for operator review; promote with `corpus golden promote`.
 *   Requires `DEEPSEEK_API_KEY` (or `ANTHROPIC_API_KEY` with `--provider anthropic`).
 */

import { expandGolden } from "@mailwoman/corpus/tools"
import { Text } from "ink"
import zod from "zod"

import { type CommandComponent, useCommandTask } from "../../../cli-kit/index.ts"

const OptionsSchema = zod.object({
	corpus: zod
		.string()
		.optional()
		.describe("Corpus test shard path(s), comma-separated (default: the v0.2.0 test shard under the data root)"),
	count: zod.number().default(100).describe("Total seeds to process"),
	variants: zod.number().default(5).describe("Variants requested per seed"),
	output: zod.string().optional().describe("JSONL output path (default data/eval/golden/candidates/expand-<ts>.jsonl)"),
	provider: zod.enum(["deepseek", "anthropic"]).default("deepseek").describe("LLM provider"),
	model: zod.string().optional().describe("Model id (default depends on provider)"),
	concurrency: zod.number().default(4).describe("Parallel LLM calls"),
	includeSources: zod.string().optional().describe("Comma-separated source allow-list"),
})

export { OptionsSchema as options }

const CorpusGoldenExpand: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(() =>
		expandGolden(
			{
				corpus: options.corpus,
				count: options.count,
				variants: options.variants,
				output: options.output,
				provider: options.provider,
				model: options.model,
				concurrency: options.concurrency,
				includeSources: options.includeSources,
			},
			(line) => console.error(line)
		)
	)

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status === "done") {
		const { seedsProcessed, kept, dropped, errored, outputPath } = state.result

		return (
			<Text color="green">
				✓ seeds {seedsProcessed}, kept {kept}, dropped {dropped}, errored {errored} → {outputPath}
			</Text>
		)
	}

	return null
}

export default CorpusGoldenExpand
