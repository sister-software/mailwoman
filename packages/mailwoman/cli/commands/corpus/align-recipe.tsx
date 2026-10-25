// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Align one canonical recipe output with the current tokenizer.
 */

import { type CommandSpec, CommandTaskResult, type CommandComponent, useCommandTask } from "#cli-kit"

/**
 * Native command-line interface consumed by the filesystem command router.
 */
export const spec = {
	name: "align-recipe",
	description: "Align a canonical recipe output with the current tokenizer.",
	options: {
		input: { type: "string", required: true, description: "Canonical jsonl input" },
		out: { type: "string", required: true, description: "Labeled jsonl output", deprecatedName: "output" },
	},
} as const satisfies CommandSpec

const Cmd: CommandComponent<typeof spec> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { alignCanonicalRows } = await import("@mailwoman/corpus/tools/align-canonical")

		await alignCanonicalRows({
			input: options.input,
			output: options.out,
		})

		return "done"
	})

	return <CommandTaskResult state={state} />
}

export default Cmd
