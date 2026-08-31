/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman dev lint mdx-angles [files...]` — raw-angle-bracket MDX lint. A bare `<55` or
 *   `{word` in docs prose is a build-breaking MDX-JSX parse error. Checks STAGED docs markdown by
 *   default (the pre-commit mode), or the explicit paths when given. Exits 1 when any file is
 *   flagged.
 */

import { Text } from "ink"

import {
	type CommandSpec,
	CommandTaskResult,
	type ParsedCommandComponent,
	reportToStderr,
	useCommandTask,
} from "#cli-kit"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "mdx-angles",
	description: "Lint raw angle brackets in MDX.",
	positionals: [
		{ name: "files", multiple: true, description: "Markdown files to check (default: staged docs/** markdown)" },
	],
} as const satisfies CommandSpec

const DevLintMDXAngles: ParsedCommandComponent<Record<string, never>> = ({ args }) => {
	const state = useCommandTask(
		async () => {
			const { lintMDXAngles } = await import("#dev-tools/lint-mdx-angles")

			return await lintMDXAngles({ files: args }, reportToStderr)
		},
		(summary) => (summary.errors > 0 ? 1 : 0)
	)

	if (state.status !== "done") return <CommandTaskResult state={state} />

	if (state.status === "done" && state.result.errors > 0) {
		return (
			<Text color="red">
				✗ {state.result.errors} file(s) flagged of {state.result.filesChecked} checked
			</Text>
		)
	}

	return null
}

export default DevLintMDXAngles
