/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman dev generate man-page` — regenerate the committed `man/mailwoman.1` from the compiled CLI's own help
 *   tree. Offline codegen; the freshness test under `test/unit/` fails on drift, and the pre-commit hook runs this when
 *   a commit touches the command surface.
 */

import { Text } from "ink"

import { type CommandSpec, CommandTaskResult, reportToStderr, useCommandTask } from "#cli-kit"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "man-page",
	description: "Generate the man page from the CLI's help tree",
} as const satisfies CommandSpec

const DevGenerateManPage = () => {
	const state = useCommandTask(async () => {
		const { generateManPage } = await import("#dev-tools/man-page")

		return generateManPage(reportToStderr)
	})

	if (state.status !== "done") return <CommandTaskResult state={state} />

	if (state.status === "done") {
		return (
			<Text color="green">
				✓ wrote {state.result.outPath} ({state.result.bytes} bytes)
			</Text>
		)
	}

	return null
}

export default DevGenerateManPage
