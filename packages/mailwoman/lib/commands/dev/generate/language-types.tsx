/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman dev generate language-types` — regenerate `core/resources/languages/types.gen.ts`
 *   (the ISO 639-1/639-2b language-code types + label maps) from the committed
 *   `internal/languages.csv` resource dictionary. Offline codegen.
 */

import { Text } from "ink"

import { type CommandSpec, CommandTaskResult, reportToStderr, useCommandTask } from "#cli-kit"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "language-types",
	description: "Generate language-code types",
} as const satisfies CommandSpec

const DevGenerateLanguageTypes = () => {
	const state = useCommandTask(async () => {
		const { generateLanguageTypes } = await import("@mailwoman/core/tools")

		return generateLanguageTypes({}, reportToStderr)
	})

	if (state.status !== "done") return <CommandTaskResult state={state} />

	if (state.status === "done") {
		return (
			<Text color="green">
				✓ wrote {state.result.outPath} ({state.result.languages} languages)
			</Text>
		)
	}

	return null
}

export default DevGenerateLanguageTypes
