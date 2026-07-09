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
import { argument } from "pastel"
import zod from "zod"

import { type PositionalCommandComponent, useCommandTask } from "../../../cli-kit/index.ts"
import { lintMDXAngles } from "../../../dev-tools/lint-mdx-angles.ts"

const ArgumentsSchema = zod
	.array(
		zod.string().describe(
			argument({
				name: "files",
				description: "Markdown files to check (default: staged docs/** markdown)",
			})
		)
	)
	.default([])

export { ArgumentsSchema as args }

const report = (line: string): void => console.error(line)

const DevLintMDXAngles: PositionalCommandComponent<typeof ArgumentsSchema> = ({ args }) => {
	const state = useCommandTask(
		async () => lintMDXAngles({ files: args }, report),
		(summary) => (summary.errors > 0 ? 1 : 0)
	)

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

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
