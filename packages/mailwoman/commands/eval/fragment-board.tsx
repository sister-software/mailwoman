/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman eval fragment-board` — the locale fragment board (#727 stage-2, Tier 1c). Targeted
 *   failure classes with confidence intervals, sampled from BAN (Tier A). The second of the two
 *   standing boards; `eval parity` is the first (the global "do no harm" floor).
 *
 *   A change ships when parity HOLDS and this board MOVES. Neither is a verdict alone.
 *   Informational (always exits 0) — the standing floors stay on `eval parity`.
 */

import { Text } from "ink"

import { type CommandSpec, type ParsedCommandComponent, useCommandTask } from "#cli-kit"

export const description = "FR fragment board — bare-street / particle / homonym / date-name classes with CIs (#727)"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "fragment-board",
	description,
	options: {
		locale: { type: "string", default: "en-US", description: "Weights package locale (default en-US)" },
		"weights-cache": {
			type: "string",
			description: "Package-shaped candidate weights dir (mirrors eval parity --weights-cache)",
		},
		fixtures: { type: "string", description: "Fixture JSONL override (default: the BAN FR fragment board)" },
		klass: { type: "string", description: "Score only one class (e.g. bare-street) for a fast loop" },
	},
} as const satisfies CommandSpec

interface Options {
	locale: string
	weightsCache?: string
	fixtures?: string
	klass?: string
}

const EvalFragmentBoard: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(
		async () => {
			const { runFragmentBoard } = await import("#eval-harness/fragment-board")

			return (
				await runFragmentBoard({
					locale: options.locale,
					weightsCacheRoot: options.weightsCache,
					fixturesPath: options.fixtures,
					klass: options.klass,
				})
			).exitCode
		},
		(exitCode) => exitCode
	)

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	// The runner narrates its table on stdout.
	return null
}

export default EvalFragmentBoard
