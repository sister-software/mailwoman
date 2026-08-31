/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Align one corpus shard with the current tokenizer.
 */

import { type CommandSpec, CommandTaskResult, type ParsedCommandComponent, useCommandTask } from "#cli-kit"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "align-shard",
	description: "Align a canonical corpus shard.",
	options: {
		input: { type: "string", required: true, description: "Canonical jsonl input" },
		output: { type: "string", required: true, description: "Labeled jsonl output" },
		"corpus-version": { type: "string", required: true, description: "Corpus version stamp for the emitted rows" },
	},
} as const satisfies CommandSpec

interface Options {
	input: string
	output: string
	corpusVersion: string
}

const Cmd: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { alignCanonicalShard } = await import("@mailwoman/corpus/tools")

		await alignCanonicalShard({
			input: options.input,
			output: options.output,
			corpusVersion: options.corpusVersion,
		})

		return "done"
	})

	return <CommandTaskResult state={state} />
}

export default Cmd
