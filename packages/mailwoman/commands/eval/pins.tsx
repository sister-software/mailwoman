/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman eval pins` — the board-pin contract's CLI (#1895). Bare: print the measured pins
 *   under the constant names `load.test.ts` pins them as. `--check`: compare measured against the
 *   committed constants and exit nonzero with the exact replacement values. `--update`: rewrite
 *   ONLY the three constants (the test's dated history comments survive byte-identically), then
 *   re-check. The calculation lives in `eval-harness/gauntlet/cases/pins.ts` so the admin-merge
 *   wrapper and the cheap CI check call it without Ink.
 */

import { Box, Text } from "ink"

import { type CommandSpec, type ParsedCommandComponent, useCommandTask } from "#cli-kit"

export const description = "Measure, check, or update the regression board's pins (row count, corpus hash, board id)."

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "pins",
	description,
	options: {
		check: {
			type: "boolean",
			default: false,
			description: "Compare against the committed constants; exit 1 on drift.",
		},
		update: {
			type: "boolean",
			default: false,
			description: "Rewrite only the three committed constants to the measured values, then re-check.",
		},
	},
} as const satisfies CommandSpec

interface Options {
	check?: boolean
	update?: boolean
}

const EvalPins: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { checkBoardPins, measureBoardPins, updateBoardPins, PIN_TEST_PATH } =
			await import("#eval-harness/gauntlet/cases/pins")

		if (options.update) {
			const verified = await updateBoardPins()

			if (verified.stale.length) {
				throw new Error(`update wrote the pins but the re-check still reports drift on: ${verified.stale.join(", ")}`)
			}

			return { mode: "update" as const, pins: verified.measured, testPath: PIN_TEST_PATH, stale: [] }
		}

		if (options.check) {
			const check = await checkBoardPins()

			if (check.stale.length) {
				const replacements = check.stale
					.map((key) => `${key}: committed ${String(check.committed[key])} → measured ${String(check.measured[key])}`)
					.join("\n")

				throw new Error(
					`the committed pins are STALE in ${PIN_TEST_PATH}:\n${replacements}\n` +
						"Run `mailwoman eval pins --update` (or paste the measured values) and commit the test with the board edit."
				)
			}

			return { mode: "check" as const, pins: check.measured, testPath: PIN_TEST_PATH, stale: [] }
		}

		return { mode: "print" as const, pins: await measureBoardPins(), testPath: PIN_TEST_PATH, stale: [] }
	})

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status === "done") {
		return (
			<Box flexDirection="column">
				{state.result.mode !== "print" && (
					<Text color="green">✓ {state.result.mode === "update" ? "pins updated and verified" : "pins hold"}</Text>
				)}
				<Text>CORPUS_SIZE = {state.result.pins.CORPUS_SIZE}</Text>
				<Text>CORPUS_HASH = "{state.result.pins.CORPUS_HASH}"</Text>
				<Text>BOARD_ID = "{state.result.pins.BOARD_ID}"</Text>
				<Text dimColor> pinned in {state.result.testPath}</Text>
			</Box>
		)
	}

	return <Text dimColor>Loading the regression corpus…</Text>
}

export default EvalPins
