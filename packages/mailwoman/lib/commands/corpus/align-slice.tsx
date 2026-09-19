/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Align one canonical recipe output with the current tokenizer.
 */

import { type CommandSpec, CommandTaskResult, type CommandComponent, useCommandTask } from "#cli-kit"

/**
 * Native command-line interface consumed by the filesystem command router.
 */
export const spec = {
	name: "align-slice",
	description: "Align a canonical recipe output with the current tokenizer.",
	options: {
		input: { type: "string", required: true, description: "Canonical jsonl input" },
		out: { type: "string", required: true, description: "Labeled jsonl output", deprecatedName: "output" },
		"corpus-version": { type: "string", required: true, description: "Corpus version stamp for the emitted rows" },
	},
} as const satisfies CommandSpec

const Cmd: CommandComponent<typeof spec> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { alignCanonicalRows } = await import("@mailwoman/corpus/tools")

		await alignCanonicalRows({
			input: options.input,
			output: options.out,
			corpusVersion: options.corpusVersion,
		})

		return "done"
	})

	return <CommandTaskResult state={state} />
}

export default Cmd
