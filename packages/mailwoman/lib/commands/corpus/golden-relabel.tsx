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

import { type CommandSpec, CommandTaskResult, type ParsedCommandComponent, useCommandTask } from "#cli-kit"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "golden-relabel",
	description: "Relabel a golden answer-key version without mutating its parent.",
	options: {
		input: {
			type: "string",
			required: true,
			description: "Parent golden version dir (read-only), e.g. data/eval/golden/v0.1.2",
		},
		output: { type: "string", required: true, description: "Output golden version dir, e.g. data/eval/golden/v0.1.3" },
		deck: { type: "string", description: "Review-deck JSONL path. Default <output>/REVIEW-DECK.jsonl" },
		commit: { type: "string", description: "Commit SHA recorded as tool provenance in the manifest" },
		"split-prefix": {
			type: "boolean",
			default: true,
			description:
				"Also lift a folded leading directional into street_prefix. --no-split-prefix measures the fold's cost",
		},
	},
} as const satisfies CommandSpec

interface Options {
	input: string
	output: string
	deck?: string
	commit?: string
	splitPrefix: boolean
}

const Cmd: ParsedCommandComponent<Options> = ({ options }) => {
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

	return <CommandTaskResult state={state} />
}

export default Cmd
