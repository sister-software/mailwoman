/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Align one corpus slice with the current tokenizer.
 */

import { type CommandSpec, CommandTaskResult, type CommandComponent, useCommandTask } from "#cli-kit"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "align-slice",
	description: "Align a canonical corpus slice.",
	options: {
		input: { type: "string", required: true, description: "Canonical jsonl input" },
		out: { type: "string", required: true, description: "Labeled jsonl output", deprecatedName: "output" },
		"corpus-version": { type: "string", required: true, description: "Corpus version stamp for the emitted rows" },
	},
} as const satisfies CommandSpec

const Cmd: CommandComponent<typeof spec> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { alignCanonicalSlice } = await import("@mailwoman/corpus/tools")

		await alignCanonicalSlice({
			input: options.input,
			output: options.out,
			corpusVersion: options.corpusVersion,
		})

		return "done"
	})

	return <CommandTaskResult state={state} />
}

export default Cmd
