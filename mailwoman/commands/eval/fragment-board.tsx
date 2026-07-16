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
import zod from "zod"

import { type CommandComponent, useCommandTask } from "../../cli-kit/index.ts"
import { runFragmentBoard } from "../../eval-harness/fragment-board.ts"

export const description = "FR fragment board — bare-street / particle / homonym / date-name classes with CIs (#727)"

const OptionsSchema = zod.object({
	locale: zod.string().optional().default("en-US").describe("Weights package locale (default en-US)"),
	weightsCache: zod
		.string()
		.optional()
		.describe("Package-shaped candidate weights dir (mirrors eval parity --weights-cache)"),
	fixtures: zod.string().optional().describe("Fixture JSONL override (default: the BAN FR fragment board)"),
	klass: zod.string().optional().describe("Score only one class (e.g. bare-street) for a fast loop"),
})

export { OptionsSchema as options }

const EvalFragmentBoard: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(
		async () =>
			(
				await runFragmentBoard({
					locale: options.locale,
					weightsCacheRoot: options.weightsCache,
					fixturesPath: options.fixtures,
					klass: options.klass,
				})
			).exitCode,
		(exitCode) => exitCode
	)

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	// The runner narrates its table on stdout.
	return null
}

export default EvalFragmentBoard
