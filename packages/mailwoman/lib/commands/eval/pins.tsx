/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman eval pins` — the board-pin contract's CLI (#1895). Bare: print the measured pins
 *   under the constant names `load.test.ts` pins them as. `--check`: compare measured against the
 *   committed constants and exit nonzero with the exact replacement values. `--update`: rewrite
 *   ONLY the three constants (the test's dated history comments survive byte-identically), then
 *   re-check. `--report-issue` is `--check` for the main-branch audit: on drift it additionally
 *   opens or updates ONE deduplicated issue through `gh` — the backstop for a stale pin reaching
 *   `main` through an admin-merge that bypassed `mailwoman release merge-admin` or a web edit. The
 *   calculation lives in `eval-harness/gauntlet/cases/pins.ts` so the admin-merge command calls it
 *   without Ink.
 */

import { parseJSONStrict } from "@mailwoman/core/objects"
import { Box, Text } from "ink"
import { $ } from "zx"

import { type CommandSpec, CommandTaskResult, type ParsedCommandComponent, useCommandTask } from "#cli-kit"

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
		"report-issue": {
			type: "boolean",
			default: false,
			description:
				"Check, and on drift open or update the one deduplicated stale-pin issue through gh (the main-branch audit).",
		},
	},
} as const satisfies CommandSpec

interface Options {
	check?: boolean
	update?: boolean
	reportIssue?: boolean
}

/**
 * The title the audit searches for, so a second drift updates the open issue rather than opening a sibling.
 */
const STALE_PIN_ISSUE_TITLE = "board pins are stale on main"

/**
 * Open the deduplicated stale-pin issue, or comment on the open one. Answers what it did, for the command's output.
 */
async function reportStalePins(drift: string, testPath: string): Promise<string> {
	const commit = (await $`git rev-parse HEAD`.quiet()).stdout.trim()

	const body =
		`The board-pin audit found the committed constants stale at ${commit}:\n\n${drift}\n\n` +
		`Run \`mailwoman eval pins --update\`, commit ${testPath}, and this issue closes on the next green audit.`

	const search = `in:title ${JSON.stringify(STALE_PIN_ISSUE_TITLE)}`
	const issueList = await $`gh issue list --state open --search ${search} --json number`.quiet()
	const existing = parseJSONStrict<Array<{ number: number }>>(issueList.stdout)
	const first = existing[0]

	if (first) {
		await $`gh issue comment ${first.number} --body ${body}`.quiet()

		return `updated issue #${first.number}`
	}

	await $`gh issue create --title ${STALE_PIN_ISSUE_TITLE} --body ${body}`.quiet()

	return "opened the audit issue"
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

		if (options.check || options.reportIssue) {
			const check = await checkBoardPins()

			if (check.stale.length) {
				const replacements = check.stale
					.map((key) => `${key}: committed ${String(check.committed[key])} → measured ${String(check.measured[key])}`)
					.join("\n")

				const reported = options.reportIssue ? `\n${await reportStalePins(replacements, PIN_TEST_PATH)}` : ""

				throw new Error(
					`the committed pins are STALE in ${PIN_TEST_PATH}:\n${replacements}\n` +
						"Run `mailwoman eval pins --update` (or paste the measured values) and commit the test with the board edit." +
						reported
				)
			}

			return { mode: "check" as const, pins: check.measured, testPath: PIN_TEST_PATH, stale: [] }
		}

		return { mode: "print" as const, pins: await measureBoardPins(), testPath: PIN_TEST_PATH, stale: [] }
	})

	if (state.status !== "done")
		return <CommandTaskResult state={state} running={<Text dimColor>Loading the regression corpus…</Text>} />

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

	return null
}

export default EvalPins
