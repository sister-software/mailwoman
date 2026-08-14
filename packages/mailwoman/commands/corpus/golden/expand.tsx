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

import { Text } from "ink"
import { type CommandSpec, type ParsedCommandComponent, useCommandTask } from "mailwoman/cli-kit"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "expand",
	description: "Generate golden-set candidates from verified-label seeds.",
	options: {
		corpus: {
			type: "string",
			description: "Corpus test shard path(s), comma-separated (default: the v0.2.0 test shard under the data root)",
		},
		count: { type: "number", default: 100, description: "Total seeds to process" },
		variants: { type: "number", default: 5, description: "Variants requested per seed" },
		output: {
			type: "string",
			description: "JSONL output path (default data/eval/golden/candidates/expand-<ts>.jsonl)",
		},
		provider: { type: "string", choices: ["deepseek", "anthropic"], default: "deepseek", description: "LLM provider" },
		model: { type: "string", description: "Model id (default depends on provider)" },
		concurrency: { type: "number", default: 4, description: "Parallel LLM calls" },
		"include-sources": { type: "string", description: "Comma-separated source allow-list" },
	},
} as const satisfies CommandSpec

interface Options {
	corpus?: string
	count: number
	variants: number
	output?: string
	provider: "deepseek" | "anthropic"
	model?: string
	concurrency: number
	includeSources?: string
}

const CorpusGoldenExpand: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { expandGolden } = await import("@mailwoman/corpus/tools")

		return expandGolden(
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
	})

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
