/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman eval pins` — print the regression board's measured pins: row count, corpus hash, and
 *   board id, under the constant names `load.test.ts` pins them as. A board edit updates the pins
 *   from one command instead of copying values out of the pin test's failure output — the workflow
 *   that let two board additions ship unpinned in one day when their merges skipped CI.
 */

import { Box, Text } from "ink"

import { type CommandSpec, type ParsedCommandComponent, useCommandTask } from "#cli-kit"

export const description = "Print the regression board's measured pins (row count, corpus hash, board id)."

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "pins",
	description,
} as const satisfies CommandSpec

const EvalPins: ParsedCommandComponent<Record<string, never>> = () => {
	const state = useCommandTask(async () => {
		const { loadRegressionCases, regressionCorpusHash } = await import("mailwoman/eval-harness/gauntlet/cases/load")
		const { ablationBoardID } = await import("mailwoman/eval-harness/gauntlet/ablation")

		const cases = await loadRegressionCases()

		return {
			size: cases.length,
			hash: regressionCorpusHash(cases),
			board: ablationBoardID(cases),
		}
	})

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status === "done") {
		return (
			<Box flexDirection="column">
				<Text>CORPUS_SIZE = {state.result.size}</Text>
				<Text>CORPUS_HASH = "{state.result.hash}"</Text>
				<Text>BOARD_ID = "{state.result.board}"</Text>
				<Text dimColor> pinned in packages/mailwoman/test/unit/eval-harness/gauntlet/cases/load.test.ts</Text>
			</Box>
		)
	}

	return <Text dimColor>Loading the regression corpus…</Text>
}

export default EvalPins
